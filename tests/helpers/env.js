// Picks the database and bucket the tests may use, and refuses anything else: the name must end
// in `_test`, because the tests delete data. Derived from DATABASE_URL, so .env.test holds no URL.

const TEST_DB_NAME = 'imagenuaq_test';

/**
 * The whole point of this module. A database whose name does not end in `_test` is
 * assumed to be somebody's real data, whatever the environment claims.
 */
const TEST_DB_SUFFIX = '_test';

/**
 * Derive the test database URL from the development one, or take TEST_DATABASE_URL as
 * given when the suite has to run somewhere else entirely (CI with its own server, a
 * second container). Either way the suffix check below applies. `localhost` becomes
 * 127.0.0.1: postgrejs over IPv6 loopback pays ~260 ms per query.
 */
export function testDatabaseUrl() {
  const override = process.env.TEST_DATABASE_URL;
  const source = override ?? process.env.DATABASE_URL;

  if (!source) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set. The test database is derived ' +
        'from DATABASE_URL in .env -- copy .env.example to .env and fill it in.',
    );
  }

  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error(
      `${override ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is not a valid URL: ${source}`,
    );
  }

  if (!override) url.pathname = `/${TEST_DB_NAME}`;
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';

  const name = decodeURIComponent(url.pathname.slice(1));

  if (!name.endsWith(TEST_DB_SUFFIX)) {
    throw new Error(
      `Refusing to run: the test database would be "${name}", which does not end in ` +
        `"${TEST_DB_SUFFIX}". The suite truncates tables, so it will only ever point at a ` +
        'database named as disposable.',
    );
  }

  return url.href;
}

/**
 * Point the process at the test database before anything imports a module that reads
 * DATABASE_URL. primitives/database.js reads it inside openStore(), not at import time,
 * so calling this first in a test file's before() hook is early enough.
 */
export function useTestDatabase() {
  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;
  return url;
}

/**
 * The bucket the suite stores content in. Fixed rather than configured, and suffixed like
 * the database, so a case can never write into the bucket real uploads live in.
 */
export const TEST_BUCKET = 'imagenuaq-test';

/**
 * Point the process at the test bucket before storage is opened. `localhost` becomes
 * 127.0.0.1 for the same IPv6-loopback reason as the database.
 */
export function useTestBucket() {
  if (!TEST_BUCKET.endsWith('-test')) throw new Error(`Refusing to use bucket ${TEST_BUCKET}.`);
  process.env.MINIO_DOCUMENTS_BUCKET = TEST_BUCKET;
  if (process.env.MINIO_ENDPOINT) {
    const url = new URL(process.env.MINIO_ENDPOINT);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    process.env.MINIO_ENDPOINT = url.origin;
  }
  return TEST_BUCKET;
}
