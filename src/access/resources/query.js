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
  async countUsers({ areaId = null, roleId = null, includeDeleted = false } = {}) {
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
    const rows = await this.#rows("select id, code, label from actions order by code");
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

  async createArea({ name, description }) {
    const [row] = await this.#rows(
      `insert into areas (name, description)
        values ($1, $2)
        returning id, name, description`,
      [name, description],
    );
    return row;
  }

  /** Creates an area and its first leader in one statement, so neither can be orphaned. */
  async createAreaWithLeader({ name, description, userId }) {
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
       )
       select id, name, description from created`,
      [name, description, userId],
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

}

export default new Query();
