// A field key: the name a value carries in `requests.data`, `project_field_values` and a
// stage's declared inputs and outputs (RF-FLW-06). Pure: no database, no HTTP.
//
// It lives here rather than in one orchestration module because two of them validate the same
// declaration -- a project stage and a flow template's stage -- and the template side will be
// read by the project side when a project starts from a template, so a copy in each would be
// an import cycle waiting to happen.
import { ApiError } from "./ApiError.js";

/** The column width of `project_field_values.key`. */
export const FIELD_KEY_MAX = 100;

/**
 * One field key, trimmed and checked: snake_case, starting with a letter.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {ApiError} 400
 */
export function requireFieldKey(value) {
  const text = typeof value === "string" ? value.trim() : value;
  if (text === null || text === undefined || text === "") {
    throw ApiError.badRequest("A field key is required.");
  }
  if (typeof text !== "string" || !/^[a-z][a-z0-9_]*$/.test(text) || text.length > FIELD_KEY_MAX) {
    throw ApiError.badRequest(
      `A field key must be snake_case: a lowercase letter, then letters, digits or _ (${FIELD_KEY_MAX} max).`,
    );
  }
  return text;
}

/**
 * A declaration of inputs or outputs: field keys, unique, in the order given. Absent means
 * none.
 *
 * @param {unknown} value
 * @param {string} field The name to put in the refusal.
 * @returns {string[]}
 * @throws {ApiError} 400
 */
export function requireKeyList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array of field keys.`);

  const out = [];
  for (const entry of value) {
    const key = requireFieldKey(entry);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}
