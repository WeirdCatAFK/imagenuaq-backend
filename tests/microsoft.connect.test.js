import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createActive,
  createMicrosoftAccount,
  tokenFor,
  logsFor,
  roleId,
  sql,
} from './helpers/fixtures.js';
import auth from '../src/access/orchestration/auth.js';
import { open } from '../src/utils/crypto.js';

// The account half of the spreadsheet feature: starting a sign-in, what the callback does
// with a state it did not mint, listing and revoking. The code exchange itself is not here
// -- it is the one call that needs Microsoft -- so the accounts these cases read are
// written by the fixture exactly as completeConnect() would write them.
describe('/api/microsoft', () => {
  let server;
  let admin;
  let worker;
  let adminToken;
  let workerToken;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: ACCOUNTS[0], role: 'admin' });
    worker = await createActive({ email: ACCOUNTS[1], role: 'worker' });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);

    // `worker` is seeded with no grants and resetCases() leaves seeded roles alone, so
    // the feature is granted to it for this file and taken back in after(). The ownership
    // cases below are then about rows, not about the permission guard.
    await grantWorker(['spreadsheet.read', 'spreadsheet.write']);
  });

  after(async () => {
    await grantWorker([]);
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  async function grantWorker(permissions) {
    const res = await server.put(`/api/roles/${await roleId('worker')}/permissions`, {
      token: adminToken,
      body: { permissions },
    });
    assert.equal(res.status, 200);
  }

  describe('POST /connect', () => {
    test('returns the authorize URL with a state naming the caller', async () => {
      const res = await server.post('/api/microsoft/connect', { token: adminToken });

      assert.equal(res.status, 200);
      const url = new URL(res.body.url);
      assert.equal(url.origin, 'https://login.microsoftonline.com');
      assert.equal(url.pathname, '/common/oauth2/v2.0/authorize');
      assert.equal(url.searchParams.get('client_id'), process.env.MS_CLIENT_ID);
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(
        url.searchParams.get('redirect_uri'),
        `${process.env.API_DOMAIN}/api/microsoft/callback`,
      );
      // No openid, no id_token, no identity to store: the one scope that is not optional.
      assert.match(url.searchParams.get('scope'), /(^| )openid( |$)/);
      assert.match(url.searchParams.get('scope'), /offline_access/);
      assert.match(url.searchParams.get('scope'), /Files\.Read\.All/);

      // The state is what the callback will trust, so it had better name this user.
      const userId = await auth.verifyConnectState(url.searchParams.get('state'));
      assert.equal(userId, admin.id);
    });
  });

  describe('POST /connect without an app registration', () => {
    test('is a 503 naming the variables, not a 500', async () => {
      const saved = process.env.MS_CLIENT_ID;
      delete process.env.MS_CLIENT_ID;
      try {
        const res = await server.post('/api/microsoft/connect', { token: adminToken });

        assert.equal(res.status, 503);
        assert.match(res.body.error.message, /not configured/);
      } finally {
        process.env.MS_CLIENT_ID = saved;
      }
    });
  });

  describe('the app registration (/app)', () => {
    const APP = { tenantId: 'organizations', clientId: 'client-from-db', clientSecret: 'shh' };

    test('reports .env as the source until a row is saved, never the secret', async () => {
      const res = await server.get('/api/microsoft/app', { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.app.source, 'env');
      assert.equal(res.body.app.clientId, process.env.MS_CLIENT_ID);
      assert.equal(res.body.app.hasSecret, true);
      assert.equal(res.body.app.redirectUri, `${process.env.API_DOMAIN}/api/microsoft/callback`);
      assert.doesNotMatch(JSON.stringify(res.body), /not-a-real-secret/);
    });

    test('a saved registration wins over .env and is what connect signs with', async () => {
      const saved = await server.put('/api/microsoft/app', { token: adminToken, body: APP });

      assert.equal(saved.status, 200);
      assert.equal(saved.body.app.source, 'database');
      assert.equal(saved.body.app.clientId, APP.clientId);
      assert.equal(saved.body.app.tenantId, 'organizations');
      assert.equal(saved.body.app.updatedByName, 'Prueba Usuario');
      assert.doesNotMatch(JSON.stringify(saved.body), /shh/);

      const connect = await server.post('/api/microsoft/connect', { token: adminToken });
      const url = new URL(connect.body.url);
      assert.equal(url.pathname, '/organizations/oauth2/v2.0/authorize');
      assert.equal(url.searchParams.get('client_id'), APP.clientId);

      // The secret is a column on the row, and the trail must not carry it.
      const logs = await logsFor('microsoft_app', 1);
      assert.deepEqual(logs.map((l) => l.action), ['record_created']);
      assert.equal(logs[0].after_data.client_secret_enc, '[redacted]');
    });

    test('re-saving without the secret keeps the stored one', async () => {
      await server.put('/api/microsoft/app', { token: adminToken, body: APP });

      const res = await server.put('/api/microsoft/app', {
        token: adminToken,
        body: { clientId: 'renamed' },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.app.clientId, 'renamed');
      assert.equal(res.body.app.tenantId, 'common');
      assert.equal(res.body.app.hasSecret, true);

      const [row] = await sql('select client_secret_enc from microsoft_app where id = 1');
      assert.equal(open(row.client_secret_enc), 'shh');

      const logs = await logsFor('microsoft_app', 1);
      assert.deepEqual(logs.map((l) => l.action), ['record_created', 'record_updated']);
    });

    test('the first save needs a secret; a bad tenant or client id is 400', async () => {
      const noSecret = await server.put('/api/microsoft/app', {
        token: adminToken,
        body: { clientId: 'x' },
      });
      assert.equal(noSecret.status, 400);
      assert.equal(noSecret.body.error.message, 'clientSecret is required the first time.');

      const badTenant = await server.put('/api/microsoft/app', {
        token: adminToken,
        body: { ...APP, tenantId: 'not a tenant' },
      });
      assert.equal(badTenant.status, 400);

      const noClient = await server.put('/api/microsoft/app', {
        token: adminToken,
        body: { clientSecret: 'x' },
      });
      assert.equal(noClient.status, 400);
    });

    test('deleting falls back to .env; deleting again is 404', async () => {
      await server.put('/api/microsoft/app', { token: adminToken, body: APP });

      const res = await server.delete('/api/microsoft/app', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.app.source, 'env');

      const again = await server.delete('/api/microsoft/app', { token: adminToken });
      assert.equal(again.status, 404);
    });

    test('a worker with the spreadsheet permissions is still refused', async () => {
      const res = await server.get('/api/microsoft/app', { token: workerToken });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.message, 'Insufficient role for this resource.');
    });
  });

  describe('GET /callback', () => {
    // A session token is signed with the same key and passes every structural check; only
    // the purpose claim keeps it from being accepted as a state. Same trick as invites.
    test('a session token used as the state is refused', async () => {
      const res = await server.get(
        `/api/microsoft/callback?code=abc&state=${encodeURIComponent(adminToken)}`,
        { redirect: 'manual' },
      );

      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location'));
      assert.equal(location.searchParams.get('microsoft'), 'error');
      assert.equal(location.searchParams.get('reason'), 'state');
    });

    test('a tampered state is refused', async () => {
      const state = await auth.issueConnectState(admin.id);
      const tampered = state.slice(0, -4) + 'AAAA';

      const res = await server.get(
        `/api/microsoft/callback?code=abc&state=${encodeURIComponent(tampered)}`,
        { redirect: 'manual' },
      );

      assert.equal(res.status, 302);
      assert.equal(new URL(res.headers.get('location')).searchParams.get('reason'), 'state');
    });
  });

  describe('GET /accounts', () => {
    test('lists the caller\'s accounts, never the token', async () => {
      await createMicrosoftAccount(worker.id);

      const res = await server.get('/api/microsoft/accounts', { token: workerToken });

      assert.equal(res.status, 200);
      assert.equal(res.body.accounts.length, 1);
      const [account] = res.body.accounts;
      assert.equal(account.email, 'cuenta@outlook.com');
      assert.equal(account.userId, worker.id);
      assert.equal(account.userFullName, 'Prueba Usuario');
      for (const key of Object.keys(account)) {
        assert.doesNotMatch(key, /token/i);
      }
    });

    test('a worker sees only their own; an admin sees everyone\'s', async () => {
      await createMicrosoftAccount(worker.id, { email: 'trabajador@outlook.com' });
      await createMicrosoftAccount(admin.id, { email: 'admin@outlook.com' });

      const mine = await server.get('/api/microsoft/accounts', { token: workerToken });
      assert.deepEqual(
        mine.body.accounts.map((a) => a.email),
        ['trabajador@outlook.com'],
      );

      const all = await server.get('/api/microsoft/accounts', { token: adminToken });
      assert.deepEqual(
        all.body.accounts.map((a) => a.email).sort(),
        ['admin@outlook.com', 'trabajador@outlook.com'],
      );
    });

    // The token goes through bytea and back; accessTokenFor() decrypts what the driver
    // returns, so the round trip is asserted here rather than discovered on first refresh.
    test('the sealed token survives the database round trip', async () => {
      const account = await createMicrosoftAccount(worker.id);

      const [row] = await sql('select refresh_token_enc from microsoft_accounts where id = $1', [
        account.id,
      ]);
      assert.equal(open(row.refresh_token_enc), 'not-a-real-refresh-token');
    });

    test('reconnecting the same account replaces the row rather than adding one', async () => {
      const first = await createMicrosoftAccount(worker.id);
      const second = await createMicrosoftAccount(worker.id);

      assert.equal(first.id, second.id);
      const res = await server.get('/api/microsoft/accounts', { token: workerToken });
      assert.equal(res.body.accounts.length, 1);
    });
  });

  describe('DELETE /accounts/:id', () => {
    test('revokes the caller\'s own account and records it', async () => {
      const account = await createMicrosoftAccount(worker.id);

      const res = await server.delete(`/api/microsoft/accounts/${account.id}`, {
        token: workerToken,
      });

      assert.equal(res.status, 200);
      assert.notEqual(res.body.account.revokedAt, null);

      const list = await server.get('/api/microsoft/accounts', { token: workerToken });
      assert.equal(list.body.accounts.length, 0);

      const logs = await logsFor('microsoft_accounts', account.id);
      assert.deepEqual(
        logs.map((l) => l.action),
        ['microsoft_account_revoked'],
      );
      assert.equal(logs[0].user_id, worker.id);
      // The sealed token is a column on the row, and the trail must not carry it.
      assert.equal(logs[0].before_data.refresh_token_enc, '[redacted]');
      assert.equal(logs[0].after_data.refresh_token_enc, '[redacted]');
    });

    test('a worker cannot revoke an account somebody else connected', async () => {
      const account = await createMicrosoftAccount(admin.id);

      const res = await server.delete(`/api/microsoft/accounts/${account.id}`, {
        token: workerToken,
      });

      assert.equal(res.status, 403);
      assert.equal(
        res.body.error.message,
        'That Microsoft account was connected by someone else.',
      );
    });

    test('an admin can revoke anyone\'s', async () => {
      const account = await createMicrosoftAccount(worker.id);

      const res = await server.delete(`/api/microsoft/accounts/${account.id}`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
    });

    test('revoking twice is 404, as is an unknown id', async () => {
      const account = await createMicrosoftAccount(worker.id);
      await server.delete(`/api/microsoft/accounts/${account.id}`, { token: workerToken });

      const again = await server.delete(`/api/microsoft/accounts/${account.id}`, {
        token: workerToken,
      });
      assert.equal(again.status, 404);

      const unknown = await server.delete('/api/microsoft/accounts/999999', {
        token: workerToken,
      });
      assert.equal(unknown.status, 404);

      const garbage = await server.delete('/api/microsoft/accounts/abc', {
        token: workerToken,
      });
      assert.equal(garbage.status, 400);
    });
  });
});
