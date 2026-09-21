// Request formats (RF-SOL-01): a schema is the identity, its versions are the immutable
// field lists, and a clone is how a new format starts from an existing one.
//
// Reads are open to any session -- a form has to know its fields, and a sheet mapping
// has to list the targets. Writes are `schema.manage`, coordination's grant. The
// publisher of a version is the session, never a body field (orchestration/schemas.js).
import { Router } from "express";

import schemas from "../access/orchestration/schemas.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

router.use(authenticate);

// --- Reads: any authenticated user ---

// GET /api/schemas/versions/:versionId -- declared before '/:id', see routes/areas.js.
router.get("/versions/:versionId", async (req, res) => {
  res.json({ version: await schemas.getVersion(positiveInt(req.params.versionId, "version id")) });
});

router.get("/", async (_req, res) => {
  res.json({ schemas: await schemas.getAll() });
});

router.get("/:id", async (req, res) => {
  res.json({ schema: await schemas.get(schemaId(req)) });
});

router.get("/:id/versions", async (req, res) => {
  res.json({ versions: await schemas.getVersions(schemaId(req)) });
});

// --- Writes: whoever holds schema.manage ---

router.use(requirePermission("schema.manage"));

// POST /api/schemas -- the schema and its version 1.
router.post("/", async (req, res) => {
  const { code, name, fields } = req.body ?? {};
  res.status(201).json({ schema: await schemas.create({ code, name, fields }) });
});

// POST /api/schemas/:id/clone -- a new schema whose version 1 is the source's latest.
router.post("/:id/clone", async (req, res) => {
  const { code, name } = req.body ?? {};
  res.status(201).json({ schema: await schemas.clone(schemaId(req), { code, name }) });
});

// POST /api/schemas/:id/versions -- publishes the next version; earlier ones never change.
router.post("/:id/versions", async (req, res) => {
  const { fields } = req.body ?? {};
  res.status(201).json({ version: await schemas.createVersion(schemaId(req), { fields }) });
});

// PATCH /api/schemas/:id -- name and active flag only.
router.patch("/:id", async (req, res) => {
  const { name, isActive } = req.body ?? {};
  res.json({ schema: await schemas.update(schemaId(req), { name, isActive }) });
});

// DELETE /api/schemas/:id -- deactivates; versions stay for what was captured with them.
router.delete("/:id", async (req, res) => {
  res.json({ schema: await schemas.delete(schemaId(req)) });
});

function schemaId(req) {
  return positiveInt(req.params.id, "schema id");
}

function positiveInt(raw, what) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest(`Invalid ${what}.`);
  return id;
}

export default router;
