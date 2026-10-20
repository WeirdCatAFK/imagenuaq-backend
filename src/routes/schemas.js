// Request formats (RF-SOL-01): the format, its unchangeable versions, cloning, and the vocabulary of
// data keys. Reads need a session; writes need `schema.manage`, except registering a key, which whoever
// designs a flow or a project's stages may also do. The publisher is the session, never a body field.
import { Router } from "express";

import schemas from "../access/orchestration/schemas.js";
import { authenticate, requireAnyPermission, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const schemaId = (req) => idParam(req, "id", "schema id");

router.use(authenticate);

router.get("/field-keys", async (_req, res) => {
  res.json({ fieldKeys: await schemas.listFieldKeys() });
});

router.post(
  "/field-keys",
  requireAnyPermission("schema.manage", "workflow.manage", "project.write"),
  async (req, res) => {
    res.status(201).json({ fieldKey: await schemas.createFieldKey(req.body) });
  },
);

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
