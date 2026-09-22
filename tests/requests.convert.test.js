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
} from "./helpers/fixtures.js";

// The one crossing from request to project (RF-PRY-01, RF-FLW-06).
describe("POST /api/requests/:id/convert", () => {
  let server;
  let adminToken;
  let workerToken;
  let schema;
  let area;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  const FIELDS = {
    deliverables: [
      { code: "descripcion", name: "Descripción", type: "text", required: true },
      { code: "tiraje", name: "Tiraje", type: "quantity", required: true },
      { code: "fecha_entrega", name: "Fecha de entrega", type: "date" },
    ],
    information: [
      { code: "numero_orden", name: "Número de orden", type: "text" },
      { code: "urgente", name: "Urgente", type: "boolean" },
    ],
  };

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: "admin" });
    await createActive({ email: ACCOUNTS[1], role: "worker" });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
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
    schema = await createSchema("papel", FIELDS);
  });

  async function grantWorker(permissions) {
    const res = await server.put(`/api/roles/${await roleId("worker")}/permissions`, {
      token: adminToken,
      body: { permissions },
    });
    assert.equal(res.status, 200);
  }

  async function request(overrides = {}) {
    const res = await server.post("/api/requests", {
      token: adminToken,
      body: {
        schemaId: schema.id,
        title: "Papel membretado",
        requester: "Facultad de Química",
        areaId: area.id,
        priority: 3,
        data: { descripcion: "Hojas", tiraje: 1000, fecha_entrega: "2026-03-15", urgente: true },
        ...overrides,
      },
    });
    assert.equal(res.status, 201);
    return res.body.request;
  }

  const convert = (id, body = {}, token = adminToken) =>
    server.post(`/api/requests/${id}/convert`, { token, body });

  test("carries the requester, the title, the priority and every captured value", async () => {
    const made = await request();

    const res = await convert(made.id);

    assert.equal(res.status, 201);
    const { project, conflicts } = res.body;
    assert.match(project.key, /^PRY-\d{6}$/, "the key is generated, not demanded");
    assert.equal(project.title, "Papel membretado");
    assert.equal(project.requester, "Facultad de Química");
    assert.equal(project.priority, 3);
    assert.equal(String(project.schemaVersionId), String(made.schemaVersionId));
    assert.deepEqual(conflicts, []);

    // Every value travels, keyed by its field code, stringified, with no stage behind it.
    assert.deepEqual(
      project.fieldValues.map((v) => [v.key, v.value]),
      [["descripcion", "Hojas"], ["fecha_entrega", "2026-03-15"], ["tiraje", "1000"], ["urgente", "true"]],
    );
    assert.ok(project.fieldValues.every((v) => v.producedByStageId === null));

    // The link, both ways.
    assert.deepEqual(project.requests.map((r) => r.folio), [made.folio]);
    const read = await server.get(`/api/requests/${made.id}`, { token: adminToken });
    assert.equal(String(read.body.request.projectId), String(project.id));
    assert.equal(read.body.request.projectKey, project.key);

    const logs = await logsFor("requests", made.id);
    assert.deepEqual(logs.map((l) => l.action), ["record_created", "request_converted"]);
  });

  test("empty values do not become field values", async () => {
    const made = await request({
      data: { descripcion: "Hojas", tiraje: 1000 },
    });

    const res = await convert(made.id);
    assert.deepEqual(
      res.body.project.fieldValues.map((v) => v.key),
      ["descripcion", "tiraje"],
      "fecha_entrega and urgente were never captured, so they are absent",
    );
  });

  test("the conversion may override the key, title and requester", async () => {
    const made = await request();

    const res = await convert(made.id, {
      key: "papel-fcq-03",
      title: "Papel institucional FCQ",
      requester: "Facultad de Química (FCQ)",
      hasCost: true,
      dueOn: "2026-04-01",
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.project.key, "PAPEL-FCQ-03");
    assert.equal(res.body.project.title, "Papel institucional FCQ");
    assert.equal(res.body.project.requester, "Facultad de Química (FCQ)");
    assert.equal(res.body.project.hasCost, true);
    assert.equal(res.body.project.dueOn, "2026-04-01");

    // The request keeps its own requester: the correction applies to the project.
    const read = await server.get(`/api/requests/${made.id}`, { token: adminToken });
    assert.equal(read.body.request.requester, "Facultad de Química");
  });

  test("the conversion may open the first stages", async () => {
    const made = await request();
    const other = await createArea("Impresión de prueba");

    const res = await convert(made.id, {
      stages: [
        { areaId: area.id, title: "Diseño", seq: 1 },
        { areaId: other.id, title: "Impresión", seq: 2 },
      ],
    });

    assert.equal(res.status, 201);
    assert.deepEqual(res.body.project.stages.map((s) => [s.title, s.status]), [
      ["Diseño", "active"],
      ["Impresión", "pending"],
    ]);
    assert.equal(res.body.project.activeStageIds.length, 1);
  });

  test("several requests become one project (RF-PRY-01)", async () => {
    const first = await request({ title: "Hojas" });
    const second = await request({ title: "Sobres", data: { descripcion: "Sobres", tiraje: 200 } });

    const res = await convert(first.id, { requestIds: [second.id], title: "Papelería completa" });

    assert.equal(res.status, 201);
    assert.deepEqual(
      res.body.project.requests.map((r) => r.title).sort(),
      ["Hojas", "Sobres"],
    );

    for (const id of [first.id, second.id]) {
      const read = await server.get(`/api/requests/${id}`, { token: adminToken });
      assert.equal(String(read.body.request.projectId), String(res.body.project.id));
      assert.ok((await logsFor("requests", id)).some((l) => l.action === "request_converted"));
    }
  });

  test("on a repeated key the first request wins and the rest are reported", async () => {
    const first = await request({ title: "Hojas", data: { descripcion: "Hojas", tiraje: 1000 } });
    const second = await request({ title: "Sobres", data: { descripcion: "Sobres", tiraje: 200 } });

    const res = await convert(first.id, { requestIds: [second.id] });

    assert.equal(res.status, 201);
    const values = Object.fromEntries(res.body.project.fieldValues.map((v) => [v.key, v.value]));
    assert.equal(values.descripcion, "Hojas", "the first request wins");
    assert.equal(values.tiraje, "1000");

    assert.deepEqual(
      res.body.conflicts.map((c) => [c.key, c.kept, c.discarded]).sort(),
      [["descripcion", "Hojas", "Sobres"], ["tiraje", "1000", "200"]],
    );
    assert.equal(res.body.conflicts[0].folio, second.folio);
  });

  test("converting twice is a 409, and so is stealing a converted request", async () => {
    const made = await request();
    assert.equal((await convert(made.id)).status, 201);

    const again = await convert(made.id);
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /already belongs to a project/);

    const other = await request({ title: "Otra" });
    const stealing = await convert(other.id, { requestIds: [made.id] });
    assert.equal(stealing.status, 409);
    assert.match(stealing.body.error.message, new RegExp(made.folio));

    // The refused call created nothing.
    const projects = await server.get("/api/projects?state=all", { token: adminToken });
    assert.equal(projects.body.projects.length, 1);
  });

  test("an unknown request in the list is a 400", async () => {
    const made = await request();
    const res = await convert(made.id, { requestIds: [999999] });

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /999999 does not exist/);
  });

  test("the same id in the list twice is not a conflict with itself", async () => {
    const made = await request();
    const res = await convert(made.id, { requestIds: [made.id] });

    assert.equal(res.status, 201);
    assert.equal(res.body.project.requests.length, 1);
  });

  test("a converted request refuses edits but still takes a requester correction", async () => {
    const made = await request();
    assert.equal((await convert(made.id)).status, 201);

    const edit = await server.patch(`/api/requests/${made.id}`, {
      token: adminToken,
      body: { title: "Otro" },
    });
    assert.equal(edit.status, 409);

    const fix = await server.patch(`/api/requests/${made.id}`, {
      token: adminToken,
      body: { requester: "Facultad de Química (FCQ)" },
    });
    assert.equal(fix.status, 200, "a misspelled requester can be corrected wherever it is noticed");

    assert.equal((await server.delete(`/api/requests/${made.id}`, { token: adminToken })).status, 409);
  });

  test("the inbox stops showing it once converted", async () => {
    const made = await request();
    await convert(made.id);

    const unconverted = await server.get("/api/requests?converted=false", { token: adminToken });
    assert.deepEqual(unconverted.body.requests, []);

    const converted = await server.get("/api/requests?converted=true", { token: adminToken });
    assert.deepEqual(converted.body.requests.map((r) => r.folio), [made.folio]);
  });

  test("needs project.write as well as request.write", async () => {
    const made = await request();

    await grantWorker(["request.read", "request.write"]);
    try {
      const res = await convert(made.id, {}, workerToken);
      assert.equal(res.status, 403);
    } finally {
      await grantWorker([]);
    }
  });
});
