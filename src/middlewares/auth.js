// Request-side half of src/access/orchestration/auth.js. Nothing here decides anything: it
// reads the header, hands the token to the orchestration layer and puts the result on the
// request. Keeping the verification rules over there means the token's contents are
// described in exactly one file, and this one cannot drift from what login signs.
import auth from '../access/orchestration/auth.js';
import { ApiError } from '../utils/ApiError.js';

// Pull the bearer token out of the Authorization header, or null. Case-insensitive on the
// scheme: RFC 7235 says the scheme is case-insensitive and some clients send "bearer".
function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;

  return token.trim() || null;
}

// Require a valid token. Populates req.user with { id, email, fullName, roleId, role }.

export const authenticate = async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized('No token provided.');

  // A malformed, expired or foreign-issuer token is 401, not 403. 403 means "we know who
  // you are and you still may not"; sending it for a stale token tells the frontend to
  // give up when what it should do is log the user in again.
  req.user = await auth.verifyToken(token);
  next();
};

// Attach req.user when a token is present, but let the request through when it is not.
// For endpoints whose response differs for a signed-in user without being restricted --
// an external requester following a project (RF-EXT-03) sees the same page as staff, with
// less on it. A token that IS present must still be valid; ignoring a bad one would let a
// tampered token silently downgrade into an anonymous request.
export const optionalAuthenticate = async (req, _res, next) => {
  const token = bearerToken(req);
  if (token) req.user = await auth.verifyToken(token);
  next();
};

// Restrict to named roles, e.g. requireRole('admin', 'area_lead'). Mount after
// authenticate(); it reads the role that authenticate() put on the request.
//
// Role names, not ids: roles.name is the stable identifier ('admin', 'area_lead',
// 'worker', 'finance') and an id is whatever the sequence handed out on that machine, so
// an id here would break the moment the database is rebuilt.
export const requireRole = (...roles) => {
  const allowed = new Set(roles);

  return (req, _res, next) => {
    // A programming error, not a client one: this middleware was mounted without
    // authenticate() in front of it. Saying so beats a 403 that no correct request can
    // ever get past.
    if (!req.user) {
      throw new Error('requireRole() used without authenticate() before it.');
    }

    if (!allowed.has(req.user.role)) {
      throw ApiError.forbidden('Insufficient role for this resource.');
    }

    next();
  };
};

// Restrict by permission code, e.g. requirePermission('project.write'). Costs one query
// per request because the codes are read live rather than carried in the token -- see
// issueToken(): the catalog is editable at runtime (RF-USR-05), so a set frozen into a
// week-long token would keep granting a permission that coordination has since revoked.
export const requirePermission = (...codes) => {
  return async (req, _res, next) => {
    if (!req.user) {
      throw new Error('requirePermission() used without authenticate() before it.');
    }

    const granted = await auth.permissionsFor(req.user.roleId);

    // Every listed code must be held, not any of them. Read and write are independent
    // permissions (RF-USR-05), so a handler that does both has to ask for both.
    const missing = codes.filter((code) => !granted.includes(code));
    if (missing.length > 0) {
      throw ApiError.forbidden(`Missing permission: ${missing.join(', ')}.`);
    }

    next();
  };
};
