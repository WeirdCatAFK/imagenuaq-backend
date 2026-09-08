// Tier 3: everything that decides *whether* a request is allowed to become a session, and
// what that session then claims. Password hashing, credential checking and token
// signing/verification live together because they are one rule read from both ends --
// what goes into a token here is exactly what the middleware trusts on the way back.
//
// This tier owns the refusals: it throws ApiError, so the routes below it stay four lines
// and the middleware does not have to invent status codes of its own.
import bcrypt from "bcrypt";
import * as jose from "jose";

import query from "../resources/query.js";
import { ApiError } from "../../utils/ApiError.js";

const SALT_ROUNDS = 12;

// A real bcrypt hash of a string nobody will ever send, compared against when the email
// does not exist. Without it a missing user returns in microseconds while a wrong password
// takes ~250ms, and that difference is a free "does this address have an account?" oracle
// for anyone with a stopwatch. It must be a syntactically valid hash -- bcrypt.compare()
// rejects a malformed one immediately and the padding would do nothing.
const ABSENT_USER_HASH =
  "$2b$12$Y8bJW7j4VeZFKWsqTRTpiug1BeJKXqA.7A6wSVndckjEKYw5rGz36";

// Tokens live a week. Long enough that staff are not re-typing a password daily, short
// enough that a revoked account stops working without a token blocklist -- which is the
// trade being made here, because nothing re-reads the database on a verified token. A user
// deleted or given a different role today keeps the old role until their token expires;
// when that becomes unacceptable the fix is a `token_version` column on users compared at
// verification, not a shorter TTL.
const TOKEN_TTL = "7d";

// An invite is a token like any other, so it must say what it is for. Without a `purpose`
// claim the two are interchangeable: an invite token would be accepted as a session by
// verifyToken(), handing a full login to somebody who has not chosen a password yet. Each
// verifier demands its own purpose and rejects the other.
const PURPOSE_SESSION = "session";
const PURPOSE_INVITE = "invite";

// How long a new user has to choose a password before an admin must re-issue. Shorter than
// a session on purpose: an invite is a bearer credential for an account with no password
// on it, and it travels by email or chat, where it lingers.
const INVITE_TTL = "3d";

// Read lazily rather than at import time, and cached after the first read. main.js loads
// .env with --env-file-if-exists, so the value *is* present by the time a request arrives
// -- but `new TextEncoder().encode(undefined)` silently yields the bytes of the string
// "undefined", which signs and verifies perfectly well and is not a secret. Failing loudly
// on first use is the only way that misconfiguration ever surfaces.
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

// Issuer and audience are pinned into every token and re-checked on every verification, so
// a token minted by another deployment -- staging, a colleague's laptop -- is rejected even
// if it was signed with the same leaked secret. They fall back to the dev URLs because
// HOST/PORT in src/api.js do the same; JWT_SECRET above gets no such courtesy.
const issuer = () => process.env.API_DOMAIN || "http://localhost:3000";
const audience = () => process.env.FRONTEND_DOMAIN || "http://localhost:5173";

class Auth {
  // Hash and store. Kept here rather than in a future users orchestration because the cost
  // factor and the column are one decision: nothing else may write password_hash.
  async setPassword(userId, password) {
    if (!password || password.length < 8) {
      throw ApiError.badRequest("Password must be at least 8 characters long.");
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const updated = await query.setPasswordHash(userId, hash);

    // null means no live row matched -- a wrong id, or a soft-deleted user. Hashing into
    // nowhere would report success and leave the account unusable.
    if (updated === null) throw ApiError.notFound("User not found.");
  }

  // Hash without writing. Exists for scripts/createAdmin.js, which has to move the role
  // and the password in a single statement and so cannot go through setPassword(). Keeping
  // the cost factor in one place is the whole point: a recovery script that hashed at its
  // own cost would still verify, and would quietly leave one account weaker than the rest.
  async hashPassword(password) {
    if (!password || password.length < 8) {
      throw ApiError.badRequest("Password must be at least 8 characters long.");
    }
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  // Returns the session subject, or throws. Never returns null: a caller that forgets to
  // check for one lets an unauthenticated request through, whereas a throw cannot be
  // ignored, and Express 5 forwards it to the error handler on its own.
  async authenticate(email, password) {
    if (!email || !password) {
      throw ApiError.badRequest("Email and password are required.");
    }

    // Lowercased to match how orchestration/users.js stores it. The uniqueness guarantee
    // is a plain index on the column, so without this a user created as ana@uaq.mx cannot
    // log in by typing Ana@uaq.mx -- which is exactly what a phone keyboard produces.
    const user = await query.getAuthUserByEmail(
      String(email).trim().toLowerCase(),
    );

    // password_hash is nullable: a user brought in by the Excel migration (RF-MIG-01) has
    // a row long before anyone sets them a password. Comparing against the placeholder
    // makes that case cost the same as a wrong password, and it is refused below.
    const hash = user?.password_hash ?? ABSENT_USER_HASH;
    const matches = await bcrypt.compare(password, hash);

    // One message for "no such email", "no password set" and "wrong password". Splitting
    // them is friendlier and tells an attacker which addresses are worth guessing at.
    if (!user || !user.password_hash || !matches) {
      throw ApiError.unauthorized("Invalid email or password.");
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      roleId: user.role_id,
      role: user.role_name,
    };
  }

  // The role travels in the token so authorising a request costs no query. Both forms are
  // carried on purpose: `role` is the name the frontend and requireRole() compare against,
  // `roleId` is what a query joins on, and deriving either from the other would put a
  // database round trip back into every request.
  //
  // Permissions are deliberately NOT in here. RF-USR-05 makes read and write independent
  // and the catalog is editable at runtime, so a permission set baked into a week-long
  // token goes stale the moment coordination edits a role. Read them per request with
  // permissionsFor() instead.
  async issueToken(user) {
    return (
      new jose.SignJWT({
        purpose: PURPOSE_SESSION,
        email: user.email,
        fullName: user.fullName,
        roleId: user.roleId,
        role: user.role,
      })
        .setProtectedHeader({ alg: "HS256" })
        // `sub`, not a custom userId claim: it is the registered JWT claim for the subject.
        // jose requires it to be a string, so it is read back with Number().
        .setSubject(String(user.id))
        .setIssuedAt()
        .setIssuer(issuer())
        .setAudience(audience())
        .setExpirationTime(TOKEN_TTL)
        .sign(jwtSecret())
    );
  }

  // Verify signature, expiry, issuer and audience, and hand back the same shape
  // authenticate() returns -- so req.user means one thing whether the request just logged
  // in or arrived with a token. jose throws a typed error per failure mode; they collapse
  // to one 401 for the same reason the login message is single.
  async verifyToken(token) {
    try {
      const { payload } = await jose.jwtVerify(token, jwtSecret(), {
        issuer: issuer(),
        audience: audience(),
      });

      // Signature, issuer, audience and expiry all pass for an invite token too -- it is
      // signed with the same key. Only this check keeps a not-yet-activated account from
      // being a working login.
      if (payload.purpose !== PURPOSE_SESSION) {
        throw ApiError.unauthorized("Invalid or expired token.");
      }

      return {
        id: Number(payload.sub),
        email: payload.email,
        fullName: payload.fullName,
        roleId: payload.roleId,
        role: payload.role,
      };
    } catch (err) {
      // A missing JWT_SECRET is a server bug, not a bad token. Reporting it as a 401 would
      // have every client retrying a login that can never succeed.
      if (!(err instanceof jose.errors.JOSEError)) throw err;
      throw ApiError.unauthorized("Invalid or expired token.");
    }
  }

  // A one-time link for a user who has just been created and has no password yet. It
  // carries nothing but the subject: the role and area are read fresh when the invite is
  // redeemed, so an admin correcting either between creating the user and the user
  // clicking the link does not have to re-issue.
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

  // Redeem an invite: set the password it was issued for, and hand back a session so the
  // new user is logged in rather than bounced to a login form they just set credentials
  // for.
  //
  // Single use, with no table and no revocation list to keep: the invite is valid only
  // while the account still has no password, and redeeming it gives the account one. A
  // replayed link therefore fails on its second use by construction. The cost of that
  // trick is that it cannot be reused for password *resets*, where a hashed single-use
  // token in its own table is the right shape -- do not extend this to cover them.
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

    // Re-read the row rather than trusting the token's age. The user may have been
    // soft-deleted since the invite was sent, and the account may already be active.
    const user = await query.getAuthUserById(Number(payload.sub));
    if (!user) throw ApiError.unauthorized("Invalid or expired invitation.");

    // The single-use check. A 409 and not a 401: the link was genuine, it has simply been
    // spent, and the caller's next move is to log in, not to ask for another invite.
    if (user.password_hash !== null) {
      throw ApiError.conflict("This invitation has already been used.");
    }

    await this.setPassword(user.id, password);

    const subject = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      roleId: user.role_id,
      role: user.role_name,
    };

    return { user: subject, token: await this.issueToken(subject) };
  }

  // Live permission codes for a role, read on demand rather than carried in the token
  // (see issueToken).
  async permissionsFor(roleId) {
    return query.getRolePermissionCodes(roleId);
  }
}

export default new Auth();
