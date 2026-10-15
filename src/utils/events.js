// A small event dispatcher. emit() is awaited and runs listeners in order; a failing listener is
// logged, not thrown, so a change can succeed while its audit row is lost. Not node:events,
// which cannot wait for async listeners.

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
