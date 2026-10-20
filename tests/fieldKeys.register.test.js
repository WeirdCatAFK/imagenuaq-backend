// Registering a data key no format declares (DATAMODEL §2.13b, RF-FLW-06): a stage can ask for or
// deliver a value with a real name and type, and the key still means one thing system-wide.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  tokenFor,
  grantPermissions,
  TEST_SCHEMA_PREFIX,
} from "./helpers/fixtures.js";

describe("POST /api/schemas/field-keys", () => {
  let server;
  let adminToken;
  let workerToken;
  let leadToken;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx", "lider@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ACCOUNTS[0], role: "admin" });
    await createActive({ email: ACCOUNTS[1], role: "worker" });
    await createActive({ email: ACCOUNTS[2], role: "area_lead" });
    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
    leadToken = await tokenFor(server, ACCOUNTS[2]);
  });

  after(async () => {
    await grantPermissions(server, adminToken, "area_lead", []);
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  const register = (body, token = adminToken) => server.post("/api/schemas/field-keys", { token, body });
  const vocabulary = async () =>
    Object.fromEntries((await server.get("/api/schemas/field-keys", { token: adminToken })).body.fieldKeys.map((one) => [one.key, one]));

  test("a key made from its name joins the vocabulary as registered", async () => {
    const res = await register({ name: "Costo total del pedido", type: "currency" });
    assert.equal(res.status, 201);
    assert.equal(res.body.fieldKey.key, "costo_total_del_pedido");

    const known = await vocabulary();
    assert.equal(known.costo_total_del_pedido.name, "Costo total del pedido");
    assert.equal(known.costo_total_del_pedido.type, "currency");
    assert.equal(known.costo_total_del_pedido.source, "registered");
    assert.equal(known.requiere_factura.source, "registered", "the finance keys are seeded");

    const accented = await register({ name: "Número de guía", type: "text" });
    assert.equal(accented.body.fieldKey.key, "numero_de_guia");
  });

  test("an existing key is reused with its type and refused with another", async () => {
    const same = await register({ key: "numero_orden", name: "Otro nombre", type: "text" });
    assert.equal(same.status, 201);
    assert.equal(same.body.fieldKey.name, "Número de orden", "the format's name stays");

    const other = await register({ key: "numero_orden", name: "Número de orden", type: "date" });
    assert.equal(other.status, 409);
  });

  test("a format cannot publish a registered key with another type", async () => {
    assert.equal((await register({ key: "medida_final", name: "Medida final", type: "quantity" })).status, 201);
    const res = await server.post("/api/schemas", {
      token: adminToken,
      body: {
        code: `${TEST_SCHEMA_PREFIX}medidas`,
        name: "Con medida",
        fields: { deliverables: [{ code: "medida_final", name: "Medida final", type: "text" }], information: [] },
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /already exists as "quantity"/);
  });

  test("bad input is a 400, and only those who design forms, flows or stages may register", async () => {
    assert.equal((await register({ name: "Sin tipo" })).status, 400);
    assert.equal((await register({ name: "Tipo inventado", type: "nope" })).status, 400);
    assert.equal((await register({ key: "Mal Formada", name: "x", type: "text" })).status, 400);

    assert.equal((await register({ name: "Ajeno", type: "text" }, workerToken)).status, 403);
    await grantPermissions(server, adminToken, "area_lead", ["project.read", "project.write"]);
    assert.equal((await register({ name: "De un líder", type: "text" }, leadToken)).status, 201);
  });
});
