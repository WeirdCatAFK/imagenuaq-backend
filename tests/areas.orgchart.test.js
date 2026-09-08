import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createArea,
  createActive,
  tokenFor,
  sql,
  TEST_PREFIX,
} from './helpers/fixtures.js';

// The hierarchy and the chart it draws. The shape asserted here is the contract with
// react-organizational-chart on the frontend: every node carries its own `children`, so
// <Tree>/<TreeNode> recurse over the response with no reshaping.
describe('the organisation chart', () => {
  let server;
  let adminToken;
  let workerToken;

  // A three-level tree built once per case:
  //
  //   Coordinación
  //     ├── Diseño
  //     │     └── Web
  //     └── Imprenta
  //   Suelta            (a second root -- the organisation is a forest, not a tree)
  let coordinacion;
  let diseno;
  let web;
  let imprenta;
  let suelta;

  // Created once; see areas.crud.test.js for why the accounts are not rebuilt per case.
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

  // The tree is rebuilt per case because most cases move or delete part of it.
  beforeEach(async () => {
    await resetCases(ACCOUNTS);

    coordinacion = await createArea('Coordinación');
    diseno = await createArea('Diseño');
    web = await createArea('Web');
    imprenta = await createArea('Imprenta');
    suelta = await createArea('Suelta');

    await setParent(diseno.id, coordinacion.id);
    await setParent(web.id, diseno.id);
    await setParent(imprenta.id, coordinacion.id);
  });

  const setParent = (childId, parentId) =>
    server.put(`/api/areas/${childId}/parent`, {
      token: adminToken,
      body: { parentAreaId: parentId },
    });

  const nodeFor = (roots, id) => {
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const found = walk(node.children);
        if (found) return found;
      }
      return null;
    };
    return walk(roots);
  };

  // Express matches in declaration order, so /orgchart has to be declared before /:id. With
  // them the other way round this URL is read as an id and refused as "Invalid area id." --
  // a failure that only ever shows up at runtime.
  test('GET /orgchart is not captured by /:id', async () => {
    const res = await server.get('/api/areas/orgchart', { token: workerToken });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.roots));
  });

  test('any signed-in user may read it, RF-USR-03', async () => {
    const res = await server.get('/api/areas/orgchart', { token: workerToken });
    assert.equal(res.status, 200);

    const anonymous = await server.get('/api/areas/orgchart');
    assert.equal(anonymous.status, 401);
  });

  describe('GET /api/areas/orgchart', () => {
    test('nests children under their parent', async () => {
      const res = await server.get('/api/areas/orgchart', { token: adminToken });
      assert.equal(res.status, 200);

      const root = nodeFor(res.body.roots, coordinacion.id);
      assert.ok(root, 'the coordination should be a root');
      assert.deepEqual(
        root.children.map((child) => child.name).sort(),
        [`${TEST_PREFIX}Diseño`, `${TEST_PREFIX}Imprenta`],
      );

      const design = root.children.find((child) => child.id === diseno.id);
      assert.equal(design.children.length, 1);
      assert.equal(design.children[0].id, web.id);
      assert.equal(design.children[0].children.length, 0);
    });

    test('reports depth relative to the root of the response', async () => {
      const res = await server.get('/api/areas/orgchart', { token: adminToken });

      assert.equal(nodeFor(res.body.roots, coordinacion.id).depth, 0);
      assert.equal(nodeFor(res.body.roots, diseno.id).depth, 1);
      assert.equal(nodeFor(res.body.roots, web.id).depth, 2);
    });

    test('parentAreaId is null on a root and set on a child', async () => {
      const res = await server.get('/api/areas/orgchart', { token: adminToken });

      assert.equal(nodeFor(res.body.roots, coordinacion.id).parentAreaId, null);
      assert.equal(nodeFor(res.body.roots, diseno.id).parentAreaId, coordinacion.id);
      assert.equal(nodeFor(res.body.roots, web.id).parentAreaId, diseno.id);
    });

    // A forest, not a tree. Inventing a synthetic root to join the parentless areas would
    // put a box in the chart that answers to nobody.
    test('an area with no parent is its own root', async () => {
      const res = await server.get('/api/areas/orgchart', { token: adminToken });

      const rootIds = res.body.roots.map((node) => node.id);
      assert.ok(rootIds.includes(coordinacion.id));
      assert.ok(rootIds.includes(suelta.id));
      assert.ok(!rootIds.includes(diseno.id));
    });

    test('every node carries its members and a matching count', async () => {
      const lead = await createActive({ email: 'jefa@uaq.mx', fullName: 'Jefa', role: 'area_lead' });
      const member = await createActive({ email: 'equipo@uaq.mx', fullName: 'Equipo', role: 'worker' });

      await server.put(`/api/areas/${diseno.id}/members/${lead.id}`, {
        token: adminToken,
        body: { isAreaLeader: true },
      });
      await server.put(`/api/areas/${diseno.id}/members/${member.id}`, {
        token: adminToken,
        body: { isAreaLeader: false },
      });

      const res = await server.get('/api/areas/orgchart', { token: adminToken });
      const design = nodeFor(res.body.roots, diseno.id);

      assert.equal(design.memberCount, 2);
      assert.equal(design.members.length, 2);
      // Leaders first, so the chart can label the node with members[0] if it wants to.
      assert.equal(design.members[0].id, lead.id);
      assert.deepEqual(design.leaders.map((person) => person.id), [lead.id]);
      assert.equal(design.members[0].fullName, 'Jefa');
      assert.equal(design.members[0].role, 'area_lead');
    });

    test('an area with nobody in it has an empty roster, not a missing one', async () => {
      const res = await server.get('/api/areas/orgchart', { token: adminToken });
      const node = nodeFor(res.body.roots, suelta.id);

      assert.deepEqual(node.members, []);
      assert.deepEqual(node.leaders, []);
      assert.equal(node.memberCount, 0);
    });

    // A soft-deleted user is gone from the organisation's point of view, and leaving them
    // on the chart would be the most visible possible version of that bug.
    test('soft-deleted users are not in the chart', async () => {
      const leaver = await createActive({ email: 'sale@uaq.mx', role: 'worker' });
      await server.put(`/api/areas/${diseno.id}/members/${leaver.id}`, {
        token: adminToken,
        body: {},
      });
      await sql('update users set deleted_at = now() where id = $1', [leaver.id]);

      const res = await server.get('/api/areas/orgchart', { token: adminToken });

      assert.equal(nodeFor(res.body.roots, diseno.id).memberCount, 0);
    });
  });

  describe('GET /api/areas/:id/orgchart', () => {
    // The read RF-USR-04 is written in: everyone "a su cargo" is this subtree.
    test('returns the subtree rooted at that area', async () => {
      const res = await server.get(`/api/areas/${diseno.id}/orgchart`, { token: workerToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.roots.length, 1);
      assert.equal(res.body.roots[0].id, diseno.id);
      assert.equal(res.body.roots[0].children.length, 1);
      assert.equal(res.body.roots[0].children[0].id, web.id);
    });

    // depth restarts, because it describes this response; parentAreaId does not, because it
    // describes the table. Conflating them would either lie about the organisation or make
    // the chart indent the top node.
    test('depth restarts at the subtree root but parentAreaId still points up', async () => {
      const res = await server.get(`/api/areas/${diseno.id}/orgchart`, { token: adminToken });

      assert.equal(res.body.roots[0].depth, 0);
      assert.equal(res.body.roots[0].parentAreaId, coordinacion.id);
      assert.equal(res.body.roots[0].children[0].depth, 1);
    });

    test('an id that names no area is 404', async () => {
      const res = await server.get('/api/areas/999999/orgchart', { token: adminToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Area not found.');
    });
  });

  describe('PUT /api/areas/:id/parent', () => {
    test('moving an area replaces its parent rather than adding one', async () => {
      const res = await setParent(web.id, imprenta.id);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { areaId: web.id, parentAreaId: imprenta.id });

      const chart = await server.get('/api/areas/orgchart', { token: adminToken });
      assert.equal(nodeFor(chart.body.roots, web.id).parentAreaId, imprenta.id);
      // And it appears exactly once, which is what the single-parent primary key buys.
      assert.equal(nodeFor(chart.body.roots, diseno.id).children.length, 0);
    });

    test('an area cannot be its own parent', async () => {
      const res = await setParent(diseno.id, diseno.id);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'An area cannot be its own parent.');
    });

    // The refusal the database cannot make: area_hierarchy constrains one hop, and
    // Areas.setParent() is the only thing standing between the table and a loop.
    test('a move that would close a cycle is 409', async () => {
      const res = await setParent(coordinacion.id, web.id);

      assert.equal(res.status, 409);
      assert.equal(
        res.body.error.message,
        'That area is already below this one; the move would close a cycle.',
      );
    });

    test('a direct swap of parent and child is 409', async () => {
      const res = await setParent(diseno.id, web.id);

      assert.equal(res.status, 409);
      assert.equal(
        res.body.error.message,
        'That area is already below this one; the move would close a cycle.',
      );
    });

    test('a missing parentAreaId is 400', async () => {
      const res = await server.put(`/api/areas/${diseno.id}/parent`, {
        token: adminToken,
        body: {},
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'parentAreaId must be a positive integer.');
    });

    test('a parent that does not exist is 404', async () => {
      const res = await setParent(diseno.id, 999999);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Parent area not found.');
    });

    test('a child that does not exist is 404', async () => {
      const res = await setParent(999999, diseno.id);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Area not found.');
    });
  });

  describe('DELETE /api/areas/:id/parent', () => {
    test('promotes the area to a root', async () => {
      const res = await server.delete(`/api/areas/${diseno.id}/parent`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { areaId: diseno.id, parentAreaId: null, changed: true });

      const chart = await server.get('/api/areas/orgchart', { token: adminToken });
      assert.ok(chart.body.roots.some((node) => node.id === diseno.id));
      // Its own child comes with it: the subtree moves, it does not scatter.
      assert.equal(nodeFor(chart.body.roots, diseno.id).children[0].id, web.id);
    });

    test('an area that was already a root reports changed: false, not 404', async () => {
      const res = await server.delete(`/api/areas/${suelta.id}/parent`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.changed, false);
      assert.equal(res.body.parentAreaId, null);
    });

    test('an id that names no area is 404', async () => {
      const res = await server.delete('/api/areas/999999/parent', { token: adminToken });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Area not found.');
    });
  });

  // ON DELETE CASCADE on area_hierarchy: the links go, the grandchildren stay drawable.
  test('deleting a parent area promotes its children to roots', async () => {
    await server.delete(`/api/areas/${diseno.id}/parent`, { token: adminToken });
    const res = await server.delete(`/api/areas/${diseno.id}`, { token: adminToken });
    assert.equal(res.status, 200);

    const chart = await server.get('/api/areas/orgchart', { token: adminToken });
    assert.ok(
      chart.body.roots.some((node) => node.id === web.id),
      'the orphaned child should become a root rather than disappear',
    );
  });
});
