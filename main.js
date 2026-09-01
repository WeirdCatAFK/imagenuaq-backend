// Entry point. Opens the pool, starts the API, closes both on a signal.
// Environment comes from .env via the --env-file flag in the npm scripts.
import Api from './src/api.js';
import { openStore, closeStore } from './src/access/primitives/database.js';

openStore();

const api = new Api();
await api.start();

const shutdown = (signal) => async () => {
  console.log(`${signal} received, shutting down.`);
  await api.stop();
  await closeStore();
  process.exit(0);
};

process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
