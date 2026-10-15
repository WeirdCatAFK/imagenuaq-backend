// The data-type catalogue. Read-only: types are added by migration.
import { Router } from "express";

import dataTypes from "../access/orchestration/dataTypes.js";
import { authenticate } from "../middlewares/auth.js";

const router = Router();

router.use(authenticate);

router.get("/", async (_req, res) => {
  res.json({ dataTypes: await dataTypes.getAll() });
});

router.get("/:code", async (req, res) => {
  res.json({ dataType: await dataTypes.get(req.params.code) });
});

export default router;
