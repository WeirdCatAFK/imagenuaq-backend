import query from '../resources/query.js';

class Health {
  async check() {
    const startedAt = Date.now();

    try {
      await query.ping();
      return {
        status: 'ok',
        database: { reachable: true, latencyMs: Date.now() - startedAt },
        uptime: process.uptime(),
      };
    } catch (err) {
      return {
        status: 'degraded',
        database: { reachable: false, error: err.message || err.code || err.name },
        uptime: process.uptime(),
      };
    }
  }
}

export default new Health();
