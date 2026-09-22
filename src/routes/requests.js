// The intake: requests and the one crossing into a project (RF-SOL-03 … RF-SOL-08, RF-PRY-01).
//
// Two blocks, `request.read` then `request.write`. Converting also needs `project.write`, since
// it creates a project.
import { Router } from "express";

import requests from "../access/orchestration/requests.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

router.use(authenticate);
router.use(requirePermission("request.read"));

// The inbox (RF-SOL-04, RF-SOL-05): by default what has not been converted yet.
router.get("/", async (req, res) => {
  res.json({ requests: await requests.list(req.query) });
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

// RF-PRY-01: one or several requests become a project, keeping the link.
router.post(
  "/:id/convert",
  requirePermission("project.write"),
  async (req, res) => {
    res
      .status(201)
      .json(await requests.convert(requestId(req), req.body ?? {}));
  },
);

function requestId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    throw ApiError.badRequest("Invalid request id.");
  return id;
}

export default router;
