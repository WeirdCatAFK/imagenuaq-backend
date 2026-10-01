// Invites expire in three days and travel by email or chat, so the first one going astray
// is ordinary. Without this route the only remedy would be deleting and recreating the
// user, which changes their id and orphans anything already assigned to them.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createPending,
  createActive,
  softDelete,
  tokenFor,
} from './helpers/fixtures.js';
import * as tokens from './helpers/tokens.js';

describe('POST /api/users/:id/invite', () => {
  let server;
  let adminToken;

  const ACCOUNTS = ['coordinacion@uaq.mx'];

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: 'coordinacion@uaq.mx', role: 'admin' });
    adminToken = await tokenFor(server, 'coordinacion@uaq.mx');
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  const reinvite = (id, token = adminToken) =>
    server.post(`/api/users/${id}/invite`, { token });

  describe('only coordination may re-issue', () => {
    test('without a token it is 401', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });

      const res = await server.post(`/api/users/${user.id}/invite`);

      assert.equal(res.status, 401);
    });

    test('a worker is 403', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });
      const worker = await createPending({ email: 'worker@uaq.mx', role: 'worker' });

      const res = await reinvite(
        user.id,
        await tokens.session({ ...worker, role_name: 'worker' }),
      );

      assert.equal(res.status, 403);
      assert.equal(res.body.error.message, 'Insufficient role for this resource.');
    });
  });

  describe('the id must be a positive integer', () => {
    for (const [label, id] of [
      ['a word', 'abc'],
      ['zero', '0'],
      ['a negative number', '-3'],
      ['a fraction', '1.5'],
      ['an empty-ish value', '%20'],
    ]) {
      test(`${label} is 400`, async () => {
        const res = await reinvite(id);

        assert.equal(res.status, 400);
        assert.equal(res.body.error.message, 'Invalid user id.');
      });
    }
  });

  describe('the account must exist and be dormant', () => {
    test('an unknown id is 404', async () => {
      const res = await reinvite(999_999);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'User not found.');
    });

    test('a soft-deleted user is 404', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });
      await softDelete(user.id);

      const res = await reinvite(user.id);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'User not found.');
    });

    test('an already-activated account is 409', async () => {
      const user = await createActive({ email: 'activa@uaq.mx' });

      const res = await reinvite(user.id);

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'This account is already active.');
    });
  });

  describe('re-issuing', () => {
    test('returns a fresh invitation for a dormant account', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });

      const res = await reinvite(user.id);

      assert.equal(res.status, 200);
      assert.equal(typeof res.body.inviteToken, 'string');
    });

    test('the fresh invitation activates the account', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });
      const { body } = await reinvite(user.id);

      const activated = await server.post('/api/auth/activate', {
        body: { token: body.inviteToken, password: 'una contrasena larga' },
      });

      assert.equal(activated.status, 200);
      assert.equal(activated.body.user.id, user.id);
    });

    test('an earlier invitation dies only when the account is activated', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });
      const first = (await reinvite(user.id)).body.inviteToken;
      const second = (await reinvite(user.id)).body.inviteToken;

      const usedSecond = await server.post('/api/auth/activate', {
        body: { token: second, password: 'una contrasena larga' },
      });
      assert.equal(usedSecond.status, 200);

      const usedFirst = await server.post('/api/auth/activate', {
        body: { token: first, password: 'otra contrasena larga' },
      });
      assert.equal(usedFirst.status, 409);
    });

    test('two invitations minted in the same second are identical', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });

      const [first, second] = await Promise.all([reinvite(user.id), reinvite(user.id)]);

      assert.equal(first.body.inviteToken, second.body.inviteToken);
    });
  });
});
