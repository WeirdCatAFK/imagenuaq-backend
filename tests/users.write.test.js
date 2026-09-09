import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createArea,
  createActive,
  createPending,
  findUser,
  logsFor,
  tokenFor,
  contractTypeId,
  PASSWORD,
} from './helpers/fixtures.js';

// Editing and removing staff accounts, and the revocation that removal now carries.
//
// The case this file exists for is the last describe block: before `token_version`, a
// deleted account kept a working session for up to seven days and the only lever was
// rotating JWT_SECRET, which signs everybody out. An endpoint that reported success while
// leaving the account usable would be worse than no endpoint at all, so the proof that it
// does not is a test and not a comment.
describe('/api/users writes', () => {
  let server;
  let adminToken;
  let workerToken;
  let area;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: 'admin' });
    await createActive({ email: ACCOUNTS[1], role: 'worker' });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    area = await createArea('Diseño');
  });

  const someone = (patch = {}) =>
    createPending({
      email: 'nuevo@uaq.mx',
      role: 'worker',
      fullName: 'Rodrigo Salas',
      ...patch,
    });

  describe('the admin gate', () => {
    test('a worker may not edit', async () => {
      const user = await someone();

      const res = await server.patch(`/api/users/${user.id}`, {
        token: workerToken,
        body: { fullName: 'Otro Nombre' },
      });

      assert.equal(res.status, 403);
    });

    test('a worker may not delete', async () => {
      const user = await someone();

      const res = await server.delete(`/api/users/${user.id}`, { token: workerToken });

      assert.equal(res.status, 403);
    });
  });

  describe('PATCH /api/users/:id', () => {
    test('changes only the keys that were sent', async () => {
      const user = await someone();
      const before = await findUser(user.id);

      const res = await server.patch(`/api/users/${user.id}`, {
        token: adminToken,
        body: { fullName: 'Rodrigo Salas Ruiz' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.fullName, 'Rodrigo Salas Ruiz');

      const after = await findUser(user.id);
      assert.equal(after.email, before.email);
      assert.equal(after.contract_type_id, before.contract_type_id);
      assert.equal(after.role_id, before.role_id);
    });

    test('an address is trimmed and lowercased, as on create', async () => {
      const user = await someone();

      const res = await server.patch(`/api/users/${user.id}`, {
        token: adminToken,
        body: { email: '  Rodrigo@UAQ.MX  ' },
      });

      assert.equal(res.body.user.email, 'rodrigo@uaq.mx');
    });

    test('an explicit null clears a nullable column', async () => {
      const user = await someone({ area: area.name });

      const res = await server.patch(`/api/users/${user.id}`, {
        token: adminToken,
        body: { primaryAreaId: null },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.primaryAreaId, null);
    });

    // The role is deliberately not editable here: changing what somebody may do belongs
    // with the role catalogue, not the profile form.
    test('roleId in the body is ignored, not applied', async () => {
      const user = await someone();
      const adminRole = (await findUser(user.id)).role_id;

      await server.patch(`/api/users/${user.id}`, {
        token: adminToken,
        body: { roleId: 99999 },
      });

      assert.equal((await findUser(user.id)).role_id, adminRole);
    });

    test('taking an address that belongs to a live account is 409', async () => {
      const user = await someone();

      const res = await server.patch(`/api/users/${user.id}`, {
        token: adminToken,
        body: { email: ACCOUNTS[1] },
      });

      assert.equal(res.status, 409);
      assert.equal(
        res.body.error.message,
        'A user with that email address already exists.',
      );
    });

    for (const [label, body, message] of [
      ['a malformed address', { email: 'no-arroba' }, 'A valid email address is required.'],
      ['a blank name', { fullName: '   ' }, 'Full name is required (200 characters or fewer).'],
      [
        'a name past the column width',
        { fullName: 'x'.repeat(201) },
        'Full name is required (200 characters or fewer).',
      ],
      [
        'a contract type that is not an id',
        { contractTypeId: 'abc' },
        'contractTypeId must be a positive integer.',
      ],
    ]) {
      test(`${label} is 400`, async () => {
        const user = await someone();

        const res = await server.patch(`/api/users/${user.id}`, {
          token: adminToken,
          body,
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, message);
      });
    }

    test('an area that does not exist is 400 naming the field', async () => {
      const user = await someone();

      const res = await server.patch(`/api/users/${user.id}`, {
        token: adminToken,
        body: { primaryAreaId: 999999 },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Unknown primaryAreaId.');
    });

    test('a user that does not exist is 404', async () => {
      const res = await server.patch('/api/users/999999', {
        token: adminToken,
        body: { fullName: 'Nadie' },
      });

      assert.equal(res.status, 404);
    });

    test('writes a record_updated row carrying the previous values', async () => {
      const user = await someone();

      await server.patch(`/api/users/${user.id}`, {
        token: adminToken,
        body: { fullName: 'Rodrigo Salas Ruiz' },
      });

      const [entry] = (await logsFor('users', user.id)).filter(
        (row) => row.action === 'record_updated',
      );
      assert.ok(entry, 'no record_updated row was written');
      assert.equal(entry.before_data.full_name, 'Rodrigo Salas');
      assert.equal(entry.after_data.full_name, 'Rodrigo Salas Ruiz');
      assert.equal(entry.before_data.password_hash, '[redacted]');
    });
  });

  describe('DELETE /api/users/:id', () => {
    test('marks the row and returns it', async () => {
      const user = await someone();

      const res = await server.delete(`/api/users/${user.id}`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, user.id);
      assert.notEqual((await findUser(user.id)).deleted_at, null);
    });

    test('a second delete is 404', async () => {
      const user = await someone();

      await server.delete(`/api/users/${user.id}`, { token: adminToken });
      const again = await server.delete(`/api/users/${user.id}`, { token: adminToken });

      assert.equal(again.status, 404);
    });

    // uq_users_email_live is partial on `deleted_at is null`, so removing an account frees
    // its address. That is the whole reason the delete is soft rather than hard.
    test('the address becomes reusable', async () => {
      const user = await someone();
      await server.delete(`/api/users/${user.id}`, { token: adminToken });

      const res = await server.post('/api/users', {
        token: adminToken,
        body: {
          email: 'nuevo@uaq.mx',
          fullName: 'Alguien Más',
          roleId: (await findUser(user.id)).role_id,
          contractTypeId: await contractTypeId(),
        },
      });

      assert.equal(res.status, 201);
    });

    test('writes a record_deleted row', async () => {
      const user = await someone();

      await server.delete(`/api/users/${user.id}`, { token: adminToken });

      const [entry] = (await logsFor('users', user.id)).filter(
        (row) => row.action === 'record_deleted',
      );
      assert.ok(entry, 'no record_deleted row was written');
      assert.equal(entry.after_data, null);
    });
  });

  describe('revocation', () => {
    // The point of token_version, end to end: a session minted before the delete must stop
    // working the moment the account is removed, not when the token expires seven days on.
    test('a deleted account stops working immediately', async () => {
      await createActive({ email: 'temporal@uaq.mx', role: 'worker' });
      const victim = await server.post('/api/auth/login', {
        body: { email: 'temporal@uaq.mx', password: PASSWORD },
      });
      const token = victim.body.token;

      const before = await server.get('/api/auth/me', { token });
      assert.equal(before.status, 200);

      const target = before.body.user.id;
      await server.delete(`/api/users/${target}`, { token: adminToken });

      const after = await server.get('/api/auth/me', { token });
      assert.equal(after.status, 401);
      assert.equal(after.body.error.message, 'Invalid or expired token.');
    });

    // The other half of the same read: role now comes from the row, so a change lands on
    // the next request instead of waiting for the token to expire.
    test('a live token reflects a change made after it was minted', async () => {
      await createActive({ email: 'cambiante@uaq.mx', role: 'worker' });
      const token = await tokenFor(server, 'cambiante@uaq.mx');

      const before = await server.get('/api/auth/me', { token });
      assert.equal(before.body.user.fullName, 'Prueba Usuario');

      await server.patch(`/api/users/${before.body.user.id}`, {
        token: adminToken,
        body: { fullName: 'Nombre Corregido' },
      });

      const after = await server.get('/api/auth/me', { token });
      assert.equal(after.status, 200);
      assert.equal(after.body.user.fullName, 'Nombre Corregido');
    });
  });
});
