# imagenuaq-backend

Setup

```bash
npm install
cp .env.example .env          # set DATABASE_URL
docker compose up -d db       # Postgres on the port in .env
npm run migrate:up            # apply migrations
npm run dev                   # node --watch
```

## Layout

```
main.js                  entry point: opens the pool, starts the API, shuts both down
migrations/              one file per schema change; commit these
dbml/                    one committed snapshot per migration, plus current.dbml
scripts/genDBML.js       writes dbml/ from the live schema (npm run dbml)
src/
  api.js                 Api class: builds the app, mounts ROUTERS under /api/, start/stop
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

We render with `@dbml/core` 10, but ChartDB bundles 3.14, and its parser rejects two things
the newer renderer emits — a snapshot containing either is valid DBML that fails on import
with a syntax error. `downgradeForChartDB()` in `scripts/genDBML.js` rewrites both:

- **`Checks { … }` blocks** become `CHECK <name>: <expression>` lines in the table's note, so
  `event_participants`'s `num_nonnulls(area_id, user_id) = 1` is still on the diagram.
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
create a second, disagreeing source of truth. The name belongs to the node row and comes
back as `Content-Disposition`.

`npm run storage:demo` exercises the whole surface against two scratch volumes under the
OS temp directory; it needs no database and no real disks, and it is the shortest way to
see how `putContent` is meant to be called.

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

| Method | Route           | Notes                                         |
| ------ | --------------- | --------------------------------------------- |
| GET    | `/`           | Readiness ping, no database involved          |
| GET    | `/api/health` | 200 while Postgres answers, 503 once it stops |

## Adding a resource

A migration in `migrations/`, SQL in `access/resources/query.js`, rules
in `access/orchestration/<name>.js`, a router in `routes/<name>.js`, then one line in the
`ROUTERS` map in `src/api.js`.
