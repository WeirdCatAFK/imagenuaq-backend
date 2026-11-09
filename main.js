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
