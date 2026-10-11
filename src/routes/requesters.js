// The requester strings already in use (RF-SOL-07), for the autocomplete behind the field.
//
// There is no `entities` table: the requesting party is a string on the request and on the
// project. This endpoint is what keeps that from drifting into four spellings of one
// faculty -- whoever corrects the name at conversion sees what is already there first.
import { Router } from "express";

import requests from "../access/orchestration/requests.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";

const router = Router();

router.use(authenticate);
router.use(requirePermission("request.read"));

router.get("/", async (req, res) => {
  const { q, limit } = req.query;
  res.json({ requesters: await requests.listRequesters({ q, limit }) });
});

export default router;
