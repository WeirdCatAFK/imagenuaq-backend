import { Router } from "express";

import areas from "../access/orchestration/areas.js";
import { authenticate, requireRole } from "../middlewares/auth.js";
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

// --- Everything below is coordination's ---
//
// 'admin' is roles.name for coordinación/secretaría particular, the third level of
// RF-USR-02, and the same gate routes/users.js uses. Area leads direct the work of their
// area (RF-USR-04) but creating areas and moving them under one another is the
// organisation's shape, not theirs.
//
// Not requirePermission('area.manage'), even though RF-USR-09 put that code in the
// catalogue and section 8 of catalog-bootstrap does grant it to `admin`. Two reasons, and
// the second is the one that decides it:
//
//   - It matches routes/users.js, so the two administrative routers are gated the same way
//     and there is one answer to "who may administer this system", not two.
//   - `worker` and `area_lead` are seeded with NO grants, deliberately: which of them may
//     manage areas is coordination's policy decision, not a developer's. Gating on
//     area.manage today would therefore behave identically to this line while reading as
//     though a policy had been chosen.
//
// When coordination does grant area.manage to somebody other than admin -- PUT
// /api/roles/:id/permissions is how -- swapping this line for requirePermission is the
// whole change, and it is at that point that it starts to mean something different.
router.use(requireRole("admin"));

// POST /api/areas -- create an area, optionally with its first leader.
//
// `leaderUserId` is handled in one statement rather than by a follow-up call, so a failure
// cannot leave an area nobody is responsible for. See createAreaWithLeader() in query.js.
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
