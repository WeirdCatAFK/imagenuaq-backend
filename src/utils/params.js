// Route parameters arrive as strings and reach bigint columns. Rejecting a non-id in the router
// keeps `/api/areas/abc` a 400 about the URL instead of a type error from Postgres and a 500.
import { ApiError } from "./ApiError.js";

/**
 * Parses a positive integer.
 *
 * @param {unknown} raw
 * @param {string} label Named in the message, e.g. "area id".
 * @returns {number}
 * @throws {ApiError} 400 `Invalid <label>.` when `raw` is not a positive integer.
 */
export function positiveInt(raw, label) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest(`Invalid ${label}.`);
  return id;
}

/**
 * Reads `req.params[name]` as a positive integer id.
 *
 * @param {import("express").Request} req
 * @param {string} name
 * @param {string} label
 * @returns {number}
 * @throws {ApiError} 400 when the segment is not a positive integer.
 */
export function idParam(req, name, label) {
  return positiveInt(req.params[name], label);
}
