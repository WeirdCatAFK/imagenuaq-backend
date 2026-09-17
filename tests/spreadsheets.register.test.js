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

// The registry half: registering a table under a connected account, listing, removing.
// Registration takes the ids `resolve` returned and does not call Microsoft, which is what
// makes these cases possible offline (orchestration/spreadsheets.js on the trade).
describe('/api/spreadsheets', () => {
  let server;
  let admin;
  let worker;
  let adminToken;
  let workerToken;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  const BOOK = {
    name: 'Seguimiento de solicitudes 2026',
    driveId: 'b!drive',
    itemId: '01ITEM',
    tableName: 'Tabla1',
    webUrl: 'https://uaq-my.sharepoint.com/:x:/g/personal/x/abc',
  };

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: ACCOUNTS[0], role: 'admin' });
    worker = await createActive({ email: ACCOUNTS[1], role: 'worker' });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);

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

  describe('POST /', () => {
    test('registers a table under the caller\'s account, unmapped', async () => {
      const account = await createMicrosoftAccount(worker.id);

      const res = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: account.id },
      });

      assert.equal(res.status, 201);
      const { sheet } = res.body;
      assert.equal(sheet.name, BOOK.name);
      assert.equal(sheet.driveId, BOOK.driveId);
      assert.equal(sheet.itemId, BOOK.itemId);
      assert.equal(sheet.tableName, BOOK.tableName);
      assert.equal(sheet.webUrl, BOOK.webUrl);
      assert.equal(sheet.accountId, account.id);
      assert.equal(sheet.accountEmail, 'cuenta@outlook.com');
      assert.equal(sheet.registeredBy, worker.id);
      assert.equal(sheet.registeredByName, 'Prueba Usuario');
      // Registered, not mapped: the microsoft-accounts migration made this the resting state.
      assert.equal(sheet.schemaVersionId, null);
      assert.deepEqual(sheet.columnMap, {});
      assert.equal(sheet.mapped, false);

      const logs = await logsFor('sheets', sheet.id);
      assert.deepEqual(logs.map((l) => l.action), ['record_created']);
      assert.equal(logs[0].user_id, worker.id);
    });

    test('tableName is optional and means the first table', async () => {
      const account = await createMicrosoftAccount(worker.id);

      const res = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { name: BOOK.name, driveId: BOOK.driveId, itemId: BOOK.itemId, accountId: account.id },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.sheet.tableName, null);
      assert.equal(res.body.sheet.webUrl, null);
    });

    test('the same table twice is 409; a different table in the same book is fine', async () => {
      const account = await createMicrosoftAccount(worker.id);
      const body = { ...BOOK, accountId: account.id };

      assert.equal((await server.post('/api/spreadsheets', { token: workerToken, body })).status, 201);

      const again = await server.post('/api/spreadsheets', { token: workerToken, body });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.message, 'That table is already registered.');

      const other = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...body, tableName: 'Tabla2' },
      });
      assert.equal(other.status, 201);
    });

    // uq_sheets_item coalesces a NULL table_name, so "the default table" registered twice
    // is the same table twice and not two rows that happen to both say nothing.
    test('the default table twice is also 409', async () => {
      const account = await createMicrosoftAccount(worker.id);
      const body = { name: BOOK.name, driveId: BOOK.driveId, itemId: BOOK.itemId, accountId: account.id };

      assert.equal((await server.post('/api/spreadsheets', { token: workerToken, body })).status, 201);
      assert.equal((await server.post('/api/spreadsheets', { token: workerToken, body })).status, 409);
    });

    test('a worker cannot register through an account somebody else connected', async () => {
      const account = await createMicrosoftAccount(admin.id);

      const res = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: account.id },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.message, 'That Microsoft account was connected by someone else.');
    });

    test('an admin can register through anyone\'s account', async () => {
      const account = await createMicrosoftAccount(worker.id);

      const res = await server.post('/api/spreadsheets', {
        token: adminToken,
        body: { ...BOOK, accountId: account.id },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.sheet.registeredBy, admin.id);
    });

    test('an unknown or revoked account is 404', async () => {
      const unknown = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: 999999 },
      });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error.message, 'Microsoft account not found.');

      const account = await createMicrosoftAccount(worker.id);
      await server.delete(`/api/microsoft/accounts/${account.id}`, { token: workerToken });

      const revoked = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: account.id },
      });
      assert.equal(revoked.status, 404);
    });

    test('a bad payload is 400 and names the field', async () => {
      const account = await createMicrosoftAccount(worker.id);
      const good = { ...BOOK, accountId: account.id };

      const cases = [
        [{ ...good, name: '   ' }, /name is required/],
        [{ ...good, name: 'x'.repeat(301) }, /name is required/],
        [{ ...good, driveId: '' }, /driveId and itemId are required/],
        [{ ...good, itemId: undefined }, /driveId and itemId are required/],
        [{ ...good, tableName: 'x'.repeat(201) }, /tableName/],
        [{ ...good, webUrl: 'http://insecure' }, /webUrl must be an https link/],
        [{ ...good, accountId: 'abc' }, /accountId must be a positive integer/],
      ];

      for (const [body, message] of cases) {
        const res = await server.post('/api/spreadsheets', { token: workerToken, body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match(res.body.error.message, message);
      }
    });
  });

  describe('GET / and GET /:id', () => {
    test('lists every live registration, whoever made it', async () => {
      const mine = await createMicrosoftAccount(worker.id);
      const theirs = await createMicrosoftAccount(admin.id, { email: 'admin@outlook.com' });

      await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: mine.id },
      });
      await server.post('/api/spreadsheets', {
        token: adminToken,
        body: { ...BOOK, itemId: 'OTHER', name: 'Otro libro', accountId: theirs.id },
      });

      const res = await server.get('/api/spreadsheets', { token: workerToken });

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.sheets.map((s) => s.name).sort(),
        ['Otro libro', BOOK.name],
      );
    });

    test('says when the account behind a book has been revoked', async () => {
      const account = await createMicrosoftAccount(worker.id);
      const created = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: account.id },
      });
      await server.delete(`/api/microsoft/accounts/${account.id}`, { token: workerToken });

      const res = await server.get(`/api/spreadsheets/${created.body.sheet.id}`, {
        token: workerToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.sheet.accountRevoked, true);
    });

    test('an unknown id is 404 and a non-id is 400', async () => {
      assert.equal((await server.get('/api/spreadsheets/999999', { token: workerToken })).status, 404);
      assert.equal((await server.get('/api/spreadsheets/abc', { token: workerToken })).status, 400);
    });
  });

  describe('GET /resolve', () => {
    test('a missing or non-https url is 400 before Microsoft is asked', async () => {
      const account = await createMicrosoftAccount(worker.id);

      const missing = await server.get(`/api/spreadsheets/resolve?accountId=${account.id}`, {
        token: workerToken,
      });
      assert.equal(missing.status, 400);

      const http = await server.get(
        `/api/spreadsheets/resolve?accountId=${account.id}&url=http://x`,
        { token: workerToken },
      );
      assert.equal(http.status, 400);
    });

    test('somebody else\'s account is refused before Microsoft is asked', async () => {
      const account = await createMicrosoftAccount(admin.id);

      const res = await server.get(
        `/api/spreadsheets/resolve?accountId=${account.id}&url=https://x`,
        { token: workerToken },
      );

      assert.equal(res.status, 403);
    });
  });

  describe('DELETE /:id', () => {
    test('soft-deletes, records it, and frees the table for re-registration', async () => {
      const account = await createMicrosoftAccount(worker.id);
      const created = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: account.id },
      });
      const id = created.body.sheet.id;

      const res = await server.delete(`/api/spreadsheets/${id}`, { token: workerToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.sheet.id, id);

      const [row] = await sql('select deleted_at from sheets where id = $1', [id]);
      assert.notEqual(row.deleted_at, null);

      const logs = await logsFor('sheets', id);
      assert.deepEqual(logs.map((l) => l.action), ['record_created', 'record_deleted']);

      assert.equal((await server.get(`/api/spreadsheets/${id}`, { token: workerToken })).status, 404);
      assert.equal((await server.delete(`/api/spreadsheets/${id}`, { token: workerToken })).status, 404);

      const again = await server.post('/api/spreadsheets', {
        token: workerToken,
        body: { ...BOOK, accountId: account.id },
      });
      assert.equal(again.status, 201);
    });
  });
});
