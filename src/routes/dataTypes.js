import { Router } from "express";

import dataTypes from "../access/orchestration/dataTypes.js";
import {
  authenticate,
  requirePermission,
} from "../middlewares/auth.js";

const router = Router();

router.use(authenticate);

// Consultar todos los tipos activos
router.get("/", async (_req, res) => {
  res.json({
    dataTypes: await dataTypes.getAll(),
  });
});

// Consultar un tipo específico
router.get("/:code", async (req, res) => {
  res.json({
    dataType: await dataTypes.get(req.params.code),
  });
});

// Por ahora los tipos son administrados mediante migraciones,
// por lo que no agregamos POST/PUT/DELETE desde la API.

export default router;