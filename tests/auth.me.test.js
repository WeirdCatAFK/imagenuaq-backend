import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  createActive,
  createPending,
  tokenFor,
  sql,
} from './helpers/fixtures.js';
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

    test('a lowercase bearer scheme is accepted', async () => {
      const res = await me({ headers: { authorization: `bearer ${token}` } });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'ana@uaq.mx');
    });

    test('anything after the token is ignored', async () => {
      const res = await me({ headers: { authorization: `Bearer ${token} extra` } });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'ana@uaq.mx');
    });

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

  test('a token whose account is gone is refused, however valid its signature', async () => {
    await createActive({ email: 'temporal@uaq.mx', fullName: 'Temporal' });
    const theirToken = await tokenFor(server, 'temporal@uaq.mx');

    assert.equal((await me({ token: theirToken })).status, 200);

    await reset();

    const res = await me({ token: theirToken });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Invalid or expired token.');
  });

  test('the subject follows the row, not the claims it was signed with', async () => {
    const user = await createActive({ email: 'cambia@uaq.mx', fullName: 'Nombre Viejo' });
    const theirToken = await tokenFor(server, 'cambia@uaq.mx');

    await sql('update users set full_name = $2 where id = $1', [user.id, 'Nombre Nuevo']);

    const res = await me({ token: theirToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.fullName, 'Nombre Nuevo');
  });
});
