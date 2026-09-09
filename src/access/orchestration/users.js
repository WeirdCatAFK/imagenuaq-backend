// Tier 3: staff accounts -- who exists, what they look like, and when they stop existing.
// Separate from orchestration/auth.js because they answer different questions: auth decides
// whether a caller is who they say and what a token may claim, this decides what a user
// record is allowed to look like. The invite token that ties the two together is minted by
// the route, which composes both.
//
// There is deliberately no self-registration. RF-USR-01 groups users into areas and
// RF-USR-02 assigns them one of three role levels; both are decisions the coordination
// makes about a person, not claims the person makes about themselves. An endpoint that let
// a caller pick their own role_id would make RF-USR-06 -- do not edit what is not yours --
// unenforceable, because anyone could ask to be coordination. External requesters are not
// users at all: RF-EXT-03 gives them view-only sight of their own request.
//
// Four rules run through the module:
//
//   - **Two shapes, one function.** RF-USR-03 lets everyone see their colleagues, so the
//     reads are open to any signed-in caller -- but contract type and birthday are nobody
//     else's business. shapeUser() takes `asAdmin` and is the only place either shape is
//     built, so the two cannot drift apart.
//   - **Deleting is soft, and it revokes.** `deleted_at` plus a bump of `token_version`,
//     because a delete that leaves the session working is a delete that did not happen.
//   - **Updates are merged here, not assembled in SQL.** query.updateUser() writes every
//     column; building a SET list from whichever keys arrived would put string
//     concatenation back into the one module that exists to prevent it.
//   - **Constraint violations are translated, not pre-flighted.** The constraint is the
//     authority, and two callers racing on the same address then resolve correctly instead
//     of both passing a check and one returning a 500.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Constraint name to the request field the caller got wrong. Names come from the
 * migrations; an unlisted one falls through to the generic message.
 */
const FK_FIELDS = {
  fk_users_role_id_roles_id: "roleId",
  fk_users_contract_type_id_contract_types_id: "contractTypeId",
  fk_users_primary_area_id_areas_id: "primaryAreaId",
  fk_area_members_area_id_areas_id: "primaryAreaId",
  fk_users_schedule_id_event_collections_id: "scheduleId",
};

/** Deliberately permissive: catches the obvious typo, not undeliverable addresses. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_MAX = 320;
const NAME_MAX = 200;
const SEARCH_MIN = 2;
const PAGE_MAX = 200;

/** The only image types accepted; the read endpoint serves back whichever was stored. */
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];

class Users {
  /**
   * Creates an account with no password. The route has already established that the
   * caller is an admin, so every failure here is about the payload.
   *
   * @param {object} input
   * @param {string} input.email
   * @param {string} input.fullName
   * @param {number|string} input.roleId Required by RF-USR-02.
   * @param {number|string} input.contractTypeId Required; RF-AUS-04 reads caps from it.
   * @param {number|string|null} [input.primaryAreaId]
   * @param {string|null} [input.birthday]
   * @param {boolean} [input.isAreaLeader] Requires primaryAreaId.
   * @returns {Promise<object>} The user in the shape a session carries, so the route can
   *   mint an invite without a second read.
   * @throws {ApiError} 400 on a bad payload, 409 on a duplicate live email.
   */
  async create({
    email,
    fullName,
    roleId,
    contractTypeId,
    primaryAreaId = null,
    birthday = null,
    isAreaLeader = false,
  }) {
    const cleanEmail = normaliseEmail(email);
    const cleanName = cleanText(fullName);
    requireEmail(cleanEmail);
    requireName(cleanName);

    const role = toId(roleId);
    const contractType = toId(contractTypeId);
    if (role === null) throw ApiError.badRequest("roleId is required.");
    if (contractType === null)
      throw ApiError.badRequest("contractTypeId is required.");

    const area = optionalId(primaryAreaId, "primaryAreaId");

    if (isAreaLeader && area === null) {
      throw ApiError.badRequest("isAreaLeader requires primaryAreaId.");
    }

    try {
      const row = await query.createUser({
        email: cleanEmail,
        fullName: cleanName,
        roleId: role,
        contractTypeId: contractType,
        primaryAreaId: area,
        birthday: birthday || null,
        isAreaLeader: Boolean(isAreaLeader),
      });

      // Emitted whole; audit.js redacts by column name so the rule lives in one place.
      await events.emit({
        action: "record_created",
        target: { table: "users", id: row.id },
        after: row,
      });

      return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        roleId: row.role_id,
        role: row.role_name,
        primaryAreaId: row.primary_area_id,
      };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * A page of users, with each one's areas attached in a second query rather than one per
   * row.
   *
   * @param {object} [options]
   * @param {number|string|null} [options.areaId] Only members of this area.
   * @param {number|string|null} [options.roleId]
   * @param {boolean} [options.includeDeleted] Honoured only for an admin caller.
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @param {boolean} [options.asAdmin]
   * @returns {Promise<{ users: object[], total: number, limit: number, offset: number }>}
   */
  async list({
    areaId = null,
    roleId = null,
    includeDeleted = false,
    limit = 50,
    offset = 0,
    asAdmin = false,
  } = {}) {
    const filters = {
      areaId: optionalId(areaId, "areaId"),
      roleId: optionalId(roleId, "roleId"),
      includeDeleted: asAdmin && Boolean(includeDeleted),
    };
    const page = { limit: clampLimit(limit), offset: clampOffset(offset) };

    const [rows, total] = await Promise.all([
      query.listUsers({ ...filters, ...page }),
      query.countUsers(filters),
    ]);

    return {
      users: await withAreas(rows, asAdmin),
      total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  /**
   * One user with their areas.
   *
   * @param {number|string} userId
   * @param {{ asAdmin?: boolean }} [options]
   * @returns {Promise<object>}
   * @throws {ApiError} 404 when missing or soft-deleted.
   */
  async getById(userId, { asAdmin = false } = {}) {
    const id = requireId(userId, "userId");
    const row = await query.getUser(id);
    if (!row) throw ApiError.notFound("User not found.");

    const [role, areas] = await Promise.all([
      query.getRoleById(row.role_id),
      query.getUserAreas(id),
    ]);

    return {
      ...shapeUser({ ...row, role_name: role?.name ?? null }, asAdmin),
      areas: areas.map(shapeUserArea),
    };
  }

  /**
   * Substring search on name or address, for a picker.
   *
   * @param {string} q
   * @param {{ limit?: number }} [options]
   * @returns {Promise<object[]>} id, fullName and email only — never the wider shape,
   *   since a picker has no use for a contract type, and no `asAdmin` for the same reason.
   * @throws {ApiError} 400 when the query is shorter than two characters.
   */
  async search(q, { limit = 50 } = {}) {
    const term = cleanText(q);
    if (term === null || term.length < SEARCH_MIN) {
      throw ApiError.badRequest(
        `Search query must be at least ${SEARCH_MIN} characters.`,
      );
    }

    const rows = await query.searchUsersByEmailOrFullName(
      term,
      clampLimit(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
    }));
  }

  /**
   * Updates only the keys the caller sent. The current row is read first and merged here.
   *
   * The role is deliberately NOT updatable through this method: changing what somebody may
   * do is a different decision from correcting their birthday, and RF-USR-02 puts it with
   * the role catalogue rather than the profile form.
   *
   * @param {number|string} userId
   * @param {object} changes
   * @returns {Promise<object>}
   * @throws {ApiError} 400 on a bad payload, 404 when missing, 409 on a duplicate email.
   */
  async update(userId, changes = {}) {
    const id = requireId(userId, "userId");
    const current = await query.getUser(id);
    if (!current) throw ApiError.notFound("User not found.");

    const { fullName, email, birthday, contractTypeId, primaryAreaId, scheduleId } =
      changes;

    const merged = {
      fullName:
        fullName === undefined ? current.full_name : cleanText(fullName),
      email: email === undefined ? current.email : normaliseEmail(email),
      birthday: birthday === undefined ? current.birthday : birthday || null,
      contractTypeId:
        contractTypeId === undefined
          ? current.contract_type_id
          : requireId(contractTypeId, "contractTypeId"),
      primaryAreaId:
        primaryAreaId === undefined
          ? current.primary_area_id
          : optionalId(primaryAreaId, "primaryAreaId"),
      scheduleId:
        scheduleId === undefined
          ? current.schedule_id
          : optionalId(scheduleId, "scheduleId"),
    };

    requireName(merged.fullName);
    requireEmail(merged.email);

    try {
      const row = await query.updateUser(id, merged);
      if (!row) throw ApiError.notFound("User not found.");

      await events.emit({
        action: "record_updated",
        target: { table: "users", id },
        before: auditable(current),
        after: auditable(row),
      });

      return shapeUser(row, true);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Soft-deletes an account. query.deleteUser() bumps `token_version` in the same
   * statement, so the person's outstanding tokens stop working at the same instant the
   * row is marked rather than at some point after it.
   *
   * @param {number|string} userId
   * @returns {Promise<object>} The deleted row, shaped.
   * @throws {ApiError} 404 when it does not exist or is already deleted.
   */
  async softDelete(userId) {
    const id = requireId(userId, "userId");
    const row = await query.deleteUser(id);
    if (!row) throw ApiError.notFound("User not found.");

    await events.emit({
      action: "record_deleted",
      target: { table: "users", id },
      before: auditable(row),
    });

    return shapeUser(row, true);
  }

  /**
   * Replaces a user's profile picture.
   *
   * @param {number|string} userId
   * @param {Buffer} bytes
   * @param {string} mime One of PICTURE_TYPES; the route checks the header, this checks
   *   the value, so the column can never hold a type the read endpoint would serve blind.
   * @throws {ApiError} 400 on empty bytes or an unsupported type, 404 when no live row.
   */
  async setPicture(userId, bytes, mime) {
    const id = requireId(userId, "userId");
    if (!bytes || bytes.length === 0) {
      throw ApiError.badRequest("An image body is required.");
    }
    if (!PICTURE_TYPES.includes(mime)) {
      throw ApiError.badRequest(
        `Content-Type must be one of: ${PICTURE_TYPES.join(", ")}.`,
      );
    }

    const had = (await query.getUserProfilePicture(id)) !== null;
    const row = await query.updateProfilePicture(id, { data: bytes, mime });
    if (!row) throw ApiError.notFound("User not found.");

    // Whether there is a picture, never the bytes: audit.js does not redact this column
    // and a log row is not the place for an image.
    await events.emit({
      action: "record_updated",
      target: { table: "users", id },
      before: { profile_picture: had },
      after: { profile_picture: true },
    });
  }

  /**
   * The stored picture with the type it was uploaded as.
   *
   * @param {number|string} userId
   * @returns {Promise<{ data: Buffer, mime: string }>}
   * @throws {ApiError} 404 when the user or the picture is missing.
   */
  async getPicture(userId) {
    const id = requireId(userId, "userId");
    const picture = await query.getUserProfilePicture(id);
    if (picture === null) throw ApiError.notFound("No profile picture set.");
    return picture;
  }

  /**
   * Removes a user's picture, clearing both columns together.
   *
   * @param {number|string} userId
   * @throws {ApiError} 404 when there is no live row.
   */
  async clearPicture(userId) {
    const id = requireId(userId, "userId");
    const had = (await query.getUserProfilePicture(id)) !== null;
    const row = await query.updateProfilePicture(id, { data: null, mime: null });
    if (!row) throw ApiError.notFound("User not found.");

    if (had) {
      await events.emit({
        action: "record_updated",
        target: { table: "users", id },
        before: { profile_picture: true },
        after: { profile_picture: false },
      });
    }
  }
}

/**
 * The API shape of a user. `asAdmin` widens it; everything outside that block is what
 * RF-USR-03 lets any colleague see.
 */
function shapeUser(row, asAdmin) {
  const shaped = {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role_name ?? null,
    roleId: row.role_id,
    primaryAreaId: row.primary_area_id,
  };

  if (asAdmin) {
    shaped.contractTypeId = row.contract_type_id;
    shaped.birthday = row.birthday;
    shaped.createdAt = row.created_at;
    shaped.deletedAt = row.deleted_at ?? null;
  }

  return shaped;
}

/** One of a user's areas, as the list and detail reads both carry it. */
function shapeUserArea(row) {
  return { id: row.id, name: row.name, isAreaLeader: row.is_area_leader };
}

/** Attaches `areas` to a page of rows using one extra query, not one per row. */
async function withAreas(rows, asAdmin) {
  const shaped = rows.map((row) => ({ ...shapeUser(row, asAdmin), areas: [] }));
  if (shaped.length === 0) return shaped;

  const byId = new Map(shaped.map((user) => [user.id, user]));
  const areas = await query.getAreasForUsers(shaped.map((user) => user.id));
  for (const area of areas) {
    byId.get(area.user_id)?.areas.push(shapeUserArea(area));
  }
  return shaped;
}

/**
 * A row with the image bytes removed, for the audit trail. `audit.js` redacts by column
 * name and `profile_picture` matches none of its patterns.
 */
function auditable(row) {
  const { profile_picture, ...rest } = row;
  return rest;
}

/** Trim, lowercase and reject a non-string, so "" and undefined behave the same. */
function normaliseEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** @throws {ApiError} 400 when the address is missing, malformed or too long. */
function requireEmail(email) {
  if (!EMAIL.test(email) || email.length > EMAIL_MAX) {
    throw ApiError.badRequest("A valid email address is required.");
  }
}

/** @throws {ApiError} 400 when the name is missing or too long. */
function requireName(name) {
  if (!name || name.length > NAME_MAX) {
    throw ApiError.badRequest(
      `Full name is required (${NAME_MAX} characters or fewer).`,
    );
  }
}

/**
 * Trims, and turns an empty string into null.
 *
 * @returns {string | null}
 */
function cleanText(value) {
  if (typeof value !== "string") return value == null ? null : value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Coerces a JSON or route-parameter id to a positive integer, or null. Rejects "7abc"
 * and booleans, which Number() would turn into NaN and 1.
 *
 * @returns {number | null}
 */
function toId(value) {
  if (typeof value === "boolean" || value === null || value === undefined)
    return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** @throws {ApiError} 400 when `value` is not a positive integer. */
function requireId(value, field) {
  const id = toId(value);
  if (id === null) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  return id;
}

/** Passes null and undefined through; anything else must parse. */
function optionalId(value, field) {
  if (value === null || value === undefined) return null;
  return requireId(value, field);
}

/** Keeps a page window sane whatever the query string said. */
function clampLimit(limit) {
  const n = toId(limit);
  return n === null ? 50 : Math.min(n, PAGE_MAX);
}

function clampOffset(offset) {
  const n = Number(offset);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Turns a constraint violation into the refusal the caller earned. An unrecognised error
 * is returned untouched, for errorHandler to log in full behind a 500.
 *
 * @returns {ApiError | Error}
 */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    // uq_users_email_live is partial, so a soft-deleted account frees its address.
    return ApiError.conflict("A user with that email address already exists.");
  }

  if (err?.code === FOREIGN_KEY_VIOLATION) {
    const field = FK_FIELDS[err.constraint];
    return ApiError.badRequest(
      field ? `Unknown ${field}.` : "A referenced record does not exist.",
    );
  }

  return err;
}

export default new Users();
