// Flow templates (RF-FLW-02, RF-PRY-06): a workflow is the identity, its versions are the
// immutable phase-and-stage content, and a clone is how a new flow starts from an existing
// one ("Partir de una plantilla").
//
// Reads are open to any session -- the designer and, next, a project picking its template
// have to list them. Writes are `workflow.manage`, coordination's grant. The publisher of a
// version is the session, never a body field (orchestration/workflows.js).
import { Router } from "express";

import workflows from "../access/orchestration/workflows.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

router.use(authenticate);

// --- Reads: any authenticated user ---

// GET /api/workflows/versions/:versionId -- declared before '/:id', see routes/areas.js.
router.get("/versions/:versionId", async (req, res) => {
  res.json({ version: await workflows.getVersion(positiveInt(req.params.versionId, "version id")) });
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

// --- Writes: whoever holds workflow.manage ---

router.use(requirePermission("workflow.manage"));

// POST /api/workflows -- the template and its version 1.
router.post("/", async (req, res) => {
  const { code, name, phases } = req.body ?? {};
  res.status(201).json({ workflow: await workflows.create({ code, name, phases }) });
});

// POST /api/workflows/:id/clone -- a new template whose version 1 is the source's latest.
router.post("/:id/clone", async (req, res) => {
  const { code, name } = req.body ?? {};
  res.status(201).json({ workflow: await workflows.clone(workflowId(req), { code, name }) });
});

// POST /api/workflows/:id/versions -- publishes the next version; earlier ones never change.
router.post("/:id/versions", async (req, res) => {
  const { phases } = req.body ?? {};
  res.status(201).json({ version: await workflows.publish(workflowId(req), { phases }) });
});

// PATCH /api/workflows/:id -- name and active flag only.
router.patch("/:id", async (req, res) => {
  const { name, isActive } = req.body ?? {};
  res.json({ workflow: await workflows.update(workflowId(req), { name, isActive }) });
});

// DELETE /api/workflows/:id -- deactivates; versions stay for the projects that used them.
router.delete("/:id", async (req, res) => {
  res.json({ workflow: await workflows.delete(workflowId(req)) });
});

function workflowId(req) {
  return positiveInt(req.params.id, "workflow id");
}

function positiveInt(raw, what) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest(`Invalid ${what}.`);
  return id;
}

export default router;
