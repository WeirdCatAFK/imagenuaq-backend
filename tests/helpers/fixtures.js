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
import { seal } from '../../src/utils/crypto.js';

/** Matches SALT_ROUNDS in orchestration/auth.js; a mismatch would still verify, silently. */
const SALT_ROUNDS = 12;

export const PASSWORD = 'correct horse battery staple';

/** Hashed once per process: bcrypt at cost 12 is ~300ms. */
let cachedHash = null;
async function passwordHash() {
  cachedHash ??= await bcrypt.hash(PASSWORD, SALT_ROUNDS);
  return cachedHash;
}

/** Raw SQL for state no route exposes. Parameters are positional (`$1`), in an array. */
export async function sql(text, params = []) {
  const result = await getStore().query(text, { params, objectRows: true });
  return result.rows ?? [];
}

/** Deletes every row a test file creates and restarts the user ids, leaving the seeded catalogs. */
export async function reset() {
  await resetCases([]);
  await sql('alter table users alter column id restart with 1');
  await sql('alter table area_members alter column id restart with 1');
}

/**
 * Prefixes on everything a test creates in a seeded table (areas, roles, permissions, schemas,
 * statuses), so resetCases() can delete by predicate and leave the seed alone.
 */
export const TEST_PREFIX = 'zz-test:';
export const TEST_PERMISSION_PREFIX = 'zz.test.';
export const TEST_SCHEMA_PREFIX = 'zztest_';
export const TEST_STATUS_PREFIX = 'zztest_';

/**
 * Tables nothing seeds, emptied whole. Referencing tables come before the ones they
 * reference; a new table a test writes to belongs here in that order.
 */
const UNSEEDED_TABLES = [
  'area_members',
  'logs',
  'approvals',
  'project_field_values',
  'project_stages',
  'flow_stages',
  'flow_phases',
  'requests',
  'projects',
  'workflow_versions',
  'workflows',
  'sheet_imports',
  'sheet_row_marks',
  'sheets',
  'microsoft_accounts',
  'microsoft_app',
];

/**
 * Deletes what a case created, keeping the accounts in `keepEmails` so their tokens stay
 * valid. Seeded hierarchy links under Coordinación and seeded grants are kept.
 */
export async function resetCases(keepEmails = []) {
  await sql(
    `delete from area_hierarchy h
      using areas c, areas p
      where c.id = h.child_area_id and p.id = h.parent_area_id
        and (c.name like $1 or p.name like $1 or p.name <> 'Coordinación')`,
    [`${TEST_PREFIX}%`],
  );
  for (const table of UNSEEDED_TABLES) await sql(`delete from ${table}`);
  await sql('delete from statuses where area_id is not null or code like $1', [
    `${TEST_STATUS_PREFIX}%`,
  ]);
  await sql(
    `delete from schema_versions
      where schema_id in (select id from schemas where code like $1)`,
    [`${TEST_SCHEMA_PREFIX}%`],
  );
  await sql('delete from schemas where code like $1', [`${TEST_SCHEMA_PREFIX}%`]);
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

/** An area created through query.js, named with TEST_PREFIX. */
export async function createArea(name, description = null) {
  return query.createArea({ name: `${TEST_PREFIX}${name}`, description });
}

/**
 * Catalog ids by NAME, never hardcoded. The bootstrap migration ran on a sequence that had
 * already advanced on this machine, so `admin` is id 9 here and would be something else on
 * a database built from scratch. Anything asserting on a literal id is asserting on an
 * accident.
 */
export const roleId = (name) => query.getRoleIdByName(name);
export const areaId = async (name) => (await query.findArea(name))?.id ?? null;
export const contractTypeId = async () => (await query.firstContractType()).id;

/** Resolves an area by its full name (a createArea() area includes TEST_PREFIX), or throws. */
async function requireAreaId(name) {
  const id = await areaId(name);
  if (id === null) throw new Error(`Fixture area not found: ${name}`);
  return id;
}

/**
 * A user exactly as POST /api/users leaves them: a row with no password, reachable only
 * through an invite.
 */
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

/** A user who has been through activation and can log in with PASSWORD. */
export async function createActive(options) {
  const user = await createPending(options);
  await sql('update users set password_hash = $2 where id = $1', [
    user.id,
    await passwordHash(),
  ]);
  return user;
}

/** Soft-deletes a user as DELETE /api/users/:id does, for cases that need one as setup. */
export async function softDelete(userId) {
  await sql(
    'update users set deleted_at = now(), token_version = token_version + 1 where id = $1',
    [userId],
  );
}

/** A connected Microsoft account holding a fake sealed refresh token. */
export async function createMicrosoftAccount(userId, { email = 'cuenta@outlook.com' } = {}) {
  return query.createMicrosoftAccount({
    userId,
    msObjectId: `oid-${userId}-${email}`,
    tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
    email,
    displayName: 'Cuenta de Prueba',
    refreshTokenEnc: seal('not-a-real-refresh-token'),
    scopes: 'Files.Read.All User.Read',
  });
}

/** A published format, prefixed for resetCases(). `fields` defaults to the smallest valid list. */
export async function createSchema(code, fields = null, name = null) {
  return query.createSchema({
    code: `${TEST_SCHEMA_PREFIX}${code}`,
    name: name ?? `Formato ${code}`,
    fields: fields ?? {
      deliverables: [
        { code: 'entregable', name: 'Entregable', type: 'text', note: '', required: true },
      ],
      information: [
        { code: 'dependencia', name: 'Dependencia', type: 'text', note: '', required: true },
      ],
    },
    publishedBy: null,
  });
}

/** A registered workbook for an account from createMicrosoftAccount(). */
export async function createSheet({
  microsoftAccountId,
  name = 'Seguimiento de prueba',
  tableName = 'Sheet1',
  registeredBy = null,
}) {
  return query.createSheet({
    name,
    driveId: `b!drive-${microsoftAccountId}`,
    itemId: `01ITEM-${name}`,
    tableName,
    webUrl: null,
    microsoftAccountId,
    registeredBy,
  });
}

export async function findUser(userId) {
  const [row] = await sql('select * from users where id = $1', [userId]);
  return row ?? null;
}

const LOG_SELECT = `select a.code as action, l.user_id, l.area_id, l.target_table, l.target_id,
                           l.before_data, l.after_data
                      from logs l join actions a on a.id = l.action_id`;

/** The raw audit rows for one record, oldest first. */
export async function logsFor(targetTable, targetId) {
  return sql(`${LOG_SELECT} where l.target_table = $1 and l.target_id = $2 order by l.id`, [
    targetTable,
    targetId,
  ]);
}

/** Every raw audit row, oldest first, for actions with no target such as user_login. */
export async function allLogs() {
  return sql(`${LOG_SELECT} order by l.id`);
}

/** Replaces a role's permissions over HTTP, as an admin. */
export async function grantPermissions(server, adminToken, role, permissions) {
  const res = await server.put(`/api/roles/${await roleId(role)}/permissions`, {
    token: adminToken,
    body: { permissions },
  });
  if (res.status !== 200) {
    throw new Error(`Fixture grant failed for ${role}: ${res.status} ${res.text}`);
  }
}

export async function areaMemberships(userId) {
  return sql(
    'select area_id, is_area_leader from area_members where user_id = $1 order by area_id',
    [userId],
  );
}

/** Logs in over HTTP with PASSWORD and returns the session token. */
export async function tokenFor(server, email) {
  const res = await server.post('/api/auth/login', { body: { email, password: PASSWORD } });
  if (res.status !== 200) {
    throw new Error(`Fixture login failed for ${email}: ${res.status} ${res.text}`);
  }
  return res.body.token;
}
