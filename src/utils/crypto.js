// Symmetric encryption for credentials the database has to hold and hand back.
//
// The only such credential today is a Microsoft refresh token (microsoft_accounts,
// RF-MIG-01). A hash will not do -- the token has to be presented to Microsoft again, not
// merely recognised -- so it is sealed with AES-256-GCM under a key that lives in .env and
// never in the database. Stealing a database dump then yields ciphertext; stealing the
// dump AND the server's environment yields the tokens, which is the honest limit of
// encrypting at rest.
//
// GCM rather than CBC because it authenticates: a flipped byte in the column is detected
// as tampering instead of being decrypted into garbage that is then sent to Microsoft. A
// fresh random IV per call is what makes sealing the same token twice give different
// bytes, so the column reveals nothing about which accounts share a credential.
//
// Layout of the stored buffer: iv (12 bytes) || auth tag (16 bytes) || ciphertext. Fixed
// widths, so no framing is needed and open() cannot be confused by a delimiter in the data.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Read lazily and cached, the way auth.js reads JWT_SECRET. A missing variable would
 * otherwise become Buffer.from('undefined', 'base64'), which is a key of the wrong length
 * that fails at the first seal() with a message about the algorithm, not the cause.
 */
let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;

  const raw = process.env.MS_TOKEN_KEY;
  const decoded = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `MS_TOKEN_KEY is unset or is not ${KEY_BYTES} bytes of base64 (see .env.example).`,
    );
  }

  cachedKey = decoded;
  return cachedKey;
}

/**
 * Encrypts a UTF-8 string for storage.
 *
 * @param {string} plaintext
 * @returns {Buffer} iv || tag || ciphertext
 * @throws {Error} when MS_TOKEN_KEY is unset or malformed.
 */
export function seal(plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Decrypts what seal() produced.
 *
 * @param {Buffer | Uint8Array} sealed
 * @returns {string}
 * @throws {Error} on a truncated buffer, a wrong key, or a modified byte -- GCM refuses
 *   rather than returning garbage.
 */
export function open(sealed) {
  const buffer = Buffer.from(sealed);
  if (buffer.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Sealed value is too short to carry an IV and a tag.");
  }

  const iv = buffer.subarray(0, IV_BYTES);
  const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buffer.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
