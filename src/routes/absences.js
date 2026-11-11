// Absences and leave (RF-AUS-01 to RF-AUS-15). The availability endpoint reads the view that
// hides the reason; the detail endpoint enforces RF-AUS-13 in orchestration.
import { Router } from "express";

import absences from "../access/orchestration/absences.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const eventId = (req) => idParam(req, "id", "absence id");
const typeId = (req) => idParam(req, "id", "absence type id");

router.use(authenticate);

router.get("/types", requirePermission("absence.read"), async (_req, res) => {
  res.json({ types: await absences.listTypes() });
});

router.post("/types", requirePermission("absence.manage"), async (req, res) => {
  res.status(201).json({ type: await absences.createType(req.body ?? {}) });
});

router.patch("/types/:id", requirePermission("absence.manage"), async (req, res) => {
  res.json({ type: await absences.updateType(typeId(req), req.body ?? {}) });
});

router.get("/availability", requirePermission("absence.read"), async (req, res) => {
  res.json(await absences.availability(req.query));
});

router.get("/balances", requirePermission("absence.read"), async (req, res) => {
  res.json({ balances: await absences.listBalances(req.query.userId) });
});

router.get("/balances/:id", requirePermission("absence.read"), async (req, res) => {
  res.json({ balances: await absences.listBalances(idParam(req, "id", "user id")) });
});

router.get("/", requirePermission("absence.read"), async (req, res) => {
  res.json(await absences.list(req.query));
});

router.get("/:id", requirePermission("absence.read"), async (req, res) => {
  res.json({ absence: await absences.get(eventId(req)) });
});

router.post("/", requirePermission("absence.write"), async (req, res) => {
  res.status(201).json(await absences.create(req.body ?? {}));
});

router.patch("/:id", requirePermission("absence.write"), async (req, res) => {
  res.json({ absence: await absences.update(eventId(req), req.body ?? {}) });
});

router.post("/:id/status", requirePermission("absence.approve"), async (req, res) => {
  res.json({ absence: await absences.changeStatus(eventId(req), req.body ?? {}) });
});

router.delete("/:id", requirePermission("absence.write"), async (req, res) => {
  await absences.remove(eventId(req));
  res.json({ deleted: true });
});

router.post("/:id/document", requirePermission("absence.approve"), async (req, res) => {
  const file = await absences.uploadDocument(eventId(req), {
    name: req.query.name,
    mime: req.headers["content-type"] ?? null,
    body: req,
  });
  res.status(201).json({ file });
});

router.get("/:id/history", requirePermission("absence.read"), async (req, res) => {
  res.json({ history: await absences.statusHistory(eventId(req)) });
});

export default router;
