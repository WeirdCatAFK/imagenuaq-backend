// Saving and clearing a book's mapping (RF-MIG-02). Validation and the transformation itself are
// `columnMap.test.js`'s business, pure and fast; what belongs here is the endpoint: whether it
// refuses what it should, what it stores, and the guards. The two routes that read the workbook
// live -- preview and import -- are exercised only as far as their guards, for the reason
// `spreadsheets.guard.test.js` gives: reaching them needs the network.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createSchema,
  createMicrosoftAccount,
  createSheet,
  tokenFor,
  logsFor,
  grantPermissions,
} from "./helpers/fixtures.js";

describe("/api/spreadsheets/:id/mapping", () => {
  let server;
  let admin;
  let adminToken;
  let workerToken;
  let sheet;
  let schema;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  const HEADERS = ["Id", "Entidad que solicita", "Tipo", "Cantidad", "ESTATUS"];

  const FIELDS = {
    deliverables: [
      { code: "tipo_papel", name: "Tipo de papel", type: "text", required: true },
      { code: "tiraje", name: "Tiraje", type: "quantity" },
    ],
    information: [],
  };

  const MAP = {
    version: 1,
    title: { op: "column", column: "Tipo" },
    requester: { op: "column", column: "Entidad que solicita" },
    hashColumns: ["Id"],
    fields: {
      tipo_papel: { op: "column", column: "Tipo" },
      tiraje: { op: "column", column: "Cantidad" },
    },
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
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    const account = await createMicrosoftAccount(admin.id);
    sheet = await createSheet({ microsoftAccountId: account.id, registeredBy: admin.id });
    schema = await createSchema("papel", FIELDS);
  });

  const grantWorker = (permissions) =>
    grantPermissions(server, adminToken, "worker", permissions);

  const save = (body, token = adminToken) =>
    server.put(`/api/spreadsheets/${sheet.id}/mapping`, { token, body });

  const mapping = (changes = {}) => ({
    schemaVersionId: schema.schema_version_id,
    columnMap: { ...MAP, ...changes },
    headers: HEADERS,
  });

  test("saves the mapping and the book reads as mapped", async () => {
    const res = await save(mapping());

    assert.equal(res.status, 200);
    assert.equal(res.body.sheet.mapped, true);
    assert.equal(String(res.body.sheet.schemaVersionId), String(schema.schema_version_id));
    assert.deepEqual(res.body.sheet.columnMap.hashColumns, ["Id"]);
    assert.equal(res.body.sheet.columnMap.title.column, "Tipo");

    const logs = await logsFor("sheets", sheet.id);
    assert.deepEqual(logs.map((l) => l.action), ["record_updated"]);
  });

  test("stores the map normalised, without the keys an op cannot use", async () => {
    const res = await save(
      mapping({ title: { op: "constant", value: "Papelería", column: "Tipo" } }),
    );

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.sheet.columnMap.title, { op: "constant", value: "Papelería" });
  });

  test("refuses a column the sheet does not have, naming it", async () => {
    const res = await save(
      mapping({ fields: { ...MAP.fields, tiraje: { op: "column", column: "Tiraje" } } }),
    );

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /"Tiraje", which the sheet does not have/);
  });

  test("refuses a map with no title and one that leaves a required field unfed", async () => {
    const noTitle = await save(mapping({ title: undefined }));
    assert.equal(noTitle.status, 400);
    assert.match(noTitle.body.error.message, /"title" is required/);

    const unfed = await save(mapping({ fields: { tiraje: MAP.fields.tiraje } }));
    assert.equal(unfed.status, 400);
    assert.match(unfed.body.error.message, /"Tipo de papel" is required by the format/);
  });

  test("reports every problem at once, not the first", async () => {
    const res = await save(
      mapping({
        title: { op: "column", column: "No existe" },
        fields: { ...MAP.fields, tiraje: { op: "split", column: "Cantidad" } },
      }),
    );

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /No existe/);
    assert.match(res.body.error.message, /needs the "separator"/);
  });

  test("refuses a status code the catalogue does not have", async () => {
    const res = await save(
      mapping({
        status: { op: "column", column: "ESTATUS", map: { VoBo: "no_existe_este_codigo" } },
      }),
    );

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /"no_existe_este_codigo", which is not in the catalogue/);
  });

  test("accepts a status map whose codes are real", async () => {
    const res = await save(
      mapping({
        status: {
          op: "column",
          column: "ESTATUS",
          map: { VoBo: "esperando_vb", Entregado: "entregado" },
          default: "recibido",
        },
      }),
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.sheet.columnMap.status.map.VoBo, "esperando_vb");
  });

  test("without headers the column names are not checked", async () => {
    const res = await save({
      schemaVersionId: schema.schema_version_id,
      columnMap: { ...MAP, title: { op: "column", column: "Una columna cualquiera" } },
    });

    assert.equal(res.status, 200);
  });

  test("404s on an unknown book or version", async () => {
    assert.equal(
      (await server.put("/api/spreadsheets/999999/mapping", { token: adminToken, body: mapping() })).status,
      404,
    );

    const badVersion = await save({ ...mapping(), schemaVersionId: 999999 });
    assert.equal(badVersion.status, 404);
    assert.match(badVersion.body.error.message, /Schema version not found/);
  });

  test("DELETE returns the book to unmapped", async () => {
    assert.equal((await save(mapping())).status, 200);

    const res = await server.delete(`/api/spreadsheets/${sheet.id}/mapping`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.sheet.mapped, false);
    assert.equal(res.body.sheet.schemaVersionId, null);
    assert.deepEqual(res.body.sheet.columnMap, {});

    assert.equal(
      (await server.delete("/api/spreadsheets/999999/mapping", { token: adminToken })).status,
      404,
    );
  });

  test("importing an unmapped book is refused before anything is read", async () => {
    const res = await server.post(`/api/spreadsheets/${sheet.id}/import`, {
      token: adminToken,
      body: {},
    });

    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /Map the book to a format before importing it/);
  });

  test("previewing with no format and no version offered is refused the same way", async () => {
    const res = await server.post(`/api/spreadsheets/${sheet.id}/mapping/preview`, {
      token: adminToken,
      body: {},
    });

    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /no format yet/);
  });

  test("the runs of a book are listable, and empty before the first one", async () => {
    const res = await server.get(`/api/spreadsheets/${sheet.id}/imports`, { token: adminToken });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.imports, []);
    assert.equal((await server.get("/api/spreadsheets/999999/imports", { token: adminToken })).status, 404);
  });

  describe("guards", () => {
    const ROUTES = [
      ["get", "/imports"],
      ["post", "/mapping/preview"],
      ["put", "/mapping"],
      ["delete", "/mapping"],
      ["post", "/import"],
    ];

    test("nothing answers without a session", async () => {
      for (const [method, path] of ROUTES) {
        const res = await server[method](`/api/spreadsheets/1${path}`);
        assert.equal(res.status, 401, `${method} ${path}`);
      }
    });

    test("a role with neither permission is refused all of them", async () => {
      for (const [method, path] of ROUTES) {
        const options = method === "get" ? { token: workerToken } : { token: workerToken, body: {} };
        const res = await server[method](`/api/spreadsheets/${sheet.id}${path}`, options);
        assert.equal(res.status, 403, `${method} ${path}`);
      }
    });

    test("spreadsheet.read reads, and does not write the mapping", async () => {
      await grantWorker(["spreadsheet.read"]);
      try {
        assert.equal(
          (await server.get(`/api/spreadsheets/${sheet.id}/imports`, { token: workerToken })).status,
          200,
        );
        assert.equal(
          (await server.put(`/api/spreadsheets/${sheet.id}/mapping`, { token: workerToken, body: mapping() })).status,
          403,
        );
      } finally {
        await grantWorker([]);
      }
    });

    test("importing needs request.write as well: it creates requests", async () => {
      await grantWorker(["spreadsheet.read", "spreadsheet.write"]);
      try {
        const res = await server.post(`/api/spreadsheets/${sheet.id}/import`, {
          token: workerToken,
          body: {},
        });
        assert.equal(res.status, 403, "spreadsheet.write alone does not import");
      } finally {
        await grantWorker([]);
      }
    });
  });
});
