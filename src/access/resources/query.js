import { getStore } from "../primitives/database.js";

class Query {
  async #rows(sql, params) {
    const result = await getStore().query(sql, { params, objectRows: true });
    return result.rows ?? [];
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
      [email, fullName, roleId, contractTypeId, primaryAreaId, birthday, isAreaLeader],
    );
    return row;
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
      'select id, name from contract_types order by id limit 1',
    );
    return row ?? null;
  }

  async getRoleIdByName(name) {
    const [row] = await this.#rows('select id from roles where name = $1', [name]);
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

}

export default new Query();
