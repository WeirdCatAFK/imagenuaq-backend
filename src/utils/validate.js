// Payload validation shared by the orchestration tier. Each helper either returns the clean
// value or throws a 400 naming the field, so a module reads its input in one line per field.
import { ApiError } from "./ApiError.js";

/** Postgres error codes the orchestration tier translates into refusals. */
export const UNIQUE_VIOLATION = "23505";
export const FOREIGN_KEY_VIOLATION = "23503";
export const CHECK_VIOLATION = "23514";

/**
 * Trims a string and turns a blank one into null. Anything that is not a string is null.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} max
 * @returns {string}
 * @throws {ApiError} 400 when blank, not a string, or longer than `max`.
 */
export function requireText(value, field, max) {
  const text = cleanText(value);
  if (text === null) throw ApiError.badRequest(`${field} is required.`);
  if (text.length > max) throw ApiError.badRequest(`${field} must be ${max} characters or fewer.`);
  return text;
}

/**
 * Like requireText(), but a blank value is null.
 *
 * @returns {string | null}
 * @throws {ApiError} 400 when longer than `max`.
 */
export function optionalText(value, field, max) {
  return cleanText(value) === null ? null : requireText(value, field, max);
}

/**
 * A JSON or query-string id as a positive integer, or null. Rejects booleans and "7abc",
 * which Number() would turn into 1 and NaN.
 *
 * @returns {number | null}
 */
export function toId(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * @returns {number}
 * @throws {ApiError} 400 when `value` is not a positive integer.
 */
export function requireId(value, field) {
  const id = toId(value);
  if (id === null) throw ApiError.badRequest(`${field} must be a positive integer.`);
  return id;
}

/**
 * Null, undefined and "" (a cleared form field or query parameter) are null.
 *
 * @returns {number | null}
 * @throws {ApiError} 400 when anything else is not a positive integer.
 */
export function optionalId(value, field) {
  if (value === null || value === undefined || value === "") return null;
  return requireId(value, field);
}

/**
 * An array of ids, deduplicated. Missing is an empty array.
 *
 * @returns {number[]}
 * @throws {ApiError} 400 when not an array or an element is not a positive integer.
 */
export function uniqueIds(values, field) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw ApiError.badRequest(`${field} must be an array.`);
  return [...new Set(values.map((value) => requireId(value, field)))];
}

/**
 * @returns {number}
 * @throws {ApiError} 400 when `value` is not an integer.
 */
export function requireInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw ApiError.badRequest(`${field} must be an integer.`);
  return n;
}

/**
 * @returns {boolean}
 * @throws {ApiError} 400 when `value` is not a boolean.
 */
export function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw ApiError.badRequest(`${field} must be a boolean.`);
  return value;
}

/**
 * A boolean that may arrive as a query-string "true"/"false". Blank is null.
 *
 * @returns {boolean | null}
 * @throws {ApiError} 400 on anything else.
 */
export function optionalBoolean(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw ApiError.badRequest(`${field} must be a boolean.`);
}
