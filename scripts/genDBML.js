#!/usr/bin/env node
// Snapshots the live Postgres schema as DBML, once per migration.
// Usage: npm run dbml [-- --db <url>] [-- --out <path>]
// Output: dbml/<migration>.dbml (the schema as of that migration) and dbml/current.dbml
//
// Runs automatically after migrate:up / :down / :redo via npm's post hooks, so the snapshots
// track the database rather than someone's memory. The per-migration files share the basename
// of the .sql that produced them, so `migrations/1788369848184_initial-schema.sql` pairs with
// `dbml/1788369848184_initial-schema.dbml` and the two directories sort alike. Diff any two to
// see what happened between them; `current.dbml` is the stable name to open in ChartDB
// (https://chart.weirdcat.uk/, Import DBML).
//
// The npm script passes --no-deprecation: @dbml/connector's introspection reuses one pg client
// across overlapping queries, and the resulting warning fires on every migration and is not
// ours to fix.

import { importer } from '@dbml/core';
import { Parser as ChartDBParser } from '@dbml/core-chartdb';
import connectorPkg from '@dbml/connector';
import { Connection } from 'postgrejs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const { connector } = connectorPkg;

// node-pg-migrate's own ledger. It is in the database but not in the data model, and leaving
// it in would put a table nobody designed in the middle of every diagram.
const LEDGER = 'pgmigrations';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  // Guard against `--out --db x` swallowing the next flag as a value.
  return value && !value.startsWith('--') ? value : fallback;
}

const url = flag('db', process.env.DATABASE_URL);
if (!url) {
  console.error('No database URL: set DATABASE_URL in .env, or pass --db <url>.');
  process.exit(1);
}

// @dbml/connector reads the schemas to introspect off the connection string and returns an
// empty schema when the parameter is missing, so supply it unless the caller already did.
function withSchemas(connectionString) {
  try {
    const parsed = new URL(connectionString);
    if (!parsed.searchParams.has('schemas')) parsed.searchParams.set('schemas', 'public');
    return parsed.toString();
  } catch {
    // Not a URL we can parse (a libpq key=value DSN, say) — leave the caller's string alone.
    return connectionString;
  }
}

const outPath = resolve(flag('out', 'dbml/current.dbml'));
const outDir = dirname(outPath);

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// Drops the migration ledger from every collection it appears in. The keyed collections use
// `<schema>.<table>`, so a table can be present under more than one schema name.
function dropLedger(schema) {
  schema.tables = schema.tables.filter((t) => t.name !== LEDGER);
  for (const key of ['fields', 'indexes', 'tableConstraints', 'checks']) {
    for (const name of Object.keys(schema[key] ?? {})) {
      if (name.split('.').pop() === LEDGER) delete schema[key][name];
    }
  }
  schema.refs = schema.refs.filter((r) => !r.endpoints.some((e) => e.tableName === LEDGER));
  return schema;
}

// We generate with @dbml/core 10, but ChartDB bundles 3.14 and its parser rejects two things
// the newer renderer emits. Both are downgraded here rather than left for the import to choke
// on, since a snapshot ChartDB will not open defeats the point of the format.
//
//   Checks { … }   a much later addition; 3.14 fails with "Expected schema name or type".
//                  Folded into the table note, so the constraint is still visible.
//   ?<? / <?       optionality markers on relationships; 3.14 only knows < > - <>. The
//                  endpoint relations are normalised to plain '*' / '1', which makes the
//                  renderer emit `<`. Whether the FK column is nullable is already on the
//                  column itself as `not null`, so nothing is actually lost.
function downgradeForChartDB(schema) {
  for (const [key, checks] of Object.entries(schema.checks ?? {})) {
    const [schemaName, tableName] = key.split('.');
    const table = schema.tables.find((t) => t.name === tableName && t.schemaName === schemaName);
    if (!table) continue;
    const lines = checks.map((c) => `CHECK ${c.name}: ${c.expression}`);
    table.note ??= { value: '' };
    table.note.value = [table.note.value, ...lines].filter(Boolean).join('\n');
  }
  schema.checks = {};

  for (const ref of schema.refs) {
    for (const endpoint of ref.endpoints) {
      endpoint.relation = endpoint.relation.endsWith('*') ? '*' : '1';
    }
  }
  return schema;
}

// A snapshot ChartDB cannot open is worthless, and "it rendered without error" is no evidence
// that it can — the two version gaps above both produced perfectly valid DBML that failed on
// import. @dbml/core-chartdb is an npm alias for the exact 3.14.1 that ChartDB bundles, so
// this parses the output with the real thing and fails the migration rather than committing a
// file nobody can load. Bump the alias when ChartDB bumps its own.
function assertChartDBCanParse(text) {
  try {
    ChartDBParser.parse(text, 'dbml');
  } catch (err) {
    const diag = err.diags?.[0] ?? err;
    const line = diag.location?.start?.line;
    console.error(
      `Generated DBML does not parse in ChartDB's DBML version: ${diag.message ?? err.message}`
    );
    if (line) console.error(`  line ${line}: ${text.split('\n')[line - 1]}`);
    console.error('  Add the construct to downgradeForChartDB() in this file.');
    process.exit(1);
  }
}

// The migration the database now sits on, which names the snapshot. Not "the migration that
// ran": after a rollback the head row is the one you rolled back *to*, and the file we want to
// write is the state the schema is now in — so up, down and redo all land on the right name.
// Returns null when there is nothing to name a file after (a database with no migrations, or
// no ledger at all), in which case only current.dbml is written.
async function headMigration(connectionString) {
  // A plain Connection rather than the pool in src/access/primitives: this is a one-shot dev
  // script, and going through the app's access layer would put a documentation tool inside
  // the runtime data path that ACCESS.md reserves for real resources.
  const db = new Connection(connectionString);
  await db.connect();
  try {
    const result = await db.query(`SELECT name FROM ${LEDGER} ORDER BY id DESC LIMIT 1`, {
      objectRows: true,
    });
    return result.rows?.[0]?.name ?? null;
  } catch {
    // No ledger table yet, which is what a database that has never been migrated looks like.
    return null;
  } finally {
    await db.close();
  }
}

const schema = downgradeForChartDB(
  dropLedger(await connector.fetchSchemaJson(withSchemas(url), 'postgres'))
);
const dbml = `${importer.generateDbml(schema).trim()}\n`;
assertChartDBCanParse(dbml);

const head = await headMigration(url);
const counts = `${schema.tables.length} tables, ${schema.refs.length} refs`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, dbml, 'utf8');

if (!head) {
  console.log(`DBML written to ${outPath} (${counts}); no applied migration to name a snapshot.`);
  process.exit(0);
}

// Rolling back re-writes the snapshot of the migration we land on, which should already match
// byte for byte. When it does not, an applied migration was edited or the database drifted
// away from its history — the database is the truth, so overwrite, but say so.
const snapshotPath = resolve(outDir, `${head}.dbml`);
// Normalise line endings before comparing. .gitattributes pins these files to LF, but a
// checkout made before that landed can still hold CRLF, and that is not drift.
const existing = readIfPresent(snapshotPath).replace(/\r\n/g, '\n');
if (existing && existing !== dbml) {
  console.warn(`Warning: ${head}.dbml already existed and did not match the live schema.`);
  console.warn('  An applied migration was edited, or the database drifted. Overwriting.');
}
writeFileSync(snapshotPath, dbml, 'utf8');

console.log(`DBML written to ${snapshotPath} and ${outPath} (${counts}).`);
