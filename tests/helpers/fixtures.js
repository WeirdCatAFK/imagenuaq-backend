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

// Catalog ids by NAME, never hardcoded. The bootstrap migration ran on a sequence that had
// already advanced on this machine, so `admin` is id 9 here and would be something else on
// a database built from scratch. Anything asserting on a literal id is asserting on an
// accident.
export const roleId = (name) => query.getRoleIdByName(name);
export const areaId = async (name) => (await query.findArea(name))?.id ?? null;
export const contractTypeId = async () => (await query.firstContractType()).id;

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
    primaryAreaId: area === null ? null : await areaId(area),
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
// reuse. There is no endpoint for it yet, so the tests set it directly.
export async function softDelete(userId) {
  await sql('update users set deleted_at = now() where id = $1', [userId]);
}

export async function findUser(userId) {
  const [row] = await sql('select * from users where id = $1', [userId]);
  return row ?? null;
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
