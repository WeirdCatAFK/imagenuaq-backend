import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createActive,
  findUser,
  logsFor,
  tokenFor,
  PASSWORD,
} from './helpers/fixtures.js';

// A person editing their own record through /api/auth/me. The write half of /api/users is
// admin-only and these cases exist to show that the self-service block is not a way round
// it: the keys coordination owns are dropped, the id comes from the session and nowhere
// else, and a password change demands the current one first.
describe('/api/auth/me self-service', () => {
  let server;
  let adminToken;
  let workerToken;
  let worker;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64',
  );

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: 'admin' });
    worker = await createActive({
      email: ACCOUNTS[1],
      fullName: 'Ana Gómez',
      role: 'worker',
    });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  // Each case restores the worker's own row: the file logs in once and every case edits
  // the same account, so a rename left behind would leak into the next assertion.
  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    await server.patch('/api/auth/me', {
      token: workerToken,
      body: { fullName: 'Ana Gómez', email: ACCOUNTS[1], birthday: null },
    });
    await server.delete('/api/auth/me/picture', { token: workerToken });
  });

  describe('GET /api/auth/me/profile', () => {
    test('needs a session', async () => {
      const res = await server.get('/api/auth/me/profile');
      assert.equal(res.status, 401);
    });

    test('a worker sees their own birthday and contract type', async () => {
      const res = await server.get('/api/auth/me/profile', { token: workerToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.id, worker.id);
      assert.ok(Object.hasOwn(res.body.user, 'birthday'));
      assert.ok(Object.hasOwn(res.body.user, 'contractTypeId'));
      assert.ok(Array.isArray(res.body.user.areas));
    });
  });

  describe('PATCH /api/auth/me', () => {
    test('a worker may rename themselves, and the session follows', async () => {
      const res = await server.patch('/api/auth/me', {
        token: workerToken,
        body: { fullName: 'Ana G. Ruiz', birthday: '1990-05-04' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.fullName, 'Ana G. Ruiz');
      assert.equal(res.body.user.birthday, '1990-05-04');
      // The response carries the role, as GET does; a bare RETURNING row would say null.
      assert.equal(res.body.user.role, 'worker');
      assert.equal(res.body.user.roleId, worker.role_id);

      // verifyToken() re-reads the row, so the same token now carries the new name.
      const me = await server.get('/api/auth/me', { token: workerToken });
      assert.equal(me.body.user.fullName, 'Ana G. Ruiz');
    });

    test('contract type, area and schedule are ignored, not applied', async () => {
      const before = await findUser(worker.id);

      const res = await server.patch('/api/auth/me', {
        token: workerToken,
        body: { contractTypeId: 999, primaryAreaId: 999, scheduleId: 999 },
      });

      assert.equal(res.status, 200);

      const after = await findUser(worker.id);
      assert.equal(after.contract_type_id, before.contract_type_id);
      assert.equal(after.primary_area_id, before.primary_area_id);
      assert.equal(after.schedule_id, before.schedule_id);
    });

    test('an address already taken is 409', async () => {
      const res = await server.patch('/api/auth/me', {
        token: workerToken,
        body: { email: ACCOUNTS[0] },
      });

      assert.equal(res.status, 409);
    });

    test('an empty name is 400', async () => {
      const res = await server.patch('/api/auth/me', {
        token: workerToken,
        body: { fullName: '   ' },
      });

      assert.equal(res.status, 400);
    });

    test('the change is on the trail, attributed to the person', async () => {
      await server.patch('/api/auth/me', {
        token: workerToken,
        body: { fullName: 'Ana Renombrada' },
      });

      const logs = await logsFor('users', worker.id);
      const updated = logs.filter((row) => row.action === 'record_updated');
      assert.ok(updated.length > 0);
      assert.equal(updated.at(-1).user_id, worker.id);
    });
  });

  describe('PUT /api/auth/me/password', () => {
    const change = (body, token = workerToken) =>
      server.put('/api/auth/me/password', { token, body });

    test('a wrong current password is 401', async () => {
      const res = await change({ currentPassword: 'not it', newPassword: 'otra cosa larga' });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Current password is incorrect.');
    });

    test('a short new password is 400', async () => {
      const res = await change({ currentPassword: PASSWORD, newPassword: 'corta' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Password must be at least 8 characters long.');
    });

    test('a missing field is 400', async () => {
      const res = await change({ newPassword: 'otra cosa larga' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Current and new passwords are required.');
    });

    test('the new password logs in and the old one does not', async () => {
      const NEW = 'una contrasena nueva';

      const res = await change({ currentPassword: PASSWORD, newPassword: NEW });
      assert.equal(res.status, 204);

      const old = await server.post('/api/auth/login', {
        body: { email: ACCOUNTS[1], password: PASSWORD },
      });
      assert.equal(old.status, 401);

      const fresh = await server.post('/api/auth/login', {
        body: { email: ACCOUNTS[1], password: NEW },
      });
      assert.equal(fresh.status, 200);

      // The session the change was made from keeps working: token_version is untouched.
      const me = await server.get('/api/auth/me', { token: workerToken });
      assert.equal(me.status, 200);

      // Put it back so the other cases, and the file's own login, still work.
      await change({ currentPassword: NEW, newPassword: PASSWORD });
    });
  });

  describe('/api/auth/me/picture', () => {
    const put = (bytes, contentType = 'image/png', token = workerToken) =>
      server.put('/api/auth/me/picture', {
        token,
        raw: bytes,
        headers: { 'content-type': contentType },
      });

    test('none set is 404', async () => {
      const res = await server.get('/api/auth/me/picture', { token: workerToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'No profile picture set.');
    });

    test('a worker may set their own, and a colleague may then read it', async () => {
      const stored = await put(PNG);
      assert.equal(stored.status, 204);

      const own = await server.get('/api/auth/me/picture', { token: workerToken });
      assert.equal(own.status, 200);
      assert.equal(own.headers.get('content-type'), 'image/png');

      const colleague = await server.get(`/api/users/${worker.id}/picture`, {
        token: adminToken,
      });
      assert.equal(colleague.status, 200);
    });

    test('a type off the allow-list is 400', async () => {
      const res = await put(Buffer.from('hello'), 'text/plain');

      assert.equal(res.status, 400);
    });

    test('delete clears it', async () => {
      await put(PNG);

      const removed = await server.delete('/api/auth/me/picture', { token: workerToken });
      assert.equal(removed.status, 204);

      const res = await server.get('/api/auth/me/picture', { token: workerToken });
      assert.equal(res.status, 404);
    });
  });
});
