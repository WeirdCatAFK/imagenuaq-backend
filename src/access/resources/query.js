// Tier 2: the ONLY module in the codebase that writes SQL.
//
// Everything above it -- orchestration, routes -- composes these methods; nothing below it
// knows what a table is. Two things bite anybody adding a method here:
//
//   - **Parameters are positional.** `$1, $2` in an array, never `:named` in an object:
//     postgrejs calls .map() on options.params, so an object throws
//     "params?.map is not a function" at runtime rather than at parse time.
//   - **Casts are load-bearing.** Postgres infers a parameter's type from its first use,
//     and a bare null or an `is not null` test gives it nothing, so it fails the statement
//     with "could not determine data type of parameter $n" rather than the row.
//
// Multi-step writes are data-modifying CTEs, not transactions. A CTE is atomic on its own
// and keeps the tier boundary intact -- opening a transaction would mean handing a
// connection up to orchestration, which is what this module exists to prevent.
import { getStore } from "../primitives/database.js";

/**
 * A project stage as everything above this tier reads it: the execution row joined to its
 * definition, with the definition's columns under the names project_stages carried before the
 * flow-templates migration split them. `seq` is the phase; `position` is the order within it.
 */
const STAGE_COLUMNS = `
  ps.*, fp.project_id, fs.area_id, fs.title, fp.seq, fs.seq as position,
  fs.input_keys as inputs, fs.output_keys as outputs, fs.input_note, fs.output_note,
  fs.estimated_days, fp.id as phase_id, fp.name as phase_name, a.name as area_name`;
const STAGE_FROM = `
  project_stages ps
  join flow_stages fs on fs.id = ps.flow_stage_id
  join flow_phases fp on fp.id = fs.phase_id
  join areas a on a.id = fs.area_id`;

class Query {
  async #rows(sql, params) {
    const result = await getStore().query(sql, { params, objectRows: true });
    return result.rows ?? [];
  }

  /**
   * Normalises an array parameter. postgrejs serialises an empty array as '' and
   * Postgres rejects that with 22P02, so an empty set becomes null and the SQL
   * coalesces it back to '{}'.
   *
   * @param {Array} ids
   */
  #idArray(ids) {
    return ids.length ? ids : null;
  }

  async ping() {
    const [row] = await this.#rows("select 1 as ok");
    return row?.ok === 1;
  }

  /**
   * One live user with the role name joined in: everything a session token needs, in a
   * single round trip.
   *
   * @param {string} email
   * @returns {Promise<object | null>}
   */
  async getAuthUserByEmail(email) {
    const [row] = await this.#rows(
      `select u.id,
              u.email,
              u.full_name,
              u.password_hash,
              u.role_id,
              u.primary_area_id,
              u.token_version,
              r.name as role_name
         from users u
         join roles r on r.id = u.role_id
        where u.email = $1
          and u.deleted_at is null`,
      [email],
    );
    return row ?? null;
  }

  /**
   * Sets a live user's password hash.
   *
   * @returns {Promise<number | null>} The user id, or null when no live row matched.
   */
  async setPasswordHash(userId, passwordHash) {
    const [row] = await this.#rows(
      `update users
          set password_hash = $2
        where id = $1
          and deleted_at is null
        returning id`,
      [userId, passwordHash],
    );
    return row?.id ?? null;
  }

  /**
   * Same columns as getAuthUserByEmail, keyed by id. The invite flow uses it to re-read
   * `password_hash` and `deleted_at` live.
   *
   * @returns {Promise<object | null>}
   */
  async getAuthUserById(userId) {
    const [row] = await this.#rows(
      `select u.id,
              u.email,
              u.full_name,
              u.password_hash,
              u.role_id,
              u.primary_area_id,
              u.token_version,
              r.name as role_name
         from users u
         join roles r on r.id = u.role_id
        where u.id = $1
          and u.deleted_at is null`,
      [userId],
    );
    return row ?? null;
  }

  /**
   * The permission codes granted to a role.
   *
   * @returns {Promise<string[]>}
   */
  async getRolePermissionCodes(roleId) {
    const rows = await this.#rows(
      `select p.code
         from role_permissions rp
         join permissions p on p.id = rp.permission_id
        where rp.role_id = $1
        order by p.code`,
      [roleId],
    );
    return rows.map((row) => row.code);
  }

  /**
   * Creates a user and, when an area is given, their `area_members` row, in one
   * data-modifying CTE. Writes no password hash: the account is reached through the
   * invite flow.
   *
   * @returns {Promise<object>} The new user row.
   */
  async createUser({
    email,
    fullName,
    roleId,
    contractTypeId,
    primaryAreaId = null,
    birthday = null,
    isAreaLeader = false,
  }) {
    const [row] = await this.#rows(
      `with created as (
         insert into users (email, full_name, role_id, contract_type_id,
                            primary_area_id, birthday)
         values ($1, $2, $3, $4, $5::bigint, $6::date)
         returning id, email, full_name, password_hash, role_id, primary_area_id
       ),
       membership as (
         insert into area_members (user_id, area_id, is_area_leader)
         select created.id, $5::bigint, $7::boolean
           from created
          where $5::bigint is not null
       )
       select c.id,
              c.email,
              c.full_name,
              c.password_hash,
              c.role_id,
              c.primary_area_id,
              r.name as role_name
         from created c
         join roles r on r.id = c.role_id`,
      [
        email,
        fullName,
        roleId,
        contractTypeId,
        primaryAreaId,
        birthday,
        isAreaLeader,
      ],
    );
    return row;
  }
  /**
   * One live user, every column.
   *
   * @returns {Promise<object | null>}
   */
  async getUser(userId) {
    const [row] = await this.#rows(
      `select * from users where id = $1 and deleted_at is null`,
      [userId],
    );
    return row ?? null;
  }

  /**
   * A page of users with their role name, newest filters applied. One statement serves
   * every combination: a null filter parameter disables its own predicate.
   *
   * @param {object} [options]
   * @param {number|null} [options.areaId] Restrict to members of this area.
   * @param {number|null} [options.roleId]
   * @param {boolean} [options.includeDeleted] Soft-deleted rows are excluded by default.
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {Promise<object[]>}
   */
  async listUsers({
    areaId = null,
    roleId = null,
    includeDeleted = false,
    limit = 50,
    offset = 0,
  } = {}) {
    return this.#rows(
      `select u.*, r.name as role_name
         from users u
         join roles r on r.id = u.role_id
        where ($1::boolean or u.deleted_at is null)
          and ($2::bigint is null or u.role_id = $2::bigint)
          and ($3::bigint is null or exists (
                select 1 from area_members m
                 where m.user_id = u.id and m.area_id = $3::bigint))
        order by u.full_name, u.id
        limit $4 offset $5`,
      [includeDeleted, roleId, areaId, limit, offset],
    );
  }

  /**
   * How many rows listUsers() would return without its page window.
   *
   * @returns {Promise<number>}
   */
  async countUsers({
    areaId = null,
    roleId = null,
    includeDeleted = false,
  } = {}) {
    const [row] = await this.#rows(
      `select count(*)::int as total
         from users u
        where ($1::boolean or u.deleted_at is null)
          and ($2::bigint is null or u.role_id = $2::bigint)
          and ($3::bigint is null or exists (
                select 1 from area_members m
                 where m.user_id = u.id and m.area_id = $3::bigint))`,
      [includeDeleted, roleId, areaId],
    );
    return row?.total ?? 0;
  }

  /**
   * Updates every column in one statement. The caller passes merged values — a partial
   * update would mean building SQL by concatenation.
   *
   * @returns {Promise<object | null>}
   */
  async updateUser(
    userId,
    { fullName, contractTypeId, primaryAreaId, birthday, email, scheduleId },
  ) {
    const [row] = await this.#rows(
      `update users
          set full_name        = $2,
              contract_type_id = $3,
              primary_area_id  = $4::bigint,
              birthday         = $5::date,
              email            = $6,
              schedule_id      = $7::bigint
        where id = $1 and deleted_at is null
        returning *`,
      [
        userId,
        fullName,
        contractTypeId,
        primaryAreaId,
        birthday,
        email,
        scheduleId,
      ],
    );
    return row ?? null;
  }
  /**
   * Soft-deletes an account and revokes its outstanding sessions in the same statement.
   *
   * @returns {Promise<object | null>} The deleted row, or null if it was already gone.
   */
  async deleteUser(userId) {
    const [row] = await this.#rows(
      `update users
          set deleted_at = now(),
              token_version = token_version + 1
        where id = $1 and deleted_at is null
        returning *`,
      [userId],
    );
    return row ?? null;
  }

  /**
   * Stores a profile picture and its type, or clears both when `data` is null.
   *
   * @param {number} userId
   * @param {{ data: Buffer | null, mime: string | null }} picture
   * @returns {Promise<object | null>} The updated row, or null if no live user matched.
   */
  async updateProfilePicture(userId, { data, mime }) {
    const [row] = await this.#rows(
      `update users
          set profile_picture = $2,
              profile_picture_mime = $3
        where id = $1 and deleted_at is null
        returning id`,
      [userId, data, mime],
    );
    return row ?? null;
  }
  /**
   * The stored picture and its type, or null when there is none.
   *
   * @returns {Promise<{ data: Buffer, mime: string } | null>}
   */
  async getUserProfilePicture(userId) {
    const [row] = await this.#rows(
      `select profile_picture, profile_picture_mime
         from users where id = $1 and deleted_at is null`,
      [userId],
    );
    if (!row?.profile_picture) return null;
    return { data: row.profile_picture, mime: row.profile_picture_mime };
  }

  /**
   * Searches live users on either name or address, case-insensitively.
   *
   * @param {string} query Matched as a substring.
   * @param {number} [length] Maximum rows.
   * @returns {Promise<object[]>} id, email and full_name only.
   */
  async searchUsersByEmailOrFullName(query, length = 50) {
    const rows = await this.#rows(
      `select id, email, full_name from users
        where (lower(email) like lower($1) or lower(full_name) like lower($1))
          and deleted_at is null
        order by full_name
        limit $2`,
      [`%${query}%`, length],
    );
    return rows;
  }

  /**
   * Looks a contract type up by id or by name, for scripts/createAdmin.js — an operator
   * recovering a lockout knows the name, not the sequence id.
   *
   * @param {string | number} ref
   */
  async findContractType(ref) {
    return this.#findCatalog(
      `select id, name from contract_types
        where ($1::bigint is not null and id = $1::bigint)
           or ($1::bigint is null and lower(name) = lower($2))
        order by id
        limit 1`,
      ref,
    );
  }

  async findArea(ref) {
    return this.#findCatalog(
      `select id, name from areas
        where ($1::bigint is not null and id = $1::bigint)
           or ($1::bigint is null and lower(name) = lower($2))
        order by id
        limit 1`,
      ref,
    );
  }

  async #findCatalog(sql, ref) {
    const n = Number(ref);
    const id = Number.isInteger(n) && n > 0 ? n : null;
    const [row] = await this.#rows(sql, [id, String(ref)]);
    return row ?? null;
  }

  /** The whole catalogue, for a form that has to name one. Ordered for a <select>. */
  async getContractTypes() {
    return this.#rows("select id, name from contract_types order by name");
  }

  /** The fallback contract type when none was named; `contract_type_id` is NOT NULL. */
  async firstContractType() {
    const [row] = await this.#rows(
      "select id, name from contract_types order by id limit 1",
    );
    return row ?? null;
  }

  async getRoleIdByName(name) {
    const [row] = await this.#rows("select id from roles where name = $1", [
      name,
    ]);
    return row?.id ?? null;
  }

  /** Counts live users holding a role, by role name. Used by scripts/createAdmin.js. */
  async countLiveUsersWithRole(roleName) {
    const [row] = await this.#rows(
      `select count(*)::int as count
         from users u
         join roles r on r.id = u.role_id
        where r.name = $1
          and u.deleted_at is null`,
      [roleName],
    );
    return row?.count ?? 0;
  }

  /**
   * Changes a user's role and password in one statement, for the lockout recovery in
   * scripts/createAdmin.js. Deliberately not exposed over HTTP.
   */
  async promoteToRoleAndSetPassword(userId, roleId, passwordHash) {
    const [row] = await this.#rows(
      `update users
          set role_id = $2,
              password_hash = $3
        where id = $1
          and deleted_at is null
        returning id`,
      [userId, roleId, passwordHash],
    );
    return row?.id ?? null;
  }

  /**
   * The whole action catalogue. Callers cache it; codes are stable, ids are per database.
   *
   * @returns {Promise<object[]>}
   */
  async getActions() {
    const rows = await this.#rows(
      "select id, code, label from actions order by code",
    );
    return rows;
  }

  /**
   * Writes one row of the audit trail. `area_id` is resolved by a subquery inside the
   * INSERT from the actor's current `primary_area_id`, never passed in. `targetTable`
   * and `targetId` travel together or not at all (`logs_target_complete`).
   */
  async insertLog({
    userId,
    actionId,
    targetTable = null,
    targetId = null,
    beforeData = null,
    afterData = null,
  }) {
    const [row] = await this.#rows(
      `insert into logs (user_id, action_id, area_id, target_table, target_id,
                         before_data, after_data)
        values ($1::bigint,
                $2,
                (select primary_area_id from users where id = $1::bigint),
                $3::varchar, $4::bigint, $5::jsonb, $6::jsonb)
        returning id, user_id, action_id, area_id, target_table, target_id, created_at`,
      [
        userId,
        actionId,
        targetTable,
        targetId,
        beforeData === null ? null : JSON.stringify(beforeData),
        afterData === null ? null : JSON.stringify(afterData),
      ],
    );
    return row;
  }

  /** The trail for one object, newest first. Rides the partial index `idx_logs_target`. */
  async getLogsForTarget(targetTable, targetId, limit = 100) {
    const rows = await this.#rows(
      `select l.id, l.user_id, u.full_name as user_full_name, a.code as action_code,
              l.area_id, ar.name as area_name,
              l.target_table, l.target_id, l.before_data, l.after_data, l.created_at
         from logs l
         join actions a on a.id = l.action_id
         left join users u on u.id = l.user_id
         left join areas ar on ar.id = l.area_id
        where l.target_table = $1
          and l.target_id = $2
        order by l.created_at desc, l.id desc
        limit $3`,
      [targetTable, targetId, limit],
    );
    return rows;
  }

  /**
   * The trail for a set of areas, newest first (RF-USR-04). Rides `idx_logs_area_id`.
   *
   * @param {number[]} areaIds
   */
  async getLogsForAreas(areaIds, limit = 100) {
    const rows = await this.#rows(
      `select l.id, l.user_id, u.full_name as user_full_name, a.code as action_code,
              l.area_id, ar.name as area_name,
              l.target_table, l.target_id, l.before_data, l.after_data, l.created_at
         from logs l
         join actions a on a.id = l.action_id
         left join users u on u.id = l.user_id
         left join areas ar on ar.id = l.area_id
        where l.area_id = any(coalesce($1::bigint[], '{}'::bigint[]))
        order by l.created_at desc, l.id desc
        limit $2`,
      [this.#idArray(areaIds), limit],
    );
    return rows;
  }

  /**
   * Creates an area and, when given, its first leader and its parent, in one
   * data-modifying CTE -- the same shape as createUser(). Neither side write can be left
   * behind by a failure of the other.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string|null} input.description
   * @param {number|null} [input.userId] First leader; null writes no membership.
   * @param {number|null} [input.parentAreaId] Null leaves the area a root.
   * @returns {Promise<object>} The area row plus `parent_area_id` as written.
   */
  async createArea({ name, description, userId = null, parentAreaId = null }) {
    const [row] = await this.#rows(
      `with created as (
         insert into areas (name, description)
         values ($1, $2)
         returning id, name, description
       ),
       lead as (
         insert into area_members (user_id, area_id, is_area_leader)
         select $3::bigint, created.id, true
           from created
          where $3::bigint is not null
       ),
       parent as (
         insert into area_hierarchy (child_area_id, parent_area_id)
         select created.id, $4::bigint
           from created
          where $4::bigint is not null
       )
       select id, name, description, $4::bigint as parent_area_id from created`,
      [name, description, userId, parentAreaId],
    );
    return row;
  }

  async getAreas() {
    const rows = await this.#rows(
      "select id, name, description from areas order by name",
    );
    return rows;
  }

  async updateArea(areaId, { name, description }) {
    const [row] = await this.#rows(
      `update areas
        set name = $2,
            description = $3
        where id = $1
        returning id, name, description`,
      [areaId, name, description],
    );
    return row ?? null;
  }

  /**
   * Hard delete; `areas` has no `deleted_at`. The 23503 raised while people are still
   * assigned is the refusal, which orchestration turns into a 409.
   */
  async deleteArea(areaId) {
    const [row] = await this.#rows(
      `delete from areas
        where id = $1
        returning id, name, description`,
      [areaId],
    );
    return row ?? null;
  }

  async getAreaById(areaId) {
    const [row] = await this.#rows(
      "select id, name, description from areas where id = $1",
      [areaId],
    );
    return row ?? null;
  }

  async getAreaByName(name) {
    const [row] = await this.#rows(
      "select id, name, description from areas where lower(name) = lower($1)",
      [name],
    );
    return row ?? null;
  }

  /** Upserts a membership, so adding a leader and promoting a member are the same call. */
  async setAreaMembership(userId, areaId, isAreaLeader) {
    const [row] = await this.#rows(
      `insert into area_members (user_id, area_id, is_area_leader)
        values ($1, $2, $3)
        on conflict (user_id, area_id) do update
          set is_area_leader = excluded.is_area_leader
        returning user_id, area_id, is_area_leader`,
      [userId, areaId, isAreaLeader],
    );
    return row;
  }

  async removeAreaMembership(userId, areaId) {
    const [row] = await this.#rows(
      `delete from area_members
        where user_id = $1 and area_id = $2
        returning user_id, area_id, is_area_leader`,
      [userId, areaId],
    );
    return row ?? null;
  }

  /**
   * A user's areas with their names joined in. getAreaMemberships() is the id-only
   * version that authorisation checks use.
   */
  async getUserAreas(userId) {
    const rows = await this.#rows(
      `select a.id, a.name, a.description, am.is_area_leader
         from area_members am
         join areas a on a.id = am.area_id
        where am.user_id = $1
        order by a.name`,
      [userId],
    );
    return rows;
  }

  /**
   * The areas of a SET of users, for the same reason getAreaMembersForAreas() exists:
   * shaping a page of users is then two queries rather than one plus N.
   *
   * @param {number[]} userIds
   * @returns {Promise<object[]>} Rows carry `user_id` so the caller can group them.
   */
  async getAreasForUsers(userIds) {
    const rows = await this.#rows(
      `select am.user_id, a.id, a.name, am.is_area_leader
         from area_members am
         join areas a on a.id = am.area_id
        where am.user_id = any(coalesce($1::bigint[], '{}'::bigint[]))
        order by a.name`,
      [this.#idArray(userIds)],
    );
    return rows;
  }

  async isUserAreaLeader(userId, areaId) {
    const [row] = await this.#rows(
      `select is_area_leader
         from area_members
        where user_id = $1
          and area_id = $2`,
      [userId, areaId],
    );
    return row?.is_area_leader ?? false;
  }

  async isUserMemberOfArea(userId, areaId) {
    const [row] = await this.#rows(
      `select 1 as is_member
         from area_members
        where user_id = $1
          and area_id = $2`,
      [userId, areaId],
    );
    return row?.is_member === 1;
  }

  /** One area's members, leaders first then alphabetical. */
  async getAreaMembers(areaId) {
    const rows = await this.#rows(
      `select u.id, u.email, u.full_name, r.name as role_name, am.is_area_leader
         from area_members am
         join users u on u.id = am.user_id
         join roles r on r.id = u.role_id
        where am.area_id = $1
          and u.deleted_at is null
        order by am.is_area_leader desc, u.full_name`,
      [areaId],
    );
    return rows;
  }

  /** Members of a set of areas in one query, so drawing the org chart is not 1+N. */
  async getAreaMembersForAreas(areaIds) {
    const rows = await this.#rows(
      `select am.area_id, u.id, u.email, u.full_name, r.name as role_name,
              am.is_area_leader
         from area_members am
         join users u on u.id = am.user_id
         join roles r on r.id = u.role_id
        where am.area_id = any(coalesce($1::bigint[], '{}'::bigint[]))
          and u.deleted_at is null
        order by am.is_area_leader desc, u.full_name`,
      [this.#idArray(areaIds)],
    );
    return rows;
  }

  /** Upserts the child's parent. `child_area_id` is the whole key: one parent per area. */
  async setAreaParent(childAreaId, parentAreaId) {
    const [row] = await this.#rows(
      `insert into area_hierarchy (child_area_id, parent_area_id)
        values ($1, $2)
        on conflict (child_area_id) do update
          set parent_area_id = excluded.parent_area_id
        returning child_area_id, parent_area_id`,
      [childAreaId, parentAreaId],
    );
    return row;
  }

  async clearAreaParent(childAreaId) {
    const [row] = await this.#rows(
      `delete from area_hierarchy
        where child_area_id = $1
        returning child_area_id, parent_area_id`,
      [childAreaId],
    );
    return row ?? null;
  }

  async getAreaParent(childAreaId) {
    const [row] = await this.#rows(
      `select a.id, a.name, a.description
         from area_hierarchy h
         join areas a on a.id = h.parent_area_id
        where h.child_area_id = $1`,
      [childAreaId],
    );
    return row ?? null;
  }

  /**
   * Cycle guard for setAreaParent(): is `candidateId` below `ancestorId`? Carries a
   * CYCLE clause so an already-corrupt table cannot hang the check for corruption.
   */
  async isAreaDescendantOf(candidateId, ancestorId) {
    const [row] = await this.#rows(
      `with recursive descendants as (
           select child_area_id as id
             from area_hierarchy
            where parent_area_id = $2
         union all
           select h.child_area_id
             from area_hierarchy h
             join descendants d on d.id = h.parent_area_id
       ) cycle id set is_cycle using path
       select 1 as found
         from descendants
        where id = $1 and not is_cycle
        limit 1`,
      [candidateId, ancestorId],
    );
    return row?.found === 1;
  }

  /**
   * One row per area with its parent and computed depth. A null `rootAreaId` walks the
   * whole forest, an id walks that subtree only (RF-USR-04). The CYCLE clause drops
   * repeated rows instead of recursing forever.
   */
  async getAreaTreeRows(rootAreaId = null) {
    const rows = await this.#rows(
      `with recursive tree as (
           select a.id, a.name, a.description, h.parent_area_id, 0 as depth
             from areas a
             left join area_hierarchy h on h.child_area_id = a.id
            where case
                    when $1::bigint is null then h.child_area_id is null
                    else a.id = $1::bigint
                  end
         union all
           select a.id, a.name, a.description, h.parent_area_id, t.depth + 1
             from tree t
             join area_hierarchy h on h.parent_area_id = t.id
             join areas a on a.id = h.child_area_id
       ) cycle id set is_cycle using path
       select id, name, description, parent_area_id, depth
         from tree
        where not is_cycle
        order by depth, name`,
      [rootAreaId],
    );
    return rows;
  }

  async createRole({ name, description }) {
    const [row] = await this.#rows(
      `insert into roles (name, description)
        values ($1, $2)
        returning id, name, description`,
      [name, description],
    );
    return row;
  }

  async getRoles() {
    const rows = await this.#rows(
      "select id, name, description from roles order by name",
    );
    return rows;
  }

  async getRoleById(roleId) {
    const [row] = await this.#rows(
      "select id, name, description from roles where id = $1",
      [roleId],
    );
    return row ?? null;
  }

  async getRoleByName(name) {
    const [row] = await this.#rows(
      "select id, name, description from roles where lower(name) = lower($1)",
      [name],
    );
    return row ?? null;
  }

  async updateRole(roleId, { name, description }) {
    const [row] = await this.#rows(
      `update roles
        set name = $2,
            description = $3
        where id = $1
        returning id, name, description`,
      [roleId, name, description],
    );
    return row ?? null;
  }

  /**
   * Deletes a role. Its users are not reassigned — `users.role_id` is NOT NULL with no
   * defensible default — so orchestration counts the holders and refuses first.
   */
  async deleteRole(roleId) {
    const [row] = await this.#rows(
      `delete from roles
        where id = $1
        returning id, name, description`,
      [roleId],
    );
    return row ?? null;
  }

  /** Counts live users holding a role. */
  async countUsersWithRole(roleId) {
    const [row] = await this.#rows(
      `select count(*)::int as count
         from users
        where role_id = $1
          and deleted_at is null`,
      [roleId],
    );
    return row?.count ?? 0;
  }

  async createPermission({ code, label, description }) {
    const [row] = await this.#rows(
      `insert into permissions (code, label, description)
        values ($1, $2, $3)
        returning id, code, label, description`,
      [code, label, description],
    );
    return row;
  }

  async getPermissions() {
    const rows = await this.#rows(
      "select id, code, label, description from permissions order by code",
    );
    return rows;
  }

  async getPermissionById(permissionId) {
    const [row] = await this.#rows(
      "select id, code, label, description from permissions where id = $1",
      [permissionId],
    );
    return row ?? null;
  }

  async getPermissionByCode(code) {
    const [row] = await this.#rows(
      "select id, code, label, description from permissions where code = $1",
      [code],
    );
    return row ?? null;
  }

  async updatePermission(permissionId, { code, label, description }) {
    const [row] = await this.#rows(
      `update permissions
        set code = $2,
            label = $3,
            description = $4
        where id = $1
        returning id, code, label, description`,
      [permissionId, code, label, description],
    );
    return row ?? null;
  }

  /** Deletes a permission; `role_permissions` cascades, revoking it everywhere. */
  async deletePermission(permissionId) {
    const [row] = await this.#rows(
      `delete from permissions
        where id = $1
        returning id, code, label, description`,
      [permissionId],
    );
    return row ?? null;
  }

  /** One role's grants as full rows; getRolePermissionCodes() is the codes-only version. */
  async getRolePermissions(roleId) {
    const rows = await this.#rows(
      `select p.id, p.code, p.label, p.description
         from role_permissions rp
         join permissions p on p.id = rp.permission_id
        where rp.role_id = $1
        order by p.code`,
      [roleId],
    );
    return rows;
  }

  /**
   * Grants a permission to a role.
   *
   * @returns {Promise<object | null>} null when the grant already existed.
   */
  async grantPermissionToRole(roleId, permissionId) {
    const [row] = await this.#rows(
      `insert into role_permissions (role_id, permission_id)
        values ($1, $2)
        on conflict (role_id, permission_id) do nothing
        returning role_id, permission_id`,
      [roleId, permissionId],
    );
    return row ?? null;
  }

  async revokePermissionFromRole(roleId, permissionId) {
    const [row] = await this.#rows(
      `delete from role_permissions
        where role_id = $1 and permission_id = $2
        returning role_id, permission_id`,
      [roleId, permissionId],
    );
    return row ?? null;
  }

  /**
   * Replaces a role's whole grant set in one CTE, so the role is never momentarily
   * stripped. A grant that survives the edit is not removed and re-added.
   *
   * @returns {Promise<object[]>} The resolved permissions; fewer rows than ids means one
   *   id names no permission, which orchestration refuses.
   */
  async setRolePermissions(roleId, permissionIds) {
    const rows = await this.#rows(
      `with revoked as (
         delete from role_permissions
          where role_id = $1
            and permission_id <> all(coalesce($2::bigint[], '{}'::bigint[]))
       ),
       granted as (
         insert into role_permissions (role_id, permission_id)
         select $1, p.id
           from permissions p
          where p.id = any(coalesce($2::bigint[], '{}'::bigint[]))
         on conflict (role_id, permission_id) do nothing
       )
       select p.id, p.code, p.label, p.description
         from permissions p
        where p.id = any(coalesce($2::bigint[], '{}'::bigint[]))
        order by p.code`,
      [roleId, this.#idArray(permissionIds)],
    );
    return rows;
  }

  /**
   * A request. `folio` comes from the sequence, never from the caller (RF-SOL-03). A 23505 on
   * `uq_requests_sheet_hash` means that row of that book is already in.
   */
  async createRequest({
    schemaVersionId, title, data = {}, requester = null, areaId = null, statusId,
    assigneeId = null, priority = 0, source = 'manual', sheetId = null,
    sourceIndex = null, sourceData = null, sourceHash = null, possibleDuplicateOf = null,
    folderId = null, createdBy = null,
  }) {
    const [row] = await this.#rows(
      `insert into requests (
        schema_version_id, title, data, requester, area_id, status_id, assignee_id,
        priority, source, sheet_id, source_index, source_data, source_hash,
        possible_duplicate_of, folder_id, created_by
      )
      values (
        $1, $2, $3::jsonb, $4, $5::bigint, $6, $7::bigint,
        $8, $9, $10::bigint, $11::int, $12::jsonb, $13,
        $14::bigint, $15::bigint, $16::bigint
      )
      returning *`,
      [
        schemaVersionId, title, JSON.stringify(data ?? {}), requester, areaId, statusId,
        assigneeId, priority, source, sheetId, sourceIndex,
        sourceData === null ? null : JSON.stringify(sourceData), sourceHash,
        possibleDuplicateOf, folderId, createdBy,
      ],
    );
    return row;
  }

  /** One request with the format it was captured under and the project it became. */
  async getRequest(requestId) {
    const [row] = await this.#rows(
      `select
        r.*,
        v.version as schema_version, v.fields as schema_fields,
        sc.id as schema_id, sc.code as schema_code, sc.name as schema_name,
        st.code as status_code, st.label as status_label, st.is_terminal as status_is_terminal,
        a.name as area_name,
        u.full_name as assignee_name,
        c.full_name as created_by_name,
        p.key as project_key, p.title as project_title,
        sh.name as sheet_name,
        d.folio as duplicate_of_folio,
        wv.version as flow_version, w.id as flow_workflow_id, w.name as flow_workflow_name,
        ${this.#phasesJson('r.id', 'request_id')} as flow_phases
      from requests r
      join schema_versions v on v.id = r.schema_version_id
      join schemas sc on sc.id = v.schema_id
      join statuses st on st.id = r.status_id
      left join areas a on a.id = r.area_id
      left join users u on u.id = r.assignee_id
      left join users c on c.id = r.created_by
      left join projects p on p.id = r.project_id
      left join sheets sh on sh.id = r.sheet_id
      left join requests d on d.id = r.possible_duplicate_of
      left join workflow_versions wv on wv.id = r.workflow_version_id
      left join workflows w on w.id = wv.workflow_id
      where r.id = $1 and r.deleted_at is null`,
      [requestId],
    );
    return row ?? null;
  }

  /**
   * The inbox (RF-SOL-04, RF-SOL-05). `converted` null means "not yet converted", which is what
   * a working inbox shows; true or false ask for one side explicitly.
   */
  async listRequests({
    areaId = null, statusId = null, assigneeId = null, requester = null, sheetId = null,
    schemaId = null, q = null, converted = null, duplicates = null, source = null,
    routed = null, sort = 'priority', limit = 50, offset = 0,
  } = {}) {
    return this.#rows(
      `select
        r.id, r.folio, r.title, r.requester, r.area_id, r.status_id, r.status_since,
        r.assignee_id, r.priority, r.source, r.sheet_id, r.project_id,
        r.possible_duplicate_of, r.created_at,
        -- Cuántas hay en total con estos filtros, antes del limit: una bandeja tiene que poder
        -- decir cuánto falta por ver, y repetir el WHERE en un count aparte es la forma de que
        -- las dos consultas dejen de coincidir.
        count(*) over () as total,
        st.code as status_code, st.label as status_label,
        a.name as area_name,
        u.full_name as assignee_name,
        sc.code as schema_code, sc.name as schema_name,
        p.key as project_key,
        exists (select 1 from flow_phases fp where fp.request_id = r.id) as has_flow,
        (select coalesce(json_agg(distinct fa.name), '[]'::json)
          from flow_phases fp
          join flow_stages fs on fs.phase_id = fp.id
          join areas fa on fa.id = fs.area_id
          where fp.request_id = r.id
            and fp.seq = (select min(seq) from flow_phases where request_id = r.id))
          as first_phase_areas
      from requests r
      join schema_versions v on v.id = r.schema_version_id
      join schemas sc on sc.id = v.schema_id
      join statuses st on st.id = r.status_id
      left join areas a on a.id = r.area_id
      left join users u on u.id = r.assignee_id
      left join projects p on p.id = r.project_id
      where r.deleted_at is null
        -- An area's inbox holds what was routed to it by hand and what has it in the first
        -- phase of its flow (DATAMODEL §2.5). -1 is "not routed at all": no area and no flow,
        -- which is how an imported row arrives and what somebody has to triage.
        and ($1::bigint is null
             or ($1::bigint = -1 and r.area_id is null
                 and not exists (select 1 from flow_phases fp where fp.request_id = r.id))
             or r.area_id = $1::bigint
             or exists (
               select 1 from flow_phases fp
               join flow_stages fs on fs.phase_id = fp.id
               where fp.request_id = r.id and fs.area_id = $1::bigint
                 and fp.seq = (select min(seq) from flow_phases where request_id = r.id)))
        and ($2::bigint is null or r.status_id = $2::bigint)
        and ($3::bigint is null or r.assignee_id = $3::bigint)
        and ($4::text is null or lower(r.requester) = lower($4))
        and ($5::bigint is null or r.sheet_id = $5::bigint)
        and ($6::bigint is null or sc.id = $6::bigint)
        and ($7::text is null or r.title ilike '%' || $7 || '%' or r.folio ilike $7 || '%')
        and ($8::boolean is null
             or ($8::boolean and r.project_id is not null)
             or (not $8::boolean and r.project_id is null))
        and ($9::boolean is null
             or ($9::boolean and r.possible_duplicate_of is not null)
             or (not $9::boolean and r.possible_duplicate_of is null))
        and ($10::text is null or r.source = $10::text)
        -- Routed is the step the inbox tabs split on: a request nobody has yet (no area and
        -- no flow) against one an area already holds. The negative case is the same condition
        -- as areaId -1, so one of the two filters is enough.
        and ($11::boolean is null
             or ($11::boolean = (r.area_id is not null
                 or exists (select 1 from flow_phases fp where fp.request_id = r.id))))
      order by
        case when $12::text = 'priority' then r.priority end desc nulls last,
        r.created_at desc, r.id desc
      limit $13 offset $14`,
      [
        areaId, statusId, assigneeId, requester, sheetId, schemaId, q,
        converted, duplicates, source, routed, sort, limit, offset,
      ],
    );
  }

  /** Only the keys the caller sent; `data` is replaced whole when given. */
  async updateRequest(requestId, {
    title = null, requester = null, areaId = null, assigneeId = null, priority = null,
    data = null, possibleDuplicateOf = null, clearDuplicate = false,
  }) {
    const [row] = await this.#rows(
      `update requests set
        title       = coalesce($2, title),
        requester   = coalesce($3, requester),
        area_id     = coalesce($4::bigint, area_id),
        assignee_id = coalesce($5::bigint, assignee_id),
        priority    = coalesce($6::int, priority),
        data        = coalesce($7::jsonb, data),
        possible_duplicate_of = case
                                  when $9 then null
                                  else coalesce($8::bigint, possible_duplicate_of)
                                end
      where id = $1 and deleted_at is null
      returning *`,
      [
        requestId, title, requester, areaId, assigneeId, priority,
        data === null ? null : JSON.stringify(data), possibleDuplicateOf, clearDuplicate,
      ],
    );
    return row ?? null;
  }

  /** `status_since` moves in the same UPDATE, per DATAMODEL 2.7. */
  async setRequestStatus(requestId, statusId) {
    const [row] = await this.#rows(
      `update requests
        set status_id = $2, status_since = current_timestamp
      where id = $1 and deleted_at is null
      returning *`,
      [requestId, statusId],
    );
    return row ?? null;
  }

  async deleteRequest(requestId) {
    const [row] = await this.#rows(
      `update requests
        set deleted_at = current_timestamp
      where id = $1 and deleted_at is null
      returning *`,
      [requestId],
    );
    return row ?? null;
  }

  /**
   * The request a freshly imported row is probably a correction of: same book, same normalised
   * title and requester, not yet converted. What `possible_duplicate_of` points at.
   */
  async findProbableDuplicate({ sheetId, title, requester = null }) {
    const [row] = await this.#rows(
      `select id, folio, title
      from requests
      where sheet_id = $1
        and deleted_at is null
        and lower(btrim(title)) = lower(btrim($2))
        and coalesce(lower(btrim(requester)), '') = coalesce(lower(btrim($3)), '')
      order by id desc
      limit 1`,
      [sheetId, title, requester],
    );
    return row ?? null;
  }

  /** Every hash already taken from a book, so an import can skip what it has seen. */
  async listSourceHashes(sheetId) {
    const rows = await this.#rows(
      `select source_hash from requests
        where sheet_id = $1 and source_hash is not null and deleted_at is null
      union
      select source_hash from sheet_row_marks where sheet_id = $1`,
      [sheetId],
    );
    return new Set(rows.map((row) => row.source_hash));
  }

  /**
   * Marks rows as already seen without creating anything. Returns how many marks are new: a hash
   * already marked, or already carried by a request, is left alone.
   */
  async markSheetRows({ sheetId, hashes, markedBy = null }) {
    if (hashes.length === 0) return 0;

    const rows = await this.#rows(
      `insert into sheet_row_marks (sheet_id, source_hash, marked_by)
      select $1, h, $3 from unnest($2::text[]) as h
      on conflict (sheet_id, source_hash) do nothing
      returning id`,
      [sheetId, hashes, markedBy],
    );
    return rows.length;
  }

  /** Undoes the marking for a book. Returns how many marks went. */
  async clearSheetMarks(sheetId) {
    const rows = await this.#rows(
      'delete from sheet_row_marks where sheet_id = $1 returning id',
      [sheetId],
    );
    return rows.length;
  }

  /** How many rows of a book are marked as seen without a request behind them. */
  async countSheetMarks(sheetId) {
    const [row] = await this.#rows(
      'select count(*)::int as n from sheet_row_marks where sheet_id = $1',
      [sheetId],
    );
    return row?.n ?? 0;
  }

  /**
   * A project, the requests it converts, its first field values and its first stages, in one
   * statement. `key` omitted takes the sequence default.
   */
  async createProject({
    key = null, title, description = null, requester = null, schemaVersionId = null,
    statusId, priority = 0, hasCost = false, carriedOver = false,
    startsOn = null, dueOn = null, folderId = null, eventCollectionId = null, createdBy = null,
    requestIds = [], fieldValues = [], stages = [],
    flowRequestId = null, discardFlowRequestIds = [], workflowVersionId = null,
  }) {
    const [row] = await this.#rows(
      `with created as (
        insert into projects (
          key, title, description, requester, schema_version_id, status_id,
          priority, has_cost, carried_over, starts_on, due_on,
          folder_id, event_collection_id, created_by, workflow_version_id
        )
        values (
          coalesce($1, 'PRY-' || to_char(nextval('projects_key_seq'), 'FM000000')),
          $2, $3, $4, $5::bigint, $6,
          $7, $8, $9, $10::date, $11::date,
          $12::bigint, $13::bigint, $14::bigint, $31::bigint
        )
        returning *
      ),
      linked as (
        update requests r
          set project_id = created.id
        from created
        where r.id = any($15::bigint[]) and r.project_id is null and r.deleted_at is null
        returning r.id
      ),
      values_inserted as (
        insert into project_field_values (project_id, key, value)
        select created.id, v.key, v.value
        from created, unnest($16::text[], $17::text[]) as v(key, value)
        returning 1
      ),
      stage_input as (
        select * from unnest(
          $18::bigint[], $19::text[], $20::int[], $21::int[], $22::text[], $23::text[],
          $24::text[], $25::text[], $26::text[], $27::text[], $28::text[]
        ) as st(
          area_id, title, seq, position, status, assigned_to,
          inputs, outputs, input_note, output_note, estimated_days
        )
      ),
      phases_inserted as (
        insert into flow_phases (project_id, seq, name)
        select distinct created.id, si.seq, 'Fase ' || si.seq
        from created, stage_input si
        returning id, seq
      ),
      definitions_inserted as (
        insert into flow_stages (
          phase_id, seq, area_id, title, input_keys, output_keys,
          input_note, output_note, estimated_days
        )
        select
          ph.id, si.position, si.area_id, si.title, si.inputs::jsonb, si.outputs::jsonb,
          nullif(si.input_note, ''), nullif(si.output_note, ''),
          nullif(si.estimated_days, '')::int
        from stage_input si
        join phases_inserted ph on ph.seq = si.seq
        returning id, phase_id, seq
      ),
      stages_inserted as (
        insert into project_stages (flow_stage_id, status, started_at, assigned_to)
        select
          d.id, si.status,
          case when si.status = 'active' then current_timestamp end,
          nullif(si.assigned_to, '')::bigint
        from stage_input si
        join phases_inserted ph on ph.seq = si.seq
        join definitions_inserted d on d.phase_id = ph.id and d.seq = si.position
        returning 1
      ),
      all_linked as (
        select (select count(*) from linked) = coalesce(cardinality($15::bigint[]), 0) as ok
      ),
      moved_phases as (
        update flow_phases fp
          set request_id = null, project_id = created.id
        from created, all_linked
        where fp.request_id = $29::bigint and all_linked.ok
        returning fp.id, fp.seq
      ),
      moved_first as (
        select min(seq) as seq from moved_phases
      ),
      moved_executions as (
        insert into project_stages (flow_stage_id, status, started_at, assigned_to)
        select
          fs.id,
          case when mp.seq = mf.seq then 'active' else 'pending' end,
          case when mp.seq = mf.seq then current_timestamp end,
          case when exists (
            select 1 from area_members m
            join users u on u.id = m.user_id
            where m.area_id = fs.area_id and m.user_id = fs.default_assignee_id
              and u.deleted_at is null
          ) then fs.default_assignee_id end
        from moved_phases mp
        cross join moved_first mf
        join flow_stages fs on fs.phase_id = mp.id
        returning 1
      ),
      moved_unsuggested as (
        update flow_stages set default_assignee_id = null
        where phase_id in (select id from moved_phases) and default_assignee_id is not null
        returning 1
      ),
      discarded_flows as (
        delete from flow_phases
        where request_id = any(coalesce($30::bigint[], '{}'::bigint[]))
          and (select ok from all_linked)
        returning request_id
      )
      select
        created.*,
        (select count(*) from linked)::int as linked_count,
        ((select count(*) from stages_inserted) + (select count(*) from moved_executions))::int
          as stage_count
      from created`,
      [
        key, title, description, requester, schemaVersionId, statusId,
        priority, hasCost, carriedOver, startsOn, dueOn,
        folderId, eventCollectionId, createdBy,
        this.#idArray(requestIds),
        this.#idArray(fieldValues.map((v) => v.key)),
        this.#idArray(fieldValues.map((v) => v.value)),
        this.#idArray(stages.map((st) => st.areaId)),
        this.#idArray(stages.map((st) => st.title)),
        this.#idArray(stages.map((st) => st.seq)),
        this.#idArray(stages.map((st) => st.position)),
        this.#idArray(stages.map((st) => st.status)),
        this.#idArray(stages.map((st) => (st.assignedTo == null ? '' : String(st.assignedTo)))),
        this.#idArray(stages.map((st) => JSON.stringify(st.inputs ?? []))),
        this.#idArray(stages.map((st) => JSON.stringify(st.outputs ?? []))),
        this.#idArray(stages.map((st) => st.inputNote ?? '')),
        this.#idArray(stages.map((st) => st.outputNote ?? '')),
        this.#idArray(stages.map((st) => (st.estimatedDays == null ? '' : String(st.estimatedDays)))),
        flowRequestId,
        this.#idArray(discardFlowRequestIds),
        workflowVersionId,
      ],
    );

    return row;
  }

  /** One project with its stages (and their approvals), field values and linked requests. */
  async getProject(projectId) {
    const [row] = await this.#rows(
      `select
        p.*,
        s.code as status_code, s.label as status_label, s.is_terminal as status_is_terminal,
        u.full_name as created_by_name,
        coalesce(stages.list, '[]'::json) as stages,
        coalesce(fv.list, '[]'::json) as field_values,
        coalesce(req.list, '[]'::json) as requests
      from projects p
      join statuses s on s.id = p.status_id
      left join users u on u.id = p.created_by
      left join lateral (
        select json_agg(stage order by phase_seq, stage_position, stage_attempt, stage_id) as list
        from (
          select
            ps.id as stage_id, fp.seq as phase_seq, fs.seq as stage_position,
            ps.attempt as stage_attempt,
            json_build_object(
              'id', ps.id, 'flowStageId', ps.flow_stage_id, 'phaseId', fp.id,
              'phaseName', fp.name, 'seq', fp.seq, 'position', fs.seq,
              'areaId', fs.area_id, 'areaName', a.name, 'title', fs.title,
              'attempt', ps.attempt, 'status', ps.status,
              'blockedReason', ps.blocked_reason, 'assignedTo', ps.assigned_to,
              'assignedToName', au.full_name, 'eventId', ps.event_id,
              'startedAt', ps.started_at, 'endedAt', ps.ended_at, 'createdAt', ps.created_at,
              'inputs', fs.input_keys, 'outputs', fs.output_keys,
              'inputNote', fs.input_note, 'outputNote', fs.output_note,
              'estimatedDays', fs.estimated_days,
              'approvals', coalesce(ap.list, '[]'::json)
            ) as stage
          from ${STAGE_FROM}
          left join users au on au.id = ps.assigned_to
          left join lateral (
            select json_agg(json_build_object(
              'id', v.id, 'decision', v.decision, 'approverUserId', v.approver_user_id,
              'approverName', vu.full_name, 'comment', v.comment,
              'evidenceFileId', v.evidence_file_id, 'decidedAt', v.decided_at
            ) order by v.decided_at, v.id) as list
            from approvals v
            left join users vu on vu.id = v.approver_user_id
            where v.project_stage_id = ps.id
          ) ap on true
          where fp.project_id = p.id
        ) ordered
      ) stages on true
      left join lateral (
        select json_agg(json_build_object(
          'key', f.key, 'value', f.value, 'producedByStageId', f.produced_by_stage_id,
          'updatedAt', f.updated_at
        ) order by f.key) as list
        from project_field_values f
        where f.project_id = p.id
      ) fv on true
      left join lateral (
        select json_agg(json_build_object(
          'id', r.id, 'folio', r.folio, 'title', r.title
        ) order by r.id) as list
        from requests r
        where r.project_id = p.id and r.deleted_at is null
      ) req on true
      where p.id = $1 and p.deleted_at is null`,
      [projectId],
    );

    return row ?? null;
  }

  /**
   * The board (RF-PRY-02, RF-SOL-05). `state` is open | closed | archived | all; `areaId`
   * matches a project with a stage in that area; `fieldKey`/`fieldValue` is RF-IMP-08's
   * equality lookup over produced values.
   */
  async listProjects({
    q = null, statusId = null, areaId = null, requester = null,
    hasCost = null, carriedOver = null, state = 'open',
    fieldKey = null, fieldValue = null, assignedTo = null, viewerId = null, mine = false,
    sort = 'priority', limit = 50, offset = 0,
  } = {}) {
    return this.#rows(
      `select
        p.id, p.key, p.title, p.requester, p.status_id, p.status_since, p.priority,
        p.has_cost, p.carried_over, p.starts_on, p.due_on,
        p.closed_at, p.archived_at, p.created_at, p.created_by,
        count(*) over () as total,
        s.code as status_code, s.label as status_label,
        (select count(*) from ${STAGE_FROM}
          where fp.project_id = p.id and ps.status in ('active', 'waiting_external'))::int
          as open_stage_count,
        -- The board says where a project is by naming its open stages, not by counting them:
        -- "Diseño gráfico - Propuesta" is what somebody can act on, a 2 is not.
        (select coalesce(json_agg(json_build_object(
            'id', ps.id, 'areaName', a.name, 'title', fs.title, 'status', ps.status
          ) order by fp.seq, fs.seq), '[]'::json)
          from ${STAGE_FROM}
          where fp.project_id = p.id and ps.status in ('active', 'waiting_external'))
          as open_stages,
        (select count(*) from requests r
          where r.project_id = p.id and r.deleted_at is null)::int as request_count,
        -- What the viewer has a part in, said per row so the board can mark it: a project they
        -- created, or one where a stage is theirs. Being in the area is not a part in it.
        ($11::bigint is not null and p.created_by = $11::bigint) as mine_created,
        ($11::bigint is not null and exists (
          select 1 from ${STAGE_FROM}
          where fp.project_id = p.id and ps.assigned_to = $11::bigint)) as mine_responsible
      from projects p
      join statuses s on s.id = p.status_id
      where p.deleted_at is null
        and case $7::text
              when 'open'     then p.closed_at is null and p.archived_at is null
              when 'closed'   then p.closed_at is not null
              when 'archived' then p.archived_at is not null
              else true
            end
        and ($1::text is null or p.title ilike '%' || $1 || '%' or p.key ilike $1 || '%')
        and ($2::bigint is null or p.status_id = $2::bigint)
        and ($3::bigint is null or exists (
              select 1 from flow_phases fp
              join flow_stages fs on fs.phase_id = fp.id
              where fp.project_id = p.id and fs.area_id = $3::bigint))
        and ($4::text is null or lower(p.requester) = lower($4))
        and ($5::boolean is null or p.has_cost = $5::boolean)
        and ($6::boolean is null or p.carried_over = $6::boolean)
        and ($8::text is null or exists (
              select 1 from project_field_values f
              where f.project_id = p.id and f.key = $8::text
                and ($9::text is null or f.value = $9::text)))
        and ($10::bigint is null or exists (
              select 1 from ${STAGE_FROM}
              where fp.project_id = p.id and ps.assigned_to = $10::bigint))
        and (not $12::boolean
             or p.created_by = $11::bigint
             or exists (
               select 1 from ${STAGE_FROM}
               where fp.project_id = p.id and ps.assigned_to = $11::bigint))
      order by
        case when $13::text = 'priority' then p.priority end desc nulls last,
        case when $13::text = 'due' then p.due_on end asc nulls last,
        p.created_at desc, p.id desc
      limit $14 offset $15`,
      [
        q, statusId, areaId, requester, hasCost, carriedOver, state,
        fieldKey, fieldValue, assignedTo, viewerId, mine, sort, limit, offset,
      ],
    );
  }

  /** Only the keys the caller sent; the row is merged in orchestration. */
  async updateProject(projectId, {
    title = null, description = null, requester = null, priority = null,
    hasCost = null, carriedOver = null, startsOn = null, dueOn = null, key = null,
  }) {
    const [row] = await this.#rows(
      `update projects set
        key          = coalesce($2, key),
        title        = coalesce($3, title),
        description  = coalesce($4, description),
        requester    = coalesce($5, requester),
        priority     = coalesce($6, priority),
        has_cost     = coalesce($7, has_cost),
        carried_over = coalesce($8, carried_over),
        starts_on    = coalesce($9::date, starts_on),
        due_on       = coalesce($10::date, due_on)
      where id = $1 and deleted_at is null
      returning *`,
      [projectId, key, title, description, requester, priority, hasCost, carriedOver, startsOn, dueOn],
    );
    return row ?? null;
  }

  /** `status_since` moves in the same UPDATE, per DATAMODEL 2.7. */
  async setProjectStatus(projectId, statusId) {
    const [row] = await this.#rows(
      `update projects
        set status_id = $2, status_since = current_timestamp
      where id = $1 and deleted_at is null
      returning *`,
      [projectId, statusId],
    );
    return row ?? null;
  }

  /** `closed_at` and `archived_at` are different acts; `stamp` names the column. */
  async stampProject(projectId, stamp) {
    const column = stamp === 'closed' ? 'closed_at' : 'archived_at';
    const [row] = await this.#rows(
      `update projects
        set ${column} = current_timestamp
      where id = $1 and deleted_at is null and ${column} is null
      returning *`,
      [projectId],
    );
    return row ?? null;
  }

  async deleteProject(projectId) {
    const [row] = await this.#rows(
      `update projects
        set deleted_at = current_timestamp
      where id = $1 and deleted_at is null
      returning *`,
      [projectId],
    );
    return row ?? null;
  }

  /** Links unconverted requests to an existing project (RF-PRY-01). */
  async attachRequests(projectId, requestIds) {
    return this.#rows(
      `update requests
        set project_id = $1
      where id = any($2::bigint[]) and project_id is null and deleted_at is null
      returning id, folio, title`,
      [projectId, this.#idArray(requestIds)],
    );
  }

  /**
   * Adds a stage to a project: its phase (created as `Fase <seq>` when the project has none at
   * that seq), its definition at the end of that phase, and its first attempt, in one
   * statement. Returns the three rows so orchestration can audit each; `phase` is null when
   * the phase already existed.
   *
   * @returns {Promise<{ stage: object, definition: object, phase: object|null }>}
   */
  async addProjectStage({
    projectId, seq = 1, areaId, title, status = 'pending', assignedTo = null,
    inputs = [], outputs = [], inputNote = null, outputNote = null, estimatedDays = null,
  }) {
    const [row] = await this.#rows(
      `with phase_existing as (
        select id from flow_phases where project_id = $1 and seq = $2::int
      ),
      phase_new as (
        insert into flow_phases (project_id, seq, name)
        select $1, $2::int, 'Fase ' || $2::int
        where not exists (select 1 from phase_existing)
        returning *
      ),
      phase as (
        select id from phase_existing
        union all
        select id from phase_new
      ),
      definition as (
        insert into flow_stages (
          phase_id, seq, area_id, title, input_keys, output_keys,
          input_note, output_note, estimated_days
        )
        select
          phase.id,
          coalesce((select max(fs.seq) from flow_stages fs where fs.phase_id = phase.id), 0) + 1,
          $3, $4, $5::jsonb, $6::jsonb, $7::text, $8::text, $9::int
        from phase
        returning *
      ),
      execution as (
        insert into project_stages (flow_stage_id, attempt, status, assigned_to, started_at)
        select definition.id, 1, $10, $11::bigint,
          case when $10 = 'active' then current_timestamp end
        from definition
        returning *
      )
      select
        to_json(execution.*) as stage,
        to_json(definition.*) as definition,
        (select to_json(phase_new.*) from phase_new) as phase
      from execution, definition`,
      [
        projectId, seq, areaId, title, JSON.stringify(inputs), JSON.stringify(outputs),
        inputNote, outputNote, estimatedDays, status, assignedTo,
      ],
    );
    return row;
  }

  async getProjectStage(stageId) {
    const [row] = await this.#rows(
      `select ${STAGE_COLUMNS}, p.deleted_at as project_deleted_at
      from ${STAGE_FROM}
      join projects p on p.id = fp.project_id
      where ps.id = $1`,
      [stageId],
    );
    return row ?? null;
  }

  async listProjectStages(projectId) {
    return this.#rows(
      `select ${STAGE_COLUMNS}, u.full_name as assigned_to_name
      from ${STAGE_FROM}
      left join users u on u.id = ps.assigned_to
      where fp.project_id = $1
      order by fp.seq, fs.seq, ps.attempt, ps.id`,
      [projectId],
    );
  }

  /**
   * Updates a stage's definition and its execution in one statement. The definition is
   * shared by every attempt, so a retitle or a new output reaches the history too; the
   * execution columns belong to this attempt alone.
   *
   * @returns {Promise<{ stage: object, definition: object|null }|null>}
   */
  async updateProjectStage(stageId, {
    title = null, status = null, blockedReason = null, assignedTo = null, clearBlocked = false,
    inputs = null, outputs = null,
    inputNote, outputNote, estimatedDays,
  }) {
    const definitionChanged =
      title !== null || inputs !== null || outputs !== null ||
      inputNote !== undefined || outputNote !== undefined || estimatedDays !== undefined;

    const [row] = await this.#rows(
      `with definition as (
        update flow_stages set
          title          = coalesce($2, title),
          input_keys     = coalesce($7::jsonb, input_keys),
          output_keys    = coalesce($8::jsonb, output_keys),
          input_note     = case when $9::boolean then $10::text else input_note end,
          output_note    = case when $11::boolean then $12::text else output_note end,
          estimated_days = case when $13::boolean then $14::int else estimated_days end
        where $15::boolean
          and id = (select flow_stage_id from project_stages where id = $1)
        returning *
      ),
      execution as (
        update project_stages set
          status         = coalesce($3, status),
          blocked_reason = case when $6 then null else coalesce($4, blocked_reason) end,
          assigned_to    = coalesce($5::bigint, assigned_to),
          started_at     = case
                             when started_at is null and coalesce($3, status) = 'active'
                             then current_timestamp else started_at
                           end,
          ended_at       = case
                             when coalesce($3, status) in ('done', 'cancelled')
                             then coalesce(ended_at, current_timestamp)
                             else ended_at
                           end
        where id = $1
        returning *
      )
      select
        to_json(execution.*) as stage,
        (select to_json(definition.*) from definition) as definition
      from execution`,
      [
        stageId, title, status, blockedReason, assignedTo, clearBlocked,
        inputs === null ? null : JSON.stringify(inputs),
        outputs === null ? null : JSON.stringify(outputs),
        inputNote !== undefined, inputNote ?? null,
        outputNote !== undefined, outputNote ?? null,
        estimatedDays !== undefined, estimatedDays ?? null,
        definitionChanged,
      ],
    );
    return row ?? null;
  }

  /**
   * Closes a stage and opens what follows it, in one statement.
   *
   * @param {number} stageId
   * @param {{ status?: string, rerun?: boolean }} input
   * @returns {Promise<{ stage: object, reopened: object[], opened: object[] }>}
   */
  async advanceStage(stageId, { status = 'done', rerun = false } = {}) {
    const rows = await this.#rows(
      `with closed as (
        update project_stages
          set status = $2, ended_at = coalesce(ended_at, current_timestamp)
        where id = $1
        returning *
      ),
      place as (
        select fs.phase_id, fp.project_id, fp.seq as phase_seq
        from closed
        join flow_stages fs on fs.id = closed.flow_stage_id
        join flow_phases fp on fp.id = fs.phase_id
      ),
      rerun as (
        insert into project_stages (flow_stage_id, attempt, status, assigned_to, started_at)
        select
          closed.flow_stage_id,
          (select max(ps.attempt) from project_stages ps
            where ps.flow_stage_id = closed.flow_stage_id) + 1,
          'active', closed.assigned_to, current_timestamp
        from closed
        where $3::boolean
        returning *
      ),
      next_phase as (
        select min(fp.seq) as seq
        from place
        join flow_phases fp on fp.project_id = place.project_id and fp.seq > place.phase_seq
        join flow_stages fs on fs.phase_id = fp.id
        join project_stages ps on ps.flow_stage_id = fs.id and ps.status = 'pending'
        where not $3::boolean and $2::text = 'done'
          and not exists (
            select 1
            from flow_stages sibling
            join project_stages sp on sp.flow_stage_id = sibling.id
            where sibling.phase_id = place.phase_id
              and sp.id <> $1
              and sp.status in ('pending', 'active', 'waiting_external')
          )
      ),
      advanced as (
        update project_stages ps
          set status = 'active', started_at = coalesce(ps.started_at, current_timestamp)
        from flow_stages fs, flow_phases fp, place, next_phase
        where fs.id = ps.flow_stage_id
          and fp.id = fs.phase_id
          and fp.project_id = place.project_id
          and fp.seq = next_phase.seq
          and ps.status = 'pending'
        returning ps.*
      )
      select 'closed' as kind, to_json(closed.*) as row from closed
      union all
      select 'reopened' as kind, to_json(rerun.*) as row from rerun
      union all
      select 'opened' as kind, to_json(advanced.*) as row from advanced`,
      [stageId, status, rerun],
    );

    return {
      stage: rows.find((r) => r.kind === 'closed')?.row ?? null,
      reopened: rows.filter((r) => r.kind === 'reopened').map((r) => r.row),
      opened: rows.filter((r) => r.kind === 'opened').map((r) => r.row),
    };
  }

  async createApproval({ projectStageId, decision, approverUserId, comment = null, evidenceFileId = null }) {
    const [row] = await this.#rows(
      `insert into approvals (
        project_stage_id, decision, approver_user_id, comment, evidence_file_id
      )
      values ($1, $2, $3, $4, $5::bigint)
      returning *`,
      [projectStageId, decision, approverUserId, comment, evidenceFileId],
    );
    return row;
  }

  async listApprovals(stageId) {
    return this.#rows(
      `select v.*, u.full_name as approver_name
      from approvals v
      left join users u on u.id = v.approver_user_id
      where v.project_stage_id = $1
      order by v.decided_at, v.id`,
      [stageId],
    );
  }

  /**
   *  One row per key per project; a correction is an UPDATE that moves the provenance with it.
   */
  async upsertFieldValue(projectId, { key, value, producedByStageId = null }) {
    const [row] = await this.#rows(
      `insert into project_field_values (project_id, key, value, produced_by_stage_id)
      values ($1, $2, $3, $4::bigint)
      on conflict (project_id, key) do update
        set value = excluded.value,
            produced_by_stage_id = coalesce(excluded.produced_by_stage_id, project_field_values.produced_by_stage_id),
            updated_at = current_timestamp
      returning *`,
      [projectId, key, value, producedByStageId],
    );
    return row;
  }

  async listFieldValues(projectId) {
    return this.#rows(
      `select * from project_field_values where project_id = $1 order by key`,
      [projectId],
    );
  }

  async deleteFieldValue(projectId, key) {
    const [row] = await this.#rows(
      `delete from project_field_values where project_id = $1 and key = $2 returning *`,
      [projectId, key],
    );
    return row ?? null;
  }

  /** Points a registered book at a format version and stores how its columns feed it. */
  async setSheetMapping(sheetId, { schemaVersionId, columnMap }) {
    const [row] = await this.#rows(
      `update sheets
        set schema_version_id = $2, column_map = $3::jsonb
      where id = $1 and deleted_at is null
      returning *`,
      [sheetId, schemaVersionId, JSON.stringify(columnMap)],
    );
    return row ?? null;
  }

  /** Back to registered-but-unmapped, which is what an empty map and a null version mean. */
  async clearSheetMapping(sheetId) {
    const [row] = await this.#rows(
      `update sheets
        set schema_version_id = null, column_map = '{}'::jsonb
      where id = $1 and deleted_at is null
      returning *`,
      [sheetId],
    );
    return row ?? null;
  }

  async createSheetImport({ sheetId, runBy = null }) {
    const [row] = await this.#rows(
      `insert into sheet_imports (sheet_id, run_by)
      values ($1, $2::bigint)
      returning *`,
      [sheetId, runBy],
    );
    return row;
  }

  /** Closes the run with its counts. `errors` is [{ index, message }]. */
  async finishSheetImport(importId, {
    rowsRead = 0, rowsCreated = 0, rowsSkipped = 0, rowsFailed = 0, rowsFlagged = 0, errors = [],
  }) {
    const [row] = await this.#rows(
      `update sheet_imports set
        finished_at  = current_timestamp,
        rows_read    = $2,
        rows_created = $3,
        rows_skipped = $4,
        rows_failed  = $5,
        rows_flagged = $6,
        errors       = $7::jsonb
      where id = $1
      returning *`,
      [importId, rowsRead, rowsCreated, rowsSkipped, rowsFailed, rowsFlagged, JSON.stringify(errors)],
    );
    return row ?? null;
  }

  async listSheetImports(sheetId, limit = 20) {
    return this.#rows(
      `select i.*, u.full_name as run_by_name
      from sheet_imports i
      left join users u on u.id = i.run_by
      where i.sheet_id = $1
      order by i.started_at desc, i.id desc
      limit $2`,
      [sheetId, limit],
    );
  }

  /** How far the last import got, for the next one to say "since when" (RF-MIG-02). */
  async markSheetImported(sheetId) {
    const [row] = await this.#rows(
      `update sheets
        set last_imported_at = current_timestamp
      where id = $1
      returning *`,
      [sheetId],
    );
    return row ?? null;
  }

  /**
   * The requester strings already in use, for the autocomplete that keeps a person from
   * inventing a fifth spelling. Distinct across requests and projects, prefix-matched so
   * the index on lower(requester) is usable.
   */
  async listRequesters({ q = null, limit = 20 } = {}) {
    return this.#rows(
      `select requester, count(*)::int as uses
      from (
        select requester from requests where requester is not null and deleted_at is null
        union all
        select requester from projects where requester is not null and deleted_at is null
      ) used
      where $1::text is null or lower(requester) like lower($1) || '%'
      group by requester
      order by count(*) desc, requester
      limit $2`,
      [q, limit],
    );
  }

  /**
   * The catalogue an area works with: its own rows plus the global ones. Without an area,
   * the global catalogue alone.
   */
  async listStatuses({ areaId = null, includeInactive = false } = {}) {
    return this.#rows(
      `select
        s.id, s.area_id, s.code, s.label, s.sort_order, s.is_terminal, s.is_active,
        a.name as area_name
      from statuses s
      left join areas a on a.id = s.area_id
      where (s.area_id is null or s.area_id = $1::bigint)
        and ($2 or s.is_active)
      order by s.area_id nulls first, s.sort_order, s.id`,
      [areaId, includeInactive],
    );
  }

  async getStatus(statusId) {
    const [row] = await this.#rows(
      `select
        s.id, s.area_id, s.code, s.label, s.sort_order, s.is_terminal, s.is_active,
        a.name as area_name
      from statuses s
      left join areas a on a.id = s.area_id
      where s.id = $1`,
      [statusId],
    );
    return row ?? null;
  }

  /**
   *  A code in one catalogue. `areaId` null looks in the global one, matching the two partial indexes.
   */
  async findStatusByCode(code, areaId = null) {
    const [row] = await this.#rows(
      `select id, area_id, code, label, sort_order, is_terminal, is_active
      from statuses
      where code = $1
        and (($2::bigint is null and area_id is null) or area_id = $2::bigint)
      limit 1`,
      [code, areaId],
    );
    return row ?? null;
  }

  async createStatus({
    areaId = null,
    code,
    label,
    sortOrder = 0,
    isTerminal = false,
  }) {
    const [row] = await this.#rows(
      `insert into statuses (area_id, code, label, sort_order, is_terminal)
      values ($1, $2, $3, $4, $5)
      returning id, area_id, code, label, sort_order, is_terminal, is_active`,
      [areaId, code, label, sortOrder, isTerminal],
    );
    return row;
  }

  async updateStatus(
    statusId,
    { label = null, sortOrder = null, isTerminal = null, isActive = null },
  ) {
    const [row] = await this.#rows(
      `update statuses
        set label       = coalesce($2, label),
            sort_order  = coalesce($3, sort_order),
            is_terminal = coalesce($4, is_terminal),
            is_active   = coalesce($5, is_active)
      where id = $1
      returning id, area_id, code, label, sort_order, is_terminal, is_active`,
      [statusId, label, sortOrder, isTerminal, isActive],
    );
    return row ?? null;
  }

  /** Deactivates: the rows are referenced by requests and projects, so they never leave. */
  async deactivateStatus(statusId) {
    const [row] = await this.#rows(
      `update statuses
        set is_active = false
      where id = $1
      returning id, area_id, code, label, sort_order, is_terminal, is_active`,
      [statusId],
    );
    return row ?? null;
  }

  async getDataType(code) {
    const [row] = await this.#rows(
      `select
        id,
        code,
        name,
        base_type,
        properties,
        is_active,
        created_at
      from data_types
      where code = $1`,
      [code],
    );

    return row ?? null;
  }

  async getDataTypes() {
    return this.#rows(
      `select
        id,
        code,
        name,
        base_type,
        properties,
        is_active,
        created_at
      from data_types
      where is_active = true
      order by name, id`,
    );
  }

  /**
   * CREATE
   * Crea un schema y su primera versión.
   * El schema almacena la identidad estable, mientras que la versión almacena la definición JSON de sus campos.
   */

  async createSchema({ code, name, fields, publishedBy = null }) {
    const [row] = await this.#rows(
      `with created_schema as(
        insert into schemas (code, name)
        values($1, $2)
        returning id, code, name, is_active, created_at
      ),
      created_version as (
        insert into schema_versions(
          schema_id,
          version, 
          fields,
          published_by
        )
        select
          created_schema.id,
          1,
          $3::jsonb,
          $4::bigint
        from created_schema
        returning 
          id, 
          schema_id, 
          version, 
          fields, 
          published_at, 
          published_by
      )
      select
        s.id,
        s.code,
        s.name,
        s.is_active,
        s.created_at,
        v.id as schema_version_id,
        v.version,
        v.fields,
        v.published_at,
        v.published_by
      from created_schema s
      join created_version v
        on v.schema_id = s.id`,
      [code, name, JSON.stringify(fields), publishedBy],
    );

    return row;
  }

  /**
   * READ
   * Obtiene un schema con su última versión.
   */
  async getSchema(schemaId) {
    const [row] = await this.#rows(
      `select
        s.id,
        s.code,
        s.name,
        s.is_active,
        s.created_at,
        v.id as schema_version_id,
        v.version,
        v.fields,
        v.published_at,
        v.published_by
      from schemas s
      left join lateral (
        select
          id, version, fields, published_at, published_by
        from schema_versions
        where schema_id = s.id
        order by version desc
        limit 1
      ) v on true
      where s.id = $1`,
      [schemaId],
    );
    return row ?? null;
  }

  async getSchemas() {
    return this.#rows(
      `select
        s.id,
        s.code,
        s.name,
        s.is_active,
        s.created_at,
        v.id as schema_version_id,
        v.version,
        v.fields,
        v.published_at,
        v.published_by
      from schemas s
      left join lateral (
        select
          id, version, fields, published_at, published_by
        from schema_versions
        where schema_id = s.id
        order by version desc
        limit 1
      ) v on true
      order by s.name, s.id`,
    );
  }

  /**
   * UPDATE
   * Crea una NUEVA versión de un schema existente
   */

  async createSchemaVersion(schemaId, { fields, publishedBy = null }) {
    const [row] = await this.#rows(
      `insert into schema_versions(
        schema_id,
        version, 
        fields,
        published_by
      )
      select
        $1,
        coalesce(max(version), 0) + 1,
        $2::jsonb,
        $3::bigint
      from schema_versions
      where schema_id = $1
      returning
        id,
        schema_id,
        version, 
        fields,
        published_at,
        published_by`,
      [schemaId, JSON.stringify(fields), publishedBy],
    );

    return row;
  }

  /**
   * DELETE
   * Desactiva un schema
   */

  async desactivateSchema(schemaId) {
    const [row] = await this.#rows(
      `update schemas
        set is_active = false
      where id = $1
      returning
        id,
        code, 
        name,
        is_active,
        created_at`,
      [schemaId],
    );

    return row ?? null;
  }

  /**
   * Clones a schema: a new identity whose version 1 carries the LATEST version's fields of
   * the source, in one statement. `null` when the source does not exist or has no version.
   */
  async cloneSchema(sourceId, { code, name, publishedBy = null }) {
    const [row] = await this.#rows(
      `with source as (
        select fields
        from schema_versions
        where schema_id = $1
        order by version desc
        limit 1
      ),
      created_schema as (
        insert into schemas (code, name)
        select $2, $3 from source
        returning id, code, name, is_active, created_at
      ),
      created_version as (
        insert into schema_versions (schema_id, version, fields, published_by)
        select created_schema.id, 1, source.fields, $4::bigint
        from created_schema, source
        returning id, schema_id, version, fields, published_at, published_by
      )
      select
        s.id, s.code, s.name, s.is_active, s.created_at,
        v.id as schema_version_id, v.version, v.fields, v.published_at, v.published_by
      from created_schema s
      join created_version v on v.schema_id = s.id`,
      [sourceId, code, name, publishedBy],
    );
    return row ?? null;
  }

  /** Every version of a schema, newest first. */
  async getSchemaVersions(schemaId) {
    return this.#rows(
      `select id, schema_id, version, fields, published_at, published_by
      from schema_versions
      where schema_id = $1
      order by version desc`,
      [schemaId],
    );
  }

  /** One version by its own id, with the identity it belongs to. */
  async getSchemaVersion(versionId) {
    const [row] = await this.#rows(
      `select
        v.id, v.schema_id, v.version, v.fields, v.published_at, v.published_by,
        s.code as schema_code, s.name as schema_name, s.is_active as schema_is_active
      from schema_versions v
      join schemas s on s.id = v.schema_id
      where v.id = $1`,
      [versionId],
    );
    return row ?? null;
  }

  /**
   *  The newest version of a schema, or null. Used wherever "the schema" means its current shape.
   */
  async getLatestSchemaVersion(schemaId) {
    const [row] = await this.#rows(
      `select
        v.id, v.schema_id, v.version, v.fields, v.published_at, v.published_by,
        s.code as schema_code, s.name as schema_name, s.is_active as schema_is_active
      from schema_versions v
      join schemas s on s.id = v.schema_id
      where v.schema_id = $1
      order by v.version desc
      limit 1`,
      [schemaId],
    );
    return row ?? null;
  }

  /**
   * The field vocabulary: every key ever published, with its most recent definition and where it
   * is used.
   */
  async listFieldKeys() {
    return this.#rows(
      `with campos as (
        select
          f->>'code' as key,
          f->>'name' as name,
          f->>'type' as type,
          coalesce(f->>'note', '') as note,
          v.schema_id, v.published_at, v.id as version_id
        from schema_versions v
        cross join lateral (
          select value as f from jsonb_array_elements(coalesce(v.fields->'deliverables', '[]'::jsonb))
          union all
          select value as f from jsonb_array_elements(coalesce(v.fields->'information', '[]'::jsonb))
        ) campo
        where f->>'code' is not null
      ),
      ultima as (
        select distinct on (key) key, name, type, note
        from campos
        order by key, published_at desc, version_id desc
      )
      select
        u.key, u.name, u.type, u.note,
        (select count(distinct c.schema_id) from campos c where c.key = u.key)::int as schema_count,
        (select json_agg(distinct s.name)
           from campos c join schemas s on s.id = c.schema_id
          where c.key = u.key) as schemas
      from ultima u
      order by u.key`,
    );
  }

  /** Identity-level edit: name and active flag. Versions are never touched. */
  async updateSchema(schemaId, { name, isActive }) {
    const [row] = await this.#rows(
      `update schemas
        set name = coalesce($2, name),
            is_active = coalesce($3, is_active)
      where id = $1
      returning id, code, name, is_active, created_at`,
      [schemaId, name ?? null, isActive ?? null],
    );
    return row ?? null;
  }

  /**
   * The phases and stages of one flow as nested camelCase JSON, ordered. `ownerId` is a SQL
   * expression naming the owner and `ownerColumn` which of the three owners it is, so a
   * template version, a request and the latest version of a template share one reader.
   */
  #phasesJson(ownerId, ownerColumn = 'workflow_version_id') {
    return `coalesce((
      select json_agg(json_build_object(
        'id', fp.id, 'seq', fp.seq, 'name', fp.name,
        'stages', coalesce((
          select json_agg(json_build_object(
            'id', fs.id, 'seq', fs.seq, 'areaId', fs.area_id, 'areaName', a.name,
            'title', fs.title, 'defaultAssigneeId', fs.default_assignee_id,
            'defaultAssigneeName', du.full_name,
            'inputs', fs.input_keys, 'outputs', fs.output_keys,
            'inputNote', fs.input_note, 'outputNote', fs.output_note,
            'estimatedDays', fs.estimated_days
          ) order by fs.seq)
          from flow_stages fs
          join areas a on a.id = fs.area_id
          left join users du on du.id = fs.default_assignee_id
          where fs.phase_id = fp.id
        ), '[]'::json)
      ) order by fp.seq)
      from flow_phases fp
      where fp.${ownerColumn} = ${ownerId}
    ), '[]'::json)`;
  }

  /**
   * The CTEs that write a flow from one jsonb parameter into the owner a preceding CTE names
   * (`ownerCte`, whose `id` goes in `ownerColumn`). Phases and stages take their order from
   * their position in the arrays.
   */
  #publishCtes(phasesParam, ownerCte = 'created_version', ownerColumn = 'workflow_version_id') {
    return `phase_input as (
        select p.ord::int as seq, p.value->>'name' as name, p.value->'stages' as stages
        from jsonb_array_elements(${phasesParam}::jsonb) with ordinality as p(value, ord)
      ),
      phases_inserted as (
        insert into flow_phases (${ownerColumn}, seq, name)
        select ${ownerCte}.id, pi.seq, pi.name
        from ${ownerCte}, phase_input pi
        returning id, seq
      ),
      stages_inserted as (
        insert into flow_stages (
          phase_id, seq, area_id, title, default_assignee_id, input_keys, output_keys,
          input_note, output_note, estimated_days
        )
        select
          ph.id, s.ord::int, (s.value->>'areaId')::bigint, s.value->>'title',
          (s.value->>'defaultAssigneeId')::bigint, s.value->'inputs', s.value->'outputs',
          s.value->>'inputNote', s.value->>'outputNote', (s.value->>'estimatedDays')::int
        from phase_input pi
        join phases_inserted ph on ph.seq = pi.seq
        cross join lateral jsonb_array_elements(pi.stages) with ordinality as s(value, ord)
        returning id
      )`;
  }

  /**
   * A template and its version 1, phases and stages included, in one statement. `phases`
   * is the array orchestration normalised: `[{name, stages: [{areaId, title, ...}]}]`.
   */
  async createWorkflow({ code, name, phases, publishedBy = null }) {
    const [row] = await this.#rows(
      `with created as (
        insert into workflows (code, name) values ($1, $2)
        returning *
      ),
      created_version as (
        insert into workflow_versions (workflow_id, version, published_by)
        select created.id, 1, $4::bigint from created
        returning *
      ),
      ${this.#publishCtes('$3')}
      select
        created.*, v.id as workflow_version_id, v.version, v.published_at, v.published_by,
        (select count(*) from phases_inserted)::int as phase_count,
        (select count(*) from stages_inserted)::int as stage_count
      from created, created_version v`,
      [code, name, JSON.stringify(phases), publishedBy],
    );
    return row;
  }

  /**
   * Publishes the next version of a template. Nothing already published is touched: the
   * new content is a new version, numbered `max + 1`, so two publishers racing collide on
   * `uq_workflow_versions_version` rather than on each other.
   */
  async publishWorkflowVersion(workflowId, { phases, publishedBy = null }) {
    const [row] = await this.#rows(
      `with created_version as (
        insert into workflow_versions (workflow_id, version, published_by)
        select $1, coalesce(max(version), 0) + 1, $3::bigint
        from workflow_versions
        where workflow_id = $1
        returning *
      ),
      ${this.#publishCtes('$2')}
      select
        v.*,
        (select count(*) from phases_inserted)::int as phase_count,
        (select count(*) from stages_inserted)::int as stage_count
      from created_version v`,
      [workflowId, JSON.stringify(phases), publishedBy],
    );
    return row;
  }

  /**
   * A new template whose version 1 copies the LATEST version of the source, in one statement.
   * A default person who is no longer an active member of the stage's area is dropped from
   * the copy rather than failing it. `null` when the source does not exist or has no version.
   */
  async cloneWorkflow(sourceId, { code, name, publishedBy = null }) {
    const [row] = await this.#rows(
      `with source as (
        select id from workflow_versions
        where workflow_id = $1
        order by version desc
        limit 1
      ),
      created as (
        insert into workflows (code, name)
        select $2, $3 from source
        returning *
      ),
      created_version as (
        insert into workflow_versions (workflow_id, version, published_by)
        select created.id, 1, $4::bigint from created
        returning *
      ),
      source_phases as (
        select fp.* from flow_phases fp, source where fp.workflow_version_id = source.id
      ),
      phases_inserted as (
        insert into flow_phases (workflow_version_id, seq, name)
        select created_version.id, sp.seq, sp.name
        from created_version, source_phases sp
        returning id, seq
      ),
      stages_inserted as (
        insert into flow_stages (
          phase_id, seq, area_id, title, default_assignee_id, input_keys, output_keys,
          input_note, output_note, estimated_days
        )
        select
          ph.id, fs.seq, fs.area_id, fs.title,
          case when exists (
            select 1 from area_members m
            join users u on u.id = m.user_id
            where m.area_id = fs.area_id and m.user_id = fs.default_assignee_id
              and u.deleted_at is null
          ) then fs.default_assignee_id end,
          fs.input_keys, fs.output_keys, fs.input_note, fs.output_note, fs.estimated_days
        from source_phases sp
        join phases_inserted ph on ph.seq = sp.seq
        join flow_stages fs on fs.phase_id = sp.id
        returning id
      )
      select
        created.*, v.id as workflow_version_id, v.version, v.published_at, v.published_by,
        (select count(*) from phases_inserted)::int as phase_count,
        (select count(*) from stages_inserted)::int as stage_count
      from created, created_version v`,
      [sourceId, code, name, publishedBy],
    );
    return row ?? null;
  }

  /** Every template with a summary of its latest version, by name. */
  async listWorkflows() {
    return this.#rows(
      `select
        w.*, v.id as workflow_version_id, v.version, v.published_at, v.published_by,
        pu.full_name as published_by_name,
        (select count(*) from flow_phases fp
          where fp.workflow_version_id = v.id)::int as phase_count,
        (select count(*) from flow_phases fp join flow_stages fs on fs.phase_id = fp.id
          where fp.workflow_version_id = v.id)::int as stage_count
      from workflows w
      left join lateral (
        select * from workflow_versions
        where workflow_id = w.id
        order by version desc
        limit 1
      ) v on true
      left join users pu on pu.id = v.published_by
      order by w.name, w.id`,
    );
  }

  /** One template with its latest version's phases and stages. */
  async getWorkflow(workflowId) {
    const [row] = await this.#rows(
      `select
        w.*, v.id as workflow_version_id, v.version, v.published_at, v.published_by,
        pu.full_name as published_by_name,
        ${this.#phasesJson('v.id')} as phases
      from workflows w
      left join lateral (
        select * from workflow_versions
        where workflow_id = w.id
        order by version desc
        limit 1
      ) v on true
      left join users pu on pu.id = v.published_by
      where w.id = $1`,
      [workflowId],
    );
    return row ?? null;
  }

  /** Every version of a template, newest first, without their content. */
  async listWorkflowVersions(workflowId) {
    return this.#rows(
      `select
        v.*, pu.full_name as published_by_name,
        (select count(*) from flow_phases fp
          where fp.workflow_version_id = v.id)::int as phase_count,
        (select count(*) from flow_phases fp join flow_stages fs on fs.phase_id = fp.id
          where fp.workflow_version_id = v.id)::int as stage_count
      from workflow_versions v
      left join users pu on pu.id = v.published_by
      where v.workflow_id = $1
      order by v.version desc`,
      [workflowId],
    );
  }

  /** One version, whichever it is, with its template's identity and its content. */
  async getWorkflowVersion(versionId) {
    const [row] = await this.#rows(
      `select
        v.*, w.code, w.name, w.is_active, pu.full_name as published_by_name,
        ${this.#phasesJson('v.id')} as phases
      from workflow_versions v
      join workflows w on w.id = v.workflow_id
      left join users pu on pu.id = v.published_by
      where v.id = $1`,
      [versionId],
    );
    return row ?? null;
  }

  /** Only `name` and `is_active` change; the code is what a clone or a project named. */
  async updateWorkflow(workflowId, { name = null, isActive = null }) {
    const [row] = await this.#rows(
      `update workflows
        set name = coalesce($2, name),
            is_active = coalesce($3::boolean, is_active)
      where id = $1
      returning *`,
      [workflowId, name, isActive],
    );
    return row ?? null;
  }

  /** Deactivates a template; its versions stay readable. */
  async deactivateWorkflow(workflowId) {
    const [row] = await this.#rows(
      `update workflows set is_active = false where id = $1 returning *`,
      [workflowId],
    );
    return row ?? null;
  }

  /**
   * Replaces a request's whole flow in one statement: its old phases go (their stages
   * cascade) and the new ones come either from `phases` -- a flow designed for it, in the
   * template shape -- or from a copy of the template version `sourceVersionId`, whose id is
   * recorded in `requests.workflow_version_id`. Only an unconverted, live request is touched;
   * `found` says whether it was.
   */
  async setRequestFlow(requestId, { phases = null, sourceVersionId = null }) {
    const fromTemplate = sourceVersionId !== null;
    const version = fromTemplate ? '$2' : '$3';
    const [row] = await this.#rows(
      `with target as (
        select id from requests
        where id = $1 and deleted_at is null and project_id is null
      ),
      cleared as (
        delete from flow_phases where request_id = (select id from target)
        returning id
      ),
      recorded as (
        update requests set workflow_version_id = ${version}::bigint
        where id = (select id from target)
        returning id
      ),
      -- A data-modifying CTE nobody reads runs after the main query, so the new phases would be
      -- inserted before the old ones are deleted and collide on (request_id, seq). Reading
      -- \`cleared\` here makes the delete run first.
      ready as (
        select target.id from target where (select count(*) from cleared) >= 0
      ),
      ${fromTemplate
        ? `source_phases as (
        select fp.* from flow_phases fp where fp.workflow_version_id = ${version}::bigint
      ),
      phases_inserted as (
        insert into flow_phases (request_id, seq, name)
        select ready.id, sp.seq, sp.name
        from ready, source_phases sp
        returning id, seq
      ),
      stages_inserted as (
        insert into flow_stages (
          phase_id, seq, area_id, title, default_assignee_id, input_keys, output_keys,
          input_note, output_note, estimated_days
        )
        select
          ph.id, fs.seq, fs.area_id, fs.title, fs.default_assignee_id, fs.input_keys,
          fs.output_keys, fs.input_note, fs.output_note, fs.estimated_days
        from source_phases sp
        join phases_inserted ph on ph.seq = sp.seq
        join flow_stages fs on fs.phase_id = sp.id
        returning id
      )`
        : this.#publishCtes('$2', 'ready', 'request_id')}
      select
        (select count(*) from target)::int as found,
        (select count(*) from phases_inserted)::int as phase_count,
        (select count(*) from stages_inserted)::int as stage_count`,
      fromTemplate
        ? [requestId, sourceVersionId]
        : [requestId, JSON.stringify(phases), null],
    );
    return row;
  }

  /** Removes a request's flow; `workflow_version_id` goes with it. */
  async clearRequestFlow(requestId) {
    const [row] = await this.#rows(
      `with cleared as (
        delete from flow_phases where request_id = $1 returning id
      ),
      recorded as (
        update requests set workflow_version_id = null where id = $1 returning id
      )
      select (select count(*) from cleared)::int as phase_count`,
      [requestId],
    );
    return row;
  }

  /**
   * For each of these requests, whether it owns a flow, and the areas of its first phase and
   * of the whole flow. What conversion and the status check need, in one read.
   */
  async getRequestFlowAreas(requestIds) {
    return this.#rows(
      `select
        fp.request_id,
        array_agg(distinct fs.area_id) as area_ids,
        array_agg(distinct fs.area_id) filter (
          where fp.seq = (select min(seq) from flow_phases where request_id = fp.request_id)
        ) as first_phase_area_ids
      from flow_phases fp
      join flow_stages fs on fs.phase_id = fp.id
      where fp.request_id = any(coalesce($1::bigint[], '{}'::bigint[]))
      group by fp.request_id`,
      [this.#idArray(requestIds)],
    );
  }

  /** The one row, with who last saved it, or null when the registration lives in .env. */
  async getMicrosoftApp() {
    const [row] = await this.#rows(
      `select a.*, u.full_name as updated_by_name
         from microsoft_app a
         left join users u on u.id = a.updated_by
        where a.id = 1`,
      [],
    );
    return row ?? null;
  }

  /**
   * Creates or replaces the registration. `clientSecretEnc` null keeps the stored secret,
   * which is how a form that never shows the secret can save the other two fields.
   *
   * @param {{ tenantId: string, clientId: string, clientSecretEnc: Buffer | null,
   *   updatedBy: number | null }} app
   * @returns {Promise<object | null>} The row, or null when there was no secret to keep.
   */
  async setMicrosoftApp({ tenantId, clientId, clientSecretEnc, updatedBy }) {
    const [row] = await this.#rows(
      `insert into microsoft_app (id, tenant_id, client_id, client_secret_enc, updated_by)
       values (1, $1, $2,
               coalesce($3::bytea, (select client_secret_enc from microsoft_app where id = 1)),
               $4::bigint)
       on conflict (id) do update
         set tenant_id         = excluded.tenant_id,
             client_id         = excluded.client_id,
             client_secret_enc = excluded.client_secret_enc,
             updated_at        = current_timestamp,
             updated_by        = excluded.updated_by
       returning *`,
      [tenantId, clientId, clientSecretEnc, updatedBy],
    );
    return row ?? null;
  }

  /** @returns {Promise<object | null>} The row that was removed, or null. */
  async deleteMicrosoftApp() {
    const [row] = await this.#rows(
      `delete from microsoft_app where id = 1 returning *`,
      [],
    );
    return row ?? null;
  }

  /**
   * Records a delegated grant, or replaces the token when this user reconnects the same
   * account. The upsert targets the partial unique index, so a revoked row for the same
   * pair is left as history and a fresh live row is written beside it.
   *
   * @param {{ userId: number, msObjectId: string, tenantId: string, email: string | null,
   *   displayName: string | null, refreshTokenEnc: Buffer, scopes: string }} grant
   * @returns {Promise<object>} The live row.
   */
  async createMicrosoftAccount({
    userId,
    msObjectId,
    tenantId,
    email,
    displayName,
    refreshTokenEnc,
    scopes,
  }) {
    const [row] = await this.#rows(
      `insert into microsoft_accounts
         (user_id, ms_object_id, tenant_id, email, display_name, refresh_token_enc, scopes)
       values ($1, $2, $3, $4::varchar, $5::varchar, $6, $7)
       on conflict (user_id, ms_object_id) where revoked_at is null
       do update set tenant_id         = excluded.tenant_id,
                     email             = excluded.email,
                     display_name      = excluded.display_name,
                     refresh_token_enc = excluded.refresh_token_enc,
                     scopes            = excluded.scopes,
                     connected_at      = current_timestamp
       returning *`,
      [
        userId,
        msObjectId,
        tenantId,
        email,
        displayName,
        refreshTokenEnc,
        scopes,
      ],
    );
    return row;
  }

  /** One account, revoked or not, with its owner's name. */
  async getMicrosoftAccount(accountId) {
    const [row] = await this.#rows(
      `select a.*, u.full_name as user_full_name
         from microsoft_accounts a
         join users u on u.id = a.user_id
        where a.id = $1`,
      [accountId],
    );
    return row ?? null;
  }

  /**
   * Live accounts, everyone's or one person's.
   *
   * @param {number | null} userId Null lists them all.
   */
  async listMicrosoftAccounts(userId = null) {
    return this.#rows(
      `select a.*, u.full_name as user_full_name
         from microsoft_accounts a
         join users u on u.id = a.user_id
        where a.revoked_at is null
          and ($1::bigint is null or a.user_id = $1)
        order by a.connected_at desc, a.id desc`,
      [userId],
    );
  }

  /** Stores the rotated refresh token and stamps the use. */
  async updateMicrosoftRefreshToken(accountId, refreshTokenEnc) {
    const [row] = await this.#rows(
      `update microsoft_accounts
          set refresh_token_enc = $2,
              last_used_at = current_timestamp
        where id = $1 and revoked_at is null
        returning id`,
      [accountId, refreshTokenEnc],
    );
    return row ?? null;
  }

  /** @returns {Promise<object | null>} The row as it was, or null when already revoked. */
  async revokeMicrosoftAccount(accountId) {
    const [row] = await this.#rows(
      `update microsoft_accounts
          set revoked_at = current_timestamp
        where id = $1 and revoked_at is null
        returning *`,
      [accountId],
    );
    return row ?? null;
  }

  /**
   * Registers a workbook. `schema_version_id` and `column_map` are left at their defaults:
   * mapping is a later act (microsoft-accounts migration).
   *
   * @throws {{ code: '23505' }} on uq_sheets_item -- the same table registered twice.
   */
  async createSheet({
    name,
    driveId,
    itemId,
    tableName,
    webUrl,
    microsoftAccountId,
    registeredBy,
  }) {
    const [row] = await this.#rows(
      `insert into sheets
         (name, drive_id, item_id, table_name, web_url, microsoft_account_id, registered_by)
       values ($1, $2, $3, $4::varchar, $5::text, $6, $7::bigint)
       returning *`,
      [
        name,
        driveId,
        itemId,
        tableName,
        webUrl,
        microsoftAccountId,
        registeredBy,
      ],
    );
    return row;
  }

  #sheetSelect = `
    select s.*,
           a.email        as account_email,
           a.display_name as account_display_name,
           a.revoked_at   as account_revoked_at,
           u.full_name    as registered_by_name,
           -- Cuántas filas se marcaron como ya vistas sin importarlas: una pantalla que ofrece
           -- deshacerlo tiene que poder decir cuántas son.
           (select count(*)::int from sheet_row_marks m where m.sheet_id = s.id) as marked_rows
      from sheets s
      join microsoft_accounts a on a.id = s.microsoft_account_id
      left join users u on u.id = s.registered_by`;

  async listSheets() {
    return this.#rows(
      `${this.#sheetSelect}
        where s.deleted_at is null
        order by s.created_at desc, s.id desc`,
      [],
    );
  }

  async getSheet(sheetId) {
    const [row] = await this.#rows(
      `${this.#sheetSelect}
        where s.id = $1 and s.deleted_at is null`,
      [sheetId],
    );
    return row ?? null;
  }

  /** Soft delete. Returns the row as it was, or null when there was no live row. */
  async deleteSheet(sheetId) {
    const [row] = await this.#rows(
      `update sheets
          set deleted_at = current_timestamp
        where id = $1 and deleted_at is null
        returning *`,
      [sheetId],
    );
    return row ?? null;
  }
}

export default new Query();
