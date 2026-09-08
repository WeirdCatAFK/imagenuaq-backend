import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServerWithoutDatabase } from './helpers/server.js';

// Its own file, because node:test gives each file its own process and the pool is a
// module-level singleton. Opening it in any other file would leak into this one.
describe('GET /api/health with no database', () => {
  let server;

  before(async () => {
    // Started the way main.js never starts it: no openStore(). query.ping() therefore
    // throws before it reaches Postgres, which is a faithful stand-in for the database
    // being unreachable and does not require stopping the container mid-suite.
    server = await startServerWithoutDatabase();
  });

  after(async () => {
    await server.close();
  });

  // The distinction this file exists for. health.check() catches every error rather than
  // letting it reach the error handler, so a dead pool is a 503 the load balancer can act
  // on -- not a 500 that looks like the route itself crashed.
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
    // Not the error envelope: this is a report, so it must not arrive shaped like a refusal.
    assert.equal('error' in body === true && typeof body.error === 'object', false);
  });
});
