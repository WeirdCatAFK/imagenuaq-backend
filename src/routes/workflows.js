// Flow templates (RF-FLW-02, RF-PRY-06): the template, its unchangeable versions, and cloning.
// Reads need a session; writes need `workflow.manage`. The publisher is the session.
import { Router } from "express";

import workflows from "../access/orchestration/workflows.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const workflowId = (req) => idParam(req, "id", "workflow id");

router.use(authenticate);

router.get("/versions/:versionId", async (req, res) => {
  res.json({ version: await workflows.getVersion(idParam(req, "versionId", "version id")) });
});

router.get("/", async (_req, res) => {
  res.json({ workflows: await workflows.list() });
});

router.get("/:id", async (req, res) => {
  res.json({ workflow: await workflows.get(workflowId(req)) });
});

router.get("/:id/versions", async (req, res) => {
  res.json({ versions: await workflows.getVersions(workflowId(req)) });
});

router.use(requirePermission("workflow.manage"));

router.post("/", async (req, res) => {
  const { code, name, phases } = req.body ?? {};
  res.status(201).json({ workflow: await workflows.create({ code, name, phases }) });
});

router.post("/:id/clone", async (req, res) => {
  const { code, name } = req.body ?? {};
  res.status(201).json({ workflow: await workflows.clone(workflowId(req), { code, name }) });
});

router.post("/:id/versions", async (req, res) => {
  const { phases } = req.body ?? {};
  res.status(201).json({ version: await workflows.publish(workflowId(req), { phases }) });
});

router.patch("/:id", async (req, res) => {
  const { name, isActive } = req.body ?? {};
  res.json({ workflow: await workflows.update(workflowId(req), { name, isActive }) });
});

router.delete("/:id", async (req, res) => {
  res.json({ workflow: await workflows.delete(workflowId(req)) });
});

export default router;
