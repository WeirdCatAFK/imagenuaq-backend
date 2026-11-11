// Absence types, entitlements, the request-approve-take lifecycle, balance enforcement, and the
// privacy boundary between availability and the absence detail (RF-AUS-01 to RF-AUS-15).
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  grantPermissions,
  sql,
} from "./helpers/fixtures.js";

const ADMIN = "coordinacion.aus@uaq.mx";
const LEAD = "lider.aus@uaq.mx";
const WORKER = "empleado.aus@uaq.mx";

describe("/api/absences", () => {
  let server;
  let adminToken;
  let adminUser;
  let area;

  before(async () => {
    server = await startServer();
    await reset();
    adminUser = await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "area_lead", [
      "absence.read", "absence.write", "absence.approve",
    ]);
    await grantPermissions(server, adminToken, "worker", [
      "absence.read", "absence.write",
    ]);
  });

  /** resetCases deletes TEST_PREFIX areas, so recreate it each case. */
  async function ensureArea() {
    area = await createArea("Diseño");
    return area;
  }

  after(async () => {
    try {
      await grantPermissions(server, adminToken, "area_lead", []);
      await grantPermissions(server, adminToken, "worker", []);
      await resetCases();
      await reset();
    } finally {
      await server?.close();
    }
  });

  let leadToken, workerToken, workerUser;

  beforeEach(async () => {
    await resetCases([ADMIN]);
    await ensureArea();
    await createActive({ email: LEAD, role: "area_lead", area: area.name });
    workerUser = await createActive({ email: WORKER, area: area.name });
    leadToken = await tokenFor(server, LEAD);
    workerToken = await tokenFor(server, WORKER);
  });

  describe("absence types", () => {
    const unique = () => `zztest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    test("lists seeded absence types", async () => {
      const res = await server.get("/api/absences/types", { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.types.length >= 7);
      const codes = res.body.types.map((t) => t.code);
      assert.ok(codes.includes("vacaciones"));
      assert.ok(codes.includes("permiso_economico"));
    });

    test("creates and updates an absence type", async () => {
      const code = unique();
      const create = await server.post("/api/absences/types", {
        token: adminToken,
        body: { code, label: "Tipo de prueba", unit: "day" },
      });
      assert.equal(create.status, 201);
      assert.equal(create.body.type.code, code);
      assert.equal(create.body.type.consumesBalance, true);

      const update = await server.patch(`/api/absences/types/${create.body.type.id}`, {
        token: adminToken,
        body: { label: "Tipo modificado", consumesBalance: false },
      });
      assert.equal(update.status, 200);
      assert.equal(update.body.type.label, "Tipo modificado");
      assert.equal(update.body.type.consumesBalance, false);
    });

    test("a worker cannot create absence types", async () => {
      const res = await server.post("/api/absences/types", {
        token: workerToken,
        body: { code: unique(), label: "No", unit: "day" },
      });
      assert.equal(res.status, 403);
    });

    test("rejects duplicate codes", async () => {
      const code = unique();
      await server.post("/api/absences/types", {
        token: adminToken,
        body: { code, label: "Primera", unit: "day" },
      });
      const dup = await server.post("/api/absences/types", {
        token: adminToken,
        body: { code, label: "Segunda", unit: "day" },
      });
      assert.equal(dup.status, 409);
    });
  });

  describe("entitlements", () => {
    test("creates an entitlement via contract-types", async () => {
      const types = await server.get("/api/contract-types", { token: adminToken });
      const ct = types.body.contractTypes[0];
      const absTypes = await server.get("/api/absences/types", { token: adminToken });
      const vacaciones = absTypes.body.types.find((t) => t.code === "vacaciones");

      const create = await server.post(`/api/contract-types/${ct.id}/entitlements`, {
        token: adminToken,
        body: { absenceTypeId: vacaciones.id, amount: 10, validFrom: "2026-01-01" },
      });
      assert.equal(create.status, 201);
      assert.equal(create.body.entitlement.amount, 10);

      const list = await server.get(`/api/contract-types/${ct.id}/entitlements`, {
        token: adminToken,
      });
      assert.equal(list.status, 200);
      assert.ok(list.body.entitlements.length >= 1);
    });
  });

  describe("absence lifecycle", () => {
    let absenceTypeId;

    beforeEach(async () => {
      const types = await server.get("/api/absences/types", { token: adminToken });
      const pe = types.body.types.find((t) => t.code === "permiso_economico");
      absenceTypeId = pe.id;

      await sql(
        `insert into leave_balances (user_id, absence_type_id, cycle_start, cycle_end, granted, used)
         values ($1, $2, '2026-01-01', '2026-12-31', 5, 0)
         on conflict (user_id, absence_type_id, cycle_start) do update set granted = 5, used = 0`,
        [workerUser.id, absenceTypeId],
      );
    });

    async function createAbsence(body = {}, token = workerToken) {
      return server.post("/api/absences", {
        token,
        body: {
          userId: workerUser.id,
          absenceTypeId,
          startsAt: "2026-06-15T08:00:00Z",
          endsAt: "2026-06-16T08:00:00Z",
          reason: "Diligencia personal",
          ...body,
        },
      });
    }

    test("creates an absence in requested status", async () => {
      const res = await createAbsence();
      assert.equal(res.status, 201);
      assert.equal(res.body.absence.status, "requested");
      assert.equal(res.body.absence.reason, "Diligencia personal");
    });

    test("approve deducts balance, taken is final", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      const approve = await server.post(`/api/absences/${eventId}/status`, {
        token: leadToken,
        body: { status: "approved" },
      });
      assert.equal(approve.status, 200);
      assert.equal(approve.body.absence.status, "approved");

      const [balance] = await sql(
        "select used from leave_balances where user_id = $1 and absence_type_id = $2",
        [workerUser.id, absenceTypeId],
      );
      assert.equal(Number(balance.used), 1);

      const taken = await server.post(`/api/absences/${eventId}/status`, {
        token: leadToken,
        body: { status: "taken" },
      });
      assert.equal(taken.status, 200);
      assert.equal(taken.body.absence.status, "taken");
    });

    test("reject does not change balance", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      const reject = await server.post(`/api/absences/${eventId}/status`, {
        token: leadToken,
        body: { status: "rejected", note: "No procede" },
      });
      assert.equal(reject.status, 200);
      assert.equal(reject.body.absence.status, "rejected");

      const [balance] = await sql(
        "select used from leave_balances where user_id = $1 and absence_type_id = $2",
        [workerUser.id, absenceTypeId],
      );
      assert.equal(Number(balance.used), 0);
    });

    test("cancel after approve restores balance", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      await server.post(`/api/absences/${eventId}/status`, {
        token: leadToken,
        body: { status: "approved" },
      });

      const cancel = await server.post(`/api/absences/${eventId}/status`, {
        token: leadToken,
        body: { status: "cancelled" },
      });
      assert.equal(cancel.status, 200);

      const [balance] = await sql(
        "select used from leave_balances where user_id = $1 and absence_type_id = $2",
        [workerUser.id, absenceTypeId],
      );
      assert.equal(Number(balance.used), 0);
    });

    test("can approve your own absence with the right permission", async () => {
      const created = await createAbsence({ userId: adminUser.id }, adminToken);
      const res = await server.post(`/api/absences/${created.body.absence.eventId}/status`, {
        token: adminToken,
        body: { status: "approved" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.absence.status, "approved");
    });

    test("delete removes a requested absence", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      const del = await server.delete(`/api/absences/${eventId}`, { token: workerToken });
      assert.equal(del.status, 200);

      const get = await server.get(`/api/absences/${eventId}`, { token: workerToken });
      assert.equal(get.status, 404);
    });

    test("warns when balance would be exceeded", async () => {
      await sql(
        "update leave_balances set used = 4 where user_id = $1 and absence_type_id = $2",
        [workerUser.id, absenceTypeId],
      );

      const res = await createAbsence({
        startsAt: "2026-07-01T08:00:00Z",
        endsAt: "2026-07-03T08:00:00Z",
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.warning);
    });

    test("status history records transitions", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      await server.post(`/api/absences/${eventId}/status`, {
        token: leadToken,
        body: { status: "approved" },
      });

      const hist = await server.get(`/api/absences/${eventId}/history`, { token: workerToken });
      assert.equal(hist.status, 200);
      assert.ok(hist.body.history.length >= 2);
      assert.equal(hist.body.history[0].status, "requested");
      assert.equal(hist.body.history[1].status, "approved");
    });
  });

  describe("availability", () => {
    test("returns who is away without the motive", async () => {
      const types = await server.get("/api/absences/types", { token: adminToken });
      const pe = types.body.types.find((t) => t.code === "permiso_economico");

      await sql(
        `insert into leave_balances (user_id, absence_type_id, cycle_start, cycle_end, granted, used)
         values ($1, $2, '2026-01-01', '2026-12-31', 5, 0)
         on conflict (user_id, absence_type_id, cycle_start) do update set granted = 5, used = 0`,
        [workerUser.id, pe.id],
      );

      const created = await server.post("/api/absences", {
        token: workerToken,
        body: {
          userId: workerUser.id,
          absenceTypeId: pe.id,
          startsAt: "2026-06-15T08:00:00Z",
          endsAt: "2026-06-16T08:00:00Z",
          reason: "Motivo secreto",
        },
      });

      await server.post(`/api/absences/${created.body.absence.eventId}/status`, {
        token: leadToken,
        body: { status: "approved" },
      });

      const avail = await server.get(
        "/api/absences/availability?from=2026-06-15&to=2026-06-16",
        { token: workerToken },
      );
      assert.equal(avail.status, 200);
      const rows = avail.body;
      assert.ok(Array.isArray(rows));
      for (const row of rows) {
        assert.equal(row.reason, undefined);
      }
    });
  });

  describe("privacy", () => {
    test("non-detail readers see no motive in the absence list", async () => {
      const types = await server.get("/api/absences/types", { token: adminToken });
      const pe = types.body.types.find((t) => t.code === "permiso_economico");

      await sql(
        `insert into leave_balances (user_id, absence_type_id, cycle_start, cycle_end, granted, used)
         values ($1, $2, '2026-01-01', '2026-12-31', 5, 0)
         on conflict (user_id, absence_type_id, cycle_start) do update set granted = 5, used = 0`,
        [workerUser.id, pe.id],
      );

      const created = await server.post("/api/absences", {
        token: workerToken,
        body: {
          userId: workerUser.id,
          absenceTypeId: pe.id,
          startsAt: "2026-08-01T08:00:00Z",
          endsAt: "2026-08-02T08:00:00Z",
          reason: "Motivo privado",
        },
      });
      assert.equal(created.status, 201);

      const list = await server.get("/api/absences", { token: leadToken });
      assert.equal(list.status, 200);
      const absence = list.body.find((a) => a.eventId === created.body.absence.eventId);
      assert.equal(absence.reason, null);
    });
  });
});
