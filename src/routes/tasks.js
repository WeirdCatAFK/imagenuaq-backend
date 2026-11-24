// Each person's stages, the area inbox, the load panel and the sign-off queue (RF-TSK-01 to RF-TSK-07,
// RF-FLW-03). Reading and delivering one's own stages needs `task.read`; handing work out and signing
// it off need `task.write`, and orchestration then checks that the caller leads the stage's area.
import { Router } from "express";

import tasks from "../access/orchestration/tasks.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();

router.use(authenticate);
router.use(requirePermission("task.read"));

router.get("/mine", async (req, res) => {
  res.json(await tasks.listMine());
});

router.get("/stages/:stageId/folder", async (req, res) => {
  res.json({ folder: await tasks.getFolder(idParam(req, "stageId", "stage id")) });
});

router.put("/stages/:stageId/delivery", async (req, res) => {
  const { note, fileId } = req.body ?? {};
  res.json({ stage: await tasks.deliver(idParam(req, "stageId", "stage id"), { note, fileId }) });
});

router.use(requirePermission("task.write"));

router.get("/unassigned", async (req, res) => {
  res.json({ items: await tasks.listUnassigned(req.query.areaId) });
});

router.get("/workload", async (req, res) => {
  const { areaId, from, to } = req.query;
  res.json(await tasks.workload(areaId, { from, to }));
});

router.get("/overview", async (req, res) => {
  const { from, to } = req.query;
  res.json(await tasks.overview({ from, to }));
});

router.get("/review", async (req, res) => {
  res.json(await tasks.listToReview());
});

router.post("/stages/:stageId/approvals", async (req, res) => {
  const { decision, comment } = req.body ?? {};
  res.status(201).json(await tasks.signOff(idParam(req, "stageId", "stage id"), { decision, comment }));
});

router.put("/stages/:stageId/assignee", async (req, res) => {
  const { userId } = req.body ?? {};
  res.json({ stage: await tasks.assignStage(idParam(req, "stageId", "stage id"), userId) });
});

export default router;
