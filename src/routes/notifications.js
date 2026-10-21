import { Router } from "express";

import { authenticate } from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";
import notifications from "../access/orchestration/notifications.js";

const router = Router();

router.use(authenticate);

router.get("/", async (req, res) => {
  const list = await notifications.list(req.user.id, {
    limit: req.query.limit ?? 50,
    offset: req.query.offset ?? 0,
  });
  res.json({ notifications: list });
});

router.get("/unread-count", async (req, res) => {
  res.json({ unreadCount: await notifications.countUnread(req.user.id) });
});

router.patch("/read-all", async (req, res) => {
  res.json(await notifications.markAllAsRead(req.user.id));
});

router.patch("/:id/read", async (req, res) => {
  const result = await notifications.markAsRead(req.params.id, req.user.id);
  if (!result) throw ApiError.notFound("Notification not found or already read.");
  res.json({ notification: result });
});

export default router;
