// The requester strings already in use (RF-SOL-07), for the autocomplete behind the field.
//
// There is no `entities` table: the requesting party is a string on the request and on the
// project. This endpoint is what keeps that from drifting into four spellings of one
// faculty -- whoever corrects the name at conversion sees what is already there first.
import { Router } from "express";

import query from "../access/resources/query.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";

const router = Router();

router.use(authenticate);
router.use(requirePermission("request.read"));

router.get("/", async (req, res) => {
  const { q, limit } = req.query;
  const cap = Number(limit);

  const rows = await query.listRequesters({
    q: typeof q === "string" && q.trim() !== "" ? q.trim() : null,
    limit: Number.isInteger(cap) && cap > 0 && cap <= 100 ? cap : 20,
  });

  res.json({ requesters: rows.map((row) => ({ name: row.requester, uses: row.uses })) });
});

export default router;
