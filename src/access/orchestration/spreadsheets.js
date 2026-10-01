// Tier 3: the registry of workbooks that stay alive during the transition (RF-MIG-01).
//
// A `sheets` row is a workbook, the table or worksheet inside it, and the Microsoft
// account whose access reads it. This module registers and removes those rows, offers the Graph
// reads the registry needs -- resolving a pasted link into the drive/item pair Graph wants, and
// reading a header row so a person can see they registered the right thing -- and maps a book
// onto a format so its rows can become requests.
//
// **A book is registered before it is mapped**, and a row with `schema_version_id` and
// `column_map` empty reads as "not yet mapped". `utils/columnMap.js` owns what a map means; this
// module owns when it may be saved and what an import does with it.
//
// **An import is not a transaction, on purpose.** Rows are independent: one that cannot be read
// is reported and the run continues, because stopping at the first bad row in a tracker of
// hundreds means nobody ever finishes an import. The run's report is a `sheet_imports` row, so
// "why did this row not come in" is answerable after the response is gone.
//
// **Nothing is written back to the sheet.** The account is connected read-only and the Graph
// client has only GET; syncing the project's status into the Excel is its own increment, needing
// another consent from the account's owner. So a book is imported once with its state -- the map
// translates its status column -- and the work lives here from then on.
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
  readAllRows,
} from "../resources/spreadsheets.js";
import microsoft, { translateGraph } from "./microsoft.js";
import statuses from "./statuses.js";
import { fieldList } from "./schemas.js";
import { validateColumnMap, applyMapping, rowHash } from "../../utils/columnMap.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  UNIQUE_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  cleanText,
  requireId,
} from "../../utils/validate.js";

/** Where an imported row starts when its map says nothing about status (RF-EST-01). */
const DEFAULT_STATUS = "recibido";

/**
 *  Column widths from projects-spine; checked here so a 22001 becomes a 400 naming the field.
 */
const NAME_MAX = 300;
const ID_MAX = 255;
const TABLE_MAX = 200;

class Spreadsheets {
  /** status code -> id, for the length of the process. The catalogue changes rarely. */
  #statusCache = new Map();

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
   * Points the book at a format version and saves how its columns feed it (RF-MIG-02).
   *
   * @param {number} sheetId
   * @param {{ schemaVersionId: number, columnMap: object, headers?: unknown[] }} input
   * @throws {ApiError} 400 naming every problem with the map, 404.
   */
  async setMapping(sheetId, { schemaVersionId, columnMap, headers = null }) {
    const id = requireId(sheetId, "sheetId");
    const sheet = await query.getSheet(id);
    if (!sheet) throw ApiError.notFound("Spreadsheet not found.");

    const version = await query.getSchemaVersion(requireId(schemaVersionId, "schemaVersionId"));
    if (!version) throw ApiError.notFound("Schema version not found.");

    const { map, errors } = validateColumnMap(
      columnMap,
      fieldList(version.fields),
      Array.isArray(headers) ? headers : null,
    );
    if (errors.length > 0) throw ApiError.badRequest(errors.join(" "));

    await this.#assertStatusCodes(map);

    const row = await query.setSheetMapping(id, { schemaVersionId: version.id, columnMap: map });

    await events.emit({
      action: "record_updated",
      target: { table: "sheets", id },
      before: sheet,
      after: row,
    });

    return this.getById(id);
  }

  /**
   *  Back to unmapped. What is already imported keeps its own capture. @throws {ApiError} 404
   */
  async clearMapping(sheetId) {
    const id = requireId(sheetId, "sheetId");
    const sheet = await query.getSheet(id);
    if (!sheet) throw ApiError.notFound("Spreadsheet not found.");

    const row = await query.clearSheetMapping(id);

    await events.emit({
      action: "record_updated",
      target: { table: "sheets", id },
      before: sheet,
      after: row,
    });

    return this.getById(id);
  }

  /**
   * The first rows as the map would read them, without writing anything.
   *
   * @param {number} sheetId
   * @param {{ columnMap?: object, schemaVersionId?: number }} input Omitted: what is saved.
   * @param {object} actor
   * @returns {Promise<object>} The headers, and one entry per sample row with its values or its
   *   errors.
   * @throws {ApiError} 400 on a map that will not validate, 404, 409 when nothing is mapped.
   */
  async previewMapping(sheetId, { columnMap = null, schemaVersionId = null } = {}, actor) {
    const id = requireId(sheetId, "sheetId");
    const sheet = await query.getSheet(id);
    if (!sheet) throw ApiError.notFound("Spreadsheet not found.");

    const versionId = schemaVersionId ?? sheet.schema_version_id;
    if (versionId === null) {
      throw ApiError.conflict("That book has no format yet: send schemaVersionId to try one.");
    }
    const version = await query.getSchemaVersion(requireId(versionId, "schemaVersionId"));
    if (!version) throw ApiError.notFound("Schema version not found.");

    const fields = fieldList(version.fields);
    const proposed = columnMap ?? sheet.column_map;

    const token = await microsoft.accessTokenFor(sheet.microsoft_account_id, actor);
    let read;
    try {
      read = await readHeaders(token, sheet.drive_id, sheet.item_id, sheet.table_name);
    } catch (err) {
      throw translateGraph(err);
    }
    if (!read) throw ApiError.notFound("That table or worksheet no longer exists in the workbook.");

    const { map, errors } = validateColumnMap(proposed, fields, read.headers);
    if (errors.length > 0) throw ApiError.badRequest(errors.join(" "));

    const seen = await query.listSourceHashes(id);

    return {
      sheet: shapeSheet(sheet),
      schemaVersionId: version.id,
      kind: read.kind,
      headers: read.headers,
      rows: read.rows.map((row, index) => {
        const out = applyMapping(map, fields, read.headers, row, read.texts?.[index] ?? []);
        return {
          index,
          ok: out.errors.length === 0,
          alreadyImported: seen.has(out.sourceHash),
          title: out.title,
          requester: out.requester,
          statusCode: out.statusCode,
          data: out.data,
          errors: out.errors,
          warnings: out.warnings,
        };
      }),
    };
  }

  /**
   * Reads the whole book and turns its rows into requests (RF-MIG-01, RF-MIG-02).
   *
   * @param {number} sheetId
   * @param {{ dryRun?: boolean }} [input] `dryRun` counts without writing.
   * @param {object} actor
   * @returns {Promise<{ import: object }>}
   * @throws {ApiError} 409 when the book is not mapped, 404, and whatever Graph refuses.
   */
  async import(sheetId, { dryRun = false } = {}, actor) {
    const id = requireId(sheetId, "sheetId");
    const sheet = await query.getSheet(id);
    if (!sheet) throw ApiError.notFound("Spreadsheet not found.");
    if (sheet.schema_version_id === null) {
      throw ApiError.conflict("Map the book to a format before importing it.");
    }

    const token = await microsoft.accessTokenFor(sheet.microsoft_account_id, actor);
    let read;
    try {
      read = await readAllRows(token, sheet.drive_id, sheet.item_id, sheet.table_name);
    } catch (err) {
      throw translateGraph(err);
    }
    if (!read) throw ApiError.notFound("That table or worksheet no longer exists in the workbook.");

    return {
      import: await this.importRows(sheet, read, { dryRun }),
    };
  }

  /**
   * Marks every row the book has right now as already seen, without creating anything.
   *
   * @param {number} sheetId
   * @param {{dryRun?: boolean}} [options] `dryRun` counts and writes nothing.
   * @returns {Promise<{rowsRead: number, rowsMarked: number, rowsAlreadyKnown: number,
   *   truncated: boolean, dryRun: boolean}>}
   * @throws {ApiError} 404, 409 when the book has no mapping, 502 from Graph.
   */
  async markRowsAsSeen(sheetId, { dryRun = false } = {}, actor) {
    const id = requireId(sheetId, "sheetId");
    const sheet = await query.getSheet(id);
    if (!sheet) throw ApiError.notFound("Spreadsheet not found.");
    if (sheet.schema_version_id === null) {
      throw ApiError.conflict("Map the book to a format before marking its rows.");
    }

    const token = await microsoft.accessTokenFor(sheet.microsoft_account_id, actor);
    let read;
    try {
      read = await readAllRows(token, sheet.drive_id, sheet.item_id, sheet.table_name);
    } catch (err) {
      throw translateGraph(err);
    }
    if (!read) throw ApiError.notFound("That table or worksheet no longer exists in the workbook.");

    return this.markRows(sheet, read, { dryRun });
  }

  /**
   * The marking itself, given rows somebody already read. Separated from `markRowsAsSeen()` for
   * the same reason `importRows()` is separated from `import()`: what is worth testing is which
   * rows stop being new, not that Microsoft answered.
   *
   * @param {object} sheet A `sheets` row.
   * @param {{headers: unknown[], rows: unknown[][], truncated?: boolean}} read
   * @param {{dryRun?: boolean}} [options]
   * @throws {ApiError} 409 when the book has no mapping or the sheet stopped matching it.
   */
  async markRows(sheet, read, { dryRun = false } = {}) {
    if (sheet.schema_version_id === null) {
      throw ApiError.conflict("Map the book to a format before marking its rows.");
    }

    const version = await query.getSchemaVersion(sheet.schema_version_id);
    if (!version) throw ApiError.conflict("The format this book points at is gone.");

    const { map, errors } = validateColumnMap(sheet.column_map, fieldList(version.fields), read.headers);
    if (errors.length > 0) {
      throw ApiError.conflict(`The sheet no longer matches its mapping: ${errors.join(" ")}`);
    }

    const seen = await query.listSourceHashes(sheet.id);
    const hashes = read.rows.map((row) => rowHash(map, read.headers, row));
    const nuevas = [...new Set(hashes.filter((hash) => !seen.has(hash)))];

    const resultado = {
      rowsRead: read.rows.length,
      rowsMarked: nuevas.length,
      rowsAlreadyKnown: read.rows.length - nuevas.length,
      truncated: read.truncated === true,
      dryRun,
    };

    if (dryRun) return resultado;

    resultado.rowsMarked = await query.markSheetRows({
      sheetId: sheet.id,
      hashes: nuevas,
      markedBy: currentActor()?.id ?? null,
    });

    await events.emit({
      action: "sheet_rows_marked",
      target: { table: "sheets", id: sheet.id },
      after: { ...resultado, sheetId: sheet.id },
    });

    return resultado;
  }

  /**
   * Undoes the marking: the rows become unknown again and the next import brings them in.
   *
   * @returns {Promise<{rowsCleared: number}>}
   * @throws {ApiError} 404.
   */
  async clearMarks(sheetId) {
    const id = requireId(sheetId, "sheetId");
    if (!(await query.getSheet(id))) throw ApiError.notFound("Spreadsheet not found.");

    const rowsCleared = await query.clearSheetMarks(id);

    await events.emit({
      action: "record_updated",
      target: { table: "sheets", id },
      after: { sheetId: id, rowsCleared },
    });

    return { rowsCleared };
  }

  /**
   * The import itself, given rows somebody already read.
   *
   * @param {object} sheet A `sheets` row, mapped.
   * @param {{ headers: unknown[], rows: unknown[][], texts?: unknown[][], truncated?: boolean }} read
   * @param {{ dryRun?: boolean }} [options]
   * @returns {Promise<object>} The run's report.
   */
  async importRows(sheet, read, { dryRun = false } = {}) {
    const version = await query.getSchemaVersion(sheet.schema_version_id);
    if (!version) throw ApiError.conflict("The format this book points at is gone; map it again.");

    const fields = fieldList(version.fields);
    const { map, errors: mapErrors } = validateColumnMap(sheet.column_map, fields, read.headers);
    if (mapErrors.length > 0) {
      throw ApiError.conflict(`The book no longer matches its mapping: ${mapErrors.join(" ")}`);
    }

    await this.#assertStatusCodes(map);

    const seen = await query.listSourceHashes(sheet.id);
    const fallback = await this.#statusId(map.status?.default ?? DEFAULT_STATUS);

    const run = dryRun
      ? null
      : await query.createSheetImport({ sheetId: sheet.id, runBy: currentActor()?.id ?? null });

    const counters = { rowsRead: read.rows.length, rowsCreated: 0, rowsSkipped: 0, rowsFailed: 0, rowsFlagged: 0 };
    const failures = [];

    for (const [index, row] of read.rows.entries()) {
      const out = applyMapping(map, fields, read.headers, row, read.texts?.[index] ?? []);

      if (seen.has(out.sourceHash)) {
        counters.rowsSkipped += 1;
        continue;
      }

      if (out.errors.length > 0) {
        counters.rowsFailed += 1;
        failures.push({ index, message: out.errors.map((entry) => entry.message).join(" ") });
        continue;
      }

      const twin = await query.findProbableDuplicate({
        sheetId: sheet.id,
        title: out.title,
        requester: out.requester,
      });

      if (dryRun) {
        counters.rowsCreated += 1;
        if (twin) counters.rowsFlagged += 1;
        seen.add(out.sourceHash);
        continue;
      }

      try {
        const request = await query.createRequest({
          schemaVersionId: version.id,
          title: out.title,
          data: out.data,
          requester: out.requester,
          areaId: null,
          statusId: out.statusCode === null ? fallback : await this.#statusId(out.statusCode),
          priority: out.priority,
          source: "sheet",
          sheetId: sheet.id,
          sourceIndex: index,
          sourceData: out.sourceData,
          sourceHash: out.sourceHash,
          possibleDuplicateOf: twin?.id ?? null,
        });

        counters.rowsCreated += 1;
        if (twin) counters.rowsFlagged += 1;
        seen.add(out.sourceHash);

        await events.emit({
          action: "record_created",
          target: { table: "requests", id: request.id },
          after: request,
        });
      } catch (err) {
        counters.rowsFailed += 1;
        failures.push({ index, message: translate(err).message });
      }
    }

    if (dryRun) {
      return { ...counters, dryRun: true, errors: failures, truncated: read.truncated === true };
    }

    const finished = await query.finishSheetImport(run.id, { ...counters, errors: failures });
    if (!finished) {
      throw new Error(`Import run ${run.id} disappeared before it could be closed.`);
    }

    await query.markSheetImported(sheet.id);

    await events.emit({
      action: "sheet_imported",
      target: { table: "sheets", id: sheet.id },
      after: finished,
    });

    return { ...shapeImport(finished), truncated: read.truncated === true };
  }

  async listImports(sheetId) {
    const id = requireId(sheetId, "sheetId");
    if (!(await query.getSheet(id))) throw ApiError.notFound("Spreadsheet not found.");
    return (await query.listSheetImports(id)).map(shapeImport);
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

  /**
   * Every status code the map can produce has to exist, checked when the map is saved rather
   * than discovered on row 200 of an import.
   */
  async #assertStatusCodes(map) {
    if (map.status === undefined) return;

    const codes = new Set(Object.values(map.status.map ?? {}));
    if (map.status.default !== undefined) codes.add(map.status.default);
    codes.add(DEFAULT_STATUS);

    for (const code of codes) await this.#statusId(code);
  }

  /** Memoised: one import asks for the same handful of codes hundreds of times. */
  async #statusId(code) {
    if (this.#statusCache.has(code)) return this.#statusCache.get(code);

    const status = await statuses.byCode(code);
    if (!status) {
      throw ApiError.badRequest(
        `The map names the status "${code}", which is not in the catalogue.`,
      );
    }

    this.#statusCache.set(code, status.id);
    return status.id;
  }
}

/** snake_case row in, camelCase JSON out. */
function shapeImport(row) {
  return {
    id: row.id,
    sheetId: row.sheet_id,
    runBy: row.run_by,
    runByName: row.run_by_name ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    rowsRead: row.rows_read,
    rowsCreated: row.rows_created,
    rowsSkipped: row.rows_skipped,
    rowsFailed: row.rows_failed,
    rowsFlagged: row.rows_flagged,
    errors: row.errors ?? [],
  };
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
    markedRows: row.marked_rows ?? 0,
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
