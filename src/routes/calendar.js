// The calendar and its semester closure windows (RF-CAL-02, RF-CAL-03, RF-CAL-05). Reading, and
// writing one's own notes, needs `calendar.read`; global events and closure windows are written under
// `calendar.write`.
import { Router } from "express";

import calendar from "../access/orchestration/calendar.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();

router.use(authenticate);
router.use(requirePermission("calendar.read"));

router.get("/", async (req, res) => {
  const { from, to, scope, areaId, userId } = req.query;
  res.json(await calendar.list({ from, to, scope, areaId, userId }));
});

router.get("/closures", async (req, res) => {
  res.json({ items: await calendar.listClosures() });
});

router.post("/notes", async (req, res) => {
  res.status(201).json(await calendar.createNote(req.body));
});

router.patch("/notes/:noteId", async (req, res) => {
  res.json(await calendar.updateNote(idParam(req, "noteId", "note id"), req.body));
});

router.delete("/notes/:noteId", async (req, res) => {
  await calendar.deleteNote(idParam(req, "noteId", "note id"));
  res.status(204).end();
});

router.use(requirePermission("calendar.write"));

router.post("/events", async (req, res) => {
  res.status(201).json(await calendar.createEvent(req.body));
});

router.patch("/events/:eventId", async (req, res) => {
  res.json(await calendar.updateEvent(idParam(req, "eventId", "event id"), req.body));
});

router.delete("/events/:eventId", async (req, res) => {
  await calendar.deleteEvent(idParam(req, "eventId", "event id"));
  res.status(204).end();
});

router.post("/closures", async (req, res) => {
  res.status(201).json(await calendar.createClosure(req.body));
});

router.patch("/closures/:closureId", async (req, res) => {
  res.json(await calendar.updateClosure(idParam(req, "closureId", "closure id"), req.body));
});

router.delete("/closures/:closureId", async (req, res) => {
  await calendar.deleteClosure(idParam(req, "closureId", "closure id"));
  res.status(204).end();
});

export default router;
