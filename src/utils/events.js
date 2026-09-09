// The domain event dispatcher.
//
// Orchestration announces what happened; whoever cares subscribes. Today the only subscriber
// is the audit trail (access/orchestration/audit.js, RF-USR-07), but the reason this is a
// dispatcher and not an `audit.write()` call is that it is already known who subscribes
// next: RF-EST-03/RF-EST-06 need a notification when a project sits too long in one status,
// and RF-FLW-04 needs the receiving area told when an approval unlocks the next stage. Those
// fire on exactly the events written here. A direct call would have each of them re-derive
// the same facts from inside the same methods.
//
// **Not** node:events. EventEmitter is the obvious choice and it is wrong for this, twice:
//
//   - `emit()` is synchronous and ignores what a listener returns. An async listener that
//     rejects becomes an unhandled rejection -- which in Node 20 is a process-level crash by
//     default, so a bad audit write would take the API down rather than be reported.
//   - `emit()` returns before an async listener has done anything, so nothing can wait for
//     the audit row. A test could not assert the row exists without polling, and a request
//     could finish before its own trail was written.
//
// So: `emit()` is awaited, listeners run in sequence, and a listener that throws is
// contained here rather than escaping into the caller's request.

// An audit failure must not turn a successful change into a 500. If Postgres is unreachable
// the change being recorded failed too and the caller already has an error; the failure mode
// unique to this path is a bad action code or a malformed payload, which is a bug in the
// emit call. Bugs are logged in full and swallowed, exactly as middlewares/errorHandler.js
// treats a non-ApiError.
//
// The cost, stated plainly because it is the one thing to remember: a write can succeed
// while its audit row does not, and nothing reconciles them. That is acceptable while the
// audited tables are users, areas and roles. It is NOT obviously acceptable for FIN
// (RF-FIN-*), whose records need an audit trail with integrity -- when that module lands,
// the shape that cannot lose a row is a data-modifying CTE writing `logs` in the same
// statement as the change, the way createUser() already writes `area_members`.
function report(name, event, err) {
  console.error(
    `Event subscriber "${name}" failed for ${event?.action ?? "an event"}:`,
    err,
  );
  console.error("  event was:", JSON.stringify(event));
}

class Dispatcher {
  #subscribers = new Map();

  // Named, and idempotent on that name. `api.js` subscribes when it builds the app, and a
  // test file that constructs a second Api in the same process would otherwise register the
  // audit writer twice and log every action twice -- a duplicate that is invisible until
  // somebody reads the trail.
  on(name, handler) {
    this.#subscribers.set(name, handler);
  }

  off(name) {
    this.#subscribers.delete(name);
  }

  // Sequential, not Promise.all. Subscribers are few and the ordering is worth more than the
  // concurrency: when the notification subscriber of RF-EST-06 arrives it will want the
  // audit row already written, so that a notification can cite it.
  async emit(event) {
    for (const [name, handler] of this.#subscribers) {
      try {
        await handler(event);
      } catch (err) {
        report(name, event, err);
      }
    }
  }
}

// A singleton instance, not the class -- the same shape as query.js and health.js.
export default new Dispatcher();
