// Tier 3: the status catalogue, configurable per area (RF-EST-02).
//
// `area_id` NULL is the global catalogue every area starts from; a row with an area belongs
// to that area alone. An area may reuse a global code -- two partial unique indexes, not one
// on the pair, because NULL is distinct from NULL in an index.
//
// Nothing is deleted: requests and projects reference these rows, so a status leaves the
// catalogue by going inactive, which hides it from the pickers without rewriting history.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const CODE = /^[a-z][a-z0-9_]{0,49}$/;
const LABEL_MAX = 200;

class Statuses {
  /**
   * The catalogue an area works with: its rows plus the global ones. Without an area, the
   * global catalogue alone.
   */
  async list({ areaId = null, includeInactive = false } = {}) {
    const rows = await query.listStatuses({
      areaId: areaId == null ? null : requireId(areaId, "areaId"),
      includeInactive: includeInactive === true,
    });
    return rows.map(shapeStatus);
  }

  /** @throws {ApiError} 404 */
  async get(statusId) {
    const row = await query.getStatus(requireId(statusId, "statusId"));
    if (!row) throw ApiError.notFound("Status not found.");
    return shapeStatus(row);
  }

  /**
   * @param {{ code: string, label: string, areaId?: number|null, sortOrder?: number,
   *   isTerminal?: boolean }} input areaId omitted or null creates a global status.
   * @throws {ApiError} 400, 409 when the code exists in that catalogue.
   */
  async create({ areaId = null, code, label, sortOrder = 0, isTerminal = false }) {
    const area = areaId == null ? null : requireId(areaId, "areaId");
    const cleanCode = requireCode(code);
    const cleanLabel = requireText(label, "label", LABEL_MAX);

    try {
      const row = await query.createStatus({
        areaId: area,
        code: cleanCode,
        label: cleanLabel,
        sortOrder: requireInt(sortOrder, "sortOrder"),
        isTerminal: requireBoolean(isTerminal, "isTerminal"),
      });

      await events.emit({
        action: "record_created",
        target: { table: "statuses", id: row.id },
        after: row,
      });

      return shapeStatus(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * The code and the area are not editable: both are what requests and projects were filed
   * under, and a rename of either would move rows between catalogues silently.
   *
   * @throws {ApiError} 400 when nothing valid is sent, 404.
   */
  async update(statusId, { label, sortOrder, isTerminal, isActive }) {
    const id = requireId(statusId, "statusId");

    const payload = {
      label: label === undefined ? null : requireText(label, "label", LABEL_MAX),
      sortOrder: sortOrder === undefined ? null : requireInt(sortOrder, "sortOrder"),
      isTerminal: isTerminal === undefined ? null : requireBoolean(isTerminal, "isTerminal"),
      isActive: isActive === undefined ? null : requireBoolean(isActive, "isActive"),
    };
    if (Object.values(payload).every((value) => value === null)) {
      throw ApiError.badRequest("Nothing to update: send label, sortOrder, isTerminal or isActive.");
    }

    const before = await query.getStatus(id);
    if (!before) throw ApiError.notFound("Status not found.");

    const row = await query.updateStatus(id, payload);

    await events.emit({
      action: "record_updated",
      target: { table: "statuses", id: row.id },
      before,
      after: row,
    });

    return shapeStatus(row);
  }

  /** @throws {ApiError} 404, 409 when it is already inactive. */
  async deactivate(statusId) {
    const id = requireId(statusId, "statusId");

    const before = await query.getStatus(id);
    if (!before) throw ApiError.notFound("Status not found.");
    if (before.is_active === false) throw ApiError.conflict("Status is already inactive.");

    const row = await query.deactivateStatus(id);

    await events.emit({
      action: "record_deleted",
      target: { table: "statuses", id: row.id },
      before,
      after: row,
    });

    return shapeStatus(row);
  }

  /**
   * A code resolved in one catalogue, for the modules that need a default -- `recibido` for
   * a new request. Null when nothing carries it.
   */
  async byCode(code, areaId = null) {
    const row = await query.findStatusByCode(requireCode(code), areaId ?? null);
    return row ? shapeStatus(row) : null;
  }
}

/* HELPERS */

function requireText(value, field, max) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw ApiError.badRequest(`${field} is required.`);
  if (text.length > max) throw ApiError.badRequest(`${field} must be ${max} characters or fewer.`);
  return text;
}

function requireCode(code) {
  const text = typeof code === "string" ? code.trim().toLowerCase() : "";
  if (!text) throw ApiError.badRequest("code is required.");
  if (!CODE.test(text)) {
    throw ApiError.badRequest(
      "code must be snake_case: a lowercase letter, then letters, digits or _ (50 max).",
    );
  }
  return text;
}

function requireInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw ApiError.badRequest(`${field} must be an integer.`);
  return n;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw ApiError.badRequest(`${field} must be a boolean.`);
  return value;
}

function requireId(value, field) {
  if (value === null || value === undefined || typeof value === "boolean") {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  return id;
}

function shapeStatus(row) {
  return {
    id: row.id,
    areaId: row.area_id,
    areaName: row.area_name ?? null,
    code: row.code,
    label: row.label,
    sortOrder: row.sort_order,
    isTerminal: row.is_terminal,
    isActive: row.is_active,
    isGlobal: row.area_id === null,
  };
}

function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    return ApiError.conflict("That catalogue already has a status with that code.");
  }
  if (err?.code === FOREIGN_KEY_VIOLATION) {
    return ApiError.badRequest("That area does not exist.");
  }
  return err;
}

export default new Statuses();
