// The envelope every refusal arrives in, and the classification behind the status code.
// These are the assertions the frontend's error handling is built on, so they are pinned
// here rather than left implicit in the endpoint files.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset } from './helpers/fixtures.js';

describe('errors', () => {
  let server;

  before(async () => {
    server = await startServer();
    await reset();
  });

  after(async () => {
    await server.close();
  });

  describe('unmatched routes', () => {
    test('name the method and path that missed', async () => {
      const res = await server.get('/api/nope');

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Route GET /api/nope not found');
    });

    test('a nonexistent prefix is 404', async () => {
      const res = await server.get('/api/proyectos');

      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'Route GET /api/proyectos not found');
    });

    test('the query string is included, since originalUrl carries it', async () => {
      const res = await server.get('/api/nope?a=1');

      assert.equal(res.body.error.message, 'Route GET /api/nope?a=1 not found');
    });

    test('a guarded router answers 401 before it answers 404', async () => {
      const res = await server.get('/api/users');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.message, 'No token provided.');
    });
  });

  describe('the error envelope', () => {
    test('is always { error: { message } }', async () => {
      const res = await server.get('/api/nope');

      assert.equal(typeof res.body.error, 'object');
      assert.equal(typeof res.body.error.message, 'string');
    });

    test('carries a stack outside production', async () => {
      const res = await server.get('/api/nope');

      assert.equal(typeof res.body.error.stack, 'string');
      assert.match(res.body.error.stack, /Error/);
    });

    test('is JSON even when the request was not', async () => {
      const res = await server.get('/api/nope', { headers: { accept: 'text/html' } });

      assert.match(res.headers.get('content-type'), /application\/json/);
    });
  });

  describe('malformed request bodies', () => {
    test('unparseable JSON is 400, not 500', async () => {
      const res = await server.post('/api/auth/login', { raw: '{"email": ' });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /JSON/i);
    });

    test('a valid JSON scalar is still refused, in strict mode', async () => {
      const res = await server.post('/api/auth/login', { raw: '"hola"' });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /JSON/i);
    });

    test('an empty body reaches the route as an empty object', async () => {
      const res = await server.post('/api/auth/login', { raw: '' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });

    test('a body over the size limit is 413', async () => {
      const res = await server.post('/api/auth/login', {
        raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }),
      });

      assert.equal(res.status, 413);
    });

    test('a non-JSON content type leaves the body empty', async () => {
      const res = await server.post('/api/auth/login', {
        raw: 'email=ana@uaq.mx&password=secreto',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });

    test('the parser refusal is reported without a server-error status', async () => {
      const res = await server.post('/api/auth/login', { raw: '{oops}' });

      assert.equal(res.status >= 400 && res.status < 500, true);
      assert.equal(res.status, 400);
    });
  });
});
