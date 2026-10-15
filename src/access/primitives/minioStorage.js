// Stores file bytes in one MinIO bucket under `content/ab/cd/<sha256>`; it knows nothing about
// names or folders. Stored bytes are never changed (new bytes, new key), and it never touches
// the database: callers store the bytes first, then insert their `files` row.
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const TMP_PREFIX = 'tmp/';
const CONTENT_PREFIX = 'content/';

/**
 * Matched before anything becomes an object key, so a key outside content/ is structurally
 * impossible rather than filtered against. Same shape as the files_hash_is_hex check.
 */
const HASH_RE = /^[0-9a-f]{64}$/;

const REQUIRED_ENV = [
  'MINIO_ENDPOINT',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'MINIO_DOCUMENTS_BUCKET',
];

export class StorageError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

let client = null;
let bucket = null;

/** Whether an SDK error means "no such object or bucket" rather than a failure. */
function isNotFound(error) {
  return (
    ['NotFound', 'NoSuchKey', 'NoSuchBucket'].includes(error?.name) ||
    error?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Builds the client from the environment and checks the bucket exists. Idempotent.
 *
 * @throws {StorageError} EBADCONFIG when a variable is missing, ENOBUCKET when the bucket
 *   does not exist, EUNREACHABLE when MinIO does not answer.
 */
export async function openStorage() {
  if (client) return client;

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new StorageError(`${missing.join(', ')} not set.`, 'EBADCONFIG');
  }

  const candidate = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.MINIO_ROOT_USER,
      secretAccessKey: process.env.MINIO_ROOT_PASSWORD,
    },
    forcePathStyle: true,
  });
  const name = process.env.MINIO_DOCUMENTS_BUCKET;

  try {
    await candidate.send(new HeadBucketCommand({ Bucket: name }));
  } catch (cause) {
    candidate.destroy();
    throw isNotFound(cause)
      ? new StorageError(
          `Bucket ${name} does not exist at ${process.env.MINIO_ENDPOINT}. ` +
            "The minio-init service in compose.yaml creates it.",
          'ENOBUCKET',
          { cause },
        )
      : new StorageError(
          `MinIO at ${process.env.MINIO_ENDPOINT} is not reachable: ${cause.message}`,
          'EUNREACHABLE',
          { cause },
        );
  }

  client = candidate;
  bucket = name;
  return client;
}

/** Releases the client. Safe to call when nothing is open. */
export function closeStorage() {
  client?.destroy();
  client = null;
  bucket = null;
}

export const isOpen = () => client !== null;

/** @throws {StorageError} ECLOSED before openStorage(). */
function getClient() {
  if (!client) {
    throw new StorageError('Storage is not open. Call openStorage() first.', 'ECLOSED');
  }
  return client;
}

/** Asks MinIO whether the bucket is still there, for the health check. */
export async function ping() {
  await getClient().send(new HeadBucketCommand({ Bucket: bucket }));
}

/**
 * The object key for a hash.
 *
 * @throws {StorageError} EBADHASH when it is not a lowercase sha-256 hex digest.
 */
export function contentKey(hash) {
  if (!HASH_RE.test(hash)) throw new StorageError(`Not a sha-256 hex digest: ${hash}`, 'EBADHASH');
  return `${CONTENT_PREFIX}${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

/** Hashes and counts on the way past, so the bytes are read exactly once. */
function meter(maxBytes) {
  const digest = createHash('sha256');
  let size = 0;
  let failure = null;

  const stream = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (maxBytes != null && size > maxBytes) {
        failure = new StorageError(`Upload exceeds ${maxBytes} bytes.`, 'ETOOLARGE');
        done(failure);
        return;
      }
      digest.update(chunk);
      done(null, chunk);
    },
  });

  return {
    stream,
    failure: () => failure,
    result: () => ({ hash: digest.digest('hex'), size }),
  };
}

/**
 * Wraps anything that is not already a StorageError, so the tier boundary keeps its
 * meaning for the caller.
 */
function asStorageError(error) {
  if (error instanceof StorageError) return error;
  return new StorageError(`Storage operation failed: ${error.message}`, 'EIO', { cause: error });
}

/**
 * Streams bytes into the bucket and returns their hash. Does NOT touch the database — the
 * caller inserts its files row once this resolves.
 *
 * @param {Buffer|string|import('node:stream').Readable} source
 * @param {{maxBytes?: number|null}} [options]
 * @returns {Promise<{hash: string, size: number, existed: boolean}>} `existed: true` means
 *   the content was already stored — the dedup path. The caller still inserts its row.
 * @throws {StorageError} ETOOLARGE past maxBytes; EIO when MinIO fails.
 */
export async function putContent(source, { maxBytes = null } = {}) {
  const s3 = getClient();
  const tmpKey = `${TMP_PREFIX}${randomUUID()}`;
  const readable =
    Buffer.isBuffer(source) || typeof source === 'string'
      ? Readable.from([Buffer.from(source)])
      : source;
  const gauge = meter(maxBytes);
  const body = pipeline(readable, gauge.stream, () => {});

  try {
    await new Upload({ client: s3, params: { Bucket: bucket, Key: tmpKey, Body: body } }).done();

    const { hash, size } = gauge.result();
    const key = contentKey(hash);
    const existed = (await statContent(hash)) !== null;

    if (!existed) {
      await s3.send(
        new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: `${bucket}/${tmpKey}` }),
      );
    }

    return { hash, size, existed };
  } catch (error) {
    throw gauge.failure() ?? asStorageError(error);
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: tmpKey })).catch(() => {});
  }
}

/**
 * Opens the content for reading, streamed rather than buffered.
 *
 * @returns {Promise<{stream: import('node:stream').Readable, size: number}|null>} null when
 *   nothing is stored under the hash.
 */
export async function readContent(hash) {
  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: contentKey(hash) }),
    );
    return { stream: response.Body, size: response.ContentLength };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw asStorageError(error);
  }
}

/** @returns {Promise<{size: number}|null>} null when nothing is stored under the hash. */
export async function statContent(hash) {
  try {
    const response = await getClient().send(
      new HeadObjectCommand({ Bucket: bucket, Key: contentKey(hash) }),
    );
    return { size: response.ContentLength };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw asStorageError(error);
  }
}

/**
 * Removes content. Only ever call it for a hash no live files row references.
 *
 * @returns {Promise<boolean>} Whether anything was removed, so a sweeper can tell
 *   "reclaimed" from "already gone" — S3 deletes report success either way.
 */
export async function deleteContent(hash) {
  if (!(await statContent(hash))) return false;
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: contentKey(hash) }));
    return true;
  } catch (error) {
    throw asStorageError(error);
  }
}
