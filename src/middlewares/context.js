// Starts the per-request context that utils/context.js reads. Must run before the routers, and
// keeps a getter for `req.user` (set later by authenticate()), never a copy of it.
import { runWithContext } from "../utils/context.js";

/**
 * Express middleware. Mount before the routers; `actor` is a getter because
 * authenticate() assigns `req.user` after this runs.
 */
export const requestContext = (req, _res, next) => {
  const context = {
    get actor() {
      return req.user ?? null;
    },
  };

  runWithContext(context, next);
};
