// Per-request ambient state, on Node's AsyncLocalStorage.
//
// RF-USR-07 wants every relevant change attributed to whoever made it. The code that
// knows *what* changed is orchestration; the code that knows *who* is asking is the HTTP
// layer. Three ways to close that gap:
//
//   - Thread the actor through every orchestration signature. Honest, and it means
//     changing about thirty methods, every call site and every test so a bookkeeping
//     concern rides in the middle of the domain arguments. It also spreads: the day a
//     request id or a locale is wanted, every signature grows again.
//   - Emit the audit event from the routes, which already have `req.user`. But a route
//     does not know the row before the change, so `before_data` would be read twice --
//     and it puts a rule in the layer this codebase keeps to four lines.
//   - Keep the actor beside the request rather than inside the call. That is this file.
//
// AsyncLocalStorage is not a global: each request gets its own store and `await` carries
// it through, so two requests in flight never see each other's actor. Outside a request
// -- scripts/createAdmin.js, a background job later -- there is no store and the helpers
// return null. A change made by a script is genuinely unattributed, and `logs.user_id`
// is nullable to say so.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with `context` attached; everything `fn` awaits sees it.
 *
 * @param {{ requestId: string, actor: object | null }} context
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

/**
 * Id correlating everything logged while serving one request, or null outside one.
 *
 * @returns {string | null}
 */
export function currentRequestId() {
  return storage.getStore()?.requestId ?? null;
}
