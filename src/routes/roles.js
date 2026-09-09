import { Router } from "express";

import roles from "../access/orchestration/roles.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

// Two guard blocks, and the order of the file enforces them -- see routes/areas.js for the
// argument. A route appended to the bottom is admin-only by default.

router.use(authenticate);

// --- Reads: any authenticated user ---
//
// The catalogues, not the grants of any particular role. A form that assigns somebody a
// role has to list the roles, and hiding the list from everyone but coordination would mean
// the frontend hard-coding four names that this module exists to make editable.

// Declared before '/:id': Express matches in declaration order, and with these the other way
// round `/permissions` is captured as an id and refused as "Invalid role id."
router.get("/permissions", async (_req, res) => {
  res.json({ permissions: await roles.getPermissions() });
});

router.get("/", async (_req, res) => {
  res.json({ roles: await roles.get() });
});

router.get("/:id", async (req, res) => {
  res.json({ role: await roles.getById(roleId(req)) });
});

// What one role may do. Readable by any signed-in user on purpose: RF-USR-05 makes read and
// write independent permissions, and a user who cannot see why they were refused something
// has no way to ask for the right thing.
router.get("/:id/permissions", async (req, res) => {
  res.json({ permissions: await roles.getRolePermissions(roleId(req)) });
});

// --- Everything below is coordination's ---
//
// Editing the role catalogue is editing the authorisation model. requireRole('admin') and
// not requirePermission(): the grants these endpoints write are the very thing
// requirePermission() reads, so gating them on one of them makes the authorisation model
// its own prerequisite -- one bad PUT below and nobody can undo it over HTTP. That is the
// same reasoning that keeps promotion to admin out of the API entirely
// (scripts/createAdmin.js), and it is why catalog-bootstrap seeds `admin` with every
// permission instead of leaving the deadlock for the first operator to find.
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

// PUT /api/roles/:id/permissions -- replace the role's whole grant set, by code.
//
// This is the endpoint that fills `role_permissions`, which the role-permissions migration
// left empty on purpose (RF-USR-05: which role gets what is coordination's decision, not a
// developer's). Until it is used, requirePermission() refuses everyone and every guarded
// route in this API falls back to requireRole().
router.put("/:id/permissions", async (req, res) => {
  const { permissions } = req.body ?? {};
  res.json({
    permissions: await roles.setPermissions(roleId(req), permissions),
  });
});

// 201 when the grant is new, 200 when the role already held it. Both are successes -- the
// caller asked for the grant to exist and it does -- but the status distinguishes them for a
// UI that reports what it actually changed.
router.post("/:id/permissions/:permissionId", async (req, res) => {
  const result = await roles.grant(roleId(req), paramId(req, "permissionId"));
  res.status(result.granted ? 201 : 200).json(result);
});

router.delete("/:id/permissions/:permissionId", async (req, res) => {
  res.json(await roles.revoke(roleId(req), paramId(req, "permissionId")));
});

router.post("/permissions", async (req, res) => {
  const permission = await roles.createPermission(req.body ?? {});
  res.status(201).json({ permission });
});

router.patch("/permissions/:permissionId", async (req, res) => {
  const permission = await roles.updatePermission(
    paramId(req, "permissionId"),
    req.body ?? {},
  );
  res.json({ permission });
});

router.delete("/permissions/:permissionId", async (req, res) => {
  const permission = await roles.deletePermission(
    paramId(req, "permissionId"),
  );
  res.json({ permission });
});

// See routes/areas.js: a non-numeric parameter is a 400 about the URL, not a 500 from
// Postgres refusing the type.
function paramId(req, name) {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest(
      `Invalid ${name === "id" ? "role" : "permission"} id.`,
    );
  }
  return id;
}

function roleId(req) {
  return paramId(req, "id");
}

export default router;
