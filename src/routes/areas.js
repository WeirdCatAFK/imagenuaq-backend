import { Router } from "express";

import areas from "../access/orchestration/areas.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";

const router = Router();

// Guards are mounted on the router, in two blocks, and the order of this file is what
// enforces them. routes/users.js makes the argument for router-wide guards -- a route added
// later cannot be left unguarded by omission, and the failure mode of per-route guards is
// silence. That argument survives two levels here: everything below the first `router.use`
// needs a session, everything below the second is coordination's. A route appended to the
// bottom of the file is admin-only by default, which is the safe direction to be wrong in.

router.use(authenticate);

// --- Reads: any authenticated user ---
//
// RF-USR-03 gives every member of an area unrestricted sight of their colleagues' work, and
// the organisation chart is the most basic form of that: who is in which area and who leads
// it. Nothing here exposes anything a staff member could not learn by asking.

// GET /api/areas/orgchart -- the whole organisation as a forest of nested areas.
//
// Declared BEFORE '/:id'. Express matches in declaration order, so with these two the other
// way round `/orgchart` is captured by `:id`, fails Number.isInteger, and returns "Invalid
// area id." for a URL that is not an id at all.
router.get("/orgchart", async (_req, res) => {
  res.json(await areas.getOrgChart());
});

router.get("/", async (_req, res) => {
  res.json({ areas: await areas.get() });
});

router.get("/:id", async (req, res) => {
  res.json({ area: await areas.getById(areaId(req)) });
});

// GET /api/areas/:id/orgchart -- the same shape rooted at one area.
//
// This is the read RF-USR-04 is written in: an area lead or coordination consults the work
// of "todos los usuarios a su cargo", and who that is is exactly this subtree. The node
// comes back as the single entry in `roots`, so the frontend renders it with the same
// component either way.
router.get("/:id/orgchart", async (req, res) => {
  res.json(await areas.getOrgChart(areaId(req)));
});

router.get("/:id/members", async (req, res) => {
  res.json({ members: await areas.getMembers(areaId(req)) });
});

// --- Writes: whoever holds area.manage ---
//
// The first router on the permission model, and the shape every later one copies:
// permissions mirror the router's BLOCKS, not its endpoints. One `resource.read` code
// gates the read block, one write code gates everything below, each mounted once with
// router.use(). A route appended at the bottom is write-gated by omission. A third code
// appears only where an RF forces a slice of the router to answer differently (the
// absence motive under RF-AUS-13 is the standing example), cited where it is declared and
// applied on those routes alone. Which records somebody may touch is never a permission
// -- that is area_members and area_hierarchy, applied in orchestration.
//
// `area.manage` is what section 8 of catalog-bootstrap grants `admin`, so admin behaviour
// is unchanged by this line. What changed is that it is no longer the only answer: a role
// granted the code through PUT /api/roles/:id/permissions passes here on its next request,
// without a deploy (RF-USR-05, RF-USR-09). Area leads direct the work of their area
// (RF-USR-04), but the organisation's shape is coordination's, and coordination decides who
// else may edit it by granting this.
//
// The read block above stays on the session alone, not `area.read`: RF-USR-03 gives every
// member of an area sight of their colleagues, and no role exists yet that should be
// refused it. That code arrives with the external requester (RF-EXT-03).
//
// routes/roles.js and the write half of routes/users.js deliberately do NOT follow this
// pattern -- see the comment there: the grants those endpoints write are what this line
// reads, and gating them on one of them lets an admin lock everyone out, self included.
router.use(requirePermission("area.manage"));

// POST /api/areas -- create an area, optionally with its first leader and its parent.
//
// `leaderUserId` and `parentAreaId` are written in the same statement as the area rather
// than by follow-up calls, so a failure cannot leave an area nobody is responsible for or a
// root nobody meant. Omitting `parentAreaId` hangs the area under DEFAULT_AREA (.env); an
// explicit null makes it a root. See createArea() in query.js.
router.post("/", async (req, res) => {
  const area = await areas.create(req.body ?? {});
  res.status(201).json({ area });
});

router.patch("/:id", async (req, res) => {
  const area = await areas.update(areaId(req), req.body ?? {});
  res.json({ area });
});

router.delete("/:id", async (req, res) => {
  const area = await areas.delete(areaId(req));
  res.json({ area });
});

// PUT /api/areas/:id/parent -- hang this area under another one.
//
// PUT and not POST: an area has at most one parent, so this is an idempotent replacement of
// a single value, not the addition of one more relation. The database agrees -- the child is
// the primary key of area_hierarchy.
router.put("/:id/parent", async (req, res) => {
  const { parentAreaId } = req.body ?? {};
  res.json(await areas.setParent(areaId(req), parentAreaId));
});

// DELETE /api/areas/:id/parent -- promote the area back to a root of the chart.
router.delete("/:id/parent", async (req, res) => {
  res.json(await areas.clearParent(areaId(req)));
});

// PUT /api/areas/:id/members/:userId -- add the user to the area, or change whether they
// lead it. One route for both because they are one upsert; splitting them would make the
// client know which it is doing, and it does not.
router.put("/:id/members/:userId", async (req, res) => {
  const { isAreaLeader = false } = req.body ?? {};
  res.json(
    await areas.setMembership(paramId(req, "userId"), areaId(req), isAreaLeader),
  );
});

router.delete("/:id/members/:userId", async (req, res) => {
  res.json(
    await areas.removeMembership(paramId(req, "userId"), areaId(req)),
  );
});

// Route parameters arrive as strings and reach a bigint column. Rejecting a non-id here
// rather than in orchestration keeps "/api/areas/abc" a 400 with a message about the URL,
// instead of a query that Postgres refuses with a type error and a 500.
function paramId(req, name) {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest(
      `Invalid ${name === "id" ? "area" : "user"} id.`,
    );
  }
  return id;
}

function areaId(req) {
  return paramId(req, "id");
}

export default router;
