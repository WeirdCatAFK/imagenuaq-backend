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

/**
 * Built once, at mount time. The document does not depend on the request, and rebuilding
 * it per request would only re-read API_DOMAIN, which cannot change while the process runs.
 */
const openApiDocument = buildOpenApiDocument();

router.get('/', (req, res, next) => {
  const [path, queryString] = req.originalUrl.split('?');
  if (path.endsWith('/')) return next();

  res.redirect(301, `${path}/${queryString ? `?${queryString}` : ''}`);
});

router.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

/**
 * helmet() already ran on the whole app in api.js; running it again here overwrites the
 * headers it set for this subtree only, which is the point.
 */
const docsCsp = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
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
      docExpansion: 'list',
      persistAuthorization: true,
      operationsSorter: 'alpha',
      tagsSorter: 'alpha',
    },
  }),
);

export default router;
