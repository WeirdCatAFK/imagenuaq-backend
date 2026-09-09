// Seeds the per-request context that utils/context.js hands to anything downstream.
//
// Mounted BEFORE the routers. `req.user` is filled in later, by authenticate(), so the
// context holds a getter rather than a copy of a value that does not exist yet: by the
// time an orchestration method emits an event, authenticate() has run and written it.
//
// That indirection is the whole trick. Reading `req.user` here would capture undefined
// forever, and moving this middleware after authenticate() would leave the public routes
// -- login, activate -- with no context at all, which is exactly where the user_login and
// user_login_failed rows come from.
import { randomUUID } from "node:crypto";

import { runWithContext } from "../utils/context.js";

/**
 * Express middleware. Mount before the routers; `actor` is a getter because
 * authenticate() assigns `req.user` after this runs.
 */
export const requestContext = (req, _res, next) => {
  const context = {
    requestId: randomUUID(),
    get actor() {
      return req.user ?? null;
    },
  };

  // next() runs inside the store so the rest of the chain inherits it.
  runWithContext(context, next);
};
