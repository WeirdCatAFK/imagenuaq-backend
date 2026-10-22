import query from "../resources/query.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";
import { currentActor } from "../../utils/context.js";
import realtime from "../../realtime/socket.js";

const CATEGORIES = new Set(["calendario", "alerta", "recordatorio"]);

/**
 * Qué avisa cada evento de dominio, por nombre de acción. Cada entrada recibe el evento y regresa
 * la etapa, a quién avisar (`to`), el título, el texto antes y después de «la etapa … del
 * proyecto …», y la clave que evita repetir el aviso; o null para no avisar. Un evento que no
 * está aquí no avisa a nadie (RF-FLW-04, RF-FLW-03, RF-EST-06).
 */
const HANDLERS = {
  stage_activated: (event) => ({
    stageId: event.target.id,
    to: { assignee: true, leads: true, admins: true },
    title: "Nueva etapa activada",
    lead: "Se activó",
    trail: ".",
    dedupKey: `stage_activated:${event.target.id}`,
  }),
  stage_assigned: (event) =>
    event.after?.assigned_to == null
      ? null
      : {
          stageId: event.target.id,
          to: { assignee: true },
          exceptActor: true,
          title: "Etapa asignada",
          lead: "Te asignaron",
          trail: ".",
          dedupKey: `stage_assigned:${event.target.id}:${event.after.assigned_to}`,
        },
  stage_delivered: (event) => ({
    stageId: event.target.id,
    to: { leads: true },
    exceptActor: true,
    title: "Entrega por revisar",
    lead: "Se entregó",
    trail: " y espera tu visto bueno.",
    dedupKey: `stage_delivered:${event.target.id}`,
  }),
  stage_signed_off: (event) => {
    const approval = event.after;
    const approved = approval.decision === "approved";
    return {
      stageId: approval.project_stage_id,
      to: approved ? { deliverer: true } : { deliverer: true, assignee: true },
      exceptActor: true,
      title: approved ? "Entrega aprobada" : "Etapa devuelta",
      lead: approved ? "Se aprobó tu entrega de" : "Se devolvió",
      trail: approval.comment ? `. Comentario: ${approval.comment}` : ".",
      dedupKey: `stage_signed_off:${approval.id}`,
    };
  },
  project_closed: (event) => {
    const gaps = (event.financeGaps ?? []).filter((flag) => flag !== "no_finance_records");
    if (gaps.length === 0) return null;
    return {
      projectId: event.target.id,
      permission: "finance.read",
      exceptActor: true,
      title: "Proyecto cerrado con pendientes",
      lead: "Se cerró",
      trail: ` con pendientes de finanzas: ${gaps.map((flag) => FINANCE_GAPS[flag] ?? flag).join(", ")}.`,
      dedupKey: `project_closed:${event.target.id}`,
    };
  },
};

/**
 * Cómo se lee cada pendiente de finanzas en un aviso (RF-FIN-08). `no_finance_records` no avisa
 * por sí solo: un proyecto sin costo sin facturas es lo normal.
 */
const FINANCE_GAPS = {
  missing_invoices: "faltan facturas",
  costed_no_quote: "tiene costo y no tiene cotización",
  delivered_no_invoice: "se entregó y no tiene facturas",
};

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

  /** Envía en tiempo real las notificaciones que una consulta ya guardó, y regresa cuántas fueron. */
  deliver(rows) {
    for (const notification of rows.map(shapeNotification)) {
      realtime.sendToUser(notification.userId, "notification:new", notification);
    }
    return { notified: rows.length };
  }

  /** Avisa a todo el equipo de los cumpleaños de hoy; una sola vez por persona y año. */
  async notifyBirthdays(now = new Date()) {
    return this.deliver(await query.notifyBirthdays(now.toISOString()));
  }

  /** Avisa a líderes y administradores qué proyectos cerrados borran sus archivos en los próximos `days` días. */
  async notifyFilesExpiring(now = new Date(), days = 7) {
    return this.deliver(await query.notifyFilesExpiring(now.toISOString(), days));
  }

  /**
   * Resumen de pendientes de finanzas: a finanzas, cuántos proyectos tienen cada pendiente; a cada
   * líder de área, cuáles de los suyos. Una sola vez por persona cada `days` días.
   */
  async notifyFinanceGaps(now = new Date(), days = 3) {
    return this.deliver(await query.notifyFinanceGaps(now.toISOString(), days));
  }

  /** Registra este módulo como suscriptor de eventos de dominio. Se llama una vez al iniciar la aplicación. */
  subscribe() {
    events.on("notifications", (event) => this.handle(event));
  }

  /**
   * Avisa según HANDLERS, con una sola consulta por evento: por etapa (`stageId`) o, por proyecto, a
   * quien tenga un permiso (`projectId` y `permission`). Quien hizo la acción no recibe su propio
   * aviso, salvo en `stage_activated`.
   */
  async handle(event) {
    const spec = HANDLERS[event?.action]?.(event);
    if (!spec?.stageId && !spec?.projectId) return;

    const { stageId, projectId, exceptActor = false, ...message } = spec;
    const exceptUserId = exceptActor ? (currentActor()?.id ?? null) : null;
    this.deliver(
      stageId
        ? await query.notifyStage(stageId, { ...message, exceptUserId })
        : await query.notifyPermission(projectId, { ...message, exceptUserId }),
    );
  }
}

export default new Notifications();
