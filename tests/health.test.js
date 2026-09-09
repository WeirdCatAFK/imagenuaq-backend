import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';

describe('GET /api/health', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
  });

  test('is 200 while Postgres answers', async () => {
    const res = await server.get('/api/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('reports the database as reachable, with a latency reading', async () => {
    const { body } = await server.get('/api/health');

    assert.equal(body.database.reachable, true);
    assert.equal(typeof body.database.latencyMs, 'number');
    assert.ok(body.database.latencyMs >= 0);
    // The error field belongs to the degraded shape and must not appear here.
    assert.equal('error' in body.database, false);
  });

  test('reports process uptime', async () => {
    const { body } = await server.get('/api/health');

    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.uptime > 0);
  });

  test('the router is mounted only at the collection root', async () => {
    const res = await server.get('/api/health/deep');

    assert.equal(res.status, 404);
  });
});
