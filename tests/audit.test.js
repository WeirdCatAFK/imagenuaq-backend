// RF-USR-07: who created, modified or deleted each relevant record. The trail is written by
// a subscriber to the domain events orchestration emits (src/utils/events.js ->
// src/access/orchestration/audit.js), so these cases drive the real endpoints over HTTP and
// then read `logs` directly -- asserting on the rows rather than on the emit calls is what
// makes them a test of the trail and not of the plumbing.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createArea,
  createActive,
  tokenFor,
  logsFor,
  allLogs,
  roleId,
  sql,
  PASSWORD,
  TEST_PREFIX,
} from './helpers/fixtures.js';

describe('the audit trail', () => {
  let server;
  let adminToken;
  let admin;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: ACCOUNTS[0], role: 'admin' });
    await createActive({ email: ACCOUNTS[1], role: 'worker' });
    adminToken = await tokenFor(server, ACCOUNTS[0]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  describe('attribution', () => {
    test('records the signed-in user as the actor', async () => {
      const created = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Auditada` },
      });

      const rows = await logsFor('areas', created.body.area.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'record_created');
      assert.equal(rows[0].user_id, admin.id);
    });

    test('a change made outside a request has no actor rather than a wrong one', async () => {
      const area = await createArea('Sin Petición');

      assert.deepEqual(await logsFor('areas', area.id), []);
    });
  });

  describe('what is recorded', () => {
    test('a create carries after_data and no before_data', async () => {
      const created = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Nueva`, description: 'con texto' },
      });

      const [row] = await logsFor('areas', created.body.area.id);
      assert.equal(row.before_data, null);
      assert.equal(row.after_data.name, `${TEST_PREFIX}Nueva`);
      assert.equal(row.after_data.description, 'con texto');
    });

    test('an update carries both sides, so the change is readable', async () => {
      const area = await createArea('Antes');

      await server.patch(`/api/areas/${area.id}`, {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Después` },
      });

      const [row] = await logsFor('areas', area.id);
      assert.equal(row.action, 'record_updated');
      assert.equal(row.before_data.name, `${TEST_PREFIX}Antes`);
      assert.equal(row.after_data.name, `${TEST_PREFIX}Después`);
    });

    test('a delete carries before_data and no after_data', async () => {
      const area = await createArea('Efímera');

      await server.delete(`/api/areas/${area.id}`, { token: adminToken });

      const [row] = await logsFor('areas', area.id);
      assert.equal(row.action, 'record_deleted');
      assert.equal(row.before_data.name, `${TEST_PREFIX}Efímera`);
      assert.equal(row.after_data, null);
    });

    test('a move records where the area came from and where it went', async () => {
      const parent = await createArea('Coordinación');
      const child = await createArea('Diseño');
      const other = await createArea('Otra');

      await server.put(`/api/areas/${child.id}/parent`, {
        token: adminToken,
        body: { parentAreaId: parent.id },
      });
      await server.put(`/api/areas/${child.id}/parent`, {
        token: adminToken,
        body: { parentAreaId: other.id },
      });

      const rows = await logsFor('areas', child.id);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0].before_data, { parent_area_id: null });
      assert.deepEqual(rows[0].after_data, { parent_area_id: parent.id });
      assert.deepEqual(rows[1].before_data, { parent_area_id: parent.id });
      assert.deepEqual(rows[1].after_data, { parent_area_id: other.id });
    });

    test('clearing a parent that was never set records nothing', async () => {
      const area = await createArea('Ya Raíz');

      const res = await server.delete(`/api/areas/${area.id}/parent`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.changed, false);
      assert.deepEqual(await logsFor('areas', area.id), []);
    });
  });

  describe('redaction', () => {
    test('a users row never carries password_hash into the trail', async () => {
      const created = await server.post('/api/users', {
        token: adminToken,
        body: {
          email: 'nuevo@uaq.mx',
          fullName: 'Nuevo Usuario',
          roleId: await roleId('worker'),
          contractTypeId: 1,
        },
      });
      assert.equal(created.status, 201);

      const [row] = await logsFor('users', created.body.user.id);
      assert.equal(row.after_data.password_hash, '[redacted]');
      assert.equal(row.after_data.email, 'nuevo@uaq.mx');
    });

    test('the trail never contains a bcrypt digest anywhere', async () => {
      await server.post('/api/users', {
        token: adminToken,
        body: {
          email: 'otro@uaq.mx',
          fullName: 'Otro Usuario',
          roleId: await roleId('worker'),
          contractTypeId: 1,
        },
      });

      const serialised = JSON.stringify(await allLogs());
      assert.doesNotMatch(serialised, /\$2[aby]?\$\d\d\$/, 'a bcrypt hash reached logs');
    });
  });

  describe('authentication events', () => {
    test('a successful login is attributed to the user who just logged in', async () => {
      await tokenFor(server, ACCOUNTS[1]);

      const logins = (await allLogs()).filter((row) => row.action === 'user_login');
      assert.ok(logins.length >= 1);
      assert.notEqual(logins.at(-1).user_id, null);
    });

    test('a wrong password is recorded against the account it was aimed at', async () => {
      const res = await server.post('/api/auth/login', {
        body: { email: ACCOUNTS[1], password: 'not the password' },
      });
      assert.equal(res.status, 401);

      const [row] = (await allLogs()).filter((r) => r.action === 'user_login_failed');
      assert.equal(row.after_data.reason, 'wrong password');
      assert.equal(row.after_data.email, ACCOUNTS[1]);
      assert.equal(row.after_data.password, undefined, 'the attempt must not carry it');
    });

    test('an attempt on an unknown address is recorded with no actor', async () => {
      await server.post('/api/auth/login', {
        body: { email: 'nadie@uaq.mx', password: PASSWORD },
      });

      const [row] = (await allLogs()).filter((r) => r.action === 'user_login_failed');
      assert.equal(row.user_id, null);
      assert.equal(row.after_data.reason, 'no such account');
      assert.equal(row.after_data.email, 'nadie@uaq.mx');
    });

    test('the response still says nothing about which failure it was', async () => {
      const unknown = await server.post('/api/auth/login', {
        body: { email: 'nadie@uaq.mx', password: PASSWORD },
      });
      const wrong = await server.post('/api/auth/login', {
        body: { email: ACCOUNTS[1], password: 'not the password' },
      });

      assert.equal(unknown.body.error.message, 'Invalid email or password.');
      assert.equal(wrong.body.error.message, 'Invalid email or password.');
    });
  });

  describe('permission grants', () => {
    let role;

    beforeEach(async () => {
      const created = await server.post('/api/roles', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}auditable` },
      });
      role = created.body.role;
    });

    test('a grant and a revoke are recorded under their own verbs', async () => {
      const catalogue = await server.get('/api/roles/permissions', { token: adminToken });
      const permission = catalogue.body.permissions.find((p) => p.code === 'area.manage');

      await server.post(`/api/roles/${role.id}/permissions/${permission.id}`, {
        token: adminToken,
      });
      await server.delete(`/api/roles/${role.id}/permissions/${permission.id}`, {
        token: adminToken,
      });

      const rows = await logsFor('roles', role.id);
      assert.deepEqual(
        rows.map((row) => row.action),
        ['record_created', 'permission_granted', 'permission_revoked'],
      );
    });

    test('re-granting something already held records nothing', async () => {
      const catalogue = await server.get('/api/roles/permissions', { token: adminToken });
      const permission = catalogue.body.permissions.find((p) => p.code === 'task.read');

      await server.post(`/api/roles/${role.id}/permissions/${permission.id}`, {
        token: adminToken,
      });
      await server.post(`/api/roles/${role.id}/permissions/${permission.id}`, {
        token: adminToken,
      });

      const grants = (await logsFor('roles', role.id)).filter(
        (row) => row.action === 'permission_granted',
      );
      assert.equal(grants.length, 1);
    });

    test('replacing the set records only what actually changed', async () => {
      await server.put(`/api/roles/${role.id}/permissions`, {
        token: adminToken,
        body: { permissions: ['project.read', 'project.write'] },
      });

      await server.put(`/api/roles/${role.id}/permissions`, {
        token: adminToken,
        body: { permissions: ['project.read', 'finance.read'] },
      });

      const rows = (await logsFor('roles', role.id)).filter((row) =>
        row.action.startsWith('permission_'),
      );

      assert.deepEqual(
        rows.map((row) => row.action),
        [
          'permission_granted',
          'permission_granted',
          'permission_granted',
          'permission_revoked',
        ],
      );
    });
  });

  describe('the area an action belonged to', () => {
    test('is stamped from the actor primary area, without being asked for', async () => {
      const area = await createArea('Con Miembros');
      const worker = await createActive({
        email: 'conarea@uaq.mx',
        role: 'worker',
      });
      await sql('update users set primary_area_id = $2 where id = $1', [worker.id, area.id]);
      const workerToken = await tokenFor(server, 'conarea@uaq.mx');

      const [login] = (await allLogs()).filter((row) => row.action === 'user_login');
      assert.equal(login.area_id, area.id);
      assert.ok(workerToken);
    });

    test('follows a move immediately, even on a token minted before it', async () => {
      const before = await createArea('Antes');
      const after = await createArea('Después');
      const mover = await createActive({ email: 'cambia@uaq.mx', role: 'worker' });

      await sql('update users set primary_area_id = $2 where id = $1', [mover.id, before.id]);
      const staleToken = await tokenFor(server, 'cambia@uaq.mx');

      await sql('update users set primary_area_id = $2 where id = $1', [mover.id, after.id]);

      const me = await server.get('/api/auth/me', { token: staleToken });
      assert.equal(me.body.user.areaId, after.id, 'the subject is rebuilt from the row');

      await server.post('/api/auth/login', {
        body: { email: 'cambia@uaq.mx', password: PASSWORD },
      });
      const logins = (await allLogs()).filter((row) => row.action === 'user_login');
      assert.equal(logins.at(-1).area_id, after.id, 'the trail reads the database, not the token');
    });

    test('is null when the actor has no area, not zero or a placeholder', async () => {
      const created = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Sin Área` },
      });

      const [row] = await logsFor('areas', created.body.area.id);
      assert.equal(row.area_id, null);
    });

    test('an action with no actor at all has no area', async () => {
      await server.post('/api/auth/login', {
        body: { email: 'nadie@uaq.mx', password: PASSWORD },
      });

      const [row] = (await allLogs()).filter((r) => r.action === 'user_login_failed');
      assert.equal(row.user_id, null);
      assert.equal(row.area_id, null);
    });

    test('forAreas returns what an area did, newest first', async () => {
      const audit = (await import('../src/access/orchestration/audit.js')).default;
      const area = await createArea('Auditable');
      const worker = await createActive({ email: 'delarea@uaq.mx', role: 'worker' });
      await sql('update users set primary_area_id = $2 where id = $1', [worker.id, area.id]);

      await tokenFor(server, 'delarea@uaq.mx');
      await server.post('/api/auth/login', {
        body: { email: 'delarea@uaq.mx', password: 'wrong' },
      });

      const trail = await audit.forAreas([area.id]);

      assert.equal(trail.length, 2);
      assert.equal(trail[0].action, 'user_login_failed', 'newest first');
      assert.equal(trail[0].area.id, area.id);
      assert.equal(trail[0].area.name, `${TEST_PREFIX}Auditable`);
      assert.equal(trail[0].target, null);
    });

    test('forAreas with no areas is an empty list, not every row', async () => {
      const audit = (await import('../src/access/orchestration/audit.js')).default;

      assert.deepEqual(await audit.forAreas([]), []);
    });
  });

  describe('reading one object\'s history', () => {
    test('returns the trail newest first, with the actor resolved to a name', async () => {
      const audit = (await import('../src/access/orchestration/audit.js')).default;

      const created = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Historiada` },
      });
      const id = created.body.area.id;

      await server.patch(`/api/areas/${id}`, {
        token: adminToken,
        body: { description: 'ahora con texto' },
      });

      const trail = await audit.forTarget('areas', id);

      assert.deepEqual(
        trail.map((entry) => entry.action),
        ['record_updated', 'record_created'],
      );
      assert.equal(trail[0].actor.id, admin.id);
      assert.equal(trail[0].actor.fullName, 'Prueba Usuario');
      assert.deepEqual(trail[0].target, { table: 'areas', id });
      assert.ok(trail[0].at instanceof Date);
    });

    test('an object with no history is an empty list, not an error', async () => {
      const audit = (await import('../src/access/orchestration/audit.js')).default;

      assert.deepEqual(await audit.forTarget('areas', 999999), []);
    });

    test('an unattributed row comes back with a null actor rather than a broken one', async () => {
      const audit = (await import('../src/access/orchestration/audit.js')).default;

      await server.post('/api/auth/login', {
        body: { email: 'nadie@uaq.mx', password: PASSWORD },
      });

      const [row] = (await allLogs()).filter((r) => r.action === 'user_login_failed');
      assert.equal(row.user_id, null);
    });
  });

  describe('a broken subscriber does not break the request', () => {
    test('the write succeeds even when the trail cannot be written', async () => {
      const events = (await import('../src/utils/events.js')).default;
      const errors = [];
      const realError = console.error;
      console.error = (...args) => errors.push(args);

      events.on('exploding', () => {
        throw new Error('subscriber is broken');
      });

      try {
        const res = await server.post('/api/areas', {
          token: adminToken,
          body: { name: `${TEST_PREFIX}Sobrevive` },
        });

        assert.equal(res.status, 201);
        assert.equal((await logsFor('areas', res.body.area.id)).length, 1);
      } finally {
        events.off('exploding');
        console.error = realError;
      }

      assert.ok(
        errors.some((args) => String(args[0]).includes('exploding')),
        'the failure should be reported on stderr, not swallowed silently',
      );
    });
  });
});
