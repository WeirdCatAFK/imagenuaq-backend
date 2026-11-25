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

    test("a null amount ends the cap, keeping what it was (RF-AUS-04)", async () => {
      const { contractTypes } = (await server.get("/api/contract-types", { token: adminToken })).body;
      const { types } = (await server.get("/api/absences/types", { token: adminToken })).body;
      const type = types.find((t) => t.code === "cumpleanos");
      const path = `/api/contract-types/${contractTypes[0].id}/entitlements`;
      const set = (amount, validFrom) =>
        server.post(path, { token: adminToken, body: { absenceTypeId: type.id, amount, validFrom } });
      const caps = async () =>
        (await server.get(path, { token: adminToken })).body.entitlements.filter((e) => e.absenceTypeId === type.id);
      await sql("delete from contract_type_entitlements where absence_type_id = $1", [type.id]);
      try {
        assert.equal((await set(undefined, "2026-01-01")).status, 400, "only an explicit null ends it");
        assert.equal((await set(null, "2026-01-01")).status, 404);
        assert.equal((await set(1, "2026-01-01")).status, 201);
        const ended = await set(null, "2026-07-01");
        assert.deepEqual([ended.status, ended.body.entitlement], [201, null]);
        assert.deepEqual((await caps()).map((e) => [e.amount, e.validFrom, e.validTo]), [[1, "2026-01-01", "2026-06-30"]]);
        assert.equal((await set(null, "2026-03-01")).status, 404, "it already has an end");
        await set(2, "2026-07-01");
        await set(null, "2026-07-01");
        assert.equal((await caps()).length, 1, "ended the day it starts, it never was");
        assert.equal((await server.post(path, {
          token: workerToken, body: { absenceTypeId: type.id, amount: null, validFrom: "2026-07-01" },
        })).status, 403);
      } finally {
        await sql("delete from contract_type_entitlements where absence_type_id = $1", [type.id]);
      }
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

    test("withdrawing a request leaves it cancelled, with who and when (RF-AUS-14)", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      const del = await server.delete(`/api/absences/${eventId}`, { token: workerToken });
      assert.equal(del.status, 200);

      const get = await server.get(`/api/absences/${eventId}`, { token: workerToken });
      assert.equal(get.body.absence.status, "cancelled");
      const { history } = (await server.get(`/api/absences/${eventId}/history`, { token: workerToken })).body;
      assert.equal(history.at(-1).status, "cancelled");
      assert.equal(String(history.at(-1).changedBy), String(workerUser.id));
      assert.equal((await server.delete(`/api/absences/${eventId}`, { token: workerToken })).status, 409);
    });

    test("an approved absence is not withdrawn by its person", async () => {
      const { eventId } = (await createAbsence()).body.absence;
      await server.post(`/api/absences/${eventId}/status`, { token: leadToken, body: { status: "approved" } });
      assert.equal((await server.delete(`/api/absences/${eventId}`, { token: workerToken })).status, 409);
      assert.equal((await server.get(`/api/absences/${eventId}`, { token: workerToken })).body.absence.status, "approved");
    });

    test("going over the balance is warned about, never refused (RF-AUS-07)", async () => {
      const { eventId } = (await createAbsence({ endsAt: "2026-06-23T08:00:00Z" })).body.absence;
      const approve = await server.post(`/api/absences/${eventId}/status`, { token: leadToken, body: { status: "approved" } });
      assert.equal(approve.status, 200);
      const [balance] = await sql(
        "select granted, used from leave_balances where user_id = $1 and absence_type_id = $2",
        [workerUser.id, absenceTypeId],
      );
      assert.deepEqual([Number(balance.granted), Number(balance.used)], [5, 8]);
    });

    test("no file but the one uploaded for it backs an absence", async () => {
      const created = await createAbsence({ documentFileId: 999999 });
      assert.equal(created.status, 201);
      assert.equal(created.body.absence.documentFileId, null);
      const res = await server.post(`/api/absences/${created.body.absence.eventId}/status`, {
        token: leadToken,
        body: { status: "approved", documentFileId: 999999 },
      });
      assert.equal(res.status, 400);
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

    test("a requested absence can be edited by its person", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      const res = await server.patch(`/api/absences/${eventId}`, {
        token: workerToken,
        body: { startsAt: "2026-06-20T08:00:00Z", endsAt: "2026-06-22T08:00:00Z", reason: "Trámite" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.absence.reason, "Trámite");
      assert.equal(new Date(res.body.absence.startsAt).toISOString(), "2026-06-20T08:00:00.000Z");
      assert.equal(new Date(res.body.absence.endsAt).toISOString(), "2026-06-22T08:00:00.000Z");
      assert.equal(res.body.absence.status, "requested");

      const [log] = await sql(
        `select l.after_data from logs l join actions a on a.id = l.action_id
          where a.code = 'record_updated' and l.target_table = 'absences' and l.target_id = $1`,
        [eventId],
      );
      assert.ok(log, "the edit is audited");
      assert.ok(!JSON.stringify(log.after_data).includes("Trámite"), "the reason stays out of the log");
    });

    test("an approved absence is not edited: cancel and request again", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;
      await server.post(`/api/absences/${eventId}/status`, { token: leadToken, body: { status: "approved" } });

      const res = await server.patch(`/api/absences/${eventId}`, {
        token: workerToken,
        body: { reason: "Otra" },
      });
      assert.equal(res.status, 409);
    });

    test("someone else's absence is not removed without absence.request_others", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      const del = await server.delete(`/api/absences/${eventId}`, { token: leadToken });
      assert.equal(del.status, 403);
      assert.equal((await server.get(`/api/absences/${eventId}`, { token: workerToken })).status, 200);
    });

    test("history notes are hidden from readers without the detail", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;
      await server.post(`/api/absences/${eventId}/status`, {
        token: leadToken,
        body: { status: "rejected", note: "Motivo privado" },
      });

      const own = await server.get(`/api/absences/${eventId}/history`, { token: workerToken });
      assert.equal(own.body.history.at(-1).note, "Motivo privado");
      const other = await server.get(`/api/absences/${eventId}/history`, { token: leadToken });
      assert.equal(other.status, 200);
      assert.ok(other.body.history.every((entry) => entry.note === null));
    });

    test("someone else's absence is not edited without absence.request_others", async () => {
      const created = await createAbsence();
      const res = await server.patch(`/api/absences/${created.body.absence.eventId}`, {
        token: leadToken,
        body: { reason: "Ajena" },
      });
      assert.equal(res.status, 403);
    });

    test("an edit with nothing to change, or a reversed range, is a 400", async () => {
      const created = await createAbsence();
      const eventId = created.body.absence.eventId;

      assert.equal((await server.patch(`/api/absences/${eventId}`, { token: workerToken, body: {} })).status, 400);
      const reversed = await server.patch(`/api/absences/${eventId}`, {
        token: workerToken,
        body: { endsAt: "2026-06-14T08:00:00Z" },
      });
      assert.equal(reversed.status, 400);
      assert.equal(reversed.body.error.message, "endsAt must be after startsAt.");
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

  describe("balances are created from the contract's cap (RF-AUS-06, RF-AUS-15)", () => {
    const year = new Date().getFullYear();
    let type;

    beforeEach(async () => {
      const { types } = (await server.get("/api/absences/types", { token: adminToken })).body;
      type = types.find((t) => t.code === "permiso_economico");
      await sql("delete from contract_type_entitlements where absence_type_id = $1", [type.id]);
      await sql(
        `insert into contract_type_entitlements (contract_type_id, absence_type_id, amount, valid_from)
         select contract_type_id, $2, 5, $3 from users where id = $1`,
        [workerUser.id, type.id, `${year}-01-01`],
      );
    });

    after(() => sql("delete from contract_type_entitlements where absence_type_id = $1", [type.id]));

    const request = async (from, to) =>
      (await server.post("/api/absences", {
        token: workerToken,
        body: {
          userId: workerUser.id, absenceTypeId: type.id, reason: "x",
          startsAt: `${year}-${from}T08:00:00Z`, endsAt: `${year}-${to}T08:00:00Z`,
        },
      })).body;
    const move = (eventId, status) =>
      server.post(`/api/absences/${eventId}/status`, { token: leadToken, body: { status } });
    const mine = async () =>
      (await server.get(`/api/absences/balances/${workerUser.id}`, { token: workerToken })).body.balances
        .find((row) => row.absenceTypeId === type.id);

    test("looking at it creates it, once", async () => {
      const first = await mine();
      assert.deepEqual([first.granted, first.used, first.remaining], [5, 0, 5]);
      assert.deepEqual([first.cycleStart, first.cycleEnd], [`${year}-01-01`, `${year}-12-31`]);
      assert.equal((await mine()).id, first.id);
    });

    test("approving deducts and cancelling gives back, with no balance beforehand", async () => {
      const { absence } = await request("06-01", "06-03");
      assert.equal((await move(absence.eventId, "approved")).status, 200);
      assert.equal((await mine()).used, 2);
      assert.equal((await move(absence.eventId, "cancelled")).status, 200);
      assert.equal((await mine()).used, 0);
    });

    test("an absence approved before the balance existed counts in it", async () => {
      const { absence } = await request("06-01", "06-03");
      await move(absence.eventId, "approved");
      await sql("delete from leave_balances where user_id = $1", [workerUser.id]);
      assert.equal((await mine()).used, 2);
      await move(absence.eventId, "cancelled");
      assert.equal((await mine()).used, 0);
    });

    test("a request over the cap warns", async () => {
      assert.ok((await request("06-01", "06-08")).warning);
      assert.equal((await request("07-01", "07-02")).warning, undefined);
    });

    test("no cap, or one not yet in force, grants nothing", async () => {
      await sql("update contract_type_entitlements set valid_from = $1 where absence_type_id = $2", [`${year + 1}-01-01`, type.id]);
      assert.equal(await mine(), undefined);
      const { absence } = await request("06-01", "06-03");
      assert.equal((await move(absence.eventId, "approved")).status, 200);
    });

    test("one person is granted their own amount, keeping what they used (RF-AUS-05)", async () => {
      const adjust = (body, token = adminToken) =>
        server.put(`/api/absences/balances/${workerUser.id}`, {
          token, body: { absenceTypeId: type.id, cycleStart: `${year}-01-01`, granted: 8, ...body },
        });
      const { absence } = await request("06-01", "06-03");
      await move(absence.eventId, "approved");
      const changed = await adjust({ note: "Antigüedad" });
      assert.equal(changed.status, 200);
      const { granted, used, remaining, note } = changed.body.balance;
      assert.deepEqual([granted, used, remaining, note], [8, 2, 6, "Antigüedad"]);

      await sql("delete from leave_balances where user_id = $1", [workerUser.id]);
      await sql("delete from contract_type_entitlements where absence_type_id = $1", [type.id]);
      assert.equal((await adjust({ cycleStart: `${year}-05-20` })).body.balance.used, 2, "counted without a cap");
      assert.equal((await mine()).cycleStart, `${year}-01-01`);

      assert.equal((await adjust({}, workerToken)).status, 403);
      assert.equal((await adjust({}, leadToken)).status, 403);
      assert.equal((await adjust({ granted: -1 })).status, 400);
      const { types } = (await server.get("/api/absences/types", { token: adminToken })).body;
      const free = types.find((t) => t.code === "comision");
      assert.equal((await adjust({ absenceTypeId: free.id })).status, 404);
      const logged = await sql(
        "select 1 from logs l join actions a on a.id = l.action_id where a.code = 'balance_adjusted'",
      );
      assert.ok(logged.length >= 2);
    });

    test("two decisions at once count once", async () => {
      const { absence } = await request("06-01", "06-03");
      const both = await Promise.all([move(absence.eventId, "approved"), move(absence.eventId, "approved")]);
      assert.equal(both.filter((res) => res.status === 200).length, 1);
      assert.equal((await mine()).used, 2);
    });
  });

  test("the person opens their own backing document, and a colleague does not (RF-AUS-13)", async () => {
    const { types } = (await server.get("/api/absences/types", { token: adminToken })).body;
    const { absence } = (await server.post("/api/absences", {
      token: workerToken,
      body: {
        userId: workerUser.id, absenceTypeId: types[0].id, reason: "x",
        startsAt: "2026-06-15T08:00:00Z", endsAt: "2026-06-16T08:00:00Z",
      },
    })).body;
    const path = `/api/absences/${absence.eventId}/document`;
    assert.equal((await server.get(path, { token: workerToken })).status, 404, "none yet");
    const up = await server.post(`${path}?name=oficio.pdf`, {
      token: leadToken, raw: Buffer.from("%PDF oficio"), headers: { "content-type": "application/pdf" },
    });
    assert.equal(up.status, 201);
    const again = await server.post(`${path}?name=oficio-2.pdf`, {
      token: leadToken, raw: Buffer.from("%PDF oficio 2"), headers: { "content-type": "application/pdf" },
    });
    assert.equal(again.status, 201);
    const folders = await sql(`select owner_id from folders where system_key = 'absence_documents'`);
    assert.deepEqual(folders.map((folder) => Number(folder.owner_id)), [Number(adminUser.id)], "made once, by the first upload");

    await createActive({ email: "colega.oficio@uaq.mx", area: area.name });
    const peer = await tokenFor(server, "colega.oficio@uaq.mx");
    assert.equal((await server.get(path, { token: workerToken })).status, 200);
    assert.equal((await server.get(path, { token: adminToken })).status, 200);
    assert.equal((await server.get(path, { token: peer })).status, 404);
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

    test("availability.read is enough, and opens nothing else (RF-USR-10)", async () => {
      await grantPermissions(server, adminToken, "worker", ["availability.read"]);
      try {
        const path = "/api/absences/availability?from=2026-06-15&to=2026-06-16";
        assert.equal((await server.get(path, { token: workerToken })).status, 200);
        assert.equal((await server.get("/api/absences", { token: workerToken })).status, 403);
        await grantPermissions(server, adminToken, "worker", []);
        assert.equal((await server.get(path, { token: workerToken })).status, 403);
      } finally {
        await grantPermissions(server, adminToken, "worker", ["absence.read", "absence.write"]);
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
      await createActive({ email: "colega.aus@uaq.mx", area: area.name });
      const peer = await tokenFor(server, "colega.aus@uaq.mx");
      const path = `/api/absences/${created.body.absence.eventId}`;
      const peerSees = async () =>
        (await server.get("/api/absences", { token: peer })).body.some((a) => a.eventId === created.body.absence.eventId);
      assert.equal(await peerSees(), false, "a request is not yet an absence");
      assert.equal((await server.get(path, { token: peer })).status, 404);
      assert.equal((await server.get(`${path}/history`, { token: peer })).status, 404);
      assert.equal((await server.get(path, { token: workerToken })).status, 200);
      assert.equal((await server.get(path, { token: leadToken })).status, 200, "decides on it");

      const byType = await server.get(`/api/absences?absenceTypeId=${pe.id}`, { token: leadToken });
      assert.deepEqual(byType.body, [], "the type filter would tell the type");
      const own = await server.get(`/api/absences?absenceTypeId=${pe.id}`, { token: workerToken });
      assert.deepEqual(own.body.map((a) => a.eventId), [created.body.absence.eventId]);
      assert.equal(own.body[0].typeLabel, pe.label);

      const balances = (token) => server.get(`/api/absences/balances/${workerUser.id}`, { token });
      assert.equal((await balances(leadToken)).status, 403);
      assert.equal((await balances(workerToken)).status, 200);
      assert.equal((await balances(adminToken)).status, 200);

      const decided = await server.post(`${path}/status`, { token: leadToken, body: { status: "approved" } });
      assert.equal(decided.status, 200);
      assert.equal(await peerSees(), true);
      assert.equal((await server.get(path, { token: peer })).body.absence.reason, null);

      const absence = list.body.find((a) => a.eventId === created.body.absence.eventId);
      assert.equal(absence.typeLabel, null);
      assert.equal(absence.typeCode, null);
      assert.equal(absence.absenceTypeId, null);
      assert.equal(absence.reason, null);
    });
  });
});
