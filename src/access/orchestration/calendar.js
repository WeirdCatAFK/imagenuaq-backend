// The calendar (RF-CAL-02, RF-CAL-03, RF-CAL-05): stages, absences, global events and the semester
// closure windows over a span of days. Stage events are kept by a trigger and absences come from the
// view without the reason, so only global events and closures are written here (DATAMODEL §2.19).
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  EXCLUSION_VIOLATION,
  CHECK_VIOLATION,
  optionalDate,
  optionalId,
  optionalText,
  optionalBoolean,
  requireId,
  requireText,
} from "../../utils/validate.js";

/** The widest span one read may ask for: a month grid with its spill-over weeks, plus slack. */
const MAX_DAYS = 92;

const GLOBAL_TYPES = ["festivo", "general"];

const NOTE_SCOPES = ["personal", "area", "global"];

/** The recurrence the SQL expansion understands; `recurrence_until` carries the end, not UNTIL. */
const RULE = /^FREQ=(YEARLY|WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*)$/;

class Calendar {
  /**
   * What the caller may see on the days `from`..`to`. `scope` is `mine` (their own stages and
   * absences), `area` (everything of the areas they belong to, or of `areaId`) or `all`, which only
   * coordination may ask for. Global events and closures come with every scope.
   *
   * @param {{from: string, to: string, scope?: string, areaId?: unknown, userId?: unknown}} input
   * @throws {ApiError} 400 on a bad span or scope, 403 on `all` to anyone but coordination.
   */
  async list({ from, to, scope = "area", areaId, userId }) {
    const start = optionalDate(from, "from");
    const end = optionalDate(to, "to");
    if (start === null || end === null) throw ApiError.badRequest("from and to are required.");
    if (end < start) throw ApiError.badRequest("to must not be earlier than from.");
    if ((Date.parse(end) - Date.parse(start)) / 86_400_000 >= MAX_DAYS) {
      throw ApiError.badRequest(`A calendar read covers at most ${MAX_DAYS} days.`);
    }
    if (!["mine", "area", "all"].includes(scope)) throw ApiError.badRequest("scope must be mine, area or all.");

    const actor = currentActor();
    const admin = actor.role === "admin";
    if (scope === "all" && !admin) throw ApiError.forbidden("Only coordination sees every area's calendar.");
    const filter = {
      from: start,
      to: end,
      viewerId: admin ? null : actor.id,
      actorId: actor.id,
      areaId: optionalId(areaId, "areaId"),
      userId: scope === "mine" ? actor.id : optionalId(userId, "userId"),
    };

    const [rows, absences, dues, closures] = await Promise.all([
      query.calendarEvents(filter),
      query.calendarAbsences(filter),
      query.calendarDues(filter),
      query.listClosures(start, end),
    ]);
    return {
      from: start,
      to: end,
      events: [...rows.map((row) => shapeEvent(row, actor)), ...absences.map(shapeAbsence), ...dues.map(shapeDue)],
      closures: closures.map(shapeClosure),
    };
  }

  /**
   * A global event, seen by everyone: a festivo or a general announcement, once or repeating.
   *
   * @throws {ApiError} 400 on a bad payload or a rule outside the supported subset.
   */
  async createEvent(input) {
    const fields = readEvent(input, true);
    const row = await query.insertGlobalEvent({ ...fields, createdBy: currentActor().id });
    await events.emit({ action: "record_created", target: { table: "events", id: row.id }, after: row });
    return shapeGlobal(row);
  }

  /**
   * Changes or moves a global event. A stage or absence event is not one, and is refused.
   *
   * @throws {ApiError} 400, 404 when `eventId` is not a global event.
   */
  async updateEvent(eventId, input) {
    const id = requireId(eventId, "eventId");
    const before = await query.getGlobalEvent(id);
    if (!before) throw ApiError.notFound("Global event not found.");
    const until = before.recurrence_until === null ? null : new Date(before.recurrence_until).toISOString();
    const fields = readEvent({ rule: before.rule, until, ...input }, false);
    const starts = new Date(fields.startsAt ?? before.starts_at);
    const ends = new Date(fields.endsAt ?? before.ends_at);
    if (ends <= starts) throw ApiError.badRequest("endsAt must be after startsAt.");
    const row = await query.updateGlobalEvent(id, fields);
    await events.emit({ action: "record_updated", target: { table: "events", id }, before, after: row });
    return shapeGlobal(row);
  }

  /** @throws {ApiError} 404 when `eventId` is not a global event. */
  async deleteEvent(eventId) {
    const id = requireId(eventId, "eventId");
    const before = await query.getGlobalEvent(id);
    if (!before || !(await query.deleteGlobalEvent(id))) throw ApiError.notFound("Global event not found.");
    await events.emit({ action: "record_deleted", target: { table: "events", id }, before });
  }

  /** Every semester closure window, earliest first (RF-CAL-03). */
  async listClosures() {
    return (await query.listClosures()).map(shapeClosure);
  }

  /** @throws {ApiError} 400, 409 when it overlaps another window. */
  async createClosure(input) {
    const fields = readClosure(input, true);
    const row = await translate(() => query.insertClosure({ ...fields, createdBy: currentActor().id }));
    await events.emit({ action: "record_created", target: { table: "period_closures", id: row.id }, after: row });
    return shapeClosure(row);
  }

  /** @throws {ApiError} 400, 404, 409 when the new dates overlap another window. */
  async updateClosure(closureId, input) {
    const id = requireId(closureId, "closureId");
    const row = await translate(() => query.updateClosure(id, readClosure(input, false)));
    if (!row) throw ApiError.notFound("Closure window not found.");
    await events.emit({ action: "record_updated", target: { table: "period_closures", id }, after: row });
    return shapeClosure(row);
  }

  /**
   * A note on a day, like a post-it. `personal` only its author reads; `area` the members of an area
   * the author belongs to (coordination: any area); `global` everyone, and only coordination writes it.
   *
   * @param {{day: string, text: string, scope?: string, areaId?: unknown}} input
   * @throws {ApiError} 400, 403 on an area the author is not in or a global note by anyone else.
   */
  async createNote(input) {
    const body = input ?? {};
    const day = optionalDate(body.day, "day");
    if (day === null) throw ApiError.badRequest("day is required.");
    const text = requireText(body.text, "text", 300);
    const scope = body.scope ?? "personal";
    if (!NOTE_SCOPES.includes(scope)) throw ApiError.badRequest("scope must be personal, area or global.");
    const actor = currentActor();
    const admin = actor.role === "admin";
    let areaId = null;
    if (scope === "area") {
      areaId = requireId(body.areaId, "areaId");
      if (!admin && !(await query.isUserMemberOfArea(actor.id, areaId))) {
        throw ApiError.forbidden("A note for an area needs its author to be in that area.");
      }
    }
    if (scope === "global" && !admin) throw ApiError.forbidden("Only coordination leaves notes for everyone.");

    const row = await query.insertNote({ day, text, scope, areaId, authorId: actor.id });
    await events.emit({ action: "record_created", target: { table: "events", id: row.id }, after: row });
    return shapeNote(row);
  }

  /** Rewrites a note or moves it to another day. @throws {ApiError} 400, 403 to anyone but its author, 404. */
  async updateNote(noteId, input) {
    const id = requireId(noteId, "noteId");
    const before = await this.#ownNote(id);
    const body = input ?? {};
    const row = await query.updateNote(id, {
      text: optionalText(body.text, "text", 300),
      day: optionalDate(body.day, "day"),
    });
    await events.emit({ action: "record_updated", target: { table: "events", id }, before, after: row });
    return shapeNote(row);
  }

  /** @throws {ApiError} 403 to anyone but its author, 404. */
  async deleteNote(noteId) {
    const id = requireId(noteId, "noteId");
    const before = await this.#ownNote(id);
    await query.deleteNote(id);
    await events.emit({ action: "record_deleted", target: { table: "events", id }, before });
  }

  /** The note `id`, if the caller wrote it; a global note coordination may also change. */
  async #ownNote(id) {
    const note = await query.getNote(id);
    if (!note) throw ApiError.notFound("Note not found.");
    const actor = currentActor();
    const globalNote = note.area_id === null && !note.personal;
    if (String(note.created_by) !== String(actor.id) && !(globalNote && actor.role === "admin")) {
      throw ApiError.forbidden("Only its author changes a note.");
    }
    return note;
  }

  /** @throws {ApiError} 404. */
  async deleteClosure(closureId) {
    const id = requireId(closureId, "closureId");
    if (!(await query.deleteClosure(id))) throw ApiError.notFound("Closure window not found.");
    await events.emit({ action: "record_deleted", target: { table: "period_closures", id } });
  }
}

/** A global event's payload. On create every required field must be there; on update any may be missing. */
function readEvent(input, creating) {
  const body = input ?? {};
  const type = body.type === undefined && !creating ? null : String(body.type ?? "general");
  if (type !== null && !GLOBAL_TYPES.includes(type)) throw ApiError.badRequest("type must be festivo or general.");
  const startsAt = optionalInstant(body.startsAt, "startsAt");
  const endsAt = optionalInstant(body.endsAt, "endsAt");
  if (creating && (startsAt === null || endsAt === null)) throw ApiError.badRequest("startsAt and endsAt are required.");
  if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw ApiError.badRequest("endsAt must be after startsAt.");
  }
  const rule = optionalText(body.rule, "rule", 200);
  if (rule !== null && !RULE.test(rule)) {
    throw ApiError.badRequest("rule must be FREQ=YEARLY or FREQ=WEEKLY;BYDAY=MO,TU,… ; give the end as until.");
  }
  return {
    typeCode: type,
    title: creating ? requireText(body.title, "title", 300) : optionalText(body.title, "title", 300),
    description: optionalText(body.description, "description", 2000),
    allDay: optionalBoolean(body.allDay, "allDay") ?? (creating ? false : null),
    startsAt,
    endsAt,
    rule,
    until: rule === null ? null : optionalInstant(body.until, "until"),
  };
}

function readClosure(input, creating) {
  const body = input ?? {};
  const name = creating ? requireText(body.name, "name", 200) : optionalText(body.name, "name", 200);
  const startsOn = optionalDate(body.startsOn, "startsOn");
  const endsOn = optionalDate(body.endsOn, "endsOn");
  if (creating && (startsOn === null || endsOn === null)) throw ApiError.badRequest("startsOn and endsOn are required.");
  return { name, startsOn, endsOn };
}

function optionalInstant(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw ApiError.badRequest(`${field} must be a date and time in ISO 8601.`);
  }
  return new Date(value).toISOString();
}

async function translate(write) {
  try {
    return await write();
  } catch (err) {
    if (err?.code === EXCLUSION_VIOLATION) throw ApiError.conflict("That window overlaps another closure window.");
    if (err?.code === CHECK_VIOLATION) throw ApiError.badRequest("endsOn must not be earlier than startsOn.");
    throw err;
  }
}

function shapeEvent(row, actor) {
  const stage = row.stage_id !== null;
  if (row.type === "nota") return shapeNoteOccurrence(row, actor);
  return {
    id: row.id,
    kind: stage ? "stage" : row.is_global ? "global" : "other",
    type: row.type,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: row.all_day,
    rule: row.rule,
    until: row.recurrence_until,
    seriesStartsAt: row.series_starts_at,
    seriesEndsAt: row.series_ends_at,
    editable: !stage && row.is_global && GLOBAL_TYPES.includes(row.type),
    stageId: row.stage_id,
    stageStatus: row.stage_status,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectTitle: row.project_title,
    hasCost: row.has_cost ?? false,
    inClosure: row.in_closure,
    areaId: row.area_id,
    areaName: row.area_name,
    userId: row.user_id,
    userName: row.user_name,
  };
}

/** A note as the calendar draws it: who it is for, and whether the reader may move or change it. */
function shapeNoteOccurrence(row, actor) {
  const mine = String(row.created_by) === String(actor.id);
  const scope = row.is_global ? "global" : row.area_id !== null ? "area" : "personal";
  return {
    id: row.id,
    kind: "note",
    type: "nota",
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: true,
    noteScope: scope,
    mine,
    editable: mine || (scope === "global" && actor.role === "admin"),
    areaId: row.area_id,
    areaName: row.area_name,
    userId: null,
    userName: null,
  };
}

function shapeNote(row) {
  return {
    id: row.id,
    text: row.title,
    day: row.day,
    scope: row.personal ? "personal" : row.area_id !== null ? "area" : "global",
    areaId: row.area_id,
  };
}

/** A project's due date as a one-day marker; `day` is the date as it is, with no time zone to shift it. */
function shapeDue(row) {
  return {
    id: row.id,
    kind: "due",
    type: "entrega",
    title: `${row.key} · ${row.title}`,
    day: row.due_on,
    allDay: true,
    editable: false,
    priority: row.priority,
    projectId: row.id,
    projectKey: row.key,
    projectTitle: row.title,
    hasCost: row.has_cost,
    inClosure: row.in_closure,
    areaId: null,
    areaName: null,
    userId: null,
    userName: null,
  };
}

function shapeAbsence(row) {
  return {
    id: row.id,
    kind: "absence",
    type: "ausencia",
    title: row.user_name ?? row.area_name ?? "Ausencia",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: row.all_day,
    editable: false,
    areaId: row.area_id,
    areaName: row.area_name,
    userId: row.user_id,
    userName: row.user_name,
  };
}

function shapeGlobal(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    allDay: row.all_day,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    rule: row.rule,
    until: row.recurrence_until,
  };
}

function shapeClosure(row) {
  return { id: row.id, name: row.name, startsOn: row.starts_on, endsOn: row.ends_on };
}

export default new Calendar();
