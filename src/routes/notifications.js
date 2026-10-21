import { Router } from "express";

import notification from "../access/orchestration/notifications.js";
import {authenticate} from "../middlewares/auth.js";
import { ApiError } from "../utils/ApiError.js";
import notifications from "../access/orchestration/notifications.js";

const router = Router();

//Las rutas (TODAS) requieres una sesión válida sin excepción
//El usr se obtiene del token, nunca del body

router.use(authenticate);

/**GET api/notifications
 * Obtiene las notificaciones del usr autenticado.
 * Admite paginación mediante limit y offset 
*/

router.get("/", async (req, res) => {
    const userId = req.user.id;
    const notificationsList = await notifications.list(userId,{
        limit: req.query.limit ?? 50,
        offset: req.query.offset ?? 0,
    });

    res.json({
        notifications: notificationsList,
    });
});

/**
 * GET /api/notifications/unread-count
 *
 * Obtiene la cantidad de notificaciones sin leer.
 */
router.get("/unread-count", async (req, res) => {
  const userId = req.user.id;

  const unreadCount = await notifications.countUnread(userId);

  res.json({
    unreadCount,
  });
});

/**
 * PATCH /api/notifications/read-all
 *
 * Marca como leídas todas las notificaciones
 * del usuario autenticado.
 */
router.patch("/read-all", async (req, res) => {
  const userId = req.user.id;

  const result = await notifications.markAllAsRead(userId);

  res.json(result);
});

/**
 * PATCH /api/notifications/:id/read
 *
 * Marca como leída una notificación específica.
 */
router.patch("/:id/read", async (req, res) => {
  const userId = req.user.id;
  const notificationId = req.params.id;

  const result = await notifications.markAsRead(
    notificationId,
    userId
  );

  if (!result) {
    throw ApiError.notFound(
      "Notification not found or already read."
    );
  }

  res.json({
    notification: result,
  });
});

export default router;