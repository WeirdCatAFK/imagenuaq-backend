import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createSchema,
  tokenFor,
  TEST_SCHEMA_PREFIX,
} from "./helpers/fixtures.js";

// El vocabulario de claves. Una clave no es una etiqueta local de un formato: es lo que nombra
// al valor en `requests.data` y en `project_field_values`, así que tiene que significar una sola
// cosa en todo el sistema.
describe("GET /api/schemas/field-keys", () => {
  let server;
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
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  const vocabulario = async (token = adminToken) =>
    (await server.get("/api/schemas/field-keys", { token })).body.fieldKeys;

  const crear = (body, token = adminToken) => server.post("/api/schemas", { token, body });

  test("trae las claves sembradas con su tipo y en qué formatos viven", async () => {
    const claves = await vocabulario();
    const porClave = Object.fromEntries(claves.map((una) => [una.key, una]));

    assert.ok(porClave.numero_orden, "la sembró papel_institucional");
    assert.equal(porClave.numero_orden.type, "text");
    assert.ok(porClave.numero_orden.schemas.includes("Papel institucional"));

    // `descripcion` la piden varios formatos: eso es reuso, y es el punto del vocabulario.
    assert.ok(porClave.descripcion.schemaCount >= 2, "la comparten varios formatos");
    assert.equal(porClave.descripcion.type, "text");

    // Ordenado por clave, para que la lista sea buscable.
    assert.deepEqual([...claves.map((una) => una.key)].sort(), claves.map((una) => una.key));
  });

  test("una clave nueva aparece en cuanto se publica", async () => {
    assert.ok(!(await vocabulario()).some((una) => una.key === "clave_inedita"));

    const res = await crear({
      code: `${TEST_SCHEMA_PREFIX}nuevas`,
      name: "Con clave inédita",
      fields: {
        deliverables: [
          { code: "clave_inedita", name: "Clave inédita", type: "quantity", note: "Traída del aire" },
        ],
        information: [],
      },
    });
    assert.equal(res.status, 201);

    const una = (await vocabulario()).find((otra) => otra.key === "clave_inedita");
    assert.equal(una.type, "quantity");
    assert.equal(una.name, "Clave inédita");
    assert.equal(una.note, "Traída del aire");
    assert.equal(una.schemaCount, 1);
  });

  test("la definición que trae es la más reciente", async () => {
    const formato = await createSchema("renombra", {
      deliverables: [{ code: "clave_renombrada", name: "Nombre viejo", type: "text", note: "" }],
      information: [],
    });

    const v2 = await server.post(`/api/schemas/${formato.id}/versions`, {
      token: adminToken,
      body: {
        fields: {
          deliverables: [
            { code: "clave_renombrada", name: "Nombre nuevo", type: "text", note: "Ahora con nota" },
          ],
          information: [],
        },
      },
    });
    assert.equal(v2.status, 201);

    const una = (await vocabulario()).find((otra) => otra.key === "clave_renombrada");
    assert.equal(una.name, "Nombre nuevo", "renombrar sí se puede: el tipo es lo que no cambia");
    assert.equal(una.note, "Ahora con nota");
  });

  test("una clave de una versión retirada sigue en el vocabulario", async () => {
    const formato = await createSchema("retira", {
      deliverables: [{ code: "clave_retirada", name: "Se va a retirar", type: "text", note: "" }],
      information: [],
    });

    // La versión 2 ya no la pide.
    const v2 = await server.post(`/api/schemas/${formato.id}/versions`, {
      token: adminToken,
      body: {
        fields: {
          deliverables: [{ code: "clave_que_queda", name: "La que queda", type: "text" }],
          information: [],
        },
      },
    });
    assert.equal(v2.status, 201);

    // Sigue ahí: hay datos capturados debajo, así que la clave sigue significando algo.
    assert.ok(
      (await vocabulario()).some((una) => una.key === "clave_retirada"),
      "no se puede reusar con otro significado solo porque el formato dejó de pedirla",
    );
  });

  test("cualquier sesión la lee; sin token no", async () => {
    assert.equal((await server.get("/api/schemas/field-keys", { token: workerToken })).status, 200);
    assert.equal((await server.get("/api/schemas/field-keys")).status, 401);
  });

  describe("el tipo de una clave no cambia", () => {
    test("reusar una clave sembrada con otro tipo se rechaza, nombrando dónde vive", async () => {
      const res = await crear({
        code: `${TEST_SCHEMA_PREFIX}choca`,
        name: "Choca",
        fields: {
          deliverables: [{ code: "numero_orden", name: "Número de orden", type: "date" }],
          information: [],
        },
      });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /already exists as "text"/);
      assert.match(res.body.error.message, /Papel institucional/);
      assert.match(res.body.error.message, /pick another key/);
    });

    test("reusarla con el mismo tipo es justo el punto", async () => {
      const res = await crear({
        code: `${TEST_SCHEMA_PREFIX}reusa`,
        name: "Reusa",
        fields: {
          deliverables: [{ code: "tiraje", name: "Tiraje", type: "quantity" }],
          information: [{ code: "numero_orden", name: "Número de orden", type: "text" }],
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.schema.fields.information[0].code, "numero_orden");
    });

    test("tampoco cambia al publicar una versión nueva", async () => {
      const formato = await createSchema("inmutable_tipo", {
        deliverables: [{ code: "clave_con_tipo", name: "Con tipo", type: "text" }],
        information: [],
      });

      const res = await server.post(`/api/schemas/${formato.id}/versions`, {
        token: adminToken,
        body: {
          fields: {
            deliverables: [{ code: "clave_con_tipo", name: "Con tipo", type: "quantity" }],
            information: [],
          },
        },
      });

      // Es la misma regla, no otra: los valores ya capturados son del tipo viejo.
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /already exists as "text"/);
    });

    test("un clon hereda tipos que ya son consistentes, así que pasa", async () => {
      const [starter] = (await vocabulario()).filter((una) => una.key === "tiraje");
      assert.ok(starter, "tiraje viene sembrada");

      const formato = await createSchema("fuente_clon", {
        deliverables: [{ code: "tiraje", name: "Tiraje", type: "quantity" }],
        information: [],
      });

      const res = await server.post(`/api/schemas/${formato.id}/clone`, {
        token: adminToken,
        body: { code: `${TEST_SCHEMA_PREFIX}clonado`, name: "Clonado" },
      });
      assert.equal(res.status, 201);
    });
  });
});
