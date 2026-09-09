// Per-request ambient state, on Node's AsyncLocalStorage.
//
// The problem this solves: RF-USR-07 wants every relevant change attributed to whoever made
// it, and the code that knows *what* changed is orchestration, while the code that knows
// *who* is asking is the HTTP layer. Three ways to close that gap:
//
//   - Thread the actor through every orchestration signature. Honest, and it would mean
//     changing about thirty methods, every call site and every test so that a bookkeeping
//     concern rides along in the middle of the domain arguments. It also spreads: the day a
//     request id or a locale is wanted, every signature grows again.
//   - Emit the audit event from the routes, which already have `req.user`. But a route does
//     not know the row before the change, so `before_data` would have to be read a second
//     time -- and it puts a rule in the layer this codebase deliberately keeps to four lines.
//   - Keep the actor beside the request rather than inside the call. That is this file.
//
// AsyncLocalStorage is not a global: each request gets its own store, and `await` carries it
// through, so two requests in flight never see each other's actor. Outside a request -- in
// scripts/createAdmin.js, or in a background job later -- there is simply no store, and the
// helpers return null rather than throwing. A change made by a script is genuinely
// unattributed, and `logs.user_id` is nullable to say so.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

// Run `fn` with a context attached. Everything `fn` awaits, however deep, sees it.
export function runWithContext(context, fn) {
  return storage.run(context, fn);
}

// The signed-in user behind the current request, or null.
//
// Deliberately the whole `req.user` and not just the id: a subscriber that wants to record
// the actor's role at the time of the action -- which is the interesting half of an audit
// trail, since roles are editable at runtime -- should not have to go back to the database
// for something the token already carried.
export function currentActor() {
  return storage.getStore()?.actor ?? null;
}

// Correlates several log rows written while serving one request. Not stored on `logs` today
// -- there is no column for it -- but it is what makes the stderr line from a failed audit
// write traceable back to the request that produced it.
export function currentRequestId() {
  return storage.getStore()?.requestId ?? null;
}
