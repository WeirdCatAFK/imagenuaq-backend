// The domain event dispatcher.
//
// Orchestration announces what happened; whoever cares subscribes. Today the only
// subscriber is the audit trail (access/orchestration/audit.js, RF-USR-07), but this is a
// dispatcher rather than an `audit.write()` call because it is already known who
// subscribes next: RF-EST-03/RF-EST-06 need a notification when a project sits too long in
// one status, and RF-FLW-04 needs the receiving area told when an approval unlocks the
// next stage. Both fire on exactly the events written here.
//
// **Not** node:events. EventEmitter is the obvious choice and it is wrong twice:
//
//   - `emit()` is synchronous and ignores what a listener returns, so an async listener
//     that rejects becomes an unhandled rejection -- a process-level crash in Node 20.
//   - `emit()` returns before an async listener has done anything, so nothing can wait for
//     the audit row and no test can assert it exists without polling.
//
// So: `emit()` is awaited, listeners run in sequence, and a listener that throws is
// contained here. The cost, stated plainly: a write can succeed while its audit row does
// not, and nothing reconciles them. Acceptable while the audited tables are users, areas
// and roles; NOT obviously acceptable for FIN, where the shape that cannot lose a row is a
// data-modifying CTE writing `logs` in the same statement as the change.
/** Reports a subscriber failure to stderr with the event that caused it. */
function report(name, event, err) {
  console.error(
    `Event subscriber "${name}" failed for ${event?.action ?? "an event"}:`,
    err,
  );
  console.error("  event was:", JSON.stringify(event));
}

class Dispatcher {
  #subscribers = new Map();

  /**
   * Registers a subscriber. Idempotent on `name`: registering again replaces.
   *
   * @param {string} name
   * @param {(event: object) => unknown} handler
   */
  on(name, handler) {
    this.#subscribers.set(name, handler);
  }

  /** @param {string} name */
  off(name) {
    this.#subscribers.delete(name);
  }

  /**
   * Delivers `event` to every subscriber in registration order, awaiting each. A
   * subscriber that throws is logged and skipped; it never fails the caller.
   *
   * @param {object} event
   */
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

export default new Dispatcher();
