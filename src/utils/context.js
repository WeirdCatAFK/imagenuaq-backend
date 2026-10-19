// Per-request context (who is acting) on Node's AsyncLocalStorage, so the audit trail knows the
// user without it being passed through every function. Outside a request it returns null.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with `context` attached; everything `fn` awaits sees it.
 *
 * @param {{ actor: object | null }} context
 * @param {() => unknown} fn
 */
export function runWithContext(context, fn) {
  return storage.run(context, fn);
}

/**
 * The signed-in user behind the current request, or null outside one. The whole
 * `req.user`, not just its id.
 *
 * @returns {object | null}
 */
export function currentActor() {
  return storage.getStore()?.actor ?? null;
}
