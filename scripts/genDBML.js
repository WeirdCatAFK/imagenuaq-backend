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

// The index access methods ChartDB's parser accepts; see downgradeForChartDB(). Its own error
// names them ('Expected btree, comment, hash, or whitespace'), so this list is not a guess.
const CHARTDB_INDEX_TYPES = new Set(['btree', 'hash']);

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

// We generate with @dbml/core 10, but ChartDB bundles 3.14 and its parser rejects four
// things the newer renderer emits. All are downgraded here rather than left for the import to
// choke on, since a snapshot ChartDB will not open defeats the point of the format.
//
//   Checks { … }   a much later addition; 3.14 fails with "Expected schema name or type".
//                  Folded into the table note, so the constraint is still visible.
//   [check: …]     the same constraint over a single column, which the connector reports on
//                  the column rather than the table; 3.14 reads the settings list and fails
//                  with 'Expected "default:" … but "c" found'. Folded into the same note.
//   ?<? / <?       optionality markers on relationships; 3.14 only knows < > - <>. The
//                  endpoint relations are normalised to plain '*' / '1', which makes the
//                  renderer emit `<`. Whether the FK column is nullable is already on the
//                  column itself as `not null`, so nothing is actually lost.
//   [type: gist]   index access methods beyond btree and hash; 3.14 fails with 'Expected
//                  btree, comment, hash, or whitespace'. Dropped to the table note, since the
//                  only one we have is the index behind an EXCLUDE constraint, which DBML
//                  cannot express in any version.
//
// Two more survive the parser and break later, which is why assertChartDBCanRender() exists
// alongside the parse check — neither of these is a parse error anywhere:
//
//   expression     an index over an expression rather than columns, such as lower(email) or
//   indexes        coalesce(table_name, ''). It parses, then fails as ChartDB builds its model
//                  with 'Index references non-existent column', because a DBML index names
//                  columns and each is resolved against the table. Dropped to the note.
//   expression     a column default carrying a call or a quoted literal, such as the
//   defaults       nextval() behind requests.folio. It parses AND imports, and breaks when
//                  ChartDB regenerates SQL from its model: everything after the first quoted
//                  literal is dropped, so the default comes back out as `DEFAULT (SOL-)` and
//                  the export fails to parse. Dropped to the note.
function downgradeForChartDB(schema) {
  // Every CHECK ends up in its table's note, because 3.14 can express none of them. They
  // reach us by two different routes, though: a constraint over several columns arrives in
  // schema.checks and renders as a `Checks { … }` block, while a single-column one rides on
  // the column in schema.tableConstraints and renders inline as `check:`. Both are rejected
  // on import, so both are collected here and the sources emptied.
  const notes = new Map();
  const note = (key, line) => {
    if (!notes.has(key)) notes.set(key, []);
    notes.get(key).push(line);
  };
  const collect = (key, check) => note(key, `CHECK ${check.name}: ${check.expression}`);

  for (const [key, checks] of Object.entries(schema.checks ?? {})) {
    for (const check of checks) collect(key, check);
  }
  schema.checks = {};

  for (const [key, columns] of Object.entries(schema.tableConstraints ?? {})) {
    for (const constraint of Object.values(columns)) {
      if (!constraint.checks?.length) continue;
      // Collected under the table, not the column: the note belongs to the table either
      // way, and the constraint name already says which column it is about.
      for (const check of constraint.checks) collect(key, check);
      // pk and unique live on this same object and 3.14 understands both, so only the
      // checks are cleared.
      constraint.checks = [];
    }
  }

  // Two kinds of index cannot survive as an index, for unrelated reasons.
  //
  // An access method beyond btree or hash stops 3.14's grammar dead. The one we have is not
  // really an index anyway: it is what Postgres builds behind `cte_no_overlap`, the EXCLUDE
  // constraint that stops two entitlement validity periods overlapping (RF-AUS-04), and no
  // version of DBML can say EXCLUDE.
  //
  // An index over an *expression* — `coalesce(table_name, '')` on `uq_sheets_item`,
  // `lower(email)` on `uq_entity_contacts_email` — parses fine and then fails on import with
  // 'Index references non-existent column', because DBML indexes name columns and ChartDB
  // resolves each one against the table. The access method is irrelevant here; these are
  // ordinary btree indexes. This is the third thing DBML cannot express, alongside partial
  // predicates and EXCLUDE, and the only one that used to reach the file.
  //
  // Both are folded into the table note. Joining the parts back with ', ' undoes the split
  // @dbml/connector performs on an index's column list, which cuts on commas without regard
  // for parentheses: `daterange(valid_from, valid_to, '[]'::text)` arrives as three separate
  // expression columns. In the note it reads as documentation rather than as a schema object
  // someone might try to reproduce.
  for (const [key, indexes] of Object.entries(schema.indexes ?? {})) {
    const supported = [];
    for (const index of indexes) {
      const method = index.type?.toLowerCase();
      const methodOk = !method || CHARTDB_INDEX_TYPES.has(method);
      const overColumns = !index.columns.some((c) => c.type === 'expression');
      if (methodOk && overColumns) {
        supported.push(index);
        continue;
      }
      const columns = index.columns.map((c) => String(c.value).trim()).join(', ');
      const using = methodOk ? '' : ` USING ${method}`;
      note(key, `INDEX ${index.name}${using} (${columns})`);
    }
    schema.indexes[key] = supported;
  }

  // ChartDB does not keep the DBML it imported: it regenerates SQL from its own model, and
  // that generator drops everything after the first quoted literal in an expression default.
  // `('SOL-'::text || to_char(nextval('requests_folio_seq'::regclass), 'FM000000'::text))`
  // comes back out as `DEFAULT (SOL-)`, which fails to parse and takes the whole file with it.
  // The expression is valid DBML and 3.14 parses it happily, so this is invisible to the
  // parser check below — it surfaces only when ChartDB exports.
  //
  // Bare words (CURRENT_TIMESTAMP) and the JSON literals ({}, []) survive the round trip, so
  // the line is drawn at a parenthesis or an apostrophe: a default carrying a call or a quoted
  // literal comes off the column and goes to the note.
  for (const [key, fields] of Object.entries(schema.fields ?? {})) {
    for (const field of fields) {
      if (field.dbdefault?.type !== 'expression') continue;
      if (!/[(']/.test(field.dbdefault.value)) continue;
      note(key, `DEFAULT ${field.name}: ${field.dbdefault.value}`);
      delete field.dbdefault;
    }
  }

  for (const [key, lines] of notes) {
    const [schemaName, tableName] = key.split('.');
    const table = schema.tables.find((t) => t.name === tableName && t.schemaName === schemaName);
    if (!table) continue;
    table.note ??= { value: '' };
    table.note.value = [table.note.value, ...lines].filter(Boolean).join('\n');
  }

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
    return ChartDBParser.parse(text, 'dbml');
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

// Parsing is necessary and not sufficient, which the projects spine proved twice. `uq_sheets_item`,
// an index over coalesce(table_name, ''), parsed cleanly in 3.14 and then threw 'Index references
// non-existent column: COALESCE(table_name' when ChartDB built its model. `requests.folio`, whose
// default calls nextval(), parsed and imported and only broke when ChartDB regenerated SQL from
// what it had imported. Both are things ChartDB does *after* the parse, so both are done here too,
// over the same parse tree, and the failure lands on the migration that caused it instead of in a
// browser console days later.
function assertChartDBCanRender(database) {
  const offenders = [];
  for (const schema of database.schemas ?? []) {
    for (const table of schema.tables ?? []) {
      const fields = new Set((table.fields ?? []).map((f) => f.name));
      for (const index of table.indexes ?? []) {
        for (const column of index.columns ?? []) {
          if (column.type === 'column' && fields.has(column.value)) continue;
          offenders.push(
            `index ${table.name}.${index.name ?? '(unnamed)'} -> ${column.value}` +
              ' (expression indexes belong in the table note)'
          );
        }
      }
      for (const field of table.fields ?? []) {
        if (field.dbdefault?.type !== 'expression') continue;
        if (!/[(']/.test(String(field.dbdefault.value))) continue;
        offenders.push(
          `default ${table.name}.${field.name} = ${field.dbdefault.value}` +
            " (ChartDB's SQL export truncates it)"
        );
      }
    }
  }
  if (!offenders.length) return;
  console.error('Generated DBML parses but ChartDB cannot round-trip it:');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error('  Fold the construct into the table note in downgradeForChartDB().');
  process.exit(1);
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
assertChartDBCanRender(assertChartDBCanParse(dbml));

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
