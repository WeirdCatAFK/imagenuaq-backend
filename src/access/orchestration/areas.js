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
import query from "../resources/query.js";
import { ApiError } from "../../utils/ApiError.js";

// Postgres error codes, as in orchestration/users.js. The constraint is the authority:
// pre-flighting each value with its own SELECT loses to two callers creating the same area
// at once, where both pass the check and one comes back as a 500.
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

// Which constraint failed maps to which field the caller got wrong. Names come from the
// migrations -- `uq_areas_name` from catalog-bootstrap, the area_hierarchy pair from
// roles-and-areas, which took Postgres's default names for its inline REFERENCES. A
// renamed constraint must be renamed here too; until then it falls through to the generic
// message rather than naming the wrong field.
const FK_FIELDS = {
  area_hierarchy_child_area_id_fkey: "areaId",
  area_hierarchy_parent_area_id_fkey: "parentAreaId",
  fk_area_members_area_id_areas_id: "areaId",
  fk_area_members_user_id_users_id: "userId",
};

// `areas.name` is varchar(200); `roles.name` is 50 and lives in roles.js. Checking here
// rather than letting Postgres raise 22001 turns a 500 into a 400 that says which field.
const NAME_MAX = 200;

class Areas {
  // --- CRUD ---

  // `leaderUserId` is optional and, when given, makes that user the area's first leader in
  // the same statement. Two calls would leave an area nobody is responsible for whenever
  // the second one failed, and the cleanup for that lives in a catch block that is itself
  // allowed to fail.
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

      return shapeArea(area);
    } catch (err) {
      throw translate(err);
    }
  }

  async get() {
    const areas = await query.getAreas();
    return areas.map(shapeArea);
  }

  // A partial update: only the keys the caller sent are changed. The underlying statement
  // writes every column, so the current row is read first and the two are merged here --
  // building the SET list from whichever keys arrived would put string concatenation back
  // into query.js, which is the one thing that module exists to prevent.
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
      return shapeArea(area);
    } catch (err) {
      throw translate(err);
    }
  }

  // Children are promoted to roots by the ON DELETE CASCADE on area_hierarchy; people are
  // not, because `users.primary_area_id` and `area_members.area_id` are NO ACTION. That
  // foreign key is deliberately the gate: counting members here first would still race a
  // concurrent assignment, and the database's answer is the only one that cannot.
  //
  // 23503 is caught here rather than in translate() because the code alone cannot say which
  // direction was violated. Postgres reports the *referencing* table and constraint in both
  // cases, so `fk_area_members_area_id_areas_id` means "no such area" when inserting a
  // membership and "this area still has members" when deleting the area. Only the call site
  // knows which it asked for.
  async delete(areaId) {
    const id = requireId(areaId, "areaId");

    try {
      const area = await query.deleteArea(id);
      if (!area) throw ApiError.notFound("Area not found.");
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
  //
  // No try/catch on the pure reads. translate() only maps 23505 and 23503, and a SELECT
  // raises neither; wrapping them would mean re-throwing every real failure through a
  // function that has nothing to say about it.

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
    // Existence is checked separately: an area with nobody in it and an area that does not
    // exist both return zero rows, and they are a 200 and a 404.
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
  //
  // Note the argument order: (userId, areaId) throughout, matching query.js. An earlier
  // draft of this file passed (areaId, userId) to queries declared the other way round,
  // which is not an error at any layer -- it writes the wrong row and returns successfully.

  async setMembership(userId, areaId, isAreaLeader = false) {
    const user = requireId(userId, "userId");
    const area = requireId(areaId, "areaId");

    try {
      const row = await query.setAreaMembership(
        user,
        area,
        Boolean(isAreaLeader),
      );
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

  // Hang one area under another. Three refusals, in the order they can be checked:
  //
  //   404  either area does not exist
  //   400  an area cannot be its own parent -- the CHECK would catch it, but as a 500
  //   409  the proposed parent is already BELOW this area
  //
  // The third is the one the database cannot see. `area_hierarchy` constrains a single hop;
  // A under B under A needs a trigger or a materialised closure, and both charge every
  // write for something only a hand-written UPDATE can produce. This check is what keeps
  // the table acyclic, so any second write path to it owes the same check -- the reader's
  // CYCLE clause survives a loop, it does not repair one.
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

    try {
      const row = await query.setAreaParent(child, parent);
      return { areaId: row.child_area_id, parentAreaId: row.parent_area_id };
    } catch (err) {
      throw translate(err);
    }
  }

  // Promote an area back to a root. Not an error when it already was one: the caller asked
  // for it to have no parent and it has none, which is a 200 and not a 404.
  async clearParent(areaId) {
    const id = requireId(areaId, "areaId");
    if (!(await query.getAreaById(id))) {
      throw ApiError.notFound("Area not found.");
    }

    const row = await query.clearAreaParent(id);
    // `changed` distinguishes "it had a parent and no longer does" from "it never had
    // one", which the caller cannot see from parentAreaId being null either way.
    return { areaId: id, parentAreaId: null, changed: row !== null };
  }

  // --- The organisation chart ---

  // The whole organisation as a forest, or one subtree when `rootAreaId` is given.
  //
  // Two queries, never one per node: the tree rows, then every member of every area in it.
  // The nesting is assembled here rather than in SQL because shaping is this tier's job and
  // query.js stays SQL-only -- and because a json_agg version would still have to be
  // unpacked into the same objects on the way out.
  //
  // The result is the shape react-organizational-chart nests: every node carries its own
  // children, so <Tree>/<TreeNode> recurse over it directly. `leaders` is a projection of
  // `members`, not a separate set -- the chart labels a node with whoever heads it, and
  // duplicating those rows is cheaper than making the frontend filter twice per node.
  async getOrgChart(rootAreaId = null) {
    const root = rootAreaId === null ? null : requireId(rootAreaId, "areaId");

    if (root !== null && !(await query.getAreaById(root))) {
      throw ApiError.notFound("Area not found.");
    }

    const rows = await query.getAreaTreeRows(root);
    // An empty forest is legitimate -- a database with no areas in it yet. The empty-array
    // parameter is handled in query.js rather than guarded here; see #idArray().
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

    // Attach in the order the walk produced, which is by depth: a node's parent is always
    // already in the map by the time the node is reached. A parent that is NOT in the map
    // means the walk started below it -- the subtree case -- so the node is a root of this
    // chart even though it has a parent in the table.
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

// Trim, and turn an empty string into null. A description the user cleared arrives as ""
// and must not be stored as one: "" and NULL would then both mean "no description" and
// every reader would have to test for both.
function cleanText(value) {
  if (typeof value !== "string") return value == null ? null : value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Ids arrive from JSON and from route parameters, so "7" and 7 both turn up. Number()
// alone accepts "7abc" as NaN and true as 1; this is null for anything that is not a
// positive integer.
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

// null and undefined pass through; anything else must parse. The distinction matters:
// "no leader given" and "leader given as garbage" are a 201 and a 400.
function optionalId(value, field) {
  if (value === null || value === undefined) return null;
  return requireId(value, field);
}

// snake_case rows in, camelCase JSON out. The boundary is here rather than in query.js
// because the column names are the schema's business and the field names are the API's.
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

// Turn a constraint violation into the refusal the caller earned. Anything unrecognised is
// re-thrown untouched: errorHandler logs a non-ApiError in full and hides it behind a 500,
// which is the right treatment for a database error nobody predicted.
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    // uq_areas_name, or the area_hierarchy primary key. The second cannot be reached
    // through setAreaParent(), which upserts, but a future writer to this table can.
    return ApiError.conflict("An area with that name already exists.");
  }

  if (err?.code === FOREIGN_KEY_VIOLATION) {
    // Always the "you named something that is not there" direction. The other direction --
    // the row being deleted is still referenced -- reaches 23503 with the same constraint
    // name, and is handled at the one call site that can tell them apart, delete().
    const field = FK_FIELDS[err.constraint];
    return ApiError.badRequest(
      field ? `Unknown ${field}.` : "A referenced record does not exist.",
    );
  }

  return err;
}

export default new Areas();
