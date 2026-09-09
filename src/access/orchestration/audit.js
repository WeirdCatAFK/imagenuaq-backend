// Tier 3: the audit trail (RF-USR-07).
//
// A *subscriber*, not a function the rest of the code calls. Orchestration announces what
// it did through utils/events.js and this turns the announcement into a row in `logs` --
// the only module that writes that table. The indirection is not decoupling for its own
// sake: an `audit.record()` call in the middle of Areas.update() reads as part of the
// business rule and gets deleted by whoever simplifies that method later, whereas the
// event is the method saying what it did, worth keeping whether or not anybody listens.
//
// The actor is not an argument. It comes from utils/context.js, seeded per request by
// middlewares/context.js, so orchestration never learns that HTTP exists.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";

/** Column names whose values are replaced before they reach `logs`. */
const REDACT = /password|secret|token|hash|salt/i;

/**
 * Copies a row with secret-looking columns blanked. One level deep; a jsonb column
 * would need recursion.
 *
 * @param {object | null | undefined} row
 * @returns {object | null}
 */
function redact(row) {
  if (row === null || row === undefined) return null;

  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    clean[key] = REDACT.test(key) ? "[redacted]" : value;
  }
  return clean;
}

class Audit {
  /**
   * The action catalogue, cached as the promise so concurrent readers share one query.
   *
   * @type {Promise<Map<string, number>> | null}
   */
  #actions = null;

  /** @returns {Promise<Map<string, number>>} action code to id */
  async #actionIds() {
    this.#actions ??= query
      .getActions()
      .then((rows) => new Map(rows.map((row) => [row.code, row.id])));

    const pending = this.#actions;
    try {
      return await pending;
    } catch (err) {
      // Drop a rejected promise so a failed read at start-up is retried.
      this.#actions = null;
      throw err;
    }
  }

  /** Registers this as the `audit` subscriber. Called once from api.js. */
  subscribe() {
    events.on("audit", (event) => this.record(event));
  }

  /**
   * Writes one event as one row of the trail.
   *
   * @param {object} event
   * @param {string} event.action Code from the `actions` catalogue.
   * @param {{ table: string, id: number } | null} [event.target]
   * @param {object | null} [event.before] Row before the change.
   * @param {object | null} [event.after] Row after the change.
   * @param {object | number | null} [event.actor] Overrides the request context; login
   *   needs it, since its actor is established by the action itself.
   * @throws {Error} If `action` is not in the catalogue.
   */
  async record({ action, target = null, before = null, after = null, actor }) {
    const actions = await this.#actionIds();
    const actionId = actions.get(action);
    if (actionId === undefined) {
      throw new Error(
        `Unknown action code "${action}". The catalogue is seeded by ` +
          "migrations/1788794776184_catalog-bootstrap.sql; add the code there first.",
      );
    }

    const userId =
      actor === undefined ? (currentActor()?.id ?? null) : (actor?.id ?? actor ?? null);

    await query.insertLog({
      userId,
      actionId,
      targetTable: target?.table ?? null,
      targetId: target?.id ?? null,
      beforeData: redact(before),
      afterData: redact(after),
    });
  }

  /** Maps one `logs` row to the API shape. */
  #shape(row) {
    return {
      id: row.id,
      action: row.action_code,
      actor:
        row.user_id === null
          ? null
          : { id: row.user_id, fullName: row.user_full_name },
      // The area recorded on the row: where the actor was then, not now.
      area:
        row.area_id === null ? null : { id: row.area_id, name: row.area_name },
      target:
        row.target_table === null
          ? null
          : { table: row.target_table, id: row.target_id },
      before: row.before_data,
      after: row.after_data,
      at: row.created_at,
    };
  }

  /**
   * The trail for one object, newest first.
   *
   * @param {string} targetTable
   * @param {number} targetId
   * @param {number} [limit]
   */
  async forTarget(targetTable, targetId, limit = 100) {
    const rows = await query.getLogsForTarget(targetTable, targetId, limit);
    return rows.map((row) => this.#shape(row));
  }

  /**
   * The trail for one or more areas, newest first. Takes a list because RF-USR-04 asks
   * for a subtree of the organisation chart, which the caller resolves first.
   *
   * @param {number[]} areaIds
   * @param {number} [limit]
   */
  async forAreas(areaIds, limit = 100) {
    const rows = await query.getLogsForAreas(areaIds, limit);
    return rows.map((row) => this.#shape(row));
  }
}

export default new Audit();
