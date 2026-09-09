// The contract-scheme catalogue, at /api/contract-types.
//
// One route, one guard. Everything about why there is no POST here is in
// access/orchestration/contractTypes.js.
import { Router } from "express";

import contractTypes from "../access/orchestration/contractTypes.js";
import { authenticate } from "../middlewares/auth.js";

const router = Router();

router.use(authenticate);

router.get("/", async (_req, res) => {
  res.json({ contractTypes: await contractTypes.get() });
});

export default router;
