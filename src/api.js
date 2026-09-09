// Mounts the API. Separate from main.js so it can be started on its own, embedded in a
// larger backend, or built by a test that never binds a port.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRouter from './routes/health.js';
import spreadsheetsRouter from './routes/spreadsheets.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import areasRouter from './routes/areas.js';
import rolesRouter from './routes/roles.js';
import docsRouter from './routes/docs.js';
import { requestContext } from './middlewares/context.js';
import { notFound } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';
import audit from './access/orchestration/audit.js';

// Every router, keyed by its mount name under /api/. A map rather than one app.use line
// each, so the URL comes from a single place.
export const ROUTERS = {
  health: healthRouter,
  spreadsheets: spreadsheetsRouter,
  auth: authRouter,
  users: usersRouter,
  areas: areasRouter,
  roles: rolesRouter,
  // Swagger UI and the raw document, at /api/docs and /api/docs/openapi.json. It belongs
  // in this map rather than beside the `/` handler below because it is mounted the same
  // way everything else is; the only thing unusual about it is that it serves no data.
  docs: docsRouter,
};

export default class Api {
  // Options fall back to the environment, so main.js constructs this with nothing and a
  // test can override one field without touching process.env.
  constructor(options = {}) {
    this.app = express();
    // `??`, not `||`: port 0 means "let the OS pick a free one", a real value for tests.
    this.port = options.port ?? Number(process.env.PORT ?? 3000);
    this.host = options.host || process.env.HOST || 'localhost';
    this.logFormat = options.logFormat || process.env.LOG_FORMAT || 'dev';
    this.corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? '*';
    this.server = null;

    this.build();
  }

  build() {
    // The audit trail listens for domain events (RF-USR-07). Subscribed here rather than as
    // an import side effect so that building an Api is what turns it on, and a tool that
    // imports orchestration without serving HTTP -- scripts/createAdmin.js -- does not
    // quietly acquire a listener. The dispatcher keys subscribers by name, so a second Api
    // in the same process replaces this one instead of logging everything twice.
    audit.subscribe();

    this.app.use(helmet());
    this.app.use(cors({ origin: this.corsOrigin }));
    this.app.use(morgan(this.logFormat));
    this.app.use(express.json());

    // Before the routers, so every handler runs inside a request context, and before
    // authenticate(), so the public routes have one too -- user_login_failed is emitted
    // from a request that by definition has no session. See middlewares/context.js.
    this.app.use(requestContext);

    this.app.get('/', (_req, res) => res.json({ name: 'imagenuaq-api', status: 'up' }));

    for (const [name, router] of Object.entries(ROUTERS)) {
      this.app.use(`/api/${name}`, router);
    }

    this.app.use(notFound);
    this.app.use(errorHandler);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, this.host);
      this.server.once('listening', () => {
        // Re-read it: with port 0 the bound port is not the requested one.
        this.port = this.server.address().port;
        console.log(`API listening on http://${this.host}:${this.port}`);
        resolve(this.server);
      });
      this.server.once('error', reject);
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}
