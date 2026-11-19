// The photo service (RF-PRY-06). A group makes its folios up front, and each folio's 8-character code
// is the client's only credential. Staff type the cajas payment, the client picks proofs and downloads
// finals until the group's retention ends. Bytes go to the photos bucket.
import { createHash, randomInt, randomUUID } from "node:crypto";

import sharp from "sharp";

import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { seal, open } from "../../utils/crypto.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
  optionalBoolean,
  optionalInstant,
  optionalText,
  requireId,
  requireInt,
  requireText,
  uniqueIds,
} from "../../utils/validate.js";
import {
  StorageError,
  abortMultipart,
  beginMultipart,
  completeMultipart,
  deleteContent,
  putContent,
  readContent,
  statContent,
  uploadPart,
} from "../primitives/minioStorage.js";

/** Crockford base32: no I, L, O or U, so a code copied by hand off a sheet reads one way only. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** The statuses of a folio in order. A folio only moves forward. */
export const STATUSES = ["generated", "registered", "paid", "proofs", "selected", "ready", "printed", "delivered"];

/** The most folios one group, or one growth of a group, may have. */
const MAX_GROUP_SIZE = 1000;

/** The biggest photo one upload takes. */
const PHOTO_MAX_BYTES = 60 * 1024 * 1024;

/** The most bytes one ranged read returns, so each download request stays small. */
const MAX_RANGE = 16 * 1024 * 1024;

/** How long an unfinished upload in parts lives before the sweep drops it. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** shortcut: uploads in parts live in this process's memory, so a restart drops them. Move them to a table if the API runs as more than one instance. */
const pendingUploads = new Map();

/** Longest side of the thumbnail of a final photo in the portal, in pixels. */
const THUMB_PX = 600;

/** Longest side of a proof's watermarked preview, in pixels. */
const PREVIEW_PX = 1200;

const MS_PER_DAY = 86_400_000;

class Photos {
  async getRetention() {
    return shapeRetention(await query.getPhotoRetention());
  }

  /**
   * Sets how many days new groups keep their photos downloadable. Existing groups keep theirs.
   *
   * @throws {ApiError} 400 when `days` is not a whole number from 1 to 3650.
   */
  async setRetention(input) {
    const days = requireInt(input?.days, "days");
    if (days < 1 || days > 3650) throw ApiError.badRequest("days must be between 1 and 3650.");
    const before = await query.getPhotoRetention();
    const row = await query.setPhotoRetention(days, currentActor().id);
    await events.emit({ action: "record_updated", target: { table: "photo_retention", id: 1 }, before, after: row });
    return shapeRetention(row);
  }

  async listPackages() {
    return (await query.listPhotoPackages()).map(shapePackage);
  }

  /** @throws {ApiError} 400, 409 on a name already taken. */
  async createPackage(input) {
    const fields = readPackage(input ?? {}, true);
    const row = await translate(() => query.createPhotoPackage(fields));
    await events.emit({ action: "record_created", target: { table: "photo_packages", id: row.id }, after: row });
    return shapePackage(row);
  }

  /**
   * Edits a catalog entry. Folios already paid keep the name and amount they were sold at.
   *
   * @throws {ApiError} 400, 404, 409.
   */
  async updatePackage(packageId, input) {
    const id = requireId(packageId, "packageId");
    const body = input ?? {};
    const before = await query.getPhotoPackage(id);
    if (!before) throw ApiError.notFound("Package not found.");
    const clear = ["description", "presalePrice"].filter((key) => key in body && body[key] === null);
    const row = await translate(() =>
      query.updatePhotoPackage(id, {
        ...readPackage(body, false),
        isActive: optionalBoolean(body.isActive, "isActive"),
        clear,
      }),
    );
    await events.emit({ action: "record_updated", target: { table: "photo_packages", id }, before, after: row });
    return shapePackage(row);
  }

  async listGroups() {
    return (await query.listPhotoGroups()).map(shapeGroup);
  }

  /** @throws {ApiError} 404. */
  async getGroup(groupId) {
    const group = await requireGroup(groupId);
    const packages = await query.listGroupPhotoPackages(group.id);
    return { ...shapeGroup(group), packages: packages.map((row) => shapePackage(row, group)) };
  }

  /**
   * Creates a group and its `size` folios, each with a fresh code, so the sheets can be printed
   * before anyone signs up. Without `packageIds` it offers every active package.
   *
   * @throws {ApiError} 400, 409 on a code already used by another group.
   */
  async createGroup(input) {
    const body = input ?? {};
    const size = readSize(body.size, "size");
    const startsAt = optionalInstant(body.eventStartsAt, "eventStartsAt");
    const endsAt = optionalInstant(body.eventEndsAt, "eventEndsAt");
    if (startsAt === null || endsAt === null) throw ApiError.badRequest("eventStartsAt and eventEndsAt are required.");
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw ApiError.badRequest("eventEndsAt must be after eventStartsAt.");
    const codes = newCodes(size);
    const row = await translate(() =>
      query.createPhotoGroup({
        name: requireText(body.name, "name", 200),
        code: readGroupCode(body.code),
        startsAt,
        endsAt,
        presaleUntil: optionalInstant(body.presaleUntil, "presaleUntil"),
        downloadDays: readDays(body.downloadDays),
        notes: optionalText(body.notes, "notes", 2000),
        createdBy: currentActor().id,
        packageIds: body.packageIds === undefined ? null : uniqueIds(body.packageIds, "packageIds"),
        hashes: codes.map(hashCode),
        sealed: codes.map(seal),
      }),
    );
    await events.emit({ action: "record_created", target: { table: "photo_groups", id: row.id }, after: row });
    return this.getGroup(row.id);
  }

  /**
   * Edits a group. A new `downloadDays` also moves the deadline of folios already ready.
   * `closed: true` closes it. `packageIds` replaces what it offers.
   *
   * @throws {ApiError} 400, 404.
   */
  async updateGroup(groupId, input) {
    const before = await requireGroup(groupId);
    const body = input ?? {};
    const startsAt = optionalInstant(body.eventStartsAt, "eventStartsAt");
    const endsAt = optionalInstant(body.eventEndsAt, "eventEndsAt");
    const starts = startsAt ?? new Date(before.event_starts_at).toISOString();
    const ends = endsAt ?? new Date(before.event_ends_at).toISOString();
    if (Date.parse(ends) <= Date.parse(starts)) throw ApiError.badRequest("eventEndsAt must be after eventStartsAt.");
    const row = await translate(() =>
      query.updatePhotoGroup(before.id, {
        name: optionalText(body.name, "name", 200),
        startsAt,
        endsAt,
        presaleUntil: optionalInstant(body.presaleUntil, "presaleUntil"),
        downloadDays: readDays(body.downloadDays),
        notes: optionalText(body.notes, "notes", 2000),
        closed: optionalBoolean(body.closed, "closed"),
        packageIds: body.packageIds === undefined ? null : uniqueIds(body.packageIds, "packageIds"),
        clear: ["presaleUntil", "notes"].filter((key) => key in body && body[key] === null),
      }),
    );
    await events.emit({ action: "record_updated", target: { table: "photo_groups", id: before.id }, before, after: row });
    return this.getGroup(before.id);
  }

  /** Adds `count` folios after the group's last one. @throws {ApiError} 400, 404. */
  async addFolios(groupId, input) {
    const group = await requireGroup(groupId);
    const count = readSize(input?.count, "count");
    if (group.size + count > MAX_GROUP_SIZE) {
      throw ApiError.badRequest(`A group has at most ${MAX_GROUP_SIZE} folios.`);
    }
    const codes = newCodes(count);
    await translate(() => query.addPhotoFolios(group.id, codes.map(hashCode), codes.map(seal)));
    await events.emit({ action: "record_updated", target: { table: "photo_groups", id: group.id }, before: group, after: { added: count } });
    return this.listFolios(group.id);
  }

  /** The group's folios without their codes. @throws {ApiError} 404. */
  async listFolios(groupId) {
    const group = await requireGroup(groupId);
    return (await query.listPhotoFolios(group.id)).map((row) => shapeFolio(row));
  }

  /** The group's folios with their codes, for printing the sheets. @throws {ApiError} 404. */
  async listSheets(groupId) {
    const group = await requireGroup(groupId);
    return (await query.listPhotoFolios(group.id)).map((row) => ({
      ...shapeFolio(row),
      code: formatCode(open(row.code_enc)),
    }));
  }

  /**
   * The folio a typed or scanned code opens, for the desk. Accepts the bare code or a whole
   * portal link, as the scanner reads it.
   *
   * @throws {ApiError} 404.
   */
  async findFolio(rawCode) {
    const folio = await folioByCode(codeFromInput(rawCode));
    return this.getFolio(folio.id);
  }

  /** The folio with its photos and the packages its group offers. @throws {ApiError} 404. */
  async getFolio(folioId) {
    const folio = await requireFolio(folioId);
    const [files, packages] = await Promise.all([
      query.listPhotoFiles(folio.id),
      query.listGroupPhotoPackages(folio.group_id),
    ]);
    return {
      ...shapeFolio(folio),
      files: files.map(shapeFile),
      packages: packages.map((row) => shapePackage(row, folio)),
    };
  }

  /**
   * Captures or corrects the client's data by hand, as when a sheet comes back filled on paper.
   *
   * @throws {ApiError} 400, 404.
   */
  async updateFolio(folioId, input) {
    const before = await requireFolio(folioId);
    const fields = await readRegistration(input ?? {}, before, false);
    if (before.status === "generated") {
      Object.assign(fields, { status: "registered", registered_via: "manual", registered_at: new Date() });
    }
    const row = await query.updatePhotoFolio(before.id, fields);
    await audit("record_updated", before, row);
    return this.getFolio(before.id);
  }

  /**
   * Records the cajas payment. It copies the package's name, counts and price onto the folio
   * now, so a later catalog change never rewrites a sale. `amount` overrides the catalog price.
   *
   * @throws {ApiError} 400 on a package the group does not offer or a folio with no name, 404, 409 when already paid.
   */
  async recordPayment(folioId, input) {
    const before = await requireFolio(folioId);
    const body = input ?? {};
    if (before.paid_at) throw ApiError.conflict("This folio is already paid.");
    if (!before.full_name) throw ApiError.badRequest("Register the client's name before recording the payment.");
    const pkg = await offeredPackage(before, requireId(body.packageId ?? before.package_id, "packageId"));
    const amount = body.amount === undefined || body.amount === null ? priceNow(pkg, before) : readMoney(body.amount, "amount");
    const row = await query.updatePhotoFolio(before.id, {
      package_id: pkg.id,
      package_name: pkg.name,
      digital_count: pkg.digital_count,
      print_count: pkg.print_count,
      amount,
      caja_folio: requireText(body.cajaFolio, "cajaFolio", 100),
      paid_at: new Date(),
      paid_by: currentActor().id,
      status: stageAtLeast(before.status, "paid"),
    });
    await audit("record_updated", before, row);
    return this.getFolio(before.id);
  }

  /**
   * Stores one photo of a paid folio in the photos bucket, sent in a single request.
   *
   * @param {object} upload `kind`, `name`, `mime` (or null) and the `body` stream.
   * @throws {ApiError} 400 on a bad kind, a bad name or a body that is not an image.
   * @throws {ApiError} 404, 409 before payment, 413.
   */
  async uploadPhoto(folioId, { kind, name, mime = null, body }) {
    const folio = await uploadableFolio(folioId, kind);
    const cleanName = requireText(name, "name", 255);
    const bytes = await readBody(body, PHOTO_MAX_BYTES);
    let stored;
    try {
      stored = await putContent(bytes, { store: "photos" });
    } catch (err) {
      throw translateStorage(err);
    }
    return savePhoto(folio, { kind, name: cleanName, mime, bytes, stored });
  }

  /**
   * Starts a photo upload in parts, so no single request is large or slow enough to fail through
   * a Cloudflare tunnel. The caller sends the parts in order, then finishes.
   *
   * @param {object} input `kind`, `name` and `mime` (or null).
   * @returns {Promise<string>} The upload id for the next calls.
   * @throws {ApiError} 400, 404, 409 before payment.
   */
  async beginUpload(folioId, input) {
    const body = input ?? {};
    const folio = await uploadableFolio(folioId, body.kind);
    const name = requireText(body.name, "name", 255);
    sweepStaleUploads();
    let multipart;
    try {
      multipart = await beginMultipart("photos");
    } catch (err) {
      throw translateStorage(err);
    }
    const uploadId = randomUUID();
    pendingUploads.set(uploadId, {
      userId: currentActor().id,
      folioId: folio.id,
      kind: body.kind,
      name,
      mime: optionalText(body.mime, "mime", 255),
      key: multipart.key,
      s3UploadId: multipart.s3UploadId,
      parts: [],
      bytes: 0,
      createdAt: Date.now(),
    });
    return uploadId;
  }

  /**
   * Receives one part. Parts arrive in order from 1. Each part before the last is at least 5 MB.
   *
   * @throws {ApiError} 400 on a part out of order, 403, 404, 413 past the photo size limit.
   */
  async uploadChunk(uploadId, partNumber, body) {
    const session = requireUpload(uploadId);
    const number = Number(partNumber);
    if (number !== session.parts.length + 1) {
      throw ApiError.badRequest(`Send part ${session.parts.length + 1} next.`);
    }
    let result;
    try {
      result = await uploadPart(session.key, session.s3UploadId, number, body, "photos");
    } catch (err) {
      throw translateStorage(err);
    }
    if (session.bytes + result.size > PHOTO_MAX_BYTES) {
      await this.abortUpload(uploadId);
      throw new ApiError(413, `A photo is at most ${Math.floor(PHOTO_MAX_BYTES / 1024 / 1024)} MB.`);
    }
    session.bytes += result.size;
    session.parts.push({ partNumber: number, etag: result.etag });
    return { partNumber: number, size: result.size };
  }

  /**
   * Joins the parts, checks the result is an image, makes a proof's preview and saves the photo.
   *
   * @throws {ApiError} 400 without parts or on a file that is not an image, 403, 404, 409, 503.
   */
  async finishUpload(uploadId) {
    const session = requireUpload(uploadId);
    if (session.parts.length === 0) throw ApiError.badRequest("No parts uploaded.");
    pendingUploads.delete(uploadId);
    const folio = await uploadableFolio(session.folioId, session.kind);
    let stored;
    let bytes;
    try {
      stored = await completeMultipart(session.key, session.s3UploadId, session.parts, "photos");
      bytes = await readBody((await readContent(stored.hash, "photos")).stream, PHOTO_MAX_BYTES);
    } catch (err) {
      throw translateStorage(err);
    }
    return savePhoto(folio, { kind: session.kind, name: session.name, mime: session.mime, bytes, stored });
  }

  /** Cancels a photo upload in parts and drops what it sent. @throws {ApiError} 403, 404. */
  async abortUpload(uploadId) {
    const session = requireUpload(uploadId);
    pendingUploads.delete(uploadId);
    await abortMultipart(session.key, session.s3UploadId, "photos");
  }

  /** Removes one photo and, once nothing else uses them, its bytes. @throws {ApiError} 404. */
  async deletePhoto(fileId) {
    const id = requireId(fileId, "fileId");
    const row = await query.deletePhotoFile(id);
    if (!row) throw ApiError.notFound("Photo not found.");
    await events.emit({ action: "record_deleted", target: { table: "photo_files", id }, before: row });
    await reclaim([row.hash, row.preview_hash]);
  }

  /** A photo as uploaded, for staff. @throws {ApiError} 404, 503. */
  async readPhoto(fileId, range = null) {
    const file = await query.getPhotoFile(requireId(fileId, "fileId"));
    if (!file) throw ApiError.notFound("Photo not found.");
    return openContent(file, file.hash, file.name, range);
  }

  /** A proof's watermarked preview. @throws {ApiError} 404, 503. */
  async readPreview(fileId, range = null) {
    const file = await query.getPhotoFile(requireId(fileId, "fileId"));
    if (!file?.preview_hash) throw ApiError.notFound("Preview not found.");
    return openContent({ ...file, mime: "image/jpeg" }, file.preview_hash, previewName(file.name), range);
  }

  /**
   * Opens the download window: the folio's finals become downloadable for the group's
   * `download_days`, counted from now.
   *
   * @throws {ApiError} 404, 409 without any final photo.
   */
  async markReady(folioId) {
    const before = await requireFolio(folioId);
    const files = await query.listPhotoFiles(before.id);
    if (!files.some((file) => file.kind === "final")) throw ApiError.conflict("Upload the edited photos first.");
    const now = new Date();
    const row = await query.updatePhotoFolio(before.id, {
      ready_at: now,
      expires_at: new Date(now.getTime() + before.download_days * MS_PER_DAY),
      status: stageAtLeast(before.status, "ready"),
    });
    await audit("record_updated", before, row);
    return this.getFolio(before.id);
  }

  /** @throws {ApiError} 404, 409 when the package has no prints or the photos are not ready. */
  async markPrinted(folioId) {
    const before = await requireFolio(folioId);
    if (!before.print_count) throw ApiError.conflict("This folio's package has no prints.");
    if (!before.ready_at) throw ApiError.conflict("Mark the photos ready before printing.");
    const row = await query.updatePhotoFolio(before.id, { printed_at: new Date(), status: stageAtLeast(before.status, "printed") });
    await audit("record_updated", before, row);
    return this.getFolio(before.id);
  }

  /** Records that staff handed over the prints. @throws {ApiError} 404, 409 before printing. */
  async markDelivered(folioId) {
    const before = await requireFolio(folioId);
    if (!before.printed_at) throw ApiError.conflict("Mark the prints as printed first.");
    const row = await query.updatePhotoFolio(before.id, { delivered_at: new Date(), status: "delivered" });
    await audit("record_updated", before, row);
    return this.getFolio(before.id);
  }

  /**
   * Deletes the photos of every folio past its download window, and their bytes once no live
   * photo shares them.
   *
   * @returns {Promise<{folios: number, reclaimed: number}>}
   */
  async expire(now = new Date()) {
    const rows = await query.expirePhotoFolios(now.toISOString());
    const reclaimed = await reclaim(rows.flatMap((row) => [row.hash, row.preview_hash]));
    return { folios: new Set(rows.map((row) => row.folio_id)).size, reclaimed };
  }

  /** What the client's page shows for a code. @throws {ApiError} 404. */
  async portal(rawCode) {
    const folio = await folioByCode(codeFromInput(rawCode));
    const [files, packages] = await Promise.all([
      query.listPhotoFiles(folio.id),
      query.listGroupPhotoPackages(folio.group_id),
    ]);
    return shapePortal(folio, files, packages);
  }

  /**
   * The client fills in their own data and picks a package. Only before the payment: after it,
   * corrections go through the desk.
   *
   * @throws {ApiError} 400, 404, 409 once paid.
   */
  async register(rawCode, input) {
    const before = await folioByCode(codeFromInput(rawCode));
    if (!["generated", "registered"].includes(before.status)) {
      throw ApiError.conflict("This folio is already paid; ask the photo desk to change its data.");
    }
    if (before.group_closed_at) throw ApiError.conflict("This group is closed.");
    const fields = await readRegistration(input ?? {}, before, true);
    const row = await query.updatePhotoFolio(before.id, {
      ...fields,
      status: "registered",
      registered_via: before.registered_via ?? "qr",
      registered_at: before.registered_at ?? new Date(),
    });
    await audit("record_updated", before, row);
    return this.portal(rawCode);
  }

  /**
   * The client's pick among their proofs, at most the package's digital count. `lock: true`
   * sends it to editing and freezes it.
   *
   * @throws {ApiError} 400 on a photo not theirs or too many, 404, 409 before proofs or once locked.
   */
  async select(rawCode, input) {
    const folio = await folioByCode(codeFromInput(rawCode));
    if (folio.selection_locked_at) throw ApiError.conflict("Your selection is already sent.");
    if (folio.status !== "proofs") throw ApiError.conflict("Your photos are not ready to choose yet.");
    const fileIds = uniqueIds(input?.fileIds, "fileIds");
    const proofs = new Set((await query.listPhotoFiles(folio.id)).filter((f) => f.kind === "proof").map((f) => String(f.id)));
    if (fileIds.some((id) => !proofs.has(String(id)))) throw ApiError.badRequest("One of those photos is not yours.");
    if (fileIds.length > folio.digital_count) {
      throw ApiError.badRequest(`Your package includes ${folio.digital_count} photos.`);
    }
    await query.setPhotoSelection(folio.id, fileIds);
    if (optionalBoolean(input?.lock, "lock")) {
      if (fileIds.length === 0) throw ApiError.badRequest("Choose at least one photo.");
      const row = await query.updatePhotoFolio(folio.id, { selection_locked_at: new Date(), status: "selected" });
      await audit("record_updated", folio, row);
    }
    return this.portal(rawCode);
  }

  /** A proof preview of the code's own folio. @throws {ApiError} 404. */
  async portalPreview(rawCode, fileId, range = null) {
    const { file } = await ownFile(rawCode, fileId);
    if (!file.preview_hash) throw ApiError.notFound("Preview not found.");
    return openContent({ ...file, mime: "image/jpeg" }, file.preview_hash, previewName(file.name), range);
  }

  /**
   * One final photo of the code's own folio, or one piece of it with `range`. It logs a download
   * in photo_downloads once, on its first piece.
   *
   * @throws {ApiError} 404, 409 before ready or after the window closed, 416.
   */
  async download(rawCode, fileId, ip = null, range = null) {
    const { file } = await ownFinal(rawCode, fileId);
    const content = await openContent(file, file.hash, file.name, range);
    if (!range || range.start === 0) await query.insertPhotoDownload(file.id, ip);
    return content;
  }

  /**
   * A small JPEG of one final photo of the code's own folio, for the list of downloads. It is not
   * a download and is not logged.
   *
   * @returns {Promise<Buffer>}
   * @throws {ApiError} 404, 409 before ready or after the window closed, 503.
   */
  async portalThumbnail(rawCode, fileId) {
    const { file } = await ownFinal(rawCode, fileId);
    let bytes;
    try {
      const content = await readContent(file.hash, "photos");
      if (!content) throw ApiError.notFound("Photo not found.");
      bytes = await readBody(content.stream, PHOTO_MAX_BYTES);
    } catch (err) {
      throw translateStorage(err);
    }
    return sharp(bytes)
      .rotate()
      .resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
  }
}

/**
 * Turns typed or scanned text into a code. It uppercases, drops spaces and dashes, and reads O as 0
 * and I or L as 1. From a whole portal link it takes the `photo` parameter.
 *
 * @returns {string|null} null when it cannot be a code.
 */
export function normalizeCode(raw) {
  const code = codeParam(String(raw ?? "").trim())
    .toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE_RE.test(code) ? code : null;
}

/** The `photo` parameter when `text` is a portal link, else `text` itself. */
function codeParam(text) {
  try {
    return new URL(text).searchParams.get("photo") ?? text;
  } catch {
    return text;
  }
}

/** `ABCD1234` as printed on the sheet, `ABCD-1234`. */
export function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** @throws {ApiError} 404, the same answer as a code nobody has, so a bad code reveals nothing. */
function codeFromInput(raw) {
  const code = normalizeCode(raw);
  if (!code) throw ApiError.notFound("Folio not found.");
  return code;
}

function newCodes(count) {
  const codes = new Set();
  while (codes.size < count) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
    codes.add(code);
  }
  return [...codes];
}

function hashCode(code) {
  return createHash("sha256").update(code).digest("hex");
}

/** @throws {ApiError} 404. */
async function folioByCode(code) {
  const folio = await query.getPhotoFolio({ hash: hashCode(code) });
  if (!folio) throw ApiError.notFound("Folio not found.");
  return folio;
}

/** @throws {ApiError} 400, 404. */
async function requireFolio(folioId) {
  const folio = await query.getPhotoFolio({ id: requireId(folioId, "folioId") });
  if (!folio) throw ApiError.notFound("Folio not found.");
  return folio;
}

/** @throws {ApiError} 400, 404. */
async function requireGroup(groupId) {
  const group = await query.getPhotoGroup(requireId(groupId, "groupId"));
  if (!group) throw ApiError.notFound("Group not found.");
  return group;
}

/**
 * A final photo of the code's own folio while its download window is open.
 *
 * @throws {ApiError} 404 for anyone else's or a proof, 409 before ready or after the window closed.
 */
async function ownFinal(rawCode, fileId) {
  const { folio, file } = await ownFile(rawCode, fileId);
  if (file.kind !== "final") throw ApiError.notFound("Photo not found.");
  if (!folio.ready_at) throw ApiError.conflict("Your photos are not ready yet.");
  if (folio.files_expired_at || Date.parse(folio.expires_at) <= Date.now()) {
    throw ApiError.conflict("The download period for these photos has ended.");
  }
  return { folio, file };
}

/** A live photo of the code's own folio. @throws {ApiError} 404 for anyone else's. */
async function ownFile(rawCode, fileId) {
  const folio = await folioByCode(codeFromInput(rawCode));
  const file = await query.getPhotoFile(requireId(fileId, "fileId"));
  if (!file || String(file.folio_id) !== String(folio.id)) throw ApiError.notFound("Photo not found.");
  return { folio, file };
}

/** @throws {ApiError} 400 when the group does not offer it or the catalog retired it. */
async function offeredPackage(folio, packageId) {
  const offered = await query.listGroupPhotoPackages(folio.group_id);
  const pkg = offered.find((row) => String(row.id) === String(packageId));
  if (!pkg || !pkg.is_active) throw ApiError.badRequest("This group does not offer that package.");
  return pkg;
}

/** The pre-sale price before the group's `presale_until`, the full price after. */
function priceNow(pkg, group, now = Date.now()) {
  const presale = group.presale_until && now < Date.parse(group.presale_until) && pkg.presale_price !== null;
  return presale ? pkg.presale_price : pkg.price;
}

/** `current` or `floor`, whichever is further along. */
function stageAtLeast(current, floor) {
  return STATUSES.indexOf(current) >= STATUSES.indexOf(floor) ? current : floor;
}

/**
 * The client data in a registration. The portal needs the name, the email and a package. At the
 * desk every field is optional and only the given ones change.
 */
async function readRegistration(body, folio, fromPortal) {
  const fields = {};
  const name = fromPortal ? requireText(body.fullName, "fullName", 200) : optionalText(body.fullName, "fullName", 200);
  if (name !== null) fields.full_name = name;
  const email = optionalText(body.email, "email", 254);
  if (email !== null) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest("email does not look like an address.");
    fields.email = email.toLowerCase();
  } else if (fromPortal) {
    throw ApiError.badRequest("email is required.");
  }
  const phone = optionalText(body.phone, "phone", 30);
  if (phone !== null) fields.phone = phone;
  const schoolId = optionalText(body.schoolId, "schoolId", 50);
  if (schoolId !== null) fields.school_id = schoolId;
  const packageId = fromPortal ? requireId(body.packageId, "packageId") : (body.packageId == null ? null : requireId(body.packageId, "packageId"));
  if (packageId !== null) {
    if (folio.paid_at) throw ApiError.conflict("The package of a paid folio does not change.");
    fields.package_id = (await offeredPackage(folio, packageId)).id;
  }
  return fields;
}

function readPackage(body, creating) {
  const pick = (key, read) => (body[key] === undefined || body[key] === null ? null : read(body[key], key));
  const fields = {
    name: creating ? requireText(body.name, "name", 100) : optionalText(body.name, "name", 100),
    description: optionalText(body.description, "description", 2000),
    digitalCount: pick("digitalCount", readCount),
    printCount: pick("printCount", readCount),
    price: pick("price", readMoney),
    presalePrice: pick("presalePrice", readMoney),
  };
  if (creating && (fields.digitalCount === null || fields.price === null)) {
    throw ApiError.badRequest("digitalCount and price are required.");
  }
  if (fields.digitalCount === 0) throw ApiError.badRequest("digitalCount must be at least 1.");
  if (creating) fields.printCount ??= 0;
  return fields;
}

/** @throws {ApiError} 400 when not a whole number from 0 to 500. */
function readCount(value, field) {
  const n = requireInt(value, field);
  if (n < 0 || n > 500) throw ApiError.badRequest(`${field} must be between 0 and 500.`);
  return n;
}

/** @throws {ApiError} 400 when not a non-negative amount with at most two decimals. */
function readMoney(value, field) {
  const n = Number(value);
  if (typeof value === "boolean" || !Number.isFinite(n) || n < 0 || Math.round(n * 100) !== n * 100) {
    throw ApiError.badRequest(`${field} must be a non-negative amount with at most two decimals.`);
  }
  return n.toFixed(2);
}

/** @throws {ApiError} 400 when not a whole number from 1 to MAX_GROUP_SIZE. */
function readSize(value, field) {
  const n = requireInt(value, field);
  if (n < 1 || n > MAX_GROUP_SIZE) throw ApiError.badRequest(`${field} must be between 1 and ${MAX_GROUP_SIZE}.`);
  return n;
}

/** Null when absent, so the group takes the configured retention. @throws {ApiError} 400. */
function readDays(value) {
  if (value === undefined || value === null || value === "") return null;
  const days = requireInt(value, "downloadDays");
  if (days < 1 || days > 3650) throw ApiError.badRequest("downloadDays must be between 1 and 3650.");
  return days;
}

/** @throws {ApiError} 400 when not 1 to 12 letters or digits. */
function readGroupCode(value) {
  const code = requireText(value, "code", 12).toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(code)) throw ApiError.badRequest("code must be 1 to 12 letters or digits.");
  return code;
}

/** Reads the whole request body. @throws {ApiError} 413 past `max` bytes. */
async function readBody(stream, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw new ApiError(413, `A photo is at most ${Math.floor(max / 1024 / 1024)} MB.`);
    chunks.push(chunk);
  }
  if (size === 0) throw ApiError.badRequest("The photo is empty.");
  return Buffer.concat(chunks, size);
}

/** @throws {ApiError} 400 when `bytes` is not an image sharp can read. */
async function assertImage(bytes) {
  try {
    await sharp(bytes).metadata();
  } catch {
    throw ApiError.badRequest("That file is not an image.");
  }
}

/**
 * A small JPEG of the photo with the watermark burned in, so a preview is never worth keeping
 * instead of buying. Diagonal bands mark it even where the server has no font for the text.
 *
 * @throws {ApiError} 400 when `bytes` is not an image.
 */
async function makePreview(bytes) {
  let resized;
  try {
    resized = await sharp(bytes)
      .rotate()
      .resize({ width: PREVIEW_PX, height: PREVIEW_PX, fit: "inside", withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw ApiError.badRequest("That file is not an image.");
  }
  const { width, height } = resized.info;
  const tile = Math.max(320, Math.round(Math.max(width, height) * 0.6));
  const rise = Math.round(tile * 0.4);
  const font = Math.round(tile / 15);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><pattern id="w" width="${tile}" height="${rise}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <rect y="${rise / 2 - font}" width="${tile}" height="${font * 1.6}" fill="white" fill-opacity="0.15"/>
      <text x="${tile / 2}" y="${rise / 2 + font * 0.35}" font-family="sans-serif" font-size="${font}" font-weight="bold"
            fill="white" fill-opacity="0.8" stroke="black" stroke-opacity="0.3" stroke-width="1"
            text-anchor="middle">IMAGEN UAQ · MUESTRA</text>
    </pattern></defs>
    <rect width="100%" height="100%" fill="url(#w)"/>
  </svg>`;
  return sharp(resized.data)
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 70 })
    .toBuffer();
}

/** Deletes each hash from the photos bucket once no live photo uses it. It skips null entries. */
async function reclaim(hashes) {
  let reclaimed = 0;
  for (const hash of new Set(hashes.filter(Boolean))) {
    if (await query.photoHashInUse(hash)) continue;
    try {
      if (await deleteContent(hash, "photos")) reclaimed += 1;
    } catch (err) {
      console.error(`Could not delete photo content ${hash}:`, err);
    }
  }
  return reclaimed;
}

/**
 * The bytes of a photo, whole or one piece. A `range` of `{start, end}` (end may be null) is cut to
 * at most MAX_RANGE bytes. The result's `range` says which bytes came, out of how many.
 *
 * @throws {ApiError} 404 when the bytes are gone, 416 past the end, 503 when storage is down.
 */
async function openContent(file, hash, name, range = null) {
  let content;
  let span = null;
  try {
    if (range) {
      const stat = await statContent(hash, "photos");
      if (!stat) throw ApiError.notFound("Photo not found.");
      if (range.start >= stat.size) throw new ApiError(416, "That range is past the end of the photo.");
      const end = Math.min(range.end ?? stat.size - 1, range.start + MAX_RANGE - 1, stat.size - 1);
      span = { start: range.start, end, total: stat.size };
    }
    content = await readContent(hash, "photos", span);
  } catch (err) {
    throw translateStorage(err);
  }
  if (!content) throw ApiError.notFound("Photo not found.");
  return { file: { ...file, name }, stream: content.stream, size: content.size, range: span };
}

/**
 * Checks a photo's bytes, makes a proof's watermarked preview and inserts the row. When the bytes
 * are not an image, it deletes them again.
 *
 * @throws {ApiError} 400 when the bytes are not an image, 503.
 */
async function savePhoto(folio, { kind, name, mime, bytes, stored }) {
  let preview = null;
  try {
    if (kind === "proof") preview = await makePreview(bytes);
    else await assertImage(bytes);
  } catch (err) {
    await reclaim([stored.hash]);
    throw err;
  }
  let storedPreview = null;
  try {
    if (preview) storedPreview = await putContent(preview, { store: "photos" });
  } catch (err) {
    throw translateStorage(err);
  }
  const row = await query.insertPhotoFile({
    folioId: folio.id,
    kind,
    hash: stored.hash,
    previewHash: storedPreview?.hash ?? null,
    name,
    size: stored.size,
    mime: optionalText(mime, "Content-Type", 255),
    uploadedBy: currentActor().id,
  });
  await events.emit({ action: "record_created", target: { table: "photo_files", id: row.id }, after: row });
  if (kind === "proof" && folio.status === "paid") {
    await query.updatePhotoFolio(folio.id, { status: "proofs" });
  }
  return shapeFile(row);
}

/** A folio that takes photos of `kind`. @throws {ApiError} 400 on a bad kind, 404, 409 before payment or after expiry. */
async function uploadableFolio(folioId, kind) {
  const folio = await requireFolio(folioId);
  if (kind !== "proof" && kind !== "final") throw ApiError.badRequest("kind must be proof or final.");
  if (!folio.paid_at) throw ApiError.conflict("Photos go to a folio once it is paid.");
  if (folio.files_expired_at) throw ApiError.conflict("This folio's photos already expired.");
  return folio;
}

/** The caller's own upload in parts. @throws {ApiError} 404, 403 for anyone else's. */
function requireUpload(uploadId) {
  const session = pendingUploads.get(String(uploadId));
  if (!session) throw ApiError.notFound("Upload not found.");
  if (String(session.userId) !== String(currentActor().id)) throw ApiError.forbidden("Not your upload.");
  return session;
}

/** Drops the uploads in parts older than UPLOAD_TTL_MS and their parts in storage. */
function sweepStaleUploads() {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  for (const [id, session] of pendingUploads) {
    if (session.createdAt < cutoff) {
      pendingUploads.delete(id);
      abortMultipart(session.key, session.s3UploadId, "photos").catch(() => {});
    }
  }
}

function previewName(name) {
  return `muestra-${name.replace(/\.[^.]+$/, "")}.jpg`;
}

function translateStorage(err) {
  if (!(err instanceof StorageError)) return err;
  console.error(err);
  return ApiError.unavailable("Photo storage is unavailable.");
}

async function translate(write) {
  try {
    return await write();
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) throw ApiError.conflict("That name or code is already taken.");
    if (err?.code === FOREIGN_KEY_VIOLATION) throw ApiError.badRequest("One of those packages does not exist.");
    if (err?.code === CHECK_VIOLATION) throw ApiError.badRequest("A value is out of range.");
    throw err;
  }
}

/** Logs a folio change without its sealed code. */
async function audit(action, before, after) {
  const strip = (row) => (row ? { ...row, code_enc: undefined } : row);
  await events.emit({ action, target: { table: "photo_folios", id: before.id }, before: strip(before), after: strip(after) });
}

/** An amount as finance sends it: a string with two decimals, or null. */
function money(value) {
  return value === null || value === undefined ? null : Number(value).toFixed(2);
}

function shapeRetention(row) {
  return { days: row.days, updatedAt: row.updated_at };
}

/** With `group`, `priceNow` is what the package costs in that group today. */
function shapePackage(row, group = null) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    digitalCount: row.digital_count,
    printCount: row.print_count,
    price: money(row.price),
    presalePrice: money(row.presale_price),
    isActive: row.is_active,
    ...(group ? { priceNow: money(priceNow(row, group)) } : {}),
  };
}

function shapeGroup(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    size: row.size,
    eventId: row.event_id,
    eventStartsAt: row.event_starts_at,
    eventEndsAt: row.event_ends_at,
    presaleUntil: row.presale_until,
    downloadDays: row.download_days,
    notes: row.notes,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    ...(row.by_status ? { byStatus: row.by_status } : {}),
    ...("active_packages" in row ? { activePackages: row.active_packages } : {}),
    ...(row.package_ids ? { packageIds: row.package_ids } : {}),
  };
}

function shapeFolio(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    number: row.number,
    label: `${row.group_code}-${String(row.number).padStart(3, "0")}`,
    status: row.status,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    schoolId: row.school_id,
    registeredVia: row.registered_via,
    registeredAt: row.registered_at,
    packageId: row.package_id,
    packageName: row.package_name,
    digitalCount: row.digital_count,
    printCount: row.print_count,
    amount: money(row.amount),
    cajaFolio: row.caja_folio,
    paidAt: row.paid_at,
    selectionLockedAt: row.selection_locked_at,
    readyAt: row.ready_at,
    expiresAt: row.expires_at,
    filesExpiredAt: row.files_expired_at,
    printedAt: row.printed_at,
    deliveredAt: row.delivered_at,
    ...("proof_count" in row ? { proofCount: row.proof_count, finalCount: row.final_count } : {}),
  };
}

function shapeFile(row) {
  return {
    id: row.id,
    folioId: row.folio_id,
    kind: row.kind,
    name: row.name,
    size: row.size,
    selected: row.selected,
    downloads: row.downloads ?? 0,
    createdAt: row.created_at,
  };
}

/** The client's view: no staff fields, no originals of proofs, the days left to download. */
function shapePortal(folio, files, packages) {
  const expires = folio.expires_at ? Date.parse(folio.expires_at) : null;
  const downloadable = Boolean(folio.ready_at && !folio.files_expired_at && expires > Date.now());
  return {
    label: `${folio.group_code}-${String(folio.number).padStart(3, "0")}`,
    groupName: folio.group_name,
    eventStartsAt: folio.event_starts_at,
    eventEndsAt: folio.event_ends_at,
    presaleUntil: folio.presale_until,
    status: folio.status,
    fullName: folio.full_name,
    email: folio.email,
    phone: folio.phone,
    schoolId: folio.school_id,
    packageId: folio.package_id,
    packageName: folio.package_name,
    digitalCount: folio.digital_count,
    printCount: folio.print_count,
    amount: money(folio.amount),
    paid: Boolean(folio.paid_at),
    selectionLocked: Boolean(folio.selection_locked_at),
    printedAt: folio.printed_at,
    deliveredAt: folio.delivered_at,
    expiresAt: folio.expires_at,
    daysLeft: downloadable ? Math.ceil((expires - Date.now()) / MS_PER_DAY) : null,
    expired: Boolean(folio.files_expired_at),
    packages: packages.filter((row) => row.is_active).map((row) => shapePackage(row, folio)),
    proofs: files
      .filter((file) => file.kind === "proof")
      .map((file) => ({ id: file.id, name: file.name, selected: file.selected })),
    finals: downloadable
      ? files.filter((file) => file.kind === "final").map((file) => ({ id: file.id, name: file.name, size: file.size, downloads: file.downloads }))
      : [],
  };
}

export default new Photos();
