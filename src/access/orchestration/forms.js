// Public forms (RF-SOL-01, RF-MIG-01): a link to a format that anyone fills without an account,
// in place of Microsoft Forms. Each answer becomes a request with source 'form' under the link's
// creator. The answer also goes into the link's workbook, so Excel keeps working.
import { createHash, randomBytes } from "node:crypto";

import query from "../resources/query.js";
import requests from "./requests.js";
import microsoft from "./microsoft.js";
import { fieldList } from "./schemas.js";
import { appendRow, readHeaders } from "../resources/spreadsheets.js";
import { invertMapping, rowHash } from "../../utils/columnMap.js";
import { seal, open } from "../../utils/crypto.js";
import events from "../../utils/events.js";
import { currentActor, runWithContext } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import { requireId, optionalId } from "../../utils/validate.js";

/** How long after submitting the browser may still attach files to its own request. */
const UPLOAD_KEY_TTL_MS = 60 * 60 * 1000;

/**
 * How long a request may wait for its files before the scheduler writes its row anyway. A browser
 * closed mid-upload must not keep the row out of Excel.
 */
const WRITE_BACK_GRACE_MS = 10 * 60 * 1000;

class Forms {
  /**
   * A format's working links. The route needs `schema.manage`.
   *
   * @param {number} schemaId
   * @returns {Promise<object[]>}
   */
  async listLinks(schemaId) {
    const rows = await query.listFormLinks(requireId(schemaId, "schemaId"));
    return rows.map(shapeLink);
  }

  /**
   * Opens a public link to the format. With a book, the form uses the book's mapped version, so
   * the columns line up. The book's map must point at a version of this format.
   *
   * @param {{ sheetId?: number|null }} input
   * @returns {Promise<object>} The link with its `token`.
   * @throws {ApiError} 400 on a book with no map or a map to another format, 404.
   */
  async createLink(schemaId, { sheetId = null } = {}) {
    const id = requireId(schemaId, "schemaId");
    const schema = await query.getSchema(id);
    if (!schema) throw ApiError.notFound("Schema not found.");

    const sheet = optionalId(sheetId, "sheetId");
    if (sheet !== null) {
      const row = await query.getSheet(sheet);
      if (!row) throw ApiError.notFound("Spreadsheet not found.");
      const version = row.schema_version_id ? await query.getSchemaVersion(row.schema_version_id) : null;
      if (!version) throw ApiError.badRequest("That workbook is not mapped to a format yet.");
      if (String(version.schema_id) !== String(id)) {
        throw ApiError.badRequest("That workbook is mapped to another format.");
      }
    }

    const token = randomBytes(32).toString("base64url");
    const row = await query.createFormLink({
      tokenHash: hashToken(token),
      tokenEnc: seal(token),
      schemaId: id,
      sheetId: sheet,
      createdBy: currentActor().id,
    });
    await events.emit({ action: "record_created", target: { table: "form_links", id: row.id }, after: row });
    return shapeLink(row);
  }

  /** @throws {ApiError} 404 when the link is not this format's or is already revoked. */
  async revokeLink(schemaId, linkId) {
    const row = await query.revokeFormLink(requireId(schemaId, "schemaId"), requireId(linkId, "linkId"));
    if (!row) throw ApiError.notFound("Link not found.");
    await events.emit({ action: "record_updated", target: { table: "form_links", id: row.id }, after: row });
    return shapeLink(row);
  }

  /**
   * What a requester sees: the format's name and fields. No session.
   *
   * @param {string} token
   * @returns {Promise<{ name: string, fields: object }>}
   * @throws {ApiError} 404 on an unknown or revoked link, or an inactive format.
   */
  async open(token) {
    const link = await this.#link(token);
    const version = await this.#version(link);
    const visible = (list) => (list ?? []).filter((field) => !field.internal);
    return {
      name: link.schema_name,
      fields: { deliverables: visible(version.fields.deliverables), information: visible(version.fields.information) },
    };
  }

  /**
   * Captures one answer as a request (RF-SOL-03). Files follow with the returned `uploadKey`, and
   * `finish()` then writes the row to the book. The input carries `title`, `requester` and `data`.
   *
   * @returns {Promise<{ folio: string, uploadKey: string }>}
   * @throws {ApiError} 400 on a bad answer, 404 on a dead link.
   */
  async submit(token, { title, requester, data = {} } = {}) {
    const link = await this.#link(token);
    if (typeof requester !== "string" || requester.trim() === "") {
      throw ApiError.badRequest("Say who is asking: requester is required.");
    }
    const version = await this.#version(link);

    const request = await asCreator(link, () =>
      requests.create(
        { schemaVersionId: version.id, title, requester, data, source: "form" },
        { formLinkId: link.id, documentsLater: true, publicOnly: true },
      ),
    );

    const uploadKey = seal(
      JSON.stringify({ r: request.id, l: link.id, e: Date.now() + UPLOAD_KEY_TTL_MS }),
    ).toString("base64url");
    return { folio: request.folio, uploadKey };
  }

  /**
   * A file for one `document` field of a request this browser just submitted.
   *
   * @throws {ApiError} 403 on a key past its time or from another link, plus attachFile()'s.
   */
  async attach(token, key, fieldCode, file) {
    const link = await this.#link(token);
    const requestId = readKey(key, link);
    await asCreator(link, () => requests.attachFile(requestId, fieldCode, file, { publicOnly: true }));
    return { attached: true };
  }

  /**
   * Ends a submission: writes its row to the book now instead of waiting for the scheduler. When
   * Microsoft refuses, this logs the error and answers anyway, because the request already exists.
   */
  async finish(token, key) {
    const link = await this.#link(token);
    const requestId = readKey(key, link);
    await this.writeBack(requestId).catch((err) => {
      console.error(`form write-back: request ${requestId} failed:`, err.message ?? err);
    });
    return { finished: true };
  }

  /**
   * Appends a form request's row to its link's book, once (RF-MIG-01). It marks the row's hash
   * as seen before it writes the row, so a sync running in between cannot import it back.
   *
   * @param {number} requestId
   * @returns {Promise<boolean>} False when there is nothing to write.
   * @throws {ApiError|GraphError} whatever Microsoft refuses.
   */
  async writeBack(requestId) {
    const request = await query.getRequest(requestId);
    if (!request || request.form_link_id === null || request.sheet_written_at !== null) return false;
    const link = await query.getFormLink(request.form_link_id);
    const sheet = link?.sheet_id ? await query.getSheet(link.sheet_id) : null;
    if (!sheet) return false;

    const actor = { id: sheet.registered_by, role: "admin" };
    await runWithContext({ actor }, async () => {
      const token = await microsoft.accessTokenFor(sheet.microsoft_account_id, actor);
      const read = await readHeaders(token, sheet.drive_id, sheet.item_id, sheet.table_name);
      if (!read) throw ApiError.notFound(`Workbook "${sheet.name}" has no table or sheet by that name.`);

      const fields = fieldList(request.schema_fields);
      const fileIds = fields
        .filter((field) => field.type === "document" && request.data?.[field.code])
        .map((field) => request.data[field.code]);
      const files = await query.getFileNames(fileIds);
      const names = Object.fromEntries(files.map((file) => [String(file.id), file.name]));

      const row = invertMapping(sheet.column_map, fields, read.headers, request, names);
      await query.markSheetRows({ sheetId: sheet.id, hashes: [rowHash(sheet.column_map, read.headers, row)] });
      await appendRow(token, sheet.drive_id, sheet.item_id, sheet.table_name, row);
      await query.markRequestWritten(request.id);
    });
    return true;
  }

  /**
   * Scheduler entry point: writes the rows a submission left behind, a browser closed before
   * `finish()` or a book Microsoft refused earlier.
   *
   * @returns {Promise<{ written: number, failed: number }>}
   */
  async writePending(now = new Date()) {
    const before = new Date(now.getTime() - WRITE_BACK_GRACE_MS).toISOString();
    let written = 0;
    let failed = 0;
    for (const { id } of await query.listPendingWriteBacks(before)) {
      try {
        if (await this.writeBack(id)) written++;
      } catch (err) {
        console.error(`form write-back: request ${id} failed:`, err.message ?? err);
        failed++;
      }
    }
    return { written, failed };
  }

  /** @throws {ApiError} 404 when the token is unknown or revoked, or its format inactive. */
  async #link(token) {
    const link = typeof token === "string" && token ? await query.resolveFormLink(hashToken(token)) : null;
    if (!link) throw ApiError.notFound("This form does not exist or is closed.");
    return link;
  }

  /** The book's mapped version when the link has a book, else the format's latest. */
  async #version(link) {
    const version = link.sheet_version_id
      ? await query.getSchemaVersion(link.sheet_version_id)
      : await query.getLatestSchemaVersion(link.schema_id);
    if (!version) throw ApiError.notFound("This form has no published version.");
    return version;
  }
}

/**
 * Runs as whoever opened the link: the request, its folder and its files need an author, and the
 * requester has no account. Admin rights here reach only what this module calls.
 */
function asCreator(link, fn) {
  return runWithContext({ actor: { id: link.created_by, role: "admin" } }, fn);
}

/** @throws {ApiError} 403 on a key that does not open, ran out of time or belongs to another link. */
function readKey(key, link) {
  let payload;
  try {
    payload = JSON.parse(open(Buffer.from(String(key ?? ""), "base64url")));
  } catch {
    throw ApiError.forbidden("This upload key is not valid.");
  }
  if (String(payload.l) !== String(link.id) || !(payload.e > Date.now())) {
    throw ApiError.forbidden("This upload key has expired; submit the form again.");
  }
  return payload.r;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** A link as the API answers it. `token` is null on a link made before the server kept it. */
function shapeLink(row) {
  return {
    id: row.id,
    schemaId: row.schema_id,
    sheetId: row.sheet_id,
    sheetName: row.sheet_name ?? null,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    responses: row.responses ?? 0,
    token: row.token_enc ? open(row.token_enc) : null,
  };
}

export default new Forms();
