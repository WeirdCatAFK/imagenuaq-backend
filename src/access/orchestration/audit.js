// Tier 3: the audit trail. RF-USR-07 asks for a record of who created, modified or deleted
// each relevant record, and this is the only thing that writes `logs`.
//
// It is a *subscriber*, not a function the rest of the code calls. Orchestration announces
// what it did through utils/events.js and this turns the announcement into a row. The reason
// for the indirection is not decoupling for its own sake: an `audit.record()` call in the
// middle of Areas.update() reads as part of the business rule and gets deleted by whoever
// simplifies that method later, whereas the event is the method saying what it did, which is
// worth keeping whether or not anybody is listening. RF-EST-03 and RF-FLW-04 are the next
// two listeners.
//
// The actor is not an argument. It comes from utils/context.js, seeded per request by
// middlewares/context.js, so that orchestration never has to know an HTTP request exists --
// see that file for the alternatives that were rejected.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";

// Never written to `logs`, whatever table the row came from.
//
// `before_data` and `after_data` are whole rows, and a `users` row carries `password_hash`.
// Copying it into the trail would take a value that lives in one guarded column and scatter
// it across a table meant to be *read* -- by coordination, and by the bitácora screen
// RF-USR-07 implies. A bcrypt digest is not a password, but it is the input to an offline
// attack, and an audit trail is the last place that should be widening its blast radius.
//
// A pattern rather than a list, because the list is the wrong shape for a schema that is a
// third built: `access_tokens` already holds token digests, FIN will hold nothing secret but
// INV's shared licences (RF-INV-07) plausibly will. A new table with a secret column is
// redacted by default and somebody has to opt it *out*, which is the safe direction.
const REDACT = /password|secret|token|hash|salt/i;

// Rows come out of postgrejs as plain objects of column values. Redaction is one level deep
// because that is how deep a row goes -- a jsonb column would nest, and none of the audited
// tables has one today. When one does (requests.data, RF-SOL-06), this needs to recurse.
function redact(row) {
  if (row === null || row === undefined) return null;

  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    clean[key] = REDACT.test(key) ? "[redacted]" : value;
  }
  return clean;
}

class Audit {
  // Resolved once and kept. The catalogue is thirteen rows written by a migration and can
  // only change by another one, so re-reading it per logged action would buy nothing and
  // cost a round trip on every write in the system.
  //
  // Cached as the *promise*, not the result: two events arriving before the first read
  // resolves would otherwise both issue the query. Awaiting the same promise twice is free.
  //
  // The annotation is for the editor rather than for the reader -- inference sees only the
  // `null` initialiser and then reports the `await` below as pointless, which is exactly
  // backwards.
  /** @type {Promise<Map<string, number>> | null} */
  #actions = null;

  async #actionIds() {
    this.#actions ??= query
      .getActions()
      .then((rows) => new Map(rows.map((row) => [row.code, row.id])));

    const pending = this.#actions;
    try {
      return await pending;
    } catch (err) {
      // Do not cache a failure. Without this the field keeps a rejected promise for the
      // lifetime of the process, so one unlucky read at start-up turns off the audit trail
      // until somebody restarts the server -- silently, because the dispatcher swallows
      // subscriber errors by design.
      this.#actions = null;
      throw err;
    }
  }

  // Wire the subscriber up. Called once from api.js; the dispatcher keys subscribers by
  // name, so calling it again replaces rather than duplicates.
  subscribe() {
    events.on("audit", (event) => this.record(event));
  }

  // Turn one domain event into one row.
  //
  // Throws on an unknown action code rather than skipping the row. That is a bug in the emit
  // call -- the catalogue is closed, seeded by catalog-bootstrap -- and the dispatcher
  // reports it with the event attached, which is what makes it findable. Silently writing
  // nothing would leave a hole in the trail that only shows up when somebody asks who
  // deleted the invoice.
  async record({ action, target = null, before = null, after = null, actor }) {
    const actions = await this.#actionIds();
    const actionId = actions.get(action);
    if (actionId === undefined) {
      throw new Error(
        `Unknown action code "${action}". The catalogue is seeded by ` +
          "migrations/1788794776184_catalog-bootstrap.sql; add the code there first.",
      );
    }

    // `actor` is an explicit override, and `undefined` means "not given" -- distinct from
    // an explicit null. Login needs the override: it is the one action whose actor is
    // established BY the action, so at the moment it is emitted there is no session yet
    // and the request context is still empty.
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

  // One row of the trail as the API shape. Both reads go through it, so the two cannot
  // drift into describing the same row differently.
  #shape(row) {
    return {
      id: row.id,
      action: row.action_code,
      actor:
        row.user_id === null
          ? null
          : { id: row.user_id, fullName: row.user_full_name },
      // Recorded on the row, not looked up now: this is the area the actor belonged to when
      // it happened. See the log-area migration for why deriving it at read time would make
      // every past action follow a person between areas.
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

  // The trail for one object, for the bitácora screen RF-USR-07 implies. Read-side only;
  // nothing here writes.
  async forTarget(targetTable, targetId, limit = 100) {
    const rows = await query.getLogsForTarget(targetTable, targetId, limit);
    return rows.map((row) => this.#shape(row));
  }

  // What one or more areas did, newest first -- the read RF-USR-04 is written in. Takes a
  // list rather than a single id because "everyone a él a su cargo" is a subtree of the
  // organisation chart, and the caller resolves that through Areas.getOrgChart() before
  // asking here.
  async forAreas(areaIds, limit = 100) {
    const rows = await query.getLogsForAreas(areaIds, limit);
    return rows.map((row) => this.#shape(row));
  }
}

export default new Audit();
