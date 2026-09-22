import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  roleId,
  sql,
} from "./helpers/fixtures.js";

// Lo que una etapa recibe y lo que entrega (RF-FLW-06), y los dos tipos de campo de finanzas.
describe("las entradas y salidas de una etapa", () => {
  let server;
  let adminToken;
  let financeToken;
  let area;

  const ACCOUNTS = ["coordinacion@uaq.mx", "finanzas@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: "admin" });
    await createActive({ email: ACCOUNTS[1], role: "finance" });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    financeToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    area = await createArea("Diseño de prueba");
  });

  async function project(stages) {
    const res = await server.post("/api/projects", {
      token: adminToken,
      body: { title: "Proyecto", stages },
    });
    assert.equal(res.status, 201);
    return res.body.project;
  }

  const sign = (id, stageId, body, token = adminToken) =>
    server.post(`/api/projects/${id}/stages/${stageId}/approvals`, { token, body });

  const setValue = (id, key, value) =>
    server.put(`/api/projects/${id}/field-values/${key}`, { token: adminToken, body: { value } });

  test("se declaran al crear el proyecto y vuelven en la lectura", async () => {
    const hecho = await project([
      {
        areaId: area.id,
        title: "Diseño",
        inputs: ["dependencia", "tiraje"],
        outputs: ["numero_orden"],
      },
    ]);

    const etapa = hecho.stages[0];
    assert.deepEqual(etapa.inputs, ["dependencia", "tiraje"]);
    assert.deepEqual(etapa.outputs, ["numero_orden"]);

    const lista = await server.get(`/api/projects/${hecho.id}/stages`, { token: adminToken });
    assert.deepEqual(lista.body.stages[0].outputs, ["numero_orden"]);
  });

  test("una etapa sin declaración las trae como listas vacías", async () => {
    const hecho = await project([{ areaId: area.id, title: "Diseño" }]);
    assert.deepEqual(hecho.stages[0].inputs, []);
    assert.deepEqual(hecho.stages[0].outputs, []);
  });

  test("se declaran al agregar una etapa y se pueden cambiar después", async () => {
    const hecho = await project([{ areaId: area.id, title: "Diseño" }]);

    const agregada = await server.post(`/api/projects/${hecho.id}/stages`, {
      token: adminToken,
      body: { areaId: area.id, title: "Impresión", seq: 2, inputs: ["numero_orden"], outputs: ["folio_sin"] },
    });
    assert.equal(agregada.status, 201);
    assert.deepEqual(agregada.body.stage.inputs, ["numero_orden"]);

    const cambiada = await server.patch(
      `/api/projects/${hecho.id}/stages/${agregada.body.stage.id}`,
      { token: adminToken, body: { outputs: ["folio_sin", "pantone"] } },
    );
    assert.equal(cambiada.status, 200);
    assert.deepEqual(cambiada.body.stage.outputs, ["folio_sin", "pantone"]);
    assert.deepEqual(cambiada.body.stage.inputs, ["numero_orden"], "lo que no se manda no se toca");
  });

  test("las claves repetidas se guardan una sola vez y las mal escritas se rechazan", async () => {
    const hecho = await project([{ areaId: area.id, title: "Diseño" }]);

    const repetida = await server.post(`/api/projects/${hecho.id}/stages`, {
      token: adminToken,
      body: { areaId: area.id, title: "X", outputs: ["numero_orden", "numero_orden"] },
    });
    assert.equal(repetida.status, 201);
    assert.deepEqual(repetida.body.stage.outputs, ["numero_orden"]);

    const mala = await server.post(`/api/projects/${hecho.id}/stages`, {
      token: adminToken,
      body: { areaId: area.id, title: "X", outputs: ["NumeroOrden"] },
    });
    assert.equal(mala.status, 400);
    assert.match(mala.body.error.message, /snake_case/);

    const noArreglo = await server.post(`/api/projects/${hecho.id}/stages`, {
      token: adminToken,
      body: { areaId: area.id, title: "X", inputs: "numero_orden" },
    });
    assert.equal(noArreglo.status, 400);
    assert.match(noArreglo.body.error.message, /array of field keys/);
  });

  describe("el visto bueno exige las salidas", () => {
    test("se niega mientras falte una, nombrándola", async () => {
      const hecho = await project([
        { areaId: area.id, title: "Diseño", outputs: ["numero_orden", "folio_sin"] },
      ]);

      const negado = await sign(hecho.id, hecho.stages[0].id, { decision: "approved" });
      assert.equal(negado.status, 409);
      assert.match(negado.body.error.message, /numero_orden, folio_sin/);

      // La etapa sigue abierta: nada quedó a medias.
      const lista = await server.get(`/api/projects/${hecho.id}/stages`, { token: adminToken });
      assert.equal(lista.body.stages[0].status, "active");
      assert.equal((await sql("select count(*)::int as n from approvals"))[0].n, 0);
    });

    test("con una capturada sigue faltando la otra", async () => {
      const hecho = await project([
        { areaId: area.id, title: "Diseño", outputs: ["numero_orden", "folio_sin"] },
      ]);
      assert.equal((await setValue(hecho.id, "numero_orden", "A-77")).status, 200);

      const negado = await sign(hecho.id, hecho.stages[0].id, { decision: "approved" });
      assert.equal(negado.status, 409);
      assert.match(negado.body.error.message, /folio_sin/);
      assert.doesNotMatch(negado.body.error.message, /numero_orden/);
    });

    test("con todas capturadas pasa", async () => {
      const hecho = await project([
        { areaId: area.id, title: "Diseño", outputs: ["numero_orden"] },
      ]);
      await setValue(hecho.id, "numero_orden", "A-77");

      const firmado = await sign(hecho.id, hecho.stages[0].id, { decision: "approved" });
      assert.equal(firmado.status, 201);
      assert.equal(firmado.body.stage.status, "done");
    });

    test("rechazar no exige nada: el trabajo se está devolviendo", async () => {
      const hecho = await project([
        { areaId: area.id, title: "Diseño", inputs: ["dependencia"], outputs: ["numero_orden"] },
      ]);

      const rechazado = await sign(hecho.id, hecho.stages[0].id, {
        decision: "rejected",
        comment: "Faltan los logotipos",
      });
      assert.equal(rechazado.status, 201);

      // El intento nuevo debe la misma salida: es la misma etapa.
      const nueva = rechazado.body.reopened[0];
      assert.deepEqual(nueva.outputs, ["numero_orden"]);
      assert.deepEqual(nueva.inputs, ["dependencia"]);

      const negado = await sign(hecho.id, nueva.id, { decision: "approved" });
      assert.equal(negado.status, 409, "el intento nuevo tampoco cierra sin la salida");
    });

    test("una salida vacía no cuenta como capturada", async () => {
      const hecho = await project([
        { areaId: area.id, title: "Diseño", outputs: ["numero_orden"] },
      ]);

      // El API ya rechaza un valor vacío, así que la fila se escribe directo para probar
      // que el conteo mira el valor y no solo la existencia de la clave.
      await sql(
        "insert into project_field_values (project_id, key, value) values ($1, 'numero_orden', '')",
        [hecho.id],
      );

      const negado = await sign(hecho.id, hecho.stages[0].id, { decision: "approved" });
      assert.equal(negado.status, 409);
    });

    test("una etapa sin salidas declaradas firma sin condiciones", async () => {
      const hecho = await project([{ areaId: area.id, title: "Diseño" }]);
      assert.equal((await sign(hecho.id, hecho.stages[0].id, { decision: "approved" })).status, 201);
    });
  });

  describe("los tipos de finanzas", () => {
    test("factura y cotización están en el catálogo, marcados como de finanzas", async () => {
      const res = await server.get("/api/data-types", { token: adminToken });
      assert.equal(res.status, 200);

      const porCodigo = Object.fromEntries(res.body.dataTypes.map((uno) => [uno.code, uno]));
      for (const code of ["factura", "cotizacion"]) {
        assert.ok(porCodigo[code], `${code} existe`);
        assert.equal(porCodigo[code].baseType, "string");
        assert.equal(porCodigo[code].properties.finance, true);
      }
    });

    test("un formato puede declarar un campo de factura", async () => {
      const res = await server.post("/api/schemas", {
        token: adminToken,
        body: {
          code: "zztest_con_factura",
          name: "Con factura",
          fields: {
            deliverables: [{ code: "descripcion", name: "Descripción", type: "text", required: true }],
            information: [{ code: "folio_factura", name: "Folio de la factura", type: "factura" }],
          },
        },
      });

      assert.equal(res.status, 201);
      const campo = res.body.schema.fields.information[0];
      assert.equal(campo.type, "factura");
      assert.equal(campo.baseType, "string", "el catálogo dice de qué está hecho");
    });
  });

  describe("finanzas pide factura o cotización", () => {
    test("ve el tablero y pide, sin poder editar el proyecto", async () => {
      const hecho = await project([{ areaId: area.id, title: "Diseño" }]);

      // project.read le alcanza para el tablero.
      const tablero = await server.get("/api/projects", { token: financeToken });
      assert.equal(tablero.status, 200);
      assert.equal(tablero.body.projects.length, 1);

      // project.write no lo tiene.
      const intento = await server.patch(`/api/projects/${hecho.id}`, {
        token: financeToken,
        body: { title: "Otro" },
      });
      assert.equal(intento.status, 403);

      const pedido = await server.post(`/api/projects/${hecho.id}/finance-request`, {
        token: financeToken,
        body: { kind: "invoice", note: "Falta el desglose por partida" },
      });
      assert.equal(pedido.status, 200);
      assert.equal(pedido.body.request.key, "requiere_factura");
      assert.equal(pedido.body.request.needed, true);
      assert.equal(pedido.body.request.note, "Falta el desglose por partida");

      // Quedó como un valor cualquiera del proyecto, así que el filtro del tablero lo encuentra.
      const encontrado = await server.get("/api/projects?fieldKey=requiere_factura", {
        token: financeToken,
      });
      assert.deepEqual(encontrado.body.projects.map((uno) => uno.id), [hecho.id]);
    });

    test("sin nota el valor es sí, y retirar el pedido borra la fila", async () => {
      const hecho = await project([{ areaId: area.id, title: "Diseño" }]);
      const pedir = (body) =>
        server.post(`/api/projects/${hecho.id}/finance-request`, { token: financeToken, body });

      const puesto = await pedir({ kind: "quote" });
      assert.equal(puesto.body.request.key, "requiere_cotizacion");
      assert.equal(puesto.body.request.note, null);

      const leido = await server.get(`/api/projects/${hecho.id}/field-values`, { token: adminToken });
      assert.equal(leido.body.fieldValues.find((uno) => uno.key === "requiere_cotizacion").value, "sí");

      const retirado = await pedir({ kind: "quote", needed: false });
      assert.equal(retirado.status, 200);
      assert.equal(retirado.body.request.needed, false);

      const despues = await server.get(`/api/projects/${hecho.id}/field-values`, { token: adminToken });
      assert.ok(!despues.body.fieldValues.some((uno) => uno.key === "requiere_cotizacion"));

      // Retirar algo que nadie pidió no falla.
      assert.equal((await pedir({ kind: "quote", needed: false })).status, 200);
    });

    test("un tipo desconocido es 400 y un proyecto que no existe es 404", async () => {
      const hecho = await project([{ areaId: area.id, title: "Diseño" }]);

      const malo = await server.post(`/api/projects/${hecho.id}/finance-request`, {
        token: financeToken,
        body: { kind: "recibo" },
      });
      assert.equal(malo.status, 400);
      assert.match(malo.body.error.message, /quote, invoice/);

      const nada = await server.post("/api/projects/999999/finance-request", {
        token: financeToken,
        body: { kind: "invoice" },
      });
      assert.equal(nada.status, 404);
    });

    test("quien no tiene finance.request no pide", async () => {
      const hecho = await project([{ areaId: area.id, title: "Diseño" }]);
      const worker = await server.put(`/api/roles/${await roleId("worker")}/permissions`, {
        token: adminToken,
        body: { permissions: ["project.read", "project.write"] },
      });
      assert.equal(worker.status, 200);

      try {
        await createActive({ email: "otro@uaq.mx", role: "worker" });
        const token = await tokenFor(server, "otro@uaq.mx");

        const res = await server.post(`/api/projects/${hecho.id}/finance-request`, {
          token,
          body: { kind: "invoice" },
        });
        assert.equal(res.status, 403, "project.write no alcanza: el permiso es propio");
      } finally {
        await server.put(`/api/roles/${await roleId("worker")}/permissions`, {
          token: adminToken,
          body: { permissions: [] },
        });
      }
    });
  });
});
