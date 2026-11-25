// The login route throttles failed attempts per IP and account, and per IP in all. A file of its
// own, because the counter lives in the process and would refuse the other login tests' attempts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, PASSWORD } from './helpers/fixtures.js';

let server;

before(async () => {
  server = await startServer();
  await reset();
  await createActive({ email: 'throttle@uaq.mx' });
  await createActive({ email: 'colleague@uaq.mx' });
});

const login = (email, password, ip) =>
  server.post('/api/auth/login', { body: { email, password }, headers: { 'x-forwarded-for': ip } });

after(async () => {
  await reset();
  await server.close();
});

test('twenty failed logins on one account refuse the next, even with the right password', async () => {
  for (let i = 0; i < 20; i++) {
    const res = await login('throttle@uaq.mx', 'wrong-password', '203.0.113.1');
    assert.equal(res.status, 401);
  }

  assert.equal((await login(' THROTTLE@uaq.mx', PASSWORD, '203.0.113.1')).status, 429);
});

test('the lockout reaches neither a colleague on the same IP nor the same account elsewhere', async () => {
  assert.equal((await login('colleague@uaq.mx', PASSWORD, '203.0.113.1')).status, 200);
  assert.equal((await login('throttle@uaq.mx', PASSWORD, '203.0.113.2')).status, 200);
});

test('a client that forges X-Forwarded-For is still known by the address its proxy appended', async () => {
  const res = await login('throttle@uaq.mx', PASSWORD, '198.51.100.9, 203.0.113.1');
  assert.equal(res.status, 429);
});

test('two hundred failures from one IP refuse every account on it', async () => {
  for (let i = 0; i < 200; i++) await login(`nobody${i}@uaq.mx`, 'wrong-password', '203.0.113.3');
  assert.equal((await login('colleague@uaq.mx', PASSWORD, '203.0.113.3')).status, 429);
});
