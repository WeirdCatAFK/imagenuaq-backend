// Request formats (RF-SOL-01): a schema is the identity, its versions are the immutable
// field lists, and a clone is how a new format starts from an existing one.
//
// Reads are open to any session -- a form has to know its fields, and a sheet mapping
// has to list the targets. Writes are `schema.manage`, coordination's grant. The
// publisher of a version is the session, never a body field (orchestration/schemas.js).
import { Router } from "express";

import schemas from "../access/orchestration/schemas.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const schemaId = (req) => idParam(req, "id", "schema id");

router.use(authenticate);

router.get("/field-keys", async (_req, res) => {
  res.json({ fieldKeys: await schemas.listFieldKeys() });
});

router.get("/versions/:versionId", async (req, res) => {
  res.json({ version: await schemas.getVersion(idParam(req, "versionId", "version id")) });
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

router.use(requirePermission("schema.manage"));

router.post("/", async (req, res) => {
  const { code, name, fields } = req.body ?? {};
  res.status(201).json({ schema: await schemas.create({ code, name, fields }) });
});

router.post("/:id/clone", async (req, res) => {
  const { code, name } = req.body ?? {};
  res.status(201).json({ schema: await schemas.clone(schemaId(req), { code, name }) });
});

router.post("/:id/versions", async (req, res) => {
  const { fields } = req.body ?? {};
  res.status(201).json({ version: await schemas.createVersion(schemaId(req), { fields }) });
});

router.patch("/:id", async (req, res) => {
  const { name, isActive } = req.body ?? {};
  res.json({ schema: await schemas.update(schemaId(req), { name, isActive }) });
});

router.delete("/:id", async (req, res) => {
  res.json({ schema: await schemas.delete(schemaId(req)) });
});

export default router;
