// Mounts the API. Separate from main.js so it can be started on its own, embedded in a
// larger backend, or built by a test that never binds a port.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRouter from './routes/health.js';
import spreadsheetsRouter from './routes/spreadsheets.js';
import microsoftRouter from './routes/microsoft.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import areasRouter from './routes/areas.js';
import rolesRouter from './routes/roles.js';
import schemasRouter from './routes/schemas.js'
import dataTypesRouter from './routes/dataTypes.js';
import statusesRouter from './routes/statuses.js';
import requestersRouter from './routes/requesters.js';
import projectsRouter from './routes/projects.js';
import requestsRouter from './routes/requests.js';
import contractTypesRouter from './routes/contractTypes.js';
import docsRouter from './routes/docs.js';
import notificationsRouter from './routes/notifications.js';

import { requestContext } from './middlewares/context.js';
import { notFound } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';

import { createServer } from 'node:http';
import realtime from './realtime/socket.js';

import audit from './access/orchestration/audit.js';
import notifications from './access/orchestration/notifications.js';


// Every router, keyed by its mount name under /api/. A map rather than one app.use line
// each, so the URL comes from a single place.
export const ROUTERS = {
  health: healthRouter,
  spreadsheets: spreadsheetsRouter,
  microsoft: microsoftRouter,
  auth: authRouter,
  users: usersRouter,
  areas: areasRouter,
  roles: rolesRouter,
  schemas: schemasRouter,
  'data-types': dataTypesRouter,
  statuses: statusesRouter,
  requesters: requestersRouter,
  requests: requestsRouter,
  projects: projectsRouter,
  notifications: notificationsRouter,
  // Quoted because the key IS the URL segment: /api/contract-types, not /api/contractTypes.
  'contract-types': contractTypesRouter,
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
    // imports orchestration without serving HTTP does not quietly acquire a listener
    // (scripts/createAdmin.js subscribes itself, in the open, for the grants it restores).
    // The dispatcher keys subscribers by name, so a second Api
    // in the same process replaces this one instead of logging everything twice.
    audit.subscribe();

    //registra los eventos para la auditoría
    notifications.subscribe();

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
      this.server = createServer(this.app);

      realtime.start(this.server, this.corsOrigin);

      this.server.once('listening', () => {
        this.port = this.server.address().port;
        console.log(`API listening on http://${this.host}:${this.port}`);
        resolve(this.server);
      });

      this.server.once('error', reject);

      this.server.listen(this.port, this.host);
    });
  }

  async stop() {
    if (!this.server) return;

    const server = this.server;

    await realtime.stop();

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error);
        } else {
          resolve();
        }
      });
    });

    this.server = null;
  }
}
