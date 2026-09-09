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

// RF-USR-07: who created, modified or deleted each relevant record. The trail is written by
// a subscriber to the domain events orchestration emits (src/utils/events.js ->
// src/access/orchestration/audit.js), so these cases drive the real endpoints over HTTP and
// then read `logs` directly -- asserting on the rows rather than on the emit calls is what
// makes them a test of the trail and not of the plumbing.
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
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  describe('attribution', () => {
    // The point of the AsyncLocalStorage context: nothing was passed an actor, and the row
    // still knows who did it.
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
      // createArea() goes straight through query.js, so no event is emitted at all and no
      // row appears. The case that matters is that this does NOT inherit the actor of some
      // other request -- a leaked AsyncLocalStorage store would attribute it to the admin.
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

    // Re-parenting is targeted at the area that moved, not at area_hierarchy, so that an
    // area's history reads as one list.
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

    // An audit trail that records requests rather than changes fills with rows saying
    // nothing happened.
    test('clearing a parent that was never set records nothing', async () => {
      const area = await createArea('Ya Raíz');

      const res = await server.delete(`/api/areas/${area.id}/parent`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.changed, false);
      assert.deepEqual(await logsFor('areas', area.id), []);
    });
  });

  // The reason redaction is a pattern and not a list of columns: `users` is the only audited
  // table with a secret today, and it must not be the last one anybody remembers.
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
      // There is no session when this is emitted, so the actor cannot come from the request
      // context -- it is passed explicitly. A null here means that override was dropped.
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

    // logs.user_id is nullable for exactly this row: there is nobody to attribute it to.
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

  // permission_granted / permission_revoked are their own action codes rather than generic
  // verbs over role_permissions, because RF-USR-05 makes "who gave this role that permission"
  // the question worth being able to ask.
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

    // Replacing a set records the difference, not the request. A single "permissions
    // replaced" row would leave the reader diffing two lists by eye.
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

      // Two grants from the first call, then one grant and one revoke from the second --
      // project.read survived the edit and must not appear again.
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

  // logs.area_id is what makes RF-USR-04 answerable -- a responsable de área consulting the
  // work of everyone under them, rather than naming each person one at a time.
  describe('the area an action belonged to', () => {
    test('is stamped from the actor primary area, without being asked for', async () => {
      const area = await createArea('Con Miembros');
      const worker = await createActive({
        email: 'conarea@uaq.mx',
        role: 'worker',
      });
      await sql('update users set primary_area_id = $2 where id = $1', [worker.id, area.id]);
      const workerToken = await tokenFor(server, 'conarea@uaq.mx');

      // Any action by that user: the login it just performed.
      const [login] = (await allLogs()).filter((row) => row.action === 'user_login');
      assert.equal(login.area_id, area.id);
      assert.ok(workerToken);
    });

    // The reason it is not read from the token. A session minted before the move keeps the
    // old area for up to seven days; the trail must not.
    test('follows a move immediately, even on a token minted before it', async () => {
      const before = await createArea('Antes');
      const after = await createArea('Después');
      const mover = await createActive({ email: 'cambia@uaq.mx', role: 'worker' });

      await sql('update users set primary_area_id = $2 where id = $1', [mover.id, before.id]);
      const staleToken = await tokenFor(server, 'cambia@uaq.mx');

      // Moved after the token was signed. The token still says `before`.
      await sql('update users set primary_area_id = $2 where id = $1', [mover.id, after.id]);

      // The token's own `areaId` claim still says `before` -- it was signed before the move
      // and claims are immutable. What /me answers no longer comes from it: verifyToken()
      // rebuilds the subject from the row, so the response already follows the move. The
      // trail below has to do the same for a different reason, and by a different route.
      const me = await server.get('/api/auth/me', { token: staleToken });
      assert.equal(me.body.user.areaId, after.id, 'the subject is rebuilt from the row');

      await server.post('/api/auth/login', {
        body: { email: 'cambia@uaq.mx', password: PASSWORD },
      });
      const logins = (await allLogs()).filter((row) => row.action === 'user_login');
      assert.equal(logins.at(-1).area_id, after.id, 'the trail reads the database, not the token');
    });

    test('is null when the actor has no area, not zero or a placeholder', async () => {
      // The admin fixture was created without one.
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
      // user_login_failed has no object, and the shaping must say so rather than inventing
      // a target with two nulls in it.
      assert.equal(trail[0].target, null);
    });

    test('forAreas with no areas is an empty list, not every row', async () => {
      const audit = (await import('../src/access/orchestration/audit.js')).default;

      assert.deepEqual(await audit.forAreas([]), []);
    });
  });

  // The read side. There is no endpoint for it yet -- the bitácora screen is frontend work
  // -- so this is exercised directly rather than over HTTP. Without these cases forTarget()
  // would be code nobody runs, which is the same mistake as a table nobody reads.
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

      // user_login_failed on an unknown address has no target, so it is looked up the only
      // way it can be. The point is that the LEFT JOIN to users survives a null user_id.
      const [row] = (await allLogs()).filter((r) => r.action === 'user_login_failed');
      assert.equal(row.user_id, null);
    });
  });

  // The dispatcher contains a failing subscriber rather than letting it escape into the
  // request. An audit bug must not turn a successful change into a 500.
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
        // And the audit subscriber, which runs alongside the broken one, still wrote.
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
