// Vehicles and their bookings for delivering and picking up material (RF-CAL-04). The database
// refuses two overlapping bookings of one vehicle, and a trigger keeps each booking's calendar event.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  CHECK_VIOLATION,
  EXCLUSION_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
  optionalBoolean,
  optionalId,
  optionalInstant,
  optionalText,
  requireId,
  requireText,
} from "../../utils/validate.js";

const KINDS = ["delivery", "pickup"];

/** The widest span one bookings read may ask for, as the calendar's. */
const MAX_DAYS = 92;

class Vehicles {
  async listVehicles() {
    return (await query.listVehicles()).map(shapeVehicle);
  }

  /** @throws {ApiError} 400, 409 on a name already taken. */
  async createVehicle(input) {
    const body = input ?? {};
    const name = requireText(body.name, "name", 100);
    const plate = optionalText(body.plate, "plate", 20);
    const row = await translate(() => query.createVehicle({ name, plate }));
    await events.emit({ action: "record_created", target: { table: "vehicles", id: row.id }, after: row });
    return shapeVehicle(row);
  }

  /** Renames, re-plates or (de)activates a vehicle. Its bookings stay. @throws {ApiError} 400, 404, 409. */
  async updateVehicle(vehicleId, input) {
    const id = requireId(vehicleId, "vehicleId");
    const body = input ?? {};
    const before = await query.getVehicle(id);
    if (!before) throw ApiError.notFound("Vehicle not found.");
    const row = await translate(() =>
      query.updateVehicle(id, {
        name: optionalText(body.name, "name", 100),
        plate: optionalText(body.plate, "plate", 20),
        isActive: optionalBoolean(body.isActive, "isActive"),
      }),
    );
    await events.emit({ action: "record_updated", target: { table: "vehicles", id }, before, after: row });
    return shapeVehicle(row);
  }

  /**
   * The bookings that touch `from`..`to` (YYYY-MM-DD or instants), optionally of one vehicle.
   *
   * @throws {ApiError} 400 on a missing or too wide span.
   */
  async listBookings({ from, to, vehicleId }) {
    const start = optionalInstant(from, "from");
    const end = optionalInstant(to, "to");
    if (start === null || end === null) throw ApiError.badRequest("from and to are required.");
    if (end < start) throw ApiError.badRequest("to must not be earlier than from.");
    if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > MAX_DAYS) {
      throw ApiError.badRequest(`A bookings read covers at most ${MAX_DAYS} days.`);
    }
    const rows = await query.listVehicleBookings({ from: start, to: end, vehicleId: optionalId(vehicleId, "vehicleId") });
    return rows.map(shapeBooking);
  }

  /**
   * Books an active vehicle for a delivery or a pickup.
   *
   * @throws {ApiError} 400 on a bad payload or an inactive vehicle, 409 when it is already booked then.
   */
  async createBooking(input) {
    const body = input ?? {};
    const fields = readBooking(body, true);
    await requireActive(fields.vehicleId);
    const row = await translate(() => query.insertVehicleBooking({ ...fields, bookedBy: currentActor().id }));
    await events.emit({ action: "record_created", target: { table: "vehicle_bookings", id: row.id }, after: row });
    return shapeBooking(row);
  }

  /**
   * Changes or moves a booking. `projectId: null` or `notes: null` clears them.
   *
   * @throws {ApiError} 400, 403 to anyone other than its booker or coordination, 404, 409 on an overlap.
   */
  async updateBooking(bookingId, input) {
    const id = requireId(bookingId, "bookingId");
    const before = await ownBooking(id);
    const body = input ?? {};
    const fields = readBooking(body, false);
    if (fields.vehicleId !== null && String(fields.vehicleId) !== String(before.vehicle_id)) {
      await requireActive(fields.vehicleId);
    }
    const starts = fields.startsAt ?? new Date(before.starts_at).toISOString();
    const ends = fields.endsAt ?? new Date(before.ends_at).toISOString();
    if (Date.parse(ends) <= Date.parse(starts)) throw ApiError.badRequest("endsAt must be after startsAt.");
    const clear = ["projectId", "notes"].filter((key) => key in body && body[key] === null);
    const row = await translate(() => query.updateVehicleBooking(id, { ...fields, clear }));
    await events.emit({ action: "record_updated", target: { table: "vehicle_bookings", id }, before, after: row });
    return shapeBooking(row);
  }

  /** Cancels a booking and drops it from the calendar. @throws {ApiError} 403, 404. */
  async deleteBooking(bookingId) {
    const id = requireId(bookingId, "bookingId");
    const before = await ownBooking(id);
    await query.deleteVehicleBooking(id);
    await events.emit({ action: "record_deleted", target: { table: "vehicle_bookings", id }, before });
  }
}

/** The booking `id`, if the caller booked it or is coordination (RF-USR-06). */
async function ownBooking(id) {
  const booking = await query.getVehicleBooking(id);
  if (!booking) throw ApiError.notFound("Booking not found.");
  const actor = currentActor();
  if (String(booking.booked_by) !== String(actor.id) && actor.role !== "admin") {
    throw ApiError.forbidden("Only whoever booked it, or coordination, changes a booking.");
  }
  return booking;
}

async function requireActive(vehicleId) {
  const vehicle = await query.getVehicle(vehicleId);
  if (!vehicle) throw ApiError.badRequest("That vehicle does not exist.");
  if (!vehicle.is_active) throw ApiError.badRequest("That vehicle is not active.");
}

/** A booking's payload. Creating needs every field the table needs. Updating needs none. */
function readBooking(body, creating) {
  const kind = body.kind === undefined && !creating ? null : String(body.kind ?? "");
  if (kind !== null && !KINDS.includes(kind)) throw ApiError.badRequest("kind must be delivery or pickup.");
  const startsAt = optionalInstant(body.startsAt, "startsAt");
  const endsAt = optionalInstant(body.endsAt, "endsAt");
  if (creating && (startsAt === null || endsAt === null)) throw ApiError.badRequest("startsAt and endsAt are required.");
  if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw ApiError.badRequest("endsAt must be after startsAt.");
  }
  return {
    vehicleId: creating ? requireId(body.vehicleId, "vehicleId") : optionalId(body.vehicleId, "vehicleId"),
    kind,
    destination: creating ? requireText(body.destination, "destination", 300) : optionalText(body.destination, "destination", 300),
    projectId: optionalId(body.projectId, "projectId"),
    notes: optionalText(body.notes, "notes", 2000),
    startsAt,
    endsAt,
  };
}

async function translate(write) {
  try {
    return await write();
  } catch (err) {
    if (err?.code === EXCLUSION_VIOLATION) throw ApiError.conflict("That vehicle is already booked at that time.");
    if (err?.code === UNIQUE_VIOLATION) throw ApiError.conflict("A vehicle with that name already exists.");
    if (err?.code === FOREIGN_KEY_VIOLATION) throw ApiError.badRequest("That project does not exist.");
    if (err?.code === CHECK_VIOLATION) throw ApiError.badRequest("endsAt must be after startsAt.");
    throw err;
  }
}

function shapeVehicle(row) {
  return { id: row.id, name: row.name, plate: row.plate, isActive: row.is_active };
}

function shapeBooking(row) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    eventId: row.event_id,
    kind: row.kind,
    destination: row.destination,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectTitle: row.project_title,
    notes: row.notes,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    bookedBy: row.booked_by,
    bookedByName: row.booked_by_name,
  };
}

export default new Vehicles();
