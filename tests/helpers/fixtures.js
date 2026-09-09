// Test data, built through the same code the API uses wherever that is possible.
//
// Fixtures go through query.js rather than hand-written INSERTs so that a schema change
// breaks the suite in one place instead of thirty. The exceptions are the few statements
// below that read a row back or soft-delete one: those are assertions about state the API
// has no endpoint for, and inventing endpoints to make them testable would be the tail
// wagging the dog.
import bcrypt from 'bcrypt';

import query from '../../src/access/resources/query.js';
import { getStore } from '../../src/access/primitives/database.js';

// Matches SALT_ROUNDS in orchestration/auth.js. A fixture hashed at a different cost would
// still verify, so getting this wrong would not fail -- it would just quietly make the
// suite test a weaker password than the server writes.
const SALT_ROUNDS = 12;

export const PASSWORD = 'correct horse battery staple';

// bcrypt at cost 12 is ~300ms, and that is the whole point of the cost factor. Paying it
// once per process and reusing the digest keeps fixture setup off the critical path; the
// suite still pays it for real on every login, and orchestration/auth.js's own
// setPassword() is exercised end to end by the activate tests.
let cachedHash = null;
async function passwordHash() {
  cachedHash ??= await bcrypt.hash(PASSWORD, SALT_ROUNDS);
  return cachedHash;
}

// Raw access, for the handful of reads and writes with no route behind them. Positional
// parameters in an array, never `:named` in an object -- postgrejs calls .map() on
// options.params and an object throws at runtime, not at parse time.
export async function sql(text, params = []) {
  const result = await getStore().query(text, { params, objectRows: true });
  return result.rows ?? [];
}

// Wipe the rows a test file creates, leaving the catalogs alone.
//
// CASCADE looks alarming and is not: TRUNCATE cascades along INBOUND foreign keys, to the
// tables that reference these two, all of which are empty in a test database. It does not
// touch roles, areas or contract_types, which users references rather than the other way
// round -- those are seeded by the catalog-bootstrap migration and must survive.
//
// RESTART IDENTITY is for determinism: every file starts from id 1 regardless of what ran
// before it.
export async function reset() {
  await sql('truncate users, area_members restart identity cascade');
}

// The prefix every area and role a test creates is named with, and the one every test
// permission code starts with. They exist so the cleanup below can be a predicate rather
// than a guess: `areas`, `roles` and `permissions` are SEEDED by the catalog-bootstrap and
// role-permissions migrations, so truncating them would destroy the rows every other file
// in the suite depends on, and "delete everything above the highest seeded id" breaks the
// moment a fixture is deleted and re-created.
export const TEST_PREFIX = 'zz-test:';
export const TEST_PERMISSION_PREFIX = 'zz.test.';

// Wipe what a case created, keeping the accounts the file logs in with.
//
// The alternative -- reset() plus createActive() in beforeEach -- re-hashes a password at
// bcrypt cost 12 and performs a real login for every account, every case. That is about
// four seconds per test, and across the areas and roles files it was most of the suite's
// runtime. The session token stays valid because nothing about the account changes.
//
// Order matters and is the foreign keys read backwards: area_hierarchy and area_members
// reference areas and users, users reference areas, so the referencing rows go first.
// area_hierarchy and area_members are emptied wholesale because nothing seeds them -- every
// row in either belongs to a test.
//
// role_permissions is NOT: section 8 of catalog-bootstrap seeds every permission onto
// `admin` and finance.read onto `finance`, and wiping those would leave the rest of the run
// testing an authorisation model the migrations never produce. Only grants on test-created
// roles are removed; a test permission's grants go with it through the cascade.
export async function resetCases(keepEmails = []) {
  await sql('delete from area_hierarchy');
  await sql('delete from area_members');
  // Before the users delete, not after: logs.user_id references users with NO ACTION, so
  // once the audit trail started writing (RF-USR-07) every case leaves rows here and the
  // delete below fails on them. reset() gets away without this because TRUNCATE ... CASCADE
  // follows inbound foreign keys and takes logs with it.
  await sql('delete from logs');
  await sql(
    `delete from role_permissions
      where role_id in (select id from roles where name like $1)`,
    [`${TEST_PREFIX}%`],
  );
  await sql('delete from users where email <> all($1::text[])', [
    keepEmails.length ? keepEmails : [''],
  ]);
  await sql('delete from areas where name like $1', [`${TEST_PREFIX}%`]);
  await sql('delete from permissions where code like $1', [`${TEST_PERMISSION_PREFIX}%`]);
  await sql('delete from roles where name like $1', [`${TEST_PREFIX}%`]);
}

// An area created straight through query.js, for the cases that need one to exist without
// exercising POST /api/areas to get it.
export async function createArea(name, description = null) {
  return query.createArea({ name: `${TEST_PREFIX}${name}`, description });
}

// Catalog ids by NAME, never hardcoded. The bootstrap migration ran on a sequence that had
// already advanced on this machine, so `admin` is id 9 here and would be something else on
// a database built from scratch. Anything asserting on a literal id is asserting on an
// accident.
export const roleId = (name) => query.getRoleIdByName(name);
export const areaId = async (name) => (await query.findArea(name))?.id ?? null;
export const contractTypeId = async () => (await query.firstContractType()).id;

// Areas are looked up by their REAL name, which for one created by createArea() includes
// TEST_PREFIX -- pass `area.name`, not the string handed to createArea. Returning null for
// a name that resolves to nothing would create a user with no area and fail somewhere else
// entirely, so this refuses instead. Seeded names ('Diseño Web') are found unprefixed.
async function requireAreaId(name) {
  const id = await areaId(name);
  if (id === null) throw new Error(`Fixture area not found: ${name}`);
  return id;
}

// A user exactly as POST /api/users leaves them: a row with no password, reachable only
// through an invite.
export async function createPending({
  email,
  role = 'worker',
  area = null,
  isAreaLeader = false,
  fullName = 'Prueba Usuario',
}) {
  return query.createUser({
    email,
    fullName,
    roleId: await roleId(role),
    contractTypeId: await contractTypeId(),
    primaryAreaId: area === null ? null : await requireAreaId(area),
    birthday: null,
    isAreaLeader,
  });
}

// A user who has been through activation and can log in with PASSWORD.
export async function createActive(options) {
  const user = await createPending(options);
  await sql('update users set password_hash = $2 where id = $1', [
    user.id,
    await passwordHash(),
  ]);
  return user;
}

// Users are soft-deleted, and almost every rule about them turns on that column: login
// refuses them, invites refuse them, and uq_users_email_live frees their address for
// reuse. DELETE /api/users/:id now does this properly; this stays for the cases that need
// a deleted row as *setup* rather than as the thing under test, so they do not depend on
// an endpoint they are not exercising.
//
// It bumps token_version for the same reason the endpoint does. Without that a test could
// soft-delete a user here and still find their token working, which is true of this helper
// and false of the API -- a difference that would be read as a bug in the wrong place.
export async function softDelete(userId) {
  await sql(
    'update users set deleted_at = now(), token_version = token_version + 1 where id = $1',
    [userId],
  );
}

export async function findUser(userId) {
  const [row] = await sql('select * from users where id = $1', [userId]);
  return row ?? null;
}

// The audit trail a case produced, oldest first. Raw rows joined to the action code, because
// the shape orchestration/audit.js returns is the API's and a test asserting on it would not
// notice a row written with the wrong action id.
export async function logsFor(targetTable, targetId) {
  return sql(
    `select a.code as action, l.user_id, l.area_id, l.target_table, l.target_id,
            l.before_data, l.after_data
       from logs l join actions a on a.id = l.action_id
      where l.target_table = $1 and l.target_id = $2
      order by l.id`,
    [targetTable, targetId],
  );
}

// Every log row, for the cases that assert on the objectless actions -- user_login and
// user_login_failed have no target to look them up by.
export async function allLogs() {
  return sql(
    `select a.code as action, l.user_id, l.area_id, l.target_table, l.target_id,
            l.before_data, l.after_data
       from logs l join actions a on a.id = l.action_id
      order by l.id`,
  );
}

export async function areaMemberships(userId) {
  return sql(
    'select area_id, is_area_leader from area_members where user_id = $1 order by area_id',
    [userId],
  );
}

// Log in over HTTP and hand back the token, so role-guard tests read as what they are
// testing rather than as a paragraph of setup.
export async function tokenFor(server, email) {
  const res = await server.post('/api/auth/login', { body: { email, password: PASSWORD } });
  if (res.status !== 200) {
    throw new Error(`Fixture login failed for ${email}: ${res.status} ${res.text}`);
  }
  return res.body.token;
}
