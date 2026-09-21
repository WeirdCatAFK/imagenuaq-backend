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

  // --- Health ---

  async ping() {
    const [row] = await this.#rows("select 1 as ok");
    return row?.ok === 1;
  }

  // --- Auth ---

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

  // --- Users ---

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
    // The ::bigint casts are required; Postgres cannot infer $5's type from `is not null`.
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
   * The bump belongs here rather than in a second call: between two statements there is a
   * window where the account is gone and its token still works, which is the exact hole
   * this column was added to close.
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
  // --- User Helpers ---

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
  // --- Audit trail (RF-USR-07) ---

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

  // --- Areas ---

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
    // The ::bigint casts are required; Postgres cannot infer a type from `is not null`.
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

  // --- Area Helpers ---

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

  // --- Area hierarchy (RF-USR-09, RF-USR-04) ---

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

  // --- Roles & Permissions ---

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

  // --- Role & Permission helpers ---

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
      // coalesce is repeated rather than hoisted: `<> all (select ...)` would compare
      // bigint to bigint[].
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

  //--- DATA TYPES ---

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

  //--- SCHEMAS ---

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
    //Asegura que la función responda con null en lugar de undefined
    //Ejemplo: si falla el filtro del JOIN.
    return row ?? null;
  }

  /* READ - Obtiene TODOS los schemas con sus más recientes/últimas versiones*/
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
   *
   * Las versiones publicadas NO son modificadas.
   * En lugar de eso, el siguiente numero versión es creado con los nuevos campos
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
   *
   * No elimina fisicamente el registro.
   * Se conserva el schema y sus versiones, pero
   * is_active pasa a false
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

  /** The newest version of a schema, or null. Used wherever "the schema" means its current shape. */
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

  // --- Microsoft app registration (RF-MIG-01) ---

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
      // The stored secret is folded in BEFORE the insert is attempted: NOT NULL is checked
      // on the proposed row, ahead of ON CONFLICT, so a coalesce in the DO UPDATE never runs.
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

  // --- Microsoft accounts (RF-MIG-01) ---

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

  // --- Sheets (RF-MIG-01, RF-MIG-02) ---

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
           u.full_name    as registered_by_name
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
