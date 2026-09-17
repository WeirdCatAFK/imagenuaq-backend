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
 * name. Cells come back as whatever Excel holds -- strings, numbers, empty strings for
 * blanks -- untouched; deciding what a blank header means is the mapping's business.
 *
 * @param {string} accessToken
 * @param {string} driveId
 * @param {string} itemId
 * @param {string | null} tableName Null: the first worksheet.
 * @returns {Promise<{ kind: 'table' | 'worksheet', name: string, headers: unknown[] }>}
 */
export async function readHeaders(accessToken, driveId, itemId, tableName) {
  const base = workbook(driveId, itemId);
  const { tables, worksheets } = await listTables(accessToken, driveId, itemId);

  const table = tableName === null ? null : tables.find((t) => t.name === tableName);
  if (table) {
    const range = await graphGet(
      accessToken,
      `${base}/tables/${encodeURIComponent(table.name)}/headerRowRange`,
    );
    return { kind: "table", name: table.name, headers: range.values?.[0] ?? [] };
  }

  const sheet =
    tableName === null ? worksheets[0] : worksheets.find((w) => w.name === tableName);
  if (!sheet) return null;

  const range = await graphGet(
    accessToken,
    `${base}/worksheets/${encodeURIComponent(sheet.name)}/usedRange?$select=values`,
  );
  return { kind: "worksheet", name: sheet.name, headers: range.values?.[0] ?? [] };
}

function workbook(driveId, itemId) {
  return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook`;
}
