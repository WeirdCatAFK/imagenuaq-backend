// Microsoft account connections (RF-MIG-01). `/callback` is public: the browser returns from
// Microsoft with no bearer header and the signed `state` as its credential. It is the one route
// that catches, turning an ApiError into a redirect, because the caller is mid-navigation.
import { Router } from "express";

import microsoft from "../access/orchestration/microsoft.js";
import { authenticate, requirePermission, requireRole } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";
import { idParam } from "../utils/params.js";

const router = Router();

/** Where the browser is sent once Microsoft has sent it back here. Same fallback as auth.js. */
const frontend = () =>
  (process.env.FRONTEND_DOMAIN || "http://localhost:5173").replace(/\/+$/, "");

router.get("/callback", async (req, res) => {
  const { code, state, error, error_description: description } = req.query;

  if (error) {
    return res.redirect(errorUrl(String(error), description));
  }

  try {
    await microsoft.completeConnect({ code, state });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return res.redirect(
      errorUrl(err.statusCode === 401 ? "state" : "exchange", err.message),
    );
  }

  res.redirect(`${frontend()}/?microsoft=connected`);
});

function errorUrl(reason, description) {
  const params = new URLSearchParams({ microsoft: "error", reason });
  if (description) params.set("description", String(description));
  return `${frontend()}/?${params}`;
}

router.use(authenticate);
router.use(requirePermission("spreadsheet.read"));

router.get("/accounts", async (req, res) => {
  res.json({ accounts: await microsoft.listAccounts(req.user) });
});

router.use(requirePermission("spreadsheet.write"));

router.post("/connect", async (req, res) => {
  res.json(await microsoft.connectUrl(req.user.id));
});

router.delete("/accounts/:id", async (req, res) => {
  res.json({ account: await microsoft.revoke(idParam(req, "id", "account id"), req.user) });
});

router.use(requireRole("admin"));

router.get("/app", async (_req, res) => {
  res.json({ app: await microsoft.getApp() });
});

router.put("/app", async (req, res) => {
  res.json({ app: await microsoft.setApp(req.body ?? {}, req.user) });
});

router.delete("/app", async (_req, res) => {
  res.json({ app: await microsoft.clearApp() });
});

export default router;
