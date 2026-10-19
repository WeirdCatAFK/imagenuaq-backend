import query from '../resources/query.js';
import { ping as pingStorage } from '../primitives/minioStorage.js';

/**
 * Times one probe and reports it the same way for every dependency.
 *
 * @returns {Promise<{reachable: boolean, latencyMs?: number, error?: string}>}
 */
async function probe(fn) {
  const startedAt = Date.now();
  try {
    await fn();
    return { reachable: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { reachable: false, error: err.message || err.code || err.name };
  }
}

class Health {
  async check() {
    const [database, storage] = await Promise.all([probe(() => query.ping()), probe(pingStorage)]);
    return {
      status: database.reachable && storage.reachable ? 'ok' : 'degraded',
      database,
      storage,
      uptime: process.uptime(),
    };
  }
}

export default new Health();
