# imagenuaq-backend

Setup

```bash
npm install
cp .env.example .env          # every value must be set; compose.yaml has no fallbacks
docker compose up -d db minio minio-init   # main.js refuses to start without the bucket
npm run migrate:up            # apply migrations, then regenerate dbml/
npm run dev                   # node --watch
npm test                      # see Tests below
```

## Layout

```
main.js                  entry point: opens the pool, starts the API and the scheduler, shuts them down
migrations/              one file per schema change; commit these
dbml/                    one committed snapshot per migration, plus current.dbml
scripts/genDBML.js       writes dbml/ from the live schema (npm run dbml)
src/
  api.js                 Api class: builds the app, mounts ROUTERS under /api/, start/stop
  scheduler.js           JOBS: the clock-driven checks, one entry per job
  realtime/socket.js     Socket.IO: pushes each new notification to its user
  swagger.js             the OpenAPI 3.1 document, hand-written
  routes/                one file per resource, thin: parse the request, call orchestration
  access/                everything that reads or writes data
    orchestration/       business rules per domain
    resources/query.js   the only module that writes SQL
    primitives/          connection pool, content store
  middlewares/           notFound, errorHandler
  utils/ApiError.js      typed HTTP errors
```

`access/` uses tiers: orchestration -> resources -> primitives. A module only imports
from tiers below it. See [src/access/ACCESS.md](src/access/ACCESS.md). All SQL lives in
`resources/query.js`, so a schema change touches one file.

Express 5 forwards rejections from `async` handlers to the error handler. Routes can
throw `ApiError` directly instead of wrapping.

Finance writes (`orchestration/finance.js`) break the rule "orchestration emits, audit
writes `logs`". Each one inserts its own `logs` row in the same statement as the change
(`loggedChange` in `query.js`). A lost audit row is not acceptable there
(`DATAMODEL.md` §5.6, §2.20).

## Database

postgrejs owns runtime queries. The pool lives in
`access/primitives/database.js` and only `resources/query.js` uses it. Reads pass
`objectRows: true`. Without it postgrejs returns arrays of values.

node-pg-migrate owns the schema. It is a devDependency and never loads at
runtime. The CLI applies the files in `migrations/` and records what it applied in
a `pgmigrations` table. Migrations use plain SQL with `-- Up Migration` and
`-- Down Migration` markers, so what runs against the database is what you wrote.
There is no schema file to keep in sync. The migrations *are* the schema history,
and `DATAMODEL.md` describes the resulting model.

| Command                    | What it does                                              |
| -------------------------- | --------------------------------------------------------- |
| `npm run migrate:new`    | Create a timestamped`.sql` migration in `migrations/` |
| `npm run migrate:up`     | Apply every pending migration, then refresh the DBML      |
| `npm run migrate:down`   | Roll back the last applied migration, then refresh it     |
| `npm run migrate:redo`   | Roll the last one back and re-apply it                    |
| `npm run migrate:status` | Print the SQL that`migrate:up` would run, run nothing   |
| `npm run dbml`           | Refresh`dbml/` by hand (the migrate commands call it)  |

Three defaults are on unless you turn them off. Every pending migration runs
inside a single transaction, so a failure half way leaves nothing behind. An
advisory lock stops two processes from migrating at once. `--check-order` refuses to
run if someone commits a migration dated earlier than one already applied.

Workflow: run `npm run migrate:new -- add-something` (spaces and `_` in the name
become dashes). Write the up and down SQL in the generated file. Run `npm run migrate:up`.
Commit the file. Write the queries that use it in `resources/query.js`.

### Schema snapshots

`migrate:up`, `:down` and `:redo` each run `npm run dbml` afterwards (npm `post` hooks, so
they fire only when the migration succeeds). That reads the live schema and writes
it twice:

- `dbml/<migration>.dbml`: the schema as of that migration. It shares the basename of the
  `.sql` that produced it. `migrations/1788369848184_initial-schema.sql` pairs with
  `dbml/1788369848184_initial-schema.dbml`, and the two directories sort alike.
- `dbml/current.dbml`: a copy of the newest one under a stable name, so ChartDB and any
  bookmark always point at the latest schema.

The snapshot format is [DBML](https://dbml.dbdiagram.io/): tables, columns, types, defaults, keys,
indexes, foreign keys, and the `COMMENT ON` text as `Note:`. To see what a migration
changed, diff its snapshot against the previous one:

```bash
git diff --no-index dbml/1788369848184_initial-schema.dbml dbml/1788380071225_update-wording-daysoff.dbml
```

The generator rewrites the target file every time, so rollback and re-apply is
safe to repeat. If a snapshot already exists and does not match the live schema, the
generator warns and overwrites. That means someone edited an already-applied migration, or the
database drifted from its own history.

Do not edit these files by hand. The generator reads them from the database, so the next
migration overwrites anything you write. Change the schema in `migrations/` only. Commit the
snapshot alongside the migration so the schema change is reviewable in the PR.
`.gitattributes` pins them to LF. They compare byte for byte, and a CRLF rewrite
would read as drift on every fresh clone.

The snapshot drops `pgmigrations` on purpose. It is node-pg-migrate's ledger, not part of
the data model. DBML cannot express partial indexes, `EXCLUDE` constraints, views or
indexes over an expression. The `.sql` is the truth about every index, and the snapshot
is a diagram. The `WHERE` predicates of `uq_users_email_live` or `event_participants`'s
unique indexes are lost. `absence_availability` is not in the snapshot at all.

`dbml/` does not pair one-to-one with `migrations/`. The `post` hook runs once per
`migrate:up`, so a batch of pending migrations leaves a snapshot only for the last one. A
migration committed but not yet applied on this machine has none. `npm run migrate:status`
decides which case applies. If nothing is pending, `current.dbml` matches the database
whatever gaps `dbml/` contains. If something is pending, the `.sql` is the only truth.

To view: open [ChartDB](https://chart.weirdcat.uk/) and use Import DBML with
`dbml/current.dbml`. ChartDB is a static frontend. It keeps diagrams in the browser's
IndexedDB and exposes no API, so the import is manual. A `/diagrams/<id>`
URL only opens in the browser that created it. Nothing here can push to the instance.

Working loop: sketch the change in ChartDB, export DBML from it to read the shape you want,
hand-write the migration SQL, run `npm run migrate:up`. Nothing applies a diagram back to the
database. A person always writes the migration.

#### Why the output targets an older DBML

The project renders with `@dbml/core` 10, but ChartDB bundles 3.14. Its parser rejects things
the newer renderer emits. A snapshot containing any of them is valid DBML that fails on
import with a syntax error.

`downgradeForChartDB()` in `scripts/genDBML.js` rewrites them.
Its JSDoc is the full list, which also covers expression indexes and expression defaults
(`nextval()` behind `requests.folio`) that parse but break ChartDB's re-export. `assertChartDBCanRender()` catches those. The first three rewrites:

- `Checks { ... }` blocks become `CHECK <name>: <expression>` lines in the table's note.
  `event_participants`'s `num_nonnulls(area_id, user_id) = 1` stays on the diagram this way.
- Inline `check:` column attributes get the same treatment. A CHECK over one column takes
  a different route out of the connector than a multi-column one. It arrives on the column in
  `schema.tableConstraints` rather than in `schema.checks`, and it renders inline. Both
  sources drain into the same note. `files`'s `hash ~ '^[0-9a-f]{64}$'` is one of these.
- `?<?` / `<?` relationship operators become plain `<`. The `?` marks an optional side.
  Whether the column is nullable already appears on the column as `not null`, so nothing is lost.

The generator then parses its own output with `@dbml/core-chartdb`, an npm alias for the
exact 3.14.1 that ChartDB ships. It fails the migration instead of writing a file that
will not import. If ChartDB upgrades its parser, bump that alias in `package.json`. If it
starts emitting something 3.14 cannot read, the error names the line and points at
`downgradeForChartDB()`.

## File storage

`access/primitives/minioStorage.js` is a content-addressed store in one MinIO bucket. The
arrangement inverts the obvious one. Postgres is the filesystem, and MinIO is a
dumb bag of bytes keyed by SHA-256. Identity is the content. The name and folder are
metadata on a row. Renaming or moving a folder is one row update, and nothing in the bucket
moves.

The `/api/documents` routes (`orchestration/documents.js`) are the tree on top of it.
`/api/shared/:token` opens a read-only, expiring share link to one folder without a session.

```
tmp/<uuid>              in-flight uploads, removed once the hash is known
content/ab/cd/<hash>    64 hex chars. No extension. No filename.
```

One piece of content can have many names (that is what dedup means). Writing a filename in
the key would pick an arbitrary winner and create a second, disagreeing source of truth. The
name belongs to the `files` row and comes back as `Content-Disposition`.

Things to know before building on it:

- Write bytes first, then the row. `putContent` streams the upload into the bucket, hashing it
  on the fly, and returns the hash. It never touches the database. Insert the `files` row
  only after it resolves. A crash in between leaves orphaned content for a sweeper to
  reclaim. The reverse order would leave a `files` row pointing at bytes that do not
  exist, a permanent 500.
- There is no update. Different content is a different hash. Renames and moves happen
  on the `files` row, never here.
- Placement is MinIO's. The bucket uses erasure coding across four disks
  (`MINIO_DISK1..4`), so the database records no placement.
- `openStorage()` checks the bucket at startup. It refuses to start when the bucket is
  missing. `compose.yaml`'s `minio-init` creates the bucket. The server image is MinIO AIStor and
  needs `minio.license` (git-ignored) in this directory, or wherever `MINIO_LICENSE` points.

The cost of this design: the database is now as critical as the
bucket. Lose it and MinIO holds correctly-hashed but meaningless bytes. Back up both.

## Scheduled jobs and notifications

Two things create notifications.

Domain events cover what a person did. The subscriber in
`orchestration/notifications.js` listens on `utils/events.js`, beside the audit trail. Its
`HANDLERS` map says, per action (`stage_activated`, `stage_assigned`, `stage_delivered`,
`stage_signed_off`, and `project_closed` when finance has gaps to see), who hears and what the
message says. The notifications exclude the person who acted, except for `stage_activated`.
An action without an entry notifies nobody.

Scheduled jobs cover what needs no person. `src/scheduler.js` holds `JOBS`, one entry per job
with a unique `name` (grep for it), a cron `schedule` read in Querétaro time, and `run(now)`.
`main.js` starts them and `Api` does not, so tests never run on a clock. A test calls
`runJob(name, now)` with whatever date it needs.

Two rules keep the jobs cheap and safe to repeat:

- One set-based statement per run. A job that notifies does it in a single
  `insert into notifications ... select ... returning *`, then pushes the returned rows over
  Socket.IO. No query per row.
- Every notification a job writes carries a dedup key naming the occurrence
  (`birthday:<userId>:<year>`). `notifications` is unique on `(user_id, dedup_key)`, so a
  repeated run, or one caught up after a restart, writes nothing new. That is why `birthdays`
  can run hourly.

The scheduler runs inside the API process. A second instance would run every job twice.

## Endpoints

| Method | Route                     | Auth         | Notes                                                     |
| ------ | ------------------------- | ------------ | --------------------------------------------------------- |
| GET    | `/`                     | none         | Readiness ping, no database involved                      |
| GET    | `/api/docs`             | none         | Swagger UI. `/api/docs/openapi.json` is the raw document |
| GET    | `/api/health`           | none         | 200 while Postgres and MinIO answer, 503 once either stops |
| POST   | `/api/auth/login`       | none         | `{ email, password }` returns `{ token, user }`            |
| GET    | `/api/auth/me`          | session      | The subject of the presented token                        |
| POST   | `/api/auth/activate`    | invite token | `{ token, password }` returns `{ token, user }`            |
| GET    | `/api/auth/me/profile`  | session      | Your own record in full, birthday and contract type included |
| PATCH  | `/api/auth/me`          | session      | `{ fullName?, email?, birthday? }`, your own only. The rest is coordination's |
| PUT    | `/api/auth/me/password` | session      | `{ currentPassword, newPassword }`. Other sessions stay signed in |
| GET/PUT/DELETE | `/api/auth/me/picture` | session | Your own picture. Raw image body on PUT, as `/api/users/:id/picture` |
| POST   | `/api/users`            | admin        | Create a staff account, returns `{ user, inviteToken }`        |
| POST   | `/api/users/:id/invite` | admin        | Re-issue an invite for an account that never activated    |

### Areas and the organisation chart

Reads need only a session. RF-USR-03 gives everyone sight of their colleagues' work.
Writes need the `area.manage` permission. `admin` holds it from the seed, and any other
role can get it through `PUT /api/roles/:id/permissions`.

| Method | Route                                | Auth    | Notes                                                        |
| ------ | ------------------------------------ | ------- | ------------------------------------------------------------ |
| GET    | `/api/areas`                       | session | Flat and alphabetical                                        |
| GET    | `/api/areas/orgchart`              | session | The whole organisation, nested. Returns `{ roots: [...] }`        |
| GET    | `/api/areas/:id`                   | session | One area                                                     |
| GET    | `/api/areas/:id/orgchart`          | session | The subtree under one area, the read `RF-USR-04` asks for  |
| GET    | `/api/areas/:id/members`           | session | Leaders first, then by name                                  |
| POST   | `/api/areas`                       | area.manage | `{ name, description?, leaderUserId?, parentAreaId? }`     |
| PATCH  | `/api/areas/:id`                   | area.manage | Partial. Absent keys stay unchanged                          |
| DELETE | `/api/areas/:id`                   | area.manage | 409 while anyone is still assigned to it                     |
| PUT    | `/api/areas/:id/parent`            | area.manage | `{ parentAreaId }`. 409 if the move would close a cycle     |
| DELETE | `/api/areas/:id/parent`            | area.manage | Promote the area back to a root                              |
| PUT    | `/api/areas/:id/members/:userId`   | area.manage | `{ isAreaLeader? }`. An upsert, so it also promotes/demotes |
| DELETE | `/api/areas/:id/members/:userId`   | area.manage | Deletes the membership, not the account                      |

An area with no `area_hierarchy` row is a root. The chart is a forest, not a single
tree. The seeded organisation is one tree: `coordinacion-root` renames the seeded
`Secretaría Particular` to `Coordinación` and places the other six under it. A `POST
/api/areas` that omits `parentAreaId` places the new area under whatever `DEFAULT_AREA` in
`.env` names (matched by name, accent included). An explicit `parentAreaId: null` asks for
a root.

When the variable is unset or matches no area, there is simply no default and the
area becomes a root. That fallback is silent on purpose.

#### Tree structure

Each area has at most one parent, which is the primary key. That is what makes the
result renderable: every node carries its own `children`, and the frontend's
`react-organizational-chart` recurses over the response with no reshaping. The walk computes
`depth` instead of storing it. Depth is a consequence of where
an area currently sits, and a stored copy would go stale on every re-parent.

`PUT /api/areas/:id/parent` refuses cycles deeper than one hop, not the table.
`area_hierarchy` can only CHECK that an area is not its own parent. The read query carries
the recursive CTE's `CYCLE` clause. A loop written straight into the database through
`psql` truncates one branch instead of hanging the request. That is a safety net, not the
guard. A second write path to that table owes the same check.

### Roles and permissions

| Method | Route                                          | Auth    | Notes                                          |
| ------ | ---------------------------------------------- | ------- | ----------------------------------------------- |
| GET    | `/api/roles`                                 | session | The catalogue. A role picker needs it           |
| GET    | `/api/roles/:id`                             | session | One role                                        |
| GET    | `/api/roles/:id/permissions`                 | session | What that role may do                           |
| GET    | `/api/roles/permissions`                     | session | Every permission code that exists               |
| POST   | `/api/roles`                                 | admin   | `{ name, description? }`                      |
| PATCH  | `/api/roles/:id`                             | admin   | Renaming locks out live tokens, see below     |
| DELETE | `/api/roles/:id`                             | admin   | 409, with the count, while users still hold it  |
| PUT    | `/api/roles/:id/permissions`                 | admin   | `{ permissions: [codes] }`, replaces the set |
| POST   | `/api/roles/:id/permissions/:permissionId`   | admin   | 201 when new, 200 when already held             |
| DELETE | `/api/roles/:id/permissions/:permissionId`   | admin   | Takes effect on the next request                |
| POST   | `/api/roles/permissions`                     | admin   | `{ code, label, description? }`               |
| PATCH  | `/api/roles/permissions/:permissionId`       | admin   | Prefer adding a code to renaming one            |
| DELETE | `/api/roles/permissions/:permissionId`       | admin   | Cascades the grants away with it                |

`role_permissions` arrives partly filled by `catalog-bootstrap`. `admin` holds every
permission because the other roles use it as a baseline. An empty one is a
deadlock. `finance` holds `finance.read` because that grant *is* the role under
`RF-USR-08`. `worker` and `area_lead` hold nothing on purpose.

Their grants are coordination's
policy decision (`RF-USR-05`). Coordination makes that decision through `PUT /api/roles/:id/permissions`.

A grant opens whatever `requirePermission()` guards. The rule for where that goes:
one code per router block, not per endpoint. Each router has a read block and a write
block, each behind one `router.use()`. `resource.read` and `resource.write` are the whole
vocabulary for a resource. A third code appears only where a requirement forces one slice
of a router to answer differently (`absence.reason.read`, `RF-AUS-13`), on those routes
alone.

Which *records* a person may touch is not a permission. That is their area and the
subtree under it.

`/api/areas` is the first router on this model (`area.manage` on its
writes). `/api/roles` and the writes of `/api/users` stay on the `admin` role name on
purpose. They edit the grants everything else reads, and a grant that can revoke itself is
a lockout.

`admin` is the one role the code names by string (`requireRole('admin')` and the record
checks in `documents.js`, `microsoft.js`, `routes/users.js`). It cannot be renamed or
deleted. Any other rename takes effect on the holders' next request. `verifyToken()` reads
the role from the user row, not from the token.

### API documentation

Run `npm run dev`. Open [http://localhost:3000/api/docs](http://localhost:3000/api/docs). *Authorize* takes the token from
`POST /api/auth/login`. *Try it out* calls this server. The document lists `/` as
its first server, so the UI resolves it against whatever host you opened it on.
`/api/docs/openapi.json` is the same document as a file, for a client generator or an
import into Postman.

The spec is hand-written in [src/swagger.js](src/swagger.js), one module rather than
JSDoc comments scattered across `routes/`, for the same reason `ROUTERS` exists. `tests/docs.test.js` keeps
it from drifting. It walks the routers the app mounts. It
fails when one lacks a documented operation, when the document describes a route nothing
serves, or when a `$ref` does not resolve.

 A new endpoint fails the suite until
the spec describes it.

The server delivers the spec in production too. This is an internal system behind a tunnel. Every route
refuses unauthenticated callers on its own, and a spec that only exists in
development is the one that never gets updated. Gate the `docs` entry in `ROUTERS` if that
ever needs to change.

Swagger UI needs `'unsafe-inline'` for scripts, which helmet's default policy forbids.
[src/routes/docs.js](src/routes/docs.js) re-runs helmet with a relaxed CSP scoped to that
subtree. The suite asserts the relaxation does not leak onto the rest of the API.

### Accounts

There is no self-registration. RF-USR-01/02 make area and role decisions coordination
takes about a person, so an admin creates accounts through `POST /api/users`.
They arrive with no password. The response carries a one-time `inviteToken`. Its owner picks
their own password at `POST /api/auth/activate`, which returns a session.

The invite is single-use with no table behind it. It is valid only while the account has no
password, and redeeming it gives the account one. That trick does not extend to password
*resets*. Those need a hashed single-use token of their own and are not built yet.

`JWT_SECRET` signs both session and invite tokens, and each carries a
`purpose` claim. Without it an invite would be accepted as a session, which is a full login
for an account whose owner has not chosen a password.

### The first admin, and lockouts

Account creation needs an admin, which is a closed loop. Either nobody exists yet, or
every admin lost access. `npm run admin:create` breaks it:

```bash
ADMIN_PASSWORD=... npm run admin:create -- --email a@uaq.mx --name "Nombre Apellido"                                           [--contract <id|name>] [--area <id|name>]
```

Run it against an address that already exists, and it promotes that user to admin and resets
their password. That is the recovery path when every admin loses access. It is a script
and not an endpoint on purpose.

In a lockout the admin rows are still present and valid. A route gated on
"no admins exist" would refuse to help in the one situation it was for.
The gate is possession of `DATABASE_URL`. Whoever has that can already do this with
`psql`. The script only makes it safe, at the same bcrypt cost the server verifies with.

Omit `ADMIN_PASSWORD` on a terminal and it prompts with the echo off. Never pass the
password as an argument. `argv` is readable through `ps` and lands in shell history.

Omit `--area` and the admin goes into the area `DEFAULT_AREA` names in `.env`, the same
variable `POST /api/areas` reads for a new area's parent. It falls back to no area when the
value is unset or matches nothing. The command rejects a `--area` that matches nothing.

Either way the script leaves the `admin` role holding every permission in the catalogue. The
seed grants all of them, but grants change at runtime. An admin can strip their own
role, and a code added later goes to nobody. Both lock admins out the same way.
The script writes what it restores to the audit trail with no actor.

## Tests

```bash
npm test
```

Every endpoint above, driven through real HTTP. `pretest` creates `imagenuaq_test` and
migrates it, and creates the `imagenuaq-test` bucket. Both the `db` and `minio`
containers must be up. One file, once `pretest` runs at least once:

```bash
node --env-file-if-exists=.env --env-file-if-exists=.env.test --test tests/roles.test.js
```

A full run takes about five minutes. Do not pipe it. `npm test | tail` hangs:
once the reader exits, the runner blocks writing to stdout at 0% CPU and never spawns a file.
It looks like a slow run rather than a dead one. Redirect instead
(`npm test > run.log 2>&1`) and read the log.

Two runs must never overlap. They share the one test database and `resetCases()`
deletes by predicate. A second run deletes the first one's fixtures. The symptom: a
file fails in a full run (`Key (user_id)=(1) is not present in table "users"`) and
passes on its own. Re-run that one file before suspecting the code.

The runner is Node's own (`node --test`) with `node:assert` and `fetch`, so the suite adds
no dependencies. Each file boots the app with `new Api({ port: 0 })` and talks to it over a
socket rather than an in-process shim. Helmet, CORS and `express.json()` are part
of what the tests cover. Two of the cases are the body parser's refusals rather than
ours.

The suite never touches the development database. `tests/helpers/env.js` derives the
test database from `DATABASE_URL` by swapping the name for `imagenuaq_test`. It throws if
the result does not end in `_test`. The fixtures truncate tables, so the code verifies the name
rather than trusting it. Point `TEST_DATABASE_URL` somewhere else to override, subject to the
same check.

Files run serially (`--test-concurrency=1`) because they share that database. Each one
empties it before every case. The catalogs seeded by `catalog-bootstrap` survive.
Fixtures look roles and areas up by name because the ids differ between databases.
`reset()` deletes rather than `TRUNCATE ... CASCADE`. The cascade followed
`schema_versions.published_by` into the seeded starter formats and emptied them.

Add a table a test writes to that `resetCases()` does not know to `UNSEEDED_TABLES` in
`tests/helpers/fixtures.js`, in foreign-key order.

Most of the runtime is bcrypt: cost 12, roughly a second per login on a laptop, paid
in full on every login the suite performs. Fixtures hash once per process and reuse the
digest.

Beyond regressions, the suite pins the behaviours a plausible refactor would quietly undo:

- The `purpose` claim that keeps an invite from working as a session
- The single login message that hides which emails have accounts
- The ordering that makes a spent invite a 409 rather than a 400
- The CTE that writes `area_members` with the user
- The partial index that frees a soft-deleted address

Each was checked by breaking it and watching the suite fail.

## Adding a resource

Write a migration in `migrations/`. Add SQL in `access/resources/query.js`. Add rules
in `access/orchestration/<name>.js`. Add a router in `routes/<name>.js`. Add one line in the
`ROUTERS` map in `src/api.js`. Describe its paths in `src/swagger.js`.

`tests/docs.test.js` fails when it mounts a route that the spec does not describe.

`auth` is the worked example of the whole stack. Copy its shape rather than `health`'s,
which is thin enough to mislead. A router never imports `query.js`. Routes do not
catch: every refusal is an `ApiError` thrown from orchestration. A `try/catch` in a
handler only turns a deliberate 401 into a 500.

Declare static paths (`/orgchart`,
`/field-keys`) before `/:id`, which would otherwise capture them. A new permission or audit
action code is a migration. Grant a new permission to `admin` in that same
migration (DATAMODEL.md §5.9).

## Conventions

- Two kinds of comment only: a 1-3 line header saying what the file does and the one
  thing you would get wrong. JSDoc goes directly above a declaration for any rule a caller
  could break. Plain words, no history. `npm run lint` enforces the two kinds
  (`eslint-rules/comment-policy.js`). SQL comments in query strings and migrations are fine.
  Design reasoning goes in `DATAMODEL.md`, cited from the code by its `RF-*`.
- Code, comments and this README are English. `DATAMODEL.md`, `src/access/ACCESS.md` and
  migration prose are Spanish. Keep each file in the language it already uses.
- A migration opens with a prose block: what the previous shape could not express and
  why the obvious fix is wrong. Name the `RF-*` that force it and the `DATAMODEL.md` section it closes.
  Its Down really reverses its Up. An applied migration is never edited. Fix forward.
- Run migrations from the host against `DATABASE_URL`, never inside the server
  container. `node-pg-migrate` and `pg` are devDependencies, absent from the image.
- `dev` is the integration branch, not `main`. Branches are `I<n>-<topic>`
  (`I8-archivos`), merged to `dev` by PR. Commit subjects are `<area>/<summary>` with area
  `api/`, `db/`, `api-db/`, `fix/` or `docs/`.
