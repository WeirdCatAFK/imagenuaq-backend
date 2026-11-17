// Print shop routes (RF-IMP-01 to RF-IMP-08). Machines and pantones are catalogs
// managed by coordination. Orders are the work-order sheets that go to the press.
import { Router } from "express";

import print from "../access/orchestration/print.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const orderId = (req) => idParam(req, "id", "order id");
const pantoneId = (req) => idParam(req, "id", "pantone id");
const machineId = (req) => idParam(req, "id", "machine id");

router.use(authenticate);

router.get("/machines", requirePermission("print.read"), async (_req, res) => {
  res.json({ machines: await print.listMachines() });
});

router.post("/machines", requirePermission("print.manage"), async (req, res) => {
  res.status(201).json({ machine: await print.createMachine(req.body ?? {}) });
});

router.patch("/machines/:id", requirePermission("print.manage"), async (req, res) => {
  res.json({ machine: await print.updateMachine(machineId(req), req.body ?? {}) });
});

router.get("/pantones", requirePermission("print.read"), async (req, res) => {
  res.json({ pantones: await print.listPantones(req.query.entity) });
});

router.get("/pantones/lookup", requirePermission("print.read"), async (req, res) => {
  res.json({ pantones: await print.lookupPantones(req.query.entity) });
});

router.post("/pantones", requirePermission("print.manage"), async (req, res) => {
  res.status(201).json({ pantone: await print.createPantone(req.body ?? {}) });
});

router.patch("/pantones/:id", requirePermission("print.manage"), async (req, res) => {
  res.json({ pantone: await print.updatePantone(pantoneId(req), req.body ?? {}) });
});

router.delete("/pantones/:id", requirePermission("print.manage"), async (req, res) => {
  await print.deletePantone(pantoneId(req));
  res.json({ ok: true });
});

router.get("/orders", requirePermission("print.read"), async (req, res) => {
  res.json({ orders: await print.listOrders(req.query) });
});

router.get("/orders/:id", requirePermission("print.read"), async (req, res) => {
  res.json({ order: await print.getOrder(orderId(req)) });
});

router.post("/orders", requirePermission("print.create"), async (req, res) => {
  res.status(201).json({ order: await print.createOrder(req.body ?? {}) });
});

router.patch("/orders/:id", requirePermission("print.write"), async (req, res) => {
  res.json({ order: await print.updateOrder(orderId(req), req.body ?? {}) });
});

router.post("/orders/:id/status", requirePermission("print.write"), async (req, res) => {
  res.json({ order: await print.changeStatus(orderId(req), req.body ?? {}) });
});

router.delete("/orders/:id", requirePermission("print.write"), async (req, res) => {
  await print.deleteOrder(orderId(req));
  res.json({ ok: true });
});

export default router;
