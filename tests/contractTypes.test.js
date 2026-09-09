import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, tokenFor } from './helpers/fixtures.js';

// The contract-scheme catalogue. Small surface, but the reason it exists is worth pinning:
// users.contract_type_id is NOT NULL, so POST /api/users cannot be filled in without this
// list, and the ids come from a sequence rather than from the requirement -- a client that
// hard-coded them would work on one database and quietly assign the wrong scheme on the
// next. So the cases below assert on NAMES and never on an id.
describe('GET /api/contract-types', () => {
  let server;
  let workerToken;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: 'disenador@uaq.mx', role: 'worker' });
    workerToken = await tokenFor(server, 'disenador@uaq.mx');
  });

  after(async () => {
    await reset();
    await server.close();
  });

  test('without a token it is 401', async () => {
    const res = await server.get('/api/contract-types');

    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'No token provided.');
  });

  // Not admin-only, and deliberately so: a form that assigns a scheme has to list them, and
  // there is nothing private in the name of one.
  test('any signed-in user may read it', async () => {
    const res = await server.get('/api/contract-types', { token: workerToken });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.contractTypes));
  });

  test('carries the four RF-AUS-02 schemes and becario', async () => {
    const res = await server.get('/api/contract-types', { token: workerToken });
    const names = res.body.contractTypes.map((type) => type.name);

    for (const expected of [
      'Honorarios',
      'Eventual',
      'Base de confianza',
      'Base sindicalizada',
      'Becario',
    ]) {
      assert.ok(names.includes(expected), `${expected} is missing from the catalogue`);
    }
  });

  test('every row is an id and a name, and nothing else', async () => {
    const res = await server.get('/api/contract-types', { token: workerToken });

    for (const type of res.body.contractTypes) {
      assert.deepEqual(Object.keys(type).sort(), ['id', 'name']);
      assert.equal(typeof type.id, 'number');
      assert.equal(typeof type.name, 'string');
    }
  });

  // By name rather than by insertion order, so a <select> needs no sort of its own.
  // Asserted as one pair rather than by re-sorting the list: Postgres orders under the
  // database's collation and JS under the runtime's, and pinning those two to agree would
  // be a test about ICU. 'Honorarios' was seeded FIRST and sorts LAST, which is the whole
  // claim.
  test('is ordered by name, not by id', async () => {
    const res = await server.get('/api/contract-types', { token: workerToken });
    const names = res.body.contractTypes.map((type) => type.name);

    assert.ok(
      names.indexOf('Base de confianza') < names.indexOf('Honorarios'),
      `not ordered by name: ${names.join(', ')}`,
    );
  });
});
