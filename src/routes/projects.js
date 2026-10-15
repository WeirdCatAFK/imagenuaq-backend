// Projects, their stages, sign-offs and the values that cross stages (RF-PRY-02, RF-FLW-01,
// RF-FLW-03, RF-FLW-06).
//
// Two blocks: `project.read` for everything that reads, `project.write` for everything that
// writes, so a route appended at the bottom is write-gated by omission. Linking a request also
// needs `request.write` -- it edits a request.
import { Router } from "express";

import projects from "../access/orchestration/projects.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const projectId = (req) => idParam(req, "id", "project id");
const stageId = (req) => idParam(req, "stageId", "stage id");

router.use(authenticate);
router.use(requirePermission("project.read"));

router.get("/", async (req, res) => {
  res.json(await projects.list(req.query, req.user.id));
});

router.get("/:id", async (req, res) => {
  res.json({ project: await projects.getById(projectId(req)) });
});

router.get("/:id/stages", async (req, res) => {
  res.json({ stages: await projects.listStages(projectId(req)) });
});

router.get("/:id/field-values", async (req, res) => {
  res.json({ fieldValues: await projects.listFieldValues(projectId(req)) });
});

router.post("/:id/finance-request", requirePermission("finance.request"), async (req, res) => {
  const { kind, needed, note } = req.body ?? {};
  res.json({
    request: await projects.requestFinance(projectId(req), { kind, needed, note }),
  });
});

router.use(requirePermission("project.write"));

router.post("/", async (req, res) => {
  res.status(201).json({ project: await projects.create(req.body ?? {}) });
});

router.patch("/:id", async (req, res) => {
  res.json({ project: await projects.update(projectId(req), req.body ?? {}) });
});

router.put("/:id/status", async (req, res) => {
  const { statusId } = req.body ?? {};
  res.json({ project: await projects.setStatus(projectId(req), statusId) });
});

router.post("/:id/close", async (req, res) => {
  res.json({ project: await projects.close(projectId(req)) });
});

router.post("/:id/archive", async (req, res) => {
  res.json({ project: await projects.archive(projectId(req)) });
});

router.delete("/:id", async (req, res) => {
  res.json({ project: await projects.remove(projectId(req)) });
});

router.post("/:id/requests", requirePermission("request.write"), async (req, res) => {
  const { requestIds } = req.body ?? {};
  res.json({ project: await projects.attachRequests(projectId(req), requestIds) });
});

router.post("/:id/stages", async (req, res) => {
  res.status(201).json({ stage: await projects.addStage(projectId(req), req.body ?? {}) });
});

router.patch("/:id/stages/:stageId", async (req, res) => {
  res.json({ stage: await projects.updateStage(projectId(req), stageId(req), req.body ?? {}) });
});

router.post("/:id/stages/:stageId/approvals", async (req, res) => {
  const { decision, comment, evidenceFileId } = req.body ?? {};
  res.status(201).json(
    await projects.approve(projectId(req), stageId(req), { decision, comment, evidenceFileId }),
  );
});

router.put("/:id/field-values/:key", async (req, res) => {
  const { value, producedByStageId } = req.body ?? {};
  res.json({
    fieldValue: await projects.setFieldValue(projectId(req), req.params.key, {
      value,
      producedByStageId,
    }),
  });
});

router.delete("/:id/field-values/:key", async (req, res) => {
  res.json({ fieldValue: await projects.deleteFieldValue(projectId(req), req.params.key) });
});

export default router;
