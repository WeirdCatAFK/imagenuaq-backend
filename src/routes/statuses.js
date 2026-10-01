// The status catalogue (RF-EST-02). Reads stay on the session -- every board and every form
// needs its picker; writes are `status.manage`, coordination's grant.
import { Router } from "express";

import statuses from "../access/orchestration/statuses.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const statusId = (req) => idParam(req, "id", "status id");

router.use(authenticate);

router.get("/", async (req, res) => {
  const { areaId, includeInactive } = req.query;
  res.json({
    statuses: await statuses.list({
      areaId: areaId === undefined ? null : areaId,
      includeInactive: includeInactive === "true",
    }),
  });
});

router.get("/:id", async (req, res) => {
  res.json({ status: await statuses.get(statusId(req)) });
});

router.use(requirePermission("status.manage"));

router.post("/", async (req, res) => {
  const { areaId, code, label, sortOrder, isTerminal } = req.body ?? {};
  res.status(201).json({
    status: await statuses.create({
      areaId,
      code,
      label,
      sortOrder: sortOrder ?? 0,
      isTerminal: isTerminal ?? false,
    }),
  });
});

router.patch("/:id", async (req, res) => {
  const { label, sortOrder, isTerminal, isActive } = req.body ?? {};
  res.json({ status: await statuses.update(statusId(req), { label, sortOrder, isTerminal, isActive }) });
});

router.delete("/:id", async (req, res) => {
  res.json({ status: await statuses.deactivate(statusId(req)) });
});

export default router;
