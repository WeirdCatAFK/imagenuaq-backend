// Public forms (RF-SOL-01, RF-MIG-01): links managed under a format, answered without a session.
// Writing to the book needs Microsoft, so these tests check the row instead. applyMapping() reads
// back what invertMapping() writes, and the import skips its hash.
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
  sql,
} from "./helpers/fixtures.js";
import { validateColumnMap, applyMapping, invertMapping, rowHash } from "../src/utils/columnMap.js";
import { fieldList } from "../src/access/orchestration/schemas.js";

const FIELDS = {
  deliverables: [
    { code: "material", name: "Material", type: "choice", required: true, choices: ["Hoja membretada", "Tarjeta", "Sobre"], multiple: true },
    { code: "tiraje", name: "Tiraje", type: "quantity", required: true },
    { code: "archivo", name: "Archivo", type: "document", required: true },
  ],
  information: [
    { code: "formato_entrega", name: "Entrega", type: "choice", choices: ["Digital", "Impreso"] },
    { code: "fecha", name: "Fecha", type: "date" },
    { code: "urgente", name: "Urgente", type: "boolean" },
    { code: "facturacion", name: "Facturación", type: "text", internal: true },
    { code: "cotizacion", name: "Cotización", type: "document", internal: true },
  ],
};

describe("/api/forms", () => {
  let server;
  let admin;
  let adminToken;
  let workerToken;
  let schema;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();
    admin = await createActive({ email: ACCOUNTS[0], role: "admin" });
    await createActive({ email: ACCOUNTS[1], role: "worker" });
    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    schema = await createSchema("papel_form", FIELDS, "Papel institucional");
  });

  const createLink = (body = {}, token = adminToken) =>
    server.post(`/api/schemas/${schema.id}/links`, { token, body });

  const VALID = {
    title: "Hojas para la facultad",
    requester: "Facultad de Química",
    data: { material: ["tarjeta", "Sobre"], tiraje: "500", formato_entrega: "digital" },
  };

  test("a link is made and listed with its token by whoever manages formats, refused to anyone else", async () => {
    const refused = await createLink({}, workerToken);
    assert.equal(refused.status, 403);

    const res = await createLink();
    assert.equal(res.status, 201);
    assert.match(res.body.link.token, /^[\w-]{43}$/);

    const list = await server.get(`/api/schemas/${schema.id}/links`, { token: adminToken });
    assert.equal(list.body.links.length, 1);
    assert.equal(list.body.links[0].token, res.body.link.token);

    const formats = await server.get("/api/schemas", { token: adminToken });
    assert.equal(formats.body.schemas.find((one) => one.id === schema.id).linkCount, 1);
  });

  test("a choice field needs its list, and only a choice field takes one", async () => {
    const publish = (field) =>
      server.post(`/api/schemas/${schema.id}/versions`, {
        token: adminToken,
        body: { fields: { deliverables: [field], information: [] } },
      });

    assert.equal((await publish({ code: "color", name: "Color", type: "choice" })).status, 400);
    assert.equal((await publish({ code: "color", name: "Color", type: "text", choices: ["Rojo"] })).status, 400);

    const ok = await publish({ code: "color", name: "Color", type: "choice", choices: [" Rojo ", "Azul"], multiple: true });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.version.fields.deliverables[0].choices, ["Rojo", "Azul"]);
    assert.equal(ok.body.version.fields.deliverables[0].multiple, true);
  });

  test("a book mapped to another format is refused", async () => {
    const other = await createSchema("otro_form");
    const account = await createMicrosoftAccount(admin.id);
    const sheet = await createSheet({ microsoftAccountId: account.id, registeredBy: admin.id });
    await sql(
      "update sheets set schema_version_id = (select id from schema_versions where schema_id = $2) where id = $1",
      [sheet.id, other.id],
    );

    const res = await createLink({ sheetId: sheet.id });
    assert.equal(res.status, 400);
  });

  test("anyone with the link reads the form and answers it without a session", async () => {
    const { token } = (await createLink()).body.link;

    const form = await server.get(`/api/forms/${token}`);
    assert.equal(form.status, 200);
    assert.equal(form.body.form.name, "Papel institucional");
    assert.deepEqual(form.body.form.fields.deliverables[0].choices, ["Hoja membretada", "Tarjeta", "Sobre"]);

    const res = await server.post(`/api/forms/${token}`, { body: VALID });
    assert.equal(res.status, 201);
    assert.match(res.body.folio, /^SOL-\d{6}$/);

    const [row] = await sql("select * from requests where folio = $1", [res.body.folio]);
    assert.equal(row.source, "form");
    assert.equal(row.created_by, admin.id);
    assert.deepEqual(row.data.material, ["Tarjeta", "Sobre"]);
    assert.equal(row.data.formato_entrega, "Digital");
    assert.equal(row.data.tiraje, 500);
  });

  test("the fields staff fill stay off the public form and out of its answers", async () => {
    const { token } = (await createLink()).body.link;

    const form = await server.get(`/api/forms/${token}`);
    const codes = form.body.form.fields.information.map((field) => field.code);
    assert.ok(!codes.includes("facturacion"));
    assert.ok(!codes.includes("cotizacion"));

    const res = await server.post(`/api/forms/${token}`, {
      body: { ...VALID, data: { ...VALID.data, facturacion: "F-123" } },
    });
    assert.equal(res.status, 201);
    const [row] = await sql("select data from requests where folio = $1", [res.body.folio]);
    assert.equal(row.data.facturacion, undefined);

    const upload = await server.post(
      `/api/forms/${token}/files?key=${encodeURIComponent(res.body.uploadKey)}&field=cotizacion&name=c.pdf`,
      { raw: "%PDF", headers: { "content-type": "application/pdf" } },
    );
    assert.equal(upload.status, 400);
  });

  test("an answer outside the choices, or no requester, is refused", async () => {
    const { token } = (await createLink()).body.link;

    const bad = await server.post(`/api/forms/${token}`, {
      body: { ...VALID, data: { ...VALID.data, formato_entrega: "Fax" } },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /Fax/);

    const anonymous = await server.post(`/api/forms/${token}`, { body: { ...VALID, requester: " " } });
    assert.equal(anonymous.status, 400);
  });

  test("files attach with the upload key and become the field's value", async () => {
    const { token } = (await createLink()).body.link;
    const { folio, uploadKey } = (await server.post(`/api/forms/${token}`, { body: VALID })).body;

    const path = (key) =>
      `/api/forms/${token}/files?key=${encodeURIComponent(key)}&field=archivo&name=arte.pdf`;
    const forged = await server.post(path("bm90LWEta2V5"), { raw: "pdf", headers: { "content-type": "application/pdf" } });
    assert.equal(forged.status, 403);

    const res = await server.post(path(uploadKey), { raw: "%PDF-1.4", headers: { "content-type": "application/pdf" } });
    assert.equal(res.status, 201);

    const [row] = await sql("select * from requests where folio = $1", [folio]);
    const [file] = await sql("select * from files where id = $1", [row.data.archivo]);
    assert.equal(file.name, "arte.pdf");
    assert.equal(String(file.folder_id), String(row.folder_id));

    const finish = await server.post(`/api/forms/${token}/finish`, { body: { key: uploadKey } });
    assert.equal(finish.status, 200);
  });

  test("a revoked link answers 404", async () => {
    const { id, token } = (await createLink()).body.link;
    const revoked = await server.delete(`/api/schemas/${schema.id}/links/${id}`, { token: adminToken });
    assert.equal(revoked.status, 200);

    assert.equal((await server.get(`/api/forms/${token}`)).status, 404);
    assert.equal((await server.post(`/api/forms/${token}`, { body: VALID })).status, 404);
  });

  test("one address gets a 429 after thirty answers in an hour", async () => {
    const { token } = (await createLink()).body.link;
    let status = 0;
    for (let i = 0; i < 31 && status !== 429; i++) {
      status = (await server.post(`/api/forms/${token}`, { body: VALID })).status;
    }
    assert.equal(status, 429);
  });
});

describe("invertMapping", () => {
  const HEADERS = ["Id", "Hora de inicio", "Entidad", "Asunto", "Material", "Tiraje", "Archivo", "Entrega", "Fecha", "Urgente"];
  const fields = fieldList(FIELDS).filter((field) => !field.internal);
  const { map, errors } = validateColumnMap(
    {
      title: { op: "column", column: "Asunto" },
      requester: { op: "column", column: "Entidad" },
      hashColumns: ["Id"],
      fields: {
        material: { op: "column", column: "Material" },
        tiraje: { op: "column", column: "Tiraje" },
        archivo: { op: "column", column: "Archivo" },
        formato_entrega: { op: "column", column: "Entrega" },
        fecha: { op: "column", column: "Fecha" },
        urgente: { op: "column", column: "Urgente" },
      },
    },
    fields,
    HEADERS,
  );

  const request = {
    folio: "SOL-000042",
    title: "Hojas",
    requester: "Facultad de Química",
    data: { material: ["Tarjeta", "Sobre"], tiraje: 500, archivo: "7", formato_entrega: "Digital", fecha: "2026-03-15", urgente: true },
  };

  test("the row it writes reads back as the same request", () => {
    assert.deepEqual(errors, []);
    const row = invertMapping(map, fields, HEADERS, request, { 7: "arte.pdf" });

    assert.equal(row[0], "SOL-000042");
    assert.equal(row[1], "");
    assert.equal(row[6], "arte.pdf");
    assert.equal(row[8], "15/03/2026");

    const back = applyMapping(map, fields, HEADERS, row);
    assert.deepEqual(back.errors, []);
    assert.equal(back.title, "Hojas");
    assert.equal(back.requester, "Facultad de Química");
    assert.deepEqual(back.data, { ...request.data, archivo: "arte.pdf" });
  });

  test("its hash is the folio's, so each written row is its own and the import skips it", () => {
    const a = invertMapping(map, fields, HEADERS, request);
    const b = invertMapping(map, fields, HEADERS, { ...request, folio: "SOL-000043" });
    assert.notEqual(rowHash(map, HEADERS, a), rowHash(map, HEADERS, b));
    assert.equal(rowHash(map, HEADERS, a), applyMapping(map, fields, HEADERS, a).sourceHash);
  });
});
