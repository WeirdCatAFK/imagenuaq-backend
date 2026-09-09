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
import query from '../resources/query.js';
import { ApiError } from '../../utils/ApiError.js';

// Postgres error codes. Checking these beats pre-flighting each value with its own select:
// the constraint is the authority, and two callers creating the same email at once resolve
// correctly instead of both passing a check and one blowing up as a 500.
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

// Which constraint failed maps to which field the caller got wrong. Names come from the
// migrations; a renamed constraint should be renamed here too, and until then falls
// through to the generic message rather than reporting the wrong field.
const FK_FIELDS = {
  fk_users_role_id_roles_id: 'roleId',
  fk_users_contract_type_id_contract_types_id: 'contractTypeId',
  fk_users_primary_area_id_areas_id: 'primaryAreaId',
  fk_area_members_area_id_areas_id: 'primaryAreaId',
};

// Deliberately permissive. The authority on what is a deliverable address is whether mail
// arrives, and a stricter regex reliably rejects real addresses (plus tags, new TLDs,
// apostrophes) while still admitting undeliverable ones. This only catches the obvious
// typo; 320 is the column width.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Users {
  // Create an account with no password. The caller is an authenticated admin -- the route
  // enforces that -- so the failures here are about the *payload*, not about permission.
  //
  // Returns the created user in the same shape a session carries, so the route can mint an
  // invite for it without a second read.
  async create({
    email,
    fullName,
    roleId,
    contractTypeId,
    primaryAreaId = null,
    birthday = null,
    isAreaLeader = false,
  }) {
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const cleanName = typeof fullName === 'string' ? fullName.trim() : '';

    // Lowercased on the way in because the uniqueness guarantee is a plain unique index on
    // the column: without this, Ana@uaq.mx and ana@uaq.mx are two accounts, and the login
    // lookup finds whichever was typed. Normalising at the one place rows are created is
    // cheaper than a functional index and a matching lower() in every query.
    if (!EMAIL.test(cleanEmail) || cleanEmail.length > 320) {
      throw ApiError.badRequest('A valid email address is required.');
    }
    if (!cleanName || cleanName.length > 200) {
      throw ApiError.badRequest('Full name is required (200 characters or fewer).');
    }

    // Required by the schema and by RF-USR-02: a user with no role has no visibility rules
    // to apply, and contract type is what RF-AUS-04 later reads absence caps from.
    const role = toId(roleId);
    const contractType = toId(contractTypeId);
    if (role === null) throw ApiError.badRequest('roleId is required.');
    if (contractType === null) throw ApiError.badRequest('contractTypeId is required.');

    const area = primaryAreaId === null || primaryAreaId === undefined
      ? null
      : toId(primaryAreaId);
    if (primaryAreaId !== null && primaryAreaId !== undefined && area === null) {
      throw ApiError.badRequest('primaryAreaId must be a positive integer.');
    }

    // A leader flag without an area has nowhere to apply. Accepting it silently would
    // record a decision that never took effect.
    if (isAreaLeader && area === null) {
      throw ApiError.badRequest('isAreaLeader requires primaryAreaId.');
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

// Ids arrive from JSON, so "7" and 7 both turn up. Number() alone would accept "7abc" as
// NaN and true as 1; this returns null for anything that is not a positive integer, and
// the caller decides whether that is a 400 or a legitimate absence.
function toId(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Turn a constraint violation into the refusal the caller earned. Anything unrecognised is
// re-thrown untouched: errorHandler logs a non-ApiError in full and hides it behind a 500,
// which is the correct treatment for a database error nobody predicted.
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    // The live-only partial index (uq_users_email_live) means this fires for an active
    // account and stays silent for a soft-deleted one whose address is free again.
    return ApiError.conflict('A user with that email address already exists.');
  }

  if (err?.code === FOREIGN_KEY_VIOLATION) {
    const field = FK_FIELDS[err.constraint];
    return ApiError.badRequest(
      field ? `Unknown ${field}.` : 'A referenced record does not exist.',
    );
  }

  return err;
}

export default new Users();
