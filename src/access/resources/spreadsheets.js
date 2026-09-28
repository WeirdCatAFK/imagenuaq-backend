// Tier 2: what a workbook looks like through Graph, shaped for the tier above.
//
// query.js is the resource for Postgres; this is the resource for Excel. Same rule: the
// only module that knows Graph's paths and response shapes. Orchestration asks for "the
// tables in this book" and gets `{ tables, worksheets }`, never `@odata` anything.
//
// Two shapes of data live in a tracker and both are offered. A *table* is an Excel
// ListObject with a header row Graph can name; a *worksheet* is the raw grid, read through
// its used range. The trackers the interviews describe are as likely to be the second as
// the first, and asking coordination to convert a sheet to a table before registering it
// is a step nobody would remember to take.
//
// Share links are resolved rather than parsed: Graph's /shares endpoint turns any OneDrive
// or SharePoint URL a person can paste into the drive/item pair the workbook calls take
// (DATAMODEL.md 2.9 on why that pair, not the URL, is the key). The encoding is the one
// Graph documents -- base64url of the URL with a `u!` prefix.
import { graphGet } from "../primitives/microsoftGraph.js";

// How many body rows a preview carries under the header row: enough to recognise the
// tracker, few enough that a table of thousands of rows costs one small Graph call.
const SAMPLE_ROWS = 5;

// How many table rows one Graph call asks for. A tracker of a few thousand rows is a handful
// of round trips; asking for everything at once is what gets a 504 from Graph on a big book.
const PAGE = 500;

// Beyond this the import refuses rather than pulling a corpus into one HTTP request. The
// interviews describe trackers of hundreds of rows; ten thousand means somebody pointed this
// at the wrong file, and a job queue is the answer for the day that is real (not this one).
const MAX_ROWS = 10_000;

/**
 * The drive/item pair behind a share link.
 *
 * @param {string} accessToken
 * @param {string} url
 * @returns {Promise<{ driveId: string, itemId: string, name: string, webUrl: string | null }>}
 * @throws {GraphError} 404 (`itemNotFound`) when the link resolves to nothing the account
 *   can see, 403 when it can see it exists but not open it.
 */
export async function resolveShareLink(accessToken, url) {
  const encoded = Buffer.from(url, "utf8").toString("base64url");
  const item = await graphGet(accessToken, `/shares/u!${encoded}/driveItem`);

  return {
    driveId: item.parentReference?.driveId ?? null,
    itemId: item.id,
    name: item.name,
    webUrl: item.webUrl ?? null,
  };
}

/**
 * Every table and every worksheet in a workbook, by name.
 *
 * @param {string} accessToken
 * @param {string} driveId
 * @param {string} itemId
 * @returns {Promise<{ tables: { id: string, name: string }[],
 *   worksheets: { id: string, name: string }[] }>}
 */
export async function listTables(accessToken, driveId, itemId) {
  const base = workbook(driveId, itemId);
  const [tables, worksheets] = await Promise.all([
    graphGet(accessToken, `${base}/tables`),
    graphGet(accessToken, `${base}/worksheets`),
  ]);

  const name = (row) => ({ id: row.id, name: row.name });
  return {
    tables: tables.value.map(name),
    worksheets: worksheets.value.map(name),
  };
}

/**
 * The header row of a table, or of a worksheet's used range when no table carries that
 * name, plus the first SAMPLE_ROWS rows under it. Cells come back as whatever Excel holds
 * -- strings, numbers, empty strings for blanks -- untouched; deciding what a blank header
 * means is the mapping's business.
 *
 * A table's body is paged through /rows with $top so a long tracker is never downloaded
 * whole; a worksheet's used range already arrives in one piece and is sliced here.
 *
 * @param {string} accessToken
 * @param {string} driveId
 * @param {string} itemId
 * @param {string | null} tableName Null: the first worksheet.
 * @returns {Promise<{ kind: 'table' | 'worksheet', name: string, headers: unknown[],
 *   rows: unknown[][], texts: unknown[][] } | null>} Null when no table or worksheet has that
 *   name. `texts` is the same rows as Excel displays them, empty for a table, which is what
 *   `from: "text"` reads -- the preview has to be fed it or it answers a different question than
 *   the import does.
 */
export async function readHeaders(accessToken, driveId, itemId, tableName) {
  const target = await resolveTarget(accessToken, driveId, itemId, tableName);
  if (target === null) return null;

  const base = workbook(driveId, itemId);

  if (target.kind === "table") {
    const tablePath = `${base}/tables/${encodeURIComponent(target.name)}`;
    const [range, body] = await Promise.all([
      graphGet(accessToken, `${tablePath}/headerRowRange`),
      graphGet(accessToken, `${tablePath}/rows?$top=${SAMPLE_ROWS}`),
    ]);
    return {
      kind: "table",
      name: target.name,
      headers: range.values?.[0] ?? [],
      // Each table row is its own object holding a one-row matrix.
      rows: (body.value ?? []).map((row) => row.values?.[0] ?? []),
      // A table's rows carry no formatted text, so `from: "text"` falls back to the value --
      // cellAt() does that, and an empty matrix here is how it learns to.
      texts: [],
    };
  }

  const range = await graphGet(
    accessToken,
    `${base}/worksheets/${encodeURIComponent(target.name)}/usedRange?$select=values,text`,
  );
  const values = range.values ?? [];
  const texts = range.text ?? [];
  return {
    kind: "worksheet",
    name: target.name,
    headers: values[0] ?? [],
    rows: values.slice(1, 1 + SAMPLE_ROWS),
    texts: texts.slice(1, 1 + SAMPLE_ROWS),
  };
}

/**
 * Every row under the header, for an import, in both the shapes Excel offers.
 *
 * **`values` and `texts` are both returned, and that is the point.** A real date in a cell
 * arrives in `values` as a serial number -- days since 1899-12-30 -- while the same date typed
 * as text arrives as a string, and a mapping rule cannot know which a given tracker holds.
 * `texts` is what Excel displays, so a rule may ask for `from: "text"` when the formatted
 * string is the truth. `utils/fieldValues.js` handles both, so the default stays `values`.
 *
 * A table is paged through `/rows` with `$top`/`$skip`, because `graphGet()`'s `@odata.nextLink`
 * following does not apply to the workbook row endpoint. A worksheet's used range arrives whole
 * and is sliced here -- there is no paging to do and asking for one is a second round trip for
 * nothing.
 *
 * @param {string} accessToken
 * @param {string} driveId
 * @param {string} itemId
 * @param {string | null} tableName Null: the first worksheet.
 * @returns {Promise<{ kind: 'table' | 'worksheet', name: string, headers: unknown[],
 *   rows: unknown[][], texts: unknown[][], truncated: boolean } | null>} Null when no table or
 *   worksheet has that name. `texts` is empty for a table: Graph's row endpoint offers no
 *   formatted text, so a rule asking for `from: "text"` over a table falls back to the value.
 * @throws {GraphError} whatever Graph refuses.
 */
export async function readAllRows(accessToken, driveId, itemId, tableName) {
  const target = await resolveTarget(accessToken, driveId, itemId, tableName);
  if (target === null) return null;

  const base = workbook(driveId, itemId);

  if (target.kind === "table") {
    const tablePath = `${base}/tables/${encodeURIComponent(target.name)}`;
    const range = await graphGet(accessToken, `${tablePath}/headerRowRange`);

    const rows = [];
    let skip = 0;
    let truncated = false;
    for (;;) {
      const page = await graphGet(accessToken, `${tablePath}/rows?$top=${PAGE}&$skip=${skip}`);
      const batch = (page.value ?? []).map((row) => row.values?.[0] ?? []);
      rows.push(...batch);

      if (batch.length < PAGE) break;
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      skip += PAGE;
    }

    return {
      kind: "table",
      name: target.name,
      headers: range.values?.[0] ?? [],
      rows,
      texts: [],
      truncated,
    };
  }

  const range = await graphGet(
    accessToken,
    `${base}/worksheets/${encodeURIComponent(target.name)}/usedRange?$select=values,text`,
  );
  const values = range.values ?? [];
  const texts = range.text ?? [];

  return {
    kind: "worksheet",
    name: target.name,
    headers: values[0] ?? [],
    rows: values.slice(1, 1 + MAX_ROWS),
    texts: texts.slice(1, 1 + MAX_ROWS),
    truncated: values.length - 1 > MAX_ROWS,
  };
}

/**
 * Which thing in the book the registration meant: the table of that name, else the worksheet
 * of that name, else -- with no name -- the first worksheet. One list call, shared by both
 * readers so they can never disagree about what a registration points at.
 *
 * @returns {Promise<{ kind: 'table' | 'worksheet', name: string } | null>}
 */
async function resolveTarget(accessToken, driveId, itemId, tableName) {
  const { tables, worksheets } = await listTables(accessToken, driveId, itemId);

  const table = tableName === null ? null : tables.find((t) => t.name === tableName);
  if (table) return { kind: "table", name: table.name };

  const sheet =
    tableName === null ? worksheets[0] : worksheets.find((w) => w.name === tableName);
  return sheet ? { kind: "worksheet", name: sheet.name } : null;
}

function workbook(driveId, itemId) {
  return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook`;
}
