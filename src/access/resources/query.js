import { getStore } from '../primitives/database.js';

class Query {
  async #rows(sql, params) {
    const result = await getStore().query(sql, { params, objectRows: true });
    return result.rows ?? [];
  }

  // --- Health ---

  async ping() {
    const [row] = await this.#rows('select 1 as ok');
    return row?.ok === 1;
  }

  async serverVersion() {
    const [row] = await this.#rows('select version() as version');
    return row?.version ?? null;
  }
}

export default new Query();
