// Tier 3: the registry of workbooks that stay alive during the transition (RF-MIG-01).
//
// A `sheets` row is a workbook, the table or worksheet inside it, and the Microsoft
// account whose access reads it. This module registers and removes those rows and offers
// the two Graph reads the registry needs: resolving a pasted link into the drive/item pair
// Graph wants, and reading a header row so a person can see they registered the right
// thing. Mapping those headers onto a format (`schema_version_id`, `column_map`) is the
// next iteration and is deliberately absent; a registered row with both empty reads as
// "not yet mapped".
//
// Registering does NOT call Graph. resolve() returns the ids and the caller sends them
// back, so a registration is a plain insert that can be tested without the network and
// that survives a Microsoft outage. The cost, stated: a client can register ids it made
// up, and the row fails the first time it is read. The alternative -- verifying on every
// insert -- makes the registry unusable exactly when the outage is Microsoft's.
//
// Which accounts may be used is microsoft.js's rule (owner or admin), asked through
// usableAccount() so the two modules cannot disagree on it.
import query from "../resources/query.js";
import {
  resolveShareLink,
  listTables,
  readHeaders,
} from "../resources/spreadsheets.js";
import microsoft, { translateGraph } from "./microsoft.js";
import events from "../../utils/events.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** Column widths from projects-spine; checked here so a 22001 becomes a 400 naming the field. */
const NAME_MAX = 300;
const ID_MAX = 255;
const TABLE_MAX = 200;

class Spreadsheets {
  /**
   * What is behind a share link, as the account sees it: the ids the registration needs
   * and every table and worksheet the book has, for the person to pick from.
   *
   * @param {{ accountId: number|string, url: string }} input
   * @param {object} actor `req.user`.
   * @returns {Promise<object>}
   * @throws {ApiError} 400 on a bad URL, plus whatever accessTokenFor() and Graph refuse.
   */
  async resolve({ accountId, url }, actor) {
    const link = cleanText(url);
    if (!link || !isHttpsUrl(link)) {
      throw ApiError.badRequest("url must be an https link to the workbook.");
    }

    const token = await microsoft.accessTokenFor(accountId, actor);

    try {
      const item = await resolveShareLink(token, link);
      if (!item.driveId) {
        throw ApiError.badRequest("That link does not point at a file in a drive.");
      }
      const { tables, worksheets } = await listTables(token, item.driveId, item.itemId);
      return { ...item, tables, worksheets };
    } catch (err) {
      throw translateGraph(err);
    }
  }

  /**
   * Registers a workbook table under an account the actor may use.
   *
   * @param {object} input
   * @param {number|string} input.accountId
   * @param {string} input.name How the book is referred to.
   * @param {string} input.driveId
   * @param {string} input.itemId
   * @param {string|null} [input.tableName] Table or worksheet; null means the first.
   * @param {string|null} [input.webUrl]
   * @param {object} actor `req.user`.
   * @returns {Promise<object>}
   * @throws {ApiError} 400 on a bad payload, 404/403 from the account check, 409 when the
   *   same table is already registered.
   */
  async register({ accountId, name, driveId, itemId, tableName, webUrl }, actor) {
    const cleanName = cleanText(name);
    if (!cleanName || cleanName.length > NAME_MAX) {
      throw ApiError.badRequest(`name is required (${NAME_MAX} characters or fewer).`);
    }

    const drive = cleanText(driveId);
    const item = cleanText(itemId);
    if (!drive || drive.length > ID_MAX || !item || item.length > ID_MAX) {
      throw ApiError.badRequest("driveId and itemId are required.");
    }

    const table = cleanText(tableName);
    if (table !== null && table.length > TABLE_MAX) {
      throw ApiError.badRequest(`tableName must be ${TABLE_MAX} characters or fewer.`);
    }

    const link = cleanText(webUrl);
    if (link !== null && !isHttpsUrl(link)) {
      throw ApiError.badRequest("webUrl must be an https link.");
    }

    const account = await microsoft.usableAccount(accountId, actor);

    try {
      const row = await query.createSheet({
        name: cleanName,
        driveId: drive,
        itemId: item,
        tableName: table,
        webUrl: link,
        microsoftAccountId: account.id,
        registeredBy: actor?.id ?? null,
      });

      await events.emit({
        action: "record_created",
        target: { table: "sheets", id: row.id },
        after: row,
      });

      return this.getById(row.id);
    } catch (err) {
      throw translate(err);
    }
  }

  async list() {
    return (await query.listSheets()).map(shapeSheet);
  }

  async getById(sheetId) {
    const row = await query.getSheet(requireId(sheetId, "sheetId"));
    if (!row) throw ApiError.notFound("Spreadsheet not found.");
    return shapeSheet(row);
  }

  /**
   * The header row of a registered table plus a few rows under it, read live.
   *
   * @throws {ApiError} 404 when the sheet is gone here or in Microsoft 365, and whatever
   *   accessTokenFor() refuses -- including the 409 that says the account needs reconnecting.
   */
  async preview(sheetId, actor) {
    const row = await query.getSheet(requireId(sheetId, "sheetId"));
    if (!row) throw ApiError.notFound("Spreadsheet not found.");

    const token = await microsoft.accessTokenFor(row.microsoft_account_id, actor);

    let headers;
    try {
      headers = await readHeaders(token, row.drive_id, row.item_id, row.table_name);
    } catch (err) {
      throw translateGraph(err);
    }
    if (!headers) {
      throw ApiError.notFound("That table or worksheet no longer exists in the workbook.");
    }

    return { sheet: shapeSheet(row), ...headers };
  }

  /**
   * Soft-deletes a registration. Anyone with the write permission may remove any sheet:
   * the registry is shared work, not personal, and the account behind it stays connected.
   *
   * @throws {ApiError} 404 when there is no live row.
   */
  async remove(sheetId) {
    const row = await query.deleteSheet(requireId(sheetId, "sheetId"));
    if (!row) throw ApiError.notFound("Spreadsheet not found.");

    await events.emit({
      action: "record_deleted",
      target: { table: "sheets", id: row.id },
      before: row,
    });

    return shapeSheet(row);
  }
}

function cleanText(value) {
  if (typeof value !== "string") return value == null ? null : value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function requireId(value, field) {
  if (typeof value === "boolean" || value === null || value === undefined) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  return n;
}

/** snake_case row in, camelCase JSON out. `mapped` is what the UI shows, not a column. */
function shapeSheet(row) {
  return {
    id: row.id,
    name: row.name,
    driveId: row.drive_id,
    itemId: row.item_id,
    tableName: row.table_name,
    webUrl: row.web_url,
    schemaVersionId: row.schema_version_id,
    columnMap: row.column_map,
    mapped: row.schema_version_id !== null,
    lastImportedAt: row.last_imported_at,
    accountId: row.microsoft_account_id,
    accountEmail: row.account_email ?? null,
    accountDisplayName: row.account_display_name ?? null,
    accountRevoked: row.account_revoked_at != null,
    registeredBy: row.registered_by,
    registeredByName: row.registered_by_name ?? null,
    createdAt: row.created_at,
  };
}

/** A constraint violation into the refusal the caller earned; anything else untouched. */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    return ApiError.conflict("That table is already registered.");
  }
  if (err?.code === FOREIGN_KEY_VIOLATION) {
    return ApiError.badRequest("A referenced record does not exist.");
  }
  return err;
}

export default new Spreadsheets();
