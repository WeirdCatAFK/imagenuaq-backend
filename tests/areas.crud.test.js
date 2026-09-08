import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createArea,
  createActive,
  tokenFor,
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
        assert.equal(res.body.error.message, 'Insufficient role for this resource.');
      });
    }
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
