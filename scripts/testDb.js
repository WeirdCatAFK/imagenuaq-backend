#!/usr/bin/env node
// Creates the test database and brings it up to the current schema. Run by `pretest`, so
// `npm test` is the only command anyone has to remember.
//
// Idempotent: the CREATE is skipped when the database already exists and node-pg-migrate
// applies only what `pgmigrations` says is pending, so a second run is nearly free. The
// database is never dropped between runs -- migrating eight files costs a second or two
// and the suite truncates what it dirties anyway.
//
// Two things here are easy to get wrong, and both are silent when you do.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pg from 'pg';

import { testDatabaseUrl } from '../tests/helpers/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// The first mistake: connecting to the database you are about to create. CREATE DATABASE
// cannot run from inside its own target, so this connects to `postgres`, the maintenance
// database every server has, and issues the statement from there.
const target = new URL(testDatabaseUrl());
const dbName = decodeURIComponent(target.pathname.slice(1));

const maintenance = new URL(target);
maintenance.pathname = '/postgres';

const client = new pg.Client({ connectionString: maintenance.href });

try {
  await client.connect();
} catch (err) {
  console.error(
    `\n  Cannot reach Postgres at ${maintenance.host}: ${err.message}\n` +
      '  Is the database up? `docker compose up -d db`\n',
  );
  process.exit(1);
}

try {
  const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [
    dbName,
  ]);

  if (rowCount === 0) {
    // No parameters: CREATE DATABASE is not preparable, so the name has to be inlined.
    // Quoting it as an identifier is what keeps that from being an injection -- and the
    // name is not user input in the first place, it comes from env.js, which has already
    // refused anything not ending in `_test`.
    await client.query(`create database "${dbName.replace(/"/g, '""')}"`);
    console.log(`  Created database ${dbName}.`);
  }
} finally {
  await client.end();
}

// The second mistake: running `npm run migrate:up`. That script has a `postmigrate:up`
// hook which runs `npm run dbml`, and genDBML.js reads whatever database DATABASE_URL
// points at and overwrites the tracked snapshots in dbml/ with it. Pointed at the test
// database -- as it would be here -- every test run would rewrite committed files with a
// snapshot named after a schema nobody asked about. Call the binary directly instead; it
// has no hooks.
const result = spawnSync(
  process.execPath,
  [path.join(repoRoot, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js'), 'up'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: target.href },
  },
);

if (result.status !== 0) {
  console.error('\n  Migrations failed against the test database.\n');
  process.exit(result.status ?? 1);
}
