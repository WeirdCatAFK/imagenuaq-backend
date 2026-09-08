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
// See DATAMODEL.md §5.2. The other half of that section, moving `role_id` onto
// `area_members` so a role can differ per area, is still open and still its own branch.
import query from "../resources/query.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

// Column widths from the initial-schema and role-permissions migrations. Checking them
// here turns Postgres's 22001 -- a 500 that names no field -- into a 400 that does.
const ROLE_NAME_MAX = 50;
const PERMISSION_CODE_MAX = 100;
const PERMISSION_LABEL_MAX = 200;

// The seeded catalogue is `resource.action`: project.read, absence.reason.read. Enforcing
// the shape is not pedantry -- requirePermission() compares these strings literally, so
// `Project Read` and `project.read` are two different permissions that look like one to
// whoever grants them. Dots may repeat, which is what absence.reason.read needs.
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
      return shapeRole(
        await query.createRole({
          name: cleanName,
          description: cleanText(description),
        }),
      );
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

  // Partial, merged against the current row -- see Areas.update() for why the merge happens
  // here and not by assembling a SET list in query.js.
  //
  // Renaming a role is allowed and is more dangerous than it looks: requireRole() compares
  // `roles.name`, and every JWT already issued carries the OLD name for seven days. A rename
  // therefore locks out everyone holding a live token until they log in again. That is a
  // consequence of not re-reading the database on a verified token, documented in
  // orchestration/auth.js, and the reason a rename is not something to do casually.
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
      return shapeRole(role);
    } catch (err) {
      throw translate(err);
    }
  }

  // Refused while anyone still holds it, and the count is in the message because "409" on
  // its own leaves the admin guessing how much work reassigning is.
  //
  // No automatic reassignment: `users.role_id` is NOT NULL, so the alternative to refusing
  // is picking a role for those users, which silently grants or revokes access on their
  // behalf. The foreign key would refuse too; this check exists to say WHY.
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
      return shapeRole(role);
    } catch (err) {
      // The race the count above cannot close: a user assigned this role between the count
      // and the delete. The foreign key catches it, and this turns it into the same 409.
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
    // Trimmed but NOT case-folded. Lower-casing the input first would let `Project.Read`
    // through the pattern below and then collide with the seeded `project.read`, so the
    // caller gets a 409 about a permission they did not think they were creating. The code
    // is a machine name compared literally by requirePermission(); silently rewriting it is
    // how a caller ends up holding something other than what they asked for.
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
      return shapePermission(
        await query.createPermission({
          code: cleanCode,
          label: cleanLabel,
          description: cleanText(description),
        }),
      );
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
      return shapePermission(permission);
    } catch (err) {
      throw translate(err);
    }
  }

  // Deleting a permission revokes it from every role, by the cascade on role_permissions.
  // That is survivable in a way deleting a role is not: requirePermission() fails closed on
  // a code nobody holds, so the worst outcome is a route that refuses everyone, which is
  // visible immediately. A user with no role, by contrast, cannot exist.
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

  // `granted` is false when the role already held it. Not an error: the caller asked for
  // the grant to exist and it does. The route turns the flag into 201 versus 200.
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

    return { roleId: role, permissionId: permission, revoked: true };
  }

  // Replace a role's whole grant set, by code rather than by id. Codes because they are
  // what the requirement is written in and what requirePermission() compares -- an admin
  // screen posting ids would be posting sequence values that differ per database, and the
  // same request would grant different permissions on staging and in production.
  //
  // The set is resolved to ids here so query.js can do the replacement in one statement:
  // a delete-then-insert pair leaves the role holding nothing in between, and a request
  // arriving in that window is refused for a reason that has nothing to do with it.
  async setPermissions(roleId, codes) {
    const id = requireId(roleId, "roleId");
    if (!(await query.getRoleById(id))) {
      throw ApiError.notFound("Role not found.");
    }

    if (!Array.isArray(codes)) {
      throw ApiError.badRequest("permissions must be an array of permission codes.");
    }

    // Deduplicated, because the same code twice is one grant and would otherwise make the
    // length comparison below report a phantom unknown code.
    const wanted = [
      ...new Set(
        codes.map((code) => {
          // Trimmed only, for the same reason as createPermission(): a lookup that
          // case-folds would make `Project.Read` resolve here and be refused there, which
          // is worse than either behaviour on its own.
          const clean = cleanText(code);
          if (!clean) {
            throw ApiError.badRequest("permissions must be non-empty strings.");
          }
          return clean;
        }),
      ),
    ];

    // Resolved one by one rather than in a single IN (...): the caller deserves to be told
    // WHICH code was wrong, and a count mismatch cannot say. The list is eleven rows today
    // and is a catalogue, not a table that grows with usage.
    const ids = [];
    for (const code of wanted) {
      const permission = await query.getPermissionByCode(code);
      if (!permission) {
        throw ApiError.badRequest(`Unknown permission code: ${code}.`);
      }
      ids.push(permission.id);
    }

    try {
      return (await query.setRolePermissions(id, ids)).map(shapePermission);
    } catch (err) {
      throw translate(err);
    }
  }
}

// Trim, and turn an empty string into null -- see the same helper in orchestration/
// areas.js. Duplicated rather than shared: the day one of these modules needs a different
// rule, a shared helper is where the special case would go, and a special case in a helper
// used by everything is how a validation rule stops being readable.
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

// Both catalogues take their unique constraint names from Postgres's defaults, because
// both were declared with an inline UNIQUE in the initial-schema and role-permissions
// migrations. Anything unrecognised is re-thrown untouched.
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
