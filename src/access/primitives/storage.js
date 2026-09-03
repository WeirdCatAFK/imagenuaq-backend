// Tier 1. The disks, as a content-addressed key-value store.
//
// The tree lives in Postgres; this file knows nothing about folders, names or owners. It
// maps a SHA-256 to bytes on one of several mounted volumes and back. Errors from here
// mean "the disk failed", the way database.js's mean "the connection failed".
//
// "Content", not "file", throughout: a `files` row is one appearance of content in the
// tree, and several of them share one physical file whenever their hashes match. What
// this module stores is the thing they share.
//
// Layout under each mount:
//
//   <mount>/.imagenuaq-volume     {"label":"main"} - verified by openVolumes()
//   <mount>/tmp/                  in-flight writes; same filesystem, so rename(2) is atomic
//   <mount>/content/ab/cd/<hash>  64 hex chars. No extension. No filename.
//
// Two levels of fanout because a flat directory reaches millions of entries, and readdir,
// rsync and backup tools all degrade there even where ext4's dir_index copes. No filename
// on disk because one piece of content has many names - that is what deduplication means
// - so writing one of them here would pick an arbitrary winner and create a second,
// disagreeing source of truth. The name belongs to the files row.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MARKER_FILE = '.imagenuaq-volume';
const TMP_DIR = 'tmp';
const CONTENT_DIR = 'content';

// Anything that reaches a path join is matched against this first, so traversal is
// structurally impossible rather than filtered against. Same shape as the
// files_hash_is_hex and file_locations_hash_is_hex checks in the schema.
const HASH_RE = /^[0-9a-f]{64}$/;

export class StorageError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

let volumes = null;

// --- Registry ---

// `label:path` pairs separated by commas, where the label is storage_volumes.label. Split
// on the FIRST colon only: a Windows mount path is `C:\storage`, and splitting on every
// colon would eat the drive letter.
function parseSpec(spec) {
  const parsed = [];

  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;

    const sep = entry.indexOf(':');
    if (sep < 1 || sep === entry.length - 1) {
      throw new StorageError(
        `STORAGE_VOLUMES entry ${JSON.stringify(entry)} is not label:path`,
        'EBADSPEC',
      );
    }

    const label = entry.slice(0, sep).trim();
    const mountPath = path.resolve(entry.slice(sep + 1).trim());

    if (parsed.some((v) => v.label === label)) {
      throw new StorageError(`STORAGE_VOLUMES declares ${label} twice.`, 'EBADSPEC');
    }

    parsed.push({ label, mountPath });
  }

  if (parsed.length === 0) throw new StorageError('STORAGE_VOLUMES is empty.', 'EBADSPEC');
  return parsed;
}

// The marker is the whole reason this is checked at boot. A disk that fails to mount
// leaves an empty directory on the root filesystem, and without this the service writes
// into it happily while recording that content as living on a disk that is not there.
//
// It is also why storage_volumes.is_mounted would be a mistake: mount state is runtime
// truth, established here, and a stored copy of it is stale the moment it is written.
async function verifyMarker(volume) {
  const markerPath = path.join(volume.mountPath, MARKER_FILE);
  let marker;

  try {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  } catch (cause) {
    throw new StorageError(
      `Volume ${volume.label}: no readable ${MARKER_FILE} at ${volume.mountPath}. ` +
        'The disk is not mounted, or it was never initialised - see initVolume().',
      'ENOVOLUME',
      { cause },
    );
  }

  if (marker.label !== volume.label) {
    throw new StorageError(
      `Volume ${volume.label}: ${volume.mountPath} is labelled ${JSON.stringify(marker.label)}. ` +
        'Two mounts are swapped, or STORAGE_VOLUMES points at the wrong disk.',
      'EVOLUMEMISMATCH',
    );
  }
}

// Writes the marker and the directories. Deliberately separate from openVolumes(), and
// deliberately not automatic: creating the marker on demand is exactly what would defeat
// the check above. Call it once, by hand, when a disk is genuinely new - then insert the
// matching storage_volumes row with the same label.
export async function initVolume(mountPath, label) {
  const root = path.resolve(mountPath);
  await fs.mkdir(path.join(root, TMP_DIR), { recursive: true });
  await fs.mkdir(path.join(root, CONTENT_DIR), { recursive: true });
  await fs.writeFile(path.join(root, MARKER_FILE), `${JSON.stringify({ label }, null, 2)}\n`);
  return { label, mountPath: root };
}

export async function openVolumes() {
  if (volumes) return volumes;

  if (!process.env.STORAGE_VOLUMES) {
    throw new StorageError('STORAGE_VOLUMES is not set.', 'EBADSPEC');
  }

  const parsed = parseSpec(process.env.STORAGE_VOLUMES);

  for (const volume of parsed) {
    await verifyMarker(volume);
    // Recreated rather than assumed: tmp/ is where an interrupted write leaves its
    // partial file, and someone will eventually clear it out by hand.
    await fs.mkdir(path.join(volume.mountPath, TMP_DIR), { recursive: true });
  }

  volumes = parsed;
  return volumes;
}

export function getVolumes() {
  if (!volumes) {
    throw new StorageError('Volumes are not open. Call openVolumes() first.', 'ECLOSED');
  }
  return volumes;
}

export function closeVolumes() {
  volumes = null;
}

export const isOpen = () => volumes !== null;

function findVolume(label) {
  const volume = getVolumes().find((v) => v.label === label);
  if (!volume) throw new StorageError(`No volume labelled ${label} is configured.`, 'ENOVOLUME');
  return volume;
}

export async function listVolumes() {
  return Promise.all(
    getVolumes().map(async (volume) => {
      const stat = await fs.statfs(volume.mountPath);
      return {
        label: volume.label,
        mountPath: volume.mountPath,
        // bavail, not bfree: bfree counts the blocks reserved for root, which this
        // process cannot actually use.
        freeBytes: stat.bavail * stat.bsize,
        totalBytes: stat.blocks * stat.bsize,
      };
    }),
  );
}

// Most free space wins. Not `hash % n`: deriving placement from the hash means adding a
// disk reshuffles everything already stored, and consistent hashing only shrinks that, it
// does not remove it. file_locations records where content went, so adding a disk moves
// nothing.
//
// `allow` is the list of labels the caller is willing to write to - in practice the
// labels of the storage_volumes rows with is_writable = true. It is passed in rather than
// read here because this tier does not touch the database; leaving it out means every
// mounted volume is a candidate.
export async function pickVolume({ allow = null } = {}) {
  const candidates = (await listVolumes()).filter((v) => !allow || allow.includes(v.label));

  if (candidates.length === 0) {
    throw new StorageError(
      allow
        ? `None of the writable volumes (${allow.join(', ')}) are mounted.`
        : 'No volume is configured.',
      'EREADONLY',
    );
  }

  return candidates.reduce((best, v) => (v.freeBytes > best.freeBytes ? v : best));
}

// --- Content ---

export function contentPath(label, hash) {
  if (!HASH_RE.test(hash)) throw new StorageError(`Not a sha-256 hex digest: ${hash}`, 'EBADHASH');
  return path.join(
    findVolume(label).mountPath,
    CONTENT_DIR,
    hash.slice(0, 2),
    hash.slice(2, 4),
    hash,
  );
}

// Hashes and counts on the way past, so the bytes are read exactly once.
function meter(maxBytes) {
  const digest = createHash('sha256');
  let size = 0;

  const stream = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (maxBytes != null && size > maxBytes) {
        done(new StorageError(`Upload exceeds ${maxBytes} bytes.`, 'ETOOLARGE'));
        return;
      }
      digest.update(chunk);
      done(null, chunk);
    },
  });

  return { stream, result: () => ({ hash: digest.digest('hex'), size }) };
}

// Writes bytes and returns where they landed, ready to become a files row and a
// file_locations row. It does NOT touch the database: the caller commits only once this
// resolves.
//
// Bytes first, rows second. A crash in between leaves orphaned content for the sweeper to
// reclaim; the reverse order leaves a files row pointing at bytes that do not exist,
// which is a permanent 500. That ordering is why placement is returned instead of
// recorded here.
//
// `existed: true` means the content was already on that volume - the dedup path, and the
// common one. The caller still inserts its own files row; what it can skip is the
// file_locations row, which is already there.
export async function putContent(source, { maxBytes = null, volumeLabel = null, allow = null } = {}) {
  const volume = volumeLabel ? findVolume(volumeLabel) : await pickVolume({ allow });
  const tmpPath = path.join(volume.mountPath, TMP_DIR, randomUUID());
  const readable =
    Buffer.isBuffer(source) || typeof source === 'string' ? Readable.from(source) : source;
  const gauge = meter(maxBytes);

  try {
    // flush: true fsyncs before the stream closes (Node >= 20.10), so a rename can never
    // publish a file whose contents are still only in the page cache.
    await pipeline(readable, gauge.stream, createWriteStream(tmpPath, { flush: true }));

    const { hash, size } = gauge.result();
    const target = contentPath(volume.label, hash);

    try {
      await fs.access(target);
      await fs.rm(tmpPath, { force: true });
      return { hash, size, volumeLabel: volume.label, existed: true };
    } catch {
      // Not here yet; fall through and publish it.
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic: same filesystem by construction, since tmp/ lives under the same mount.
    // Overwriting is harmless anyway - an identical hash means identical bytes.
    await fs.rename(tmpPath, target);

    return { hash, size, volumeLabel: volume.label, existed: false };
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function readContent(label, hash) {
  return createReadStream(contentPath(label, hash));
}

export async function statContent(label, hash) {
  try {
    const stat = await fs.stat(contentPath(label, hash));
    return { size: stat.size };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Returns whether it removed anything, so a sweeper can tell "reclaimed" from "already
// gone" instead of guessing. Only ever call it for a hash no live files row references.
export async function deleteContent(label, hash) {
  try {
    await fs.unlink(contentPath(label, hash));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// There is no updateContent, and there never will be: different bytes are a different
// hash and therefore different content. Renames and moves happen on the files row.
