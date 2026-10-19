// The contract types, at /api/contract-types. Read-only; orchestration/contractTypes.js says why.
import { Router } from "express";

import contractTypes from "../access/orchestration/contractTypes.js";
import { authenticate } from "../middlewares/auth.js";

const router = Router();

router.use(authenticate);

router.get("/", async (_req, res) => {
  res.json({ contractTypes: await contractTypes.get() });
});

export default router;
