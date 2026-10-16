import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";
import realtime from '../../realtime/socket.js';

const CATEGORIES = new Set([
  "calendario",
  "alerta",
  "recordatorio",
]);

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
    throw ApiError.badRequest(
      `${field} must have ${maxLength} characters or fewer.`,
    );
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
  /**
   * Crea una notificacion para un usuario activo.
   *
   * Un dedupKey duplicado para el mismo usuario es ignorado.
   * Regresa null cuando el usuario es inactivo, no existe o la notificacion ya existe.
   */
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
        const id = requireId(userId, "userId");

        if (!CATEGORIES.has(category)) {
            throw ApiError.badRequest(
            "category must be calendario, alerta or recordatorio."
            );
        }

        const cleanType = requireText(type, "type", MAX_TYPE);
        const cleanTitle = requireText(title, "title", MAX_TITLE);
        const cleanMessage = requireText(message, "message");
        const cleanSourceType = optionalText(
            sourceType,
            "sourceType",
            MAX_SOURCE_TYPE
        );
        const cleanSourceId =
            sourceId == null ? null : requireId(sourceId, "sourceId");
        const cleanDedupKey = optionalText(
            dedupKey,
            "dedupKey",
            MAX_DEDUP_KEY
        );

        // 1. Guardamos la notificación en PostgreSQL.
        const row = await query.createNotification({
            userId: id,
            category,
            type: cleanType,
            title: cleanTitle,
            message: cleanMessage,
            sourceType: cleanSourceType,
            sourceId: cleanSourceId,
            dedupKey: cleanDedupKey,
        });

        // 2. Si ya existía, no enviamos otra notificación.
        if (!row) return null;

        // 3. Convertimos el registro al formato de la API.
        const notification = shapeNotification(row);

        // 4. Enviamos la notificación al usuario conectado.
        realtime.sendToUser(
            notification.userId,
            "notification:new",
            notification
        );

        // 5. Devolvemos la notificación creada.
        return notification;
    }

  /**
   * Muestra las notificaciones de un usuario, de la más reciente a la más antigua.
   */
  async list(userId, { limit = 50, offset = 0 } = {}) {
        const recipient = requireId(userId, "userId");
        const pageSize = Number(limit);
        const pageOffset = Number(offset);

        if (
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > MAX_PAGE_SIZE
        ) {
        throw ApiError.badRequest(
            `limit must be between 1 and ${MAX_PAGE_SIZE}.`,
        );
        }

        if (!Number.isSafeInteger(pageOffset) || pageOffset < 0) {
        throw ApiError.badRequest(
            "offset must be a non-negative integer.",
        );
        }

        const rows = await query.listNotifications(
        recipient,
        pageSize,
        pageOffset,
        );

        return rows.map(shapeNotification);
    }

  /**
   * Regresa las notificaciones no leídas para cada uno de los usuarios.
   */
  async countUnread(userId) {
        return query.countUnreadNotifications(
        requireId(userId, "userId"),
        );
    }

  /**
   * Marca una notificacion como leída.
   * Solo el destinatario puede actualizarlo.
   */
  async markAsRead(notificationId, userId){
        const id = requireId(notificationId, "notificationId");
        const recipient = requireId(userId, "userId");

        const row = await query.markNotificationAsRead(id, recipient);

        return row
        ? {
            id: row.id,
            userId: row.user_id,
            readAt: row.read_at,
            }
        : null;
    }

    /**
     * Marca todas las notificaciones no leídas de un usuario como leídas.
    */
    
    async markAllAsRead(userId) {
        const recipient = requireId(userId, "userId");
        const updated = await query.markAllNotificationsAsRead(recipient);

        return { updated };
    }

  /**
   * Elimina notificaciones de más de seis meses. 
   * Llamado más tarde por el trabajo de limpieza programado.
   */
  async deleteExpired() {
        const deleted = await query.deleteExpiredNotifications();
        return { deleted };
    }

  /* Registra este módulo como suscriptor de eventos de dominio. 
   * Se llama una vez durante el inicio de la aplicación.*/
  subscribe() {
        events.on("notifications", (event) => this.handle(event));
    }

  /**
   * Se añadirá el manejo de eventos de dominio cuando inspeccionemos los eventos emitidos por proyectos, solicitudes y etapas. 
   *Hasta entonces, no crea notificaciones a partir de eventos no reconocidos.
   */
  async handle(event) {
        // AHORA SOLO procesamos activaciones de etapas.
        if (event?.action !== "stage_activated") {
            return;
        }
        
        if (event?.target?.table !== "project_stages") {
            return;
        }
        
        const stageId = event.after?.id ?? event.target?.id;
        
        if (!stageId) {
            return;
        }
        
        // Consultamos los destinatarios y los datos reales del proyecto desde PostgreSQL.
        const recipients = await query.getStageNotificationRecipients(stageId);
        
        if (recipients.length === 0) {
            return;
        }
        
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
