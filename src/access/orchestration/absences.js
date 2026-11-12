// Absences and leave: types, entitlements, balances, the request-approve-take lifecycle and the
// availability view that hides the reason (RF-AUS-01 to RF-AUS-15). Status history stays in
// absence_status_history, never in logs, for RF-AUS-13.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import { putContent, StorageError } from "../primitives/minioStorage.js";
import {
  UNIQUE_VIOLATION,
  EXCLUSION_VIOLATION,
  optionalText,
  requireText,
  requireId,
  optionalId,
  optionalBoolean,
  optionalDate,
} from "../../utils/validate.js";

const TEXT_MAX = 4000;
const LABEL_MAX = 200;
const CODE_MAX = 50;
const PAGE_MAX = 200;
const CODE_FORMAT = /^[a-z][a-z0-9_]*$/;
const AMOUNT_FORMAT = /^\d{1,6}(\.\d{1,2})?$/;

const UNITS = ["day", "hour"];

const STATUS_MOVES = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["cancelled", "taken"],
  rejected: [],
  cancelled: [],
  taken: [],
};

/** The actor's id; absence writes are always someone's. */
function actorId() {
  const actor = currentActor();
  if (!actor) throw ApiError.badRequest("No acting user.");
  return actor.id;
}

/**
 * Whether the actor may see the motive and document of `userId`'s absences: their own, an admin,
 * or a holder of absence.read_detail (RF-AUS-13).
 */
async function seesDetail(userId) {
  const actor = currentActor();
  if (actor.role === "admin" || userId === actor.id) return true;
  return (await query.getRolePermissionCodes(actor.roleId)).includes("absence.read_detail");
}

/** @throws {ApiError} 400 */
function requireAmount(value, field) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!AMOUNT_FORMAT.test(text)) {
    throw ApiError.badRequest(`${field} must be a non-negative amount with at most two decimals.`);
  }
  return text;
}

/** @throws {ApiError} 400 */
function requireCode(value) {
  const code = requireText(value, "code", CODE_MAX);
  if (!CODE_FORMAT.test(code)) throw ApiError.badRequest("code must be lowercase letters, digits and underscores.");
  return code;
}

/** @throws {ApiError} 400 */
function requireUnit(value) {
  const text = requireText(value, "unit", 10);
  if (!UNITS.includes(text)) throw ApiError.badRequest(`unit must be one of: ${UNITS.join(", ")}.`);
  return text;
}

/** @throws {ApiError} 400 */
function requireDate(value, field) {
  const d = optionalDate(value, field);
  if (d === null) throw ApiError.badRequest(`${field} is required.`);
  return d;
}

/** @throws {ApiError} 400 on anything other than a valid ISO-8601 timestamp or blank. */
function requireTimestamp(value, field) {
  if (value === undefined || value === null || value === "") {
    throw ApiError.badRequest(`${field} is required.`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw ApiError.badRequest(`${field} must be a valid timestamp.`);
  return d.toISOString();
}

/** `limit` 1..200 (default 50) and `offset` >= 0 from a query string. */
function page({ limit, offset } = {}) {
  const size = limit === undefined || limit === "" ? 50 : Number(limit);
  const skip = offset === undefined || offset === "" ? 0 : Number(offset);
  if (!Number.isInteger(size) || size < 1 || size > PAGE_MAX) {
    throw ApiError.badRequest(`limit must be between 1 and ${PAGE_MAX}.`);
  }
  if (!Number.isInteger(skip) || skip < 0) throw ApiError.badRequest("offset must be a non-negative integer.");
  return { limit: size, offset: skip };
}

/** @throws {ApiError} 400 unless blank or one of `allowed`. */
function optionalChoice(value, field, allowed) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.includes(value)) throw ApiError.badRequest(`${field} must be one of: ${allowed.join(", ")}.`);
  return value;
}

/** The number of whole days the absence spans, at least 1. */
function durationDays(startsAt, endsAt) {
  return Math.max(1, Math.ceil((new Date(endsAt) - new Date(startsAt)) / 86_400_000));
}

/** Cycle = calendar year of startsAt; upgrade when contract-anniversary cycles appear. */
function cycleOf(dateStr) {
  const year = new Date(dateStr).getFullYear();
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

class Absences {
  /** @returns {Promise<object[]>} */
  async listTypes({ activeOnly } = {}) {
    const active = optionalBoolean(activeOnly, "activeOnly") ?? true;
    return (await query.listAbsenceTypes(active)).map(shapeType);
  }

  /**
   * @throws {ApiError} 404
   */
  async getType(typeId) {
    const row = await query.getAbsenceType(requireId(typeId, "typeId"));
    if (!row) throw ApiError.notFound("Absence type not found.");
    return shapeType(row);
  }

  /**
   * @throws {ApiError} 400, 409 on a duplicate code.
   */
  async createType(input) {
    const fields = {
      code: requireCode(input?.code),
      label: requireText(input?.label, "label", LABEL_MAX),
      unit: requireUnit(input?.unit),
      consumes_balance: input?.consumesBalance !== false,
      requires_document: input?.requiresDocument === true,
    };
    try {
      const row = await query.createAbsenceType(fields);
      return shapeType(row);
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) throw ApiError.conflict("An absence type with that code already exists.");
      throw err;
    }
  }

  /**
   * @throws {ApiError} 400, 404, 409.
   */
  async updateType(typeId, input) {
    const id = requireId(typeId, "typeId");
    const fields = {};
    if (input?.label !== undefined) fields.label = requireText(input.label, "label", LABEL_MAX);
    if (input?.unit !== undefined) fields.unit = requireUnit(input.unit);
    if (input?.consumesBalance !== undefined) fields.consumes_balance = input.consumesBalance === true;
    if (input?.requiresDocument !== undefined) fields.requires_document = input.requiresDocument === true;
    if (input?.isActive !== undefined) fields.is_active = input.isActive === true;
    if (Object.keys(fields).length === 0) throw ApiError.badRequest("Nothing to change.");
    try {
      const row = await query.updateAbsenceType(id, fields);
      if (!row) throw ApiError.notFound("Absence type not found.");
      return shapeType(row);
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) throw ApiError.conflict("An absence type with that code already exists.");
      throw err;
    }
  }

  /** @returns {Promise<object[]>} */
  async listEntitlements(contractTypeId) {
    const rows = await query.listEntitlements(requireId(contractTypeId, "contractTypeId"));
    return rows.map(shapeEntitlement);
  }

  /**
   * Closes the current open entitlement and inserts a replacement: RF-AUS-04 says amount is
   * never updated in place, so consumed history keeps the cap that was in force.
   *
   * @throws {ApiError} 400, 409 on overlapping periods.
   */
  async setEntitlement(contractTypeId, input) {
    const ctId = requireId(contractTypeId, "contractTypeId");
    const atId = requireId(input?.absenceTypeId, "absenceTypeId");
    const amount = requireAmount(input?.amount, "amount");
    const validFrom = requireDate(input?.validFrom, "validFrom");
    try {
      const current = await query.getEffectiveEntitlement(ctId, atId, validFrom);
      if (current && !current.valid_to) {
        const dayBefore = new Date(new Date(validFrom).getTime() - 86_400_000).toISOString().slice(0, 10);
        if (dayBefore >= current.valid_from.toISOString().slice(0, 10)) {
          await query.closeEntitlement(current.id, dayBefore);
        } else {
          await query.deleteEntitlement(current.id);
        }
      }
      const row = await query.createEntitlement({
        contract_type_id: ctId, absence_type_id: atId, amount, valid_from: validFrom, valid_to: null,
      });
      return shapeEntitlement(row);
    } catch (err) {
      if (err?.code === EXCLUSION_VIOLATION) throw ApiError.conflict("Entitlement periods overlap.");
      throw err;
    }
  }

  /**
   * Adjusts a single entitlement (e.g. correct a typo in amount before anyone consumed it).
   *
   * @throws {ApiError} 400, 404.
   */
  async updateEntitlement(contractTypeId, entitlementId, input) {
    requireId(contractTypeId, "contractTypeId");
    const eid = requireId(entitlementId, "entitlementId");
    const fields = {};
    if (input?.amount !== undefined) fields.amount = requireAmount(input.amount, "amount");
    if (input?.validFrom !== undefined) fields.valid_from = requireDate(input.validFrom, "validFrom");
    if (input?.validTo !== undefined) fields.valid_to = optionalDate(input.validTo, "validTo");
    if (Object.keys(fields).length === 0) throw ApiError.badRequest("Nothing to change.");
    try {
      const row = await query.updateEntitlement(eid, fields);
      if (!row) throw ApiError.notFound("Entitlement not found.");
      return shapeEntitlement(row);
    } catch (err) {
      if (err?.code === EXCLUSION_VIOLATION) throw ApiError.conflict("Entitlement periods overlap.");
      throw err;
    }
  }

  /** @returns {Promise<object[]>} */
  async listBalances(userId) {
    const rows = await query.listBalances(requireId(userId, "userId"));
    return rows.map(shapeBalance);
  }

  /**
   * Creates or updates an individual balance for RF-AUS-05 exceptions (e.g. seniority days).
   *
   * @throws {ApiError} 400
   */
  async setBalance(userId, input) {
    const uid = requireId(userId, "userId");
    const atId = requireId(input?.absenceTypeId, "absenceTypeId");
    const cycleStart = requireDate(input?.cycleStart, "cycleStart");
    const cycleEnd = requireDate(input?.cycleEnd, "cycleEnd");
    const granted = requireAmount(input?.granted, "granted");
    if (cycleEnd < cycleStart) throw ApiError.badRequest("cycleEnd must not be before cycleStart.");
    const row = await query.upsertBalance(uid, atId, cycleStart, cycleEnd, granted);
    return shapeBalance(row);
  }

  /**
   * @throws {ApiError} 400
   */
  async list({ userId, areaId, status, absenceTypeId, limit, offset } = {}) {
    const filters = {
      userId: optionalId(userId, "userId"),
      areaId: optionalId(areaId, "areaId"),
      status: optionalChoice(status, "status", Object.keys(STATUS_MOVES)),
      absenceTypeId: optionalId(absenceTypeId, "absenceTypeId"),
      ...page({ limit, offset }),
    };
    const actor = currentActor();
    const perms = await query.getRolePermissionCodes(actor.roleId);
    const canDetail = actor.role === "admin" || perms.includes("absence.read_detail");
    const rows = await query.listAbsences(filters);
    return rows.map((row) => canDetail || row.user_id === actor.id ? shapeAbsence(row) : shapeAbsencePublic(row));
  }

  /**
   * @throws {ApiError} 404
   */
  async get(eventId) {
    const id = requireId(eventId, "eventId");
    const row = await query.getAbsence(id);
    if (!row) throw ApiError.notFound("Absence not found.");
    return (await seesDetail(row.user_id)) ? shapeAbsence(row) : shapeAbsencePublic(row);
  }

  /**
   * Requests an absence. RF-AUS-07: warns but does not block when the balance would be exceeded.
   *
   * @returns {Promise<{absence: object, warning?: string}>}
   * @throws {ApiError} 400
   */
  async create(input) {
    const userId = requireId(input?.userId, "userId");
    const absenceTypeId = requireId(input?.absenceTypeId, "absenceTypeId");
    const startsAt = requireTimestamp(input?.startsAt, "startsAt");
    const endsAt = requireTimestamp(input?.endsAt, "endsAt");
    if (endsAt <= startsAt) throw ApiError.badRequest("endsAt must be after startsAt.");
    const allDay = input?.allDay !== false;
    const reason = requireText(input?.reason, "reason", TEXT_MAX);
    const documentFileId = optionalId(input?.documentFileId, "documentFileId");

    const actor = currentActor();
    if (!actor) throw ApiError.badRequest("No acting user.");
    if (userId !== actor.id) {
      const perms = await query.getRolePermissionCodes(actor.roleId);
      if (!perms.includes("absence.request_others")) {
        throw ApiError.forbidden("You can only request absences for yourself.");
      }
    }

    const type = await query.getAbsenceType(absenceTypeId);
    if (!type || !type.is_active) throw ApiError.badRequest("Absence type not found or inactive.");

    let warning = null;
    if (type.consumes_balance && allDay) {
      const days = durationDays(startsAt, endsAt);
      const { start, end } = cycleOf(startsAt);
      const balance = await query.getBalance(userId, absenceTypeId, start);
      if (balance && Number(balance.used) + days > Number(balance.granted)) {
        warning = `Exceeds available balance by ${Number(balance.used) + days - Number(balance.granted)} ${type.unit}(s).`;
      }
    }

    const row = await query.createAbsence({
      title: type.label, description: reason, allDay, startsAt, endsAt,
      rule: null, recurrenceUntil: null, createdBy: actor.id,
      reason, absenceTypeId, documentFileId, userId, areaId: null,
    });
    if (!row) throw ApiError.badRequest("Failed to create absence — check that the 'ausencia' event type exists.");

    await events.emit({
      action: "absence_created",
      target: { table: "absences", id: row.event_id },
      after: { user_id: userId, starts_at: startsAt, ends_at: endsAt, status: "requested" },
    });

    return { absence: shapeAbsence(row), ...(warning ? { warning } : {}) };
  }

  /**
   * Changes the dates, type or reason of an absence that is still requested. An approved one has
   * already drawn on the balance (RF-AUS-06), so changing it means cancelling and requesting
   * again. Only its person, or someone with absence.request_others, may edit it.
   *
   * @returns {Promise<object>} The absence as it is now.
   * @throws {ApiError} 400, 403, 404, 409 when it is no longer requested.
   */
  async update(eventId, input) {
    const id = requireId(eventId, "eventId");
    const row = await query.getAbsence(id);
    if (!row) throw ApiError.notFound("Absence not found.");

    const actor = currentActor();
    if (!actor) throw ApiError.badRequest("No acting user.");
    if (row.user_id !== actor.id) {
      const perms = await query.getRolePermissionCodes(actor.roleId);
      if (!perms.includes("absence.request_others")) {
        throw ApiError.forbidden("You can only edit your own absences.");
      }
    }
    if (row.status !== "requested") {
      throw ApiError.conflict("Only a requested absence can be edited. Cancel it and request it again.");
    }

    const changes = ["absenceTypeId", "startsAt", "endsAt", "reason"].filter((key) => input?.[key] !== undefined);
    if (changes.length === 0) throw ApiError.badRequest("Nothing to change.");

    const absenceTypeId = input.absenceTypeId === undefined
      ? row.absence_type_id
      : requireId(input.absenceTypeId, "absenceTypeId");
    const startsAt = input.startsAt === undefined
      ? new Date(row.starts_at).toISOString()
      : requireTimestamp(input.startsAt, "startsAt");
    const endsAt = input.endsAt === undefined
      ? new Date(row.ends_at).toISOString()
      : requireTimestamp(input.endsAt, "endsAt");
    if (endsAt <= startsAt) throw ApiError.badRequest("endsAt must be after startsAt.");
    const reason = input.reason === undefined ? row.reason : requireText(input.reason, "reason", TEXT_MAX);

    const type = await query.getAbsenceType(absenceTypeId);
    if (!type || !type.is_active) throw ApiError.badRequest("Absence type not found or inactive.");

    const updated = await query.updateRequestedAbsence(id, {
      absenceTypeId, startsAt, endsAt, reason, title: type.label,
    });
    if (!updated) {
      throw ApiError.conflict("Only a requested absence can be edited. Cancel it and request it again.");
    }

    await events.emit({
      action: "record_updated",
      target: { table: "absences", id },
      before: { absence_type_id: row.absence_type_id, starts_at: row.starts_at, ends_at: row.ends_at },
      after: { absence_type_id: absenceTypeId, starts_at: startsAt, ends_at: endsAt },
    });

    return this.get(id);
  }

  /**
   * Moves an absence between statuses. RF-AUS-06: deducts on approve, restores on cancel.
   *
   * @throws {ApiError} 400, 403, 404
   */
  async changeStatus(eventId, input) {
    const id = requireId(eventId, "eventId");
    const target = requireText(input?.status, "status", 20);
    if (!Object.keys(STATUS_MOVES).includes(target)) {
      throw ApiError.badRequest(`status must be one of: ${Object.keys(STATUS_MOVES).join(", ")}.`);
    }
    const note = optionalText(input?.note, "note", TEXT_MAX);
    const documentFileId = optionalId(input?.documentFileId, "documentFileId");

    const row = await query.getAbsence(id);
    if (!row) throw ApiError.notFound("Absence not found.");

    const allowed = STATUS_MOVES[row.status];
    if (!allowed.includes(target)) {
      throw ApiError.badRequest(`Cannot move from ${row.status} to ${target}.`);
    }

    const actor = currentActor();

    const updates = { status: target };
    let balanceDelta = 0;

    if (target === "approved") {
      updates.approved_by = actor.id;
      updates.approved_at = new Date().toISOString();
      if (row.consumes_balance && row.all_day) {
        balanceDelta = durationDays(row.starts_at, row.ends_at);
      }
    }
    if (target === "cancelled" && row.status === "approved" && row.consumes_balance && row.all_day) {
      balanceDelta = -durationDays(row.starts_at, row.ends_at);
    }

    const { start } = cycleOf(row.starts_at);
    const updated = await query.updateAbsenceStatus(id, {
      status: target, changedBy: actor.id, note,
      approvedBy: updates.approved_by ?? null, approvedAt: updates.approved_at ?? null,
      documentFileId,
    });

    if (balanceDelta !== 0) {
      await query.adjustBalanceUsed(row.user_id, row.absence_type_id, start, balanceDelta);
    }

    if (target === "approved") {
      await events.emit({
        action: "absence_status_changed",
        target: { table: "absences", id: row.event_id },
        after: updated,
      });
    }

    return shapeAbsence(updated);
  }

  /**
   * Removes a requested absence before anyone acts on it. Only its person, or someone with
   * absence.request_others, may remove it (RF-USR-05).
   *
   * @throws {ApiError} 403, 404
   */
  async remove(eventId) {
    const id = requireId(eventId, "eventId");
    const existing = await query.getAbsence(id);
    if (!existing) throw ApiError.notFound("Absence not found or not in requested status.");

    const actor = currentActor();
    if (existing.user_id !== actor.id) {
      const perms = await query.getRolePermissionCodes(actor.roleId);
      if (!perms.includes("absence.request_others")) {
        throw ApiError.forbidden("You can only remove your own absences.");
      }
    }

    const row = await query.deleteAbsence(id);
    if (!row) throw ApiError.notFound("Absence not found or not in requested status.");
  }

  /**
   * The status changes of an absence. Notes can repeat the motive, so they follow the same rule as
   * get() (RF-AUS-13).
   *
   * @returns {Promise<object[]>}
   * @throws {ApiError} 404
   */
  async statusHistory(eventId) {
    const id = requireId(eventId, "eventId");
    const row = await query.getAbsence(id);
    if (!row) throw ApiError.notFound("Absence not found.");
    const full = await seesDetail(row.user_id);
    return (await query.absenceStatusHistory(id))
      .map(shapeStatusEntry)
      .map((entry) => (full ? entry : { ...entry, note: null }));
  }

  /**
   * Who is away and when, without the reason. Reads `absence_availability`, never `absences`.
   *
   * @throws {ApiError} 400
   */
  async availability({ from, to, areaId, userId } = {}) {
    const start = requireDate(from, "from");
    const end = requireDate(to, "to");
    if (end < start) throw ApiError.badRequest("to must not be before from.");
    return query.listAvailability({
      from: start,
      to: end,
      areaId: optionalId(areaId, "areaId"),
      userId: optionalId(userId, "userId"),
    });
  }

  /**
   * Stores the backing document ("oficio") for an absence and links it.
   *
   * @throws {ApiError} 400, 404, 503
   */
  async uploadDocument(eventId, { name, mime = null, body }) {
    const id = requireId(eventId, "eventId");
    const cleanName = requireText(name, "name", 255);

    const row = await query.getAbsence(id);
    if (!row) throw ApiError.notFound("Absence not found.");

    const folder = await query.getAbsenceDocumentFolder();
    if (!folder) throw ApiError.unavailable("Absence document folder not configured.");

    let stored;
    try {
      const maxBytes = Number(process.env.MAX_UPLOAD_BYTES);
      stored = await putContent(body, { maxBytes: Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : null });
    } catch (err) {
      if (err instanceof StorageError && err.code === "ETOOLARGE") throw new ApiError(413, err.message);
      throw ApiError.unavailable("File storage is unavailable.");
    }

    const actor = currentActor();
    const file = await query.createFile({
      folderId: folder.id,
      authorId: actor.id,
      hash: stored.hash,
      name: cleanName,
      size: stored.size,
      mime: mime ?? "application/octet-stream",
    });

    await query.setAbsenceDocument(id, file.id);
    return { id: file.id, name: file.name, size: file.size };
  }
}

function shapeType(row) {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    unit: row.unit,
    consumesBalance: row.consumes_balance,
    requiresDocument: row.requires_document,
    isActive: row.is_active,
  };
}

function shapeEntitlement(row) {
  return {
    id: row.id,
    contractTypeId: row.contract_type_id,
    absenceTypeId: row.absence_type_id,
    absenceTypeCode: row.type_code ?? null,
    absenceTypeLabel: row.type_label ?? null,
    amount: Number(row.amount),
    validFrom: asDate(row.valid_from),
    validTo: asDate(row.valid_to),
  };
}

function shapeBalance(row) {
  return {
    id: row.id,
    userId: row.user_id,
    absenceTypeId: row.absence_type_id,
    absenceTypeCode: row.type_code ?? null,
    absenceTypeLabel: row.type_label ?? null,
    cycleStart: asDate(row.cycle_start),
    cycleEnd: asDate(row.cycle_end),
    granted: Number(row.granted),
    used: Number(row.used),
    remaining: Number(row.granted) - Number(row.used),
    note: row.note ?? null,
  };
}

function shapeAbsence(row) {
  return {
    eventId: row.event_id,
    status: row.status,
    absenceTypeId: row.absence_type_id,
    typeCode: row.type_code ?? null,
    typeLabel: row.type_label ?? null,
    consumesBalance: row.consumes_balance ?? null,
    reason: row.reason,
    documentFileId: row.document_file_id ?? null,
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: row.all_day,
    rule: row.rule ?? null,
    recurrenceUntil: row.recurrence_until ?? null,
    userId: row.user_id,
    userName: row.user_name ?? null,
    areaId: row.area_id ?? null,
    createdAt: row.created_at,
  };
}

function shapeAbsencePublic(row) {
  const shaped = shapeAbsence(row);
  shaped.reason = null;
  shaped.documentFileId = null;
  return shaped;
}

function shapeStatusEntry(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    note: row.note ?? null,
  };
}

/** A `date` column as `YYYY-MM-DD`; postgrejs reads it as local midnight. */
function asDate(value) {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) return value;
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

export default new Absences();
