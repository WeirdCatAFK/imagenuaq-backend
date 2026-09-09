import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import { reset } from './helpers/fixtures.js';

// The envelope every refusal arrives in, and the classification behind the status code.
// These are the assertions the frontend's error handling is built on, so they are pinned
// here rather than left implicit in the endpoint files.
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

    // Guards mounted with use() run before route matching, so an unauthenticated caller
    // gets 401 from the users router rather than the 404 the path would otherwise earn.
    // The alternative -- 404 for everything you may not see -- would be a defensible
    // design and is not this one.
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

    // Included whenever NODE_ENV is not production, for ApiErrors as much as for bugs.
    // The suite runs as NODE_ENV=test, so this is the development shape.
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

  // express.json() refuses some requests before any of our code runs. Those refusals are
  // not ApiErrors and never will be -- body-parser has no idea ApiError exists -- but they
  // are the caller's fault, not a bug, and the error handler has to tell the two apart.
  // Reporting a stray comma as a 500 tells the frontend the server broke and the request
  // is worth retrying; both halves are wrong.
  describe('malformed request bodies', () => {
    test('unparseable JSON is 400, not 500', async () => {
      const res = await server.post('/api/auth/login', { raw: '{"email": ' });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /JSON/i);
    });

    // express.json() runs in strict mode by default, so a bare string or number is refused
    // even though JSON.parse would accept it. That refusal is a 400 for the same reason
    // unparseable input is -- it reaches the same branch of the error handler -- and it
    // never reaches the route.
    test('a valid JSON scalar is still refused, in strict mode', async () => {
      const res = await server.post('/api/auth/login', { raw: '"hola"' });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /JSON/i);
    });

    // An empty body parses to {} rather than raising, so the route refuses on its own
    // terms. The distinction matters: "you sent nothing" is the caller forgetting a field,
    // not the caller sending something unreadable.
    test('an empty body reaches the route as an empty object', async () => {
      const res = await server.post('/api/auth/login', { raw: '' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });

    // express.json() defaults to a 100 kb limit, which nothing overrides.
    test('a body over the size limit is 413', async () => {
      const res = await server.post('/api/auth/login', {
        raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }),
      });

      assert.equal(res.status, 413);
    });

    // A content-type express.json() does not claim leaves req.body empty rather than
    // raising: the route then refuses for the ordinary reason, which is the right answer
    // for a client that forgot its header.
    test('a non-JSON content type leaves the body empty', async () => {
      const res = await server.post('/api/auth/login', {
        raw: 'email=ana@uaq.mx&password=secreto',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, 'Email and password are required.');
    });

    // The carve-out is narrow on purpose. It admits only errors body-parser has already
    // classified as the client's fault, so a genuine bug still gets the 500 it deserves --
    // there is no route that returns one today, which is why this asserts the shape of the
    // rule rather than provoking it.
    test('the parser refusal is reported without a server-error status', async () => {
      const res = await server.post('/api/auth/login', { raw: '{oops}' });

      assert.equal(res.status >= 400 && res.status < 500, true);
      assert.equal(res.status, 400);
    });
  });
});
