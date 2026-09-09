// Tier 3: the role catalogue and the permissions each role grants.
//
// RF-USR-02 names three levels -- integrante de área, responsable de área,
// coordinación/secretaría particular -- and the catalog-bootstrap migration seeded those
// plus `finance` for RF-USR-08. Four rows are the starting point, not the ceiling: this
// module exists so coordination adds the fifth without a deploy, for the same reason areas
// are data (RF-USR-09).
//
// The permission half is what RF-USR-05 asks for: read and write are independent and
// assignable by role, so `project.read` and `project.write` are two rows and not two levels
// of one.
//
// `role_permissions` arrives partly filled. Section 8 of catalog-bootstrap seeds the two
// grants that are definitions rather than configuration -- `admin` gets every permission,
// because it is the role from which the others are configured and an empty one is a
// bootstrap deadlock, and `finance` gets finance.read, because that grant IS the role under
// RF-USR-08. `worker` and `area_lead` are deliberately empty: theirs is policy, and
// setPermissions() below is where coordination decides it.
//
// The role is global and stays that way -- see DATAMODEL.md §5.2, which records the
// decision. `role_permissions` answers what a person may do; `area_members` and
// `area_hierarchy` answer which records they may do it to. The case that cannot be expressed
// is somebody who may edit in one area and only read in another; that is the case the
// decision declines to support, not an omission.
//
// Two rules hold throughout: codes are compared literally, so nothing here case-folds
// caller input, and a rename is a real hazard -- requireRole() compares `roles.name` and
// every live JWT carries the old one for seven days.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** Column widths from initial-schema and role-permissions; a 22001 becomes a 400 here. */
const ROLE_NAME_MAX = 50;
const PERMISSION_CODE_MAX = 100;
const PERMISSION_LABEL_MAX = 200;

/**
 * The seeded catalogue is `resource.action` -- project.read, absence.reason.read. Dots may
 * repeat. requirePermission() compares these literally, so `Project Read` and
 * `project.read` are two permissions that look like one to whoever grants them.
 */
const PERMISSION_CODE = /^[a-z0-9]+(\.[a-z0-9]+)+$/;

class Roles {
  // --- Roles ---

  async create({ name, description = null }) {
    const cleanName = cleanText(name);
    if (!cleanName || cleanName.length > ROLE_NAME_MAX) {
      throw ApiError.badRequest(
        `Role name is required (${ROLE_NAME_MAX} characters or fewer).`,
      );
    }

    try {
      const role = await query.createRole({
        name: cleanName,
        description: cleanText(description),
      });

      await events.emit({
        action: "record_created",
        target: { table: "roles", id: role.id },
        after: role,
      });

      return shapeRole(role);
    } catch (err) {
      throw translate(err);
    }
  }

  async get() {
    return (await query.getRoles()).map(shapeRole);
  }

  async getById(roleId) {
    const role = await query.getRoleById(requireId(roleId, "roleId"));
    if (!role) throw ApiError.notFound("Role not found.");
    return shapeRole(role);
  }

  async getByName(name) {
    const role = await query.getRoleByName(cleanText(name));
    if (!role) throw ApiError.notFound("Role not found.");
    return shapeRole(role);
  }

  /**
   * Updates only the keys the caller sent, merged against the current row.
   *
   * Renaming is allowed and is more dangerous than it looks: requireRole() compares
   * `roles.name`, and every JWT already issued carries the OLD name for seven days, so a
   * rename locks out everyone holding a live token until they log in again.
   *
   * @param {number|string} roleId
   * @param {{ name?: string, description?: string|null }} changes
   * @returns {Promise<object>}
   * @throws {ApiError} 400 on a bad payload, 404 when the role does not exist.
   */
  async update(roleId, { name, description }) {
    const id = requireId(roleId, "roleId");
    const current = await query.getRoleById(id);
    if (!current) throw ApiError.notFound("Role not found.");

    const nextName = name === undefined ? current.name : cleanText(name);
    if (!nextName || nextName.length > ROLE_NAME_MAX) {
      throw ApiError.badRequest(
        `Role name is required (${ROLE_NAME_MAX} characters or fewer).`,
      );
    }

    const nextDescription =
      description === undefined ? current.description : cleanText(description);

    try {
      const role = await query.updateRole(id, {
        name: nextName,
        description: nextDescription,
      });
      if (!role) throw ApiError.notFound("Role not found.");

      // A rename changes what requireRole() compares, so "why did everyone stop being able
      // to do X" has an answer here and nowhere else.
      await events.emit({
        action: "record_updated",
        target: { table: "roles", id: role.id },
        before: current,
        after: role,
      });

      return shapeRole(role);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Deletes a role, refusing while anyone still holds it. The count is in the message
   * because a bare 409 leaves the admin guessing how much reassigning is left.
   *
   * There is no automatic reassignment: `users.role_id` is NOT NULL, so the alternative
   * to refusing is picking a role for those users, which silently grants or revokes access
   * on their behalf. The foreign key would refuse too; this check exists to say why.
   *
   * @param {number|string} roleId
   * @throws {ApiError} 404 when it does not exist, 409 while it is held.
   */
  async delete(roleId) {
    const id = requireId(roleId, "roleId");

    const holders = await query.countUsersWithRole(id);
    if (holders > 0) {
      throw ApiError.conflict(
        `That role is still held by ${holders} user${holders === 1 ? "" : "s"}; reassign them first.`,
      );
    }

    try {
      const role = await query.deleteRole(id);
      if (!role) throw ApiError.notFound("Role not found.");

      await events.emit({
        action: "record_deleted",
        target: { table: "roles", id: role.id },
        before: role,
      });

      return shapeRole(role);
    } catch (err) {
      // The race the count cannot close: a user assigned this role in between.
      if (err?.code === FOREIGN_KEY_VIOLATION) {
        throw ApiError.conflict(
          "That role is still held by at least one user; reassign them first.",
        );
      }
      throw translate(err);
    }
  }

  // --- Permissions ---

  async createPermission({ code, label, description = null }) {
    // Trimmed but NOT case-folded. Lower-casing first would let `Project.Read` through the
    // pattern and then collide with the seeded `project.read`, giving the caller a 409
    // about a permission they did not think they were creating.
    const cleanCode = cleanText(code);
    const cleanLabel = cleanText(label);

    if (!cleanCode || cleanCode.length > PERMISSION_CODE_MAX) {
      throw ApiError.badRequest(
        `Permission code is required (${PERMISSION_CODE_MAX} characters or fewer).`,
      );
    }
    if (!PERMISSION_CODE.test(cleanCode)) {
      throw ApiError.badRequest(
        "Permission code must be dotted lowercase, e.g. project.write.",
      );
    }
    if (!cleanLabel || cleanLabel.length > PERMISSION_LABEL_MAX) {
      throw ApiError.badRequest(
        `Permission label is required (${PERMISSION_LABEL_MAX} characters or fewer).`,
      );
    }

    try {
      const permission = await query.createPermission({
        code: cleanCode,
        label: cleanLabel,
        description: cleanText(description),
      });

      await events.emit({
        action: "record_created",
        target: { table: "permissions", id: permission.id },
        after: permission,
      });

      return shapePermission(permission);
    } catch (err) {
      throw translate(err);
    }
  }

  async getPermissions() {
    return (await query.getPermissions()).map(shapePermission);
  }

  async getPermissionById(permissionId) {
    const permission = await query.getPermissionById(
      requireId(permissionId, "permissionId"),
    );
    if (!permission) throw ApiError.notFound("Permission not found.");

    await events.emit({
      action: "record_deleted",
      target: { table: "permissions", id: permission.id },
      before: permission,
    });

    return shapePermission(permission);
  }

  async updatePermission(permissionId, { code, label, description }) {
    const id = requireId(permissionId, "permissionId");
    const current = await query.getPermissionById(id);
    if (!current) throw ApiError.notFound("Permission not found.");

    const nextCode = code === undefined ? current.code : cleanText(code);
    if (!nextCode || nextCode.length > PERMISSION_CODE_MAX) {
      throw ApiError.badRequest(
        `Permission code is required (${PERMISSION_CODE_MAX} characters or fewer).`,
      );
    }
    if (!PERMISSION_CODE.test(nextCode)) {
      throw ApiError.badRequest(
        "Permission code must be dotted lowercase, e.g. project.write.",
      );
    }

    const nextLabel = label === undefined ? current.label : cleanText(label);
    if (!nextLabel || nextLabel.length > PERMISSION_LABEL_MAX) {
      throw ApiError.badRequest(
        `Permission label is required (${PERMISSION_LABEL_MAX} characters or fewer).`,
      );
    }

    const nextDescription =
      description === undefined ? current.description : cleanText(description);

    try {
      const permission = await query.updatePermission(id, {
        code: nextCode,
        label: nextLabel,
        description: nextDescription,
      });
      if (!permission) throw ApiError.notFound("Permission not found.");

      await events.emit({
        action: "record_updated",
        target: { table: "permissions", id: permission.id },
        before: current,
        after: permission,
      });

      return shapePermission(permission);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Deletes a permission, revoking it from every role by the cascade on role_permissions.
   * Survivable in a way deleting a role is not: requirePermission() fails closed on a code
   * nobody holds, so the worst outcome is a route that refuses everyone, visible at once.
   *
   * @param {number|string} permissionId
   * @throws {ApiError} 404 when it does not exist.
   */
  async deletePermission(permissionId) {
    const permission = await query.deletePermission(
      requireId(permissionId, "permissionId"),
    );
    if (!permission) throw ApiError.notFound("Permission not found.");
    return shapePermission(permission);
  }

  // --- Grants (RF-USR-05) ---

  async getRolePermissions(roleId) {
    const id = requireId(roleId, "roleId");
    if (!(await query.getRoleById(id))) {
      throw ApiError.notFound("Role not found.");
    }
    return (await query.getRolePermissions(id)).map(shapePermission);
  }

  /**
   * Grants a permission to a role.
   *
   * @param {number|string} roleId
   * @param {number|string} permissionId
   * @returns {Promise<object>} `granted` is false when the role already held it — not an
   *   error, and what the route turns into 201 versus 200.
   */
  async grant(roleId, permissionId) {
    const role = requireId(roleId, "roleId");
    const permission = requireId(permissionId, "permissionId");

    if (!(await query.getRoleById(role))) {
      throw ApiError.notFound("Role not found.");
    }
    if (!(await query.getPermissionById(permission))) {
      throw ApiError.notFound("Permission not found.");
    }

    try {
      const row = await query.grantPermissionToRole(role, permission);

      // `permission_granted` and `permission_revoked` are their own action codes rather
      // than record_created/deleted on a join table: "who gave finance.read to whom, and
      // when" is the question RF-USR-05 makes worth asking.
      if (row !== null) {
        await events.emit({
          action: "permission_granted",
          target: { table: "roles", id: role },
          after: { role_id: role, permission_id: permission },
        });
      }

      return { roleId: role, permissionId: permission, granted: row !== null };
    } catch (err) {
      throw translate(err);
    }
  }

  async revoke(roleId, permissionId) {
    const role = requireId(roleId, "roleId");
    const permission = requireId(permissionId, "permissionId");

    const row = await query.revokePermissionFromRole(role, permission);
    if (!row) throw ApiError.notFound("That role does not hold that permission.");

    await events.emit({
      action: "permission_revoked",
      target: { table: "roles", id: role },
      before: { role_id: role, permission_id: permission },
    });

    return { roleId: role, permissionId: permission, revoked: true };
  }

  /**
   * Replaces a role's whole grant set, by code rather than by id — codes are what the
   * requirement is written in and what requirePermission() compares, whereas ids are
   * sequence values that differ per database, so the same request would grant different
   * permissions on staging and in production.
   *
   * Resolved to ids here so query.js can replace in one statement: a delete-then-insert
   * pair leaves the role holding nothing in between.
   *
   * @param {number|string} roleId
   * @param {string[]} codes
   * @returns {Promise<object>}
   * @throws {ApiError} 400 when a code is unknown, 404 when the role does not exist.
   */
  async setPermissions(roleId, codes) {
    const id = requireId(roleId, "roleId");
    if (!(await query.getRoleById(id))) {
      throw ApiError.notFound("Role not found.");
    }

    if (!Array.isArray(codes)) {
      throw ApiError.badRequest("permissions must be an array of permission codes.");
    }

    // Deduplicated: the same code twice is one grant, and would otherwise make the length
    // comparison below report a phantom unknown code.
    const wanted = [
      ...new Set(
        codes.map((code) => {
          // Trimmed only, as in createPermission().
          const clean = cleanText(code);
          if (!clean) {
            throw ApiError.badRequest("permissions must be non-empty strings.");
          }
          return clean;
        }),
      ),
    ];

    // One by one rather than a single IN (...): the caller deserves to be told WHICH code
    // was wrong, and a count mismatch cannot say. The catalogue is eleven rows.
    const ids = [];
    for (const code of wanted) {
      const permission = await query.getPermissionByCode(code);
      if (!permission) {
        throw ApiError.badRequest(`Unknown permission code: ${code}.`);
      }
      ids.push(permission.id);
    }

    // Read the current set so the trail records what actually changed. A single
    // "permissions replaced" row would be cheaper and close to useless.
    const held = await query.getRolePermissions(id);
    const heldIds = new Set(held.map((permission) => permission.id));
    const wantedIds = new Set(ids);

    let result;
    try {
      result = (await query.setRolePermissions(id, ids)).map(shapePermission);
    } catch (err) {
      throw translate(err);
    }

    // After the write, and only for the differences: emitting before would record grants
    // that a failed statement never made.
    for (const permissionId of ids) {
      if (heldIds.has(permissionId)) continue;
      await events.emit({
        action: "permission_granted",
        target: { table: "roles", id },
        after: { role_id: id, permission_id: permissionId },
      });
    }
    for (const permission of held) {
      if (wantedIds.has(permission.id)) continue;
      await events.emit({
        action: "permission_revoked",
        target: { table: "roles", id },
        before: { role_id: id, permission_id: permission.id },
      });
    }

    return result;
  }
}

/**
 * Trims, and turns an empty string into null. Duplicated from orchestration/areas.js
 * rather than shared: a shared helper is where the first special case would go.
 *
 * @returns {string | null}
 */
function cleanText(value) {
  if (typeof value !== "string") return value == null ? null : value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toId(value) {
  if (typeof value === "boolean" || value === null || value === undefined)
    return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function requireId(value, field) {
  const id = toId(value);
  if (id === null) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  return id;
}

function shapeRole(row) {
  return { id: row.id, name: row.name, description: row.description };
}

function shapePermission(row) {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    description: row.description,
  };
}

/**
 * Turns a constraint violation into the refusal the caller earned. Both catalogues take
 * their unique constraint names from Postgres's defaults, having been declared with an
 * inline UNIQUE. An unrecognised error is returned untouched.
 *
 * @returns {ApiError | Error}
 */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    if (err.constraint === "permissions_code_key") {
      return ApiError.conflict("A permission with that code already exists.");
    }
    return ApiError.conflict("A role with that name already exists.");
  }

  if (err?.code === FOREIGN_KEY_VIOLATION) {
    return ApiError.badRequest("A referenced record does not exist.");
  }

  return err;
}

export default new Roles();
