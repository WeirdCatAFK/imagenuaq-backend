// Entry point. Opens the pool and the file store, starts the API, closes all three on a
// signal. Environment comes from .env via the --env-file flag in the npm scripts.
import Api from './src/api.js';
import { openStore, closeStore } from './src/access/primitives/database.js';
import { openStorage, closeStorage } from './src/access/primitives/minioStorage.js';

openStore();
await openStorage();

const api = new Api();
await api.start();

const shutdown = (signal) => async () => {
  console.log(`${signal} received, shutting down.`);
  await api.stop();
  await closeStore();
  closeStorage();
  process.exit(0);
};

process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
