// Roles and the permission catalogue. Writes stay on `requireRole("admin")` rather than a
// permission: gating the grants on a grant lets an admin lock everyone out.
import { Router } from "express";

import roles from "../access/orchestration/roles.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const roleId = (req) => idParam(req, "id", "role id");
const permissionId = (req) => idParam(req, "permissionId", "permission id");

router.use(authenticate);

router.get("/permissions", async (_req, res) => {
  res.json({ permissions: await roles.getPermissions() });
});

router.get("/", async (_req, res) => {
  res.json({ roles: await roles.get() });
});

router.get("/:id", async (req, res) => {
  res.json({ role: await roles.getById(roleId(req)) });
});

router.get("/:id/permissions", async (req, res) => {
  res.json({ permissions: await roles.getRolePermissions(roleId(req)) });
});

router.use(requireRole("admin"));

router.post("/", async (req, res) => {
  const role = await roles.create(req.body ?? {});
  res.status(201).json({ role });
});

router.patch("/:id", async (req, res) => {
  res.json({ role: await roles.update(roleId(req), req.body ?? {}) });
});

router.delete("/:id", async (req, res) => {
  res.json({ role: await roles.delete(roleId(req)) });
});

router.put("/:id/permissions", async (req, res) => {
  const { permissions } = req.body ?? {};
  res.json({
    permissions: await roles.setPermissions(roleId(req), permissions),
  });
});

router.post("/:id/permissions/:permissionId", async (req, res) => {
  const result = await roles.grant(roleId(req), permissionId(req));
  res.status(result.granted ? 201 : 200).json(result);
});

router.delete("/:id/permissions/:permissionId", async (req, res) => {
  res.json(await roles.revoke(roleId(req), permissionId(req)));
});

router.post("/permissions", async (req, res) => {
  const permission = await roles.createPermission(req.body ?? {});
  res.status(201).json({ permission });
});

router.patch("/permissions/:permissionId", async (req, res) => {
  const permission = await roles.updatePermission(
    permissionId(req),
    req.body ?? {},
  );
  res.json({ permission });
});

router.delete("/permissions/:permissionId", async (req, res) => {
  const permission = await roles.deletePermission(
    permissionId(req),
  );
  res.json({ permission });
});

export default router;
