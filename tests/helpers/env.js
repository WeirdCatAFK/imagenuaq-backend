// Works out which database the suite is allowed to touch, and refuses to hand back
// anything else.
//
// The fixtures TRUNCATE users and area_members at the start of every file. That is fine
// against a scratch database and unforgivable against the one someone has been entering
// real staff into, and the difference between the two is a single environment variable.
// So the name is not taken on trust from the environment: it is derived, then checked,
// and the check throws before anything opens a connection.
//
// Deriving rather than configuring is also why there is no DATABASE_URL in .env.test.
// A second URL there would need the local Postgres password in a committed file, and
// would drift from .env the first time anyone changed a port.

const TEST_DB_NAME = 'imagenuaq_test';

// The whole point of this module. A database whose name does not end in `_test` is
// assumed to be somebody's real data, whatever the environment claims.
const TEST_DB_SUFFIX = '_test';

// Derive the test database URL from the development one, or take TEST_DATABASE_URL as
// given when the suite has to run somewhere else entirely (CI with its own server, a
// second container). Either way the suffix check below applies.
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

  // Only the derived case renames. An explicit TEST_DATABASE_URL is used as written --
  // whoever set it meant it -- but still has to clear the suffix check.
  if (!override) url.pathname = `/${TEST_DB_NAME}`;

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

// Point the process at the test database before anything imports a module that reads
// DATABASE_URL. primitives/database.js reads it inside openStore(), not at import time,
// so calling this first in a test file's before() hook is early enough.
export function useTestDatabase() {
  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;
  return url;
}
