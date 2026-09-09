import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createActive,
  createPending,
  logsFor,
  tokenFor,
} from './helpers/fixtures.js';

// Profile pictures, stored as bytes on the users row.
//
// Two things here are worth more than the round trip. The type travels with the bytes --
// bytea alone cannot tell a browser whether it is looking at a PNG or a JPEG, and the
// CHECK constraint keeps the pair from ever being half-set. And the audit trail records
// only THAT a picture changed: audit.js redacts by column name and `profile_picture`
// matches none of its patterns, so an unguarded emit would put the image in `logs`.
describe('/api/users/:id/picture', () => {
  let server;
  let adminToken;
  let workerToken;
  let user;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  // The smallest valid PNG: an 8-bit greyscale 1x1. A real file rather than random bytes,
  // so a future check that sniffs the magic number does not have to invent one.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64',
  );

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: 'admin' });
    await createActive({ email: ACCOUNTS[1], role: 'worker' });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    user = await createPending({ email: 'nuevo@uaq.mx', role: 'worker' });
  });

  // `raw`, not `body`: the helper JSON-stringifies `body`, which would turn a Buffer into
  // {"type":"Buffer","data":[...]} and upload that instead of the image.
  const put = (id, bytes, contentType = 'image/png', token = adminToken) =>
    server.put(`/api/users/${id}/picture`, {
      token,
      raw: bytes,
      headers: { 'content-type': contentType },
    });

  describe('the admin gate', () => {
    test('a worker may not upload', async () => {
      const res = await put(user.id, PNG, 'image/png', workerToken);
      assert.equal(res.status, 403);
    });

    test('a worker may read', async () => {
      await put(user.id, PNG);

      const res = await server.get(`/api/users/${user.id}/picture`, {
        token: workerToken,
      });
      assert.equal(res.status, 200);
    });
  });

  describe('round trip', () => {
    test('stores and serves the same bytes', async () => {
      const stored = await put(user.id, PNG);
      assert.equal(stored.status, 204);

      const res = await server.get(`/api/users/${user.id}/picture`, {
        token: adminToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
    });

    test('a second upload replaces the first', async () => {
      await put(user.id, PNG, 'image/png');
      const second = await put(user.id, PNG, 'image/jpeg');

      assert.equal(second.status, 204);

      const res = await server.get(`/api/users/${user.id}/picture`, {
        token: adminToken,
      });
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
    });
  });

  describe('refusals', () => {
    test('a type that is not on the allow-list is 400', async () => {
      const res = await put(user.id, Buffer.from('hello'), 'text/plain');

      assert.equal(res.status, 400);
      assert.equal(
        res.body.error.message,
        'Content-Type must be one of: image/png, image/jpeg, image/webp.',
      );
    });

    test('an empty body is 400', async () => {
      const res = await put(user.id, Buffer.alloc(0));

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'An image body is required.');
    });

    test('a user that does not exist is 404', async () => {
      const res = await put(999999, PNG);
      assert.equal(res.status, 404);
    });

    test('reading a user who never set one is 404', async () => {
      const res = await server.get(`/api/users/${user.id}/picture`, {
        token: adminToken,
      });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'No profile picture set.');
    });
  });

  describe('DELETE', () => {
    test('clears it, and reading afterwards is 404', async () => {
      await put(user.id, PNG);

      const removed = await server.delete(`/api/users/${user.id}/picture`, {
        token: adminToken,
      });
      assert.equal(removed.status, 204);

      const res = await server.get(`/api/users/${user.id}/picture`, {
        token: adminToken,
      });
      assert.equal(res.status, 404);
    });

    test('clearing a user who had none is still 204', async () => {
      const res = await server.delete(`/api/users/${user.id}/picture`, {
        token: adminToken,
      });
      assert.equal(res.status, 204);
    });
  });

  describe('the audit trail', () => {
    test('records that a picture changed, never the bytes', async () => {
      await put(user.id, PNG);

      const rows = await logsFor('users', user.id);
      const entry = rows.find((row) => row.action === 'record_updated');

      assert.ok(entry, 'no record_updated row was written');
      assert.deepEqual(entry.before_data, { profile_picture: false });
      assert.deepEqual(entry.after_data, { profile_picture: true });

      // Belt and braces: the encoded image must not appear anywhere in the trail.
      const serialised = JSON.stringify(rows);
      assert.equal(serialised.includes(PNG.toString('base64').slice(0, 24)), false);
    });
  });
});
