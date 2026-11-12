// The contract types and their per-scheme absence entitlements (RF-AUS-04). Only an admin adds a
// type, as the "Tipos de contrato" tab is admin-only; entitlements go through absence.manage.
import { Router } from "express";

import contractTypes from "../access/orchestration/contractTypes.js";
import absences from "../access/orchestration/absences.js";
import { authenticate, requirePermission, requireRole } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();

router.use(authenticate);

router.get("/", async (_req, res) => {
  res.json({ contractTypes: await contractTypes.get() });
});

router.post("/", requireRole("admin"), async (req, res) => {
  res.status(201).json({ contractType: await contractTypes.create(req.body ?? {}) });
});

router.get("/:id/entitlements", requirePermission("absence.read"), async (req, res) => {
  res.json({ entitlements: await absences.listEntitlements(idParam(req, "id", "contract type id")) });
});

router.post("/:id/entitlements", requirePermission("absence.manage"), async (req, res) => {
  res.status(201).json({
    entitlement: await absences.setEntitlement(idParam(req, "id", "contract type id"), req.body ?? {}),
  });
});

router.patch("/:id/entitlements/:eid", requirePermission("absence.manage"), async (req, res) => {
  res.json({
    entitlement: await absences.updateEntitlement(
      idParam(req, "id", "contract type id"),
      idParam(req, "eid", "entitlement id"),
      req.body ?? {},
    ),
  });
});

export default router;
