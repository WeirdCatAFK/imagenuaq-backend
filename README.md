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
src/
  api.js                 Api class: builds the app, mounts ROUTERS under /api/, start/stop
  routes/                one file per resource, thin: parse the request, call orchestration
  access/                everything that reads or writes data
    orchestration/       business rules per domain
    resources/query.js   the only module that writes SQL
    primitives/          connection pool
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

| Command                  | What it does                                          |
| ------------------------ | ----------------------------------------------------- |
| `npm run migrate:new`    | Create a timestamped `.sql` migration in `migrations/` |
| `npm run migrate:up`     | Apply every pending migration                          |
| `npm run migrate:down`   | Roll back the last applied migration                   |
| `npm run migrate:redo`   | Roll the last one back and re-apply it                 |
| `npm run migrate:status` | Print the SQL that `migrate:up` would run, run nothing |

Defaults worth knowing, all on unless you turn them off: every pending migration runs
inside a **single transaction**, so a failure half way leaves nothing behind; an
**advisory lock** stops two processes migrating at once; and `--check-order` refuses to
run if someone commits a migration dated earlier than one already applied.

Workflow: `npm run migrate:new -- add_something`, write the up and down SQL in the
generated file, `npm run migrate:up`, commit the file, then write the queries that use
it in `resources/query.js`.

## Endpoints

| Method | Route         | Notes                                          |
| ------ | ------------- | ---------------------------------------------- |
| GET    | `/`           | Readiness ping, no database involved           |
| GET    | `/api/health` | 200 while Postgres answers, 503 once it stops  |

## Adding a resource

A migration in `migrations/`, SQL in `access/resources/query.js`, rules
in `access/orchestration/<name>.js`, a router in `routes/<name>.js`, then one line in the
`ROUTERS` map in `src/api.js`.
