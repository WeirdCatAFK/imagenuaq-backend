import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, createPending, tokenFor, sql } from './helpers/fixtures.js';
import auth from '../src/access/orchestration/auth.js';
import * as tokens from './helpers/tokens.js';

describe('GET /api/auth/me', () => {
  let server;
  let user;
  let token;

  before(async () => {
    server = await startServer();
    await reset();
    user = await createActive({ email: 'ana@uaq.mx', fullName: 'Ana Gómez', role: 'worker' });
    token = await tokenFor(server, 'ana@uaq.mx');
  });

  after(async () => {
    await server.close();
  });

  const me = (options) => server.get('/api/auth/me', options);

  // The header is parsed before anything is verified, and a header that yields no token at
  // all is a different failure from a token that does not verify. Both are 401 -- a stale
  // token must never be a 403, which tells the frontend to give up when what it should do
  // is send the user back to the login form -- but the messages differ, and clients key
  // off them.
  describe('the Authorization header', () => {
    test('a missing header is 401', async () => {
      const res = await me();

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    test('a non-Bearer scheme is 401', async () => {
      const res = await me({ headers: { authorization: `Token ${token}` } });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    test('a scheme with nothing after it is 401', async () => {
      const res = await me({ headers: { authorization: 'Bearer' } });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    test('an empty header is 401', async () => {
      const res = await me({ headers: { authorization: '' } });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });

    // RFC 7235 makes the scheme case-insensitive and some clients send it lowercased.
    test('a lowercase bearer scheme is accepted', async () => {
      const res = await me({ headers: { authorization: `bearer ${token}` } });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'ana@uaq.mx');
    });

    // split(' ') destructures the second field as the token and discards the rest, so a
    // trailing third field is ignored rather than folded into the credential. Lenient, and
    // harmless: a JWT contains no spaces, so nothing legitimate is being truncated. Pinned
    // because a stricter parser that rejected the whole header would be a defensible change
    // and should be a deliberate one.
    test('anything after the token is ignored', async () => {
      const res = await me({ headers: { authorization: `Bearer ${token} extra` } });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'ana@uaq.mx');
    });

    // The other half of the same rule: it really is the SECOND field that is verified, so
    // junk there fails even though a valid token follows it.
    test('only the second field is treated as the token', async () => {
      const res = await me({ headers: { authorization: `Bearer nonsense ${token}` } });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid or expired token.');
    });
  });

  describe('token verification', () => {
    const rejected = async (value) => {
      const res = await me({ token: value });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid or expired token.');
    };

    test('a token that is not a JWT is 401', async () => {
      await rejected(tokens.GARBAGE);
    });

    test('a token signed with another key is 401', async () => {
      await rejected(await tokens.wrongSecret());
    });

    // Issuer and audience are pinned into every token and re-checked here, so a token
    // minted by staging or a colleague's laptop is refused even when it was signed with
    // the same leaked secret.
    test('a token from another issuer is 401', async () => {
      await rejected(await tokens.wrongIssuer());
    });

    test('a token for another audience is 401', async () => {
      await rejected(await tokens.wrongAudience());
    });

    test('an expired token is 401', async () => {
      await rejected(await tokens.expired());
    });

    test('a token with no purpose claim is 401', async () => {
      await rejected(await tokens.noPurpose());
    });
  });

  // The check this endpoint exists to prove. An invite is signed with the same key, for the
  // same issuer and audience, and has not expired -- signature, iss, aud and exp all pass.
  // Only the purpose claim stands between a passwordless account and a working session.
  test('an invite token is not a session', async () => {
    const pending = await createPending({ email: 'pendiente@uaq.mx' });
    const invite = await auth.issueInviteToken(pending.id);

    const res = await me({ token: invite });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Invalid or expired token.');
  });

  test('a valid token returns the subject login issued', async () => {
    const res = await me({ token });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user, {
      id: user.id,
      email: 'ana@uaq.mx',
      fullName: 'Ana Gómez',
      roleId: user.role_id,
      role: 'worker',
      areaId: null,
    });
  });

  // This is the test the old comment here said should change when token_version landed, and
  // it has: verifyToken() re-reads the user row on every authenticated request, compares
  // `token_version` against the claim, and builds the subject from the row rather than from
  // the token. So a signature that is still perfectly valid is no longer sufficient -- the
  // account behind it has to still exist.
  test('a token whose account is gone is refused, however valid its signature', async () => {
    await createActive({ email: 'temporal@uaq.mx', fullName: 'Temporal' });
    const theirToken = await tokenFor(server, 'temporal@uaq.mx');

    assert.equal((await me({ token: theirToken })).status, 200);

    await reset();

    const res = await me({ token: theirToken });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Invalid or expired token.');
  });

  // The other half of the same read, and the reason it is worth a round trip: a change made
  // after the token was signed lands on the next request instead of waiting out seven days.
  test('the subject follows the row, not the claims it was signed with', async () => {
    const user = await createActive({ email: 'cambia@uaq.mx', fullName: 'Nombre Viejo' });
    const theirToken = await tokenFor(server, 'cambia@uaq.mx');

    await sql('update users set full_name = $2 where id = $1', [user.id, 'Nombre Nuevo']);

    const res = await me({ token: theirToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.fullName, 'Nombre Nuevo');
  });
});
