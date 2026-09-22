import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createSchema,
  tokenFor,
  roleId,
  sql,
} from "./helpers/fixtures.js";

// The requesting party is a string (RF-SOL-07); this is the autocomplete that keeps it from
// becoming four spellings of one faculty. Rows are inserted directly: /api/requests does
// not exist yet.
describe("GET /api/requesters", () => {
  let server;
  let statusId;
  let schemaVersionId;
  let adminToken;
  let workerToken;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: "admin" });
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
    const schema = await createSchema("solicitudes");
    schemaVersionId = schema.schema_version_id;
  });

  async function grantWorker(permissions) {
    const res = await server.put(
      `/api/roles/${await roleId("worker")}/permissions`,
      { token: adminToken, body: { permissions } },
    );
    assert.equal(res.status, 200);
  }

  async function addRequest(requester, title = "Trabajo") {
    await sql(
      `insert into requests (schema_version_id, title, status_id, requester)
       values ($1, $2, $3, $4)`,
      [schemaVersionId, title, statusId, requester],
    );
  }

  async function addProject(requester, key) {
    await sql(
      "insert into projects (key, title, status_id, requester) values ($1, $2, $3, $4)",
      [key, "Proyecto", statusId, requester],
    );
  }

  test("collects the strings from requests and projects, most used first", async () => {
    await addRequest("Facultad de Química");
    await addRequest("Facultad de Química");
    await addRequest("Rectoría");
    await addProject("Facultad de Derecho", "DER-1");

    const res = await server.get("/api/requesters", { token: adminToken });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.requesters, [
      { name: "Facultad de Química", uses: 2 },
      { name: "Facultad de Derecho", uses: 1 },
      { name: "Rectoría", uses: 1 },
    ]);
  });

  test("matches by prefix, case-insensitively", async () => {
    await addRequest("Facultad de Química");
    await addRequest("Rectoría");

    const res = await server.get("/api/requesters?q=facu", { token: adminToken });
    assert.deepEqual(
      res.body.requesters.map((r) => r.name),
      ["Facultad de Química"],
    );

    const none = await server.get("/api/requesters?q=zzz", { token: adminToken });
    assert.deepEqual(none.body.requesters, []);
  });

  test("ignores requests without a requester and soft-deleted rows", async () => {
    await addRequest(null);
    await addRequest("Viva");
    await sql("update requests set deleted_at = now() where requester = $1", ["Viva"]);
    await addRequest("Presente");

    const res = await server.get("/api/requesters", { token: adminToken });
    assert.deepEqual(
      res.body.requesters.map((r) => r.name),
      ["Presente"],
    );
  });

  test("caps the list and honours a sane limit", async () => {
    for (let i = 0; i < 5; i += 1) await addRequest(`Entidad ${i}`);

    const res = await server.get("/api/requesters?limit=2", { token: adminToken });
    assert.equal(res.body.requesters.length, 2);

    // Out-of-range limits fall back to the default rather than refusing.
    const bad = await server.get("/api/requesters?limit=0", { token: adminToken });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.requesters.length, 5);
  });

  test("needs request.read, and a token", async () => {
    assert.equal((await server.get("/api/requesters", { token: workerToken })).status, 403);
    assert.equal((await server.get("/api/requesters")).status, 401);

    await grantWorker(["request.read"]);
    try {
      assert.equal((await server.get("/api/requesters", { token: workerToken })).status, 200);
    } finally {
      await grantWorker([]);
    }
  });
});
