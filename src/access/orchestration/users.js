// Tier 3: creating a staff account. Separate from orchestration/auth.js because they
// answer different questions -- auth decides whether a caller is who they say and what a
// token may claim, this decides what a user record is allowed to look like. The invite
// token that ties the two together is minted by the route, which composes both.
//
// There is deliberately no self-registration. RF-USR-01 groups users into areas and
// RF-USR-02 assigns them one of three role levels; both are decisions the coordination
// makes about a person, not claims the person makes about themselves. An endpoint that let
// a caller pick their own role_id would make RF-USR-06 -- do not edit what is not yours --
// unenforceable, because anyone could ask to be coordination. External requesters are not
// users at all: RF-EXT-03 gives them view-only sight of their own request.
//
// Constraint violations are translated rather than pre-flighted with a select: the
// constraint is the authority, and two callers creating the same email at once then
// resolve correctly instead of both passing a check and one blowing up as a 500.
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
};

/** Deliberately permissive: catches the obvious typo, not undeliverable addresses. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const cleanEmail =
      typeof email === "string" ? email.trim().toLowerCase() : "";
    const cleanName = typeof fullName === "string" ? fullName.trim() : "";
    if (!EMAIL.test(cleanEmail) || cleanEmail.length > 320) {
      throw ApiError.badRequest("A valid email address is required.");
    }
    if (!cleanName || cleanName.length > 200) {
      throw ApiError.badRequest(
        "Full name is required (200 characters or fewer).",
      );
    }

    const role = toId(roleId);
    const contractType = toId(contractTypeId);
    if (role === null) throw ApiError.badRequest("roleId is required.");
    if (contractType === null)
      throw ApiError.badRequest("contractTypeId is required.");

    const area =
      primaryAreaId === null || primaryAreaId === undefined
        ? null
        : toId(primaryAreaId);
    if (
      primaryAreaId !== null &&
      primaryAreaId !== undefined &&
      area === null
    ) {
      throw ApiError.badRequest("primaryAreaId must be a positive integer.");
    }

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
}

/**
 * Coerces a JSON id to a positive integer, or null. Rejects "7abc" and booleans, which
 * Number() would otherwise turn into NaN and 1.
 *
 * @returns {number | null}
 */
function toId(value) {
  if (typeof value === "boolean" || value === null || value === undefined)
    return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
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
