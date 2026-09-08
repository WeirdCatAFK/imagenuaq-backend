import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  createPending,
  createActive,
  softDelete,
  tokenFor,
} from './helpers/fixtures.js';
import * as tokens from './helpers/tokens.js';

// Invites expire in three days and travel by email or chat, so the first one going astray
// is ordinary. Without this route the only remedy would be deleting and recreating the
// user, which changes their id and orphans anything already assigned to them.
describe('POST /api/users/:id/invite', () => {
  let server;
  let adminToken;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: 'coordinacion@uaq.mx', role: 'admin' });
    adminToken = await tokenFor(server, 'coordinacion@uaq.mx');
  });

  after(async () => {
    await server.close();
  });

  beforeEach(reset);

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

  // Number() accepts a good deal that is not an id. The check is Number.isInteger and > 0
  // rather than a truthiness test, so "1.5" and "-3" are refused before they reach a query.
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

    // Soft-deleted users are filtered out of the lookup, so a removed account cannot be
    // handed a fresh way in.
    test('a soft-deleted user is 404', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });
      await softDelete(user.id);

      const res = await reinvite(user.id);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'User not found.');
    });

    // Re-inviting an active account would be a password reset by another name, and this
    // flow is not one: it hands whoever holds the link a working session. A real reset
    // needs a single-use token of its own, which does not exist yet.
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

    // Re-issuing does not revoke what came before -- there is no table to record a
    // revocation in. Every outstanding link stays good until one of them is spent, and
    // then all of them are dead, because what invalidates them is the password appearing
    // on the row rather than anything about the token. Pinned because it is the visible
    // cost of the no-table design: anyone adding real revocation has to change a test that
    // says so out loud.
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

    // A consequence of the claims being fully determined by the subject: purpose, sub, iss
    // and aud are fixed, and `iat`/`exp` are whole seconds, so two invites minted for the
    // same user inside one second are the same string. Harmless -- they are equivalent
    // credentials for the same account, and the single-use rule lives on the row rather
    // than on the token -- but surprising enough that a reader deserves to find it stated
    // rather than discover it debugging a test.
    test('two invitations minted in the same second are identical', async () => {
      const user = await createPending({ email: 'pendiente@uaq.mx' });

      const [first, second] = await Promise.all([reinvite(user.id), reinvite(user.id)]);

      assert.equal(first.body.inviteToken, second.body.inviteToken);
    });
  });
});
