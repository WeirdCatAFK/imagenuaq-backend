// Request-side half of src/access/orchestration/auth.js. Nothing here decides anything: it
// reads the header, hands the token to the orchestration layer and puts the result on the
// request. Keeping the verification rules over there means the token's contents are
// described in exactly one file, and this one cannot drift from what login signs.
import auth from '../access/orchestration/auth.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Pull the bearer token out of the Authorization header, or null. Case-insensitive on the
 * scheme: RFC 7235 says the scheme is case-insensitive and some clients send "bearer".
 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;

  return token.trim() || null;
}

/** Requires a valid session token and puts its subject on `req.user`. */
export const authenticate = async (req, _res, next) => {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized('No token provided.');

  req.user = await auth.verifyToken(token);
  next();
};

/**
 * Restrict to named roles, e.g. requireRole('admin', 'area_lead'). Mount after
 * authenticate(); it reads the role that authenticate() put on the request.
 */
export const requireRole = (...roles) => {
  const allowed = new Set(roles);

  return (req, _res, next) => {
    if (!req.user) {
      throw new Error('requireRole() used without authenticate() before it.');
    }

    if (!allowed.has(req.user.role)) {
      throw ApiError.forbidden('Insufficient role for this resource.');
    }

    next();
  };
};

/**
 * Restrict by permission code, e.g. requirePermission('project.write'). Costs one query
 * per request because the codes are read live rather than carried in the token -- see
 * issueToken(): the catalog is editable at runtime (RF-USR-05), so a set frozen into a
 * week-long token would keep granting a permission that coordination has since revoked.
 */
export const requirePermission = (...codes) => {
  return async (req, _res, next) => {
    if (!req.user) {
      throw new Error('requirePermission() used without authenticate() before it.');
    }

    if (!req.permissions) {
      req.permissions = new Set(await auth.permissionsFor(req.user.roleId));
    }

    const missing = codes.filter((code) => !req.permissions.has(code));
    if (missing.length > 0) {
      throw ApiError.forbidden(`Missing permission: ${missing.join(', ')}.`);
    }

    next();
  };
};
