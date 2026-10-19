// Each person's stages, the area inbox and the load panel (RF-TSK-01 to RF-TSK-06). Reading one's
// own stages needs `task.read`; handing work out needs `task.write`, and orchestration then checks
// that the caller leads the stage's area.
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

router.put("/stages/:stageId/assignee", async (req, res) => {
  const { userId } = req.body ?? {};
  res.json({ stage: await tasks.assignStage(idParam(req, "stageId", "stage id"), userId) });
});

export default router;
