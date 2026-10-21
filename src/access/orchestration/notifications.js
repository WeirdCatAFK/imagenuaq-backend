import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";
import realtime from "../../realtime/socket.js";

const CATEGORIES = new Set(["calendario", "alerta", "recordatorio"]);

const MAX_TITLE = 300;
const MAX_TYPE = 50;
const MAX_SOURCE_TYPE = 100;
const MAX_DEDUP_KEY = 300;
const MAX_PAGE_SIZE = 100;


function requireId(value, field) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }

  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  return id;
}

function requireText(value, field, maxLength = null) {
  if (typeof value !== "string" || !value.trim()) {
    throw ApiError.badRequest(`${field} is required.`);
  }

  const text = value.trim();
  if (maxLength !== null && text.length > maxLength) {
    throw ApiError.badRequest(`${field} must have ${maxLength} characters or fewer.`);
  }
  return text;
}

function optionalText(value, field, maxLength) {
  if (value === null || value === undefined) return null;
  return requireText(value, field, maxLength);
}

function shapeNotification(row) {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    type: row.type,
    title: row.title,
    message: row.message,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    isRead: row.read_at !== null,
  };
}

class Notifications {
  async create({
    userId,
    category,
    type = "generico",
    title,
    message,
    sourceType = null,
    sourceId = null,
    dedupKey = null,
  }) {
    if (!CATEGORIES.has(category)) {
      throw ApiError.badRequest("category must be calendario, alerta or recordatorio.");
    }

    const row = await query.createNotification({
      userId: requireId(userId, "userId"),
      category,
      type: requireText(type, "type", MAX_TYPE),
      title: requireText(title, "title", MAX_TITLE),
      message: requireText(message, "message"),
      sourceType: optionalText(sourceType, "sourceType", MAX_SOURCE_TYPE),
      sourceId: sourceId == null ? null : requireId(sourceId, "sourceId"),
      dedupKey: optionalText(dedupKey, "dedupKey", MAX_DEDUP_KEY),
    });
    if (!row) return null;

    const notification = shapeNotification(row);
    realtime.sendToUser(notification.userId, "notification:new", notification);
    return notification;
  }

  /**
   * Muestra las notificaciones de un usuario, de la más reciente a la más antigua.
   *
   * @throws {ApiError} 400 si `limit` está fuera de 1..100 u `offset` es negativo.
   */
  async list(userId, { limit = 50, offset = 0 } = {}) {
    const recipient = requireId(userId, "userId");
    const pageSize = Number(limit);
    const pageOffset = Number(offset);

    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw ApiError.badRequest(`limit must be between 1 and ${MAX_PAGE_SIZE}.`);
    }
    if (!Number.isSafeInteger(pageOffset) || pageOffset < 0) {
      throw ApiError.badRequest("offset must be a non-negative integer.");
    }

    const rows = await query.listNotifications(recipient, pageSize, pageOffset);
    return rows.map(shapeNotification);
  }

  /** Cuenta las notificaciones no leídas de un usuario. */
  async countUnread(userId) {
    return query.countUnreadNotifications(requireId(userId, "userId"));
  }

  /** Marca una notificación como leída; solo el destinatario puede hacerlo. null si es ajena o ya estaba leída. */
  async markAsRead(notificationId, userId) {
    const id = requireId(notificationId, "notificationId");
    const recipient = requireId(userId, "userId");

    const row = await query.markNotificationAsRead(id, recipient);
    return row ? { id: row.id, userId: row.user_id, readAt: row.read_at } : null;
  }

  /** Marca todas las notificaciones no leídas de un usuario como leídas. */
  async markAllAsRead(userId) {
    const updated = await query.markAllNotificationsAsRead(requireId(userId, "userId"));
    return { updated };
  }

  /** Elimina las notificaciones de más de seis meses. */
  async deleteExpired() {
    const deleted = await query.deleteExpiredNotifications();
    return { deleted };
  }

  /** Registra este módulo como suscriptor de eventos de dominio. Se llama una vez al iniciar la aplicación. */
  subscribe() {
    events.on("notifications", (event) => this.handle(event));
  }

  /** Avisa al asignado, a los líderes del área y a los administradores cuando se activa una etapa. */
  async handle(event) {
    if (event?.action !== "stage_activated" || event?.target?.table !== "project_stages") return;

    const stageId = event.after?.id ?? event.target?.id;
    if (!stageId) return;

    const recipients = await query.getStageNotificationRecipients(stageId);
    for (const recipient of recipients) {
      await this.create({
        userId: recipient.user_id,
        category: "alerta",
        type: "proyecto",
        title: "Nueva etapa activada",
        message:
          `Se activó la etapa "${recipient.stage_title}" ` +
          `del proyecto "${recipient.project_title}" ` +
          `(${recipient.project_key}).`,
        sourceType: "project_stages",
        sourceId: stageId,
        dedupKey: `stage_activated:${stageId}`,
      });
    }
  }
}

export default new Notifications();
