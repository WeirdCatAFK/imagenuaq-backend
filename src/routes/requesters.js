// The requester names already in use (RF-SOL-07), for the autocomplete. There is no `entities`
// table: a requester is a string on the request and the project.
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
