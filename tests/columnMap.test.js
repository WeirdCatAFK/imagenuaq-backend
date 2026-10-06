// Pure: no server, no database, no Graph.
//
// The headers and the first row come from the real tracker (`FORMATO DE SOLICITUD 002 HOJA
// MEMBRETADA`), read with `npm run sheets:probe -- 1`. That is why the awkward parts are here:
// a header with a trailing colon, a header Forms suffixed with `1`, a date that arrives as the
// serial 46030.4107 and a quantity that arrives empty.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateColumnMap, applyMapping, rowHash } from "../src/utils/columnMap.js";

const HEADERS = [
  "Id",
  "Hora de inicio",
  "Correo Institucional de quien solicita",
  "Entidad que solicita",
  "Nombre completo de quien solicita",
  "¿Qué tipo de papelería institucional requiere?1",
  "Si eligió material impreso, favor de indicar la cantidad:",
  "ESTATUS",
  "NOTAS ADICIONALES",
];

const ROW = [
  279,
  46030.4107175926,
  "administrativo.fps@uaq.mx",
  "Facultad de Psicología y Educación",
  "Dr. Jesús Antonio Moya López",
  "Hoja membretada",
  "",
  "Enviado en digital",
  "Se solicita el material digital editable.",
];

const TEXTS = [
  "279",
  "1/8/26 9:51:26",
  "administrativo.fps@uaq.mx",
  "Facultad de Psicología y Educación",
  "Dr. Jesús Antonio Moya López",
  "Hoja membretada",
  "",
  "Enviado en digital",
  "Se solicita el material digital editable.",
];

const FIELDS = [
  { code: "tipo_papel", name: "Tipo de papel", type: "text", required: true, section: "deliverables" },
  { code: "tiraje", name: "Tiraje", type: "quantity", required: false, section: "deliverables" },
  { code: "fecha_entrega", name: "Fecha de entrega", type: "date", required: false, section: "deliverables" },
  { code: "contacto_correo", name: "Correo del contacto", type: "email", required: true, section: "information" },
];

const MAP = {
  version: 1,
  title: { op: "column", column: "¿Qué tipo de papelería institucional requiere?1" },
  requester: { op: "column", column: "Entidad que solicita" },
  hashColumns: ["Id"],
  fields: {
    tipo_papel: { op: "column", column: "¿Qué tipo de papelería institucional requiere?1" },
    contacto_correo: { op: "column", column: "Correo Institucional de quien solicita" },
  },
};

/** MAP with pieces replaced, so each case says only what it is about. */
const withMap = (changes) => ({ ...MAP, ...changes });
const withFields = (fields) => withMap({ fields: { ...MAP.fields, ...fields } });

const validate = (map, headers = HEADERS) => validateColumnMap(map, FIELDS, headers);
const apply = (map, row = ROW, texts = TEXTS) =>
  applyMapping(validate(map).map, FIELDS, HEADERS, row, texts);

describe("validateColumnMap()", () => {
  test("accepts the map for the real tracker", () => {
    const { map, errors } = validate(MAP);
    assert.deepEqual(errors, []);
    assert.equal(map.version, 1);
    assert.deepEqual(map.hashColumns, ["Id"]);
  });

  test("a title is required: a request needs one", () => {
    const { errors } = validate({ ...MAP, title: undefined });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"title" is required/);
  });

  test("names a column the sheet does not have", () => {
    const { errors } = validate(withFields({ tipo_papel: { op: "column", column: "Tipo de papel" } }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"Tipo de papel", which the sheet does not have/);
  });

  test("names a column that appears twice", () => {
    const repeated = [...HEADERS, "ESTATUS"];
    const { errors } = validateColumnMap(withFields({}), FIELDS, repeated);
    assert.ok(errors.length === 0, "nothing maps ESTATUS here, so the repetition is harmless");

    const using = validateColumnMap(
      withMap({ status: { op: "column", column: "ESTATUS" } }),
      FIELDS,
      repeated,
    );
    assert.match(using.errors.join(" "), /appears 2 times/);
  });

  test("refuses a field the format does not have", () => {
    const { errors } = validate(withFields({ inventado: { op: "column", column: "ESTATUS" } }));
    assert.match(errors.join(" "), /"inventado" is not a field of this format/);
  });

  test("a required field the map does not feed is refused at save time", () => {
    const { errors } = validate({ ...MAP, fields: { tipo_papel: MAP.fields.tipo_papel } });
    assert.match(errors.join(" "), /"Correo del contacto" is required by the format/);
  });

  test("refuses an unknown op and options an op cannot use", () => {
    assert.match(
      validate(withFields({ tiraje: { op: "lookup", column: "Id" } })).errors.join(" "),
      /use one of: column, constant, concat, split/,
    );
    assert.match(
      validate(withFields({ tiraje: { op: "column", column: "Id", nope: 1 } })).errors.join(" "),
      /options it cannot use: nope/,
    );
  });

  test("each op states what it needs", () => {
    const cases = [
      [{ op: "constant" }, /constant with no value/],
      [{ op: "concat" }, /needs a "columns" list/],
      [{ op: "split", column: "Id" }, /needs the "separator"/],
      [{ op: "split", column: "Id", separator: "/" }, /needs "index"/],
      [{ op: "column" }, /needs a column name/],
      [{ op: "column", column: "Id", from: "raw" }, /use "value" or "text"/],
    ];
    for (const [rule, expected] of cases) {
      assert.match(validate(withFields({ tiraje: rule })).errors.join(" "), expected);
    }
  });

  test("only status may translate text to a code", () => {
    const { errors } = validate(withFields({ tiraje: { op: "column", column: "Id", map: { a: "b" } } }));
    assert.match(errors.join(" "), /only "status" translates text to a code/);
  });

  test("the status table has to hold status codes", () => {
    assert.match(
      validate(withMap({ status: { op: "column", column: "ESTATUS", map: { VoBo: "Esperando VB" } } })).errors.join(" "),
      /which is not a status code/,
    );
    assert.match(
      validate(withMap({ status: { op: "column", column: "ESTATUS", default: "En proceso" } })).errors.join(" "),
      /default that is not a status code/,
    );
  });

  test("hashColumns defaults to every column a rule reads", () => {
    const { map } = validate({ ...MAP, hashColumns: undefined });
    assert.deepEqual(map.hashColumns.sort(), [
      "Correo Institucional de quien solicita",
      "Entidad que solicita",
      "¿Qué tipo de papelería institucional requiere?1",
    ].sort());
  });

  test("hashColumns must exist in the sheet and must not be empty", () => {
    assert.match(validate({ ...MAP, hashColumns: ["Folio"] }).errors.join(" "), /which the sheet does not have/);
    assert.match(validate({ ...MAP, hashColumns: [] }).errors.join(" "), /at least one column/);
  });

  test("without headers the column names are not checked", () => {
    const { errors } = validateColumnMap(
      withFields({ tipo_papel: { op: "column", column: "Una columna cualquiera" } }),
      FIELDS,
      null,
    );
    assert.deepEqual(errors, []);
  });

  test("refuses something that is not a map at all", () => {
    for (const bad of [null, [], "mapa"]) {
      assert.match(validateColumnMap(bad, FIELDS, HEADERS).errors.join(" "), /must be an object/);
    }
  });
});

describe("applyMapping()", () => {
  test("reads the real row: the serial becomes a date, the empty quantity is dropped", () => {
    const out = apply(
      withFields({
        tiraje: { op: "column", column: "Si eligió material impreso, favor de indicar la cantidad:" },
        fecha_entrega: { op: "column", column: "Hora de inicio" },
      }),
    );

    assert.deepEqual(out.errors, []);
    assert.equal(out.title, "Hoja membretada");
    assert.equal(out.requester, "Facultad de Psicología y Educación");
    assert.equal(out.data.fecha_entrega, "2026-01-08", "46030.41 is 8 January 2026");
    assert.equal(out.data.contacto_correo, "administrativo.fps@uaq.mx");
    assert.ok(!("tiraje" in out.data), "the cell is empty and the field is optional");
  });

  test("concat joins what is there and skips what is not", () => {
    const out = apply(
      withMap({
        title: {
          op: "concat",
          columns: ["¿Qué tipo de papelería institucional requiere?1", "Entidad que solicita"],
          separator: " — ",
        },
      }),
    );
    assert.equal(out.title, "Hoja membretada — Facultad de Psicología y Educación");

    const withGap = apply(
      withMap({
        title: {
          op: "concat",
          columns: ["Si eligió material impreso, favor de indicar la cantidad:", "Entidad que solicita"],
          separator: " — ",
        },
      }),
    );
    assert.equal(withGap.title, "Facultad de Psicología y Educación", "no dangling separator");
  });

  test("split takes one piece, constant ignores the row", () => {
    const out = apply(
      withMap({
        title: { op: "split", column: "Correo Institucional de quien solicita", separator: "@", index: 1 },
        priority: { op: "constant", value: 7 },
      }),
    );
    assert.equal(out.title, "uaq.mx");
    assert.equal(out.priority, 7);
  });

  test("from: text asks for what Excel displays", () => {
    const value = apply(withMap({ title: { op: "column", column: "Hora de inicio" } }));
    assert.equal(value.title, "46030.4107175926", "the stored value is a serial");

    const text = apply(withMap({ title: { op: "column", column: "Hora de inicio", from: "text" } }));
    assert.equal(text.title, "1/8/26 9:51:26");
  });

  test("from: text falls back to the value when a table offers no text", () => {
    const out = apply(withMap({ title: { op: "column", column: "Entidad que solicita", from: "text" } }), ROW, []);
    assert.equal(out.title, "Facultad de Psicología y Educación");
  });

  test("a default fills an empty cell", () => {
    const out = apply(
      withFields({
        tiraje: {
          op: "column",
          column: "Si eligió material impreso, favor de indicar la cantidad:",
          default: 1,
        },
      }),
    );
    assert.equal(out.data.tiraje, 1);
  });

  test("a row with no title is an error, not a request", () => {
    const blank = [...ROW];
    blank[5] = "";
    const out = apply(MAP, blank, TEXTS);

    assert.deepEqual(out.errors.map((e) => e.key), ["title"]);
    assert.match(out.errors[0].message, /nothing to use as a title/);
  });

  test("a required field the sheet left empty comes in missing, it does not stop the row", () => {
    const blank = [...ROW];
    blank[5] = "";
    const out = apply(MAP, blank, TEXTS);

    assert.deepEqual(out.missingRequired, ["tipo_papel"]);
    assert.ok(
      out.warnings.some((w) => w.key === "tipo_papel" && /comes in missing/.test(w.message)),
      "it is said as a warning, not as a refusal",
    );
    assert.equal(out.data.tipo_papel, undefined, "nothing is invented for it");
  });

  test("a required field that will not coerce stops the row; an optional one warns", () => {
    const dirty = [...ROW];
    dirty[2] = "no-es-un-correo";
    dirty[6] = "muchísimos";

    const out = apply(
      withFields({
        tiraje: { op: "column", column: "Si eligió material impreso, favor de indicar la cantidad:" },
      }),
      dirty,
      TEXTS,
    );

    assert.deepEqual(out.errors.map((e) => e.key), ["contacto_correo"]);
    assert.deepEqual(out.warnings.map((w) => w.key), ["tiraje"]);
    assert.ok(!("tiraje" in out.data), "a value that could not be read is not stored");
  });

  describe("status", () => {
    const statusMap = withMap({
      status: {
        op: "column",
        column: "ESTATUS",
        map: { VoBo: "esperando_vb", "Enviado en digital": "entregado" },
        default: "recibido",
      },
    });

    test("translates the sheet's own vocabulary", () => {
      assert.equal(apply(statusMap).statusCode, "entregado");

      const vobo = [...ROW];
      vobo[7] = "VoBo";
      assert.equal(apply(statusMap, vobo, TEXTS).statusCode, "esperando_vb");
    });

    test("matches regardless of casing", () => {
      const shouted = [...ROW];
      shouted[7] = "VOBO";
      assert.equal(apply(statusMap, shouted, TEXTS).statusCode, "esperando_vb");
    });

    test("an unlisted status takes the default and says so", () => {
      const odd = [...ROW];
      odd[7] = "Pendiente de cotizar";
      const out = apply(statusMap, odd, TEXTS);

      assert.equal(out.statusCode, "recibido");
      assert.deepEqual(out.warnings.map((w) => w.key), ["status"]);
      assert.match(out.warnings[0].message, /"Pendiente de cotizar" is not in the map's table/);
    });

    test("an empty status takes the default silently", () => {
      const blank = [...ROW];
      blank[7] = "";
      const out = apply(statusMap, blank, TEXTS);

      assert.equal(out.statusCode, "recibido");
      assert.deepEqual(out.warnings, []);
    });

    test("no status slot means no status to resolve", () => {
      assert.equal(apply(MAP).statusCode, null);
    });
  });

  test("sourceData keeps every column, including the ones no rule reads (RF-SOL-06)", () => {
    const out = apply(MAP);

    assert.equal(Object.keys(out.sourceData).length, HEADERS.length);
    assert.equal(out.sourceData["NOTAS ADICIONALES"], "Se solicita el material digital editable.");
    assert.equal(out.sourceData.Id, 279);
  });

  test("a blank header keeps its position rather than colliding", () => {
    const headers = ["Id", "", ""];
    const out = applyMapping(
      validateColumnMap({ version: 1, title: { op: "column", column: "Id" }, hashColumns: ["Id"], fields: {} }, [], headers).map,
      [],
      headers,
      [1, "a", "b"],
    );
    assert.deepEqual(out.sourceData, { Id: 1, column_1: "a", column_2: "b" });
  });
});

describe("rowHash()", () => {
  const hashed = (map, row, headers = HEADERS) => rowHash(validate(map, headers).map, headers, row);

  test("the same row hashes the same, a different one does not", () => {
    assert.equal(hashed(MAP, ROW), hashed(MAP, ROW));

    const other = [...ROW];
    other[0] = 283;
    assert.notEqual(hashed(MAP, ROW), hashed(MAP, other));
  });

  test("hashing the Id ignores an edit elsewhere -- the row is the row", () => {
    const edited = [...ROW];
    edited[3] = "Facultad de Psicología";
    assert.equal(hashed(MAP, ROW), hashed(MAP, edited));
  });

  test("hashing content notices that edit", () => {
    const byContent = { ...MAP, hashColumns: ["Entidad que solicita"] };
    const edited = [...ROW];
    edited[3] = "Facultad de Psicología";
    assert.notEqual(hashed(byContent, ROW), hashed(byContent, edited));
  });

  test("casing and stray whitespace are not a different row", () => {
    const byContent = { ...MAP, hashColumns: ["Entidad que solicita"] };
    const cosmetic = [...ROW];
    cosmetic[3] = "  FACULTAD  de Psicología y Educación ";
    assert.equal(hashed(byContent, ROW), hashed(byContent, cosmetic));
  });

  test("column order does not change the hash", () => {
    const order = [1, 0, ...HEADERS.map((_, index) => index).slice(2)];
    const swapped = order.map((index) => HEADERS[index]);
    const swappedRow = order.map((index) => ROW[index]);

    assert.deepEqual([...swapped].sort(), [...HEADERS].sort(), "the same columns, moved");
    assert.equal(hashed(MAP, ROW), hashed(MAP, swappedRow, swapped));
  });

  test("two columns cannot be confused for one", () => {
    const map = { hashColumns: ["a", "b"] };
    const headers = ["a", "b"];

    assert.notEqual(
      rowHash(map, headers, ["ab", "c"]),
      rowHash(map, headers, ["a", "bc"]),
    );
  });

  test("a missing column hashes as empty rather than throwing", () => {
    assert.match(rowHash({ hashColumns: ["No existe"] }, HEADERS, ROW), /^[0-9a-f]{64}$/);
  });
});
