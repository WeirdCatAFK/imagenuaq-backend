// Print shop: work-order generation, pantone catalog and machine management
// (RF-IMP-01 to RF-IMP-08). createOrder writes the order number to project_field_values
// so downstream billing reads it without recapture (RF-IMP-08, RF-FLW-06).
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  UNIQUE_VIOLATION,
  requireText,
  requireId,
  optionalText,
  optionalId,
  optionalBoolean,
} from "../../utils/validate.js";

const TEXT_MAX = 300;

/** @param {{ id, name, is_active }} row */
function shapeMachine(row) {
  return { id: row.id, name: row.name, isActive: row.is_active };
}

/** @param {{ id, entity_name, pantone_code, hex_value, is_active }} row */
function shapePantone(row) {
  return {
    id: row.id,
    entityName: row.entity_name,
    pantoneCode: row.pantone_code,
    hexValue: row.hex_value,
    isActive: row.is_active,
  };
}

function shapeOrder(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectTitle: row.project_title,
    projectRequester: row.project_requester,
    orderNumber: row.order_number,
    machineId: row.machine_id,
    machineName: row.machine_name,
    status: row.status,
    entityName: row.entity_name,
    pantoneCode: row.pantone_code,
    pantalla: row.pantalla,
    trabajo: row.trabajo,
    papelType: row.papel_type,
    papelSize: row.papel_size,
    cantidad: row.cantidad,
    laminas: row.laminas,
    frente: row.frente,
    vuelta: row.vuelta,
    corte: row.corte,
    folio: row.folio,
    paquetesD: row.paquetes_d,
    pegado: row.pegado,
    copiante: row.copiante,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function actorId() {
  const actor = currentActor();
  if (!actor) throw ApiError.badRequest("No acting user.");
  return actor.id;
}

const STATUS_MOVES = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

class Print {
  async listMachines() {
    return (await query.listPrintMachines()).map(shapeMachine);
  }

  async createMachine(input) {
    const name = requireText(input.name, "name", 50);
    try {
      const row = await query.createPrintMachine({ name });
      await events.emit({ action: "machine_created", target: { table: "print_machines", id: row.id }, after: row });
      return shapeMachine(row);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) throw ApiError.conflict("Ya existe una maquina con ese nombre.");
      throw err;
    }
  }

  async updateMachine(id, input) {
    id = requireId(id, "machine id");
    const name = optionalText(input.name, "name", 50);
    const isActive = optionalBoolean(input.isActive, "isActive");
    const row = await query.updatePrintMachine(id, { name, isActive });
    if (!row) throw ApiError.notFound("Maquina no encontrada.");
    await events.emit({ action: "machine_updated", target: { table: "print_machines", id } });
    return shapeMachine(row);
  }

  async listPantones(entity) {
    return (await query.listPantones({ entity: entity || null })).map(shapePantone);
  }

  async lookupPantones(entityName) {
    if (!entityName) return [];
    return (await query.lookupPantones(entityName)).map(shapePantone);
  }

  async createPantone(input) {
    const entityName = requireText(input.entityName, "entityName", 200);
    const pantoneCode = requireText(input.pantoneCode, "pantoneCode", 50);
    const hexValue = optionalText(input.hexValue, "hexValue", 7);
    try {
      const row = await query.createPantone({ entityName, pantoneCode, hexValue });
      await events.emit({ action: "pantone_created", target: { table: "pantone_catalog", id: row.id }, after: row });
      return shapePantone(row);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) throw ApiError.conflict("Ese pantone ya existe para esa entidad.");
      throw err;
    }
  }

  async updatePantone(id, input) {
    id = requireId(id, "pantone id");
    const entityName = optionalText(input.entityName, "entityName", 200);
    const pantoneCode = optionalText(input.pantoneCode, "pantoneCode", 50);
    const hexValue = optionalText(input.hexValue, "hexValue", 7);
    const isActive = optionalBoolean(input.isActive, "isActive");
    const row = await query.updatePantone(id, { entityName, pantoneCode, hexValue, isActive });
    if (!row) throw ApiError.notFound("Pantone no encontrado.");
    await events.emit({ action: "pantone_updated", target: { table: "pantone_catalog", id } });
    return shapePantone(row);
  }

  async deletePantone(id) {
    id = requireId(id, "pantone id");
    const row = await query.deletePantone(id);
    if (!row) throw ApiError.notFound("Pantone no encontrado.");
    await events.emit({ action: "pantone_deleted", target: { table: "pantone_catalog", id } });
  }

  async listOrders(params = {}) {
    const rows = await query.listPrintOrders({
      status: params.status || null,
      projectId: params.projectId ? Number(params.projectId) : null,
    });
    return rows.map(shapeOrder);
  }

  async getOrder(id) {
    id = requireId(id, "order id");
    const row = await query.getPrintOrder(id);
    if (!row) throw ApiError.notFound("Orden no encontrada.");
    return shapeOrder(row);
  }

  async createOrder(input) {
    const projectId = requireId(input.projectId, "projectId");
    const machineId = requireId(input.machineId, "machineId");
    const trabajo = requireText(input.trabajo, "trabajo", TEXT_MAX);

    const year = new Date().getFullYear();
    const orderNumber = await query.nextPrintOrderNumber(year);

    const row = await query.createPrintOrder({
      projectId,
      orderNumber,
      machineId,
      entityName: input.entityName || null,
      pantoneCode: input.pantoneCode || null,
      pantalla: input.pantalla || null,
      trabajo,
      papelType: input.papelType || null,
      papelSize: input.papelSize || null,
      cantidad: input.cantidad != null ? Number(input.cantidad) : null,
      laminas: input.laminas != null ? Number(input.laminas) : null,
      frente: !!input.frente,
      vuelta: !!input.vuelta,
      corte: input.corte || null,
      folio: input.folio || null,
      paquetes_d: input.paquetesD != null ? Number(input.paquetesD) : null,
      pegado: !!input.pegado,
      copiante: !!input.copiante,
      notes: input.notes || null,
      createdBy: actorId(),
    });

    await query.upsertFieldValue(projectId, {
      key: "numero_orden_impresion",
      value: orderNumber,
    });

    await events.emit({ action: "print_order_created", target: { table: "print_orders", id: row.id } });

    return this.getOrder(row.id);
  }

  async updateOrder(id, input) {
    id = requireId(id, "order id");
    const existing = await query.getPrintOrder(id);
    if (!existing) throw ApiError.notFound("Orden no encontrada.");
    if (existing.status === "completed" || existing.status === "cancelled") {
      throw ApiError.badRequest("No se puede modificar una orden completada o cancelada.");
    }

    const row = await query.updatePrintOrder(id, {
      machineId: input.machineId ? Number(input.machineId) : null,
      entityName: input.entityName,
      pantoneCode: input.pantoneCode,
      pantalla: input.pantalla,
      trabajo: input.trabajo,
      papelType: input.papelType,
      papelSize: input.papelSize,
      cantidad: input.cantidad != null ? Number(input.cantidad) : null,
      laminas: input.laminas != null ? Number(input.laminas) : null,
      frente: input.frente,
      vuelta: input.vuelta,
      corte: input.corte,
      folio: input.folio,
      paquetesD: input.paquetesD != null ? Number(input.paquetesD) : null,
      pegado: input.pegado,
      copiante: input.copiante,
      notes: input.notes,
    });

    await events.emit({ action: "print_order_updated", target: { table: "print_orders", id } });
    return this.getOrder(row.id);
  }

  async changeStatus(id, input) {
    id = requireId(id, "order id");
    const target = requireText(input.status, "status", 20);
    const existing = await query.getPrintOrder(id);
    if (!existing) throw ApiError.notFound("Orden no encontrada.");

    const allowed = STATUS_MOVES[existing.status];
    if (!allowed || !allowed.includes(target)) {
      throw ApiError.badRequest(`No se puede cambiar de ${existing.status} a ${target}.`);
    }

    const completedAt = target === "completed" ? new Date().toISOString() : null;
    await query.updatePrintOrderStatus(id, { status: target, completedAt });

    await events.emit({ action: "print_order_status", target: { table: "print_orders", id } });
    return this.getOrder(id);
  }

  async deleteOrder(id) {
    id = requireId(id, "order id");
    const existing = await query.getPrintOrder(id);
    if (!existing) throw ApiError.notFound("Orden no encontrada.");
    if (existing.status !== "pending") {
      throw ApiError.badRequest("Solo se pueden eliminar ordenes pendientes.");
    }
    await query.deletePrintOrder(id);
    await events.emit({ action: "print_order_deleted", target: { table: "print_orders", id } });
  }
}

export default new Print();
