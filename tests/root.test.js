import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';

describe('GET /', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
  });

  test('reports the service name and status without touching the database', async () => {
    const res = await server.get('/');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { name: 'imagenuaq-api', status: 'up' });
  });

  test('helmet is mounted', async () => {
    const res = await server.get('/');

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('only GET is routed; anything else falls to the 404 handler', async () => {
    const res = await server.post('/', { body: {} });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.message, 'Route POST / not found');
  });
});
