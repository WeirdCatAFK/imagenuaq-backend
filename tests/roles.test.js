import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createActive,
  tokenFor,
  roleId,
  TEST_PREFIX,
  TEST_PERMISSION_PREFIX,
} from './helpers/fixtures.js';
import auth from '../src/access/orchestration/auth.js';

// The role catalogue and the grants each role holds. `role_permissions` is empty in a fresh
// database by the role-permissions migration's own decision (RF-USR-05: which role gets
// what is coordination's call), so most of what these cases assert is the endpoint that
// stops it being empty.
describe('/api/roles', () => {
  let server;
  let adminToken;
  let workerToken;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];
  const name = (suffix) => `${TEST_PREFIX}${suffix}`;

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

  beforeEach(() => resetCases(ACCOUNTS));

  describe('authentication and role', () => {
    test('reading without a token is 401', async () => {
      const res = await server.get('/api/roles');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    // The catalogues are readable by anyone signed in: a form that assigns a role has to
    // list the roles, and hiding the list would mean hard-coding the four seeded names.
    for (const path of ['/api/roles', '/api/roles/permissions']) {
      test(`a worker may read ${path}`, async () => {
        const res = await server.get(path, { token: workerToken });

        assert.equal(res.status, 200);
      });
    }

    for (const [label, call] of [
      ['POST /', (s, t) => s.post('/api/roles', { token: t, body: { name: 'x' } })],
      ['PATCH /:id', (s, t) => s.patch('/api/roles/1', { token: t, body: { name: 'x' } })],
      ['DELETE /:id', (s, t) => s.delete('/api/roles/1', { token: t })],
      [
        'PUT /:id/permissions',
        (s, t) => s.put('/api/roles/1/permissions', { token: t, body: { permissions: [] } }),
      ],
      ['POST /:id/permissions/:pid', (s, t) => s.post('/api/roles/1/permissions/1', { token: t })],
      ['DELETE /:id/permissions/:pid', (s, t) => s.delete('/api/roles/1/permissions/1', { token: t })],
      [
        'POST /permissions',
        (s, t) => s.post('/api/roles/permissions', { token: t, body: { code: 'a.b', label: 'x' } }),
      ],
    ]) {
      test(`a worker is refused ${label}`, async () => {
        const res = await call(server, workerToken);

        assert.equal(res.status, 403);
        assert.equal(res.body.error.message, 'Insufficient role for this resource.');
      });
    }
  });

  describe('the role catalogue', () => {
    test('lists the four seeded roles', async () => {
      const res = await server.get('/api/roles', { token: workerToken });

      assert.equal(res.status, 200);
      const names = res.body.roles.map((role) => role.name);
      for (const seeded of ['admin', 'area_lead', 'worker', 'finance']) {
        assert.ok(names.includes(seeded), `${seeded} should be in the catalogue`);
      }
    });

    test('creates a role', async () => {
      const res = await server.post('/api/roles', {
        token: adminToken,
        body: { name: name('editorial'), description: 'Corrección de estilo' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.role.name, name('editorial'));
      assert.equal(res.body.role.description, 'Corrección de estilo');
    });

    test('a duplicate name is 409', async () => {
      const res = await server.post('/api/roles', {
        token: adminToken,
        body: { name: 'admin' },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'A role with that name already exists.');
    });

    for (const [label, body] of [
      ['a missing name', {}],
      ['a blank name', { name: '  ' }],
      ['a name over 50 characters', { name: `${TEST_PREFIX}${'a'.repeat(51)}` }],
    ]) {
      test(`${label} is 400`, async () => {
        const res = await server.post('/api/roles', { token: adminToken, body });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'Role name is required (50 characters or fewer).');
      });
    }

    test('renames a role', async () => {
      const created = await server.post('/api/roles', {
        token: adminToken,
        body: { name: name('antes') },
      });

      const res = await server.patch(`/api/roles/${created.body.role.id}`, {
        token: adminToken,
        body: { name: name('después') },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.role.name, name('después'));
    });

    test('deletes a role nobody holds', async () => {
      const created = await server.post('/api/roles', {
        token: adminToken,
        body: { name: name('efímero') },
      });

      const res = await server.delete(`/api/roles/${created.body.role.id}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.role.id, created.body.role.id);
    });

    // users.role_id is NOT NULL and there is no defensible default to move holders to, so
    // this is refused rather than resolved. The count is in the message on purpose.
    test('deleting a role that users still hold is 409 with the count', async () => {
      const res = await server.delete(`/api/roles/${await roleId('worker')}`, {
        token: adminToken,
      });

      assert.equal(res.status, 409);
      assert.equal(
        res.body.error.message,
        'That role is still held by 1 user; reassign them first.',
      );
    });

    test('an id that names no role is 404', async () => {
      const res = await server.get('/api/roles/999999', { token: workerToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Role not found.');
    });

    test('a non-numeric id is 400', async () => {
      const res = await server.get('/api/roles/abc', { token: workerToken });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Invalid role id.');
    });
  });

  describe('the permission catalogue', () => {
    // /permissions is declared before /:id in routes/roles.js. With them the other way
    // round Express reads this URL as an id and refuses it as "Invalid role id."
    test('GET /permissions is not captured by /:id', async () => {
      const res = await server.get('/api/roles/permissions', { token: workerToken });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.permissions));
    });

    // The eleven seeded codes are the requirements made data. These two in particular:
    // RF-USR-10 says seeing the reason for an absence is a different permission from seeing
    // that somebody is away, and their being two rows is what stops them collapsing.
    test('availability.read and absence.reason.read are separate rows', async () => {
      const res = await server.get('/api/roles/permissions', { token: workerToken });

      const codes = res.body.permissions.map((permission) => permission.code);
      assert.ok(codes.includes('availability.read'));
      assert.ok(codes.includes('absence.reason.read'));
    });

    test('creates a permission', async () => {
      const res = await server.post('/api/roles/permissions', {
        token: adminToken,
        body: { code: `${TEST_PERMISSION_PREFIX}write`, label: 'Prueba' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.permission.code, `${TEST_PERMISSION_PREFIX}write`);
    });

    // requirePermission() compares these strings literally, so a code that is not in the
    // house form is a permission nobody will ever successfully ask for.
    for (const code of ['nodots', 'Project.Read', 'project write', 'project.', '.read']) {
      test(`the code ${JSON.stringify(code)} is 400`, async () => {
        const res = await server.post('/api/roles/permissions', {
          token: adminToken,
          body: { code, label: 'Prueba' },
        });

        assert.equal(res.status, 400);
        assert.equal(
          res.body.error.message,
          'Permission code must be dotted lowercase, e.g. project.write.',
        );
      });
    }

    test('a duplicate code is 409', async () => {
      const res = await server.post('/api/roles/permissions', {
        token: adminToken,
        body: { code: 'project.read', label: 'Otra vez' },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'A permission with that code already exists.');
    });

    test('deletes a permission', async () => {
      const created = await server.post('/api/roles/permissions', {
        token: adminToken,
        body: { code: `${TEST_PERMISSION_PREFIX}delete`, label: 'Borrable' },
      });

      const res = await server.delete(`/api/roles/permissions/${created.body.permission.id}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.permission.id, created.body.permission.id);
    });
  });

  describe('grants', () => {
    let role;
    let permissions;

    beforeEach(async () => {
      const created = await server.post('/api/roles', {
        token: adminToken,
        body: { name: name('con-permisos') },
      });
      role = created.body.role;

      const catalogue = await server.get('/api/roles/permissions', { token: adminToken });
      permissions = Object.fromEntries(
        catalogue.body.permissions.map((permission) => [permission.code, permission.id]),
      );
    });

    // Section 8 of catalog-bootstrap seeds the two grants that are definitions rather than
    // configuration. They are load-bearing: an `admin` with no permissions is the bootstrap
    // deadlock that migration was written to avoid, and a `finance` without finance.read is
    // a role name with no meaning under RF-USR-08.
    test('admin arrives holding every permission', async () => {
      const catalogue = await server.get('/api/roles/permissions', { token: adminToken });
      const held = await server.get(`/api/roles/${await roleId('admin')}/permissions`, {
        token: adminToken,
      });

      assert.equal(held.body.permissions.length, catalogue.body.permissions.length);
    });

    test('finance arrives holding finance.read and nothing else', async () => {
      const held = await server.get(`/api/roles/${await roleId('finance')}/permissions`, {
        token: adminToken,
      });

      assert.deepEqual(
        held.body.permissions.map((permission) => permission.code),
        ['finance.read'],
      );
    });

    // Policy, not definition -- left to coordination on purpose (RF-USR-05).
    for (const seeded of ['worker', 'area_lead']) {
      test(`${seeded} arrives holding nothing`, async () => {
        const held = await server.get(`/api/roles/${await roleId(seeded)}/permissions`, {
          token: adminToken,
        });

        assert.deepEqual(held.body.permissions, []);
      });
    }

    test('a fresh role holds nothing', async () => {
      const res = await server.get(`/api/roles/${role.id}/permissions`, { token: workerToken });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.permissions, []);
    });

    test('granting one permission is 201, granting it again is 200', async () => {
      const first = await server.post(
        `/api/roles/${role.id}/permissions/${permissions['area.manage']}`,
        { token: adminToken },
      );
      assert.equal(first.status, 201);
      assert.equal(first.body.granted, true);

      const again = await server.post(
        `/api/roles/${role.id}/permissions/${permissions['area.manage']}`,
        { token: adminToken },
      );
      assert.equal(again.status, 200);
      assert.equal(again.body.granted, false);
    });

    test('revoking removes the grant', async () => {
      await server.post(`/api/roles/${role.id}/permissions/${permissions['task.read']}`, {
        token: adminToken,
      });

      const res = await server.delete(
        `/api/roles/${role.id}/permissions/${permissions['task.read']}`,
        { token: adminToken },
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.revoked, true);

      const held = await server.get(`/api/roles/${role.id}/permissions`, { token: adminToken });
      assert.deepEqual(held.body.permissions, []);
    });

    test('revoking a grant the role does not hold is 404', async () => {
      const res = await server.delete(
        `/api/roles/${role.id}/permissions/${permissions['task.read']}`,
        { token: adminToken },
      );

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'That role does not hold that permission.');
    });

    test('granting a permission that does not exist is 404', async () => {
      const res = await server.post(`/api/roles/${role.id}/permissions/999999`, {
        token: adminToken,
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Permission not found.');
    });

    describe('PUT /:id/permissions replaces the whole set', () => {
      test('sets the grants named by code', async () => {
        const res = await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: ['project.read', 'project.write'] },
        });

        assert.equal(res.status, 200);
        assert.deepEqual(
          res.body.permissions.map((permission) => permission.code),
          ['project.read', 'project.write'],
        );
      });

      test('a second call replaces rather than adds', async () => {
        await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: ['project.read', 'project.write'] },
        });

        await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: ['finance.read'] },
        });

        const held = await server.get(`/api/roles/${role.id}/permissions`, { token: adminToken });
        assert.deepEqual(
          held.body.permissions.map((permission) => permission.code),
          ['finance.read'],
        );
      });

      // The empty set is not an edge case: it is how a role's last permission is revoked,
      // and the driver serialises an empty array in a way Postgres rejects unless the query
      // asks for it back. Nothing else in the suite would catch that.
      test('an empty array revokes everything', async () => {
        await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: ['project.read'] },
        });

        const res = await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: [] },
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.permissions, []);
      });

      test('a duplicate code in the list is not an error', async () => {
        const res = await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: ['project.read', 'project.read'] },
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.permissions.length, 1);
      });

      test('an unknown code is 400 and names the code', async () => {
        const res = await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: ['project.read', 'project.delete'] },
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'Unknown permission code: project.delete.');
      });

      test('a non-array body is 400', async () => {
        const res = await server.put(`/api/roles/${role.id}/permissions`, {
          token: adminToken,
          body: { permissions: 'project.read' },
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'permissions must be an array of permission codes.');
      });
    });

    // The whole reason this endpoint exists. requirePermission() reads role_permissions per
    // request rather than from the token precisely so a grant written now takes effect now,
    // and permissionsFor() is what it calls.
    test('a grant written here is what permissionsFor() reads back', async () => {
      await server.put(`/api/roles/${role.id}/permissions`, {
        token: adminToken,
        body: { permissions: ['area.manage', 'project.read'] },
      });

      assert.deepEqual(await auth.permissionsFor(role.id), ['area.manage', 'project.read']);
    });
  });
});
