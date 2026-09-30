// Tier 3: the request — what arrives before there is a project (RF-SOL-03 … RF-SOL-08).
//
// **A request is not an early project** (DATAMODEL §2.8). Squash the two and a rejected request
// has nowhere to live, and a project born of three requests keeps only one of them. So they are
// separate tables, `requests.project_id` is the link, and `convert()` is the one crossing.
//
// The folio comes from a database sequence, not from here: `SELECT max()+1` in application code
// hands the same folio to two callers.
//
// `source` says how it arrived — `form`, `email`, `manual`. Never `sheet` through this module:
// a row from a book is inserted by the import, which is the only caller that has the hash and
// the raw row to go with it, and the CHECK on the table backs that up.
//
// `data` is the whole capture, coerced by `utils/fieldValues.js` against the format's fields, so
// a value typed here and the same value read out of Excel land identically. Unknown keys are
// kept: RF-SOL-06 says nothing the requester sent is dropped.
//
// **A request is routed by giving it a flow** (`request-flows`, DATAMODEL.md §2.5): a copy of a
// template or one designed for it, owned by the request until it converts. Every area in the
// flow's first phase finds it in its inbox, and converting hands the same phases to the
// project. `area_id` stays for what was routed by hand before flows existed.
import query from "../resources/query.js";
import statuses from "./statuses.js";
import projects from "./projects.js";
import { validatePhases } from "./workflows.js";
import { fieldList } from "./schemas.js";
import { validateData } from "../../utils/fieldValues.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const TITLE_MAX = 300;
const REQUESTER_MAX = 300;

/** Where a request starts (RF-EST-01) and where a rejected one ends. */
const DEFAULT_STATUS = "recibido";

/** What a client may claim about how a request arrived. `sheet` belongs to the import. */
const SOURCES = ["manual", "form", "email"];

class Requests {
  /**
   * Captures a request (RF-SOL-08: what arrives by email is registered here so one channel
   * holds everything).
   *
   * @param {object} input
   * @param {number} [input.schemaId] The format; its latest version is used.
   * @param {number} [input.schemaVersionId] Or a version directly, for a client that has one.
   * @param {string} input.title
   * @param {object} [input.data] The capture, coerced against the version's fields.
   * @returns {Promise<object>} The request as `getById()` shapes it.
   * @throws {ApiError} 400 on a bad payload or a value that will not coerce, 404 on an unknown
   *   format.
   */
  async create({
    schemaId = null, schemaVersionId = null, title, data = {}, requester = null,
    areaId = null, statusId = null, assigneeId = null, priority = 0, source = "manual",
    folderId = null,
  }) {
    const version = await this.#resolveVersion({ schemaId, schemaVersionId });
    const cleanSource = requireSource(source);

    const capture = validateData(fieldList(version.fields), data, { strict: true });
    if (capture.errors.length > 0) throw badCapture(capture.errors);

    const payload = {
      schemaVersionId: version.id,
      title: requireText(title, "title", TITLE_MAX),
      data: capture.data,
      requester: optionalText(requester, "requester", REQUESTER_MAX),
      areaId: optionalId(areaId, "areaId"),
      assigneeId: optionalId(assigneeId, "assigneeId"),
      priority: requireInt(priority, "priority"),
      source: cleanSource,
      folderId: optionalId(folderId, "folderId"),
      statusId: await this.#resolveStatus(statusId),
      createdBy: currentActor()?.id ?? null,
    };

    let row;
    try {
      row = await query.createRequest(payload);
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: "record_created",
      target: { table: "requests", id: row.id },
      after: row,
    });

    const shaped = await this.getById(row.id);
    return capture.warnings.length > 0 ? { ...shaped, warnings: capture.warnings } : shaped;
  }

  /** @throws {ApiError} 404 */
  async getById(requestId) {
    const row = await query.getRequest(requireId(requestId, "requestId"));
    if (!row) throw ApiError.notFound("Request not found.");
    return shapeRequest(row);
  }

  /**
   * The inbox (RF-SOL-04): ordered, filterable, and by default only what has not been converted,
   * because that is what an area still has to act on.
   *
   * @returns {Promise<{requests: object[], total: number, limit: number, offset: number}>} `total`
   *   counts every request matching the filters, not the page, so a client can page through and
   *   say how much is left.
   */
  async list(filters = {}) {
    const limit = filters.limit === undefined ? 50 : requireInt(filters.limit, "limit");
    const offset = filters.offset === undefined ? 0 : requireInt(filters.offset, "offset");
    if (limit < 1 || limit > 200) throw ApiError.badRequest("limit must be between 1 and 200.");
    if (offset < 0) throw ApiError.badRequest("offset must not be negative.");

    const rows = await query.listRequests({
      areaId: areaFilter(filters.areaId),
      statusId: optionalId(filters.statusId, "statusId"),
      assigneeId: optionalId(filters.assigneeId, "assigneeId"),
      schemaId: optionalId(filters.schemaId, "schemaId"),
      sheetId: optionalId(filters.sheetId, "sheetId"),
      requester: cleanText(filters.requester),
      q: cleanText(filters.q),
      converted: optionalBoolean(filters.converted, "converted"),
      duplicates: optionalBoolean(filters.duplicates, "duplicates"),
      source: filters.source === undefined ? null : requireAnySource(filters.source),
      sort: filters.sort === "created" ? "created" : "priority",
      limit,
      offset,
    });

    // `total` es de la consulta, no de la página: sin él la bandeja no puede decir cuánto falta
    // por ver. Con cero filas no hay de dónde leerlo y el total es cero.
    const total = rows.length === 0 ? 0 : Number(rows[0].total);
    return { requests: rows.map(shapeListed), total, limit, offset };
  }

  /**
   * Edits a request. Refused once it belongs to a project — except `requester`, which stays
   * editable so a misspelled name can be corrected wherever it is noticed (§2.11).
   *
   * @throws {ApiError} 400, 404, 409 once converted.
   */
  async update(requestId, input) {
    const id = requireId(requestId, "requestId");

    const before = await query.getRequest(id);
    if (!before) throw ApiError.notFound("Request not found.");

    const onlyRequester =
      Object.keys(input).every((key) => key === "requester" || key === "possibleDuplicateOf");
    if (before.project_id !== null && !onlyRequester) {
      throw ApiError.conflict(
        "That request already belongs to a project; edit the project instead.",
      );
    }

    let data = null;
    if (input.data !== undefined) {
      const capture = validateData(fieldList(before.schema_fields), input.data, { strict: true });
      if (capture.errors.length > 0) throw badCapture(capture.errors);
      data = capture.data;
    }

    const payload = {
      title: input.title === undefined ? null : requireText(input.title, "title", TITLE_MAX),
      requester:
        input.requester === undefined
          ? null
          : optionalText(input.requester, "requester", REQUESTER_MAX),
      areaId: input.areaId === undefined ? null : optionalId(input.areaId, "areaId"),
      assigneeId: input.assigneeId === undefined ? null : optionalId(input.assigneeId, "assigneeId"),
      priority: input.priority === undefined ? null : requireInt(input.priority, "priority"),
      data,
      // `null` clears the duplicate flag: somebody looked and said these are not the same.
      possibleDuplicateOf:
        input.possibleDuplicateOf === undefined || input.possibleDuplicateOf === null
          ? null
          : requireId(input.possibleDuplicateOf, "possibleDuplicateOf"),
      clearDuplicate: input.possibleDuplicateOf === null,
    };

    if (
      Object.entries(payload).every(([key, value]) => (key === "clearDuplicate" ? !value : value === null))
    ) {
      throw ApiError.badRequest("Nothing to update.");
    }

    let row;
    try {
      row = await query.updateRequest(id, payload);
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: "record_updated",
      target: { table: "requests", id },
      before,
      after: row,
    });

    return this.getById(id);
  }

  /** @throws {ApiError} 400 on an unknown or inactive status, 404. */
  async setStatus(requestId, statusId) {
    const id = requireId(requestId, "requestId");
    const status = requireId(statusId, "statusId");

    const before = await query.getRequest(id);
    if (!before) throw ApiError.notFound("Request not found.");

    const row = await query.getStatus(status);
    if (!row) throw ApiError.badRequest("That status does not exist.");
    if (row.is_active === false) throw ApiError.badRequest("That status is inactive.");
    if (row.area_id !== null && String(row.area_id) !== String(before.area_id)) {
      // An area that has the request in its inbox through the flow may use its own statuses.
      const [flow] = await query.getRequestFlowAreas([id]);
      const inbox = (flow?.first_phase_area_ids ?? []).map(String);
      if (!inbox.includes(String(row.area_id))) {
        throw ApiError.badRequest("That status belongs to another area.");
      }
    }

    const after = await query.setRequestStatus(id, status);

    await events.emit({
      action: "status_changed",
      target: { table: "requests", id },
      before,
      after,
    });

    return this.getById(id);
  }

  /**
   * Gives a request its flow, replacing any it had: a copy of a template's latest version
   * (`workflowId`), or one designed for it (`phases`, the template shape). The request then
   * sits in the inbox of every area in the first phase.
   *
   * @param {number} requestId
   * @param {{ workflowId?: number, phases?: object[] }} input Exactly one of the two.
   * @throws {ApiError} 400 on a bad payload, 404 on an unknown request or template, 409 when
   *   the request is converted or the template inactive.
   */
  async setFlow(requestId, { workflowId, phases } = {}) {
    const id = requireId(requestId, "requestId");
    const fromTemplate = workflowId !== undefined && workflowId !== null;
    const designed = phases !== undefined && phases !== null;
    if (fromTemplate === designed) {
      throw ApiError.badRequest("Send either workflowId, to copy a template, or phases.");
    }

    const before = await query.getRequest(id);
    if (!before) throw ApiError.notFound("Request not found.");
    if (before.project_id !== null) {
      throw ApiError.conflict("That request is already a project; its flow belongs to it now.");
    }

    let input;
    if (fromTemplate) {
      const workflow = await query.getWorkflow(requireId(workflowId, "workflowId"));
      if (!workflow || workflow.workflow_version_id === null) {
        throw ApiError.notFound("Workflow not found.");
      }
      if (workflow.is_active === false) {
        throw ApiError.conflict("That workflow is inactive; pick another or reactivate it.");
      }
      input = { sourceVersionId: workflow.workflow_version_id };
    } else {
      input = { phases: await validatePhases(phases) };
    }

    const result = await query.setRequestFlow(id, input);
    if (result.found === 0) {
      throw ApiError.conflict("That request was converted or removed meanwhile; read it again.");
    }

    const after = await query.getRequest(id);
    await events.emit({
      action: "record_updated",
      target: { table: "requests", id },
      before,
      after,
    });

    return shapeRequest(after);
  }

  /**
   * Takes a request's flow away; it goes back to being unrouted unless it has an area.
   *
   * @throws {ApiError} 404, 409 once converted.
   */
  async clearFlow(requestId) {
    const id = requireId(requestId, "requestId");

    const before = await query.getRequest(id);
    if (!before) throw ApiError.notFound("Request not found.");
    if (before.project_id !== null) {
      throw ApiError.conflict("That request is already a project; its flow belongs to it now.");
    }

    await query.clearRequestFlow(id);

    const after = await query.getRequest(id);
    await events.emit({
      action: "record_updated",
      target: { table: "requests", id },
      before,
      after,
    });

    return shapeRequest(after);
  }

  /** @throws {ApiError} 404, 409 once converted. */
  async remove(requestId) {
    const id = requireId(requestId, "requestId");

    const before = await query.getRequest(id);
    if (!before) throw ApiError.notFound("Request not found.");
    if (before.project_id !== null) {
      throw ApiError.conflict("That request belongs to a project; it cannot be deleted.");
    }

    const row = await query.deleteRequest(id);

    await events.emit({
      action: "record_deleted",
      target: { table: "requests", id },
      before,
      after: row,
    });

    return shapeRequest({ ...before, deleted_at: row.deleted_at });
  }

  /**
   * Turns a request into a project (RF-PRY-01), optionally answering several at once.
   *
   * What travels: the requester (correctable here, which is where the autocomplete lands), the
   * format version, and **every captured value** as a `project_field_values` row keyed by its
   * field code — no per-field opt-in, because the propagation exists for the later tools to read
   * (§2.11). `produced_by_stage_id` stays null: it came from the request, not from a stage.
   *
   * On a multi-request conversion the first request wins a repeated key and the rest come back
   * in `conflicts` rather than being silently dropped.
   *
   * **The flow travels too** (§2.5): the project takes the flow of the first request that has
   * one -- the same phases, now owned by the project, each stage with its first attempt -- and
   * any other request's flow is dropped and named in `discardedFlows`. `stages` builds the
   * stages by hand instead, and sending them for a request that has a flow is refused: it
   * would be two answers to the same question.
   *
   * @param {number} requestId
   * @param {object} [input] `key`, `title`, `requester`, `stages`, `requestIds` and the project
   *   flags; anything omitted is taken from the request.
   * @returns {Promise<{project: object, conflicts: object[], discardedFlows: string[]}>}
   * @throws {ApiError} 400 on stages for a request with a flow, 404, 409 when it is already
   *   converted.
   */
  async convert(requestId, input = {}) {
    const id = requireId(requestId, "requestId");

    const request = await query.getRequest(id);
    if (!request) throw ApiError.notFound("Request not found.");
    if (request.project_id !== null) {
      throw ApiError.conflict("That request already belongs to a project.");
    }

    const extra = uniqueIds(input.requestIds, "requestIds").filter((other) => other !== id);
    const all = [request];

    for (const otherId of extra) {
      const other = await query.getRequest(otherId);
      if (!other) throw ApiError.badRequest(`Request ${otherId} does not exist.`);
      if (other.project_id !== null) {
        throw ApiError.conflict(`Request ${other.folio} already belongs to a project.`);
      }
      all.push(other);
    }

    const { fieldValues, conflicts } = mergeCaptures(all);

    const flows = new Map(
      (await query.getRequestFlowAreas(all.map((row) => row.id)))
        .map((flow) => [String(flow.request_id), flow]),
    );
    const owner = all.find((row) => flows.has(String(row.id))) ?? null;
    const others = all.filter((row) => row !== owner && flows.has(String(row.id)));

    const stages = input.stages ?? [];
    if (owner !== null && Array.isArray(stages) && stages.length > 0) {
      throw ApiError.badRequest(
        `${owner.folio} already has a flow; convert with it, or remove it to build the stages by hand.`,
      );
    }

    const requestFlow = owner === null
      ? null
      : {
          requestId: owner.id,
          workflowVersionId: owner.workflow_version_id,
          areaIds: flows.get(String(owner.id)).area_ids ?? [],
          discardRequestIds: others.map((row) => row.id),
        };

    const project = await projects.create({
      key: input.key,
      title: cleanText(input.title) ?? request.title,
      description: input.description,
      requester: input.requester === undefined ? request.requester : input.requester,
      schemaVersionId: request.schema_version_id,
      statusId: input.statusId ?? null,
      priority: input.priority === undefined ? request.priority : input.priority,
      hasCost: input.hasCost ?? false,
      carriedOver: input.carriedOver ?? false,
      startsOn: input.startsOn ?? null,
      dueOn: input.dueOn ?? null,
      stages,
      fieldValues,
      requestIds: all.map((row) => row.id),
      requestFlow,
    });

    for (const row of all) {
      await events.emit({
        action: "request_converted",
        target: { table: "requests", id: row.id },
        before: row,
        after: { ...row, project_id: project.id },
      });
    }

    return { project, conflicts, discardedFlows: others.map((row) => row.folio) };
  }

  // --- Internals ---

  /** The version to capture under: one named directly, or the format's latest. */
  async #resolveVersion({ schemaId, schemaVersionId }) {
    if (schemaVersionId !== null && schemaVersionId !== undefined) {
      const version = await query.getSchemaVersion(requireId(schemaVersionId, "schemaVersionId"));
      if (!version) throw ApiError.notFound("Schema version not found.");
      if (version.schema_is_active === false) {
        throw ApiError.badRequest("That format is inactive.");
      }
      return version;
    }

    if (schemaId === null || schemaId === undefined) {
      throw ApiError.badRequest("Send schemaId or schemaVersionId.");
    }

    const version = await query.getLatestSchemaVersion(requireId(schemaId, "schemaId"));
    if (!version) throw ApiError.notFound("That format has no published version.");
    if (version.schema_is_active === false) throw ApiError.badRequest("That format is inactive.");
    return version;
  }

  async #resolveStatus(statusId) {
    if (statusId !== null && statusId !== undefined) {
      const id = requireId(statusId, "statusId");
      const status = await query.getStatus(id);
      if (!status) throw ApiError.badRequest("That status does not exist.");
      if (status.is_active === false) throw ApiError.badRequest("That status is inactive.");
      return id;
    }

    const fallback = await statuses.byCode(DEFAULT_STATUS);
    if (!fallback) {
      throw ApiError.badGateway(`The global status "${DEFAULT_STATUS}" is missing from the catalogue.`);
    }
    return fallback.id;
  }
}

/* HELPERS */

/**
 * Every captured value of every request, as field values for the project. First request wins a
 * repeated key; the losers are reported so a conversion does not quietly pick one.
 */
function mergeCaptures(requests) {
  const fieldValues = [];
  const conflicts = [];
  const seen = new Map();

  for (const request of requests) {
    for (const [key, value] of Object.entries(request.data ?? {})) {
      if (value === null || value === undefined || value === "") continue;

      if (seen.has(key)) {
        conflicts.push({
          key,
          folio: request.folio,
          kept: seen.get(key),
          discarded: stringify(value),
        });
        continue;
      }

      const text = stringify(value);
      if (text === null) continue;
      seen.set(key, text);
      fieldValues.push({ key, value: text });
    }
  }

  return { fieldValues, conflicts };
}

function stringify(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * Every complaint in one refusal, rather than the first one found: a form with eight fields
 * should not be filled in eight times. They are joined into the message because
 * `middlewares/errorHandler.js` sends `{ error: { message } }` and nothing else -- a per-field
 * shape would be a change to that contract, not to this function.
 */
function badCapture(errors) {
  return ApiError.badRequest(errors.map((entry) => entry.message).join(" "));
}

function cleanText(value) {
  if (typeof value !== "string") return value == null ? null : value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requireText(value, field, max) {
  const text = cleanText(value);
  if (text === null) throw ApiError.badRequest(`${field} is required.`);
  if (typeof text !== "string" || text.length > max) {
    throw ApiError.badRequest(`${field} must be a string of ${max} characters or fewer.`);
  }
  return text;
}

function optionalText(value, field, max) {
  const text = cleanText(value);
  return text === null ? null : requireText(text, field, max);
}

function requireSource(source) {
  const value = cleanText(source) ?? "manual";
  if (value === "sheet") {
    throw ApiError.badRequest(
      "A request from a book is created by the import, which has its row and its hash.",
    );
  }
  if (!SOURCES.includes(value)) {
    throw ApiError.badRequest(`source must be one of: ${SOURCES.join(", ")}.`);
  }
  return value;
}

/** Reading may filter by `sheet` even though writing may not claim it. */
function requireAnySource(source) {
  const value = cleanText(source);
  if (value === null) return null;
  if (![...SOURCES, "sheet"].includes(value)) {
    throw ApiError.badRequest(`source must be one of: ${[...SOURCES, "sheet"].join(", ")}.`);
  }
  return value;
}

function requireInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw ApiError.badRequest(`${field} must be an integer.`);
  return n;
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw ApiError.badRequest(`${field} must be a boolean.`);
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

/**
 * The area filter, which also answers "the ones with no area".
 *
 * An imported row arrives unrouted (the sheet says which faculty asked, not which area works
 * it), so the inbox has to be able to ask for exactly those to triage them. `-1` is what the
 * query reads as "no area at all"; it is not an id anybody can hold.
 */
function areaFilter(value) {
  if (value === "none") return -1;
  return optionalId(value, "areaId");
}

function optionalId(value, field) {
  if (value === null || value === undefined || value === "") return null;
  return requireId(value, field);
}

function uniqueIds(values, field) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw ApiError.badRequest(`${field} must be an array.`);
  return [...new Set(values.map((value) => requireId(value, field)))];
}

function shapeRequest(row) {
  return {
    id: row.id,
    folio: row.folio,
    title: row.title,
    requester: row.requester,
    data: row.data,
    schemaVersionId: row.schema_version_id,
    schemaId: row.schema_id,
    schemaCode: row.schema_code,
    schemaName: row.schema_name,
    schemaVersion: row.schema_version,
    // Rebuilt rather than passed through: jsonb sorts object keys by length then bytes, so the
    // document comes back as { information, deliverables } and a client reading it in order
    // would render the sections backwards.
    fields: row.schema_fields
      ? {
          deliverables: row.schema_fields.deliverables ?? [],
          information: row.schema_fields.information ?? [],
        }
      : null,
    areaId: row.area_id,
    areaName: row.area_name ?? null,
    // The flow it is routed by, or null. `workflowId` and `version` name the template it was
    // copied from; both are null for a flow designed for this request.
    flow:
      Array.isArray(row.flow_phases) && row.flow_phases.length > 0
        ? {
            workflowVersionId: row.workflow_version_id ?? null,
            workflowId: row.flow_workflow_id ?? null,
            workflowName: row.flow_workflow_name ?? null,
            version: row.flow_version ?? null,
            phases: row.flow_phases,
          }
        : null,
    statusId: row.status_id,
    statusCode: row.status_code,
    statusLabel: row.status_label,
    statusIsTerminal: row.status_is_terminal,
    statusSince: row.status_since,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name ?? null,
    priority: row.priority,
    source: row.source,
    sheetId: row.sheet_id,
    sheetName: row.sheet_name ?? null,
    sourceIndex: row.source_index,
    // The raw row as the book held it, unmapped columns included (RF-SOL-06).
    sourceData: row.source_data,
    sourceHash: row.source_hash,
    possibleDuplicateOf: row.possible_duplicate_of,
    duplicateOfFolio: row.duplicate_of_folio ?? null,
    projectId: row.project_id,
    projectKey: row.project_key ?? null,
    projectTitle: row.project_title ?? null,
    folderId: row.folder_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function shapeListed(row) {
  return {
    id: row.id,
    folio: row.folio,
    title: row.title,
    requester: row.requester,
    areaId: row.area_id,
    areaName: row.area_name ?? null,
    hasFlow: row.has_flow ?? false,
    // The inboxes it sits in through its flow: the areas of the first phase.
    firstPhaseAreas: row.first_phase_areas ?? [],
    statusId: row.status_id,
    statusCode: row.status_code,
    statusLabel: row.status_label,
    statusSince: row.status_since,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name ?? null,
    priority: row.priority,
    source: row.source,
    sheetId: row.sheet_id,
    schemaCode: row.schema_code,
    schemaName: row.schema_name,
    possibleDuplicateOf: row.possible_duplicate_of,
    projectId: row.project_id,
    projectKey: row.project_key ?? null,
    createdAt: row.created_at,
  };
}

function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    if (err.constraint === "uq_requests_sheet_hash") {
      return ApiError.conflict("That row of that book has already been imported.");
    }
    return ApiError.conflict("That request already exists.");
  }
  if (err?.code === FOREIGN_KEY_VIOLATION) {
    return ApiError.badRequest("A referenced record does not exist.");
  }
  return err;
}

export default new Requests();
