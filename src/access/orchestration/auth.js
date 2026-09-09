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

class Auth {
  /**
   * Hashes and stores a password. The cost factor and the column are one decision, so
   * nothing else may write `password_hash`.
   *
   * @param {number} userId
   * @param {string} password
   * @throws {ApiError} 404 when no live row matched.
   */
  async setPassword(userId, password) {
    if (!password || password.length < 8) {
      throw ApiError.badRequest("Password must be at least 8 characters long.");
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const updated = await query.setPasswordHash(userId, hash);

    // null means no live row matched: a wrong id, or a soft-deleted user.
    if (updated === null) throw ApiError.notFound("User not found.");
  }

  /**
   * Hashes without writing, for scripts/createAdmin.js, which moves the role and the
   * password in one statement and so cannot go through setPassword(). Exists to keep the
   * cost factor in a single place.
   *
   * @param {string} password
   * @returns {Promise<string>}
   */
  async hashPassword(password) {
    if (!password || password.length < 8) {
      throw ApiError.badRequest("Password must be at least 8 characters long.");
    }
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Checks credentials and returns the session subject. Never returns null -- a throw
   * cannot be ignored by a caller that forgets to check, and Express 5 forwards it.
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<object>} The session subject.
   * @throws {ApiError} 401 on any failure, with one message for all of them.
   */
  async authenticate(email, password) {
    if (!email || !password) {
      throw ApiError.badRequest("Email and password are required.");
    }

    // Lowercased to match how users.js stores it; the unique index is on the raw column.
    const user = await query.getAuthUserByEmail(
      String(email).trim().toLowerCase(),
    );

    // password_hash is nullable (an RF-MIG-01 import has a row before a password), so the
    // placeholder makes that case cost the same as a wrong password. It is refused below.
    const hash = user?.password_hash ?? ABSENT_USER_HASH;
    const matches = await bcrypt.compare(password, hash);

    // One message for "no such email", "no password set" and "wrong password".
    if (!user || !user.password_hash || !matches) {
      // The trail may say which it was; it is read by coordination, not returned to the
      // caller. The attempted address is recorded, the attempted password never is. `actor`
      // is explicit because a failed login has no session to read one from.
      await events.emit({
        action: "user_login_failed",
        actor: user?.id ?? null,
        after: {
          email: String(email).trim().toLowerCase(),
          reason: !user
            ? "no such account"
            : !user.password_hash
              ? "account never activated"
              : "wrong password",
        },
      });

      throw ApiError.unauthorized("Invalid email or password.");
    }

    // The actor is established BY this action, so it is passed rather than read from the
    // request context. The area is not passed: query.insertLog() resolves it in the same
    // statement, so there is one source for it.
    await events.emit({
      action: "user_login",
      actor: user.id,
      target: { table: "users", id: user.id },
    });

    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      roleId: user.role_id,
      role: user.role_name,
      areaId: user.primary_area_id ?? null,
      tokenVersion: user.token_version,
    };
  }

  /**
   * Mints a session token. Carries both `role` (the name requireRole() compares) and
   * `roleId` (what a query joins on), so authorising costs no round trip.
   *
   * Permissions are deliberately not included: RF-USR-05 makes the catalog editable at
   * runtime, so a set baked into a week-long token goes stale. Use permissionsFor().
   *
   * @param {object} user
   * @returns {Promise<string>}
   */
  async issueToken(user) {
    return (
      new jose.SignJWT({
        purpose: PURPOSE_SESSION,
        email: user.email,
        fullName: user.fullName,
        roleId: user.roleId,
        role: user.role,
        areaId: user.areaId ?? null,
        // Compared against the row on every request. A bump elsewhere makes every token
        // minted before it stop verifying, which is the whole revocation mechanism.
        tokenVersion: user.tokenVersion ?? 0,
      })
        .setProtectedHeader({ alg: "HS256" })
        // `sub` is the registered claim for the subject; jose requires a string.
        .setSubject(String(user.id))
        .setIssuedAt()
        .setIssuer(issuer())
        .setAudience(audience())
        .setExpirationTime(TOKEN_TTL)
        .sign(jwtSecret())
    );
  }

  /**
   * Verifies signature, expiry, issuer, audience and purpose, then that the account is
   * still live and still at the token's `token_version`. Returns the same shape
   * authenticate() does -- so `req.user` means one thing either way.
   *
   * Role and area come from the row, not from the claims: the same read that proves the
   * token has not been revoked is already paid for, and taking them from a week-old token
   * is what made a role change wait seven days to take effect.
   *
   * @param {string} token
   * @returns {Promise<object>}
   * @throws {ApiError} 401 for every failure mode jose distinguishes, for a deleted
   *   account, and for a revoked token.
   */
  async verifyToken(token) {
    try {
      const { payload } = await jose.jwtVerify(token, jwtSecret(), {
        issuer: issuer(),
        audience: audience(),
      });

      // An invite is signed with the same key and passes every other check; only this keeps
      // a not-yet-activated account from being a working login.
      if (payload.purpose !== PURPOSE_SESSION) {
        throw ApiError.unauthorized("Invalid or expired token.");
      }

      // Last, and deliberately so. Every check above is answerable from the token alone,
      // and each one refuses for its own reason; putting the lookup first would make a
      // forged or expired token fail as "no such user" instead.
      const user = await query.getAuthUserById(Number(payload.sub));
      if (!user || user.token_version !== (payload.tokenVersion ?? 0)) {
        throw ApiError.unauthorized("Invalid or expired token.");
      }

      return {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        roleId: user.role_id,
        role: user.role_name,
        areaId: user.primary_area_id ?? null,
      };
    } catch (err) {
      // A missing JWT_SECRET is a server bug, not a bad token -- a 401 would have clients
      // retrying a login that can never succeed.
      if (!(err instanceof jose.errors.JOSEError)) throw err;
      throw ApiError.unauthorized("Invalid or expired token.");
    }
  }

  /**
   * A one-time link for an account that has no password yet. Carries nothing but the
   * subject, so an admin correcting the role or area before it is redeemed need not
   * re-issue.
   *
   * @param {number} userId
   * @returns {Promise<string>}
   */
  async issueInviteToken(userId) {
    return new jose.SignJWT({ purpose: PURPOSE_INVITE })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(userId))
      .setIssuedAt()
      .setIssuer(issuer())
      .setAudience(audience())
      .setExpirationTime(INVITE_TTL)
      .sign(jwtSecret());
  }

  /**
   * Redeems an invite: sets the password and returns a session, so the new user is logged
   * in rather than bounced to a login form.
   *
   * Single use by construction, with no table and no revocation list -- the invite is valid
   * only while the account has no password, and redeeming it gives the account one. That
   * trick does NOT extend to password resets, which need a hashed single-use token in its
   * own table.
   *
   * @param {string} token
   * @param {string} password
   * @returns {Promise<object>}
   * @throws {ApiError} 401 on a bad token, 404 on a dead user, 409 on a spent invite.
   */
  async completeInvite(token, password) {
    let payload;
    try {
      ({ payload } = await jose.jwtVerify(token, jwtSecret(), {
        issuer: issuer(),
        audience: audience(),
      }));
    } catch (err) {
      if (!(err instanceof jose.errors.JOSEError)) throw err;
      throw ApiError.unauthorized("Invalid or expired invitation.");
    }

    if (payload.purpose !== PURPOSE_INVITE) {
      throw ApiError.unauthorized("Invalid or expired invitation.");
    }

    // Re-read: the user may have been soft-deleted or activated since the invite was sent.
    const user = await query.getAuthUserById(Number(payload.sub));
    if (!user) throw ApiError.unauthorized("Invalid or expired invitation.");

    // The single-use check. 409 and not 401: the link was genuine, it has been spent, and
    // the caller's next move is to log in.
    if (user.password_hash !== null) {
      throw ApiError.conflict("This invitation has already been used.");
    }

    await this.setPassword(user.id, password);

    // Only the state transition; audit.js redacts the hash in any case.
    await events.emit({
      action: "record_updated",
      actor: user.id,
      target: { table: "users", id: user.id },
      before: { activated: false },
      after: { activated: true },
    });

    // The same shape authenticate() returns, so a session minted here is indistinguishable.
    const subject = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      roleId: user.role_id,
      role: user.role_name,
      areaId: user.primary_area_id ?? null,
      tokenVersion: user.token_version,
    };

    return { user: subject, token: await this.issueToken(subject) };
  }

  /**
   * Live permission codes for a role, read on demand rather than carried in the token.
   *
   * @param {number} roleId
   * @returns {Promise<string[]>}
   */
  async permissionsFor(roleId) {
    return query.getRolePermissionCodes(roleId);
  }
}

export default new Auth();
