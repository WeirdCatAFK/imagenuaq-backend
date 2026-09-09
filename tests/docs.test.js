import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServerWithoutDatabase } from './helpers/server.js';
import { ROUTERS } from '../src/api.js';
import { buildOpenApiDocument } from '../src/swagger.js';

// The docs describe the API; they do not read it. Nothing here touches Postgres, so this
// file boots the server with no pool at all -- if a case in here ever needs a database,
// something has gone wrong in routes/docs.js rather than in the test.
describe('GET /api/docs', () => {
  let server;

  before(async () => {
    server = await startServerWithoutDatabase();
  });

  after(async () => {
    await server.close();
  });

  test('serves the raw document as JSON', async () => {
    const res = await server.get('/api/docs/openapi.json');

    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, '3.1.0');
    assert.equal(res.body.info.title, 'Imagen UAQ API');
  });

  test('redirects to the trailing slash so relative assets resolve', async () => {
    // Without this, the browser resolves ./swagger-ui-bundle.js against /api/ and the page
    // renders empty. fetch() follows redirects by default, so the redirect is opted out of
    // rather than asserted after the fact.
    const res = await fetch(`${server.base}/api/docs`, { redirect: 'manual' });

    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/api/docs/');
  });

  test('serves the Swagger UI page and the bundle it asks for', async () => {
    const page = await server.get('/api/docs/');
    assert.equal(page.status, 200);
    assert.match(page.text, /<div id="swagger-ui">/);
    assert.match(page.text, /swagger-ui-bundle\.js/);

    // The asset that the default CSP and a missing trailing slash both break, fetched the
    // way the page fetches it.
    const bundle = await server.get('/api/docs/swagger-ui-bundle.js');
    assert.equal(bundle.status, 200);
  });

  test('relaxes the script CSP for this subtree only', async () => {
    // Swagger UI bootstraps from an inline script; helmet's default script-src is 'self'
    // with no 'unsafe-inline', under which the page loads and then does nothing at all.
    const docs = await server.get('/api/docs/');
    assert.match(docs.headers.get('content-security-policy'), /script-src[^;]*'unsafe-inline'/);
    // Still helmet, not helmet switched off.
    assert.equal(docs.headers.get('x-content-type-options'), 'nosniff');

    // And the relaxation did not leak onto the rest of the API.
    const root = await server.get('/');
    assert.doesNotMatch(
      root.headers.get('content-security-policy'),
      /script-src[^;]*'unsafe-inline'/,
    );
  });
});

// The reason src/swagger.js is a module and not a pile of JSDoc comments: a hand-written
// document drifts, and this is the check that makes the drift a test failure instead of a
// surprise for whoever is writing the frontend.
describe('the OpenAPI document covers what is mounted', () => {
  const document = buildOpenApiDocument();

  // Walk the routers the app actually mounts and rebuild the URL Express serves each route
  // at, in OpenAPI's notation: Express writes a parameter as :id, OpenAPI as {id}.
  const mounted = [];
  for (const [name, router] of Object.entries(ROUTERS)) {
    // The docs router describes every other route; describing itself as well would be
    // noise in the page for no reader's benefit.
    if (name === 'docs') continue;

    for (const layer of router.stack) {
      if (!layer.route) continue;

      const suffix = layer.route.path === '/' ? '' : layer.route.path;
      const path = `/api/${name}${suffix}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

      for (const method of Object.keys(layer.route.methods)) {
        mounted.push({ method, path });
      }
    }
  }

  test('finds routes to check', () => {
    // Guards the two loops above: if Express changes its internals, every case below would
    // pass vacuously on an empty list.
    assert.ok(mounted.length >= 6, `only found ${mounted.length} mounted routes`);
  });

  for (const { method, path } of mounted) {
    test(`${method.toUpperCase()} ${path} is documented`, () => {
      const item = document.paths[path];
      assert.ok(item, `${path} is mounted but missing from src/swagger.js`);
      assert.ok(item[method], `${method.toUpperCase()} ${path} is mounted but not documented`);
    });
  }

  test('documents nothing that is not mounted', () => {
    // '/' is on the app rather than in ROUTERS, so it is the one legitimate entry the walk
    // above cannot see.
    const served = new Set([...mounted.map((r) => `${r.method} ${r.path}`), 'get /']);

    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of Object.keys(item)) {
        assert.ok(
          served.has(`${method} ${path}`),
          `${method.toUpperCase()} ${path} is documented but no router serves it`,
        );
      }
    }
  });

  test('every $ref resolves', () => {
    // A typo in a $ref is not a parse error: Swagger UI renders the operation with an
    // empty schema and says nothing, which is worse than a broken page.
    const refs = new Set();
    (function collect(node) {
      if (Array.isArray(node)) return node.forEach(collect);
      if (!node || typeof node !== 'object') return;

      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.add(value);
        else collect(value);
      }
    })(document);

    for (const ref of refs) {
      const target = ref
        .replace(/^#\//, '')
        .split('/')
        .reduce((node, segment) => node?.[segment], document);

      assert.ok(target, `${ref} does not resolve`);
    }
  });

  test('every operation states its authentication', () => {
    // The document-level `security` locks everything by default, so a public route has to
    // say `security: []`. That is deliberate -- the failure mode of the opposite default
    // is a guarded route documented as public, which a frontend then calls without a token.
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        assert.ok(
          Array.isArray(operation.security) || document.security,
          `${method.toUpperCase()} ${path} does not say whether it needs a token`,
        );
        assert.ok(operation.summary, `${method.toUpperCase()} ${path} has no summary`);
      }
    }
  });
});
