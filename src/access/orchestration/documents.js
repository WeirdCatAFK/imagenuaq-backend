// Folders, files and share links. Names and folders live in Postgres and bytes in MinIO under
// their SHA-256, so renames and moves never touch MinIO. Upload the bytes first, then insert the row.
import { createHash, randomBytes } from "node:crypto";

import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import { putContent, readContent, deleteContent, StorageError } from "../primitives/minioStorage.js";
import {
  FOREIGN_KEY_VIOLATION,
  CHECK_VIOLATION,
  requireText,
  optionalText,
  requireId,
  optionalId,
} from "../../utils/validate.js";

const NAME_MAX = 255;
const MIME_MAX = 255;
const LEVELS = ["read", "write"];

/** Path separators and control characters: a name is one segment, and it ends up in a header. */
const BAD_NAME = /[/\\\u0000-\u001f\u007f]/;

class Documents {
  /** The folders the caller starts browsing from. */
  async listTop() {
    const actor = currentActor();
    const all = isAdmin(actor) || (await browses(actor));
    const rows = await query.listTopFolders(all ? null : actor.id);
    return rows.map(shapeFolder);
  }

  /**
   * A folder with its subfolders, files and area grants.
   *
   * @throws {ApiError} 404 when missing or not readable.
   */
  async getFolder(folderId) {
    const id = requireId(folderId, "folderId");
    const { folder, access } = await this.#readable(id);
    const [folders, files, areas] = await Promise.all([
      query.listChildFolders(id),
      query.listFolderFiles(id),
      query.listFolderAreas(id),
    ]);
    return {
      ...shapeFolder(folder),
      access,
      folders: folders.map(shapeFolder),
      files: files.map(shapeFile),
      areas: areas.map(shapeGrant),
    };
  }

  /**
   * A root when `parentId` is omitted (owned by the caller), else a subfolder, which needs
   * write on the parent.
   *
   * @throws {ApiError} 400, 403, 404.
   */
  async createFolder({ parentId = null, name }) {
    const actor = currentActor();
    const parent = optionalId(parentId, "parentId");
    const cleanName = requireName(name);
    if (parent !== null) await this.#writable(parent);

    try {
      const row = await query.createFolder({ parentId: parent, name: cleanName, ownerId: actor.id });
      await events.emit({
        action: "record_created",
        target: { table: "folders", id: row.id },
        after: row,
      });
      return shapeFolder(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Renames and/or moves. `parentId: null` makes it a root, which only its owner may do;
   * moving under another folder needs write there too.
   *
   * @throws {ApiError} 400 (including a move into its own subtree), 403, 404.
   */
  async updateFolder(folderId, { name, parentId }) {
    const id = requireId(folderId, "folderId");
    const { folder, access } = await this.#writable(id);
    const cleanName = name === undefined ? null : requireName(name);
    const parent = parentId === undefined ? undefined : optionalId(parentId, "parentId");

    if (parent === null && access !== "owner") {
      throw ApiError.forbidden("Only the folder's owner can make it a root.");
    }
    if (parent != null) await this.#writable(parent);

    try {
      const row = await query.updateFolder(id, { name: cleanName, parentId: parent });
      await events.emit({
        action: "record_updated",
        target: { table: "folders", id },
        before: folder,
        after: row,
      });
      return shapeFolder(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Soft-deletes the folder, its subtree and their files. Needs management of the folder.
   *
   * @throws {ApiError} 403, 404.
   */
  async deleteFolder(folderId) {
    const id = requireId(folderId, "folderId");
    await this.#managed(id);
    const row = await query.deleteFolder(id);
    await events.emit({ action: "record_deleted", target: { table: "folders", id }, before: row });
    return {
      ...shapeFolder(row),
      foldersDeleted: row.folders_deleted,
      filesDeleted: row.files_deleted,
    };
  }

  /**
   * Replaces the areas a folder is shared with. Needs management of the folder.
   *
   * @param {Array<{areaId: number, level: 'read'|'write'}>} grants
   * @throws {ApiError} 400, 403, 404.
   */
  async setFolderAreas(folderId, grants) {
    const id = requireId(folderId, "folderId");
    await this.#managed(id);
    const clean = requireGrants(grants);
    const before = await query.listFolderAreas(id);

    try {
      await query.setFolderAreas(id, clean);
    } catch (err) {
      throw translate(err);
    }

    const after = await query.listFolderAreas(id);
    await events.emit({
      action: "record_updated",
      target: { table: "folders", id },
      before: { areas: before },
      after: { areas: after },
    });
    return after.map(shapeGrant);
  }

  /**
   * Stores the bytes, then the row. Needs write on the folder.
   *
   * @param {number} folderId
   * @param {{name: string, mime?: string|null, body: import('node:stream').Readable}} input
   * @throws {ApiError} 400, 403, 404, 413 past MAX_UPLOAD_BYTES, 503
   *   when the store fails.
   */
  async upload(folderId, { name, mime = null, body }) {
    const actor = currentActor();
    const id = requireId(folderId, "folderId");
    const cleanName = requireName(name);
    const cleanMime = optionalText(mime, "Content-Type", MIME_MAX);
    await this.#writable(id);

    let stored;
    try {
      stored = await putContent(body, { maxBytes: maxUploadBytes() });
    } catch (err) {
      throw translateStorage(err);
    }

    try {
      const row = await query.createFile({
        folderId: id,
        authorId: actor.id,
        hash: stored.hash,
        name: cleanName,
        size: stored.size,
        mime: cleanMime,
      });
      await events.emit({ action: "file_uploaded", target: { table: "files", id: row.id }, after: row });
      return shapeFile(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /** @throws {ApiError} 404 when missing or not readable. */
  async getFile(fileId) {
    const { file } = await this.#readableFile(requireId(fileId, "fileId"));
    return shapeFile(file);
  }

  /**
   * The file's metadata and a stream of its content.
   *
   * @throws {ApiError} 404, 503.
   */
  async download(fileId) {
    const { file } = await this.#readableFile(requireId(fileId, "fileId"));

    let content;
    try {
      content = await readContent(file.hash);
    } catch (err) {
      throw translateStorage(err);
    }
    if (!content) throw new Error(`File ${file.id} has a row but no content (hash ${file.hash}).`);

    await events.emit({ action: "file_downloaded", target: { table: "files", id: file.id } });
    return { file: shapeFile(file), stream: content.stream, size: content.size };
  }

  /**
   * Renames and/or moves a file. Needs write where it is and where it goes.
   *
   * @throws {ApiError} 400, 403, 404.
   */
  async updateFile(fileId, { name, folderId }) {
    const id = requireId(fileId, "fileId");
    const { file } = await this.#writableFile(id);
    const cleanName = name === undefined ? null : requireName(name);
    const target = optionalId(folderId, "folderId");
    if (target !== null) await this.#writable(target);

    try {
      const row = await query.updateFile(id, { name: cleanName, folderId: target });
      await events.emit({
        action: "record_updated",
        target: { table: "files", id },
        before: file,
        after: row,
      });
      return shapeFile(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Soft delete; the bytes stay in MinIO. Its author may always delete it, anyone else needs
   * management of the folder.
   *
   * @throws {ApiError} 403, 404.
   */
  async deleteFile(fileId) {
    const id = requireId(fileId, "fileId");
    const { file, access } = await this.#writableFile(id);
    if (file.author_id !== currentActor().id) await this.#requireManage(access);
    const row = await query.deleteFile(id);
    await events.emit({ action: "record_deleted", target: { table: "files", id }, before: row });
    return shapeFile(row);
  }

  /**
   * Issues a read-only link to a folder the caller can see. The route requires
   * `document.share`.
   *
   * @param {number} folderId
   * @param {{expiresAt: string}} input An ISO timestamp in the future.
   * @returns {Promise<object>} The link, with its `token`, which is never shown again.
   * @throws {ApiError} 400, 404.
   */
  async createFolderLink(folderId, { expiresAt }) {
    const id = requireId(folderId, "folderId");
    const expiry = requireFuture(expiresAt);
    await this.#readable(id);

    const token = randomBytes(32).toString("base64url");
    const row = await query.createFolderLink({
      tokenHash: hashToken(token),
      folderId: id,
      authorizer: currentActor().id,
      expiresAt: expiry.toISOString(),
    });
    await events.emit({
      action: "share_token_created",
      target: { table: "access_tokens", id: row.id },
      after: shapeLink(row),
    });
    return { ...shapeLink(row), token };
  }

  /** @throws {ApiError} 404 when the folder is missing or not readable. */
  async listFolderLinks(folderId) {
    const id = requireId(folderId, "folderId");
    await this.#readable(id);
    return (await query.listFolderLinks(id)).map(shapeLink);
  }

  /**
   * Revokes a link on a folder the caller can see. The route requires `document.share`.
   *
   * @throws {ApiError} 404 when the link is unknown, already revoked or its folder hidden.
   */
  async revokeLink(linkId) {
    const id = requireId(linkId, "linkId");
    const link = await query.getLink(id);
    if (!link?.folder_id || link.revoked_at) throw ApiError.notFound("Link not found.");
    await this.#readable(link.folder_id);

    const row = await query.revokeLink(id);
    if (!row) throw ApiError.notFound("Link not found.");
    await events.emit({
      action: "share_token_revoked",
      target: { table: "access_tokens", id },
      before: shapeLink(link),
      after: shapeLink(row),
    });
    return shapeLink(row);
  }

  /**
   * What a share link shows: the linked folder, or `folderId` when it lies beneath it.
   * No session; the token is the credential.
   *
   * @throws {ApiError} 404 when the link does not work or the folder is outside it.
   */
  async sharedFolder(token, folderId = null) {
    const link = await this.#link(token);
    const id = folderId === null ? link.id : requireId(folderId, "folderId");
    if (!(await query.isWithinFolder(id, link.id))) throw ApiError.notFound("Folder not found.");

    const [folder, folders, files] = await Promise.all([
      query.getFolder(id),
      query.listChildFolders(id),
      query.listFolderFiles(id),
    ]);
    return {
      expiresAt: link.expires_at,
      folder: {
        ...shapeSharedFolder(folder),
        folders: folders.map(shapeSharedFolder),
        files: files.map(shapeSharedFile),
      },
    };
  }

  /**
   * A file under a share link, as metadata and a stream of its content.
   *
   * @throws {ApiError} 404, 503.
   */
  async sharedDownload(token, fileId) {
    const link = await this.#link(token);
    const file = await query.getFile(requireId(fileId, "fileId"));
    if (!file || !(await query.isWithinFolder(file.folder_id, link.id))) {
      throw ApiError.notFound("File not found.");
    }

    let content;
    try {
      content = await readContent(file.hash);
    } catch (err) {
      throw translateStorage(err);
    }
    if (!content) throw new Error(`File ${file.id} has a row but no content (hash ${file.hash}).`);

    await events.emit({
      action: "file_downloaded",
      target: { table: "files", id: file.id },
      after: { linkId: link.link_id },
    });
    return { file: shapeSharedFile(file), stream: content.stream, size: content.size };
  }

  /**
   * Gives a project its folder, named by its key and owned by the caller, the first time it is
   * asked, then grants `write` to each area with a stage in the project that has no grant yet
   * (RF-ARC-01, RF-ARC-02). Safe to call again.
   *
   * @param {{id: number, key: string, folderId: number|null}} project
   * @returns {Promise<number>} The project's folder id.
   */
  async ensureProjectFolder(project) {
    let folderId = project.folderId;
    if (folderId == null) {
      const folder = await query.createFolder({
        parentId: null,
        name: project.key,
        ownerId: currentActor().id,
      });
      folderId = await query.setProjectFolder(project.id, folder.id);
      if (String(folderId) !== String(folder.id)) {
        await query.deleteFolder(folder.id);
      } else {
        await events.emit({
          action: "record_created",
          target: { table: "folders", id: folder.id },
          after: folder,
        });
      }
    }

    const added = await query.addProjectFolderAreas(project.id);
    if (added.length > 0) {
      await events.emit({
        action: "record_updated",
        target: { table: "folders", id: folderId },
        after: { areas: added },
      });
    }
    return folderId;
  }

  /** How many months a file lives once its project ends, or since upload outside any project. */
  async getRetention() {
    return shapeRetention(await query.getRetention());
  }

  /**
   * Changes the retention. The route requires `document.manage`.
   *
   * @throws {ApiError} 400 unless `months` is a positive integer.
   */
  async setRetention(months) {
    if (!Number.isInteger(months) || months < 1) {
      throw ApiError.badRequest("months must be a positive integer.");
    }
    const before = await query.getRetention();
    const row = await query.setRetention(months, currentActor().id);
    await events.emit({
      action: "record_updated",
      target: { table: "file_retention", id: 1 },
      before,
      after: row,
    });
    return shapeRetention(row);
  }

  /**
   * Expires every file past retention as of `now`: the row is soft-deleted and logged as
   * `file_expired`, and the bytes go once no live row shares the hash. The log is kept.
   * shortcut: an upload of the same bytes landing between the check and the delete loses its
   * content; acceptable while the sweep runs daily at low concurrency, revisit with I6's scheduler.
   *
   * @returns {Promise<{expired: number, reclaimed: number}>}
   */
  async expire(now = new Date()) {
    const rows = await query.expireFiles(now.toISOString());
    for (const row of rows) {
      await events.emit({ action: "file_expired", target: { table: "files", id: row.id }, before: row });
    }

    let reclaimed = 0;
    for (const hash of new Set(rows.map((row) => row.hash))) {
      if (await query.hashInUse(hash)) continue;
      try {
        if (await deleteContent(hash)) reclaimed += 1;
      } catch (err) {
        console.error(`Could not delete expired content ${hash}:`, err);
      }
    }
    return { expired: rows.length, reclaimed };
  }

  /** @throws {ApiError} 404 when the token is unknown, revoked, expired or its folder deleted. */
  async #link(token) {
    const link = typeof token === "string" && token ? await query.resolveFolderLink(hashToken(token)) : null;
    if (!link) throw ApiError.notFound("This link does not exist or has expired.");
    return link;
  }

  /**
   * Resolves what the caller may do in a folder: 'owner', 'write', 'read' or null.
   *
   * @returns {Promise<{folder: object, access: string|null}>}
   * @throws {ApiError} 404 when the folder does not exist.
   */
  async #access(folderId) {
    const actor = currentActor();
    const [folder, grant] = await Promise.all([
      query.getFolder(folderId),
      query.folderAccess(folderId, actor.id),
    ]);
    if (!folder) throw ApiError.notFound("Folder not found.");
    let access = isAdmin(actor) || grant.owns ? "owner" : grant.level;
    if (!access && (await browses(actor))) access = "read";
    return { folder, access };
  }

  /** @throws {ApiError} 404 when missing or not readable. */
  async #readable(folderId) {
    const result = await this.#access(folderId);
    if (!result.access) throw ApiError.notFound("Folder not found.");
    return result;
  }

  /** @throws {ApiError} 404 when not readable, 403 when read-only. */
  async #writable(folderId) {
    const result = await this.#readable(folderId);
    if (result.access === "read") throw ApiError.forbidden("This folder is read-only for you.");
    return result;
  }

  /** @throws {ApiError} 404 when not readable, 403 when the caller may not manage it. */
  async #managed(folderId) {
    const result = await this.#writable(folderId);
    await this.#requireManage(result.access);
    return result;
  }

  /**
   * Ownership is enough; write access also needs `document.manage` (RF-USR-05).
   *
   * @throws {ApiError} 403
   */
  async #requireManage(access) {
    if (access === "owner") return;
    const codes = await query.getRolePermissionCodes(currentActor().roleId);
    if (!codes.includes("document.manage")) {
      throw ApiError.forbidden("Only the owner, or someone with document.manage, can do that.");
    }
  }

  /** @throws {ApiError} 404 when the file is missing or its folder not readable. */
  async #readableFile(fileId) {
    const file = await query.getFile(fileId);
    if (!file) throw ApiError.notFound("File not found.");
    const access = await this.#access(file.folder_id);
    if (!access.access) throw ApiError.notFound("File not found.");
    return { file, ...access };
  }

  /** @throws {ApiError} 404, or 403 when the folder is read-only for the caller. */
  async #writableFile(fileId) {
    const result = await this.#readableFile(fileId);
    if (result.access === "read") throw ApiError.forbidden("This folder is read-only for you.");
    return result;
  }
}

function isAdmin(actor) {
  return actor?.role === "admin";
}

/** Whether the actor's role holds `document.browse`: read on every folder. */
async function browses(actor) {
  return (await query.getRolePermissionCodes(actor.roleId)).includes("document.browse");
}

function shapeRetention(row) {
  return { months: row.months, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

/** MAX_UPLOAD_BYTES, or no limit when unset. */
function maxUploadBytes() {
  const limit = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

/** @throws {ApiError} 400 */
function requireName(value) {
  const name = requireText(value, "name", NAME_MAX);
  if (BAD_NAME.test(name) || name === "." || name === "..") {
    throw ApiError.badRequest("name cannot contain slashes or control characters, or be . or ..");
  }
  return name;
}

/** @throws {ApiError} 400 */
function requireGrants(grants) {
  if (!Array.isArray(grants)) throw ApiError.badRequest("areas must be an array.");
  const seen = new Set();
  return grants.map((grant) => {
    const areaId = requireId(grant?.areaId, "areaId");
    if (!LEVELS.includes(grant?.level)) {
      throw ApiError.badRequest("level must be 'read' or 'write'.");
    }
    if (seen.has(areaId)) throw ApiError.badRequest(`Area ${areaId} is listed twice.`);
    seen.add(areaId);
    return { areaId, level: grant.level };
  });
}

function translate(err) {
  if (err?.code === FOREIGN_KEY_VIOLATION) return ApiError.badRequest("That area does not exist.");
  if (err?.code === CHECK_VIOLATION) {
    return ApiError.badRequest("A folder cannot be moved inside itself.");
  }
  return err;
}

function translateStorage(err) {
  if (!(err instanceof StorageError)) return err;
  if (err.code === "ETOOLARGE") return new ApiError(413, err.message);
  console.error(err);
  return ApiError.unavailable("File storage is unavailable.");
}

function shapeFolder(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}

function shapeFile(row) {
  return {
    id: row.id,
    folderId: row.folder_id,
    authorId: row.author_id,
    name: row.name,
    size: Number(row.size),
    mime: row.mime,
    hash: row.hash,
    createdAt: row.created_at,
  };
}

/** The stored form of a share token: its SHA-256, hex. */
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** @throws {ApiError} 400 unless `value` is a timestamp in the future. */
function requireFuture(value) {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw ApiError.badRequest("expiresAt must be an ISO timestamp.");
  }
  if (date <= new Date()) throw ApiError.badRequest("expiresAt must be in the future.");
  return date;
}

function shapeLink(row) {
  return {
    id: row.id,
    folderId: row.folder_id,
    authorizer: row.authorizer,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

/** What someone outside the system sees of a folder: no owner. */
function shapeSharedFolder(row) {
  return { id: row.id, name: row.name };
}

/** What someone outside the system sees of a file: no author, no hash. */
function shapeSharedFile(row) {
  return { id: row.id, name: row.name, size: Number(row.size), mime: row.mime, createdAt: row.created_at };
}

function shapeGrant(row) {
  return { areaId: row.area_id, areaName: row.area_name, level: row.level };
}

export default new Documents();
