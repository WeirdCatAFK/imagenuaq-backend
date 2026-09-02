### Building and running your application

When you're ready, start your application by running:
`docker compose up --build`.

Your application will be available at http://localhost:3000.

The port is not hardcoded: Compose reads `PORT` from the `.env` file in this
directory (falling back to `3000`) and uses it for both the published port and
the `PORT` variable the app reads. Set `PORT=8080` in `.env` — or run
`PORT=8080 docker compose up --build` — and the app is served on that port
instead. `HOST` is forced to `0.0.0.0` in the container so the published port
reaches it; the app's own `localhost` default would only bind loopback.

### The database

`compose.yaml` also starts a `postgres:18-alpine` service called `db`, created from
`POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` in `.env` (defaults:
`imagenuaq` / `postgres` / `postgres`). Data lives in the `db-data` named volume and
survives `docker compose down`; `docker compose down -v` deletes it.

The server waits for the database's healthcheck before starting, and connects to it as
`db:5432` on the Compose network — the `DATABASE_URL` in `.env` points at `localhost`,
which inside a container is the container itself, so `compose.yaml` overrides it.

The database is also published on the host as `${POSTGRES_PORT:-5432}` so your local
tooling can reach it. That matters for migrations: node-pg-migrate is a devDependency and
is not installed in the server image, so migrations run from your machine, not in the
container:

```
npm run migrate:new -- add_something   # create a .sql migration
npm run migrate:up                     # apply pending
npm run migrate:status                 # print the SQL without running it
```

Those read `DATABASE_URL` from `.env`, so keep it in sync with the `POSTGRES_*` values.
If port 5432 is already taken on your machine, set `POSTGRES_PORT` to something else and
update the port in `DATABASE_URL` to match.

### pgAdmin

`compose.yaml` also starts pgAdmin, published on `${PGADMIN_PORT:-5050}` — it listens on
port 80 inside its container, which is why the mapping is not a matching pair. Log in
with `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD` from `.env`, then register a
server pointing at host `db`, port `5432` (the container's own port, not the published
one, since pgAdmin connects over the Compose network).

Its configuration — the login accounts and the servers you register — lives in the
`pgadmin-data` volume, so both survive `docker compose down`. `docker compose down -v`
drops it along with the database data, and you register the server again.

### Deploying your application to the cloud

First, build your image, e.g.: `docker build -t myapp .`.
If your cloud uses a different CPU architecture than your development
machine (e.g., you are on a Mac M1 and your cloud provider is amd64),
you'll want to build the image for that platform, e.g.:
`docker build --platform=linux/amd64 -t myapp .`.

Then, push it to your registry, e.g. `docker push myregistry.com/myapp`.

Consult Docker's [getting started](https://docs.docker.com/go/get-started-sharing/)
docs for more detail on building and pushing.

### References
* [Docker's Node.js guide](https://docs.docker.com/language/nodejs/)