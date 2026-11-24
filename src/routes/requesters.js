// The requester names already in use (RF-SOL-07), for the autocomplete. There is no `entities`
// table: a requester is a string on the request and the project, so whoever captures either reads it.
import { Router } from "express";

import requests from "../access/orchestration/requests.js";
import { authenticate, requireAnyPermission } from "../middlewares/auth.js";

const router = Router();

router.use(authenticate);
router.use(requireAnyPermission("request.read", "project.write"));

router.get("/", async (req, res) => {
  const { q, limit } = req.query;
  res.json({ requesters: await requests.listRequesters({ q, limit }) });
});

export default router;
