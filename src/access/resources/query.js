import { getStore } from "../primitives/database.js";

class Query {
  async #rows(sql, params) {
    const result = await getStore().query(sql, { params, objectRows: true });
    return result.rows ?? [];
  }

  // postgrejs serialises an EMPTY JavaScript array as '' rather than '{}', and Postgres
  // rejects that with 22P02, "malformed array literal". An empty set is not an edge case
  // here -- it is how a role's last permission is revoked -- so every array parameter goes
  // through this, and the SQL that receives it wraps the cast in
  // coalesce($n::bigint[], '{}'::bigint[]) to turn the null back into the empty array.
  //
  // Fixing it at the driver boundary rather than in each caller: an `if (ids.length)` in
  // orchestration reads like a performance shortcut, and the day somebody removes it as one
  // the failure is a 500 on the revoke path only.
  #idArray(ids) {
    return ids.length ? ids : null;
  }

  // --- Health ---

  async ping() {
    const [row] = await this.#rows("select 1 as ok");
    return row?.ok === 1;
  }

  async serverVersion() {
    const [row] = await this.#rows("select version() as version");
    return row?.version ?? null;
  }

  // --- Auth ---
  //
  // Parameters are positional ($1, $2) in an array, never `:named` in an object: postgrejs
  // calls .map() on options.params, so an object throws "params?.map is not a function" at
  // runtime rather than at parse time. Nothing else in the codebase takes parameters yet,
  // so this is the note that saves the next resource an hour.

  // One row with everything a session needs, so authenticating is a single round trip
  // rather than a login lookup followed by a role lookup. The join is to `roles` and not
  // just `role_id` because the token carries the role *name*: an integer id in a JWT is
  // meaningless to the frontend and would have to be resolved on every request anyway.
  //
  // `deleted_at is null` matters here more than anywhere else. Users are soft-deleted
  // (that is what the partial index `uq_users_email_live` is for -- a freed address can be
  // reused), so without this predicate a removed employee keeps logging in, and a reused
  // address can match two rows.
  async getAuthUserByEmail(email) {
    const [row] = await this.#rows(
      `select u.id,
              u.email,
              u.full_name,
              u.password_hash,
              u.role_id,
              u.primary_area_id,
              r.name as role_name
         from users u
         join roles r on r.id = u.role_id
        where u.email = $1
          and u.deleted_at is null`,
      [email],
    );
    return row ?? null;
  }

  // `returning id` rather than a rowcount: the same statement then reports whether the
  // user existed and was live, so the caller can tell "wrong id" from "wrote nothing"
  // without a second select.
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

  // Same columns as getAuthUserByEmail, keyed by id. Used by the invite flow, which knows
  // the user id from the token and must still re-read `password_hash` and `deleted_at`
  // live -- an invite token minted a week ago says nothing about the row's state now.
  async getAuthUserById(userId) {
    const [row] = await this.#rows(
      `select u.id,
              u.email,
              u.full_name,
              u.password_hash,
              u.role_id,
              u.primary_area_id,
              r.name as role_name
         from users u
         join roles r on r.id = u.role_id
        where u.id = $1
          and u.deleted_at is null`,
      [userId],
    );
    return row ?? null;
  }

  // Permission *codes*, not ids. `permissions.code` is the stable machine name the rest
  // of the code compares against; the surrogate id is an implementation detail of the
  // join table and would make every call site do another lookup.
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

  // Creates the user and, when an area is given, their membership of it -- in ONE
  // statement. area_members is not redundant with users.primary_area_id: DATAMODEL.md
  // §5.2 moved area leadership there precisely because somebody can lead one area and be
  // a member of another, and the RF-USR-03 / RF-TSK-06 visibility queries read
  // area_members. A user created without a row there is invisible to their own colleagues.
  //
  // A CTE rather than two calls inside a transaction: a data-modifying CTE is atomic on
  // its own, so this cannot half-succeed, and it keeps the tier boundary intact -- opening
  // a transaction would mean handing a connection up to orchestration, which is exactly
  // what `query.js` exists to prevent.
  //
  // No password_hash. A user is created without one and reaches it through the invite
  // flow, so the account cannot be logged into before its owner chooses a secret. That is
  // also what makes an invite single-use: see completeInvite() in orchestration/auth.js.
  async createUser({
    email,
    fullName,
    roleId,
    contractTypeId,
    primaryAreaId = null,
    birthday = null,
    isAreaLeader = false,
  }) {
    // The casts are load-bearing, not decoration. Postgres infers a parameter's type from
    // its first use, and `$5 is not null` in the second CTE gives it nothing to work with;
    // without ::bigint it fails with "could not determine data type of parameter $5".
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
  async getUser(userId) {
    const [row] = await this.#rows(
      `select * from users where id = $1 and deleted_at is null`,
      [userId],
    );
    return row ?? null;
  }
  // Every column in one statement, and every one of them mandatory in the argument: a
  // partial update built by concatenating whichever keys the caller sent would put string
  // interpolation back into the SQL, which is the one thing this module exists to prevent.
  // Orchestration reads the row first and passes the merged values -- see Users.update().
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
  async deleteUser(userId) {
    const [row] = await this.#rows(
      `update users set deleted_at = now()
        where id = $1 and deleted_at is null
        returning *`,
      [userId],
    );
    return row ?? null;
  }
  // --- User Helpers ---

  // pictureBinary higher level  handles that picture is resized at 256x256 and converted to PNG before calling this function.
  async updateProfilePicture(userId, pictureBinary) {
    const [row] = await this.#rows(
      `update users set profile_picture = $2
        where id = $1 and deleted_at is null
        returning *`,
      [userId, pictureBinary],
    );
    return row ?? null;
  }
  async getUserProfilePicture(userId) {
    const [row] = await this.#rows(
      `select profile_picture from users where id = $1 and deleted_at is null`,
      [userId],
    );
    return row?.profile_picture ?? null;
  }
  async getUserEmailById(userId) {
    const [row] = await this.#rows(
      `select email from users where id = $1 and deleted_at is null`,
      [userId],
    );
    return row?.email ?? null;
  }
  async getUserIdByEmail(email) {
    const [row] = await this.#rows(
      `select id from users where email = $1 and deleted_at is null`,
      [email],
    );
    return row?.id ?? null;
  }

  // The tree search functions have to be a parameter on the api caller to select the type of search.
  // This way each search doesn't get unupdated data from previous searches
  async searchUsersByEmail(email, length = 50) {
    const rows = await this.#rows(
      `select id, email, full_name from users
        where lower(email) like lower($1)
          and deleted_at is null
        order by email
        limit $2`,
      [`%${email}%`, length],
    );
    return rows;
  }
  async searchUsersByFullName(fullName, length = 50) {
    const rows = await this.#rows(
      `select id, email, full_name from users
        where lower(full_name) like lower($1)
          and deleted_at is null
        order by full_name
        limit $2`,
      [`%${fullName}%`, length],
    );
    return rows;
  }
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

  // Catalog lookups for scripts/createAdmin.js, which accepts either an id or a name --
  // ids come from a sequence and differ per database, so an operator recovering a lockout
  // cannot be expected to know them. One statement handles both: the id branch is taken
  // only when the reference parses as a positive integer, which `$1::bigint is not null`
  // expresses without the caller sending two different queries.
  //
  // These live here rather than as raw SQL in the script because query.js is the only
  // module that writes SQL, and a recovery path is the worst possible place to make an
  // exception to that -- it is the code that runs when everything else has already failed.
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

  // The fallback when no contract type was named. contract_type_id is NOT NULL and there
  // is no defensible invented default, so the script picks the first and reports it.
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

  // Used only by scripts/createAdmin.js, to report what the recovery it just performed
  // changed. Live rows only: a soft-deleted admin cannot log in and must not be counted
  // as one.
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

  // Role change and password reset in one statement, for the lockout recovery in
  // scripts/createAdmin.js. Deliberately NOT exposed through the API: promoting somebody
  // to admin over HTTP is the one operation whose only safe gate is database access.
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

  // The action catalogue keyed by code. `actions.code` is the stable machine name, the id is
  // whatever the sequence handed out on this machine -- the same reason permissions are
  // compared by code. Read as a whole and cached by the caller rather than looked up per
  // write: the catalogue is thirteen rows seeded by a migration, and a lookup per logged
  // action would double the number of round trips the audit trail costs.
  async getActions() {
    const rows = await this.#rows("select id, code, label from actions order by code");
    return rows;
  }

  // One row of the trail. `target_table` and `target_id` travel together or not at all --
  // `logs_target_complete` enforces `num_nonnulls(...) IN (0, 2)`, because one of the two
  // is always a mistake while zero is legitimate: `user_login` has no object.
  //
  // The casts are load-bearing. `$4` and `$5` are the target pair and are null for the
  // objectless actions, and `$6`/`$7` are jsonb that arrives as a JavaScript object;
  // without them Postgres cannot infer a type for a bare null parameter and fails the
  // statement rather than the row.
  // `area_id` is resolved by the statement, not by the caller. The obvious source is the
  // session -- the JWT could carry the area and it would cost nothing to read -- and it is
  // the wrong one: a token lives seven days and nothing re-reads the database on a verified
  // one, so somebody moved between areas keeps stamping the old area onto the trail for the
  // rest of the week. A trail that is confidently wrong about history is worse than one that
  // is silent about it.
  //
  // The subquery is the fix and it is free: the row is being inserted anyway, so resolving
  // the area inside the same statement adds no round trip and always reads the current
  // value. There is deliberately no override parameter -- one source means the trail cannot
  // disagree with itself depending on which call site wrote the row.
  //
  // A null `user_id` -- a failed login on an address that matches no account -- resolves to
  // a null area, which is correct: there is nobody to have an area.
  //
  // Deliberately NOT filtered on `deleted_at`: a soft-deleted user's actions still happened,
  // and belonged to an area when they did.
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

  // The trail for one object, newest first. `idx_logs_target` is the partial index this
  // rides -- (target_table, target_id) WHERE target_table IS NOT NULL -- so the objectless
  // rows do not bloat it.
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

  // What one area did, newest first. This is the read RF-USR-04 is written in -- a
  // responsable de área consulting the work of everyone under them -- and the reason
  // logs.area_id exists at all rather than being derived from area_members at read time.
  //
  // Rides idx_logs_area_id, which is (area_id, created_at DESC) partial on area_id NOT NULL:
  // the same order this query asks for, so the sort is the index walk.
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

  // The area and its first leader in ONE statement, for the same reason createUser() puts
  // the membership in a CTE: a two-call version that fails on the second call leaves an
  // area nobody is responsible for, and orchestration would have to delete it again from a
  // catch block -- cleanup that is itself allowed to fail.
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

  // A hard delete, not a soft one: `areas` has no deleted_at, because every foreign key
  // into it is NO ACTION and a referenced row therefore cannot be deleted at all. The 23503
  // that comes back when people are still assigned IS the refusal -- orchestration turns it
  // into a 409 rather than pre-flighting a count another session can invalidate.
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

  async getAreaDescriptionById(areaId) {
    const [row] = await this.#rows(
      "select description from areas where id = $1",
      [areaId],
    );
    return row?.description ?? null;
  }

  // Upsert, not insert. Promoting an existing member to leader and adding a new leader are
  // the same intent expressed twice, and the unique index on (user_id, area_id) makes the
  // insert-only version fail on the first of them.
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

  // A user can be in multiple areas -- RF-USR-03, and the reason schema-proofing moved
  // leadership here from areas.lead_user_id.
  async getAreaMemberships(userId, areaId = null) {
    const rows = await this.#rows(
      `select area_id, is_area_leader
         from area_members
        where user_id = $1
          and ($2::bigint is null or area_id = $2::bigint)`,
      [userId, areaId],
    );
    return rows;
  }

  // The same relation as getAreaMemberships, joined out to the areas themselves. Two
  // methods because the callers differ: an authorisation check wants the ids and nothing
  // else, a profile page wants the names, and making the hot caller pay for the join is
  // how an authorisation check gets slow.
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

  // Leaders first, then alphabetical: the first row is who to ask about this area, which
  // is what both the org chart node and a task-assignment screen want at the top.
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

  // Every member of a SET of areas, for the organisation chart. One statement rather than
  // getAreaMembers() per node: drawing the whole organisation is then one query for the
  // tree and one for the people in it, not one plus N.
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

  // Upsert on the child, because the child is the whole primary key: an area has at most
  // one parent, so "move this area under that one" must overwrite rather than add a second
  // line of authority. See the migration for why the key is shaped that way.
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

  // Is `candidateId` somewhere below `ancestorId`? The cycle guard for setAreaParent():
  // hanging an area under one of its own descendants closes a loop that no CHECK can see,
  // and that the read path can then only survive rather than report.
  //
  // The CYCLE clause is on this walk too, not only on the reader below. If the table is
  // ALREADY corrupt, the check whose job is to catch corruption must not be the thing that
  // hangs.
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

  // The organisation chart's spine: one row per area, with its parent and its depth.
  //
  // A null `rootAreaId` walks the whole forest, anchored on every area that has no parent
  // row. An id walks that subtree only, which is the shape RF-USR-04's "todos los usuarios
  // a su cargo" asks for.
  //
  // `depth` is computed rather than stored -- see the migration for why a `level` column
  // was rejected. The CYCLE clause is the seatbelt: a loop written straight into the table
  // through psql marks the repeated row and stops recursing, so a corrupt hierarchy costs
  // one truncated branch instead of a request that never returns. Those rows are dropped
  // rather than returned: a repeat of a node already in the chart is not another node.
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

  // The role's users are not reassigned on the way out, and cannot be: users.role_id is
  // NOT NULL and there is no defensible default to move them to -- choosing one would
  // silently grant or revoke access on somebody else's behalf. Orchestration counts the
  // holders and refuses; the foreign key is the backstop when it does not.
  async deleteRole(roleId) {
    const [row] = await this.#rows(
      `delete from roles
        where id = $1
        returning id, name, description`,
      [roleId],
    );
    return row ?? null;
  }

  // Live rows only: a soft-deleted user cannot log in, so holding a role is not a reason to
  // keep that role alive.
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

  // role_permissions cascades from here, so deleting a permission revokes it everywhere
  // rather than leaving grants pointing at nothing. That is the migration's decision, not
  // this method's; what makes it survivable is that a code is only ever compared by
  // requirePermission(), which fails closed on one nobody holds.
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

  // One role's grants, as full rows. getRolePermissionCodes() above returns codes only,
  // because codes are all requirePermission() compares; an administration screen needs the
  // labels to show a human what it is about to revoke.
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

  // null when the grant was already there. The caller asked for it to be granted and it is,
  // so that is not a failure -- it is the difference between a 201 and a 200.
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

  // Replace a role's whole grant set. One data-modifying CTE and not a delete followed by
  // an insert, because between those two calls the role holds NOTHING: a request landing in
  // that window is refused by requirePermission() for a reason that has nothing to do with
  // it, and if the insert then fails the role stays stripped.
  //
  // The revoke arm is `<> all(...)` rather than an unconditional delete, so a grant that
  // survives the edit is never actually removed and re-added. That matters the day
  // role_permissions grows a granted_at column.
  //
  // Returns what the requested ids resolve to. Fewer rows than ids means one of them names
  // no permission; orchestration compares the two lengths and refuses.
  async setRolePermissions(roleId, permissionIds) {
    const rows = await this.#rows(
      // The coalesce is spelled out three times rather than hoisted into a CTE: `<> all
      // (select ids from wanted)` parses as ALL(subquery), whose rows are of type bigint[],
      // and fails with "operator does not exist: bigint <> bigint[]". Repetition is the
      // cheaper of the two confusions.
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

  async getUserRoleIdById(userId) {
    const [row] = await this.#rows(
      `select role_id from users where id = $1 and deleted_at is null`,
      [userId],
    );
    return row?.role_id ?? null;
  }

  // Plural, and it has to be. An earlier draft destructured the first row and returned one
  // code, which reads as "this user holds exactly one permission" -- a check against it
  // fails closed, so nothing would have reported the mistake.
  async getUserPermissionCodesById(userId) {
    const rows = await this.#rows(
      `select p.code
         from users u
         join role_permissions rp on rp.role_id = u.role_id
         join permissions p on p.id = rp.permission_id
        where u.id = $1 and u.deleted_at is null
        order by p.code`,
      [userId],
    );
    return rows.map((row) => row.code);
  }
}

export default new Query();
