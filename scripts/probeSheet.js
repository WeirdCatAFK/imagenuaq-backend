#!/usr/bin/env node
// Reads a registered workbook with the real credentials and prints what it actually holds.
// Usage: npm run sheets:probe               -- lists the registered books
//        npm run sheets:probe -- 1          -- probes sheet 1
//        npm run sheets:probe -- 1 --rows 8 -- with more sample rows
//
// Why this exists as a script.
//
// The test suite stays offline on purpose: `tests/spreadsheets.guard.test.js` covers the
// Graph-touching routes as guard-only, and the import is tested by feeding `importRows()`
// fixture rows. That keeps the suite deterministic and runnable with no tenant, which is what
// makes it worth running. But the questions that actually block a mapping are about the real
// book: what are its headers, does `sheets.table_name` resolve to a table or a worksheet, and
// do its dates arrive as Excel serials or as strings somebody typed? Those cannot be answered
// by a fixture. This answers them by looking.
//
// It is also the tool for "the book will not read". A registration holds ids that were never
// verified (POST /api/spreadsheets does not call Graph, by decision), so the first honest test
// of a registration is a read, and the failure it produces here carries Graph's own message
// rather than a 502 from the API.
//
// The gate is `DATABASE_URL`, as in createAdmin.js: whoever can reach the database can already
// decrypt the refresh tokens with MS_TOKEN_KEY. The actor is therefore synthetic
// (`{ role: 'admin' }`) -- `Microsoft.accessTokenFor()` checks ownership, and outside a request
// there is nobody to be.
//
// Like every Graph call, this **rotates the refresh token** (Microsoft rotates on use), so the
// stored one changes. That is normal and the reason the write goes through
// `accessTokenFor()` rather than around it.
import { openStore, closeStore } from "../src/access/primitives/database.js";
import query from "../src/access/resources/query.js";
import microsoft from "../src/access/orchestration/microsoft.js";
import { readAllRows } from "../src/access/resources/spreadsheets.js";

/** A script's actor: the gate is database access, so it stands in for coordination. */
const ACTOR = { role: "admin" };

/** How many body rows to print. The read pulls the whole sheet either way. */
const DEFAULT_SAMPLE = 5;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** `["1", "--rows", "8"]` -> `{ sheetId: 1, sample: 8 }`. */
function parseArgs(argv) {
  const rest = [...argv];
  let sample = DEFAULT_SAMPLE;

  const flag = rest.indexOf("--rows");
  if (flag !== -1) {
    const value = Number(rest[flag + 1]);
    if (!Number.isInteger(value) || value < 1) fail("--rows takes a positive integer.");
    sample = value;
    rest.splice(flag, 2);
  }

  if (rest.length === 0) return { sheetId: null, sample };

  const sheetId = Number(rest[0]);
  if (!Number.isInteger(sheetId) || sheetId <= 0) {
    fail(`"${rest[0]}" is not a sheet id. Run without arguments to list them.`);
  }
  return { sheetId, sample };
}

/** A cell as it should be read in a terminal: quoted, so a blank and a space differ. */
function show(cell) {
  if (cell === null || cell === undefined) return "null";
  if (cell === "") return '""';
  return typeof cell === "number" ? String(cell) : JSON.stringify(String(cell));
}

/**
 * What the value/text pair says about a column. This is the question the mapping needs
 * answered: a date stored as a date arrives as a number, and `from: "text"` is how a rule asks
 * for what Excel displays instead.
 */
function describeCell(value, text) {
  if (typeof value !== "number") {
    if (value === "" || value === null || value === undefined) return "empty";
    return `text ${JSON.stringify(String(value))}`;
  }

  const shown = text === undefined || text === null ? "" : String(text);
  // A date serial displays as a date: slashes or a clock. A number that merely carries a
  // thousands separator is not one, and saying so would send somebody mapping a quantity as
  // a date.
  if (shown !== "" && /[/:]/.test(shown)) {
    return `number ${value} displayed as ${JSON.stringify(shown)}  <- a date serial: map to a date or datetime field`;
  }
  if (shown !== "" && shown !== String(value)) {
    return `number ${value} displayed as ${JSON.stringify(shown)}  (formatting only)`;
  }
  return `number ${value}`;
}

async function listBooks() {
  const sheets = await query.listSheets();
  if (sheets.length === 0) {
    console.log("No books registered. Register one through POST /api/spreadsheets first.");
    return;
  }

  console.log("Registered books:\n");
  for (const sheet of sheets) {
    console.log(
      `  ${sheet.id}  ${sheet.name}` +
        `\n      table/worksheet: ${sheet.table_name ?? "(the first worksheet)"}` +
        `\n      account: ${sheet.account_email ?? "?"}${sheet.account_revoked_at ? " (REVOKED)" : ""}` +
        `\n      mapped: ${sheet.schema_version_id === null ? "no" : `schema version ${sheet.schema_version_id}`}` +
        `\n      last import: ${sheet.last_imported_at ?? "never"}\n`,
    );
  }
  console.log("Probe one with:  npm run sheets:probe -- <id>");
}

async function probe(sheetId, sample) {
  const sheet = await query.getSheet(sheetId);
  if (!sheet) fail(`No registered book with id ${sheetId}.`);

  console.log(`Book: ${sheet.name}`);
  console.log(`  drive/item: ${sheet.drive_id} / ${sheet.item_id}`);
  console.log(`  registered target: ${sheet.table_name ?? "(the first worksheet)"}`);
  console.log(`  read as: ${sheet.account_email ?? "?"}\n`);

  console.log("Asking Microsoft for a token (this rotates the stored refresh token)...");
  const token = await microsoft.accessTokenFor(sheet.microsoft_account_id, ACTOR);

  console.log("Reading the whole sheet...\n");
  const read = await readAllRows(token, sheet.drive_id, sheet.item_id, sheet.table_name);

  if (read === null) {
    fail(
      `The book has no table or worksheet called "${sheet.table_name}". ` +
        "GET /api/spreadsheets/resolve lists what it does have.",
    );
  }

  console.log(`Resolved as a ${read.kind} named ${JSON.stringify(read.name)}.`);
  console.log(`Rows under the header: ${read.rows.length}${read.truncated ? " (TRUNCATED)" : ""}`);
  console.log(`Formatted text available: ${read.texts.length > 0 ? "yes" : "no (tables offer none)"}\n`);

  console.log(`Headers (${read.headers.length}):`);
  read.headers.forEach((header, index) => {
    const label = header === "" || header === null ? "(blank)" : JSON.stringify(String(header));
    console.log(`  ${String(index).padStart(2)}  ${label}`);
  });

  const blank = read.headers.filter((header) => header === "" || header === null).length;
  if (blank > 0) {
    console.log(
      `\n  ${blank} header(s) are blank. A column map names columns by header text, so those ` +
        "cannot be mapped until the sheet names them.",
    );
  }

  const duplicates = read.headers.filter(
    (header, index) => header !== "" && read.headers.indexOf(header) !== index,
  );
  if (duplicates.length > 0) {
    console.log(`\n  Repeated header(s): ${[...new Set(duplicates)].join(", ")}. A map cannot tell them apart.`);
  }

  console.log(`\nFirst ${Math.min(sample, read.rows.length)} row(s), column by column:`);
  read.rows.slice(0, sample).forEach((row, index) => {
    console.log(`\n  row ${index + 1}:`);
    read.headers.forEach((header, column) => {
      const label = header === "" || header === null ? `(column ${column})` : String(header);
      console.log(`    ${label}: ${describeCell(row[column], read.texts[index]?.[column])}`);
    });
  });

  console.log("\nRaw values of the first row, for copying into a fixture:");
  console.log(`  ${JSON.stringify(read.rows[0] ?? [])}`);
  if (read.texts.length > 0) {
    console.log("Raw texts of the first row:");
    console.log(`  ${JSON.stringify(read.texts[0] ?? [])}`);
  }
}

await openStore();
try {
  const { sheetId, sample } = parseArgs(process.argv.slice(2));
  if (sheetId === null) await listBooks();
  else await probe(sheetId, sample);
} catch (error) {
  // An ApiError from orchestration says something useful (reconnect the account, no such
  // book); anything else is a bug or the network, and its stack is what helps.
  console.error(`\nFailed: ${error.message}`);
  if (error.statusCode === undefined) console.error(error);
  process.exitCode = 1;
} finally {
  await closeStore();
}
