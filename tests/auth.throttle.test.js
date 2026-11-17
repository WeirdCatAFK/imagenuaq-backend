// The login route throttles failed attempts per IP. A file of its own, because the counter lives
// in the process and would refuse the other login tests' attempts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset, createActive, PASSWORD } from './helpers/fixtures.js';

let server;

before(async () => {
  server = await startServer();
  await reset();
  await createActive({ email: 'throttle@uaq.mx' });
});

after(async () => {
  await reset();
  await server.close();
});

test('twenty failed logins from one IP refuse the next, even with the right password', async () => {
  for (let i = 0; i < 20; i++) {
    const res = await server.post('/api/auth/login', {
      body: { email: 'throttle@uaq.mx', password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
  }

  const res = await server.post('/api/auth/login', {
    body: { email: 'throttle@uaq.mx', password: PASSWORD },
  });
  assert.equal(res.status, 429);
});
