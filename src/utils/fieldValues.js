// What a captured value becomes, per data type. Pure: no database, no HTTP.
//
// The same value arrives three ways -- typed into a form, sent by an API client, read out of an
// Excel cell -- and all three have to end up as the same thing in `requests.data`, or the
// inbox shows one date as `45000` and another as `15/03/2023`. So the coercion lives here and
// the three callers share it: `orchestration/requests.js`, `orchestration/projects.js` and the
// sheet import.
//
// **The type decides the coercion, never the rule.** A column map may say what format a date
// string is written in, but not that a `quantity` should be parsed as a date. That is why
// `coerce()` takes the `data_types.code` first and the options second.
//
// **Excel numbers are the interesting case.** A real date in a worksheet arrives from Graph as
// a serial number -- days since 1899-12-30, with the time as a fraction -- while a date somebody
// typed as text arrives as a string. Both are accepted: a number goes through the serial
// conversion, a string through `format`.
//
// The 1899-12-30 epoch is what makes every modern date come out right, and it is a consequence
// of the 1900 leap-year bug Excel keeps for compatibility: it counts a 1900-02-29 that never
// existed. The cost is that serials 1 to 60 -- January and February 1900 -- land a day off under
// that epoch, so they are **refused** rather than answered with the wrong day. A tracker whose
// delivery date is in 1900 has a typo, not a date.
//
// Nothing here throws: every function answers `{ value, error }` or `{ data, errors }`, because
// the import needs to report twenty bad rows rather than stop at the first, and the API needs
// to answer with every complaint at once.

/** Excel's day zero. 1899-12-30, because the 1900 leap-year bug shifts everything by one. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/** 61 is 1900-03-01, the first serial the epoch above maps correctly (see the header). */
const MIN_EXCEL_SERIAL = 61;
/** 2958465 is 9999-12-31; past it the value is not a date anybody typed. */
const MAX_EXCEL_SERIAL = 2_958_465;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What `boolean` reads as true or false when nothing else is said. Spanish first. */
const TRUTHY = ["sí", "si", "s", "yes", "y", "true", "verdadero", "1", "x"];
const FALSY = ["no", "n", "false", "falso", "0", ""];

/** The date orders a person might have written, as tokens a mapping can name. */
const DATE_FORMATS = {
  "DD/MM/YYYY": { day: 0, month: 1, year: 2 },
  "MM/DD/YYYY": { month: 0, day: 1, year: 2 },
  "YYYY-MM-DD": { year: 0, month: 1, day: 2 },
};

export const DATE_FORMAT_TOKENS = Object.keys(DATE_FORMATS);

/**
 * One value into what its type says it is.
 *
 * @param {string} dataType A `data_types.code`.
 * @param {unknown} raw
 * @param {{ format?: string, truthy?: string[], falsy?: string[] }} [options]
 * @returns {{ value: unknown, error: string|null }} `value` is null when the input was empty;
 *   an empty input is never an error here -- whether it is allowed is `required`'s business.
 */
export function coerce(dataType, raw, options = {}) {
  if (isEmpty(raw)) return ok(null);

  switch (dataType) {
    case "text":
    case "location":
    case "document":
      return ok(text(raw));

    case "email": {
      const value = text(raw).toLowerCase();
      return EMAIL.test(value) ? ok(value) : bad("is not a valid email address");
    }

    case "phone": {
      // Digits, spaces and the punctuation a phone number is written with. Not validated
      // against a country plan: the interviews list extensions and internal numbers.
      const value = text(raw);
      return /^[\d\s()+.-]{5,50}$/.test(value)
        ? ok(value.replace(/\s+/g, " "))
        : bad("is not a valid phone number");
    }

    case "url": {
      const value = text(raw);
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:"
          ? ok(url.toString())
          : bad("must be an http or https link");
      } catch {
        return bad("is not a valid link");
      }
    }

    case "quantity": {
      const value = number(raw);
      if (value === null) return bad("is not a number");
      if (!Number.isInteger(value)) return bad("must be a whole number");
      if (value < 0) return bad("must not be negative");
      return ok(value);
    }

    case "currency": {
      const value = number(raw);
      if (value === null) return bad("is not an amount");
      // Two decimals: money, and the print shop quotes in pesos and cents.
      return ok(Math.round(value * 100) / 100);
    }

    case "percentage": {
      const value = number(raw);
      if (value === null) return bad("is not a percentage");
      if (value < 0 || value > 100) return bad("must be between 0 and 100");
      return ok(value);
    }

    case "date":
      return date(raw, options, false);

    case "datetime":
      return date(raw, options, true);

    case "boolean":
      return boolean(raw, options);

    default:
      // An unknown type is a schema problem, not a value problem, and the schema validator
      // already refuses one. Passing the text through keeps a data type added tomorrow from
      // silently emptying today's captures.
      return ok(text(raw));
  }
}

/**
 * A whole capture against a format's fields.
 *
 * Unknown keys are **kept**: `RF-SOL-06` says nothing the requester sent is dropped, and a
 * format that loses a field in its next version must not erase what was captured under the old
 * one. They are reported as warnings so a mapping typo is visible.
 *
 * @param {object[]} fields The flattened field list (`fieldList()` in orchestration/schemas.js).
 * @param {object} data
 * @param {{ strict?: boolean }} [options] `strict` (the default) makes a coercion failure an
 *   error; false records it as a warning and stores null, which is what a bulk import wants
 *   when a single cell is dirty.
 * @returns {{ data: object, errors: {key: string, message: string}[],
 *   warnings: {key: string, message: string}[] }}
 */
export function validateData(fields, data, { strict = true } = {}) {
  const errors = [];
  const warnings = [];
  const out = {};

  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  if (data !== undefined && data !== null && source !== data) {
    return { data: {}, errors: [{ key: "data", message: "data must be an object." }], warnings };
  }

  for (const field of fields ?? []) {
    const { value, error } = coerce(field.type, source[field.code], field.options ?? {});

    if (error !== null) {
      const message = `"${field.name}" ${error}.`;
      if (strict) errors.push({ key: field.code, message });
      else warnings.push({ key: field.code, message });
      // A dirty value is not stored: null is honest, the raw text is a lie about its type.
      if (field.required && !strict) {
        errors.push({ key: field.code, message: `"${field.name}" is required.` });
      }
      continue;
    }

    if (value === null) {
      if (field.required) errors.push({ key: field.code, message: `"${field.name}" is required.` });
      continue;
    }

    out[field.code] = value;
  }

  const known = new Set((fields ?? []).map((field) => field.code));
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key)) continue;
    out[key] = value;
    warnings.push({ key, message: `"${key}" is not a field of this format; kept as captured.` });
  }

  return { data: out, errors, warnings };
}

/* HELPERS */

function ok(value) {
  return { value, error: null };
}

function bad(error) {
  return { value: null, error };
}

function isEmpty(raw) {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

function text(raw) {
  return typeof raw === "string" ? raw.trim() : String(raw);
}

/**
 * A number out of what a spreadsheet or a form offers: `1,250`, `$1,250.50`, `45 %`, `1250`.
 * Null when what is left is not a number.
 */
function number(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return null;

  const cleaned = text(raw)
    .replace(/[$€\s%]/g, "")
    .replace(/,(?=\d{3}\b)/g, ""); // thousands separator, not a decimal comma

  const normalised = cleaned.includes(",") && !cleaned.includes(".")
    ? cleaned.replace(",", ".") // `1,5` is one and a half in Spanish
    : cleaned;

  if (normalised === "" || !/^-?\d*\.?\d+$/.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * A date out of an Excel serial, an ISO string or a written order named by `format`.
 * Returns `YYYY-MM-DD`, or an ISO instant when the type wants the time too.
 */
function date(raw, options, withTime) {
  if (typeof raw === "number" || /^\d+(\.\d+)?$/.test(text(raw))) {
    const serial = typeof raw === "number" ? raw : Number(text(raw));
    if (serial < MIN_EXCEL_SERIAL || serial > MAX_EXCEL_SERIAL) {
      return bad("is not a valid date");
    }
    const at = new Date(EXCEL_EPOCH_MS + Math.round(serial * MS_PER_DAY));
    return ok(withTime ? at.toISOString() : at.toISOString().slice(0, 10));
  }

  const value = text(raw);

  // ISO first, whatever `format` says: a client that sends 2026-05-01 means that date.
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/);
  if (iso) {
    const parsed = Date.parse(withTime && iso[4] ? value.replace(" ", "T") : `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    if (Number.isNaN(parsed)) return bad("is not a valid date");
    return ok(withTime ? new Date(parsed).toISOString() : value.slice(0, 10));
  }

  const token = options.format ?? "DD/MM/YYYY";
  const order = DATE_FORMATS[token];
  if (!order) return bad(`cannot be read: "${token}" is not a known date format`);

  const parts = value.split(/[/\-.]/);
  const time = parts[2]?.match(/\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (time) parts[2] = parts[2].slice(0, time.index);
  if (parts.length < 3) return bad(`is not a date written as ${token}`);

  const year = Number(parts[order.year]);
  const month = Number(parts[order.month]);
  const day = Number(parts[order.day]);
  if (![year, month, day].every(Number.isInteger)) return bad(`is not a date written as ${token}`);
  if (month < 1 || month > 12 || day < 1 || day > 31) return bad("is not a valid date");

  const at = new Date(Date.UTC(
    year,
    month - 1,
    day,
    time ? Number(time[1]) : 0,
    time ? Number(time[2]) : 0,
    time && time[3] ? Number(time[3]) : 0,
  ));
  // Rejects 31/02: the constructor rolls over and the day no longer matches.
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return bad("is not a valid date");

  return ok(withTime ? at.toISOString() : at.toISOString().slice(0, 10));
}

function boolean(raw, options) {
  if (typeof raw === "boolean") return ok(raw);
  if (typeof raw === "number") return ok(raw !== 0);

  const value = text(raw).toLowerCase();
  const truthy = (options.truthy ?? TRUTHY).map((entry) => String(entry).toLowerCase());
  const falsy = (options.falsy ?? FALSY).map((entry) => String(entry).toLowerCase());

  if (truthy.includes(value)) return ok(true);
  if (falsy.includes(value)) return ok(false);
  return bad(`is not a yes or no value (got "${value}")`);
}
