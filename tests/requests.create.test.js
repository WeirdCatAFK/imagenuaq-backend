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
  TEST_SCHEMA_PREFIX,
} from "./helpers/fixtures.js";

// Capture and edit (RF-SOL-03, RF-SOL-06, RF-SOL-08). The coercion itself is covered by
// fieldValues.test.js; here it is the API's use of it.
describe("/api/requests", () => {
  let server;
  let admin;
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
      { code: "contacto_correo", name: "Correo del contacto", type: "email" },
      { code: "urgente", name: "Urgente", type: "boolean" },
    ],
  };

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: ACCOUNTS[0], role: "admin" });
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

  const create = (body, token = adminToken) => server.post("/api/requests", { token, body });

  const VALID = {
    title: "Papel membretado para la facultad",
    requester: "Facultad de Química",
    data: {
      descripcion: "  Hojas membretadas ",
      tiraje: "1,000",
      fecha_entrega: "15/03/2026",
      contacto_correo: "ALMA@UAQ.MX",
      urgente: "sí",
    },
  };

  describe("POST /", () => {
    test("captures the request, coerces every value and takes a folio from the sequence", async () => {
      const res = await create({ ...VALID, schemaId: schema.id, areaId: area.id });

      assert.equal(res.status, 201);
      const { request } = res.body;
      assert.match(request.folio, /^SOL-\d{6}$/);
      assert.equal(request.statusCode, "recibido");
      assert.equal(request.source, "manual");
      assert.equal(request.projectId, null);
      assert.equal(request.createdBy, admin.id);
      assert.equal(request.schemaCode, `${TEST_SCHEMA_PREFIX}papel`);

      assert.deepEqual(request.data, {
        descripcion: "Hojas membretadas",
        tiraje: 1000,
        fecha_entrega: "2026-03-15",
        contacto_correo: "alma@uaq.mx",
        urgente: true,
      });

      // The read carries the format's fields, so a screen can render the capture.
      assert.deepEqual(Object.keys(request.fields), ["deliverables", "information"]);

      const logs = await logsFor("requests", request.id);
      assert.deepEqual(logs.map((l) => l.action), ["record_created"]);
    });

    test("two requests never share a folio", async () => {
      const first = await create({ ...VALID, schemaId: schema.id });
      const second = await create({ ...VALID, schemaId: schema.id });

      assert.notEqual(first.body.request.folio, second.body.request.folio);
    });

    test("a required field missing is a 400 naming it", async () => {
      const res = await create({
        title: "Sin tiraje",
        schemaId: schema.id,
        data: { descripcion: "Algo" },
      });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /"Tiraje" is required/);
    });

    test("every complaint comes back at once", async () => {
      const res = await create({
        title: "Con dos errores",
        schemaId: schema.id,
        data: { tiraje: "muchos", contacto_correo: "no-es-correo" },
      });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /"Descripción" is required/);
      assert.match(res.body.error.message, /"Tiraje" is not a number/);
      assert.match(res.body.error.message, /"Correo del contacto" is not a valid email/);
    });

    test("an unknown key is kept and reported as a warning (RF-SOL-06)", async () => {
      const res = await create({
        title: "Con columna vieja",
        schemaId: schema.id,
        data: { descripcion: "X", tiraje: 1, columna_vieja: "lo que sea" },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.request.data.columna_vieja, "lo que sea");
      assert.deepEqual(res.body.request.warnings.map((w) => w.key), ["columna_vieja"]);
    });

    test("schemaVersionId pins the version; schemaId follows the latest", async () => {
      const v2 = await server.post(`/api/schemas/${schema.id}/versions`, {
        token: adminToken,
        body: {
          fields: { deliverables: [{ code: "nota", name: "Nota", type: "text" }], information: [] },
        },
      });
      assert.equal(v2.status, 201);

      const latest = await create({ title: "Sigue la última", schemaId: schema.id, data: { nota: "hola" } });
      assert.equal(latest.status, 201);
      assert.equal(latest.body.request.schemaVersion, 2);

      const pinned = await create({
        title: "Fijada a la v1",
        schemaVersionId: schema.schema_version_id,
        data: { descripcion: "X", tiraje: 1 },
      });
      assert.equal(pinned.status, 201);
      assert.equal(pinned.body.request.schemaVersion, 1);
    });

    test("refuses source sheet, an inactive format and a missing format", async () => {
      const asSheet = await create({ ...VALID, schemaId: schema.id, source: "sheet" });
      assert.equal(asSheet.status, 400);
      assert.match(asSheet.body.error.message, /created by the import/);

      assert.equal((await create({ ...VALID, schemaId: 999999 })).status, 404);
      assert.equal((await create({ ...VALID })).status, 400, "neither schemaId nor schemaVersionId");

      assert.equal((await server.delete(`/api/schemas/${schema.id}`, { token: adminToken })).status, 200);
      const inactive = await create({ ...VALID, schemaId: schema.id });
      assert.equal(inactive.status, 400);
      assert.match(inactive.body.error.message, /inactive/);
    });

    test("email and form are accepted sources", async () => {
      for (const source of ["email", "form"]) {
        const res = await create({ ...VALID, schemaId: schema.id, source });
        assert.equal(res.status, 201);
        assert.equal(res.body.request.source, source);
      }
    });

    test("needs request.write", async () => {
      assert.equal((await create({ ...VALID, schemaId: schema.id }, workerToken)).status, 403);
    });
  });

  describe("PATCH /:id, status and DELETE", () => {
    async function request(body = {}) {
      const res = await create({ ...VALID, schemaId: schema.id, areaId: area.id, ...body });
      assert.equal(res.status, 201);
      return res.body.request;
    }

    test("edits the title and re-coerces a new capture", async () => {
      const made = await request();

      const res = await server.patch(`/api/requests/${made.id}`, {
        token: adminToken,
        body: { title: "Otro título", data: { descripcion: "Nuevo", tiraje: "2,500" } },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.request.title, "Otro título");
      assert.equal(res.body.request.data.tiraje, 2500);
      assert.ok(!("fecha_entrega" in res.body.request.data), "data is replaced whole");
    });

    test("a bad value in a patch is refused and nothing changes", async () => {
      const made = await request();

      const res = await server.patch(`/api/requests/${made.id}`, {
        token: adminToken,
        body: { data: { descripcion: "X", tiraje: "muchos" } },
      });
      assert.equal(res.status, 400);

      const read = await server.get(`/api/requests/${made.id}`, { token: adminToken });
      assert.equal(read.body.request.data.tiraje, 1000);
    });

    test("refuses an empty patch and 404s on a missing request", async () => {
      const made = await request();
      assert.equal((await server.patch(`/api/requests/${made.id}`, { token: adminToken, body: {} })).status, 400);
      assert.equal((await server.patch("/api/requests/999999", { token: adminToken, body: { title: "X" } })).status, 404);
      assert.equal((await server.get("/api/requests/999999", { token: adminToken })).status, 404);
    });

    test("status moves status_since and a rejected request stops sitting in the inbox", async () => {
      const made = await request();
      const [rejected] = await sql("select id from statuses where area_id is null and code = 'rechazada'");

      const res = await server.put(`/api/requests/${made.id}/status`, {
        token: adminToken,
        body: { statusId: rejected.id },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.request.statusCode, "rechazada");
      assert.equal(res.body.request.statusIsTerminal, true);
      assert.ok(new Date(res.body.request.statusSince) > new Date(made.statusSince));

      const logs = await logsFor("requests", made.id);
      assert.ok(logs.some((l) => l.action === "status_changed"));
    });

    test("refuses a status of another area", async () => {
      const other = await createArea("Impresión de prueba");
      const made = await request();
      const created = await server.post("/api/statuses", {
        token: adminToken,
        body: { areaId: other.id, code: "en_prensa", label: "En prensa" },
      });

      const res = await server.put(`/api/requests/${made.id}/status`, {
        token: adminToken,
        body: { statusId: created.body.status.id },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /another area/);
    });

    test("delete hides it from the inbox", async () => {
      const made = await request();
      assert.equal((await server.delete(`/api/requests/${made.id}`, { token: adminToken })).status, 200);

      assert.equal((await server.get(`/api/requests/${made.id}`, { token: adminToken })).status, 404);
      assert.equal((await server.get("/api/requests", { token: adminToken })).body.requests.length, 0);
    });
  });
});
