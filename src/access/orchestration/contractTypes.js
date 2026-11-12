// The contract types (RF-AUS-02). No migration seeds them: coordination enters its schemes from
// the app, and a fresh install gets its first one from scripts/createAdmin.js.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";
import { UNIQUE_VIOLATION, requireText } from "../../utils/validate.js";

const NAME_MAX = 200;

class ContractTypes {
  /**
   * Every contract scheme, ordered by name.
   *
   * @returns {Promise<Array<{ id: number, name: string }>>}
   */
  async get() {
    return (await query.getContractTypes()).map(shapeContractType);
  }

  /**
   * Adds a scheme. Its caps are entitlement rows, set afterwards (RF-AUS-04).
   *
   * @param {{ name?: unknown }} input
   * @returns {Promise<{ id: number, name: string }>}
   * @throws {ApiError} 400 on a missing or long name, 409 on a taken one.
   */
  async create({ name } = {}) {
    const cleanName = requireText(name, "name", NAME_MAX);
    try {
      const row = await query.createContractType(cleanName);
      await events.emit({
        action: "record_created",
        target: { table: "contract_types", id: row.id },
        after: row,
      });
      return shapeContractType(row);
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) {
        throw ApiError.conflict("A contract type with that name already exists.");
      }
      throw err;
    }
  }
}

function shapeContractType(row) {
  return { id: row.id, name: row.name };
}

export default new ContractTypes();
