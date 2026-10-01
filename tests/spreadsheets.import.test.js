// The import, fed rows instead of Graph.
//
// `importRows()` is separated from `import()` for exactly this: the part worth testing is what
// happens to a row -- created, skipped, refused, flagged -- and not that Microsoft answered. The
// headers and the first row below are the real tracker's, read with `npm run sheets:probe -- 1`,
// which is why the shapes are awkward: a date arrives as the serial 46030.41, the quantity column
// is often empty, and the status column holds the area's own vocabulary.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  createSchema,
  createMicrosoftAccount,
  createSheet,
  tokenFor,
  allLogs,
  sql,
} from "./helpers/fixtures.js";
import spreadsheets from "../src/access/orchestration/spreadsheets.js";
import query from "../src/access/resources/query.js";

const HEADERS = [
  "Id",
  "Hora de inicio",
  "Correo Institucional de quien solicita",
  "Entidad que solicita",
  "¿Qué tipo de papelería institucional requiere?1",
  "Si eligió material impreso, favor de indicar la cantidad:",
  "ESTATUS",
  "NOTAS ADICIONALES",
];

/** One row of the tracker, as Graph hands it over. */
const row = ({ id, serial = 46030.4107175926, email, entity, kind, amount = "", status, notes = "" }) => [
  id,
  serial,
  email,
  entity,
  kind,
  amount,
  status,
  notes,
];

const ROWS = [
  row({
    id: 279,
    email: "administrativo.fps@uaq.mx",
    entity: "Facultad de Psicología y Educación",
    kind: "Hoja membretada",
    status: "Enviado en digital",
    notes: "Se solicita el material digital editable.",
  }),
  row({
    id: 283,
    serial: 46035.4193171296,
    email: "alejandra.resendiz.cabrera@uaq.mx",
    entity: "SECRETARIA ADMINISTRATIVA DE QUIMICA ",
    kind: "Hoja membretada",
    amount: 5000,
    status: "VoBo",
  }),
  row({
    id: 291,
    serial: 46040.5,
    email: "contacto@uaq.mx",
    entity: "Facultad de Derecho",
    kind: "Sobre membretado",
    status: "",
  }),
];

const FIELDS = {
  deliverables: [
    { code: "tipo_papel", name: "Tipo de papel", type: "text", required: true },
    { code: "tiraje", name: "Tiraje", type: "quantity" },
    { code: "fecha_entrega", name: "Fecha de entrega", type: "date" },
  ],
  information: [
    { code: "contacto_correo", name: "Correo del contacto", type: "email", required: true },
  ],
};

/** The map coordination would save for this book, hashing the Forms id. */
const MAP = {
  version: 1,
  title: { op: "column", column: "¿Qué tipo de papelería institucional requiere?1" },
  requester: { op: "column", column: "Entidad que solicita" },
  status: {
    op: "column",
    column: "ESTATUS",
    map: { VoBo: "esperando_vb", "Enviado en digital": "entregado" },
    default: "recibido",
  },
  hashColumns: ["Id"],
  fields: {
    tipo_papel: { op: "column", column: "¿Qué tipo de papelería institucional requiere?1" },
    tiraje: { op: "column", column: "Si eligió material impreso, favor de indicar la cantidad:" },
    fecha_entrega: { op: "column", column: "Hora de inicio" },
    contacto_correo: { op: "column", column: "Correo Institucional de quien solicita" },
  },
};

describe("importing a book's rows", () => {
  let server;
  let admin;
  let adminToken;
  let sheet;

  const ACCOUNTS = ["coordinacion@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();
    admin = await createActive({ email: ACCOUNTS[0], role: "admin" });
    adminToken = await tokenFor(server, ACCOUNTS[0]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);

    const account = await createMicrosoftAccount(admin.id);
    const registered = await createSheet({ microsoftAccountId: account.id });
    const schema = await createSchema("papel", FIELDS);

    const mapped = await spreadsheets.setMapping(registered.id, {
      schemaVersionId: schema.schema_version_id,
      columnMap: MAP,
      headers: HEADERS,
    });
    assert.equal(mapped.mapped, true);

    sheet = await query.getSheet(registered.id);
  });

  const read = (rows = ROWS, extra = {}) => ({ headers: HEADERS, rows, texts: [], ...extra });
  const requests = () => query.listRequests({ sheetId: sheet.id, limit: 100 });

  test("creates one request per row, with the state the sheet carried", async () => {
    const run = await spreadsheets.importRows(sheet, read());

    assert.equal(run.rowsRead, 3);
    assert.equal(run.rowsCreated, 3);
    assert.equal(run.rowsSkipped, 0);
    assert.equal(run.rowsFailed, 0);
    assert.deepEqual(run.errors, []);

    const rows = await requests();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((one) => one.source === "sheet"));
    assert.ok(rows.every((one) => /^SOL-\d{6}$/.test(one.folio)));

    const byTitle = Object.fromEntries(rows.map((one) => [one.requester, one.status_code]));
    assert.equal(byTitle["Facultad de Psicología y Educación"], "entregado");
    assert.equal(byTitle["SECRETARIA ADMINISTRATIVA DE QUIMICA"], "esperando_vb");
    assert.equal(byTitle["Facultad de Derecho"], "recibido", "an empty status takes the default");
  });

  test("the capture is coerced, and the whole row is kept beside it", async () => {
    await spreadsheets.importRows(sheet, read());

    const [{ id }] = await sql("select id from requests where source_index = 0");
    const request = await query.getRequest(id);

    assert.deepEqual(request.data, {
      tipo_papel: "Hoja membretada",
      fecha_entrega: "2026-01-08",
      contacto_correo: "administrativo.fps@uaq.mx",
    });
    assert.ok(!("tiraje" in request.data), "the cell was empty and the field is optional");

    assert.equal(request.source_data["NOTAS ADICIONALES"], "Se solicita el material digital editable.");
    assert.equal(request.source_data.Id, 279);
    assert.match(request.source_hash, /^[0-9a-f]{64}$/);
    assert.equal(request.source_index, 0);
  });

  test("an imported row arrives with no area, for triage from the inbox", async () => {
    await spreadsheets.importRows(sheet, read());

    const rows = await requests();
    assert.ok(rows.every((one) => one.area_id === null));

    const unrouted = await server.get("/api/requests?areaId=none", { token: adminToken });
    assert.equal(unrouted.status, 200);
    assert.equal(unrouted.body.requests.length, 3);

    const area = await createArea("Diseño de prueba");
    const routed = await server.patch(`/api/requests/${rows[0].id}`, {
      token: adminToken,
      body: { areaId: area.id },
    });
    assert.equal(routed.status, 200);

    const left = await server.get("/api/requests?areaId=none", { token: adminToken });
    assert.equal(left.body.requests.length, 2);
  });

  test("running it again creates nothing", async () => {
    const first = await spreadsheets.importRows(sheet, read());
    assert.equal(first.rowsCreated, 3);

    const again = await spreadsheets.importRows(sheet, read());
    assert.equal(again.rowsCreated, 0);
    assert.equal(again.rowsSkipped, 3);
    assert.equal((await requests()).length, 3);
  });

  test("hashing the id means an edit elsewhere is the same row", async () => {
    await spreadsheets.importRows(sheet, read());

    const corrected = [...ROWS];
    corrected[0] = row({
      id: 279,
      email: "administrativo.fps@uaq.mx",
      entity: "Facultad de Psicología",
      kind: "Hoja membretada",
      status: "Enviado en digital",
    });

    const again = await spreadsheets.importRows(sheet, read(corrected));
    assert.equal(again.rowsSkipped, 3, "the row is recognised; the state lives in the app now");
    assert.equal(again.rowsCreated, 0);
  });

  test("hashing content instead makes an edit a new row, flagged as a probable correction", async () => {
    await spreadsheets.setMapping(sheet.id, {
      schemaVersionId: sheet.schema_version_id,
      columnMap: {
        ...MAP,
        hashColumns: [
          "Entidad que solicita",
          "¿Qué tipo de papelería institucional requiere?1",
          "Si eligió material impreso, favor de indicar la cantidad:",
        ],
      },
      headers: HEADERS,
    });
    const byContent = await query.getSheet(sheet.id);

    await spreadsheets.importRows(byContent, read());

    const corrected = [...ROWS];
    corrected[1] = row({
      id: 283,
      serial: 46035.4193171296,
      email: "alejandra.resendiz.cabrera@uaq.mx",
      entity: "SECRETARIA ADMINISTRATIVA DE QUIMICA ",
      kind: "Hoja membretada",
      amount: 6000,
      status: "VoBo",
    });

    const again = await spreadsheets.importRows(byContent, read(corrected));
    assert.equal(again.rowsCreated, 1);
    assert.equal(again.rowsSkipped, 2);
    assert.equal(again.rowsFlagged, 1);

    const rows = await sql(
      `select id, possible_duplicate_of from requests
       where requester = $1 order by id`,
      ["SECRETARIA ADMINISTRATIVA DE QUIMICA"],
    );
    assert.equal(rows.length, 2);
    assert.equal(String(rows[1].possible_duplicate_of), String(rows[0].id));
  });

  test("an edit to the requester itself is not recognised, and that is the limit", async () => {
    await spreadsheets.setMapping(sheet.id, {
      schemaVersionId: sheet.schema_version_id,
      columnMap: { ...MAP, hashColumns: ["Entidad que solicita"] },
      headers: HEADERS,
    });
    const byContent = await query.getSheet(sheet.id);

    await spreadsheets.importRows(byContent, read());

    const corrected = [...ROWS];
    corrected[0] = row({
      id: 279,
      email: "administrativo.fps@uaq.mx",
      entity: "Facultad de Psicología",
      kind: "Hoja membretada",
      status: "Enviado en digital",
    });

    const again = await spreadsheets.importRows(byContent, read(corrected));
    assert.equal(again.rowsCreated, 1);
    assert.equal(again.rowsFlagged, 0);

    const [fresh] = await sql(
      "select possible_duplicate_of from requests where requester = $1",
      ["Facultad de Psicología"],
    );
    assert.equal(fresh.possible_duplicate_of, null);
  });

  test("a row missing a required value is reported and not inserted", async () => {
    const broken = [
      ...ROWS,
      row({ id: 300, email: "", entity: "Facultad de Enfermería", kind: "Hoja membretada", status: "" }),
      row({ id: 301, email: "no-es-un-correo", entity: "Rectoría", kind: "Hoja membretada", status: "" }),
    ];

    const run = await spreadsheets.importRows(sheet, read(broken));

    assert.equal(run.rowsRead, 5);
    assert.equal(run.rowsCreated, 3);
    assert.equal(run.rowsFailed, 2);
    assert.deepEqual(run.errors.map((entry) => entry.index), [3, 4]);
    assert.match(run.errors[0].message, /"Correo del contacto" is required/);
    assert.match(run.errors[1].message, /valid email/);

    assert.equal((await requests()).length, 3);
  });

  test("the run is written down, and the book remembers when it last ran", async () => {
    const run = await spreadsheets.importRows(sheet, read());

    const stored = await query.listSheetImports(sheet.id);
    assert.equal(stored.length, 1);
    assert.equal(String(stored[0].id), String(run.id));
    assert.equal(stored[0].rows_created, 3);
    assert.ok(stored[0].finished_at !== null);

    const after = await query.getSheet(sheet.id);
    assert.ok(after.last_imported_at !== null);

    const logs = (await allLogs()).filter((entry) => entry.action === "sheet_imported");
    assert.equal(logs.length, 1);
  });

  test("`from: text` reads the cell as Excel shows it, not the whole row", async () => {
    await spreadsheets.setMapping(sheet.id, {
      schemaVersionId: sheet.schema_version_id,
      columnMap: {
        ...MAP,
        fields: {
          ...MAP.fields,
          fecha_entrega: { op: "column", column: "Hora de inicio", from: "text", format: "DD/MM/YYYY" },
        },
      },
      headers: HEADERS,
    });
    const porTexto = await query.getSheet(sheet.id);

    const texts = ROWS.map((fila) => fila.map((celda) => String(celda)));
    texts[0][1] = "08/01/2026";
    texts[1][1] = "13/01/2026";
    texts[2][1] = "18/01/2026";

    const run = await spreadsheets.importRows(porTexto, { headers: HEADERS, rows: ROWS, texts });
    assert.equal(run.rowsFailed, 0, run.errors.map((e) => e.message).join(" "));
    assert.equal(run.rowsCreated, 3);

    const [{ id }] = await sql("select id from requests where source_index = 0");
    const request = await query.getRequest(id);
    assert.equal(request.data.fecha_entrega, "2026-01-08");
  });

  describe("marcar filas como ya vistas", () => {
    test("marcar las filas de hoy hace que la importación no cree nada", async () => {
      const marcado = await spreadsheets.markRows(sheet, read());
      assert.equal(marcado.rowsRead, 3);
      assert.equal(marcado.rowsMarked, 3);
      assert.equal(marcado.rowsAlreadyKnown, 0);

      const corrida = await spreadsheets.importRows(sheet, read());
      assert.equal(corrida.rowsCreated, 0, "ninguna solicitud");
      assert.equal(corrida.rowsSkipped, 3, "las tres se reconocen");
      assert.equal((await requests()).length, 0);
    });

    test("una fila agregada después sí entra", async () => {
      await spreadsheets.markRows(sheet, read());

      const conUnaNueva = [
        ...ROWS,
        row({
          id: 300,
          email: "nueva@uaq.mx",
          entity: "Facultad de Enfermería",
          kind: "Hoja membretada",
          status: "",
        }),
      ];

      const corrida = await spreadsheets.importRows(sheet, read(conUnaNueva));
      assert.equal(corrida.rowsCreated, 1, "sólo la nueva");
      assert.equal(corrida.rowsSkipped, 3);

      const [una] = await requests();
      assert.equal(una.requester, "Facultad de Enfermería");
    });

    test("marcar dos veces no cuenta doble, y lo ya importado ya se conocía", async () => {
      await spreadsheets.importRows(sheet, read([ROWS[0]]));

      const marcado = await spreadsheets.markRows(sheet, read());
      assert.equal(marcado.rowsMarked, 2, "la importada ya se conocía por su solicitud");
      assert.equal(marcado.rowsAlreadyKnown, 1);

      const otra = await spreadsheets.markRows(sheet, read());
      assert.equal(otra.rowsMarked, 0);
      assert.equal(otra.rowsAlreadyKnown, 3);
    });

    test("un ensayo cuenta y no marca nada", async () => {
      const ensayo = await spreadsheets.markRows(sheet, read(), { dryRun: true });
      assert.equal(ensayo.rowsMarked, 3);
      assert.equal(ensayo.dryRun, true);

      const corrida = await spreadsheets.importRows(sheet, read());
      assert.equal(corrida.rowsCreated, 3);
    });

    test("deshacer las marcas devuelve las filas", async () => {
      await spreadsheets.markRows(sheet, read());
      assert.equal((await query.getSheet(sheet.id)).marked_rows, 3);

      const limpiado = await spreadsheets.clearMarks(sheet.id);
      assert.equal(limpiado.rowsCleared, 3);
      assert.equal((await query.getSheet(sheet.id)).marked_rows, 0);

      const corrida = await spreadsheets.importRows(sheet, read());
      assert.equal(corrida.rowsCreated, 3, "vuelven a ser desconocidas");
    });

    test("deshacer no toca lo ya importado", async () => {
      await spreadsheets.importRows(sheet, read());
      await spreadsheets.markRows(sheet, read());
      await spreadsheets.clearMarks(sheet.id);

      assert.equal((await requests()).length, 3);
      const otra = await spreadsheets.importRows(sheet, read());
      assert.equal(otra.rowsCreated, 0);
      assert.equal(otra.rowsSkipped, 3);
    });

    test("un libro sin mapeo no se puede marcar", async () => {
      await spreadsheets.clearMapping(sheet.id);
      const sinMapeo = await query.getSheet(sheet.id);

      await assert.rejects(
        () => spreadsheets.markRows(sinMapeo, read()),
        /Map the book to a format before marking its rows/,
      );
    });

    test("queda en la bitácora quién decidió no importarlas", async () => {
      await spreadsheets.markRows(sheet, read());
      const logs = (await allLogs()).filter((entry) => entry.action === "sheet_rows_marked");
      assert.equal(logs.length, 1);
    });
  });

  test("a dry run counts and writes nothing", async () => {
    const run = await spreadsheets.importRows(sheet, read(), { dryRun: true });

    assert.equal(run.dryRun, true);
    assert.equal(run.rowsCreated, 3);
    assert.equal((await requests()).length, 0);
    assert.deepEqual(await query.listSheetImports(sheet.id), []);
    assert.equal((await query.getSheet(sheet.id)).last_imported_at, null);
  });

  test("a truncated read says so", async () => {
    const run = await spreadsheets.importRows(sheet, read(ROWS, { truncated: true }));
    assert.equal(run.truncated, true);
  });

  test("an unmapped book is refused before anything is read", async () => {
    await spreadsheets.clearMapping(sheet.id);
    const unmapped = await query.getSheet(sheet.id);

    await assert.rejects(
      () => spreadsheets.importRows(unmapped, read()),
      /format this book points at is gone|no format/i,
    );
  });

  test("a sheet that no longer matches its mapping is a refusal, not a silent mis-import", async () => {
    const renamed = HEADERS.map((header) => (header === "ESTATUS" ? "ESTADO" : header));

    await assert.rejects(
      () => spreadsheets.importRows(sheet, { headers: renamed, rows: ROWS, texts: [] }),
      /no longer matches its mapping/,
    );
  });
});
