import { Router } from "express";

import microsoft from "../access/orchestration/microsoft.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

/** Where the browser is sent once Microsoft has sent it back here. Same fallback as auth.js. */
const frontend = () =>
  (process.env.FRONTEND_DOMAIN || "http://localhost:5173").replace(/\/+$/, "");

// GET /api/microsoft/callback -- where Microsoft redirects the browser after sign-in.
//
// Public, and declared before authenticate() for the same reason POST /api/auth/activate
// is: the caller is a browser arriving from another site with no bearer header, and the
// credential is in the query -- the `state` this API minted for one user ten minutes ago.
//
// The one route in the codebase that catches. The response is a redirect either way,
// because the thing on the other end is a browser mid-navigation and a JSON error would be
// rendered as text on a blank page. Only ApiError is caught -- a deliberate refusal becomes
// ?microsoft=error -- and anything else still reaches errorHandler as the bug it is.
router.get("/callback", async (req, res) => {
  const { code, state, error, error_description: description } = req.query;

  if (error) {
    return res.redirect(errorUrl(String(error), description));
  }

  try {
    await microsoft.completeConnect({ code, state });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return res.redirect(errorUrl(err.statusCode === 401 ? "state" : "exchange", err.message));
  }

  res.redirect(`${frontend()}/?microsoft=connected`);
});

function errorUrl(reason, description) {
  const params = new URLSearchParams({ microsoft: "error", reason });
  if (description) params.set("description", String(description));
  return `${frontend()}/?${params}`;
}

router.use(authenticate);

// --- Reads: spreadsheet.read ---
//
// This router and routes/spreadsheets.js are one feature -- the accounts exist only to read
// the books -- so they share one read code and one write code rather than growing a second
// pair nobody would grant separately.
router.use(requirePermission("spreadsheet.read"));

// GET /api/microsoft/accounts -- the caller's connected accounts; every account for admin.
router.get("/accounts", async (req, res) => {
  res.json({ accounts: await microsoft.listAccounts(req.user) });
});

// --- Writes: spreadsheet.write ---
router.use(requirePermission("spreadsheet.write"));

// POST /api/microsoft/connect -- start a sign-in. Returns the URL to send the browser to;
// POST because it mints a state token for this user, which is a thing done, not fetched.
router.post("/connect", async (req, res) => {
  res.json(await microsoft.connectUrl(req.user.id));
});

// DELETE /api/microsoft/accounts/:id -- withdraw the grant. The row stays, revoked.
router.delete("/accounts/:id", async (req, res) => {
  res.json({ account: await microsoft.revoke(paramId(req), req.user) });
});

function paramId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest("Invalid account id.");
  }
  return id;
}

export default router;
