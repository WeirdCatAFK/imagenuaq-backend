// Each person's stages, the area inbox, the load panel and the sign-off queue (RF-TSK-01 to RF-TSK-07,
// RF-FLW-03). The unit of work is the project stage: there are no free-standing tasks. Only a leader
// of the stage's area hands it out and signs it off. Load is a count of open stages, never of hours.
import query from "../resources/query.js";
import projects from "./projects.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import { optionalDate, requireId, optionalId } from "../../utils/validate.js";

/** The window the load panel counts absences over when the caller names none: this week. */
const WINDOW_DAYS = 7;

const OPEN_STAGE = ["pending", "active", "waiting_external"];

class Tasks {
  /**
   * The open stages the signed-in person is responsible for (RF-TSK-03), with what they have
   * delivered so far. A delivered stage stays here until its sign-off closes it.
   */
  async listMine() {
    return { stages: (await query.listAssignedStages(currentActor().id)).map(shapeAssignedStage) };
  }

  /**
   * The delivered stages waiting for the caller's sign-off (RF-FLW-03): those of the areas they
   * lead, every area for coordination.
   */
  async listToReview() {
    const actor = currentActor();
    const rows = await query.listToReview(actor.role === "admin" ? null : actor.id);
    return {
      stages: rows.map((row) => ({ ...shapeAssignedStage(row), assignedToName: row.assigned_to_name ?? null })),
    };
  }

  /**
   * Signs a stage off from the review queue (RF-FLW-03). The same sign-off as the project detail's,
   * which needs `project.write`; here the leader of the stage's area may give it.
   *
   * @param {{decision: 'approved'|'rejected', comment?: string}} input
   * @throws {ApiError} 400, 403 to anyone but coordination and the area's leaders, 404, 409.
   */
  async signOff(stageId, { decision, comment = null }) {
    const id = requireId(stageId, "stageId");
    const stage = await query.getProjectStage(id);
    if (!stage || stage.project_deleted_at !== null) throw ApiError.notFound("Stage not found.");
    await this.#requireLead(stage.area_id);
    return projects.approve(stage.project_id, id, { decision, comment });
  }

  /**
   * Hands an open stage to a member of its area (RF-TSK-01), from the inbox. It is the same
   * `project_stages.assigned_to` the project detail edits under `project.write`; here the
   * area's own leader may set it.
   *
   * @throws {ApiError} 400 when the person is not in the area, 403, 404, 409 on a stage that
   *   is no longer open.
   */
  async assignStage(stageId, userId) {
    const id = requireId(stageId, "stageId");
    const stage = await query.getProjectStage(id);
    if (!stage || stage.project_deleted_at !== null) throw ApiError.notFound("Stage not found.");
    if (!OPEN_STAGE.includes(stage.status)) {
      throw ApiError.conflict(`A ${stage.status} stage cannot be reassigned.`);
    }
    await this.#requireLead(stage.area_id);
    const assignee = optionalId(userId, "userId");
    await this.#requireMember(assignee, stage.area_id);

    const row = await query.setStageAssignee(id, assignee);
    await events.emit({
      action: "record_updated",
      target: { table: "project_stages", id },
      before: { assigned_to: stage.assigned_to },
      after: { assigned_to: row.assigned_to },
    });
    return { id, assignedTo: row.assigned_to };
  }

  /**
   * What `areaId` still has to hand out, most urgent first (RF-TSK-01, RF-TSK-05).
   *
   * @throws {ApiError} 403 to anyone but coordination and the area's leaders.
   */
  async listUnassigned(areaId) {
    const area = requireId(areaId, "areaId");
    await this.#requireLead(area);
    return (await query.listUnassigned(area)).map((row) => ({
      id: row.id,
      title: row.title,
      priority: row.priority,
      dueOn: row.due_on,
      projectId: row.project_id,
      projectKey: row.project_key,
      projectTitle: row.project_title,
      phaseName: row.phase_name,
    }));
  }

  /**
   * The load of each member of `areaId`: their open stages, lightest first, with the
   * days an approved absence keeps them out between `from` and `to` (RF-TSK-06, RF-TSK-07). The
   * lightest member with no absence in the window is marked `suggested`.
   *
   * @param {number} areaId
   * @param {{from?: string, to?: string}} [window] YYYY-MM-DD; this week when omitted.
   * @throws {ApiError} 400 on a bad window, 403 to anyone but coordination and the area's leaders.
   */
  async workload(areaId, window = {}) {
    const area = requireId(areaId, "areaId");
    const { start, end } = parseWindow(window);
    await this.#requireLead(area);
    const members = await this.#members([area], start, end);
    return { from: start, to: end, members: members.get(String(area)) ?? [] };
  }

  /**
   * Every area the caller hands work out in -- all of them for coordination -- with what each
   * still has to assign and its team's load, for the whole-system view (RF-TSK-06, RF-RPT-02).
   *
   * @param {{from?: string, to?: string}} [window] YYYY-MM-DD; this week when omitted.
   * @throws {ApiError} 400 on a bad window.
   */
  async overview(window = {}) {
    const { start, end } = parseWindow(window);
    const actor = currentActor();
    const areas = await query.areasHandedOutBy(actor.role === "admin" ? null : actor.id);
    const counts = new Map(
      (await query.inboxCounts(areas.map((area) => area.id))).map((row) => [String(row.area_id), row]),
    );
    const members = await this.#members(areas.map((area) => area.id), start, end);
    const shaped = areas.map((area) => {
      const count = counts.get(String(area.id));
      return {
        id: area.id,
        name: area.name,
        unassigned: count?.unassigned ?? 0,
        late: count?.late ?? 0,
        members: members.get(String(area.id)) ?? [],
      };
    });
    return { from: start, to: end, areas: shaped };
  }

  /**
   * The members of each of `areaIds` with their open stages and the days they are away in the
   * window, keyed by the area's id as a string. Two queries whatever the number of areas.
   */
  async #members(areaIds, start, end) {
    const rows = await query.areaWorkload(areaIds, start, end);
    const stages = await query.openStagesOf([...new Set(rows.map((row) => row.id))]);
    const byArea = new Map();
    for (const row of rows) {
      const key = String(row.area_id);
      if (!byArea.has(key)) byArea.set(key, []);
      byArea.get(key).push(row);
    }
    for (const [key, areaRows] of byArea) byArea.set(key, this.#shapeMembers(areaRows, stages));
    return byArea;
  }

  /** One area's members, lightest first, with the lightest one free all window `suggested`. */
  #shapeMembers(rows, stages) {
    const members = rows
      .map((row) => ({
        userId: row.id,
        name: row.full_name,
        isAreaLeader: row.is_area_leader,
        openStages: row.open_stages,
        awayDays: row.away_days,
        awayDates: row.away_dates,
        stages: stages.filter((stage) => String(stage.assigned_to) === String(row.id)).map(shapeLoadStage),
        suggested: false,
      }))
      .sort((a, b) => a.openStages - b.openStages || a.name.localeCompare(b.name));

    const pick = members.find((member) => member.awayDays === 0);
    if (pick) pick.suggested = true;
    return members;
  }

  async #requireLead(areaId) {
    const actor = currentActor();
    if (actor.role === "admin") return;
    if (!(await query.isUserAreaLeader(actor.id, areaId))) {
      throw ApiError.forbidden("Only a leader of that area hands out its work.");
    }
  }

  async #requireMember(userId, areaId) {
    if (userId === null) return;
    if (!(await query.isUserMemberOfArea(userId, areaId))) {
      throw ApiError.badRequest("The assignee must be a member of the stage's area.");
    }
  }
}

function shapeAssignedStage(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectTitle: row.project_title,
    priority: row.project_priority,
    dueOn: row.project_due_on,
    areaId: row.area_id,
    areaName: row.area_name,
    phaseName: row.phase_name,
    title: row.title,
    status: row.status,
    startedAt: row.started_at,
    inputNote: row.input_note ?? null,
    outputNote: row.output_note ?? null,
    outputs: row.outputs ?? [],
    deliveryNote: row.delivery_note,
    deliveryFileId: row.delivery_file_id,
    deliveryFileName: row.delivery_file_name ?? null,
    deliveredByName: row.delivered_by_name ?? null,
    deliveredAt: row.delivered_at,
  };
}

/** A stage as the load panels list it under a person: enough to name it and open its project. */
function shapeLoadStage(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    areaName: row.area_name,
    phaseName: row.phase_name,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectTitle: row.project_title,
    priority: row.priority,
    dueOn: row.due_on,
  };
}

/** The `{from, to}` query as YYYY-MM-DD, `WINDOW_DAYS` from today when omitted. */
function parseWindow({ from, to }) {
  const start = optionalDate(from, "from") ?? isoDate(new Date());
  const end = optionalDate(to, "to") ?? isoDate(new Date(Date.parse(start) + (WINDOW_DAYS - 1) * 86_400_000));
  if (end < start) throw ApiError.badRequest("to must not be earlier than from.");
  return { start, end };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export default new Tasks();
