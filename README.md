# imagenuaq-backend

Setup

```bash
npm install
cp .env.example .env          # set DATABASE_URL
docker compose up -d db       # Postgres on the port in .env
npm run migrate:up            # apply migrations
npm run dev                   # node --watch
npm test                      # see Tests below
```

## Layout

```
main.js                  entry point: opens the pool, starts the API, shuts both down
migrations/              one file per schema change; commit these
dbml/                    one committed snapshot per migration, plus current.dbml
scripts/genDBML.js       writes dbml/ from the live schema (npm run dbml)
src/
  api.js                 Api class: builds the app, mounts ROUTERS under /api/, start/stop
  swagger.js             the OpenAPI 3.1 document, hand-written
  routes/                one file per resource, thin: parse the request, call orchestration
  access/                everything that reads or writes data
    orchestration/       business rules per domain
    resources/query.js   the only module that writes SQL
    primitives/          connection pool, content store
  middlewares/           notFound, errorHandler
  utils/ApiError.js      typed HTTP errors
```

`access/` is tiered: orchestration -> resources -> primitives, and a module only imports
from tiers below it — see [src/access/ACCESS.md](src/access/ACCESS.md). All SQL lives in
`resources/query.js`, so a schema change has one file to visit.

Express 5 forwards rejections from `async` handlers to the error handler, so routes can
throw `ApiError` directly instead of being wrapped.

## Database

- **postgrejs** owns runtime queries. The pool is built in
  `access/primitives/database.js` and used only by `resources/query.js`. Reads pass
  `objectRows: true` — postgrejs returns arrays of values otherwise.
- **node-pg-migrate** owns the schema. It is a devDependency and never loads at
  runtime: a CLI that applies the files in `migrations/` and records what it applied in
  a `pgmigrations` table. Migrations are plain SQL with `-- Up Migration` and
  `-- Down Migration` markers, so what runs against the database is what you wrote.
  There is no schema file to keep in sync — the migrations *are* the schema history,
  and `DATAMODEL.md` is where the resulting model is described.

| Command                    | What it does                                              |
| -------------------------- | --------------------------------------------------------- |
| `npm run migrate:new`    | Create a timestamped`.sql` migration in `migrations/` |
| `npm run migrate:up`     | Apply every pending migration, then refresh the DBML      |
| `npm run migrate:down`   | Roll back the last applied migration, then refresh it     |
| `npm run migrate:redo`   | Roll the last one back and re-apply it                    |
| `npm run migrate:status` | Print the SQL that`migrate:up` would run, run nothing   |
| `npm run dbml`           | Refresh`dbml/` by hand — the migrate commands call it  |

Defaults worth knowing, all on unless you turn them off: every pending migration runs
inside a **single transaction**, so a failure half way leaves nothing behind; an
**advisory lock** stops two processes migrating at once; and `--check-order` refuses to
run if someone commits a migration dated earlier than one already applied.

Workflow: `npm run migrate:new -- add-something` (spaces and underscores in the name are
normalised to dashes), write the up and down SQL in the generated file, `npm run migrate:up`, commit the file, then write the queries that use it in `resources/query.js`.

### Schema snapshots

`migrate:up`, `:down` and `:redo` each run `npm run dbml` afterwards (npm `post` hooks, so
they fire only when the migration actually succeeded). That reads the live schema and writes
it twice:

- **`dbml/<migration>.dbml`** — the schema as of that migration, sharing the basename of the
  `.sql` that produced it. `migrations/1788369848184_initial-schema.sql` pairs with
  `dbml/1788369848184_initial-schema.dbml`, and the two directories sort alike.
- **`dbml/current.dbml`** — a copy of the newest one under a stable name, so ChartDB and any
  bookmark always point at the latest schema.

The snapshot is [DBML](https://dbml.dbdiagram.io/): tables, columns, types, defaults, keys,
indexes, foreign keys, and the `COMMENT ON` text as `Note:`. To see what a migration did to
the schema, diff its snapshot against the one before it — no need to replay anything:

```bash
git diff --no-index dbml/1788369848184_initial-schema.dbml dbml/1788380071225_update-wording-daysoff.dbml
```

The file the migration lands on is rewritten every time, so rolling back and re-applying is
idempotent. If a snapshot already exists and does not match the live schema, the generator
warns and overwrites: that means an already-applied migration was edited, or the database
drifted from its own history.

None of these files are edited by hand. They are read out of the database, so the next
migration overwrites anything you write; the schema is changed in `migrations/` and nowhere
else. Commit the snapshot alongside the migration and the schema change is reviewable in the
PR. `.gitattributes` pins them to LF — they are compared byte for byte, and a CRLF rewrite
would read as drift on every fresh clone.

The snapshot drops `pgmigrations` on purpose — it is node-pg-migrate's ledger, not part of
the data model. One thing DBML genuinely cannot express is a **partial** index: the
`WHERE area_id IS NOT NULL` predicate on `event_participants`'s two unique indexes is lost,
and they read as plain unique indexes.

To view it: open [ChartDB](https://chart.weirdcat.uk/) and use **Import DBML** with
`dbml/current.dbml`. ChartDB is a static frontend — it keeps diagrams in the browser's
IndexedDB and exposes no API, so the import is manual by necessity and a `/diagrams/<id>`
URL only opens in the browser that created it. Nothing here can push to the instance.

Working loop: sketch the change in ChartDB, export DBML from it to read the shape you want,
hand-write the migration SQL, `npm run migrate:up`. Nothing applies a diagram back to the
database — the migration is always written by a person.

#### Why the output is written for an older DBML

We render with `@dbml/core` 10, but ChartDB bundles 3.14, and its parser rejects three things
the newer renderer emits — a snapshot containing any of them is valid DBML that fails on
import with a syntax error. `downgradeForChartDB()` in `scripts/genDBML.js` rewrites all three:

- **`Checks { … }` blocks** become `CHECK <name>: <expression>` lines in the table's note, so
  `event_participants`'s `num_nonnulls(area_id, user_id) = 1` is still on the diagram.
- **Inline `check:` column attributes** get the same treatment. A CHECK over one column takes
  a different route out of the connector than a multi-column one — it arrives on the column in
  `schema.tableConstraints` rather than in `schema.checks` — and renders inline, so both
  sources are drained into the same note. `files`'s `hash ~ '^[0-9a-f]{64}$'` is one of these.
- **`?<?` / `<?` relationship operators** become plain `<`. The `?` marks an optional side;
  whether the column is nullable is already on the column as `not null`, so nothing is lost.

The generator then parses its own output with `@dbml/core-chartdb` — an npm alias for the
exact 3.14.1 ChartDB ships — and fails the migration instead of writing a file that will not
import. If ChartDB upgrades its parser, bump that alias in `package.json`; if it starts
emitting something else 3.14 cannot read, the error names the line and points at
`downgradeForChartDB()`.

## File storage

`access/primitives/storage.js` is a content-addressed store spread over several
mounted disks. The arrangement is inverted from the obvious one: **Postgres is the
filesystem, and the disks are a dumb bag of bytes keyed by SHA-256.** Identity is the
content; the path is metadata on a row. The two axes then move independently — renaming a
folder is one row update and nothing on disk moves, and draining a dying disk copies bytes
without changing any path.

```
<mount>/.imagenuaq-volume   {"label":"main"} — verified at startup
<mount>/tmp/                in-flight uploads; same filesystem, so rename(2) is atomic
<mount>/content/ab/cd/<hash>  64 hex chars. No extension. No filename.
```

Two levels of fanout because a flat directory reaches millions of entries, where
`readdir`, rsync and backup tools all degrade. No filename on disk because one piece of content has many
names — that is what dedup means — so writing one here would pick an arbitrary winner and
create a second, disagreeing source of truth. The name belongs to the `files` row and comes
back as `Content-Disposition`.

Four things worth knowing before building on it:

- **Bytes first, row second.** `putContent` writes and returns where the bytes landed; it
  never touches the database. Commit the `files` and `file_locations` rows only after it resolves. A crash in
  between leaves orphaned content for a sweeper to reclaim, whereas the reverse order leaves
  a `files` row pointing at bytes that do not exist — a permanent 500.
- **There is no update.** Different content is a different hash and therefore a different
  content. Renames and moves happen on the `files` row, never here.
- **Placement is recorded, not derived.** Content goes to whichever writable volume has the
  most free space, and the database remembers which. Deriving it from the hash (`hash % n`)
  would reshuffle everything already stored the moment a disk is added.
- **The marker file is load-bearing.** A disk that fails to mount leaves an empty directory
  on the root filesystem, and the service would otherwise write into it while recording
  that content as living on a disk that is not there. `openVolumes()` refuses to start
  without a matching `.imagenuaq-volume`. Initialise a genuinely new disk once, by hand,
  with `initVolume()` — it is deliberately not automatic.

Two costs this design has, stated plainly. **The database is now as critical as the
disks**: lose it and the disks hold correctly-named but meaningless bytes. And **multi-disk
is not redundancy** — one disk failing permanently loses that fraction of the corpus with
no partial recovery, so either ZFS/SnapRAID sits underneath or `file_locations` grows a
second row per hash. The schema supports the second without change; nothing implements it
yet.

## Endpoints

| Method | Route                     | Auth         | Notes                                                     |
| ------ | ------------------------- | ------------ | --------------------------------------------------------- |
| GET    | `/`                     | —           | Readiness ping, no database involved                      |
| GET    | `/api/docs`             | —           | Swagger UI;`/api/docs/openapi.json` is the raw document |
| GET    | `/api/health`           | —           | 200 while Postgres answers, 503 once it stops             |
| POST   | `/api/auth/login`       | —           | `{ email, password }` → `{ token, user }`            |
| GET    | `/api/auth/me`          | session      | The subject of the presented token                        |
| POST   | `/api/auth/activate`    | invite token | `{ token, password }` → `{ token, user }`            |
| POST   | `/api/users`            | admin        | Create a staff account →`{ user, inviteToken }`        |
| POST   | `/api/users/:id/invite` | admin        | Re-issue an invite for an account that never activated    |

### Areas and the organisation chart

Reads need only a session — RF-USR-03 gives everyone sight of their colleagues' work.
Writes need the `area.manage` permission, which `admin` holds from the seed and any other
role can be granted through `PUT /api/roles/:id/permissions`.

| Method | Route                                | Auth    | Notes                                                        |
| ------ | ------------------------------------ | ------- | ------------------------------------------------------------ |
| GET    | `/api/areas`                       | session | Flat and alphabetical                                        |
| GET    | `/api/areas/orgchart`              | session | The whole organisation, nested →`{ roots: [...] }`        |
| GET    | `/api/areas/:id`                   | session | One area                                                     |
| GET    | `/api/areas/:id/orgchart`          | session | The subtree under one area — the read`RF-USR-04` asks for  |
| GET    | `/api/areas/:id/members`           | session | Leaders first, then by name                                  |
| POST   | `/api/areas`                       | area.manage | `{ name, description?, leaderUserId?, parentAreaId? }`     |
| PATCH  | `/api/areas/:id`                   | area.manage | Partial; absent keys are left alone                          |
| DELETE | `/api/areas/:id`                   | area.manage | 409 while anyone is still assigned to it                     |
| PUT    | `/api/areas/:id/parent`            | area.manage | `{ parentAreaId }`; 409 if the move would close a cycle     |
| DELETE | `/api/areas/:id/parent`            | area.manage | Promote the area back to a root                              |
| PUT    | `/api/areas/:id/members/:userId`   | area.manage | `{ isAreaLeader? }`; an upsert, so it also promotes/demotes |
| DELETE | `/api/areas/:id/members/:userId`   | area.manage | Removes the membership, not the account                      |

An area with no `area_hierarchy` row is a root, so the chart is a **forest**, not a single
tree — but the seeded organisation is one: `coordinacion-root` renames the seeded
`Secretaría Particular` to `Coordinación` and hangs the other six under it, and a `POST
/api/areas` that omits `parentAreaId` hangs the new area under whatever `DEFAULT_AREA` in
`.env` names (matched by name, accent included). An explicit `parentAreaId: null` asks for
a root. When the variable is unset or matches no area there is simply no default, and the
area is a root — that fallback is silent by decision. Each area has at most one parent — that is the primary key — which is what makes the
result renderable: every node carries its own `children`, and the frontend's
`react-organizational-chart` recurses over the response with no reshaping. `depth` is
computed by the recursive walk rather than stored, because depth is a consequence of where
an area currently hangs and a stored copy would go stale on every re-parent.

Cycles deeper than one hop are refused by `PUT /api/areas/:id/parent`, not by the table:
`area_hierarchy` can only CHECK that an area is not its own parent. The read query carries
the recursive CTE's `CYCLE` clause so a loop written straight into the database through
`psql` truncates one branch instead of hanging the request — that is a seatbelt, not the
guard. A second write path to that table owes the same check.

### Roles and permissions

| Method | Route                                          | Auth    | Notes                                          |
| ------ | ---------------------------------------------- | ------- | ----------------------------------------------- |
| GET    | `/api/roles`                                 | session | The catalogue; a role picker needs it           |
| GET    | `/api/roles/:id`                             | session | One role                                        |
| GET    | `/api/roles/:id/permissions`                 | session | What that role may do                           |
| GET    | `/api/roles/permissions`                     | session | Every permission code that exists               |
| POST   | `/api/roles`                                 | admin   | `{ name, description? }`                      |
| PATCH  | `/api/roles/:id`                             | admin   | Renaming locks out live tokens — see below     |
| DELETE | `/api/roles/:id`                             | admin   | 409, with the count, while users still hold it  |
| PUT    | `/api/roles/:id/permissions`                 | admin   | `{ permissions: [codes] }` — replaces the set |
| POST   | `/api/roles/:id/permissions/:permissionId`   | admin   | 201 when new, 200 when already held             |
| DELETE | `/api/roles/:id/permissions/:permissionId`   | admin   | Takes effect on the next request                |
| POST   | `/api/roles/permissions`                     | admin   | `{ code, label, description? }`               |
| PATCH  | `/api/roles/permissions/:permissionId`       | admin   | Prefer adding a code to renaming one            |
| DELETE | `/api/roles/permissions/:permissionId`       | admin   | Cascades the grants away with it                |

`role_permissions` arrives partly filled by `catalog-bootstrap`: `admin` holds every
permission, because it is the role the others are configured from and an empty one is a
deadlock; `finance` holds `finance.read`, because that grant *is* the role under
`RF-USR-08`. `worker` and `area_lead` hold nothing on purpose — theirs is coordination's
policy decision (`RF-USR-05`), and `PUT /api/roles/:id/permissions` is where it gets made.

A grant opens whatever `requirePermission()` guards, and the rule for where that goes is
**one code per router block, not per endpoint**: each router is a read block and a write
block, each behind one `router.use()`, so `resource.read` and `resource.write` are the whole
vocabulary for a resource. A third code appears only where a requirement forces one slice
of a router to answer differently (`absence.reason.read`, `RF-AUS-13`), on those routes
alone. Which *records* a person may touch is not a permission — that is their area and the
subtree under it. `/api/areas` is the first router on this model (`area.manage` on its
writes). `/api/roles` and the writes of `/api/users` stay on the `admin` role name on
purpose: they edit the grants everything else reads, and a grant that can revoke itself is
a lockout.

Renaming a role is heavier than it looks. `requireRole()` compares `roles.name`, and every
token already issued carries the old name for up to seven days, because nothing re-reads the
database on a verified token. A rename locks those holders out until they log in again.

### API documentation

`npm run dev`, then [http://localhost:3000/api/docs](http://localhost:3000/api/docs). *Authorize* takes the token from
`POST /api/auth/login`, and **Try it out** calls this server — the document lists `/` as
its first server, so the UI resolves it against whatever host you opened it on.
`/api/docs/openapi.json` is the same document as a file, for a client generator or an
import into Postman.

The spec is **hand-written**, in [src/swagger.js](src/swagger.js) — one module rather than
JSDoc comments scattered across `routes/`, for the same reason `ROUTERS` exists. What keeps
it from drifting is `tests/docs.test.js`, which walks the routers the app actually mounts
and fails when one has no documented operation, when the document describes a route nothing
serves, or when a `$ref` does not resolve. A new endpoint therefore fails the suite until
it is described.

It is served in production too. This is an internal system behind a tunnel, every route it
describes refuses unauthenticated callers on its own, and a spec that only exists in
development is the one that never gets updated. Gate the `docs` entry in `ROUTERS` if that
ever needs to change.

Swagger UI needs `'unsafe-inline'` for scripts, which helmet's default policy forbids;
[src/routes/docs.js](src/routes/docs.js) re-runs helmet with a relaxed CSP scoped to that
subtree, and the suite asserts the relaxation does not leak onto the rest of the API.

### Accounts

There is no self-registration. RF-USR-01/02 make area and role decisions coordination
takes about a person, so accounts are created by an admin through `POST /api/users` and
arrive with **no password**. The response carries a one-time `inviteToken`; its owner picks
their own password at `POST /api/auth/activate`, which returns a session.

The invite is single-use with no table behind it: it is valid only while the account has no
password, and redeeming it gives the account one. That trick does not extend to password
*resets* — those need a hashed single-use token of their own, and are not built yet.

Session and invite tokens are both signed with `JWT_SECRET` and are distinguished by a
`purpose` claim. Without it an invite would be accepted as a session, which is a full login
for an account whose owner has not chosen a password.

### The first admin, and lockouts

Account creation needs an admin, which is a closed loop — nobody has been created yet, or
every admin has lost access. `npm run admin:create` breaks it:

```bash
ADMIN_PASSWORD=... npm run admin:create -- --email a@uaq.mx --name "Nombre Apellido"                                           [--contract <id|name>] [--area <id|name>]
```

Run against an address that already exists it **promotes that user to admin and resets
their password**, which is the recovery path when every admin is locked out. It is a script
and not an endpoint deliberately: in a lockout the admin rows are still present and valid,
so a route gated on “no admins exist” would refuse to help in the one situation it was for.
The gate is possession of `DATABASE_URL` — whoever has that can already do this with
`psql`; the script only makes it correct, at the same bcrypt cost the server verifies with.

Omit `ADMIN_PASSWORD` on a terminal and it prompts with the echo off. Never pass the
password as an argument: `argv` is readable through `ps` and lands in shell history.

Omit `--area` and the admin goes into the area `DEFAULT_AREA` names in `.env` — the same
variable `POST /api/areas` reads for a new area's parent — or into no area when that is
unset or matches nothing. A `--area` that matches nothing is refused instead.

Either way it leaves the `admin` role holding **every** permission in the catalogue. The
seed grants all of them, but grants are edited at runtime, so an admin can strip their own
role and a code added later is granted to nobody; both are the lockout in a different coat.
What it restores is written to the audit trail with no actor.

## Tests

```bash
npm test
```

Every endpoint above, driven through real HTTP. `pretest` creates
`imagenuaq_test` and migrates it, so `npm test` is the only command to remember; the
database container has to be up.

The runner is Node's own (`node --test`) with `node:assert` and `fetch`, so the suite adds
no dependencies. Each file boots the app with `new Api({ port: 0 })` and talks to it over a
socket rather than through an in-process shim -- helmet, CORS and `express.json()` are part
of what is being tested, and two of the cases are the body parser's refusals rather than
ours.

**The suite never touches the development database.** `tests/helpers/env.js` derives the
test database from `DATABASE_URL` by swapping the name for `imagenuaq_test`, and throws if
the result does not end in `_test` -- the fixtures truncate tables, so the name is checked
rather than trusted. Point `TEST_DATABASE_URL` somewhere else to override, subject to the
same check.

Files run serially (`--test-concurrency=1`) because they share that database and each one
truncates `users` and `area_members` before every case. The catalogs seeded by
`catalog-bootstrap` survive, and fixtures look roles and areas up **by name** -- the ids
differ between databases.

Most of the runtime is bcrypt: cost 12, roughly a second per login on a laptop, paid
honestly on every login the suite performs. Fixtures hash once per process and reuse the
digest.

What the suite is for, beyond regressions: the behaviours it pins are the ones the code
comments argue for and a plausible refactor would quietly undo -- the `purpose` claim that
keeps an invite from working as a session, the single login message that denies an
email-enumeration oracle, the ordering that makes a spent invite a 409 rather than a 400,
the CTE that writes `area_members` with the user, and the partial index that frees a
soft-deleted address. Each was checked by breaking it and confirming the suite fails.

There is still no linter.

## Adding a resource

A migration in `migrations/`, SQL in `access/resources/query.js`, rules
in `access/orchestration/<name>.js`, a router in `routes/<name>.js`, then one line in the
`ROUTERS` map in `src/api.js`, and its paths in `src/swagger.js` — `tests/docs.test.js`
fails on a route that is mounted and not described.
