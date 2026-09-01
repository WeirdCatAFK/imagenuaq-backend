// Mounts the API. Separate from main.js so it can be started on its own, embedded in a
// larger backend, or built by a test that never binds a port.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRouter from './routes/health.js';
import { notFound } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';

// Every router, keyed by its mount name under /api/. A map rather than one app.use line
// each, so the URL comes from a single place.
export const ROUTERS = {
  health: healthRouter,
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
    this.app.use(helmet());
    this.app.use(cors({ origin: this.corsOrigin }));
    this.app.use(morgan(this.logFormat));
    this.app.use(express.json());

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
