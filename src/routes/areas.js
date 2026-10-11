// Areas and the organisation chart. Reads need a session (RF-USR-03); writes need
// `area.manage`. Static paths such as `/orgchart` are declared before `/:id`, which would
// otherwise capture them.
import { Router } from "express";

import areas from "../access/orchestration/areas.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const areaId = (req) => idParam(req, "id", "area id");

router.use(authenticate);

router.get("/orgchart", async (_req, res) => {
  res.json(await areas.getOrgChart());
});

router.get("/", async (_req, res) => {
  res.json({ areas: await areas.get() });
});

router.get("/:id", async (req, res) => {
  res.json({ area: await areas.getById(areaId(req)) });
});

router.get("/:id/orgchart", async (req, res) => {
  res.json(await areas.getOrgChart(areaId(req)));
});

router.get("/:id/members", async (req, res) => {
  res.json({ members: await areas.getMembers(areaId(req)) });
});

router.use(requirePermission("area.manage"));

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

router.put("/:id/parent", async (req, res) => {
  const { parentAreaId } = req.body ?? {};
  res.json(await areas.setParent(areaId(req), parentAreaId));
});

router.delete("/:id/parent", async (req, res) => {
  res.json(await areas.clearParent(areaId(req)));
});

router.put("/:id/members/:userId", async (req, res) => {
  const { isAreaLeader = false } = req.body ?? {};
  res.json(
    await areas.setMembership(idParam(req, "userId", "user id"), areaId(req), isAreaLeader),
  );
});

router.delete("/:id/members/:userId", async (req, res) => {
  res.json(
    await areas.removeMembership(idParam(req, "userId", "user id"), areaId(req)),
  );
});

export default router;
