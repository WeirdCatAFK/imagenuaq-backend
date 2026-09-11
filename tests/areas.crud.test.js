import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createArea,
  createActive,
  tokenFor,
  areaId,
  TEST_PREFIX,
} from './helpers/fixtures.js';

// The catalogue half of /api/areas: creating, listing, renaming and deleting. The hierarchy
// and the chart are areas.orgchart.test.js; memberships are areas.members.test.js.
describe('/api/areas', () => {
  let server;
  let adminToken;
  let workerToken;

  // The two accounts are created ONCE. Re-creating them per case costs two bcrypt hashes at
  // cost 12 and two real logins -- about four seconds a test -- and nothing any case does
  // changes either account, so there is nothing for the repetition to protect.
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
    // resetCases() before reset(): area_members and users reference areas, so deleting the
    // areas first raises a foreign-key error, the hook throws, and server.close() never
    // runs -- which leaves this file's rows behind for whatever runs next.
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  describe('authentication and role', () => {
    test('reading without a token is 401', async () => {
      const res = await server.get('/api/areas');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    // The point of the two-block guard layout in routes/areas.js: reads are open to
    // everyone signed in (RF-USR-03), writes are not.
    test('a worker may read the list', async () => {
      const res = await server.get('/api/areas', { token: workerToken });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.areas));
    });

    for (const [label, call] of [
      ['POST /', (s, t) => s.post('/api/areas', { token: t, body: { name: 'x' } })],
      ['PATCH /:id', (s, t) => s.patch('/api/areas/1', { token: t, body: { name: 'x' } })],
      ['DELETE /:id', (s, t) => s.delete('/api/areas/1', { token: t })],
      [
        'PUT /:id/parent',
        (s, t) => s.put('/api/areas/1/parent', { token: t, body: { parentAreaId: 2 } }),
      ],
      ['DELETE /:id/parent', (s, t) => s.delete('/api/areas/1/parent', { token: t })],
      [
        'PUT /:id/members/:userId',
        (s, t) => s.put('/api/areas/1/members/1', { token: t, body: {} }),
      ],
      ['DELETE /:id/members/:userId', (s, t) => s.delete('/api/areas/1/members/1', { token: t })],
    ]) {
      test(`a worker is refused ${label}`, async () => {
        const res = await call(server, workerToken);

        assert.equal(res.status, 403);
        assert.equal(res.body.error.message, 'Missing permission: area.manage.');
      });
    }

    // The write block is gated on the permission, not on the role's name (RF-USR-05): a
    // role nobody seeded, granted area.manage through the API, passes; take the grant
    // away and the very next request is refused. That second half is the point --
    // requirePermission() reads role_permissions per request, never from the token, so the
    // token minted while the grant stood does not keep it.
    test('a role granted area.manage may write, and loses it the moment it is revoked', async () => {
      const created = await server.post('/api/roles', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}gestor de áreas` },
      });
      assert.equal(created.status, 201);
      const role = created.body.role;

      const granted = await server.put(`/api/roles/${role.id}/permissions`, {
        token: adminToken,
        body: { permissions: ['area.manage'] },
      });
      assert.equal(granted.status, 200);

      await createActive({ email: 'gestor@uaq.mx', role: role.name });
      const gestorToken = await tokenFor(server, 'gestor@uaq.mx');

      const allowed = await server.post('/api/areas', {
        token: gestorToken,
        body: { name: `${TEST_PREFIX}Creada por gestor` },
      });
      assert.equal(allowed.status, 201);

      const revoked = await server.put(`/api/roles/${role.id}/permissions`, {
        token: adminToken,
        body: { permissions: [] },
      });
      assert.equal(revoked.status, 200);

      const refused = await server.post('/api/areas', {
        token: gestorToken,
        body: { name: `${TEST_PREFIX}Ya no` },
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.message, 'Missing permission: area.manage.');

      // Reads were never behind the grant (RF-USR-03), so they survive the revocation.
      const stillReads = await server.get('/api/areas', { token: gestorToken });
      assert.equal(stillReads.status, 200);
    });
  });

  describe('POST /api/areas', () => {
    test('creates an area', async () => {
      const res = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Coordinación de Imagen`, description: 'La cabeza' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.area.name, `${TEST_PREFIX}Coordinación de Imagen`);
      assert.equal(res.body.area.description, 'La cabeza');
      assert.ok(Number.isInteger(res.body.area.id));
    });

    // An area created with a leader must arrive with the membership already written --
    // that is the whole reason it is one statement rather than two calls.
    test('leaderUserId makes that user the area lead in the same statement', async () => {
      const lead = await createActive({ email: 'lider@uaq.mx', role: 'area_lead' });

      const created = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Con Líder`, leaderUserId: lead.id },
      });
      assert.equal(created.status, 201);

      const members = await server.get(`/api/areas/${created.body.area.id}/members`, {
        token: adminToken,
      });
      assert.equal(members.status, 200);
      assert.equal(members.body.members.length, 1);
      assert.equal(members.body.members[0].id, lead.id);
      assert.equal(members.body.members[0].isAreaLeader, true);
    });

    test('an empty description is stored as null, not as an empty string', async () => {
      const res = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Sin Descripción`, description: '   ' },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.area.description, null);
    });

    for (const [label, body, message] of [
      ['a missing name', {}, 'Area name is required (200 characters or fewer).'],
      ['a blank name', { name: '   ' }, 'Area name is required (200 characters or fewer).'],
      [
        'a name over 200 characters',
        { name: TEST_PREFIX + 'a'.repeat(201) },
        'Area name is required (200 characters or fewer).',
      ],
      [
        'a malformed leaderUserId',
        { name: `${TEST_PREFIX}Mal`, leaderUserId: 'abc' },
        'leaderUserId must be a positive integer.',
      ],
    ]) {
      test(`${label} is 400`, async () => {
        const res = await server.post('/api/areas', { token: adminToken, body });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, message);
      });
    }

    test('a leaderUserId that names no user is 400', async () => {
      const res = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Fantasma`, leaderUserId: 999999 },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Unknown userId.');
    });

    // uq_areas_name is a plain unique index, not a partial one: areas have no deleted_at,
    // so there is no such thing as a freed name.
    test('a duplicate name is 409', async () => {
      await createArea('Repetida');

      const res = await server.post('/api/areas', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Repetida` },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'An area with that name already exists.');
    });

    // Where a new area hangs. .env.test pins DEFAULT_AREA=Coordinación, which is the seeded
    // root since coordinacion-root, so these cases do not depend on the developer's .env.
    // The request distinguishes omitted from null: omitted takes the default, null asks
    // for a root -- and the difference is the whole contract, so both are asserted.
    describe('the default parent (DEFAULT_AREA)', () => {
      const parentOf = async (id) => {
        const chart = await server.get('/api/areas/orgchart', { token: adminToken });
        assert.equal(chart.status, 200);
        const walk = (nodes) => {
          for (const node of nodes) {
            if (node.id === id) return node.parentAreaId;
            const found = walk(node.children);
            if (found !== undefined) return found;
          }
          return undefined;
        };
        return walk(chart.body.roots);
      };

      test('omitting parentAreaId hangs the area under DEFAULT_AREA', async () => {
        const coordinacion = await areaId(process.env.DEFAULT_AREA);
        assert.ok(coordinacion, 'DEFAULT_AREA must name a seeded area in .env.test');

        const res = await server.post('/api/areas', {
          token: adminToken,
          body: { name: `${TEST_PREFIX}Por Omisión` },
        });

        assert.equal(res.status, 201);
        assert.equal(res.body.area.parentAreaId, coordinacion);
        assert.equal(await parentOf(res.body.area.id), coordinacion);
      });

      test('a parentAreaId is written in the same statement', async () => {
        const parent = await createArea('Padre Explícito');

        const res = await server.post('/api/areas', {
          token: adminToken,
          body: { name: `${TEST_PREFIX}Hija`, parentAreaId: parent.id },
        });

        assert.equal(res.status, 201);
        assert.equal(res.body.area.parentAreaId, parent.id);
        assert.equal(await parentOf(res.body.area.id), parent.id);
      });

      test('an explicit null parentAreaId makes a root', async () => {
        const res = await server.post('/api/areas', {
          token: adminToken,
          body: { name: `${TEST_PREFIX}Raíz`, parentAreaId: null },
        });

        assert.equal(res.status, 201);
        assert.equal(res.body.area.parentAreaId, null);
        assert.equal(await parentOf(res.body.area.id), null);
      });

      test('leaderUserId and parentAreaId land together', async () => {
        const lead = await createActive({ email: 'lider2@uaq.mx', role: 'area_lead' });
        const parent = await createArea('Padre Con Líder');

        const res = await server.post('/api/areas', {
          token: adminToken,
          body: { name: `${TEST_PREFIX}Ambos`, leaderUserId: lead.id, parentAreaId: parent.id },
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.area.parentAreaId, parent.id);

        const members = await server.get(`/api/areas/${res.body.area.id}/members`, {
          token: adminToken,
        });
        assert.equal(members.body.members.length, 1);
        assert.equal(members.body.members[0].isAreaLeader, true);
      });

      test('a parentAreaId that names no area is 400', async () => {
        const res = await server.post('/api/areas', {
          token: adminToken,
          body: { name: `${TEST_PREFIX}Huérfana`, parentAreaId: 999999 },
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'Unknown parentAreaId.');
      });

      test('a malformed parentAreaId is 400', async () => {
        const res = await server.post('/api/areas', {
          token: adminToken,
          body: { name: `${TEST_PREFIX}Mal Padre`, parentAreaId: 'arriba' },
        });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'parentAreaId must be a positive integer.');
      });

      // The variable is read per request, not at boot, so a case can take it away. Two
      // shapes of "no default": unset, and set to a name no area has. Both fall through
      // to a root silently -- that is the decision, and the assertion is that nothing
      // refuses.
      for (const [label, value] of [
        ['unset', undefined],
        ['naming no area', `${TEST_PREFIX}no existe`],
      ]) {
        test(`with DEFAULT_AREA ${label}, an omitted parentAreaId makes a root`, async () => {
          const saved = process.env.DEFAULT_AREA;
          if (value === undefined) delete process.env.DEFAULT_AREA;
          else process.env.DEFAULT_AREA = value;

          try {
            const res = await server.post('/api/areas', {
              token: adminToken,
              body: { name: `${TEST_PREFIX}Sin Default` },
            });

            assert.equal(res.status, 201);
            assert.equal(res.body.area.parentAreaId, null);
            assert.equal(await parentOf(res.body.area.id), null);
          } finally {
            process.env.DEFAULT_AREA = saved;
          }
        });
      }
    });
  });

  describe('GET /api/areas/:id', () => {
    test('returns the area', async () => {
      const area = await createArea('Una', 'con descripción');

      const res = await server.get(`/api/areas/${area.id}`, { token: workerToken });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.area, {
        id: area.id,
        name: `${TEST_PREFIX}Una`,
        description: 'con descripción',
      });
    });

    for (const [label, id] of [
      ['a non-numeric id', 'abc'],
      ['a zero id', '0'],
      ['a negative id', '-3'],
      ['a fractional id', '1.5'],
    ]) {
      test(`${label} is 400`, async () => {
        const res = await server.get(`/api/areas/${id}`, { token: workerToken });

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'Invalid area id.');
      });
    }

    test('an id that names no area is 404', async () => {
      const res = await server.get('/api/areas/999999', { token: workerToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Area not found.');
    });
  });

  describe('PATCH /api/areas/:id', () => {
    test('renames without touching the description', async () => {
      const area = await createArea('Antes', 'intacta');

      const res = await server.patch(`/api/areas/${area.id}`, {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Después` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.area.name, `${TEST_PREFIX}Después`);
      assert.equal(res.body.area.description, 'intacta');
    });

    test('clears the description when it is sent as null', async () => {
      const area = await createArea('Con Texto', 'algo');

      const res = await server.patch(`/api/areas/${area.id}`, {
        token: adminToken,
        body: { description: null },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.area.description, null);
      assert.equal(res.body.area.name, `${TEST_PREFIX}Con Texto`);
    });

    test('renaming onto a taken name is 409', async () => {
      await createArea('Ocupada');
      const area = await createArea('Libre');

      const res = await server.patch(`/api/areas/${area.id}`, {
        token: adminToken,
        body: { name: `${TEST_PREFIX}Ocupada` },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'An area with that name already exists.');
    });

    test('an id that names no area is 404', async () => {
      const res = await server.patch('/api/areas/999999', {
        token: adminToken,
        body: { name: `${TEST_PREFIX}X` },
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Area not found.');
    });
  });

  describe('DELETE /api/areas/:id', () => {
    test('deletes an empty area', async () => {
      const area = await createArea('Vacía');

      const res = await server.delete(`/api/areas/${area.id}`, { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.area.id, area.id);

      const gone = await server.get(`/api/areas/${area.id}`, { token: adminToken });
      assert.equal(gone.status, 404);
    });

    // The foreign key is the gate, not a count taken first -- a count would race a
    // concurrent assignment, and this is the case that proves the FK is reached.
    test('an area with members is 409', async () => {
      const area = await createArea('Ocupada por gente');
      const user = await createActive({ email: 'miembro@uaq.mx', role: 'worker' });

      await server.put(`/api/areas/${area.id}/members/${user.id}`, {
        token: adminToken,
        body: {},
      });

      const res = await server.delete(`/api/areas/${area.id}`, { token: adminToken });

      assert.equal(res.status, 409);
      assert.equal(
        res.body.error.message,
        'That area still has users or records assigned to it; reassign them first.',
      );
    });

    test('an id that names no area is 404', async () => {
      const res = await server.delete('/api/areas/999999', { token: adminToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Area not found.');
    });
  });
});
