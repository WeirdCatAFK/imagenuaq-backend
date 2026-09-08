import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  createPending,
  createActive,
  softDelete,
  findUser,
  areaMemberships,
  areaId,
  roleId,
  contractTypeId,
  tokenFor,
  sql,
} from './helpers/fixtures.js';
import * as tokens from './helpers/tokens.js';

describe('POST /api/users', () => {
  let server;
  let admin;
  let adminToken;
  let workerRole;
  let contractType;
  let disenoWeb;

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: 'coordinacion@uaq.mx', role: 'admin' });
    adminToken = await tokenFor(server, 'coordinacion@uaq.mx');

    workerRole = await roleId('worker');
    contractType = await contractTypeId();
    disenoWeb = await areaId('Diseño Web');
  });

  after(async () => {
    await server.close();
  });

  // The admin row is truncated along with everything else, and the token keeps working:
  // nothing re-reads the database on a verified token, so the role travels in the JWT for
  // its full seven days. That is the documented trade behind requireRole() costing no
  // query, and leaning on it here is what keeps this file to a single bcrypt comparison
  // instead of one per test.
  beforeEach(reset);

  const valid = () => ({
    email: 'nuevo@uaq.mx',
    fullName: 'Nuevo Usuario',
    roleId: workerRole,
    contractTypeId: contractType,
  });

  const create = (body, token = adminToken) => server.post('/api/users', { body, token });

  describe('only coordination may create accounts', () => {
    test('without a token it is 401', async () => {
      const res = await server.post('/api/users', { body: valid() });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    test('with an invalid token it is 401', async () => {
      const res = await create(valid(), tokens.GARBAGE);

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid or expired token.');
    });

    // Area leads direct the work of their area, but staffing it is not theirs to decide --
    // so the guard is requireRole('admin') and not a list that quietly includes them.
    for (const role of ['worker', 'area_lead', 'finance']) {
      test(`a ${role} is 403`, async () => {
        const user = await createPending({ email: `${role}@uaq.mx`, role });
        const token = await tokens.session({ ...user, role_name: role });

        const res = await create(valid(), token);

        assert.equal(res.status, 403);
        assert.equal(res.body.error.message, 'Insufficient role for this resource.');
      });
    }

    // 403 and not 404: the guard is mounted on the router with use(), so it answers before
    // route matching. A caller learns they lack the role rather than that the route is
    // missing.
    test('the guard runs before the route, so an unknown sub-path is still 403', async () => {
      const user = await createPending({ email: 'worker2@uaq.mx', role: 'worker' });
      const token = await tokens.session({ ...user, role_name: 'worker' });

      const res = await server.post('/api/users/does-not-exist', { body: {}, token });

      assert.equal(res.status, 403);
    });
  });

  describe('creating an account', () => {
    test('returns 201 with the user and an invitation', async () => {
      const res = await create(valid());

      assert.equal(res.status, 201);
      assert.deepEqual(res.body.user, {
        id: res.body.user.id,
        email: 'nuevo@uaq.mx',
        fullName: 'Nuevo Usuario',
        roleId: workerRole,
        role: 'worker',
        primaryAreaId: null,
      });
      assert.equal(typeof res.body.inviteToken, 'string');
    });

    // The account arrives with no password and reaches one only through the invite, which
    // is what makes the invite single-use and what stops a created account being logged
    // into before its owner has chosen a secret.
    test('the account has no password until it is activated', async () => {
      const res = await create(valid());

      assert.equal((await findUser(res.body.user.id)).password_hash, null);
    });

    // The invite is a credential with a life of its own, not a property of the user -- it
    // is returned alongside the record rather than inside it, and this is the only moment
    // it exists. Nothing stores it and it cannot be read back.
    test('the invitation is usable and is not stored on the user', async () => {
      const res = await create(valid());

      assert.equal('inviteToken' in res.body.user, false);

      const activated = await server.post('/api/auth/activate', {
        body: { token: res.body.inviteToken, password: 'una contrasena larga' },
      });
      assert.equal(activated.status, 200);
    });

    test('the email is lowercased and trimmed on the way in', async () => {
      const res = await create({ ...valid(), email: '  NUEVO@UAQ.MX  ' });

      assert.equal(res.status, 201);
      assert.equal(res.body.user.email, 'nuevo@uaq.mx');
      assert.equal((await findUser(res.body.user.id)).email, 'nuevo@uaq.mx');
    });

    test('the full name is trimmed', async () => {
      const res = await create({ ...valid(), fullName: '  Nuevo Usuario  ' });

      assert.equal(res.body.user.fullName, 'Nuevo Usuario');
    });

    // Ids arrive from JSON, where "7" and 7 are both ordinary.
    test('numeric ids sent as strings are accepted', async () => {
      const res = await create({
        ...valid(),
        roleId: String(workerRole),
        contractTypeId: String(contractType),
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.user.roleId, workerRole);
    });
  });

  // area_members is not redundant with users.primary_area_id: leadership lives there
  // because somebody can lead one area and be a member of another, and the visibility
  // queries read that table. A user created without a row there is invisible to their own
  // colleagues, which is a bug nobody notices until the first area listing comes up empty.
  describe('area membership', () => {
    test('an area creates the membership row alongside the user', async () => {
      const res = await create({ ...valid(), primaryAreaId: disenoWeb });

      assert.equal(res.status, 201);
      assert.equal(res.body.user.primaryAreaId, disenoWeb);
      assert.deepEqual(await areaMemberships(res.body.user.id), [
        { area_id: disenoWeb, is_area_leader: false },
      ]);
    });

    test('the leader flag is recorded on the membership', async () => {
      const res = await create({
        ...valid(),
        primaryAreaId: disenoWeb,
        isAreaLeader: true,
      });

      assert.deepEqual(await areaMemberships(res.body.user.id), [
        { area_id: disenoWeb, is_area_leader: true },
      ]);
    });

    test('no area means no membership row', async () => {
      const res = await create(valid());

      assert.equal(res.body.user.primaryAreaId, null);
      assert.deepEqual(await areaMemberships(res.body.user.id), []);
    });

    // A leader flag with no area has nowhere to apply; accepting it silently would record
    // a decision that never took effect.
    test('a leader flag without an area is 400', async () => {
      const res = await create({ ...valid(), isAreaLeader: true });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'isAreaLeader requires primaryAreaId.');
    });
  });

  describe('payload validation', () => {
    const rejected = async (patch, message) => {
      const res = await create({ ...valid(), ...patch });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(patch)}`);
      assert.equal(res.body.error.message, message);
    };

    const EMAIL_REQUIRED = 'A valid email address is required.';
    const NAME_REQUIRED = 'Full name is required (200 characters or fewer).';

    test('an address with no @ is 400', async () => {
      await rejected({ email: 'nuevo.uaq.mx' }, EMAIL_REQUIRED);
    });

    test('an address with no domain dot is 400', async () => {
      await rejected({ email: 'nuevo@uaq' }, EMAIL_REQUIRED);
    });

    test('an address with a space is 400', async () => {
      await rejected({ email: 'nue vo@uaq.mx' }, EMAIL_REQUIRED);
    });

    test('a missing address is 400', async () => {
      await rejected({ email: undefined }, EMAIL_REQUIRED);
    });

    test('a non-string address is 400 rather than a crash', async () => {
      await rejected({ email: 42 }, EMAIL_REQUIRED);
    });

    test('an address over the column width is 400', async () => {
      await rejected({ email: `${'a'.repeat(320)}@uaq.mx` }, EMAIL_REQUIRED);
    });

    // Deliberately permissive: the authority on a deliverable address is whether mail
    // arrives, and a stricter pattern reliably rejects real addresses. Plus-tagging is the
    // usual casualty, so it is pinned as accepted.
    test('a plus-tagged address is accepted', async () => {
      const res = await create({ ...valid(), email: 'ana+proyectos@uaq.mx' });

      assert.equal(res.status, 201);
    });

    test('a missing full name is 400', async () => {
      await rejected({ fullName: undefined }, NAME_REQUIRED);
    });

    test('a blank full name is 400', async () => {
      await rejected({ fullName: '   ' }, NAME_REQUIRED);
    });

    test('a full name over 200 characters is 400', async () => {
      await rejected({ fullName: 'a'.repeat(201) }, NAME_REQUIRED);
    });

    test('a missing roleId is 400', async () => {
      await rejected({ roleId: undefined }, 'roleId is required.');
    });

    test('a missing contractTypeId is 400', async () => {
      await rejected({ contractTypeId: undefined }, 'contractTypeId is required.');
    });

    // Number() alone would read true as 1 and "7abc" as NaN; toId() rejects both, so a
    // caller cannot stumble into role 1 by sending a boolean.
    for (const [label, value] of [
      ['a boolean', true],
      ['zero', 0],
      ['a negative number', -1],
      ['a fraction', 7.5],
      ['a numeric prefix', '7abc'],
      ['an empty string', ''],
      ['null', null],
    ]) {
      test(`${label} is not a valid roleId`, async () => {
        await rejected({ roleId: value }, 'roleId is required.');
      });
    }

    test('a malformed primaryAreaId is 400', async () => {
      await rejected(
        { primaryAreaId: 'sala de juntas' },
        'primaryAreaId must be a positive integer.',
      );
    });

    // null and undefined are a legitimate absence, not a malformed value -- staff without
    // a home area exist.
    test('an explicitly null primaryAreaId is accepted', async () => {
      const res = await create({ ...valid(), primaryAreaId: null });

      assert.equal(res.status, 201);
    });
  });

  // The constraint is the authority, not a pre-flight SELECT: two admins creating the same
  // address at once resolve correctly instead of both passing a check and one becoming a
  // 500. These assert the translation from Postgres error code back to the field the
  // caller got wrong.
  describe('constraint violations become refusals', () => {
    test('a duplicate live address is 409', async () => {
      await create(valid());

      const res = await create(valid());

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'A user with that email address already exists.');
    });

    test('a duplicate differing only in case is still 409', async () => {
      await create(valid());

      const res = await create({ ...valid(), email: 'NUEVO@UAQ.MX' });

      assert.equal(res.status, 409);
    });

    // uq_users_email_live is partial on deleted_at IS NULL, so removing someone frees
    // their address. Without that a departing employee would burn their address forever,
    // and a returning one could not be re-created.
    test('an address freed by a soft delete can be reused', async () => {
      const first = await create(valid());
      await softDelete(first.body.user.id);

      const res = await create(valid());

      assert.equal(res.status, 201);
      assert.notEqual(res.body.user.id, first.body.user.id);
    });

    test('an unknown roleId names that field', async () => {
      const res = await create({ ...valid(), roleId: 999_999 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Unknown roleId.');
    });

    test('an unknown contractTypeId names that field', async () => {
      const res = await create({ ...valid(), contractTypeId: 999_999 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Unknown contractTypeId.');
    });

    test('an unknown primaryAreaId names that field', async () => {
      const res = await create({ ...valid(), primaryAreaId: 999_999 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Unknown primaryAreaId.');
    });

    // A rejected creation must leave nothing behind. The user and its membership are one
    // data-modifying CTE precisely so the pair cannot half-succeed.
    test('a rejected creation writes no user', async () => {
      await create({ ...valid(), primaryAreaId: 999_999 });

      const [{ count }] = await sql(
        'select count(*)::int as count from users where email = $1',
        ['nuevo@uaq.mx'],
      );
      assert.equal(count, 0);
    });
  });

  // Never in the response, and never in the token either. The shape is assembled field by
  // field rather than spread from the row, and this is what that buys.
  test('the response never carries a password hash', async () => {
    const res = await create(valid());

    assert.equal(res.text.includes('password'), false);
  });
});
