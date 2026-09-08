import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createArea,
  createActive,
  tokenFor,
  areaMemberships,
} from './helpers/fixtures.js';

// Membership of an area, and leadership of it. Both live on `area_members` rather than on
// `areas`, because somebody can lead one area and be an ordinary member of another --
// the conclusion the schema-proofing migration reached when it dropped areas.lead_user_id.
describe('/api/areas/:id/members', () => {
  let server;
  let adminToken;
  let workerToken;
  let area;
  let other;

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
    other = await createArea('Imprenta');
  });

  const addMember = (areaId, userId, isAreaLeader = false) =>
    server.put(`/api/areas/${areaId}/members/${userId}`, {
      token: adminToken,
      body: { isAreaLeader },
    });

  describe('PUT /api/areas/:id/members/:userId', () => {
    test('adds a member', async () => {
      const user = await createActive({ email: 'nuevo@uaq.mx', fullName: 'Nuevo', role: 'worker' });

      const res = await addMember(area.id, user.id);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        userId: user.id,
        areaId: area.id,
        isAreaLeader: false,
      });
    });

    // One route for both because they are one upsert. Calling it twice must not raise on
    // the unique index over (user_id, area_id) -- promoting an existing member and adding a
    // new leader are the same intent expressed twice.
    test('calling it again promotes rather than failing on the unique index', async () => {
      const user = await createActive({ email: 'asciende@uaq.mx', role: 'worker' });

      await addMember(area.id, user.id, false);
      const promoted = await addMember(area.id, user.id, true);

      assert.equal(promoted.status, 200);
      assert.equal(promoted.body.isAreaLeader, true);

      assert.deepEqual(await areaMemberships(user.id), [
        { area_id: area.id, is_area_leader: true },
      ]);
    });

    test('demoting a leader is the same call with false', async () => {
      const user = await createActive({ email: 'baja@uaq.mx', role: 'area_lead' });

      await addMember(area.id, user.id, true);
      const demoted = await addMember(area.id, user.id, false);

      assert.equal(demoted.body.isAreaLeader, false);
    });

    // The reason leadership is not a column on `areas`.
    test('a user can lead one area and be an ordinary member of another', async () => {
      const user = await createActive({ email: 'doble@uaq.mx', role: 'area_lead' });

      await addMember(area.id, user.id, true);
      await addMember(other.id, user.id, false);

      const memberships = await areaMemberships(user.id);
      assert.equal(memberships.length, 2);
      assert.deepEqual(
        memberships.map((row) => row.is_area_leader).sort(),
        [false, true],
      );
    });

    test('an omitted body defaults to a non-leader membership', async () => {
      const user = await createActive({ email: 'sincuerpo@uaq.mx', role: 'worker' });

      const res = await server.put(`/api/areas/${area.id}/members/${user.id}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.isAreaLeader, false);
    });

    test('an unknown user is 400, not 500', async () => {
      const res = await addMember(area.id, 999999);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Unknown userId.');
    });

    test('an unknown area is 400, not 500', async () => {
      const user = await createActive({ email: 'huerfano@uaq.mx', role: 'worker' });

      const res = await addMember(999999, user.id);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Unknown areaId.');
    });

    test('a non-numeric user id is 400', async () => {
      const res = await server.put(`/api/areas/${area.id}/members/abc`, {
        token: adminToken,
        body: {},
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Invalid user id.');
    });
  });

  describe('DELETE /api/areas/:id/members/:userId', () => {
    test('removes the membership', async () => {
      const user = await createActive({ email: 'sale@uaq.mx', role: 'worker' });
      await addMember(area.id, user.id, true);

      const res = await server.delete(`/api/areas/${area.id}/members/${user.id}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.isAreaLeader, true, 'reports what was removed');
      assert.deepEqual(await areaMemberships(user.id), []);
    });

    // The membership, not the account. Deleting a person because they left one area would
    // be the most destructive possible reading of this route.
    test('leaves the user account alone', async () => {
      const user = await createActive({ email: 'sigue@uaq.mx', role: 'worker' });
      await addMember(area.id, user.id);

      await server.delete(`/api/areas/${area.id}/members/${user.id}`, { token: adminToken });

      const stillThere = await server.get('/api/auth/me', {
        token: await tokenFor(server, 'sigue@uaq.mx'),
      });
      assert.equal(stillThere.status, 200);
    });

    test('a membership that does not exist is 404', async () => {
      const user = await createActive({ email: 'nunca@uaq.mx', role: 'worker' });

      const res = await server.delete(`/api/areas/${area.id}/members/${user.id}`, {
        token: adminToken,
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'That user is not a member of this area.');
    });
  });

  describe('GET /api/areas/:id/members', () => {
    test('lists leaders first, then by name', async () => {
      const zulema = await createActive({ email: 'zulema@uaq.mx', fullName: 'Zulema', role: 'worker' });
      const ana = await createActive({ email: 'ana@uaq.mx', fullName: 'Ana', role: 'worker' });
      const lead = await createActive({ email: 'lider@uaq.mx', fullName: 'Zoraida', role: 'area_lead' });

      await addMember(area.id, zulema.id);
      await addMember(area.id, ana.id);
      await addMember(area.id, lead.id, true);

      const res = await server.get(`/api/areas/${area.id}/members`, { token: workerToken });

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.members.map((member) => member.fullName),
        ['Zoraida', 'Ana', 'Zulema'],
      );
      assert.equal(res.body.members[0].isAreaLeader, true);
      assert.equal(res.body.members[0].role, 'area_lead');
    });

    // An area with nobody in it and an area that does not exist both produce zero rows, and
    // they are a 200 and a 404.
    test('an empty area is 200 with an empty list', async () => {
      const res = await server.get(`/api/areas/${area.id}/members`, { token: workerToken });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.members, []);
    });

    test('an area that does not exist is 404', async () => {
      const res = await server.get('/api/areas/999999/members', { token: workerToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Area not found.');
    });
  });
});
