// Serves the OpenAPI document from src/swagger.js: the raw JSON, and Swagger UI over it.
//
// A router in routes/ like any other, so it is mounted by the one line in the `ROUTERS`
// map that every other resource is mounted by, and the URL stays in a single place. It has
// no orchestration layer beneath it because it reads nothing -- the document is a
// constant, and there is no tier boundary to respect when there is no data.
//
// Left on in production deliberately. This is an internal system of dozens of users behind
// a tunnel, every route it describes already refuses unauthenticated callers on its own,
// and a spec that is only reachable in development is the one nobody remembers to update.
// If that ever needs to change, gate the ROUTERS entry, not this file.
import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import { buildOpenApiDocument } from '../swagger.js';

const router = Router();

// Built once, at mount time. The document does not depend on the request, and rebuilding
// it per request would only re-read API_DOMAIN, which cannot change while the process runs.
const openApiDocument = buildOpenApiDocument();

// Swagger UI's page pulls its bundle, its stylesheet and the generated swagger-ui-init.js
// from *relative* URLs (`./swagger-ui-bundle.js`). A browser at /api/docs -- no trailing
// slash -- resolves those against /api/, where nothing is served, and the page renders as
// an empty white frame with three 404s in the console. Express cannot tell the two apart
// inside a mounted router (req.url is '/' either way), so the check reads originalUrl.
//
// 301 rather than 302 because the correct URL will not change, and the query string is
// carried over because Swagger UI reads ?url= from it.
router.get('/', (req, res, next) => {
  const [path, queryString] = req.originalUrl.split('?');
  if (path.endsWith('/')) return next();

  res.redirect(301, `${path}/${queryString ? `?${queryString}` : ''}`);
});

// GET /api/docs/openapi.json -- the document itself, for a client generator, an import
// into Postman or Insomnia, or a diff in review. Ahead of the UI middleware because
// swagger-ui-express's asset handler is an express.static() that would answer first.
router.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

// helmet() already ran on the whole app in api.js; running it again here overwrites the
// headers it set for this subtree only, which is the point.
//
// The default policy is `script-src 'self'` with no `'unsafe-inline'`, and Swagger UI's
// page carries an inline bootstrap script plus inline `style` attributes it writes at
// runtime. Under the default policy the page loads and then does nothing, silently. Both
// relaxations are scoped to this path and to a document that is a constant compiled into
// the server -- there is no request data in it for an injection to arrive through.
//
// The rest of helmet's headers are re-applied unchanged by this second call rather than
// dropped, so /api/docs keeps nosniff, frame-ancestors and the rest.
const docsCsp = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      // Try it out issues fetches from the page. 'self' covers the relative server URL in
      // the document; a reader pointing the UI at a different host is out of scope.
      connectSrc: ["'self'"],
      // The default policy upgrades http:// subresources to https://, which breaks the
      // page when the API is reached over plain http on a LAN address rather than
      // localhost. null removes the directive instead of setting it empty.
      upgradeInsecureRequests: null,
    },
  },
});

router.use(
  docsCsp,
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    customSiteTitle: 'Imagen UAQ API',
    swaggerOptions: {
      // Collapsed by default: expanding every operation puts the reader in front of a page
      // of schemas before they have found the endpoint they came for.
      docExpansion: 'list',
      // Survives a reload, so an Authorize from ten minutes ago is still in place. Stored
      // in the browser's localStorage, which is why this is not on for a public API.
      persistAuthorization: true,
      // Sort by path rather than by definition order: the order in swagger.js is written
      // for a reader of the file, not for a reader of the page.
      operationsSorter: 'alpha',
      tagsSorter: 'alpha',
    },
  }),
);

export default router;
