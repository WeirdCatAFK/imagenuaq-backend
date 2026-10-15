// Serves the API description from src/swagger.js, as JSON and as Swagger UI. On in production
// on purpose; to turn it off, remove the `docs` entry from ROUTERS.
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
