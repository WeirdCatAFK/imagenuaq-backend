// Tokens the server must refuse: wrong secret, issuer or audience, expired, or missing
// `purpose`. Built by hand because the API never issues them.
import * as jose from 'jose';

const encode = (secret) => new TextEncoder().encode(secret);

const secret = () => encode(process.env.JWT_SECRET);
const issuer = () => process.env.API_DOMAIN || 'http://localhost:3000';
const audience = () => process.env.FRONTEND_DOMAIN || 'http://localhost:5173';

/**
 * One builder, so a negative token differs from a valid one in exactly the field under
 * test. A test that changed two things at once would pass for the wrong reason.
 */
export function mint({
  subject = '1',
  purpose = 'session',
  claims = {},
  key = secret(),
  iss = issuer(),
  aud = audience(),
  expiresIn = '7d',
} = {}) {
  const payload = purpose === null ? { ...claims } : { purpose, ...claims };

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(expiresIn)
    .sign(key);
}

export const wrongSecret = (options) =>
  mint({ ...options, key: encode('a-completely-different-key-of-sufficient-length') });

export const wrongIssuer = (options) => mint({ ...options, iss: 'http://evil.example' });

export const wrongAudience = (options) => mint({ ...options, aud: 'http://evil.example' });

export const expired = (options) => mint({ ...options, expiresIn: '-1s' });

export const noPurpose = (options) => mint({ ...options, purpose: null });

/**
 * A well-formed session token for a user, identical in every claim to what issueToken()
 * produces. Used by the role-guard tests so they cost one signature instead of a bcrypt
 * comparison each -- the login path that would otherwise mint these is covered in full by
 * auth.login.test.js, so re-walking it per guard test buys nothing but seconds.
 */
export const session = (user) =>
  mint({
    subject: String(user.id),
    purpose: 'session',
    claims: {
      email: user.email,
      fullName: user.full_name,
      roleId: user.role_id,
      role: user.role_name,
      areaId: user.primary_area_id ?? null,
      tokenVersion: user.token_version ?? 0,
    },
  });

export const GARBAGE = 'not.a.jwt';
