// Tier 3: areas, who is in them, and how they hang off each other.
//
// RF-USR-09 is the whole reason this module exists as data rather than a constant: new
// areas *and coordinations* are created without a deploy, "dado que la estructura
// organizacional crece". A coordination is not a different kind of record from an area --
// it is an area with areas under it -- so there is one table and one endpoint set, and the
// difference between the two is a row in `area_hierarchy`.
//
// The hierarchy is what makes RF-USR-04 answerable at all: an area lead or coordination
// consults the work of "todos los usuarios a su cargo", which is a subtree of areas, not
// one area. getOrgChart() below is the read side of that, and the shape the frontend's
// react-organizational-chart consumes.
//
// Three conventions hold throughout:
//
//   - **Membership arguments are (userId, areaId)**, matching query.js. Reversing them is
//     not an error at any layer -- it writes the wrong row and returns successfully.
//   - **Constraint violations are translated, not pre-flighted.** The constraint is the
//     authority; a SELECT-then-write loses to two callers racing on the same name.
//   - **Pure reads carry no try/catch.** translate() maps only 23505 and 23503, and a
//     SELECT raises neither.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

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

/** `areas.name` is varchar(200); checking here makes a 22001 into a 400 that names the field. */
const NAME_MAX = 200;

class Areas {
  // --- CRUD ---

  /**
   * Creates an area, optionally with its first leader in the same statement -- two calls
   * would leave an area nobody is responsible for whenever the second failed.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string|null} [input.description]
   * @param {number|string|null} [input.leaderUserId]
   * @returns {Promise<object>}
   * @throws {ApiError} 400 on a bad payload, 409 on a duplicate name.
   */
  async create({ name, description = null, leaderUserId = null }) {
    const cleanName = cleanText(name);
    if (!cleanName || cleanName.length > NAME_MAX) {
      throw ApiError.badRequest(
        `Area name is required (${NAME_MAX} characters or fewer).`,
      );
    }

    const leader = optionalId(leaderUserId, "leaderUserId");

    try {
      const area =
        leader === null
          ? await query.createArea({
              name: cleanName,
              description: cleanText(description),
            })
          : await query.createAreaWithLeader({
              name: cleanName,
              description: cleanText(description),
              userId: leader,
            });

      await events.emit({
        action: "record_created",
        target: { table: "areas", id: area.id },
        after: area,
      });

      return shapeArea(area);
    } catch (err) {
      throw translate(err);
    }
  }

  async get() {
    const areas = await query.getAreas();
    return areas.map(shapeArea);
  }

  /**
   * Updates only the keys the caller sent. The current row is read first and merged here;
   * building the SET list from whichever keys arrived would put string concatenation back
   * into query.js.
   *
   * @param {number|string} areaId
   * @param {{ name?: string, description?: string|null }} changes
   * @returns {Promise<object>}
   * @throws {ApiError} 400 on a bad payload, 404 when the area does not exist.
   */
  async update(areaId, { name, description }) {
    const id = requireId(areaId, "areaId");
    const current = await query.getAreaById(id);
    if (!current) throw ApiError.notFound("Area not found.");

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

      // `current` was read to merge the update, so before_data costs nothing here -- the
      // reason this is emitted from this tier and not the route, where it is already gone.
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

  /**
   * Deletes an area. Children are promoted to roots by ON DELETE CASCADE on
   * area_hierarchy; people are not, and the NO ACTION foreign key is deliberately the
   * gate -- counting members first would still race a concurrent assignment.
   *
   * 23503 is caught here rather than in translate() because the code alone cannot say
   * which direction was violated: Postgres names the referencing table either way, so
   * only the call site knows whether it asked for a membership or a deletion.
   *
   * @param {number|string} areaId
   * @throws {ApiError} 404 when it does not exist, 409 when people are still assigned.
   */
  async delete(areaId) {
    const id = requireId(areaId, "areaId");

    try {
      const area = await query.deleteArea(id);
      if (!area) throw ApiError.notFound("Area not found.");

      // The deleted row IS before_data; a null after_data is what says it is gone.
      await events.emit({
        action: "record_deleted",
        target: { table: "areas", id: area.id },
        before: area,
      });

      return shapeArea(area);
    } catch (err) {
      if (err?.code === FOREIGN_KEY_VIOLATION) {
        throw ApiError.conflict(
          "That area still has users or records assigned to it; reassign them first.",
        );
      }
      throw translate(err);
    }
  }

  // --- Lookups ---

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
    // Checked separately: an empty area and a missing one both return zero rows.
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

  // --- Membership ---

  async setMembership(userId, areaId, isAreaLeader = false) {
    const user = requireId(userId, "userId");
    const area = requireId(areaId, "areaId");

    try {
      const row = await query.setAreaMembership(
        user,
        area,
        Boolean(isAreaLeader),
      );

      // record_created for what is really an upsert: the trail records the resulting state,
      // and the area's history read in order already shows whether it was a join or a
      // promotion.
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

  async removeMembership(userId, areaId) {
    const row = await query.removeAreaMembership(
      requireId(userId, "userId"),
      requireId(areaId, "areaId"),
    );
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

  // --- Hierarchy (RF-USR-09) ---

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
   * @throws {ApiError} 404 when either area is missing, 400 for self-parenting, 409 when
   *   the proposed parent already sits below this area.
   */
  async setParent(childAreaId, parentAreaId) {
    const child = requireId(childAreaId, "areaId");
    const parent = requireId(parentAreaId, "parentAreaId");

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

    // Read before the upsert overwrites it: a move recorded without where the area came
    // from cannot be read backwards.
    const previousParent = await query.getAreaParent(child);

    try {
      const row = await query.setAreaParent(child, parent);

      // Targeted at the area that moved, not at area_hierarchy: somebody reading an area's
      // history wants the move in the same list as its rename.
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
   */
  async clearParent(areaId) {
    const id = requireId(areaId, "areaId");
    if (!(await query.getAreaById(id))) {
      throw ApiError.notFound("Area not found.");
    }

    const row = await query.clearAreaParent(id);

    // Only when something actually changed: a trail that records requests rather than
    // changes buries the rows that matter.
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

  // --- The organisation chart ---

  /**
   * The whole organisation as a forest, or one subtree when `rootAreaId` is given.
   *
   * Two queries, never one per node: the tree rows, then every member of every area in
   * it. The nesting is assembled here because shaping is this tier's job and query.js
   * stays SQL-only. The result is the shape react-organizational-chart nests -- every
   * node carries its children, and `leaders` is a projection of `members` rather than a
   * separate set, so the frontend does not filter twice per node.
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
    // An empty forest is legitimate; the empty-array parameter is handled by #idArray().
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

    // Attached in walk order, which is by depth, so a node's parent is always already in
    // the map. A parent that is NOT in the map means the walk started below it -- the
    // subtree case -- so the node is a root of this chart despite having one in the table.
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

/**
 * Trims, and turns an empty string into null -- a cleared description must not be stored
 * as "", or "" and NULL would both mean "none" and every reader would test for both.
 *
 * @returns {string | null}
 */
function cleanText(value) {
  if (typeof value !== "string") return value == null ? null : value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Coerces a JSON or route-parameter id to a positive integer, or null. Rejects "7abc"
 * and booleans, which Number() would turn into NaN and 1.
 *
 * @returns {number | null}
 */
function toId(value) {
  if (typeof value === "boolean" || value === null || value === undefined)
    return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function requireId(value, field) {
  const id = toId(value);
  if (id === null) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  return id;
}

/**
 * Passes null and undefined through; anything else must parse. "No leader given" and
 * "leader given as garbage" are a 201 and a 400.
 *
 * @throws {ApiError} 400 when `value` is present and not a positive integer.
 */
function optionalId(value, field) {
  if (value === null || value === undefined) return null;
  return requireId(value, field);
}

/**
 * snake_case row in, camelCase JSON out. The boundary is here because column names are
 * the schema's business and field names are the API's.
 */
function shapeArea(row) {
  return { id: row.id, name: row.name, description: row.description };
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
 * Turns a constraint violation into the refusal the caller earned. An unrecognised error
 * is returned untouched, for errorHandler to log in full behind a 500.
 *
 * @returns {ApiError | Error}
 */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    // uq_areas_name, or the area_hierarchy primary key -- unreachable through
    // setParent(), which upserts, but a future writer to that table can hit it.
    return ApiError.conflict("An area with that name already exists.");
  }

  if (err?.code === FOREIGN_KEY_VIOLATION) {
    // Always the "you named something that is not there" direction; the other reaches
    // 23503 under the same constraint name and is handled in delete().
    const field = FK_FIELDS[err.constraint];
    return ApiError.badRequest(
      field ? `Unknown ${field}.` : "A referenced record does not exist.",
    );
  }

  return err;
}

export default new Areas();
