// The contract types: the list and the admin's create. Cases match on names, never ids: ids
// differ between databases.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, tokenFor, TEST_PREFIX } from './helpers/fixtures.js';

describe('/api/contract-types', () => {
  let server;
  let workerToken;
  let adminToken;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: 'disenador@uaq.mx', role: 'worker' });
    await createActive({ email: 'coordinacion@uaq.mx', role: 'admin' });
    workerToken = await tokenFor(server, 'disenador@uaq.mx');
    adminToken = await tokenFor(server, 'coordinacion@uaq.mx');
  });

  const create = (name, token = adminToken) =>
    server.post('/api/contract-types', { token, body: { name } });

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

  test('an admin adds a scheme and it is listed', async () => {
    const res = await create(`${TEST_PREFIX}Becario`);

    assert.equal(res.status, 201);
    assert.equal(res.body.contractType.name, `${TEST_PREFIX}Becario`);
    const list = await server.get('/api/contract-types', { token: workerToken });
    assert.ok(list.body.contractTypes.some((type) => type.id === res.body.contractType.id));
  });

  test('a worker may not add one', async () => {
    const res = await create(`${TEST_PREFIX}Eventual`, workerToken);

    assert.equal(res.status, 403);
  });

  test('a blank name is 400', async () => {
    const res = await create('   ');

    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, 'name is required.');
  });

  test('a taken name is 409', async () => {
    await create(`${TEST_PREFIX}Honorarios`);
    const res = await create(`${TEST_PREFIX}Honorarios`);

    assert.equal(res.status, 409);
    assert.equal(res.body.error.message, 'A contract type with that name already exists.');
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
    await create(`${TEST_PREFIX}B base`);
    await create(`${TEST_PREFIX}A alta`);
    const res = await server.get('/api/contract-types', { token: workerToken });
    const names = res.body.contractTypes.map((type) => type.name);

    assert.ok(
      names.indexOf(`${TEST_PREFIX}A alta`) < names.indexOf(`${TEST_PREFIX}B base`),
      `not ordered by name: ${names.join(', ')}`,
    );
  });
});
