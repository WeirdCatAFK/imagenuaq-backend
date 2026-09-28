import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  createSchema,
  tokenFor,
  logsFor,
  roleId,
  sql,
} from "./helpers/fixtures.js";

describe("/api/projects", () => {
  let server;
  let admin;
  let adminToken;
  let workerToken;
  let statusId;
  let area;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: ACCOUNTS[0], role: "admin" });
    await createActive({ email: ACCOUNTS[1], role: "worker" });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);

    [{ id: statusId }] = await sql(
      "select id from statuses where area_id is null and code = 'recibido'",
    );
  });

  after(async () => {
    await grantWorker([]);
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    area = await createArea("Diseño de prueba");
  });

  async function grantWorker(permissions) {
    const res = await server.put(`/api/roles/${await roleId("worker")}/permissions`, {
      token: adminToken,
      body: { permissions },
    });
    assert.equal(res.status, 200);
  }

  const create = (body, token = adminToken) => server.post("/api/projects", { token, body });

  describe("POST /", () => {
    test("generates the key when none is sent", async () => {
      const res = await create({ title: "Proyecto sin nombre" });

      assert.equal(res.status, 201);
      assert.match(res.body.project.key, /^PRY-\d{6}$/);
      assert.equal(res.body.project.statusCode, "recibido", "defaults to the global status");
      assert.equal(res.body.project.priority, 0);
      assert.equal(res.body.project.hasCost, false);
      assert.deepEqual(res.body.project.stages, []);
      assert.deepEqual(res.body.project.activeStageIds, []);
      assert.equal(res.body.project.createdBy, admin.id);
    });

    test("keeps a key the caller sends, uppercased", async () => {
      const res = await create({ title: "Papel FCQ", key: "papel-fcq-03" });

      assert.equal(res.status, 201);
      assert.equal(res.body.project.key, "PAPEL-FCQ-03");
    });

    test("refuses a malformed key and a missing title", async () => {
      const bad = await create({ title: "X", key: "con espacios" });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error.message, /key must start with/);

      assert.equal((await create({ key: "SIN-TITULO" })).status, 400);
    });

    test("refuses a duplicate key with 409", async () => {
      assert.equal((await create({ title: "Primero", key: "UNICO" })).status, 201);

      const again = await create({ title: "Segundo", key: "UNICO" });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.message, "A project with that key already exists.");
    });

    test("creates stages, starting the lowest seq", async () => {
      const other = await createArea("Impresión de prueba");
      const res = await create({
        title: "Con etapas",
        requester: "Facultad de Química",
        stages: [
          { areaId: other.id, title: "Impresión", seq: 2 },
          { areaId: area.id, title: "Diseño", seq: 1 },
        ],
      });

      assert.equal(res.status, 201);
      const { stages, activeStageIds } = res.body.project;
      assert.deepEqual(stages.map((s) => s.title), ["Diseño", "Impresión"]);
      assert.equal(stages[0].status, "active");
      assert.ok(stages[0].startedAt, "an active stage is stamped");
      assert.equal(stages[1].status, "pending");
      assert.equal(stages[1].startedAt, null);
      assert.deepEqual(activeStageIds, [stages[0].id]);
      assert.equal(stages[0].attempt, 1);

      const logs = await logsFor("project_stages", stages[0].id);
      assert.deepEqual(logs.map((l) => l.action), ["stage_activated"]);
    });

    test("seeds field values and drops the empty ones", async () => {
      const res = await create({
        title: "Con valores",
        fieldValues: [
          { key: "tiraje", value: 500 },
          { key: "con_costo", value: true },
          { key: "pantone", value: "  " },
          { key: "nota", value: null },
        ],
      });

      assert.equal(res.status, 201);
      assert.deepEqual(
        res.body.project.fieldValues.map((v) => [v.key, v.value]),
        [["con_costo", "true"], ["tiraje", "500"]],
      );
      assert.equal(res.body.project.fieldValues[0].producedByStageId, null);
    });

    test("refuses a repeated or malformed field key", async () => {
      const repeated = await create({
        title: "X",
        fieldValues: [{ key: "tiraje", value: 1 }, { key: "tiraje", value: 2 }],
      });
      assert.equal(repeated.status, 400);
      assert.match(repeated.body.error.message, /repeated/);

      const bad = await create({ title: "X", fieldValues: [{ key: "Tiraje", value: 1 }] });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error.message, /snake_case/);
    });

    test("links the requests it converts, and refuses one already converted", async () => {
      const schema = await createSchema("solicitudes");
      const rows = await sql(
        `insert into requests (schema_version_id, title, status_id, requester)
         values ($1,'Solicitud A',$2,'FCQ'), ($1,'Solicitud B',$2,'FCQ') returning id`,
        [schema.schema_version_id, statusId],
      );
      const ids = rows.map((r) => r.id);

      const first = await create({ title: "De dos solicitudes", requestIds: ids });
      assert.equal(first.status, 201);
      assert.deepEqual(first.body.project.requests.map((r) => r.title), ["Solicitud A", "Solicitud B"]);
      assert.equal(first.body.project.requestCount, undefined, "only the list read counts them");

      const stolen = await create({ title: "Robo", requestIds: ids });
      assert.equal(stolen.status, 409);

      // The refused call leaves nothing behind.
      const [{ n }] = await sql("select count(*)::int as n from projects where deleted_at is null");
      assert.equal(n, 1);
    });

    test("refuses an unknown area, status or schema version as a 400", async () => {
      const area404 = await create({ title: "X", stages: [{ areaId: 999999, title: "Etapa" }] });
      assert.equal(area404.status, 400);

      const status404 = await create({ title: "X", statusId: 999999 });
      assert.equal(status404.status, 400);
      assert.equal(status404.body.error.message, "That status does not exist.");
    });

    test("refuses an area status when no stage belongs to that area", async () => {
      const made = await server.post("/api/statuses", {
        token: adminToken,
        body: { areaId: area.id, code: "en_prensa", label: "En prensa" },
      });
      assert.equal(made.status, 201);

      const wrong = await create({ title: "Sin la etapa", statusId: made.body.status.id });
      assert.equal(wrong.status, 400);
      assert.match(wrong.body.error.message, /no stage in this project/);

      const right = await create({
        title: "Con la etapa",
        statusId: made.body.status.id,
        stages: [{ areaId: area.id, title: "Diseño" }],
      });
      assert.equal(right.status, 201);
    });

    test("refuses dueOn before startsOn", async () => {
      const res = await create({ title: "X", startsOn: "2026-05-10", dueOn: "2026-05-01" });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /dueOn/);
    });

    test("needs project.write", async () => {
      assert.equal((await create({ title: "X" }, workerToken)).status, 403);
    });
  });

  describe("GET /", () => {
    async function seed() {
      const withCost = await create({
        title: "Con costo",
        key: "CON-COSTO",
        requester: "Facultad de Química",
        hasCost: true,
        priority: 5,
        stages: [{ areaId: area.id, title: "Diseño" }],
        fieldValues: [{ key: "numero_orden", value: "A-77" }],
      });
      const plain = await create({ title: "Sin costo", key: "SIN-COSTO", requester: "Rectoría" });
      assert.equal(withCost.status, 201);
      assert.equal(plain.status, 201);
      return { withCost: withCost.body.project, plain: plain.body.project };
    }

    test("lists open projects, most urgent first, with counts", async () => {
      const { withCost } = await seed();

      const res = await server.get("/api/projects", { token: adminToken });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.projects.map((p) => p.key), ["CON-COSTO", "SIN-COSTO"]);

      const first = res.body.projects[0];
      assert.equal(first.id, withCost.id);
      assert.equal(first.openStageCount, 1);
      assert.equal(first.requestCount, 0);
      assert.equal(first.statusLabel, "Recibido");
    });

    test("filters by requester, area, cost and produced value", async () => {
      await seed();
      const get = async (qs) => (await server.get(`/api/projects?${qs}`, { token: adminToken })).body.projects;

      assert.deepEqual((await get("requester=facultad de química")).map((p) => p.key), ["CON-COSTO"]);
      assert.deepEqual((await get(`areaId=${area.id}`)).map((p) => p.key), ["CON-COSTO"]);
      assert.deepEqual((await get("hasCost=true")).map((p) => p.key), ["CON-COSTO"]);
      assert.deepEqual((await get("hasCost=false")).map((p) => p.key), ["SIN-COSTO"]);
      assert.deepEqual((await get("q=sin")).map((p) => p.key), ["SIN-COSTO"]);
      assert.deepEqual((await get("q=CON-")).map((p) => p.key), ["CON-COSTO"]);
      // RF-IMP-08: find the project by the order number a stage produced.
      assert.deepEqual((await get("fieldKey=numero_orden&fieldValue=A-77")).map((p) => p.key), ["CON-COSTO"]);
      assert.deepEqual(await get("fieldKey=numero_orden&fieldValue=B-00"), []);
    });

    test("state moves projects between the lists", async () => {
      const { plain } = await seed();
      assert.equal((await server.post(`/api/projects/${plain.id}/close`, { token: adminToken })).status, 200);

      const open = await server.get("/api/projects", { token: adminToken });
      assert.deepEqual(open.body.projects.map((p) => p.key), ["CON-COSTO"]);

      const closed = await server.get("/api/projects?state=closed", { token: adminToken });
      assert.deepEqual(closed.body.projects.map((p) => p.key), ["SIN-COSTO"]);
      assert.equal((await server.get("/api/projects?state=all", { token: adminToken })).body.projects.length, 2);
    });

    test("refuses an unknown state and an out-of-range limit", async () => {
      assert.equal((await server.get("/api/projects?state=todos", { token: adminToken })).status, 400);
      assert.equal((await server.get("/api/projects?limit=500", { token: adminToken })).status, 400);
    });

    test("reads need project.read", async () => {
      assert.equal((await server.get("/api/projects", { token: workerToken })).status, 403);
      await grantWorker(["project.read"]);
      try {
        assert.equal((await server.get("/api/projects", { token: workerToken })).status, 200);
      } finally {
        await grantWorker([]);
      }
    });
  });

  describe("PATCH, status, close, archive, delete", () => {
    async function project(body = {}) {
      const res = await create({ title: "Editable", ...body });
      assert.equal(res.status, 201);
      return res.body.project;
    }

    test("merges only the keys sent", async () => {
      const made = await project({ hasCost: true, requester: "Rectoría" });

      const res = await server.patch(`/api/projects/${made.id}`, {
        token: adminToken,
        body: { title: "Renombrado", priority: 9 },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.project.title, "Renombrado");
      assert.equal(res.body.project.priority, 9);
      assert.equal(res.body.project.hasCost, true, "untouched");
      assert.equal(res.body.project.requester, "Rectoría", "untouched");

      const logs = await logsFor("projects", made.id);
      assert.deepEqual(logs.map((l) => l.action), ["record_created", "record_updated"]);
    });

    test("refuses an empty patch and 404s on a missing project", async () => {
      const made = await project();
      assert.equal((await server.patch(`/api/projects/${made.id}`, { token: adminToken, body: {} })).status, 400);
      assert.equal((await server.patch("/api/projects/999999", { token: adminToken, body: { title: "X" } })).status, 404);
      assert.equal((await server.get("/api/projects/999999", { token: adminToken })).status, 404);
    });

    test("status moves status_since and writes status_changed", async () => {
      const made = await project();
      const [target] = await sql("select id from statuses where area_id is null and code = 'en_proceso'");

      const res = await server.put(`/api/projects/${made.id}/status`, {
        token: adminToken,
        body: { statusId: target.id },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.project.statusCode, "en_proceso");
      assert.ok(
        new Date(res.body.project.statusSince) > new Date(made.statusSince),
        "status_since moved with the status",
      );

      const logs = await logsFor("projects", made.id);
      assert.ok(logs.some((l) => l.action === "status_changed"));
    });

    test("refuses an inactive status", async () => {
      const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
      const created = await server.post("/api/statuses", {
        token: adminToken,
        body: { areaId: area.id, code: "en_prensa", label: "En prensa" },
      });
      await server.delete(`/api/statuses/${created.body.status.id}`, { token: adminToken });

      const res = await server.put(`/api/projects/${made.id}/status`, {
        token: adminToken,
        body: { statusId: created.body.status.id },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /inactive/);
    });

    test("close is refused while a stage is open, and allowed once it is not", async () => {
      const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });

      const refused = await server.post(`/api/projects/${made.id}/close`, { token: adminToken });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error.message, /stage\(s\) still open/);

      assert.equal(
        (await server.patch(`/api/projects/${made.id}/stages/${made.stages[0].id}`, {
          token: adminToken,
          body: { status: "cancelled" },
        })).status,
        200,
      );

      const closed = await server.post(`/api/projects/${made.id}/close`, { token: adminToken });
      assert.equal(closed.status, 200);
      assert.ok(closed.body.project.closedAt);
      assert.equal((await server.post(`/api/projects/${made.id}/close`, { token: adminToken })).status, 409);
    });

    test("a blocked stage also blocks closing", async () => {
      const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
      await server.patch(`/api/projects/${made.id}/stages/${made.stages[0].id}`, {
        token: adminToken,
        body: { status: "waiting_external", blockedReason: "Falta el material" },
      });

      assert.equal((await server.post(`/api/projects/${made.id}/close`, { token: adminToken })).status, 409);
    });

    test("archive is its own act", async () => {
      const made = await project();
      const res = await server.post(`/api/projects/${made.id}/archive`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.ok(res.body.project.archivedAt);
      assert.equal(res.body.project.closedAt, null);
      assert.equal((await server.post(`/api/projects/${made.id}/archive`, { token: adminToken })).status, 409);
    });

    test("delete hides it everywhere", async () => {
      const made = await project();
      const res = await server.delete(`/api/projects/${made.id}`, { token: adminToken });

      assert.equal(res.status, 200);
      assert.equal((await server.get(`/api/projects/${made.id}`, { token: adminToken })).status, 404);
      assert.equal((await server.get("/api/projects?state=all", { token: adminToken })).body.projects.length, 0);

      const logs = await logsFor("projects", made.id);
      assert.ok(logs.some((l) => l.action === "record_deleted"));
    });

    test("POST /:id/requests links later and refuses a converted one", async () => {
      const made = await project();
      const schema = await createSchema("mas_solicitudes");
      const [row] = await sql(
        `insert into requests (schema_version_id, title, status_id) values ($1,'Tardía',$2) returning id`,
        [schema.schema_version_id, statusId],
      );

      await grantWorker(["project.read", "project.write"]);
      try {
        const noWrite = await server.post(`/api/projects/${made.id}/requests`, {
          token: workerToken,
          body: { requestIds: [row.id] },
        });
        assert.equal(noWrite.status, 403, "needs request.write too");
      } finally {
        await grantWorker([]);
      }

      const res = await server.post(`/api/projects/${made.id}/requests`, {
        token: adminToken,
        body: { requestIds: [row.id] },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.project.requests.map((r) => r.title), ["Tardía"]);

      const logs = await logsFor("requests", row.id);
      assert.deepEqual(logs.map((l) => l.action), ["request_converted"]);

      const again = await server.post(`/api/projects/${made.id}/requests`, {
        token: adminToken,
        body: { requestIds: [row.id] },
      });
      assert.equal(again.status, 409);
      assert.equal((await server.post(`/api/projects/${made.id}/requests`, { token: adminToken, body: { requestIds: [] } })).status, 400);
    });
  });
});
