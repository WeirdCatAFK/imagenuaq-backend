// Areas, who belongs to them and how they nest (RF-USR-09, RF-USR-04). A new area with no
// parent goes under DEFAULT_AREA from .env; an explicit null parent makes it a top-level area.
// Membership arguments are always (userId, areaId): swapped, they write the wrong row silently.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  UNIQUE_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  cleanText,
  requireId,
  optionalId,
} from "../../utils/validate.js";

/**
 * Constraint name to the request field the caller got wrong. Names come from the
 * migrations -- `uq_areas_name` from catalog-bootstrap, the area_hierarchy pair from
 * roles-and-areas. An unlisted one falls through to the generic message.
 */
const FK_FIELDS = {
  area_hierarchy_child_area_id_fkey: "areaId",
  area_hierarchy_parent_area_id_fkey: "parentAreaId",
  fk_area_members_area_id_areas_id: "areaId",
  fk_area_members_user_id_users_id: "userId",
};

/**
 *  `areas.name` is varchar(200); checking here makes a 22001 into a 400 that names the field.
 */
const NAME_MAX = 200;

/** What keeps an area from being retired: the key of `query.areaUsage()` and how a refusal names it. */
const USES = [
  ["people", "people"],
  ["sub_areas", "sub-areas"],
  ["stages", "open stages"],
  ["requests", "requests without a project"],
  ["templates", "flow templates"],
];

class Areas {
  /**
   * Creates an area, with its first leader and its parent in the same statement -- a
   * second call for either would leave an area nobody is responsible for, or a root
   * nobody meant to create, whenever it failed.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string|null} [input.description]
   * @param {number|string|null} [input.leaderUserId]
   * @param {number|string|null} [input.parentAreaId] Omitted: the DEFAULT_AREA area.
   *   Null: a root. No cycle check -- a new area has no descendants to close one with.
   * @returns {Promise<object>} The area, plus `parentAreaId` as written.
   * @throws {ApiError} 400 on a bad payload or an unknown parent, 403 unless the caller leads the
   *   parent, 409 on a duplicate name.
   */
  async create({ name, description = null, leaderUserId = null, parentAreaId }) {
    const cleanName = cleanText(name);
    if (!cleanName || cleanName.length > NAME_MAX) {
      throw ApiError.badRequest(
        `Area name is required (${NAME_MAX} characters or fewer).`,
      );
    }

    const leader = optionalId(leaderUserId, "leaderUserId");
    const parent =
      parentAreaId === undefined
        ? ((await this.defaultArea())?.id ?? null)
        : optionalId(parentAreaId, "parentAreaId");
    await requireLeads(parent);

    try {
      const area = await query.createArea({
        name: cleanName,
        description: cleanText(description),
        userId: leader,
        parentAreaId: parent,
      });

      await events.emit({
        action: "record_created",
        target: { table: "areas", id: area.id },
        after: area,
      });

      return { ...shapeArea(area), parentAreaId: area.parent_area_id ?? null };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * The area DEFAULT_AREA names, or null when it is unset, empty, or matches nothing.
   * Read per call rather than at boot: the catalogue is edited at runtime (RF-USR-09), so a
   * rename after start-up must be seen. Also used by scripts/createAdmin.js.
   *
   * @returns {Promise<{ id: number, name: string } | null>}
   */
  async defaultArea() {
    const ref = cleanText(process.env.DEFAULT_AREA);
    return ref === null ? null : query.findArea(ref);
  }

  /** The areas in use; with `includeRetired`, the retired ones too. */
  async get({ includeRetired = false } = {}) {
    const areas = await query.getAreas({ includeRetired });
    return areas.map(shapeArea);
  }

  /**
   * Updates only the keys the caller sent. The current row is read first and merged here;
   * building the SET list from whichever keys arrived would put string concatenation back
   * into query.js.
   *
   * @param {number|string} areaId
   * @param {{ name?: string, description?: string|null, isActive?: boolean }} changes `isActive: true`
   *   brings a retired area back, which is coordination's; retiring one is `delete()`.
   * @returns {Promise<object>}
   * @throws {ApiError} 400 on a bad payload, 403 unless the caller leads it, 404 when the area does
   *   not exist.
   */
  async update(areaId, { name, description, isActive }) {
    const id = requireId(areaId, "areaId");
    const current = await query.getAreaById(id);
    if (!current) throw ApiError.notFound("Area not found.");
    await requireLeads(id);
    if (isActive === true && !current.is_active) return this.#setActive(current, true);

    const nextName = name === undefined ? current.name : cleanText(name);
    if (!nextName || nextName.length > NAME_MAX) {
      throw ApiError.badRequest(
        `Area name is required (${NAME_MAX} characters or fewer).`,
      );
    }

    const nextDescription =
      description === undefined ? current.description : cleanText(description);

    try {
      const area = await query.updateArea(id, {
        name: nextName,
        description: nextDescription,
      });
      if (!area) throw ApiError.notFound("Area not found.");

      await events.emit({
        action: "record_updated",
        target: { table: "areas", id: area.id },
        before: current,
        after: area,
      });

      return shapeArea(area);
    } catch (err) {
      throw translate(err);
    }
  }

  async #setActive(current, isActive) {
    requireCoordination();
    const area = await query.setAreaActive(current.id, isActive);
    await events.emit({
      action: "record_updated",
      target: { table: "areas", id: area.id },
      before: current,
      after: area,
    });
    return shapeArea(area);
  }

  /**
   * Deletes an area nobody uses. One that stages, requests or the audit trail still name is
   * retired instead (RF-USR-09): it leaves the pickers and the org chart, and its history stays.
   *
   * @param {number|string} areaId
   * @returns {Promise<object>} The area; `isActive: false` when it was retired.
   * @throws {ApiError} 403 to anyone but coordination, 404 when it does not exist, 409 naming what
   *   still uses it.
   */
  async delete(areaId) {
    const id = requireId(areaId, "areaId");
    requireCoordination();

    const current = await query.getAreaById(id);
    if (!current) throw ApiError.notFound("Area not found.");
    const usage = await query.areaUsage(id);
    const uses = USES.filter(([key]) => usage[key] > 0).map(([key, name]) => `${usage[key]} ${name}`);
    if (uses.length > 0) throw ApiError.conflict(`That area is still in use: ${uses.join(", ")}.`);

    try {
      const area = await query.deleteArea(id);
      if (!area) throw ApiError.notFound("Area not found.");

      await events.emit({
        action: "record_deleted",
        target: { table: "areas", id: area.id },
        before: area,
      });

      return shapeArea(area);
    } catch (err) {
      if (err?.code === FOREIGN_KEY_VIOLATION) return this.#setActive(current, false);
      throw translate(err);
    }
  }

  async getById(areaId) {
    const area = await query.getAreaById(requireId(areaId, "areaId"));
    if (!area) throw ApiError.notFound("Area not found.");
    return shapeArea(area);
  }

  async getByName(name) {
    const area = await query.getAreaByName(cleanText(name));
    if (!area) throw ApiError.notFound("Area not found.");
    return shapeArea(area);
  }

  async getMembers(areaId) {
    const id = requireId(areaId, "areaId");
    const area = await query.getAreaById(id);
    if (!area) throw ApiError.notFound("Area not found.");

    return (await query.getAreaMembers(id)).map(shapeMember);
  }

  async getUserAreas(userId) {
    const areas = await query.getUserAreas(requireId(userId, "userId"));
    return areas.map((area) => ({
      ...shapeArea(area),
      isAreaLeader: area.is_area_leader,
    }));
  }

  async isUserAreaLeader(userId, areaId) {
    return query.isUserAreaLeader(
      requireId(userId, "userId"),
      requireId(areaId, "areaId"),
    );
  }

  async isUserMemberOfArea(userId, areaId) {
    return query.isUserMemberOfArea(
      requireId(userId, "userId"),
      requireId(areaId, "areaId"),
    );
  }

  /**
   * Adds someone to an area, or changes whether they lead it.
   *
   * @throws {ApiError} 400 on an unknown user or area, 403 unless the caller leads the area, or
   *   leads one above it when this changes who leads.
   */
  async setMembership(userId, areaId, isAreaLeader = false) {
    const user = requireId(userId, "userId");
    const area = requireId(areaId, "areaId");
    await requireLeads(area);
    if ((await query.isUserAreaLeader(user, area)) !== Boolean(isAreaLeader)) {
      await requireLeadsAbove(area);
    }

    try {
      const row = await query.setAreaMembership(
        user,
        area,
        Boolean(isAreaLeader),
      );

      await events.emit({
        action: "record_created",
        target: { table: "area_members", id: area },
        after: row,
      });

      return {
        userId: row.user_id,
        areaId: row.area_id,
        isAreaLeader: row.is_area_leader,
      };
    } catch (err) {
      throw translate(err);
    }
  }

  /** @throws {ApiError} 403 as in `setMembership()`, 404 when the user is not a member. */
  async removeMembership(userId, areaId) {
    const user = requireId(userId, "userId");
    const area = requireId(areaId, "areaId");
    await requireLeads(area);
    if (await query.isUserAreaLeader(user, area)) await requireLeadsAbove(area);

    const row = await query.removeAreaMembership(user, area);
    if (!row) throw ApiError.notFound("That user is not a member of this area.");

    await events.emit({
      action: "record_deleted",
      target: { table: "area_members", id: row.area_id },
      before: row,
    });

    return {
      userId: row.user_id,
      areaId: row.area_id,
      isAreaLeader: row.is_area_leader,
    };
  }

  async getParent(areaId) {
    const id = requireId(areaId, "areaId");
    const area = await query.getAreaById(id);
    if (!area) throw ApiError.notFound("Area not found.");

    const parent = await query.getAreaParent(id);
    return parent ? shapeArea(parent) : null;
  }

  /**
   * Hangs one area under another. The 409 is the refusal the database cannot see:
   * `area_hierarchy` constrains a single hop, so A under B under A needs a trigger or a
   * materialised closure, and both charge every write for what only a hand-written UPDATE
   * can produce. Any second write path to that table owes the same check -- the reader's
   * CYCLE clause survives a loop, it does not repair one.
   *
   * @param {number|string} childAreaId
   * @param {number|string} parentAreaId
   * @returns {Promise<object>}
   * @throws {ApiError} 403 to anyone but coordination, 404 when either area is missing, 400 for
   *   self-parenting, 409 when the proposed parent already sits below this area.
   */
  async setParent(childAreaId, parentAreaId) {
    const child = requireId(childAreaId, "areaId");
    const parent = requireId(parentAreaId, "parentAreaId");
    requireCoordination();

    if (child === parent) {
      throw ApiError.badRequest("An area cannot be its own parent.");
    }

    if (!(await query.getAreaById(child))) {
      throw ApiError.notFound("Area not found.");
    }
    if (!(await query.getAreaById(parent))) {
      throw ApiError.notFound("Parent area not found.");
    }

    if (await query.isAreaDescendantOf(parent, child)) {
      throw ApiError.conflict(
        "That area is already below this one; the move would close a cycle.",
      );
    }

    const previousParent = await query.getAreaParent(child);

    try {
      const row = await query.setAreaParent(child, parent);

      await events.emit({
        action: "record_updated",
        target: { table: "areas", id: child },
        before: { parent_area_id: previousParent?.id ?? null },
        after: { parent_area_id: row.parent_area_id },
      });

      return { areaId: row.child_area_id, parentAreaId: row.parent_area_id };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Promotes an area back to a root. Not an error when it already was one.
   *
   * @param {number|string} areaId
   * @returns {Promise<{ areaId: number, parentAreaId: null, changed: boolean }>}
   *   `changed` distinguishes "it had a parent" from "it never did", which the caller
   *   cannot see from parentAreaId being null either way.
   * @throws {ApiError} 403 to anyone but coordination, 404.
   */
  async clearParent(areaId) {
    const id = requireId(areaId, "areaId");
    requireCoordination();
    if (!(await query.getAreaById(id))) {
      throw ApiError.notFound("Area not found.");
    }

    const row = await query.clearAreaParent(id);

    if (row) {
      await events.emit({
        action: "record_updated",
        target: { table: "areas", id },
        before: { parent_area_id: row.parent_area_id },
        after: { parent_area_id: null },
      });
    }

    return { areaId: id, parentAreaId: null, changed: row !== null };
  }

  /**
   * The whole organisation as a forest, or one subtree when `rootAreaId` is given.
   *
   * @param {number|string|null} [rootAreaId]
   * @returns {Promise<object[]>} The roots of this chart.
   * @throws {ApiError} 404 when `rootAreaId` names no area.
   */
  async getOrgChart(rootAreaId = null) {
    const root = rootAreaId === null ? null : requireId(rootAreaId, "areaId");

    if (root !== null && !(await query.getAreaById(root))) {
      throw ApiError.notFound("Area not found.");
    }

    const rows = await query.getAreaTreeRows(root);
    const members = await query.getAreaMembersForAreas(rows.map((row) => row.id));

    const membersByArea = new Map();
    for (const member of members) {
      const bucket = membersByArea.get(member.area_id);
      if (bucket) bucket.push(shapeMember(member));
      else membersByArea.set(member.area_id, [shapeMember(member)]);
    }

    const nodes = new Map();
    for (const row of rows) {
      const areaMembers = membersByArea.get(row.id) ?? [];
      nodes.set(row.id, {
        id: row.id,
        name: row.name,
        description: row.description,
        parentAreaId: row.parent_area_id,
        depth: row.depth,
        leaders: areaMembers.filter((member) => member.isAreaLeader),
        members: areaMembers,
        memberCount: areaMembers.length,
        children: [],
      });
    }

    const roots = [];
    for (const row of rows) {
      const node = nodes.get(row.id);
      const parent =
        row.parent_area_id === null ? null : nodes.get(row.parent_area_id);

      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    return { roots };
  }
}

const isCoordination = () => currentActor()?.role === "admin";

/** Deleting an area or moving it in the org chart is coordination's. @throws {ApiError} 403 */
function requireCoordination() {
  if (!isCoordination()) throw ApiError.forbidden("Only coordination deletes or moves an area.");
}

/**
 * `area.manage` reaches the areas the caller leads and those below them (RF-USR-06).
 *
 * @throws {ApiError} 403
 */
async function requireLeads(areaId) {
  if (isCoordination()) return;
  const actor = currentActor();
  if (!actor || areaId === null || !(await query.leadsArea(actor.id, areaId))) {
    throw ApiError.forbidden("Only a leader of that area, or of one above it, manages it.");
  }
}

/** Who leads an area is decided from above it, never by its own leader. @throws {ApiError} 403 */
async function requireLeadsAbove(areaId) {
  if (isCoordination()) return;
  const parent = await query.getAreaParent(areaId);
  const actor = currentActor();
  if (!actor || !parent || !(await query.leadsArea(actor.id, parent.id))) {
    throw ApiError.forbidden("Only coordination, or a leader of an area above, changes who leads it.");
  }
}

/**
 * snake_case row in, camelCase JSON out. The boundary is here because column names are
 * the schema's business and field names are the API's.
 */
function shapeArea(row) {
  return { id: row.id, name: row.name, description: row.description, isActive: row.is_active ?? true };
}

function shapeMember(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role_name,
    isAreaLeader: row.is_area_leader,
  };
}

/**
 * Turns a constraint violation into the matching 4xx error. An unrecognised error
 * is returned untouched, for errorHandler to log in full behind a 500. Writes rely on the
 * constraint rather than checking first, since a check-then-write loses when two callers race.
 *
 * @returns {ApiError | Error}
 */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    return ApiError.conflict("An area with that name already exists.");
  }

  if (err?.code === FOREIGN_KEY_VIOLATION) {
    const field = FK_FIELDS[err.constraint];
    return ApiError.badRequest(
      field ? `Unknown ${field}.` : "A referenced record does not exist.",
    );
  }

  return err;
}

export default new Areas();
