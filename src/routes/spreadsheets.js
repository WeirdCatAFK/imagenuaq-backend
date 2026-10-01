// The registry of Excel trackers, their mapping and import (RF-MIG-01). Shares
// `spreadsheet.read`/`spreadsheet.write` with routes/microsoft.js: one feature, one grant.
import { Router } from "express";

import spreadsheets from "../access/orchestration/spreadsheets.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const sheetId = (req) => idParam(req, "id", "spreadsheet id");

router.use(authenticate);
router.use(requirePermission("spreadsheet.read"));

router.get("/", async (_req, res) => {
  res.json({ sheets: await spreadsheets.list() });
});

router.get("/resolve", async (req, res) => {
  const { accountId, url } = req.query;
  res.json(await spreadsheets.resolve({ accountId, url }, req.user));
});

router.get("/:id", async (req, res) => {
  res.json({ sheet: await spreadsheets.getById(sheetId(req)) });
});

router.get("/:id/imports", async (req, res) => {
  res.json({ imports: await spreadsheets.listImports(sheetId(req)) });
});

router.post("/:id/mapping/preview", async (req, res) => {
  const { columnMap, schemaVersionId } = req.body ?? {};
  res.json(
    await spreadsheets.previewMapping(sheetId(req), { columnMap, schemaVersionId }, req.user),
  );
});

router.get("/:id/preview", async (req, res) => {
  res.json(await spreadsheets.preview(sheetId(req), req.user));
});

router.use(requirePermission("spreadsheet.write"));

router.post("/", async (req, res) => {
  const sheet = await spreadsheets.register(req.body ?? {}, req.user);
  res.status(201).json({ sheet });
});

router.put("/:id/mapping", async (req, res) => {
  const { schemaVersionId, columnMap, headers } = req.body ?? {};
  res.json({
    sheet: await spreadsheets.setMapping(sheetId(req), { schemaVersionId, columnMap, headers }),
  });
});

router.delete("/:id/mapping", async (req, res) => {
  res.json({ sheet: await spreadsheets.clearMapping(sheetId(req)) });
});

router.post("/:id/import", requirePermission("request.write"), async (req, res) => {
  const { dryRun } = req.body ?? {};
  res.json(await spreadsheets.import(sheetId(req), { dryRun: dryRun === true }, req.user));
});

router.post("/:id/baseline", async (req, res) => {
  const { dryRun } = req.body ?? {};
  res.json(await spreadsheets.markRowsAsSeen(sheetId(req), { dryRun: dryRun === true }, req.user));
});

router.delete("/:id/baseline", async (req, res) => {
  res.json(await spreadsheets.clearMarks(sheetId(req)));
});

router.delete("/:id", async (req, res) => {
  res.json({ sheet: await spreadsheets.remove(sheetId(req)) });
});

export default router;
