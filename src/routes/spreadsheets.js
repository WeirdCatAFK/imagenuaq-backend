import { Router } from "express";

import spreadsheets from "../access/orchestration/spreadsheets.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

router.use(authenticate);

// --- Reads: spreadsheet.read ---
//
// Two blocks, as routes/areas.js lays out. The codes are shared with routes/microsoft.js:
// the accounts and the books they read are one feature (RF-MIG-01), granted together.
router.use(requirePermission("spreadsheet.read"));

router.get("/", async (_req, res) => {
  res.json({ sheets: await spreadsheets.list() });
});

// GET /api/spreadsheets/resolve?accountId=&url= -- what is behind a pasted link, as that
// account sees it: the drive/item ids to register plus the tables and worksheets inside.
// Declared before '/:id' so "resolve" is not parsed as one.
router.get("/resolve", async (req, res) => {
  const { accountId, url } = req.query;
  res.json(await spreadsheets.resolve({ accountId, url }, req.user));
});

router.get("/:id", async (req, res) => {
  res.json({ sheet: await spreadsheets.getById(sheetId(req)) });
});

// GET /api/spreadsheets/:id/preview -- the header row, read live from Microsoft 365.
router.get("/:id/preview", async (req, res) => {
  res.json(await spreadsheets.preview(sheetId(req), req.user));
});

// --- Writes: spreadsheet.write ---
router.use(requirePermission("spreadsheet.write"));

// POST /api/spreadsheets -- register a table under an account the caller may use. Takes
// the ids `resolve` returned; does not call Microsoft (see orchestration/spreadsheets.js).
router.post("/", async (req, res) => {
  const sheet = await spreadsheets.register(req.body ?? {}, req.user);
  res.status(201).json({ sheet });
});

router.delete("/:id", async (req, res) => {
  res.json({ sheet: await spreadsheets.remove(sheetId(req)) });
});

function sheetId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest("Invalid spreadsheet id.");
  }
  return id;
}

export default router;
