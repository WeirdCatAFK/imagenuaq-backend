import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createArea,
  createActive,
  createPending,
  softDelete,
  tokenFor,
} from './helpers/fixtures.js';

// The read half of /api/users: the list, one user, and the search. Writes are
// users.write.test.js; pictures are users.picture.test.js.
//
// The case this file exists for is the two shapes. RF-USR-03 lets any colleague see who
// else is in the organisation, so these reads are open to every signed-in caller -- but
// contract type and birthday are coordination's business, and a worker must not receive
// them. Asserting on the KEY SET rather than on values is deliberate: a field that leaks
// as `null` still leaks its existence, and a value assertion would pass.
describe('/api/users reads', () => {
  let server;
  let adminToken;
  let workerToken;
  let area;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  const PUBLIC_KEYS = ['id', 'fullName', 'email', 'role', 'roleId', 'primaryAreaId', 'areas'];
  const ADMIN_ONLY_KEYS = ['contractTypeId', 'birthday', 'createdAt', 'deletedAt'];

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

  describe('authentication', () => {
    test('the list without a token is 401', async () => {
      const res = await server.get('/api/users');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    test('a worker may read the list, RF-USR-03', async () => {
      const res = await server.get('/api/users', { token: workerToken });
      assert.equal(res.status, 200);
    });
  });

  describe('GET /api/users', () => {
    test('a worker gets the public shape and nothing more', async () => {
      const res = await server.get('/api/users', { token: workerToken });

      assert.equal(res.status, 200);
      assert.ok(res.body.users.length > 0);

      for (const user of res.body.users) {
        assert.deepEqual(Object.keys(user).sort(), [...PUBLIC_KEYS].sort());
      }
    });

    test('an admin additionally gets contract type, birthday and timestamps', async () => {
      const res = await server.get('/api/users', { token: adminToken });

      assert.equal(res.status, 200);
      for (const key of ADMIN_ONLY_KEYS) {
        assert.ok(
          Object.hasOwn(res.body.users[0], key),
          `admin shape is missing ${key}`,
        );
      }
    });

    test('total counts the matches, not the page', async () => {
      const res = await server.get('/api/users?limit=1', { token: adminToken });

      assert.equal(res.body.users.length, 1);
      assert.equal(res.body.total, 2);
      assert.equal(res.body.limit, 1);
    });

    test('offset walks the page window', async () => {
      const first = await server.get('/api/users?limit=1&offset=0', { token: adminToken });
      const second = await server.get('/api/users?limit=1&offset=1', { token: adminToken });

      assert.notEqual(first.body.users[0].id, second.body.users[0].id);
    });

    test('areaId narrows to that area, and areas comes back attached', async () => {
      const member = await createPending({
        email: 'nuevo@uaq.mx',
        role: 'worker',
        area: area.name,
      });

      const res = await server.get(`/api/users?areaId=${area.id}`, { token: adminToken });

      assert.equal(res.body.total, 1);
      assert.equal(res.body.users[0].id, member.id);
      assert.deepEqual(res.body.users[0].areas, [
        { id: area.id, name: area.name, isAreaLeader: false },
      ]);
    });

    test('a user in no area has an empty roster, not a missing one', async () => {
      const res = await server.get('/api/users', { token: adminToken });

      for (const user of res.body.users) {
        assert.ok(Array.isArray(user.areas));
      }
    });

    test('a soft-deleted user is absent by default', async () => {
      const doomed = await createPending({ email: 'fuera@uaq.mx', role: 'worker' });
      await softDelete(doomed.id);

      const res = await server.get('/api/users', { token: adminToken });

      assert.equal(res.body.users.some((user) => user.id === doomed.id), false);
    });

    test('includeDeleted brings them back for an admin', async () => {
      const doomed = await createPending({ email: 'fuera@uaq.mx', role: 'worker' });
      await softDelete(doomed.id);

      const res = await server.get('/api/users?includeDeleted=true', { token: adminToken });

      const found = res.body.users.find((user) => user.id === doomed.id);
      assert.ok(found, 'the deleted user should be listed for an admin');
      assert.notEqual(found.deletedAt, null);
    });

    // The flag is a permission, not a preference: honouring it for a worker would hand
    // them a list the admin shape exists to keep from them.
    test('includeDeleted is ignored for a worker', async () => {
      const doomed = await createPending({ email: 'fuera@uaq.mx', role: 'worker' });
      await softDelete(doomed.id);

      const res = await server.get('/api/users?includeDeleted=true', { token: workerToken });

      assert.equal(res.body.users.some((user) => user.id === doomed.id), false);
    });

    test('a filter that is not a positive integer is 400', async () => {
      const res = await server.get('/api/users?areaId=abc', { token: adminToken });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'areaId must be a positive integer.');
    });
  });

  describe('GET /api/users/:id', () => {
    test('returns the user with their areas', async () => {
      const member = await createPending({
        email: 'nuevo@uaq.mx',
        role: 'worker',
        area: area.name,
        isAreaLeader: true,
      });

      const res = await server.get(`/api/users/${member.id}`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, member.id);
      assert.deepEqual(res.body.user.areas, [
        { id: area.id, name: area.name, isAreaLeader: true },
      ]);
    });

    test('a worker gets the public shape', async () => {
      const member = await createPending({ email: 'nuevo@uaq.mx', role: 'worker' });

      const res = await server.get(`/api/users/${member.id}`, { token: workerToken });

      assert.equal(res.status, 200);
      for (const key of ADMIN_ONLY_KEYS) {
        assert.equal(Object.hasOwn(res.body.user, key), false, `${key} leaked to a worker`);
      }
    });

    test('an id that names no user is 404', async () => {
      const res = await server.get('/api/users/999999', { token: adminToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'User not found.');
    });

    test('a soft-deleted user is 404', async () => {
      const doomed = await createPending({ email: 'fuera@uaq.mx', role: 'worker' });
      await softDelete(doomed.id);

      const res = await server.get(`/api/users/${doomed.id}`, { token: adminToken });

      assert.equal(res.status, 404);
    });

    for (const [label, id] of [
      ['a non-numeric id', 'abc'],
      ['a negative id', '-1'],
      ['zero', '0'],
      ['a fractional id', '1.5'],
    ]) {
      test(`${label} is 400`, async () => {
        const res = await server.get(`/api/users/${id}`, { token: adminToken });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'Invalid user id.');
      });
    }
  });

  describe('GET /api/users/search', () => {
    // The ordering trick in routes/users.js: declared before '/:id', or Express captures
    // `search` as an id and answers "Invalid user id." for a URL that is not one.
    test('is not captured by /:id', async () => {
      const res = await server.get('/api/users/search?q=coord', { token: workerToken });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.users));
    });

    test('matches on the address', async () => {
      const res = await server.get('/api/users/search?q=disenador', { token: adminToken });

      assert.equal(res.body.users.length, 1);
      assert.equal(res.body.users[0].email, ACCOUNTS[1]);
    });

    test('matches on the name, case-insensitively', async () => {
      await createPending({ email: 'nuevo@uaq.mx', fullName: 'Rodrigo Salas' });

      const res = await server.get('/api/users/search?q=RODRIGO', { token: adminToken });

      assert.equal(res.body.users.length, 1);
      assert.equal(res.body.users[0].fullName, 'Rodrigo Salas');
    });

    test('returns the narrow shape, never the admin one', async () => {
      const res = await server.get('/api/users/search?q=uaq', { token: adminToken });

      for (const user of res.body.users) {
        assert.deepEqual(Object.keys(user).sort(), ['email', 'fullName', 'id']);
      }
    });

    test('a soft-deleted user is not a match', async () => {
      const doomed = await createPending({ email: 'fuerabusca@uaq.mx', role: 'worker' });
      await softDelete(doomed.id);

      const res = await server.get('/api/users/search?q=fuerabusca', { token: adminToken });

      assert.equal(res.body.users.length, 0);
    });

    for (const [label, q] of [
      ['a one-character query', 'a'],
      ['an empty query', ''],
      ['a missing query', undefined],
    ]) {
      test(`${label} is 400`, async () => {
        const url = q === undefined ? '/api/users/search' : `/api/users/search?q=${q}`;
        const res = await server.get(url, { token: adminToken });

        assert.equal(res.status, 400);
        assert.equal(
          res.body.error.message,
          'Search query must be at least 2 characters.',
        );
      });
    }
  });
});
