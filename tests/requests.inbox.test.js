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
  roleId,
  sql,
} from "./helpers/fixtures.js";

// The inbox RF-SOL-04 asks for -- ordered and filterable, so nobody reads four channels to find
// their work -- and the search of RF-SOL-05.
describe("GET /api/requests", () => {
  let server;
  let worker;
  let adminToken;
  let workerToken;
  let schema;
  let otherSchema;
  let design;
  let print;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: "admin" });
    worker = await createActive({ email: ACCOUNTS[1], role: "worker" });

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
    design = await createArea("Diseño de prueba");
    print = await createArea("Impresión de prueba");
    schema = await createSchema("papel", {
      deliverables: [{ code: "descripcion", name: "Descripción", type: "text", required: true }],
      information: [],
    });
    otherSchema = await createSchema("fotos", {
      deliverables: [{ code: "evento", name: "Evento", type: "text", required: true }],
      information: [],
    });
  });

  async function grantWorker(permissions) {
    const res = await server.put(`/api/roles/${await roleId("worker")}/permissions`, {
      token: adminToken,
      body: { permissions },
    });
    assert.equal(res.status, 200);
  }

  async function add(body) {
    const res = await server.post("/api/requests", {
      token: adminToken,
      body: { schemaId: schema.id, data: { descripcion: "Algo" }, ...body },
    });
    assert.equal(res.status, 201);
    return res.body.request;
  }

  const list = async (qs = "") =>
    (await server.get(`/api/requests${qs}`, { token: adminToken })).body.requests;

  async function seed() {
    const urgent = await add({
      title: "Carteles urgentes",
      requester: "Facultad de Química",
      areaId: design.id,
      priority: 9,
      assigneeId: worker.id,
    });
    const normal = await add({
      title: "Hojas membretadas",
      requester: "Rectoría",
      areaId: design.id,
      priority: 0,
    });
    const printed = await add({
      title: "Lonas",
      requester: "Facultad de Química",
      areaId: print.id,
      source: "email",
    });
    const photos = await server.post("/api/requests", {
      token: adminToken,
      body: {
        schemaId: otherSchema.id,
        title: "Fotografía del congreso",
        data: { evento: "Congreso" },
        areaId: design.id,
      },
    });
    assert.equal(photos.status, 201);
    return { urgent, normal, printed, photos: photos.body.request };
  }

  test("orders by priority, then newest first", async () => {
    const { urgent } = await seed();
    const rows = await list();

    assert.equal(rows.length, 4);
    assert.equal(rows[0].folio, urgent.folio, "priority 9 leads");
    // The rest share priority 0, so the newest of them comes next.
    assert.deepEqual(rows.slice(1).map((r) => r.title), ["Fotografía del congreso", "Lonas", "Hojas membretadas"]);
  });

  test("sort=created ignores priority", async () => {
    await seed();
    const rows = await list("?sort=created");
    assert.equal(rows[0].title, "Fotografía del congreso");
  });

  test("filters by area, assignee, requester, format and source", async () => {
    await seed();

    assert.deepEqual((await list(`?areaId=${print.id}`)).map((r) => r.title), ["Lonas"]);
    assert.deepEqual((await list(`?assigneeId=${worker.id}`)).map((r) => r.title), ["Carteles urgentes"]);
    assert.deepEqual(
      (await list("?requester=facultad de química")).map((r) => r.title).sort(),
      ["Carteles urgentes", "Lonas"],
    );
    assert.deepEqual((await list(`?schemaId=${otherSchema.id}`)).map((r) => r.title), ["Fotografía del congreso"]);
    assert.deepEqual((await list("?source=email")).map((r) => r.title), ["Lonas"]);
  });

  test("searches by title fragment and folio prefix (RF-SOL-05)", async () => {
    const { normal } = await seed();

    assert.deepEqual((await list("?q=membret")).map((r) => r.title), ["Hojas membretadas"]);
    assert.deepEqual((await list(`?q=${normal.folio}`)).map((r) => r.folio), [normal.folio]);
    assert.deepEqual((await list("?q=SOL-")).length, 4, "the prefix matches every folio");
    assert.deepEqual(await list("?q=nada de esto"), []);
  });

  test("filters by status, and a rejected request leaves the working inbox", async () => {
    const { normal } = await seed();
    const [rejected] = await sql("select id from statuses where area_id is null and code = 'rechazada'");

    await server.put(`/api/requests/${normal.id}/status`, {
      token: adminToken,
      body: { statusId: rejected.id },
    });

    assert.deepEqual((await list(`?statusId=${rejected.id}`)).map((r) => r.title), ["Hojas membretadas"]);
    assert.equal((await list()).length, 4, "it is still there until somebody filters it out");
  });

  test("converted=false is the working inbox", async () => {
    const { urgent } = await seed();
    assert.equal(
      (await server.post(`/api/requests/${urgent.id}/convert`, { token: adminToken, body: {} })).status,
      201,
    );

    assert.equal((await list()).length, 4, "omitted means everything");
    assert.equal((await list("?converted=false")).length, 3);
    assert.deepEqual((await list("?converted=true")).map((r) => r.folio), [urgent.folio]);
  });

  test("duplicates=true finds only the flagged rows", async () => {
    const { urgent, normal } = await seed();
    // The import sets this; here it is set directly, since the import is a later increment.
    await sql("update requests set possible_duplicate_of = $2 where id = $1", [normal.id, urgent.id]);

    assert.deepEqual((await list("?duplicates=true")).map((r) => r.title), ["Hojas membretadas"]);
    assert.equal((await list("?duplicates=false")).length, 3);

    const read = await server.get(`/api/requests/${normal.id}`, { token: adminToken });
    assert.equal(read.body.request.duplicateOfFolio, urgent.folio, "the read names what it duplicates");
  });

  test("the list carries what a board needs without a second read", async () => {
    const { urgent } = await seed();
    const row = (await list()).find((r) => r.folio === urgent.folio);

    assert.equal(row.areaName, design.name);
    assert.equal(row.assigneeName, worker.full_name);
    assert.equal(row.statusLabel, "Recibido");
    assert.ok(row.schemaName);
    assert.equal(row.projectKey, null);
  });

  test("limit and offset page it", async () => {
    await seed();

    assert.equal((await list("?limit=2")).length, 2);
    assert.equal((await list("?limit=2&offset=3")).length, 1);
    assert.equal((await server.get("/api/requests?limit=0", { token: adminToken })).status, 400);
    assert.equal((await server.get("/api/requests?offset=-1", { token: adminToken })).status, 400);
    assert.equal((await server.get("/api/requests?source=telepatía", { token: adminToken })).status, 400);
    assert.equal((await server.get("/api/requests?converted=quizá", { token: adminToken })).status, 400);
  });

  test("reads need request.read", async () => {
    assert.equal((await server.get("/api/requests", { token: workerToken })).status, 403);
    assert.equal((await server.get("/api/requests")).status, 401);

    await grantWorker(["request.read"]);
    try {
      assert.equal((await server.get("/api/requests", { token: workerToken })).status, 200);
    } finally {
      await grantWorker([]);
    }
  });
});
