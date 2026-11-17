// Vehicle bookings (RF-CAL-04): the catalog and no overlapping bookings of one vehicle. Only the
// booker or coordination changes one, and each booking shows in the calendar as its own kind.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import { reset, resetCases, createActive, tokenFor, grantPermissions, sql } from "./helpers/fixtures.js";

const ADMIN = "coordinacion.veh@uaq.mx";

/** Tomorrow at `hour`:00 UTC plus `days`, as an ISO instant. */
function at(hour, days = 1) {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

describe("/api/vehicles", () => {
  let server, adminToken, anaToken, betoToken, van, car;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "worker", ["calendar.read", "vehicle.book"]);
  });

  after(async () => {
    try {
      await grantPermissions(server, adminToken, "worker", []);
      await reset();
    } finally {
      await server?.close();
    }
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    await createActive({ email: "ana.veh@uaq.mx", fullName: "Ana" });
    await createActive({ email: "beto.veh@uaq.mx", fullName: "Beto" });
    anaToken = await tokenFor(server, "ana.veh@uaq.mx");
    betoToken = await tokenFor(server, "beto.veh@uaq.mx");
    van = (await server.post("/api/vehicles", { token: adminToken, body: { name: "Camioneta", plate: "UAQ-01" } })).body.vehicle;
    car = (await server.post("/api/vehicles", { token: adminToken, body: { name: "Sedán" } })).body.vehicle;
  });

  async function book(token, body = {}) {
    return server.post("/api/vehicles/bookings", {
      token,
      body: { vehicleId: van.id, kind: "delivery", destination: "Rectoría", startsAt: at(15), endsAt: at(17), ...body },
    });
  }

  test("the catalog is coordination's", async () => {
    assert.equal(van.plate, "UAQ-01");
    const refused = await server.post("/api/vehicles", { token: anaToken, body: { name: "Moto" } });
    assert.equal(refused.status, 403);
    const duplicate = await server.post("/api/vehicles", { token: adminToken, body: { name: "Camioneta" } });
    assert.equal(duplicate.status, 409);
    const listed = await server.get("/api/vehicles", { token: anaToken });
    assert.deepEqual(listed.body.vehicles.map((v) => v.name), ["Camioneta", "Sedán"]);
  });

  test("a booking shows in the calendar as a vehicle event", async () => {
    const res = await book(anaToken, { kind: "pickup" });
    assert.equal(res.status, 201);
    assert.equal(res.body.booking.vehicleName, "Camioneta");

    const day = at(15).slice(0, 10);
    const calendar = await server.get(`/api/calendar?from=${day}&to=${day}`, { token: betoToken });
    const event = calendar.body.events.find((e) => e.kind === "vehicle");
    assert.ok(event, "the booking is in the calendar");
    assert.equal(event.bookingId, res.body.booking.id);
    assert.equal(event.bookingKind, "pickup");
    assert.equal(event.title, "Camioneta · Rectoría");
    assert.equal(event.editable, false, "Beto did not book it");
  });

  test("one vehicle cannot be booked twice at once; another can, and so can the next slot", async () => {
    assert.equal((await book(anaToken)).status, 201);
    const overlap = await book(betoToken, { startsAt: at(16), endsAt: at(18) });
    assert.equal(overlap.status, 409);
    assert.equal((await book(betoToken, { vehicleId: car.id, startsAt: at(16), endsAt: at(18) })).status, 201);
    assert.equal((await book(betoToken, { startsAt: at(17), endsAt: at(18) })).status, 201);
  });

  test("an inactive vehicle and a bad span are refused", async () => {
    await server.patch(`/api/vehicles/${car.id}`, { token: adminToken, body: { isActive: false } });
    assert.equal((await book(anaToken, { vehicleId: car.id })).status, 400);
    assert.equal((await book(anaToken, { startsAt: at(17), endsAt: at(15) })).status, 400);
    assert.equal((await book(anaToken, { kind: "taxi" })).status, 400);
  });

  test("only the booker or coordination changes a booking", async () => {
    const { booking } = (await book(anaToken)).body;
    const path = `/api/vehicles/bookings/${booking.id}`;
    assert.equal((await server.patch(path, { token: betoToken, body: { destination: "Otro" } })).status, 403);
    assert.equal((await server.delete(path, { token: betoToken })).status, 403);

    const moved = await server.patch(path, { token: anaToken, body: { startsAt: at(15, 2), endsAt: at(17, 2) } });
    assert.equal(moved.status, 200);
    const [event] = await sql("select starts_at from events where id = $1", [booking.eventId]);
    assert.equal(new Date(event.starts_at).toISOString(), at(15, 2), "the calendar event follows");

    assert.equal((await server.patch(path, { token: adminToken, body: { destination: "Bodega" } })).status, 200);
  });

  test("cancelling a booking drops its calendar event", async () => {
    const { booking } = (await book(anaToken)).body;
    assert.equal((await server.delete(`/api/vehicles/bookings/${booking.id}`, { token: anaToken })).status, 204);
    assert.deepEqual(await sql("select id from events where id = $1", [booking.eventId]), []);
  });

  test("booking needs vehicle.book", async () => {
    await grantPermissions(server, adminToken, "worker", ["calendar.read"]);
    try {
      assert.equal((await book(anaToken)).status, 403);
    } finally {
      await grantPermissions(server, adminToken, "worker", ["calendar.read", "vehicle.book"]);
    }
  });
});
