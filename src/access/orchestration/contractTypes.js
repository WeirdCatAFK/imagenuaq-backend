// Tier 3: the contract-scheme catalogue.
//
// One read, and that is the whole module. It exists because `users.contract_type_id` is
// NOT NULL, so every account creation has to name a scheme -- and without this the only way
// for a form to offer them was to hard-code four ids, which are an accident of the sequence
// and differ on every database.
//
// Read-only on purpose, and the reason is RF-AUS-02/RF-AUS-04 rather than laziness. These
// rows are the university's conditions of employment (honorarios, eventual, base de
// confianza, base sindicalizada, plus becario), not settings coordination adjusts: adding
// one is a decision about how somebody is employed, and it arrives through a migration
// where it is reviewed. The surface that genuinely is configuration is
// `contract_type_entitlements` -- how many days each scheme grants, versioned per validity
// period so a collective-contract change cannot rewrite consumed history -- and that is
// AUS work with its own endpoints, not a POST bolted onto this list.
//
// Readable by any signed-in user for the same reason the role catalogue is: a form that
// assigns a scheme has to list them, and there is nothing private in a name.
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
