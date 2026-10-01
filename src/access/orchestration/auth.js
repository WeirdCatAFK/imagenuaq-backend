// Tier 3: everything that decides *whether* a request becomes a session, and what that
// session then claims. Password hashing, credential checking and token signing/verification
// live together because they are one rule read from both ends -- what goes into a token
// here is exactly what the middleware trusts on the way back. This tier owns the refusals:
// it throws ApiError, so the routes stay four lines.
//
// Three decisions worth knowing before changing anything here:
//
//   - **A verified token is checked against its row.** verifyToken() costs one primary-key
//     lookup, and it buys two things a stateless token cannot: a deleted or revoked account
//     stops working at once rather than when its token expires, and `role` and `areaId`
//     come from the row, so a change takes effect on the next request instead of in seven
//     days. This reverses an earlier decision that nothing would re-read the database here;
//     a shorter TOKEN_TTL was the alternative and it shortens the window without closing
//     it. Permissions are still NOT read here -- requirePermission() does that separately,
//     per request, because the catalog is editable at runtime (RF-USR-05).
//   - **A missing email and a wrong password must cost the same.** Without the padding
//     hash a missing user returns in microseconds while a real comparison takes ~250ms,
//     which is a free "does this address have an account?" oracle for anyone with a
//     stopwatch. One refusal message, for the same reason.
//   - **An invite is a token like any other and must say what it is for.** Without the
//     `purpose` claim verifyToken() would accept an invite as a session, handing a full
//     login to somebody who has not chosen a password yet.
import bcrypt from "bcrypt";
import * as jose from "jose";

import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";

const SALT_ROUNDS = 12;

/**
 * A syntactically valid bcrypt hash of a string nobody will ever send, compared against
 * when the email matches no account. bcrypt.compare() rejects a malformed hash outright,
 * so the padding has to be real.
 */
const ABSENT_USER_HASH =
  "$2b$12$Y8bJW7j4VeZFKWsqTRTpiug1BeJKXqA.7A6wSVndckjEKYw5rGz36";

/** Session lifetime. Long enough that staff are not re-typing a password daily. */
const TOKEN_TTL = "7d";

/** Token purposes. Each verifier demands its own and rejects the other. */
const PURPOSE_SESSION = "session";
const PURPOSE_INVITE = "invite";
const PURPOSE_MS_CONNECT = "ms_connect";

/** How long a Microsoft sign-in may take between leaving here and coming back. */
const MS_CONNECT_TTL = "10m";

/** Invite lifetime. Shorter than a session: it travels by email or chat and lingers. */
const INVITE_TTL = "3d";

/**
 * Read lazily and cached. `new TextEncoder().encode(undefined)` yields the bytes of the
 * string "undefined", which signs and verifies perfectly well and is not a secret, so
 * this fails loudly on first use instead.
 */
let secretKey = null;
function jwtSecret() {
  if (secretKey) return secretKey;

  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET is unset or shorter than the 32 bytes HS256 needs (see .env.example).",
    );
  }

  secretKey = new TextEncoder().encode(secret);
  return secretKey;
}

/**
 * Pinned into every token and re-checked on every verification, so a token minted by
 * another deployment is rejected even if the secret leaked. These fall back to the dev
 * URLs the way HOST/PORT do; JWT_SECRET gets no such courtesy.
 */
const issuer = () => process.env.API_DOMAIN || "http://localhost:3000";
const audience = () => process.env.FRONTEND_DOMAIN || "http://localhost:5173";

/** Signs a token for `subjectId` carrying `purpose` and any extra claims. */
function sign(purpose, subjectId, ttl, claims = {}) {
  return new jose.SignJWT({ purpose, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(subjectId))
    .setIssuedAt()
    .setIssuer(issuer())
    .setAudience(audience())
    .setExpirationTime(ttl)
    .sign(jwtSecret());
}

/**
 * Verifies signature, expiry, issuer, audience and purpose.
 *
 * @returns {Promise<object>} The payload.
 * @throws {ApiError} 401 with `message` on any failure.
 */
async function verify(token, purpose, message) {
  let payload;
  try {
    ({ payload } = await jose.jwtVerify(token, jwtSecret(), {
      issuer: issuer(),
      audience: audience(),
    }));
  } catch (err) {
    if (!(err instanceof jose.errors.JOSEError)) throw err;
    throw ApiError.unauthorized(message);
  }
  if (payload.purpose !== purpose) throw ApiError.unauthorized(message);
  return payload;
}

/** The session subject: what `req.user` holds and what a login returns. */
function toSubject(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    roleId: row.role_id,
    role: row.role_name,
    areaId: row.primary_area_id ?? null,
  };
}

class Auth {
  /**
   * Hashes and stores a password. Nothing else may write `password_hash`.
   *
   * @param {number} userId
   * @param {string} password
   * @throws {ApiError} 400 when shorter than 8 characters, 404 when no live row matched.
   */
  async setPassword(userId, password) {
    const hash = await this.hashPassword(password);
    const updated = await query.setPasswordHash(userId, hash);
    if (updated === null) throw ApiError.notFound("User not found.");
  }

  /**
   * A person changing their own password, after checking the current one. Does not bump
   * `token_version`, which would sign the caller out of the session they are using.
   *
   * @param {number} userId The caller's own id, from the session.
   * @param {string} currentPassword
   * @param {string} newPassword
   * @throws {ApiError} 400 when a field is missing or the new one is too short, 401 when
   *   the current password is wrong, 404 when no live row matched.
   */
  async changePassword(userId, currentPassword, newPassword) {
    if (!currentPassword || !newPassword) {
      throw ApiError.badRequest("Current and new passwords are required.");
    }

    const user = await query.getAuthUserById(userId);
    if (!user) throw ApiError.notFound("User not found.");

    const matches = await bcrypt.compare(currentPassword, user.password_hash ?? ABSENT_USER_HASH);
    if (!user.password_hash || !matches) {
      throw ApiError.unauthorized("Current password is incorrect.");
    }

    await this.setPassword(user.id, newPassword);
    await events.emit({
      action: "record_updated",
      target: { table: "users", id: user.id },
      before: { password_changed: false },
      after: { password_changed: true },
    });
  }

  /**
   * Hashes without writing, for scripts/createAdmin.js. Keeps the cost factor in one place.
   *
   * @param {string} password
   * @returns {Promise<string>}
   * @throws {ApiError} 400 when shorter than 8 characters.
   */
  async hashPassword(password) {
    if (!password || password.length < 8) {
      throw ApiError.badRequest("Password must be at least 8 characters long.");
    }
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Checks credentials and returns the session subject. A missing account, one never
   * activated and a wrong password cost the same time and get the same message.
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<object>} The session subject.
   * @throws {ApiError} 400 when a field is missing, 401 on any failure.
   */
  async authenticate(email, password) {
    if (!email || !password) {
      throw ApiError.badRequest("Email and password are required.");
    }

    const address = String(email).trim().toLowerCase();
    const user = await query.getAuthUserByEmail(address);
    const matches = await bcrypt.compare(password, user?.password_hash ?? ABSENT_USER_HASH);

    if (!user || !user.password_hash || !matches) {
      await events.emit({
        action: "user_login_failed",
        actor: user?.id ?? null,
        after: {
          email: address,
          reason: !user
            ? "no such account"
            : !user.password_hash
              ? "account never activated"
              : "wrong password",
        },
      });
      throw ApiError.unauthorized("Invalid email or password.");
    }

    await events.emit({
      action: "user_login",
      actor: user.id,
      target: { table: "users", id: user.id },
    });

    return toSubject(user);
  }

  /**
   * Mints a session token. Permissions are not in it: RF-USR-05 makes them editable at
   * runtime, so requirePermission() reads them per request.
   *
   * @param {object} user A session subject.
   * @returns {Promise<string>}
   */
  async issueToken(user) {
    const row = await query.getAuthUserById(Number(user.id));
    return sign(PURPOSE_SESSION, user.id, TOKEN_TTL, {
      email: user.email,
      fullName: user.fullName,
      roleId: user.roleId,
      role: user.role,
      areaId: user.areaId ?? null,
      tokenVersion: row?.token_version ?? 0,
    });
  }

  /**
   * Verifies a session token, then that the account is still live and at the token's
   * `token_version`. Role and area are read from the row, not the claims.
   *
   * @param {string} token
   * @returns {Promise<object>} The session subject.
   * @throws {ApiError} 401 on a bad token, a deleted account or a revoked token.
   */
  async verifyToken(token) {
    const message = "Invalid or expired token.";
    const payload = await verify(token, PURPOSE_SESSION, message);

    const user = await query.getAuthUserById(Number(payload.sub));
    if (!user || user.token_version !== (payload.tokenVersion ?? 0)) {
      throw ApiError.unauthorized(message);
    }
    return toSubject(user);
  }

  /**
   * A one-time link for an account that has no password yet.
   *
   * @param {number} userId
   * @returns {Promise<string>}
   */
  async issueInviteToken(userId) {
    return sign(PURPOSE_INVITE, userId, INVITE_TTL);
  }

  /**
   * The `state` for a Microsoft sign-in (RF-MIG-01): how the public callback learns who was
   * connecting.
   *
   * @param {number} userId
   * @returns {Promise<string>}
   */
  async issueConnectState(userId) {
    return sign(PURPOSE_MS_CONNECT, userId, MS_CONNECT_TTL);
  }

  /**
   * Verifies a `state` issued by issueConnectState().
   *
   * @param {string} state
   * @returns {Promise<number>} The user id it names.
   * @throws {ApiError} 401 on a missing, tampered, expired or wrong-purpose state.
   */
  async verifyConnectState(state) {
    const message = "Invalid or expired sign-in state.";
    if (typeof state !== "string" || state === "") throw ApiError.unauthorized(message);
    const payload = await verify(state, PURPOSE_MS_CONNECT, message);
    return Number(payload.sub);
  }

  /**
   * Redeems an invite: sets the password and returns a session. Single use because the
   * invite is only valid while the account has no password.
   *
   * @param {string} token
   * @param {string} password
   * @returns {Promise<{ user: object, token: string }>}
   * @throws {ApiError} 401 on a bad token or a dead user, 409 on a spent invite.
   */
  async completeInvite(token, password) {
    const message = "Invalid or expired invitation.";
    const payload = await verify(token, PURPOSE_INVITE, message);

    const user = await query.getAuthUserById(Number(payload.sub));
    if (!user) throw ApiError.unauthorized(message);
    if (user.password_hash !== null) {
      throw ApiError.conflict("This invitation has already been used.");
    }

    await this.setPassword(user.id, password);
    await events.emit({
      action: "record_updated",
      actor: user.id,
      target: { table: "users", id: user.id },
      before: { activated: false },
      after: { activated: true },
    });

    const subject = toSubject(user);
    return { user: subject, token: await this.issueToken(subject) };
  }

  /**
   * Live permission codes for a role.
   *
   * @param {number} roleId
   * @returns {Promise<string[]>}
   */
  async permissionsFor(roleId) {
    return query.getRolePermissionCodes(roleId);
  }
}

export default new Auth();
