// How a spreadsheet row becomes a request. Pure: no database, no Graph, no HTTP.
//
// A column map is the declarative half of RF-MIG-02, stored in `sheets.column_map` and edited by
// coordination without a deploy. It names, per target, which column feeds it and how:
//
//   { "version": 1,
//     "title":     { "op": "concat", "columns": ["Nombre", "Entidad que solicita"], "separator": " — " },
//     "requester": { "op": "column", "column": "Entidad que solicita" },
//     "priority":  { "op": "constant", "value": 0 },
//     "status":    { "op": "column", "column": "ESTATUS",
//                    "map": { "VoBo": "esperando_vb", "Enviado en digital": "entregado" },
//                    "default": "recibido" },   // a status CODE, not a cell value
//     "hashColumns": ["Id"],
//     "fields": {
//       "tiraje":        { "op": "column", "column": "Si eligió material impreso, ..." },
//       "fecha_entrega": { "op": "column", "column": "Hora de inicio" },
//       "contacto_correo": { "op": "column", "column": "Correo Institucional de quien solicita" } } }
//
// **Columns are named by their header text, not by position.** A tracker gets columns inserted
// and reordered constantly; renaming one is rarer and is a deliberate act. The cost, stated: a
// renamed header makes the import refuse and say which column disappeared, rather than quietly
// importing the wrong column's values.
//
// **The target's type decides the coercion, never the rule.** A rule may say what order a date
// is written in (`format`) or which words mean yes (`truthy`), because only the sheet knows that.
// It may not say that a `quantity` should be read as a date: `utils/fieldValues.js` takes the
// field's `data_types.code` and the rule's options, in that order of authority.
//
// **`texts` exists because Excel has two answers.** A real date in a cell arrives as a serial
// number and the same date typed by hand arrives as a string; `from: "text"` asks for what Excel
// displays. The probe script prints both so a person can see which a column holds.
//
// **A required field the sheet left empty does not reject the row.** The request comes in
// incomplete, with the field named in `missingRequired`; the inbox says so and conversion to a
// project is what refuses until somebody fills it. A tracker always carries rows that were
// started and never finished, and leaving them outside the system is how they get lost. A cell
// that *has* a value the field's type cannot read is a different thing and still rejects the row:
// there the sheet says something, and importing it wrong would be worse than not importing it.
//
// **`hashColumns` is the row's identity, and an Id column is better than content.** The papel
// institucional tracker carries a Forms `Id`, so hashing that alone means correcting a typo in
// the sheet does not look like a new row. The consequence, accepted: an edit after the import is
// then invisible, because the row is recognised and skipped -- the state lives in the app from
// the import onwards. With no such column the hash falls back to every referenced cell, and then
// an edit does read as a new row and is flagged as a probable duplicate.
import { createHash } from "node:crypto";

import { coerce } from "./fieldValues.js";

/** The ops a rule may use. `status` also accepts `map`; nothing else does. */
const OPS = ["column", "constant", "concat", "split"];

/**
 * Where each op takes its value from. A key an op cannot use is dropped rather than stored: a
 * `constant` that still remembers the column somebody tried first reads like a rule that uses
 * it, and the next person to open the wizard believes the stored map.
 */
const SOURCE_KEYS = {
  column: ["column", "from"],
  constant: ["value"],
  concat: ["columns", "separator", "from"],
  split: ["column", "separator", "index", "from"],
};

/** Kept whatever the op is: they say how the value is read, not where it comes from. */
const READING_KEYS = ["default", "format", "truthy", "falsy", "map"];

/** The slots beside `fields`, and whether one is required. */
const SLOTS = [
  { key: "title", required: true },
  { key: "requester", required: false },
  { key: "priority", required: false },
  { key: "status", required: false },
];

/** Options a rule may carry for its target's type; anything else is a typo worth naming. */
const RULE_OPTIONS = ["from", "default", "format", "truthy", "falsy", "map", "separator", "index", "columns", "column", "value", "op"];

/**
 * Checks a column map and returns it normalised.
 *
 * @param {object} map The document as the client sent it.
 * @param {object[]} fields The target version's fields, flattened (`fieldList()`).
 * @param {unknown[]} [headers] The sheet's header row. When given, every column a rule names
 *   must exist in it exactly once -- which is the check that catches a renamed column at save
 *   time instead of at import time.
 * @returns {{ map: object, errors: string[] }} `errors` empty means the map is usable.
 */
export function validateColumnMap(map, fields, headers = null) {
  const errors = [];

  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { map: null, errors: ["The column map must be an object."] };
  }

  const known = new Map((fields ?? []).map((field) => [field.code, field]));
  const headerList = Array.isArray(headers) ? headers.map((header) => String(header ?? "")) : null;
  const out = { version: 1, fields: {} };
  /** Field codes whose rule was read, right or wrong: they do not also count as unfed. */
  const attempted = new Set();

  const check = (rule, where, target) => {
    const problems = checkRule(rule, where, target, headerList);
    errors.push(...problems);
    return problems.length === 0;
  };

  for (const slot of SLOTS) {
    const rule = map[slot.key];
    if (rule === undefined || rule === null) {
      if (slot.required) errors.push(`"${slot.key}" is required: a request needs one.`);
      continue;
    }
    if (check(rule, `"${slot.key}"`, null)) out[slot.key] = normaliseRule(rule);
  }

  if (out.status !== undefined) errors.push(...checkStatusRule(out.status));

  const fieldRules = map.fields ?? {};
  if (typeof fieldRules !== "object" || Array.isArray(fieldRules)) {
    errors.push('"fields" must be an object keyed by field code.');
  } else {
    for (const [code, rule] of Object.entries(fieldRules)) {
      const field = known.get(code);
      if (field === undefined) {
        errors.push(`"${code}" is not a field of this format.`);
        continue;
      }
      attempted.add(code);
      if (check(rule, `field "${code}"`, field)) out.fields[code] = normaliseRule(rule);
    }
  }

  for (const field of fields ?? []) {
    if (field.required && out.fields[field.code] === undefined && !attempted.has(field.code)) {
      errors.push(`"${field.name}" is required by the format, so the map has to feed it.`);
    }
  }

  const hashColumns = map.hashColumns ?? defaultHashColumns(out);
  if (!Array.isArray(hashColumns) || hashColumns.length === 0) {
    errors.push('"hashColumns" must name at least one column: it is how a row is recognised.');
  } else {
    out.hashColumns = [...new Set(hashColumns.map((column) => String(column)))];
    if (headerList !== null) {
      for (const column of out.hashColumns) {
        if (!headerList.includes(column)) {
          errors.push(`"hashColumns" names ${JSON.stringify(column)}, which the sheet does not have.`);
        }
      }
    }
  }

  return { map: errors.length === 0 ? out : null, errors };
}

/**
 * One row through the map.
 *
 * @param {object} map A validated map.
 * @param {object[]} fields The version's fields, flattened.
 * @param {unknown[]} headers
 * @param {unknown[]} row The row's values.
 * @param {unknown[]} [texts] The same row as Excel displays it, for `from: "text"`.
 * @returns {{ title: string|null, requester: string|null, priority: number,
 *   statusCode: string|null, data: object, missingRequired: string[], sourceData: object,
 *   sourceHash: string, errors: {key: string, message: string}[],
 *   warnings: {key: string, message: string}[] }} `missingRequired` names the required fields the
 *   row left empty: the request comes in anyway and conversion is what refuses until they exist.
 */
export function applyMapping(map, fields, headers, row, texts = []) {
  const errors = [];
  const warnings = [];
  const cells = { headers: headers.map((header) => String(header ?? "")), row, texts };

  const title = readRule(map.title, cells);
  const requester = map.requester === undefined ? null : readRule(map.requester, cells);
  const rawPriority = map.priority === undefined ? 0 : readRule(map.priority, cells);
  const priority = Number.isFinite(Number(rawPriority)) ? Math.trunc(Number(rawPriority)) : 0;

  if (title === null || String(title).trim() === "") {
    errors.push({ key: "title", message: "The row has nothing to use as a title." });
  }

  let statusCode = null;
  if (map.status !== undefined) {
    const { default: fallback, ...reader } = map.status;
    const raw = readRule(reader, cells);
    const text = raw === null ? "" : String(raw).trim();
    const table = map.status.map ?? {};
    const matched = Object.keys(table).find((key) => key.toLowerCase() === text.toLowerCase());

    if (matched !== undefined) statusCode = table[matched];
    else {
      statusCode = fallback ?? null;
      if (text !== "") {
        warnings.push({
          key: "status",
          message: `Status ${JSON.stringify(text)} is not in the map's table; used ${statusCode ?? "the default"}.`,
        });
      }
    }
  }

  const data = {};
  const missingRequired = [];
  for (const field of fields) {
    const rule = map.fields[field.code];
    if (rule === undefined) continue;

    const raw = readRule(rule, cells);
    const { value, error } = coerce(field.type, raw, rule);

    if (error !== null) {
      const message = `"${field.name}" ${error}.`;
      if (field.required) errors.push({ key: field.code, message });
      else warnings.push({ key: field.code, message });
      continue;
    }

    if (value === null) {
      if (field.required) {
        missingRequired.push(field.code);
        warnings.push({
          key: field.code,
          message: `"${field.name}" is required and the row has no value; it comes in missing.`,
        });
      }
      continue;
    }

    data[field.code] = value;
  }

  return {
    missingRequired,
    title: title === null ? null : String(title).trim(),
    requester: requester === null || String(requester).trim() === "" ? null : String(requester).trim(),
    priority,
    statusCode,
    data,
    sourceData: rawRow(cells),
    sourceHash: rowHash(map, headers, row),
    errors,
    warnings,
  };
}

/**
 * The row's identity: a sha256 over the cells `hashColumns` names, normalised so that a
 * whitespace or casing change is not a different row.
 *
 * @param {object} map A validated map.
 * @param {unknown[]} headers
 * @param {unknown[]} row
 * @returns {string} 64 hex characters.
 */
export function rowHash(map, headers, row) {
  const list = headers.map((header) => String(header ?? ""));
  const parts = (map.hashColumns ?? []).map((column) => {
    const index = list.indexOf(column);
    return index === -1 ? "" : normaliseForHash(row[index]);
  });

  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** Every column any rule reads, for the fallback identity when no Id column was named. */
function defaultHashColumns(map) {
  const columns = new Set();
  const collect = (rule) => {
    if (!rule || typeof rule !== "object") return;
    if (typeof rule.column === "string") columns.add(rule.column);
    for (const column of rule.columns ?? []) if (typeof column === "string") columns.add(column);
  };

  for (const slot of SLOTS) collect(map[slot.key]);
  for (const rule of Object.values(map.fields ?? {})) collect(rule);
  return [...columns];
}

function checkRule(rule, where, target, headerList) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return [`${where} must be an object with an "op".`];
  }

  const op = rule.op;
  if (!OPS.includes(op)) {
    return [`${where} has op ${JSON.stringify(op ?? null)}; use one of: ${OPS.join(", ")}.`];
  }

  const errors = [];
  const unknown = Object.keys(rule).filter((key) => !RULE_OPTIONS.includes(key));
  if (unknown.length > 0) errors.push(`${where} has options it cannot use: ${unknown.join(", ")}.`);

  const needsColumn = (column) => {
    if (typeof column !== "string" || column === "") {
      errors.push(`${where} needs a column name.`);
      return;
    }
    if (headerList === null) return;
    const seen = headerList.filter((header) => header === column).length;
    if (seen === 0) errors.push(`${where} names the column ${JSON.stringify(column)}, which the sheet does not have.`);
    if (seen > 1) errors.push(`${where} names ${JSON.stringify(column)}, which appears ${seen} times in the sheet.`);
  };

  if (op === "column") needsColumn(rule.column);

  if (op === "constant" && (rule.value === undefined || rule.value === null)) {
    errors.push(`${where} is a constant with no value.`);
  }

  if (op === "concat") {
    if (!Array.isArray(rule.columns) || rule.columns.length === 0) {
      errors.push(`${where} needs a "columns" list to join.`);
    } else rule.columns.forEach(needsColumn);
  }

  if (op === "split") {
    needsColumn(rule.column);
    if (typeof rule.separator !== "string" || rule.separator === "") {
      errors.push(`${where} needs the "separator" to split on.`);
    }
    if (!Number.isInteger(rule.index) || rule.index < 0) {
      errors.push(`${where} needs "index", a whole number from 0.`);
    }
  }

  if (rule.from !== undefined && rule.from !== "value" && rule.from !== "text") {
    errors.push(`${where} has from ${JSON.stringify(rule.from)}; use "value" or "text".`);
  }

  if (rule.map !== undefined && target !== null) {
    errors.push(`${where} cannot carry a "map": only "status" translates text to a code.`);
  }

  return errors;
}

/**
 *  The status slot's table: text to a status code, which orchestration resolves against the catalogue.
 */
function checkStatusRule(rule) {
  const errors = [];
  const table = rule.map;

  if (table !== undefined) {
    if (!table || typeof table !== "object" || Array.isArray(table)) {
      errors.push('"status" needs "map" to be an object of sheet text to status code.');
    } else {
      for (const [text, code] of Object.entries(table)) {
        if (typeof code !== "string" || !/^[a-z][a-z0-9_]*$/.test(code)) {
          errors.push(`"status" maps ${JSON.stringify(text)} to ${JSON.stringify(code)}, which is not a status code.`);
        }
      }
    }
  }

  if (rule.default !== undefined && !/^[a-z][a-z0-9_]*$/.test(String(rule.default))) {
    errors.push('"status" has a default that is not a status code.');
  }

  return errors;
}

/** Drops the keys an op does not use, so what is stored is what is read. */
function normaliseRule(rule) {
  const out = { op: rule.op };
  for (const key of [...(SOURCE_KEYS[rule.op] ?? []), ...READING_KEYS]) {
    if (rule[key] !== undefined) out[key] = rule[key];
  }
  return out;
}

/** The cell a rule points at, in the shape the rule asked for. */
function cellAt(cells, column, from) {
  const index = cells.headers.indexOf(column);
  if (index === -1) return null;

  if (from === "text") {
    const text = cells.texts?.[index];
    if (text !== undefined && text !== null && text !== "") return text;
  }
  return cells.row[index] ?? null;
}

/** One rule against one row. Null when there is nothing there. */
function readRule(rule, cells) {
  if (rule === undefined || rule === null) return null;

  switch (rule.op) {
    case "constant":
      return rule.value;

    case "column": {
      const value = cellAt(cells, rule.column, rule.from);
      return isEmpty(value) ? (rule.default ?? null) : value;
    }

    case "concat": {
      const parts = rule.columns
        .map((column) => cellAt(cells, column, rule.from))
        .filter((value) => !isEmpty(value))
        .map((value) => String(value).trim());
      return parts.length === 0 ? (rule.default ?? null) : parts.join(rule.separator ?? " ");
    }

    case "split": {
      const value = cellAt(cells, rule.column, rule.from);
      if (isEmpty(value)) return rule.default ?? null;
      const parts = String(value).split(rule.separator);
      const part = parts[rule.index];
      return part === undefined || part.trim() === "" ? (rule.default ?? null) : part.trim();
    }

    default:
      return null;
  }
}

/** The row keyed by header, for `requests.source_data`. Blank headers keep their position. */
function rawRow(cells) {
  const out = {};
  cells.headers.forEach((header, index) => {
    const key = header === "" ? `column_${index}` : header;
    out[key] = cells.row[index] ?? null;
  });
  return out;
}

function isEmpty(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/** Trimmed, collapsed and lowercased: the same row after a cosmetic edit is the same row. */
function normaliseForHash(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}
