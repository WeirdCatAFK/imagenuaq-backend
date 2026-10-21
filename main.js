// Entry point: opens the database pool and the file store, starts the API and the scheduled jobs
// (src/scheduler.js), and closes them all on shutdown. Settings come from .env through the
// --env-file flag in the npm scripts.
import Api from './src/api.js';
import { openStore, closeStore } from './src/access/primitives/database.js';
import { openStorage, closeStorage } from './src/access/primitives/minioStorage.js';
import * as scheduler from './src/scheduler.js';

openStore();
await openStorage();

const api = new Api();
await api.start();
scheduler.start();

const shutdown = (signal) => async () => {
  console.log(`${signal} received, shutting down.`);
  await scheduler.stop();
  await api.stop();
  await closeStore();
  closeStorage();
  process.exit(0);
};

process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
