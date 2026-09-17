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
        assert.match(res.body.error.message, /MS_CLIENT_ID and MS_CLIENT_SECRET/);
      } finally {
        process.env.MS_CLIENT_ID = saved;
      }
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
