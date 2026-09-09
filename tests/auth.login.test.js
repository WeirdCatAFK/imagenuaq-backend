import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, createPending, softDelete, PASSWORD } from './helpers/fixtures.js';

describe('POST /api/auth/login', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
  });

  beforeEach(reset);

  const login = (body) => server.post('/api/auth/login', { body });

  describe('missing credentials', () => {
    test('no email is 400', async () => {
      const res = await login({ password: PASSWORD });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });

    test('no password is 400', async () => {
      const res = await login({ email: 'ana@uaq.mx' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });

    test('an empty body is 400, not a crash', async () => {
      const res = await login({});

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });

    // `req.body ?? {}` in the route. Without it this would be a TypeError and a 500.
    test('no body at all is 400, not a crash', async () => {
      const res = await server.post('/api/auth/login');

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });
  });

  // The property ABSENT_USER_HASH exists to protect. Three genuinely different states --
  // no such address, an address that has never chosen a password, and the wrong password
  // for a live account -- must be indistinguishable from outside. Splitting any of them
  // into its own message would hand an attacker a free "does this address have an
  // account?" oracle, which is exactly what the dummy bcrypt comparison is paying for.
  describe('refusals are indistinguishable', () => {
    test('an unknown email is 401', async () => {
      const res = await login({ email: 'nobody@uaq.mx', password: PASSWORD });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid email or password.');
    });

    test('a wrong password is 401 with the same message', async () => {
      await createActive({ email: 'ana@uaq.mx' });

      const res = await login({ email: 'ana@uaq.mx', password: 'not the password' });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid email or password.');
    });

    // A created-but-never-activated account has password_hash IS NULL. It must refuse like
    // any other bad login rather than announcing that the address is real and merely
    // dormant.
    test('an account that has never activated is 401 with the same message', async () => {
      await createPending({ email: 'pendiente@uaq.mx' });

      const res = await login({ email: 'pendiente@uaq.mx', password: PASSWORD });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid email or password.');
    });

    test('a soft-deleted user cannot log in', async () => {
      const user = await createActive({ email: 'salio@uaq.mx' });
      await softDelete(user.id);

      const res = await login({ email: 'salio@uaq.mx', password: PASSWORD });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'Invalid email or password.');
    });

    test('all four refusals are byte-identical', async () => {
      const user = await createActive({ email: 'ana@uaq.mx' });
      await createPending({ email: 'pendiente@uaq.mx' });
      const gone = await createActive({ email: 'salio@uaq.mx' });
      await softDelete(gone.id);

      const bodies = await Promise.all(
        [
          { email: 'nobody@uaq.mx', password: PASSWORD },
          { email: 'ana@uaq.mx', password: 'wrong' },
          { email: 'pendiente@uaq.mx', password: PASSWORD },
          { email: 'salio@uaq.mx', password: PASSWORD },
        ].map(async (body) => {
          const res = await login(body);
          return `${res.status} ${res.body.error.message}`;
        }),
      );

      assert.equal(user.id > 0, true);
      assert.equal(new Set(bodies).size, 1, `distinguishable refusals: ${bodies.join(' | ')}`);
    });
  });

  describe('a successful login', () => {
    test('returns a token and the session subject', async () => {
      const created = await createActive({
        email: 'ana@uaq.mx',
        fullName: 'Ana Gómez',
        role: 'area_lead',
      });

      const res = await login({ email: 'ana@uaq.mx', password: PASSWORD });

      assert.equal(res.status, 200);
      assert.equal(typeof res.body.token, 'string');
      assert.deepEqual(res.body.user, {
        id: created.id,
        email: 'ana@uaq.mx',
        fullName: 'Ana Gómez',
        roleId: created.role_id,
        role: 'area_lead',
        areaId: null,
      });
    });

    // The response is assembled field by field in orchestration/auth.js rather than by
    // spreading the row, and this is what that buys. A refactor to `...user` would leak
    // the hash to every client that logs in.
    test('never returns the password hash', async () => {
      await createActive({ email: 'ana@uaq.mx' });

      const res = await login({ email: 'ana@uaq.mx', password: PASSWORD });

      assert.equal('password_hash' in res.body.user, false);
      assert.equal('passwordHash' in res.body.user, false);
      assert.equal(res.text.includes('$2b$'), false);
    });

    // Addresses are lowercased when the account is created, so the lookup has to lowercase
    // too -- a phone keyboard capitalises the first letter of an email by default, and
    // without this those users simply cannot log in.
    test('the email is matched case-insensitively', async () => {
      await createActive({ email: 'ana@uaq.mx' });

      const res = await login({ email: 'ANA@UAQ.MX', password: PASSWORD });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'ana@uaq.mx');
    });

    test('surrounding whitespace in the email is ignored', async () => {
      await createActive({ email: 'ana@uaq.mx' });

      const res = await login({ email: '  ana@uaq.mx  ', password: PASSWORD });

      assert.equal(res.status, 200);
    });

    // The password is the one thing not normalised: a trimmed password would silently
    // accept a credential the user did not choose.
    test('whitespace in the password is significant', async () => {
      await createActive({ email: 'ana@uaq.mx' });

      const res = await login({ email: 'ana@uaq.mx', password: ` ${PASSWORD} ` });

      assert.equal(res.status, 401);
    });
  });
});
