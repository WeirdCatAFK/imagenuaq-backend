import { Router } from "express";

import schemas from "../access/orchestration/schemas.js";
import {authenticate, requirePermission } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

router.use(authenticate);

// READS
// GET /api/schemas
// Obtiene todos los schemas y su última versión.
router.get("/", async (_req, res) => {
  res.json({
    schemas: await schemas.getAll(),
  });
});


// GET /api/schemas/:id
// Obtiene un schema específico y su última versión.
router.get("/:id", async (req, res) => {
  res.json({
    schema: await schemas.get(schemaId(req)),
  });
});


// WRITES
// La modificación de schemas requiere schema.manage.
// Los GET anteriores solamente requieren una sesión válida.

router.use(requirePermission("schema.manage"));


// POST /api/schemas
// Crea el schema y su primera versión.
router.post("/", async (req, res) => {
  const {
    code,
    name,
    fields,
    publishedBy = null,
  } = req.body ?? {};

  const schema = await schemas.create({
    code,
    name,
    fields,
    publishedBy,
  });

  res.status(201).json({ schema });
});


// POST /api/schemas/:id/versions
// Crea una nueva versión del schema.
// La versión anterior permanece intacta.
router.post("/:id/versions", async (req, res) => {
  const {fields, publishedBy = null,} = req.body ?? {};

  const version = await schemas.createVersion(schemaId(req),
    {
      fields,
      publishedBy,
    },
  );

  res.status(201).json({ version });
});


// DELETE /api/schemas/:id
// Desactiva el schema.
// No elimina físicamente sus versiones.
router.delete("/:id", async (req, res) => {
  const schema = await schemas.delete(schemaId(req));
  res.json({ schema });
});


// HELPERS
function schemaId(req) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest("Invalid schema id.");
  }

  return id;
}

export default router;