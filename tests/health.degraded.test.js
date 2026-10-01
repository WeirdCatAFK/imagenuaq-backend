// Its own file, because node:test gives each file its own process and the pool is a
// module-level singleton. Opening it in any other file would leak into this one.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServerWithoutDatabase } from './helpers/server.js';

describe('GET /api/health with no database', () => {
  let server;

  before(async () => {
    server = await startServerWithoutDatabase();
  });

  after(async () => {
    await server.close();
  });

  test('is 503 degraded, not 500', async () => {
    const res = await server.get('/api/health');

    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
  });

  test('names the failure instead of leaking a stack', async () => {
    const { body } = await server.get('/api/health');

    assert.equal(body.database.reachable, false);
    assert.match(body.database.error, /Store is not open/);
    assert.equal(typeof body.uptime, 'number');
    assert.equal('error' in body === true && typeof body.error === 'object', false);
  });
});
