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
// Las corridas de importación de un libro: los conteos y los renglones que no entraron.
router.get("/:id/imports", async (req, res) => {
  res.json({ imports: await spreadsheets.listImports(sheetId(req)) });
});

// Las primeras filas como las leería el mapeo, sin escribir nada. Es de lectura porque no
// escribe: el asistente la llama con un mapeo que todavía no se guarda.
router.post("/:id/mapping/preview", async (req, res) => {
  const { columnMap, schemaVersionId } = req.body ?? {};
  res.json(
    await spreadsheets.previewMapping(sheetId(req), { columnMap, schemaVersionId }, req.user),
  );
});

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

// El mapeo: a qué versión de formato apunta el libro y cómo sus columnas lo alimentan.
router.put("/:id/mapping", async (req, res) => {
  const { schemaVersionId, columnMap, headers } = req.body ?? {};
  res.json({
    sheet: await spreadsheets.setMapping(sheetId(req), { schemaVersionId, columnMap, headers }),
  });
});

router.delete("/:id/mapping", async (req, res) => {
  res.json({ sheet: await spreadsheets.clearMapping(sheetId(req)) });
});

// La importación crea solicitudes, así que pide también `request.write`.
router.post("/:id/import", requirePermission("request.write"), async (req, res) => {
  const { dryRun } = req.body ?? {};
  res.json(await spreadsheets.import(sheetId(req), { dryRun: dryRun === true }, req.user));
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
