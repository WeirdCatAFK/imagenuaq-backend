// Permission checks on the spreadsheet routes. Routes that call Microsoft are tested only up to
// their checks, since going further needs the network.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, tokenFor } from './helpers/fixtures.js';

describe('/api/spreadsheets and /api/microsoft are guarded', () => {
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

  const READS = [
    ['GET', '/api/spreadsheets'],
    ['GET', '/api/spreadsheets/resolve?accountId=1&url=https://x'],
    ['GET', '/api/spreadsheets/1'],
    ['GET', '/api/spreadsheets/1/preview'],
    ['GET', '/api/microsoft/accounts'],
  ];
  const WRITES = [
    ['POST', '/api/spreadsheets'],
    ['DELETE', '/api/spreadsheets/1'],
    ['POST', '/api/microsoft/connect'],
    ['DELETE', '/api/microsoft/accounts/1'],
    ['GET', '/api/microsoft/app'],
    ['PUT', '/api/microsoft/app'],
    ['DELETE', '/api/microsoft/app'],
  ];

  for (const [method, path] of [...READS, ...WRITES]) {
    test(`${method} ${path} without a token is 401`, async () => {
      const res = await server.request(method, path);

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    test(`${method} ${path} as a worker is 403`, async () => {
      const res = await server.request(method, path, { token: workerToken });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.message, 'Missing permission: spreadsheet.read.');
    });
  }

  test('GET /api/microsoft/callback without a state redirects to the error page', async () => {
    const res = await server.get('/api/microsoft/callback?code=abc', { redirect: 'manual' });

    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.origin, process.env.FRONTEND_DOMAIN);
    assert.equal(location.searchParams.get('microsoft'), 'error');
    assert.equal(location.searchParams.get('reason'), 'state');
  });

  test('GET /api/microsoft/callback with Microsoft\'s own error redirects with it', async () => {
    const res = await server.get(
      '/api/microsoft/callback?error=access_denied&error_description=User+declined',
      { redirect: 'manual' },
    );

    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.equal(location.searchParams.get('microsoft'), 'error');
    assert.equal(location.searchParams.get('reason'), 'access_denied');
    assert.equal(location.searchParams.get('description'), 'User declined');
  });
});
