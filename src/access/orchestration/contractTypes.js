// Lists the contract types. Read-only on purpose: they are terms of employment (RF-AUS-02),
// so a new one is added by migration, where it gets reviewed.
import query from "../resources/query.js";

class ContractTypes {
  /**
   * Every contract scheme, ordered by name.
   *
   * @returns {Promise<Array<{ id: number, name: string }>>}
   */
  async get() {
    return (await query.getContractTypes()).map(shapeContractType);
  }
}

function shapeContractType(row) {
  return { id: row.id, name: row.name };
}

export default new ContractTypes();
