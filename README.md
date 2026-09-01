# imagenuaq-backend

Setup
```bash
npm install
cp .env.example .env          # set DATABASE_URL
npm run db:migrate            # apply migrations
npm run dev                   # node --watch
```

## Layout

```
main.js                  entry point: opens the pool, starts the API, shuts both down
prisma.config.js         Prisma CLI config: where the datasource URL lives (Prisma 7+)
prisma/schema.prisma     the schema, owned by Prisma Migrate
prisma/migrations/       generated; commit these
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
- **Prisma Migrate** owns the schema. `prisma/schema.prisma` has no `generator client`
  block and `@prisma/client` is not installed, so Prisma never loads at runtime; it is
  a CLI that produces SQL files in `prisma/migrations/`. Since Prisma 7 the connection
  URL lives in `prisma.config.js`, not in the schema that file reads the same `.env`
  via `process.loadEnvFile`, because the CLI is a separate process and does not inherit
  the `--env-file` the npm scripts pass to node.

| Command              | What it does                                       |
| -------------------- | -------------------------------------------------- |
| `npm run db:migrate` | Author + apply a migration from the schema (dev)   |
| `npm run db:deploy`  | Apply pending migrations without authoring (CI/prod)|
| `npm run db:status`  | Show applied and pending migrations                |

Workflow: edit `prisma/schema.prisma`, run `npm run db:migrate -- --name what_changed`,
commit the generated folder, then write the SQL that uses it in `resources/query.js`.

## Endpoints

| Method | Route         | Notes                                          |
| ------ | ------------- | ---------------------------------------------- |
| GET    | `/`           | Readiness ping, no database involved           |
| GET    | `/api/health` | 200 while Postgres answers, 503 once it stops  |

## Adding a resource

Model in `prisma/schema.prisma` + a migration, SQL in `access/resources/query.js`, rules
in `access/orchestration/<name>.js`, a router in `routes/<name>.js`, then one line in the
`ROUTERS` map in `src/api.js`.
