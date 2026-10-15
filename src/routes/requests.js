// The intake: requests and the one crossing into a project (RF-SOL-03 … RF-SOL-08, RF-PRY-01).
//
// Two blocks, `request.read` then `request.write`. Converting also needs `project.write`, since
// it creates a project.
import { Router } from "express";

import requests from "../access/orchestration/requests.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const requestId = (req) => idParam(req, "id", "request id");

router.use(authenticate);
router.use(requirePermission("request.read"));

router.get("/", async (req, res) => {
  res.json(await requests.list(req.query));
});

router.get("/:id", async (req, res) => {
  res.json({ request: await requests.getById(requestId(req)) });
});

router.use(requirePermission("request.write"));

router.post("/", async (req, res) => {
  res.status(201).json({ request: await requests.create(req.body ?? {}) });
});

router.patch("/:id", async (req, res) => {
  res.json({ request: await requests.update(requestId(req), req.body ?? {}) });
});

router.put("/:id/status", async (req, res) => {
  const { statusId } = req.body ?? {};
  res.json({ request: await requests.setStatus(requestId(req), statusId) });
});

router.delete("/:id", async (req, res) => {
  res.json({ request: await requests.remove(requestId(req)) });
});

router.put("/:id/flow", async (req, res) => {
  const { workflowId, phases } = req.body ?? {};
  res.json({ request: await requests.setFlow(requestId(req), { workflowId, phases }) });
});

router.delete("/:id/flow", async (req, res) => {
  res.json({ request: await requests.clearFlow(requestId(req)) });
});

router.post("/:id/convert", requirePermission("project.write"), async (req, res) => {
  res.status(201).json(await requests.convert(requestId(req), req.body ?? {}));
});

export default router;
