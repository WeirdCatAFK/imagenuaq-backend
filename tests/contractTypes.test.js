// The contract types list. Cases match on names, never ids: ids differ between databases.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, tokenFor } from './helpers/fixtures.js';

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

  test('is ordered by name, not by id', async () => {
    const res = await server.get('/api/contract-types', { token: workerToken });
    const names = res.body.contractTypes.map((type) => type.name);

    assert.ok(
      names.indexOf('Base de confianza') < names.indexOf('Honorarios'),
      `not ordered by name: ${names.join(', ')}`,
    );
  });
});
