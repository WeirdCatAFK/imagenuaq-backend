// Seeds the per-request context that utils/context.js hands to anything downstream.
//
// Mounted BEFORE the routers and AFTER nothing in particular -- it needs no body and no
// session of its own. `req.user` is filled in later, by authenticate(), so the context holds
// a mutable object rather than a copy of a value that does not exist yet: by the time an
// orchestration method emits an event, authenticate() has run and written into it.
//
// That indirection is the whole trick. Reading `req.user` at this point would capture
// undefined forever, and moving this middleware after authenticate() would mean the public
// routes -- login, activate -- run with no context at all, which is exactly where the
// user_login and user_login_failed rows come from.
import { randomUUID } from "node:crypto";

import { runWithContext } from "../utils/context.js";

export const requestContext = (req, _res, next) => {
  const context = {
    requestId: randomUUID(),
    // A getter, not a value: authenticate() assigns req.user after this runs.
    get actor() {
      return req.user ?? null;
    },
  };

  // next() is called INSIDE run(), so the rest of the chain -- and everything it awaits --
  // executes within the store. Calling it outside would attach the context to nothing.
  runWithContext(context, next);
};
