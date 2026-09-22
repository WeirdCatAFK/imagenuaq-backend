import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { coerce, validateData } from "../src/utils/fieldValues.js";

// Pure: no server, no database. The three callers -- the request API, the project API and the
// sheet import -- share this, so a value typed into a form and the same value read out of a cell
// have to land identically.
describe("coerce()", () => {
  const value = (type, raw, options) => coerce(type, raw, options).value;
  const error = (type, raw, options) => coerce(type, raw, options).error;

  test("an empty input is null and never an error", () => {
    for (const type of ["text", "email", "quantity", "date", "boolean"]) {
      for (const raw of [null, undefined, "", "   "]) {
        assert.deepEqual(coerce(type, raw), { value: null, error: null });
      }
    }
  });

  test("text, location and document trim and pass through", () => {
    assert.equal(value("text", "  Papel membretado "), "Papel membretado");
    assert.equal(value("location", " Auditorio A "), "Auditorio A");
    assert.equal(value("document", "acta.pdf"), "acta.pdf");
    assert.equal(value("text", 42), "42", "a number in a text field is its text");
  });

  test("email lowercases and validates", () => {
    assert.equal(value("email", " Alma.Rodriguez@UAQ.MX "), "alma.rodriguez@uaq.mx");
    assert.match(error("email", "no-es-correo"), /valid email/);
    assert.match(error("email", "dos@@uaq.mx"), /valid email/);
  });

  test("phone keeps the punctuation a number is written with", () => {
    assert.equal(value("phone", "442 123 4567"), "442 123 4567");
    assert.equal(value("phone", "+52 (442) 123-4567 ext. 1"), null, "letters are refused");
    assert.equal(value("phone", "  442   192   1200 "), "442 192 1200", "spaces collapse");
    assert.match(error("phone", "123"), /valid phone/);
  });

  test("url requires http or https", () => {
    assert.equal(value("url", "https://uaq.mx/logo.png"), "https://uaq.mx/logo.png");
    assert.match(error("url", "ftp://uaq.mx"), /http or https/);
    assert.match(error("url", "uaq.mx"), /valid link/);
  });

  test("quantity is a whole number and strips separators", () => {
    assert.equal(value("quantity", "1,250"), 1250);
    assert.equal(value("quantity", 500), 500);
    assert.equal(value("quantity", " 500 "), 500);
    assert.match(error("quantity", "12.5"), /whole number/);
    assert.match(error("quantity", "-1"), /negative/);
    assert.match(error("quantity", "muchos"), /not a number/);
  });

  test("currency strips money and rounds to cents", () => {
    assert.equal(value("currency", "$1,250.50"), 1250.5);
    assert.equal(value("currency", "1250.567"), 1250.57);
    assert.equal(value("currency", "1,5"), 1.5, "a decimal comma, as Spanish writes it");
    assert.match(error("currency", "gratis"), /not an amount/);
  });

  test("percentage strips the sign and bounds itself", () => {
    assert.equal(value("percentage", "45 %"), 45);
    assert.equal(value("percentage", 0), 0);
    assert.match(error("percentage", "120"), /between 0 and 100/);
  });

  describe("date", () => {
    test("an Excel serial becomes an ISO date", () => {
      // 45000 is 2023-03-15 counting from 1899-12-30, which is the epoch the 1900 leap-year
      // bug forces.
      assert.equal(value("date", 45000), "2023-03-15");
      assert.equal(value("date", "45000"), "2023-03-15", "a serial that arrived as text");
      assert.equal(value("date", 61), "1900-03-01", "the first serial the epoch maps correctly");
      // 1 to 60 fall in the range Excel's fake 1900-02-29 corrupts, so they are refused rather
      // than answered a day off. A 1900 delivery date is a typo anyway.
      assert.match(error("date", 1), /valid date/);
      assert.match(error("date", 60), /valid date/);
      assert.match(error("date", 0), /valid date/);
      assert.match(error("date", 9_999_999), /valid date/);
    });

    test("a serial with a fraction carries the time when the type wants it", () => {
      assert.equal(value("date", 45000.5), "2023-03-15");
      assert.equal(value("datetime", 45000.5), "2023-03-15T12:00:00.000Z");
    });

    test("ISO passes through whatever format says", () => {
      assert.equal(value("date", "2026-05-01", { format: "MM/DD/YYYY" }), "2026-05-01");
      assert.equal(value("datetime", "2026-05-01T14:30:00Z"), "2026-05-01T14:30:00.000Z");
    });

    test("the ambiguous 03/04/2026 is resolved by format, not guessed", () => {
      assert.equal(value("date", "03/04/2026"), "2026-04-03", "DD/MM/YYYY is the default");
      assert.equal(value("date", "03/04/2026", { format: "DD/MM/YYYY" }), "2026-04-03");
      assert.equal(value("date", "03/04/2026", { format: "MM/DD/YYYY" }), "2026-03-04");
    });

    test("separators and a time on the end are tolerated", () => {
      assert.equal(value("date", "1-5-2026"), "2026-05-01");
      assert.equal(value("date", "1.5.2026"), "2026-05-01");
      assert.equal(value("datetime", "1/5/2026 14:30"), "2026-05-01T14:30:00.000Z");
    });

    test("an impossible day is refused rather than rolled over", () => {
      assert.match(error("date", "31/02/2026"), /valid date/);
      assert.match(error("date", "40/01/2026"), /valid date/);
      assert.match(error("date", "mayo"), /written as DD\/MM\/YYYY/);
      assert.match(error("date", "1/5/2026", { format: "YYYY.MM" }), /not a known date format/);
    });
  });

  describe("boolean", () => {
    test("the Spanish defaults", () => {
      for (const raw of ["sí", "SI", "s", "yes", "true", "1", "x"]) {
        assert.equal(value("boolean", raw), true, `${raw} is true`);
      }
      for (const raw of ["no", "N", "false", "0"]) {
        assert.equal(value("boolean", raw), false, `${raw} is false`);
      }
      assert.equal(value("boolean", true), true);
      assert.equal(value("boolean", 0), false);
    });

    test("a mapping may name its own words", () => {
      assert.equal(value("boolean", "urgente", { truthy: ["urgente"] }), true);
      assert.match(error("boolean", "quizás"), /yes or no/);
    });
  });

  test("an unknown type passes the text through rather than emptying it", () => {
    assert.equal(value("tipo_que_no_existe", " algo "), "algo");
  });
});

describe("validateData()", () => {
  const FIELDS = [
    { code: "descripcion", name: "Descripción", type: "text", required: true, section: "deliverables" },
    { code: "tiraje", name: "Tiraje", type: "quantity", required: true, section: "deliverables" },
    { code: "fecha_entrega", name: "Fecha de entrega", type: "date", required: false, section: "deliverables", options: { format: "DD/MM/YYYY" } },
    { code: "urgente", name: "Urgente", type: "boolean", required: false, section: "information" },
  ];

  test("coerces every field and reports nothing when all is well", () => {
    const out = validateData(FIELDS, {
      descripcion: "  Carteles ",
      tiraje: "1,000",
      fecha_entrega: "15/03/2026",
      urgente: "sí",
    });

    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warnings, []);
    assert.deepEqual(out.data, {
      descripcion: "Carteles",
      tiraje: 1000,
      fecha_entrega: "2026-03-15",
      urgente: true,
    });
  });

  test("a missing required field is an error naming it", () => {
    const out = validateData(FIELDS, { descripcion: "Carteles" });

    assert.deepEqual(out.errors.map((e) => e.key), ["tiraje"]);
    assert.match(out.errors[0].message, /"Tiraje" is required/);
  });

  test("an optional field left out is simply absent", () => {
    const out = validateData(FIELDS, { descripcion: "X", tiraje: 1 });

    assert.deepEqual(out.errors, []);
    assert.ok(!("fecha_entrega" in out.data));
  });

  test("strict makes a dirty value an error; loose makes it a warning", () => {
    const dirty = { descripcion: "X", tiraje: "muchos" };

    const strict = validateData(FIELDS, dirty);
    assert.deepEqual(strict.errors.map((e) => e.key), ["tiraje"]);
    assert.match(strict.errors[0].message, /is not a number/);

    // The import wants the row reported, not the run stopped -- but a required field that could
    // not be read is still an error, or the request would arrive without it.
    const loose = validateData(FIELDS, dirty, { strict: false });
    assert.deepEqual(loose.warnings.map((w) => w.key), ["tiraje"]);
    assert.deepEqual(loose.errors.map((e) => e.key), ["tiraje"]);
    assert.ok(!("tiraje" in loose.data), "a value that could not be read is not stored");
  });

  test("an optional field that is dirty is a warning and nothing else, when loose", () => {
    const out = validateData(FIELDS, { descripcion: "X", tiraje: 1, fecha_entrega: "el jueves" }, { strict: false });

    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warnings.map((w) => w.key), ["fecha_entrega"]);
  });

  test("every complaint comes back at once, not just the first", () => {
    const out = validateData(FIELDS, { tiraje: "-5", urgente: "quizás" });

    assert.deepEqual(out.errors.map((e) => e.key).sort(), ["descripcion", "tiraje", "urgente"]);
  });

  test("unknown keys are kept and flagged (RF-SOL-06)", () => {
    const out = validateData(FIELDS, {
      descripcion: "X",
      tiraje: 1,
      columna_vieja: "algo que ya no se pide",
    });

    assert.deepEqual(out.errors, []);
    assert.equal(out.data.columna_vieja, "algo que ya no se pide");
    assert.deepEqual(out.warnings.map((w) => w.key), ["columna_vieja"]);
  });

  test("data that is not an object is one error, not a crash", () => {
    assert.deepEqual(validateData(FIELDS, "no soy un objeto").errors, [
      { key: "data", message: "data must be an object." },
    ]);
    assert.deepEqual(validateData(FIELDS, [1, 2]).errors, [
      { key: "data", message: "data must be an object." },
    ]);
  });

  test("no fields and no data is empty rather than broken", () => {
    assert.deepEqual(validateData([], {}), { data: {}, errors: [], warnings: [] });
    assert.deepEqual(validateData(undefined, undefined).errors, []);
  });
});
