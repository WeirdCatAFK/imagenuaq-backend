// Print shop: pantone catalog CRUD, machine management, order creation with auto-generated
// order number, and status lifecycle (RF-IMP-01 to RF-IMP-08).
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  tokenFor,
  grantPermissions,
  sql,
} from "./helpers/fixtures.js";

const ADMIN = "coordinacion.imp@uaq.mx";
const WORKER = "empleado.imp@uaq.mx";

describe("/api/print", () => {
  let server, adminToken, workerToken;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "worker", ["print.read"]);
  });

  after(async () => {
    try {
      await grantPermissions(server, adminToken, "worker", []);
      await resetCases();
      await reset();
    } finally {
      await server?.close();
    }
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    await createActive({ email: WORKER });
    workerToken = await tokenFor(server, WORKER);
  });

  describe("machines", () => {
    test("lists seeded machines", async () => {
      const res = await server.get("/api/print/machines", { token: adminToken });
      assert.equal(res.status, 200);
      const names = res.body.machines.map((m) => m.name);
      assert.ok(names.includes("SORM"));
      assert.ok(names.includes("GTO"));
    });

    test("creates and updates a machine", async () => {
      const create = await server.post("/api/print/machines", {
        token: adminToken,
        body: { name: "RYOBI" },
      });
      assert.equal(create.status, 201);
      assert.equal(create.body.machine.name, "RYOBI");

      const update = await server.patch(`/api/print/machines/${create.body.machine.id}`, {
        token: adminToken,
        body: { isActive: false },
      });
      assert.equal(update.status, 200);
      assert.equal(update.body.machine.isActive, false);
    });

    test("rejects duplicate machine names", async () => {
      const res = await server.post("/api/print/machines", {
        token: adminToken,
        body: { name: "SORM" },
      });
      assert.equal(res.status, 409);
    });
  });

  describe("pantones", () => {
    test("lists seeded pantones", async () => {
      const res = await server.get("/api/print/pantones", { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.pantones.length >= 29);
    });

    test("looks up pantones by entity", async () => {
      const res = await server.get("/api/print/pantones/lookup?entity=UAVIG", { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.pantones.length, 2);
    });

    test("creates, updates and deletes a pantone", async () => {
      const create = await server.post("/api/print/pantones", {
        token: adminToken,
        body: { entityName: "Test Faculty", pantoneCode: "999", hexValue: "#FF0000" },
      });
      assert.equal(create.status, 201);
      assert.equal(create.body.pantone.entityName, "Test Faculty");

      const update = await server.patch(`/api/print/pantones/${create.body.pantone.id}`, {
        token: adminToken,
        body: { hexValue: "#00FF00" },
      });
      assert.equal(update.status, 200);
      assert.equal(update.body.pantone.hexValue, "#00FF00");

      const del = await server.delete(`/api/print/pantones/${create.body.pantone.id}`, {
        token: adminToken,
      });
      assert.equal(del.status, 200);
    });

    test("rejects duplicate entity+pantone", async () => {
      await server.post("/api/print/pantones", {
        token: adminToken,
        body: { entityName: "Dup Test", pantoneCode: "111" },
      });
      const dup = await server.post("/api/print/pantones", {
        token: adminToken,
        body: { entityName: "Dup Test", pantoneCode: "111" },
      });
      assert.equal(dup.status, 409);
    });
  });

  describe("orders", () => {
    let projectId, machineId;

    beforeEach(async () => {
      const project = await server.post("/api/projects", {
        token: adminToken,
        body: { title: "Papel institucional", requester: "Bachilleres" },
      });
      projectId = project.body.project.id;

      const machines = await server.get("/api/print/machines", { token: adminToken });
      machineId = machines.body.machines.find((m) => m.name === "SORM").id;
    });

    async function createOrder(extra = {}) {
      return server.post("/api/print/orders", {
        token: adminToken,
        body: {
          projectId,
          machineId,
          trabajo: "Hojas Membretadas",
          entityName: "Bachilleres",
          pantoneCode: "632",
          papelType: "Bond 90 gm",
          papelSize: "448x610 mm",
          cantidad: 1000,
          laminas: 2,
          frente: true,
          ...extra,
        },
      });
    }

    test("creates an order with auto-generated number", async () => {
      const res = await createOrder();
      assert.equal(res.status, 201);
      const order = res.body.order;
      assert.ok(order.orderNumber.startsWith("OT-"));
      assert.equal(order.trabajo, "Hojas Membretadas");
      assert.equal(order.status, "pending");
      assert.equal(order.machineName, "SORM");
    });

    test("publishes order number to project_field_values (RF-IMP-08)", async () => {
      const res = await createOrder();
      const orderNumber = res.body.order.orderNumber;

      const [fv] = await sql(
        "select value from project_field_values where project_id = $1 and key = 'numero_orden_impresion'",
        [projectId],
      );
      assert.equal(fv.value, orderNumber);
    });

    test("order status lifecycle: pending -> in_progress -> completed", async () => {
      const created = await createOrder();
      const orderId = created.body.order.id;

      const progress = await server.post(`/api/print/orders/${orderId}/status`, {
        token: adminToken,
        body: { status: "in_progress" },
      });
      assert.equal(progress.status, 200);
      assert.equal(progress.body.order.status, "in_progress");

      const complete = await server.post(`/api/print/orders/${orderId}/status`, {
        token: adminToken,
        body: { status: "completed" },
      });
      assert.equal(complete.status, 200);
      assert.equal(complete.body.order.status, "completed");
      assert.ok(complete.body.order.completedAt);
    });

    test("cannot skip status steps", async () => {
      const created = await createOrder();
      const res = await server.post(`/api/print/orders/${created.body.order.id}/status`, {
        token: adminToken,
        body: { status: "completed" },
      });
      assert.equal(res.status, 400);
    });

    test("cancellation works from pending", async () => {
      const created = await createOrder();
      const res = await server.post(`/api/print/orders/${created.body.order.id}/status`, {
        token: adminToken,
        body: { status: "cancelled" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.order.status, "cancelled");
    });

    test("delete removes a pending order", async () => {
      const created = await createOrder();
      const del = await server.delete(`/api/print/orders/${created.body.order.id}`, {
        token: adminToken,
      });
      assert.equal(del.status, 200);

      const get = await server.get(`/api/print/orders/${created.body.order.id}`, {
        token: adminToken,
      });
      assert.equal(get.status, 404);
    });

    test("worker without print.create cannot create orders", async () => {
      const res = await server.post("/api/print/orders", {
        token: workerToken,
        body: { projectId, machineId, trabajo: "Test" },
      });
      assert.equal(res.status, 403);
    });

    test("lists and filters orders by status", async () => {
      await createOrder();
      const created2 = await createOrder({ trabajo: "Carpetas" });
      await server.post(`/api/print/orders/${created2.body.order.id}/status`, {
        token: adminToken,
        body: { status: "in_progress" },
      });

      const all = await server.get("/api/print/orders", { token: adminToken });
      assert.equal(all.status, 200);
      assert.ok(all.body.orders.length >= 2);

      const pending = await server.get("/api/print/orders?status=pending", { token: adminToken });
      assert.ok(pending.body.orders.every((o) => o.status === "pending"));
    });
  });
});
