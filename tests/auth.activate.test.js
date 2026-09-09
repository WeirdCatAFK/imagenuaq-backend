import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  createActive,
  createPending,
  softDelete,
  findUser,
  PASSWORD,
} from './helpers/fixtures.js';
import auth from '../src/access/orchestration/auth.js';
import * as tokens from './helpers/tokens.js';

const NEW_PASSWORD = 'una contrasena nueva';

describe('POST /api/auth/activate', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(reset);

  const activate = (body) => server.post('/api/auth/activate', { body });

  const invited = async (email = 'nuevo@uaq.mx') => {
    const user = await createPending({ email, fullName: 'Nuevo Usuario' });
    return { user, invite: await auth.issueInviteToken(user.id) };
  };

  describe('the invitation must be present and genuine', () => {
    test('no token is 400', async () => {
      const res = await activate({ password: NEW_PASSWORD });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'An invitation token is required.');
    });

    test('an empty body is 400', async () => {
      const res = await activate({});

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'An invitation token is required.');
    });

    test('a token that is not a JWT is 401', async () => {
      const res = await activate({ token: tokens.GARBAGE, password: NEW_PASSWORD });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid or expired invitation.');
    });

    test('an invitation signed with another key is 401', async () => {
      const res = await activate({
        token: await tokens.wrongSecret({ purpose: 'invite' }),
        password: NEW_PASSWORD,
      });

      assert.equal(res.status, 401);
    });

    test('an expired invitation is 401', async () => {
      const res = await activate({
        token: await tokens.expired({ purpose: 'invite' }),
        password: NEW_PASSWORD,
      });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid or expired invitation.');
    });

    // The mirror of the check in auth.me: the two token kinds are interchangeable in every
    // respect except the purpose claim, so it has to be enforced from both ends. A session
    // accepted here would let anyone holding a login set a new password without presenting
    // the old one.
    test('a session token is not an invitation', async () => {
      await createActive({ email: 'ana@uaq.mx' });
      const login = await server.post('/api/auth/login', {
        body: { email: 'ana@uaq.mx', password: PASSWORD },
      });

      const res = await activate({ token: login.body.token, password: NEW_PASSWORD });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid or expired invitation.');
    });

    // The row is re-read at redemption rather than trusted from the token's age, so an
    // account removed after the invite went out cannot still be claimed.
    test('an invitation for a soft-deleted user is 401', async () => {
      const { user, invite } = await invited();
      await softDelete(user.id);

      const res = await activate({ token: invite, password: NEW_PASSWORD });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid or expired invitation.');
    });
  });

  describe('the password', () => {
    test('shorter than eight characters is 400', async () => {
      const { invite } = await invited();

      const res = await activate({ token: invite, password: 'corta' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Password must be at least 8 characters long.');
    });

    test('missing is 400', async () => {
      const { invite } = await invited();

      const res = await activate({ token: invite });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Password must be at least 8 characters long.');
    });

    // A rejected password must leave the account exactly as it was, still claimable. If the
    // write happened before the length check the invite would be spent on a password the
    // user never successfully set, locking them out of their own account.
    test('a rejected password leaves the invitation usable', async () => {
      const { user, invite } = await invited();

      await activate({ token: invite, password: 'corta' });

      assert.equal((await findUser(user.id)).password_hash, null);

      const res = await activate({ token: invite, password: NEW_PASSWORD });
      assert.equal(res.status, 200);
    });
  });

  describe('redeeming an invitation', () => {
    test('returns the user and a working session', async () => {
      const { user, invite } = await invited();

      const res = await activate({ token: invite, password: NEW_PASSWORD });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.user, {
        id: user.id,
        email: 'nuevo@uaq.mx',
        fullName: 'Nuevo Usuario',
        roleId: user.role_id,
        role: 'worker',
        // The session gained the area when logs.area_id did -- a screen needs to know which
        // area the signed-in user is in without spending a request. Asserting the whole
        // object is what caught the addition instead of letting it reach the frontend
        // unannounced. Null here because this fixture has no primary area.
        areaId: null,
      });

      // Logged in immediately rather than bounced to a login form for credentials they
      // have only just chosen.
      const me = await server.get('/api/auth/me', { token: res.body.token });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.id, user.id);
    });

    test('the chosen password then works at login', async () => {
      const { invite } = await invited();
      await activate({ token: invite, password: NEW_PASSWORD });

      const res = await server.post('/api/auth/login', {
        body: { email: 'nuevo@uaq.mx', password: NEW_PASSWORD },
      });

      assert.equal(res.status, 200);
    });

    test('the password is stored hashed, never in the clear', async () => {
      const { user, invite } = await invited();
      await activate({ token: invite, password: NEW_PASSWORD });

      const { password_hash: hash } = await findUser(user.id);

      // Cost 12, matching SALT_ROUNDS. A fixture or a script hashing at a different cost
      // would still verify, so nothing else would notice the drift.
      assert.match(hash, /^\$2[aby]\$12\$/);
      assert.equal(hash.includes(NEW_PASSWORD), false);
    });

    // Single use, with no table behind it and no revocation list to keep: the invite is
    // valid only while the account has no password, and redeeming it gives the account one.
    // A replayed link therefore fails on its second use by construction.
    test('the same invitation cannot be redeemed twice', async () => {
      const { invite } = await invited();

      assert.equal((await activate({ token: invite, password: NEW_PASSWORD })).status, 200);

      const res = await activate({ token: invite, password: 'otra contrasena' });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'This invitation has already been used.');
    });

    // Ordering, pinned deliberately. completeInvite() checks the row before it checks the
    // password, so a spent invite reports 409 even when the password would also have been
    // refused. Hoisting the length check -- which reads as a harmless "validate early"
    // tidy-up -- would turn this into a 400 and tell the caller to fix the wrong thing.
    test('a spent invitation reports the conflict, not the short password', async () => {
      const { invite } = await invited();
      await activate({ token: invite, password: NEW_PASSWORD });

      const res = await activate({ token: invite, password: 'abc' });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'This invitation has already been used.');
    });
  });
});
