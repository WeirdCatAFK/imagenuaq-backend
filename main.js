// Entry point: opens the database pool and the file store, starts the API and the daily file
// expiry sweep, and closes them all on shutdown. Settings come from .env through the
// --env-file flag in the npm scripts.
import Api from './src/api.js';
import { openStore, closeStore } from './src/access/primitives/database.js';
import { openStorage, closeStorage } from './src/access/primitives/minioStorage.js';
import documents from './src/access/orchestration/documents.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Expires files past retention now and then once a day (RF-ARC-01). A failed sweep is logged
 * and retried the next day.
 * shortcut: an in-process timer, so it runs once per API instance; move it to I6's scheduler.
 *
 * @returns {NodeJS.Timeout}
 */
function startRetentionSweep() {
  const sweep = () =>
    documents.expire().then(
      ({ expired, reclaimed }) => {
        if (expired > 0) console.log(`Expired ${expired} file(s), reclaimed ${reclaimed} object(s).`);
      },
      (err) => console.error('File expiry sweep failed:', err),
    );
  sweep();
  return setInterval(sweep, DAY_MS);
}

openStore();
await openStorage();

const api = new Api();
await api.start();
const sweepTimer = startRetentionSweep();

const shutdown = (signal) => async () => {
  console.log(`${signal} received, shutting down.`);
  clearInterval(sweepTimer);
  await api.stop();
  await closeStore();
  closeStorage();
  process.exit(0);
};

process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
