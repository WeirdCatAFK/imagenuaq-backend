// Tier 3: flow templates (RF-FLW-02, RF-PRY-06) -- the reusable flows coordination draws in
// the designer and a project will start from.
//
// **A flow is ordered phases, not a graph** (`flow-templates`, DATAMODEL.md §2.1, §2.17). A
// phase's stages work in parallel (RF-FLW-09); the next phase begins when the previous one is
// done. A stage names the area that does it, what it needs and what it delivers -- field keys,
// the same declaration a project stage carries (RF-FLW-06) -- plus free-text notes for a
// person to read, the working days it is expected to take, and optionally the person who
// usually does it.
//
// **Versions are immutable, like request formats** (§2.2). Saving in the designer publishes a
// new version with the whole content; nothing already published is edited, and a trigger
// refuses it if something tries. A project that started from version 3 keeps its own copy, so
// publishing version 4 moves nothing that is under way.
//
// **The default person must be an active member of the stage's area when the version is
// published**, which is the only moment the check can be made honestly -- people change
// areas. A clone re-checks it and quietly drops anyone who no longer qualifies rather than
// refusing the whole copy; the person was a suggestion, not a commitment.
//
// **Keys are checked for form, not against the published vocabulary**, the same as a project
// stage's. The reserved finance keys (`requiere_factura`) live in no format, and a template
// may name a value that the next format introduces. The designer suggests the vocabulary
// (`GET /api/schemas/field-keys`) so reuse is the easy path.
//
// The publisher is the session, never a body field.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import { requireKeyList } from "../../utils/fieldKeys.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

/** Column widths from flow-templates, checked here so a 22001 becomes a 400 naming the field. */
const CODE_MAX = 50;
const NAME_MAX = 300;
const PHASE_NAME_MAX = 100;
const TITLE_MAX = 300;
const NOTE_MAX = 2000;
const DAYS_MAX = 365;

/** Bounds on a template's size: generous for a real flow, small enough to render. */
const PHASES_MAX = 30;
const STAGES_MAX = 30;

class Workflows {
  /**
   * Creates a template and publishes its version 1 in one statement.
   *
   * @param {{ code: string, name: string, phases: object[] }} input
   * @returns {Promise<object>} The template with its latest version's content.
   * @throws {ApiError} 400 on a bad payload, 409 when the code is taken.
   */
  async create({ code, name, phases }) {
    const cleanCode = requireText(code, "code", CODE_MAX);
    const cleanName = requireText(name, "name", NAME_MAX);
    const normalised = await validatePhases(phases);

    let row;
    try {
      row = await query.createWorkflow({
        code: cleanCode,
        name: cleanName,
        phases: normalised,
        publishedBy: publisher(),
      });
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: "record_created",
      target: { table: "workflows", id: row.id },
      after: row,
    });

    return this.get(row.id);
  }

  /**
   * Publishes the next version of a template with the whole content sent. The previous
   * versions are never modified.
   *
   * @throws {ApiError} 400 on a bad payload, 404, 409 when the template is inactive or
   *   another version was published meanwhile.
   */
  async publish(workflowId, { phases }) {
    const id = requireId(workflowId, "workflowId");
    const normalised = await validatePhases(phases);

    const workflow = await query.getWorkflow(id);
    if (!workflow) throw ApiError.notFound("Workflow not found.");
    if (workflow.is_active === false) {
      throw ApiError.conflict("Cannot publish a version of an inactive workflow.");
    }

    let row;
    try {
      row = await query.publishWorkflowVersion(id, {
        phases: normalised,
        publishedBy: publisher(),
      });
    } catch (err) {
      throw translate(err);
    }

    await events.emit({
      action: "record_created",
      target: { table: "workflow_versions", id: row.id },
      after: row,
    });

    return this.getVersion(row.id);
  }

  /**
   * A new template whose version 1 copies the source's latest version ("Partir de una
   * plantilla"). A default person who no longer belongs to the stage's area is dropped.
   *
   * @throws {ApiError} 400, 404 when the source does not exist, 409 when the code is taken.
   */
  async clone(sourceId, { code, name }) {
    const id = requireId(sourceId, "workflowId");
    const cleanCode = requireText(code, "code", CODE_MAX);
    const cleanName = requireText(name, "name", NAME_MAX);

    let row;
    try {
      row = await query.cloneWorkflow(id, {
        code: cleanCode,
        name: cleanName,
        publishedBy: publisher(),
      });
    } catch (err) {
      throw translate(err);
    }
    if (!row) throw ApiError.notFound("Workflow not found.");

    await events.emit({
      action: "record_created",
      target: { table: "workflows", id: row.id },
      after: { ...row, cloned_from: id },
    });

    return this.get(row.id);
  }

  /** Every template with a summary of its latest version, active or not; the client filters. */
  async list() {
    return (await query.listWorkflows()).map(shapeWorkflow);
  }

  /** One template with its latest version's phases and stages. @throws {ApiError} 404. */
  async get(workflowId) {
    const row = await query.getWorkflow(requireId(workflowId, "workflowId"));
    if (!row) throw ApiError.notFound("Workflow not found.");
    return shapeWorkflow(row);
  }

  /** Every version of a template, newest first, without content. @throws {ApiError} 404. */
  async getVersions(workflowId) {
    const id = requireId(workflowId, "workflowId");
    if (!(await query.getWorkflow(id))) throw ApiError.notFound("Workflow not found.");
    return (await query.listWorkflowVersions(id)).map(shapeVersion);
  }

  /** One version by its id, with its content. @throws {ApiError} 404. */
  async getVersion(versionId) {
    const row = await query.getWorkflowVersion(requireId(versionId, "versionId"));
    if (!row) throw ApiError.notFound("Workflow version not found.");
    return shapeVersion(row);
  }

  /**
   * Identity-level edit: rename, or flip the active flag either way. The content changes only
   * by publishing.
   *
   * @throws {ApiError} 400 when nothing valid is sent, 404.
   */
  async update(workflowId, { name, isActive }) {
    const id = requireId(workflowId, "workflowId");
    const cleanName = name === undefined ? undefined : requireText(name, "name", NAME_MAX);
    if (isActive !== undefined && typeof isActive !== "boolean") {
      throw ApiError.badRequest("isActive must be a boolean.");
    }
    if (cleanName === undefined && isActive === undefined) {
      throw ApiError.badRequest("Nothing to update: send name or isActive.");
    }

    const before = await query.getWorkflow(id);
    if (!before) throw ApiError.notFound("Workflow not found.");

    const row = await query.updateWorkflow(id, { name: cleanName ?? null, isActive: isActive ?? null });

    await events.emit({
      action: "record_updated",
      target: { table: "workflows", id },
      before: identityOf(before),
      after: row,
    });

    return this.get(id);
  }

  /**
   * Deactivates a template. Its versions stay: a project that started from one still reads
   * where it came from.
   *
   * @throws {ApiError} 404, 409 when already inactive.
   */
  async delete(workflowId) {
    const id = requireId(workflowId, "workflowId");

    const before = await query.getWorkflow(id);
    if (!before) throw ApiError.notFound("Workflow not found.");
    if (before.is_active === false) throw ApiError.conflict("Workflow is already inactive.");

    const row = await query.deactivateWorkflow(id);

    await events.emit({
      action: "record_deleted",
      target: { table: "workflows", id },
      before: identityOf(before),
      after: row,
    });

    return this.get(id);
  }
}

/**
 * Checks a template's phases and returns them canonical -- trimmed, keys deduplicated, notes
 * null when blank -- in the shape `query.js` stores: `[{name, stages: [{areaId, title,
 * defaultAssigneeId, inputs, outputs, inputNote, outputNote, estimatedDays}]}]`. Order is
 * position in the arrays. Each refusal names the phase and stage it is about.
 *
 * Exported so a project flow can be validated with the same rules when it is edited in the
 * designer.
 *
 * @param {unknown} phases
 * @returns {Promise<object[]>}
 * @throws {ApiError} 400
 */
export async function validatePhases(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw ApiError.badRequest("phases must be a non-empty array.");
  }
  if (phases.length > PHASES_MAX) {
    throw ApiError.badRequest(`A flow holds at most ${PHASES_MAX} phases.`);
  }

  const normalised = phases.map((phase, p) => {
    const where = `Phase ${p + 1}`;
    if (!phase || typeof phase !== "object") throw ApiError.badRequest(`${where} must be an object.`);
    const name = requireText(phase.name, `${where}: name`, PHASE_NAME_MAX);

    if (!Array.isArray(phase.stages) || phase.stages.length === 0) {
      throw ApiError.badRequest(`${where} has no stages; a phase needs at least one.`);
    }
    if (phase.stages.length > STAGES_MAX) {
      throw ApiError.badRequest(`${where} holds more than ${STAGES_MAX} stages.`);
    }

    const stages = phase.stages.map((stage, s) => {
      const at = `${where}, stage ${s + 1}`;
      if (!stage || typeof stage !== "object") throw ApiError.badRequest(`${at} must be an object.`);
      return {
        areaId: requireId(stage.areaId, `${at}: areaId`),
        title: requireText(stage.title, `${at}: title`, TITLE_MAX),
        defaultAssigneeId:
          stage.defaultAssigneeId === undefined || stage.defaultAssigneeId === null
            ? null
            : requireId(stage.defaultAssigneeId, `${at}: defaultAssigneeId`),
        inputs: prefixed(at, () => requireKeyList(stage.inputs, "inputs")),
        outputs: prefixed(at, () => requireKeyList(stage.outputs, "outputs")),
        inputNote: optionalNote(stage.inputNote, `${at}: inputNote`),
        outputNote: optionalNote(stage.outputNote, `${at}: outputNote`),
        estimatedDays: requireDays(stage.estimatedDays, `${at}: estimatedDays`),
      };
    });

    return { name, stages };
  });

  await assertReferences(normalised);
  return normalised;
}

/* HELPERS */

/**
 * Areas must exist and a default person must be an active member of the stage's area, both
 * checked with one read each rather than one per stage. The foreign keys would catch an
 * unknown area too, but only as "a referenced record does not exist" -- this says which.
 */
async function assertReferences(phases) {
  const areas = new Map((await query.getAreas()).map((area) => [String(area.id), area.name]));
  const stages = phases.flatMap((phase, p) =>
    phase.stages.map((stage, s) => ({ stage, at: `Phase ${p + 1}, stage ${s + 1}` })),
  );

  for (const { stage, at } of stages) {
    if (!areas.has(String(stage.areaId))) {
      throw ApiError.badRequest(`${at}: area ${stage.areaId} does not exist.`);
    }
  }

  const staffed = stages.filter(({ stage }) => stage.defaultAssigneeId !== null);
  if (staffed.length === 0) return;

  const members = new Set(
    (await query.getAreaMembersForAreas([...new Set(staffed.map(({ stage }) => stage.areaId))]))
      .map((row) => `${row.area_id}:${row.id}`),
  );
  for (const { stage, at } of staffed) {
    if (!members.has(`${stage.areaId}:${stage.defaultAssigneeId}`)) {
      throw ApiError.badRequest(
        `${at}: user ${stage.defaultAssigneeId} is not an active member of ${areas.get(String(stage.areaId))}.`,
      );
    }
  }
}

/** Runs a check whose refusal should say which stage it is about. */
function prefixed(at, check) {
  try {
    return check();
  } catch (err) {
    if (err instanceof ApiError) throw ApiError.badRequest(`${at}: ${err.message}`);
    throw err;
  }
}

/** The session's user id, or null outside a request (a script, a job). */
function publisher() {
  return currentActor()?.id ?? null;
}

function requireText(value, field, max) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw ApiError.badRequest(`${field} is required.`);
  if (text.length > max) throw ApiError.badRequest(`${field} must be ${max} characters or fewer.`);
  return text;
}

function optionalNote(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw ApiError.badRequest(`${field} must be a string.`);
  const text = value.trim();
  if (text.length > NOTE_MAX) throw ApiError.badRequest(`${field} must be ${NOTE_MAX} characters or fewer.`);
  return text === "" ? null : text;
}

function requireDays(value, field) {
  const days = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isInteger(days) ||
      days < 1 || days > DAYS_MAX) {
    throw ApiError.badRequest(`${field} must be a whole number of days from 1 to ${DAYS_MAX}.`);
  }
  return days;
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

/** The `workflows` row out of a read that also carries its latest version. */
function identityOf(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    is_active: row.is_active,
    created_at: row.created_at,
  };
}

function shapeWorkflow(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    createdAt: row.created_at,
    workflowVersionId: row.workflow_version_id ?? null,
    version: row.version ?? null,
    publishedAt: row.published_at ?? null,
    publishedBy: row.published_by ?? null,
    publishedByName: row.published_by_name ?? null,
    ...(row.phases !== undefined
      ? { phases: row.phases }
      : { phaseCount: row.phase_count ?? 0, stageCount: row.stage_count ?? 0 }),
  };
}

function shapeVersion(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    publishedByName: row.published_by_name ?? null,
    ...(row.code !== undefined ? { code: row.code, name: row.name, isActive: row.is_active } : {}),
    ...(row.phases !== undefined
      ? { phases: row.phases }
      : { phaseCount: row.phase_count ?? 0, stageCount: row.stage_count ?? 0 }),
  };
}

/** A constraint violation into the refusal the caller earned; anything else untouched. */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    if (err.constraint === "uq_workflows_code") {
      return ApiError.conflict("A workflow with that code already exists.");
    }
    if (err.constraint === "uq_workflow_versions_version") {
      return ApiError.conflict("Another version was published meanwhile; reload and try again.");
    }
    return ApiError.conflict("That record already exists.");
  }
  if (err?.code === FOREIGN_KEY_VIOLATION) {
    return ApiError.badRequest("A referenced record does not exist.");
  }
  if (err?.code === CHECK_VIOLATION) {
    return ApiError.badRequest("That value is not allowed here.");
  }
  return err;
}

export default new Workflows();
