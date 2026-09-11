import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, tokenFor } from './helpers/fixtures.js';

// Only the guard is ours: everything behind it talks to Microsoft Graph with a token the
// caller supplies, and a case that reached it would need the network. What must hold is
// that nothing under /api/spreadsheets answers without a session, and only to admin.
describe('/api/spreadsheets is guarded', () => {
  let server;
  let workerToken;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: 'trabajador@uaq.mx', role: 'worker' });
    workerToken = await tokenFor(server, 'trabajador@uaq.mx');
  });

  after(async () => {
    await reset();
    await server.close();
  });

  for (const path of ['/tables', '/rows', '/test', '/test-graph']) {
    test(`GET ${path} without a token is 401`, async () => {
      const res = await server.get(`/api/spreadsheets${path}`);

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    test(`GET ${path} as a worker is 403`, async () => {
      const res = await server.get(`/api/spreadsheets${path}`, { token: workerToken });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.message, 'Insufficient role for this resource.');
    });
  }
});
