// Tier 3: projects, their stages, the sign-offs that move them and the values they carry
// (RF-PRY-02, RF-FLW-01, RF-FLW-03, RF-FLW-06).
//
// Three rules from DATAMODEL.md hold here and are easy to break:
//
//   - **A project has no current stage.** The active stage is the set of `project_stages`
//     rows with `status = 'active'` (§2.1); `seq` is display order and decides nothing.
//   - **`status_id` and `status_since` move together**, in the same UPDATE (§2.7). The
//     history goes to `logs`, not to a table of its own.
//   - **A stage repeats by `attempt`** (§2.6): a rejected sign-off closes the row and opens
//     a fresh one for the same stage, so what happened stays readable.
//
// Stages are created by hand here. When the declarative workflow lands they are instantiated
// from `workflow_stages` instead, and `advanceStage()` in query.js is already the statement
// that walk will reuse -- nothing in this module's shape has to change for it.
//
// A sign-off needs `project.write` and nothing more: the permission is the policy. Gating it
// on membership of the stage's area was considered and declined -- RF-FLW-03 asks for the
// decision to be recorded with its author, not for a second authorisation model.
import query from "../resources/query.js";
import statuses from "./statuses.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

/** Column widths and the CHECK from projects-spine. */
const KEY_MAX = 50;
const KEY_FORMAT = /^[A-Z0-9][A-Z0-9_-]*$/;
const TITLE_MAX = 300;
const REQUESTER_MAX = 300;
const FIELD_KEY_MAX = 100;

/** The status a project starts at when the caller names none (RF-EST-01). */
const DEFAULT_STATUS = "recibido";

/** `project_stages.status`: the flow machine, not the visible catalogue (§2.7). */
const STAGE_STATUSES = ["pending", "active", "waiting_external", "done", "cancelled"];
const LIST_STATES = ["open", "closed", "archived", "all"];

class Projects {
  /**
   * Creates a project with, optionally, the requests it converts, its first field values and
   * its first stages -- one statement, so a failure leaves nothing behind.
   *
   * @param {object} input
   * @param {string} input.title
   * @param {string} [input.key] Omitted: `PRY-000001` from the sequence.
   * @param {string} [input.requester] The requesting party, as a string (§2.11).
   * @param {{key: string, value: unknown}[]} [input.fieldValues]
   * @param {object[]} [input.stages] `{areaId, title, seq?, assignedTo?}`; the lowest seq
   *   starts active, the rest pending.
   * @param {number[]} [input.requestIds] Requests to link (RF-PRY-01).
   * @returns {Promise<object>} The project as `getById()` shapes it.
   * @throws {ApiError} 400 on a bad payload or an unknown reference, 409 on a duplicate key
   *   or on a request that is already converted.
   */
  async create({
    key, title, description = null, requester = null, schemaVersionId = null, statusId = null,
    priority = 0, hasCost = false, carriedOver = false, startsOn = null, dueOn = null,
    folderId = null, eventCollectionId = null, fieldValues = [], stages = [], requestIds = [],
  }) {
    const payload = {
      key: key === undefined || key === null ? null : requireKey(key),
      title: requireText(title, "title", TITLE_MAX),
      description: cleanText(description),
      requester: optionalText(requester, "requester", REQUESTER_MAX),
      schemaVersionId: optionalId(schemaVersionId, "schemaVersionId"),
      priority: requireInt(priority, "priority"),
      hasCost: requireBoolean(hasCost, "hasCost"),
      carriedOver: requireBoolean(carriedOver, "carriedOver"),
      startsOn: optionalDate(startsOn, "startsOn"),
      dueOn: optionalDate(dueOn, "dueOn"),
      folderId: optionalId(folderId, "folderId"),
      eventCollectionId: optionalId(eventCollectionId, "eventCollectionId"),
      statusId: await this.#resolveStatus(statusId, stages),
      fieldValues: normaliseFieldValues(fieldValues),
      stages: normaliseStages(stages),
      requestIds: uniqueIds(requestIds, "requestIds"),
      createdBy: currentActor()?.id ?? null,
    };

    let row;
    try {
      row = await query.createProject(payload);
    } catch (err) {
      throw translate(err);
    }

    // The CTE links only unconverted requests, so a short count means somebody else got
    // there first. The project is already written, so this is reported rather than hidden.
    if (row.linked_count !== payload.requestIds.length) {
      await query.deleteProject(row.id);
      throw ApiError.conflict(
        "One of those requests already belongs to a project; nothing was created.",
      );
    }

    await events.emit({
      action: "record_created",
      target: { table: "projects", id: row.id },
      after: row,
    });

    for (const stage of await query.listProjectStages(row.id)) {
      if (stage.status === "active") await emitStage("stage_activated", stage);
    }

    return this.getById(row.id);
  }

  /** @throws {ApiError} 404 */
  async getById(projectId) {
    const row = await query.getProject(requireId(projectId, "projectId"));
    if (!row) throw ApiError.notFound("Project not found.");
    return shapeProject(row);
  }

  /**
   * The board (RF-PRY-02). `state` defaults to `open`; `fieldKey`/`fieldValue` is RF-IMP-08's
   * lookup by a value some stage produced.
   */
  async list(filters = {}) {
    const state = filters.state ?? "open";
    if (!LIST_STATES.includes(state)) {
      throw ApiError.badRequest(`state must be one of: ${LIST_STATES.join(", ")}.`);
    }

    const limit = filters.limit === undefined ? 50 : requireInt(filters.limit, "limit");
    const offset = filters.offset === undefined ? 0 : requireInt(filters.offset, "offset");
    if (limit < 1 || limit > 200) throw ApiError.badRequest("limit must be between 1 and 200.");
    if (offset < 0) throw ApiError.badRequest("offset must not be negative.");

    const rows = await query.listProjects({
      q: cleanText(filters.q),
      statusId: optionalId(filters.statusId, "statusId"),
      areaId: optionalId(filters.areaId, "areaId"),
      assignedTo: optionalId(filters.assignedTo, "assignedTo"),
      requester: cleanText(filters.requester),
      hasCost: optionalBoolean(filters.hasCost, "hasCost"),
      carriedOver: optionalBoolean(filters.carriedOver, "carriedOver"),
      fieldKey: cleanText(filters.fieldKey),
      fieldValue: cleanText(filters.fieldValue),
      state,
      sort: filters.sort === "due" ? "due" : "priority",
      limit,
      offset,
    });

    return rows.map(shapeListed);
  }

  /** @throws {ApiError} 400 when nothing valid is sent, 404, 409 on a duplicate key. */
  async update(projectId, input) {
    const id = requireId(projectId, "projectId");

    const payload = {
      key: input.key === undefined ? null : requireKey(input.key),
      title: input.title === undefined ? null : requireText(input.title, "title", TITLE_MAX),
      description: input.description === undefined ? null : cleanText(input.description),
      requester:
        input.requester === undefined
          ? null
          : optionalText(input.requester, "requester", REQUESTER_MAX),
      priority: input.priority === undefined ? null : requireInt(input.priority, "priority"),
      hasCost: input.hasCost === undefined ? null : requireBoolean(input.hasCost, "hasCost"),
      carriedOver:
        input.carriedOver === undefined ? null : requireBoolean(input.carriedOver, "carriedOver"),
      startsOn: input.startsOn === undefined ? null : optionalDate(input.startsOn, "startsOn"),
      dueOn: input.dueOn === undefined ? null : optionalDate(input.dueOn, "dueOn"),
    };

    if (Object.values(payload).every((value) => value === null)) {
      throw ApiError.badRequest("Nothing to update.");
    }

    const before = await query.getProject(id);
    if (!before) throw ApiError.notFound("Project not found.");

    let row;
    try {
      row = await query.updateProject(id, payload);
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: "record_updated",
      target: { table: "projects", id },
      before,
      after: row,
    });

    return this.getById(id);
  }

  /**
   * Moves the visible status (RF-EST-01). The status must be global or belong to an area that
   * has a stage in this project, so a board cannot be set to another area's vocabulary.
   *
   * @throws {ApiError} 400 on a status this project may not use, 404.
   */
  async setStatus(projectId, statusId) {
    const id = requireId(projectId, "projectId");
    const status = requireId(statusId, "statusId");

    const before = await query.getProject(id);
    if (!before) throw ApiError.notFound("Project not found.");

    await this.#assertStatusUsable(status, id);

    const row = await query.setProjectStatus(id, status);

    await events.emit({
      action: "status_changed",
      target: { table: "projects", id },
      before,
      after: row,
    });

    return this.getById(id);
  }

  /**
   * Closes a project. Refused while any stage is still `active` or `waiting_external`:
   * RF-EST-05 asks after what is pending, and an open stage is the cheapest pending thing to
   * see. The invoice and evidence halves of that requirement wait for FIN and ARC.
   *
   * @throws {ApiError} 404, 409 when a stage is open or it is already closed.
   */
  async close(projectId) {
    const id = requireId(projectId, "projectId");

    const before = await query.getProject(id);
    if (!before) throw ApiError.notFound("Project not found.");

    const open = before.stages.filter((stage) =>
      stage.status === "active" || stage.status === "waiting_external",
    );
    if (open.length > 0) {
      throw ApiError.conflict(
        `Cannot close with ${open.length} stage(s) still open: ${open.map((s) => s.title).join(", ")}.`,
      );
    }

    const row = await query.stampProject(id, "closed");
    if (!row) throw ApiError.conflict("Project is already closed.");

    await events.emit({
      action: "record_updated",
      target: { table: "projects", id },
      before,
      after: row,
    });

    return this.getById(id);
  }

  /**
   * Archives a project. A different act from closing -- a closed project is finished work, an
   * archived one is out of the way -- so it has its own column and its own call.
   *
   * @throws {ApiError} 404, 409 when already archived.
   */
  async archive(projectId) {
    const id = requireId(projectId, "projectId");

    const before = await query.getProject(id);
    if (!before) throw ApiError.notFound("Project not found.");

    const row = await query.stampProject(id, "archived");
    if (!row) throw ApiError.conflict("Project is already archived.");

    await events.emit({
      action: "record_updated",
      target: { table: "projects", id },
      before,
      after: row,
    });

    return this.getById(id);
  }

  /** @throws {ApiError} 404 */
  async remove(projectId) {
    const id = requireId(projectId, "projectId");

    const before = await query.getProject(id);
    if (!before) throw ApiError.notFound("Project not found.");

    const row = await query.deleteProject(id);

    await events.emit({
      action: "record_deleted",
      target: { table: "projects", id },
      before,
      after: row,
    });

    return shapeProject({ ...before, deleted_at: row.deleted_at });
  }

  /**
   * Links more requests to an existing project (RF-PRY-01: several requests, one project).
   *
   * @throws {ApiError} 404, 409 when any of them is already converted.
   */
  async attachRequests(projectId, requestIds) {
    const id = requireId(projectId, "projectId");
    const ids = uniqueIds(requestIds, "requestIds");
    if (ids.length === 0) throw ApiError.badRequest("requestIds must not be empty.");

    if (!(await query.getProject(id))) throw ApiError.notFound("Project not found.");

    const linked = await query.attachRequests(id, ids);
    if (linked.length !== ids.length) {
      throw ApiError.conflict("One of those requests does not exist or already has a project.");
    }

    for (const request of linked) {
      await events.emit({
        action: "request_converted",
        target: { table: "requests", id: request.id },
        after: { ...request, project_id: id },
      });
    }

    return this.getById(id);
  }

  // --- Stages (RF-FLW-01) ---

  async listStages(projectId) {
    const id = requireId(projectId, "projectId");
    if (!(await query.getProject(id))) throw ApiError.notFound("Project not found.");
    return (await query.listProjectStages(id)).map(shapeStage);
  }

  /**
   * Adds a stage by hand. `attempt` is computed from the rows already there, so adding the
   * same area and seq twice reruns it rather than colliding.
   *
   * @throws {ApiError} 400 on a bad payload or unknown area/user, 404.
   */
  async addStage(projectId, { areaId, title, seq = 1, status = "pending", assignedTo = null }) {
    const id = requireId(projectId, "projectId");
    if (!(await query.getProject(id))) throw ApiError.notFound("Project not found.");

    const state = requireStageStatus(status);
    if (state === "waiting_external") {
      throw ApiError.badRequest("A stage cannot start blocked; create it, then block it.");
    }
    if (state === "done") {
      throw ApiError.badRequest("A stage is completed by an approval, not created done.");
    }

    try {
      const row = await query.createProjectStage({
        projectId: id,
        areaId: requireId(areaId, "areaId"),
        title: requireText(title, "title", TITLE_MAX),
        seq: requireInt(seq, "seq"),
        status: state,
        assignedTo: optionalId(assignedTo, "assignedTo"),
      });

      await events.emit({
        action: "record_created",
        target: { table: "project_stages", id: row.id },
        after: row,
      });
      if (row.status === "active") await emitStage("stage_activated", row);

      // Re-read so the response carries the area's name, as every other stage read does.
      return shapeStage(await query.getProjectStage(row.id));
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * The stage machine. `pending → active` starts work, `active ↔ waiting_external` parks it on
   * a third party with the reason RF-FLW-07 asks for, `→ cancelled` drops it. `done` is not
   * reachable here: a stage is completed by a sign-off, which is what RF-FLW-03 records.
   *
   * @throws {ApiError} 400 on an illegal transition or a missing reason, 404.
   */
  async updateStage(projectId, stageId, { title, status, blockedReason, assignedTo }) {
    const { id, before } = await this.#ownStage(projectId, stageId);

    let next = status === undefined ? undefined : requireStageStatus(status);
    if (next === "done") {
      throw ApiError.badRequest("A stage is completed by recording an approval on it.");
    }
    if (next !== undefined && (before.status === "done" || before.status === "cancelled")) {
      throw ApiError.conflict(`A ${before.status} stage cannot change status; it reruns instead.`);
    }

    const reason = blockedReason === undefined ? undefined : cleanText(blockedReason);
    if (next === "waiting_external" && reason === null && before.blocked_reason === null) {
      throw ApiError.badRequest("blockedReason is required when a stage waits on a third party.");
    }

    const payload = {
      title: title === undefined ? null : requireText(title, "title", TITLE_MAX),
      status: next ?? null,
      blockedReason: reason ?? null,
      assignedTo: assignedTo === undefined ? null : optionalId(assignedTo, "assignedTo"),
      // Leaving the blocked state clears the reason: it described a wait that is over.
      clearBlocked:
        before.status === "waiting_external" && next !== undefined && next !== "waiting_external",
    };

    if (
      payload.title === null && payload.status === null &&
      payload.blockedReason === null && payload.assignedTo === null && !payload.clearBlocked
    ) {
      throw ApiError.badRequest("Nothing to update.");
    }

    let row;
    try {
      row = await query.updateProjectStage(id, payload);
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: "record_updated",
      target: { table: "project_stages", id },
      before,
      after: row,
    });
    if (before.status !== "active" && row.status === "active") {
      await emitStage("stage_activated", row);
    }

    return shapeStage(await query.getProjectStage(id));
  }

  // --- Approvals (RF-FLW-03) ---

  /**
   * Records a sign-off and moves the stage. `approved` completes it; `rejected` completes it
   * too and opens the same stage again at the next attempt, which is how RF-FLW-03's returned
   * work stays visible instead of overwriting what happened (§2.6).
   *
   * The next stage is not opened here: which stage follows is the flow's business, and the
   * flow does not exist yet. Until it does, whoever runs the project starts the next stage.
   *
   * @param {{decision: 'approved'|'rejected', comment?: string, evidenceFileId?: number}} input
   * @throws {ApiError} 400 on a bad decision or unknown evidence file, 404, 409 when the
   *   stage is not open.
   */
  async approve(projectId, stageId, { decision, comment = null, evidenceFileId = null }) {
    const { id, before } = await this.#ownStage(projectId, stageId);

    if (decision !== "approved" && decision !== "rejected") {
      throw ApiError.badRequest('decision must be "approved" or "rejected".');
    }
    if (before.status !== "active" && before.status !== "waiting_external") {
      throw ApiError.conflict(`Only an open stage can be signed off; this one is ${before.status}.`);
    }

    const actor = currentActor()?.id ?? null;
    if (actor === null) {
      throw ApiError.badRequest("An approval needs a session: approver_user_id cannot be null.");
    }

    let approval;
    try {
      approval = await query.createApproval({
        projectStageId: id,
        decision,
        approverUserId: actor,
        comment: cleanText(comment),
        evidenceFileId: optionalId(evidenceFileId, "evidenceFileId"),
      });
    } catch (err) {
      throw translate(err);
    }

    const rerun =
      decision === "rejected"
        ? [{ areaId: before.area_id, title: before.title, seq: before.seq, assignedTo: before.assigned_to }]
        : [];

    let advanced;
    try {
      advanced = await query.advanceStage(id, { status: "done", nextStages: rerun });
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: "record_created",
      target: { table: "approvals", id: approval.id },
      after: approval,
    });
    await emitStage("stage_completed", advanced.stage);
    for (const opened of advanced.opened) await emitStage("stage_activated", opened);

    // One read for the whole project's stages rather than one per row, so the response
    // carries the area names the list reads carry.
    const joined = new Map(
      (await query.listProjectStages(before.project_id)).map((stage) => [String(stage.id), stage]),
    );
    const withArea = (stage) => shapeStage(joined.get(String(stage.id)) ?? stage);

    return {
      approval: shapeApproval(approval),
      stage: withArea(advanced.stage),
      reopened: advanced.opened.map(withArea),
    };
  }

  // --- Field values (RF-FLW-06, RF-IMP-08) ---

  async listFieldValues(projectId) {
    const id = requireId(projectId, "projectId");
    if (!(await query.getProject(id))) throw ApiError.notFound("Project not found.");
    return (await query.listFieldValues(id)).map(shapeFieldValue);
  }

  /**
   * Writes a value another stage will read. One row per key: a correction is an UPDATE and the
   * provenance moves with it.
   *
   * @throws {ApiError} 400 on a bad key, an empty value or a stage of another project, 404.
   */
  async setFieldValue(projectId, key, { value, producedByStageId = null }) {
    const id = requireId(projectId, "projectId");
    if (!(await query.getProject(id))) throw ApiError.notFound("Project not found.");

    const cleanKey = requireFieldKey(key);
    const text = stringifyValue(value);
    if (text === null) {
      throw ApiError.badRequest("value is required; delete the row instead of emptying it.");
    }

    const stage = optionalId(producedByStageId, "producedByStageId");
    if (stage !== null) {
      const owner = await query.getProjectStage(stage);
      if (!owner || String(owner.project_id) !== String(id)) {
        throw ApiError.badRequest("producedByStageId must be a stage of this project.");
      }
    }

    const before = (await query.listFieldValues(id)).find((row) => row.key === cleanKey) ?? null;

    let row;
    try {
      row = await query.upsertFieldValue(id, { key: cleanKey, value: text, producedByStageId: stage });
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: before ? "record_updated" : "record_created",
      target: { table: "project_field_values", id: row.id },
      before,
      after: row,
    });

    return shapeFieldValue(row);
  }

  /** @throws {ApiError} 404 */
  async deleteFieldValue(projectId, key) {
    const id = requireId(projectId, "projectId");
    if (!(await query.getProject(id))) throw ApiError.notFound("Project not found.");

    const row = await query.deleteFieldValue(id, requireFieldKey(key));
    if (!row) throw ApiError.notFound("That project has no value under that key.");

    await events.emit({
      action: "record_deleted",
      target: { table: "project_field_values", id: row.id },
      before: row,
    });

    return shapeFieldValue(row);
  }

  // --- Internals ---

  /** The status to start at: the caller's, checked, or the global `recibido`. */
  async #resolveStatus(statusId, stages) {
    if (statusId !== null && statusId !== undefined) {
      const id = requireId(statusId, "statusId");
      const status = await query.getStatus(id);
      if (!status) throw ApiError.badRequest("That status does not exist.");
      // At creation there is no project yet, so an area status is checked against the stages
      // the same call is asking for.
      if (status.area_id !== null && !stages.some((st) => String(st.areaId) === String(status.area_id))) {
        throw ApiError.badRequest(
          "That status belongs to an area with no stage in this project.",
        );
      }
      return id;
    }

    const fallback = await statuses.byCode(DEFAULT_STATUS);
    if (!fallback) {
      throw ApiError.badGateway(`The global status "${DEFAULT_STATUS}" is missing from the catalogue.`);
    }
    return fallback.id;
  }

  /** A project may only wear a global status or one of an area it has a stage in. */
  async #assertStatusUsable(statusId, projectId) {
    const status = await query.getStatus(statusId);
    if (!status) throw ApiError.badRequest("That status does not exist.");
    if (status.is_active === false) throw ApiError.badRequest("That status is inactive.");
    if (status.area_id === null) return;

    const stages = await query.listProjectStages(projectId);
    if (!stages.some((stage) => String(stage.area_id) === String(status.area_id))) {
      throw ApiError.badRequest("That status belongs to an area with no stage in this project.");
    }
  }

  /** A stage reached through a project's URL has to belong to it, or the path lies. */
  async #ownStage(projectId, stageId) {
    const project = requireId(projectId, "projectId");
    const id = requireId(stageId, "stageId");

    const before = await query.getProjectStage(id);
    if (!before || String(before.project_id) !== String(project) || before.project_deleted_at !== null) {
      throw ApiError.notFound("Stage not found for that project.");
    }
    return { id, before };
  }
}

/* HELPERS */

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
  if (text === null) return null;
  return requireText(text, field, max);
}

/** Uppercased before the CHECK sees it: `papel-fcq` is a typo, not a refusal. */
function requireKey(value) {
  const text = cleanText(value);
  if (text === null) throw ApiError.badRequest("key is required when sent; omit it to generate one.");
  const key = String(text).toUpperCase();
  if (key.length > KEY_MAX) throw ApiError.badRequest(`key must be ${KEY_MAX} characters or fewer.`);
  if (!KEY_FORMAT.test(key)) {
    throw ApiError.badRequest(
      "key must start with a letter or digit and hold only A-Z, 0-9, - and _.",
    );
  }
  return key;
}

function requireFieldKey(value) {
  const text = cleanText(value);
  if (text === null) throw ApiError.badRequest("A field key is required.");
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(text) || text.length > FIELD_KEY_MAX) {
    throw ApiError.badRequest(
      "A field key must be snake_case: a lowercase letter, then letters, digits or _ (100 max).",
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

function optionalBoolean(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
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

function optionalId(value, field) {
  if (value === null || value === undefined || value === "") return null;
  return requireId(value, field);
}

/** ISO dates only; the CHECK on the pair is the authority on their order. */
function optionalDate(value, field) {
  const text = cleanText(value);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw ApiError.badRequest(`${field} must be a date as YYYY-MM-DD.`);
  }
  return text;
}

function requireStageStatus(status) {
  const text = cleanText(status);
  if (text === null || !STAGE_STATUSES.includes(text)) {
    throw ApiError.badRequest(`status must be one of: ${STAGE_STATUSES.join(", ")}.`);
  }
  return text;
}

function uniqueIds(values, field) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw ApiError.badRequest(`${field} must be an array.`);
  return [...new Set(values.map((value) => requireId(value, field)))];
}

/**
 * `project_field_values.value` is `text NOT NULL`, so a value is stringified and an empty one
 * is dropped rather than stored as ''. Every captured value travels (§2.11); the filtering
 * here is about emptiness, not about which fields are allowed to.
 */
function stringifyValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function normaliseFieldValues(fieldValues) {
  if (!Array.isArray(fieldValues)) throw ApiError.badRequest("fieldValues must be an array.");

  const seen = new Set();
  const out = [];
  for (const entry of fieldValues) {
    if (!entry || typeof entry !== "object") {
      throw ApiError.badRequest("Each field value must be an object with a key and a value.");
    }
    const key = requireFieldKey(entry.key);
    if (seen.has(key)) throw ApiError.badRequest(`Field value "${key}" is repeated.`);
    seen.add(key);

    const value = stringifyValue(entry.value);
    if (value !== null) out.push({ key, value });
  }
  return out;
}

/** The lowest `seq` starts the project; the rest wait. */
function normaliseStages(stages) {
  if (!Array.isArray(stages)) throw ApiError.badRequest("stages must be an array.");
  if (stages.length === 0) return [];

  const parsed = stages.map((stage, index) => {
    if (!stage || typeof stage !== "object") {
      throw ApiError.badRequest("Each stage must be an object.");
    }
    return {
      areaId: requireId(stage.areaId, "stages[].areaId"),
      title: requireText(stage.title, "stages[].title", TITLE_MAX),
      seq: stage.seq === undefined ? index + 1 : requireInt(stage.seq, "stages[].seq"),
      assignedTo: optionalId(stage.assignedTo, "stages[].assignedTo"),
    };
  });

  const first = Math.min(...parsed.map((stage) => stage.seq));
  return parsed.map((stage) => ({ ...stage, status: stage.seq === first ? "active" : "pending" }));
}

/** RF-FLW-04's hook: the notifier will subscribe to these two rather than to record_updated. */
async function emitStage(action, stage) {
  if (!stage) return;
  await events.emit({
    action,
    target: { table: "project_stages", id: stage.id },
    after: stage,
  });
}

function shapeProject(row) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    description: row.description,
    requester: row.requester,
    schemaVersionId: row.schema_version_id,
    statusId: row.status_id,
    statusCode: row.status_code,
    statusLabel: row.status_label,
    statusIsTerminal: row.status_is_terminal,
    statusSince: row.status_since,
    priority: row.priority,
    hasCost: row.has_cost,
    carriedOver: row.carried_over,
    startsOn: row.starts_on,
    dueOn: row.due_on,
    folderId: row.folder_id,
    eventCollectionId: row.event_collection_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at ?? null,
    // Already camelCase: json_build_object shapes them in the query.
    stages: row.stages ?? [],
    fieldValues: row.field_values ?? [],
    requests: row.requests ?? [],
    // §2.1: the current stage is a query, not a column.
    activeStageIds: (row.stages ?? [])
      .filter((stage) => stage.status === "active")
      .map((stage) => stage.id),
  };
}

function shapeListed(row) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    requester: row.requester,
    statusId: row.status_id,
    statusCode: row.status_code,
    statusLabel: row.status_label,
    statusSince: row.status_since,
    priority: row.priority,
    hasCost: row.has_cost,
    carriedOver: row.carried_over,
    startsOn: row.starts_on,
    dueOn: row.due_on,
    closedAt: row.closed_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    openStageCount: row.open_stage_count,
    requestCount: row.request_count,
  };
}

function shapeStage(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    areaId: row.area_id,
    areaName: row.area_name ?? null,
    title: row.title,
    seq: row.seq,
    attempt: row.attempt,
    status: row.status,
    blockedReason: row.blocked_reason,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name ?? null,
    eventId: row.event_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

function shapeApproval(row) {
  return {
    id: row.id,
    projectStageId: row.project_stage_id,
    decision: row.decision,
    approverUserId: row.approver_user_id,
    approverName: row.approver_name ?? null,
    comment: row.comment,
    evidenceFileId: row.evidence_file_id,
    decidedAt: row.decided_at,
  };
}

function shapeFieldValue(row) {
  return {
    key: row.key,
    value: row.value,
    producedByStageId: row.produced_by_stage_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A constraint violation into the refusal the caller earned; anything else untouched. */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    if (err.constraint === "uq_projects_key") {
      return ApiError.conflict("A project with that key already exists.");
    }
    if (err.constraint === "uq_project_stages_attempt") {
      return ApiError.conflict("That stage was already advanced; read it again.");
    }
    return ApiError.conflict("That record already exists.");
  }
  if (err?.code === FOREIGN_KEY_VIOLATION) {
    return ApiError.badRequest("A referenced record does not exist.");
  }
  if (err?.code === CHECK_VIOLATION) {
    if (err.constraint === "projects_date_range") {
      return ApiError.badRequest("dueOn must not be earlier than startsOn.");
    }
    if (err.constraint === "project_stages_blocked_reason_present") {
      return ApiError.badRequest("blockedReason is required when a stage waits on a third party.");
    }
    return ApiError.badRequest("That value is not allowed here.");
  }
  return err;
}

export default new Projects();
