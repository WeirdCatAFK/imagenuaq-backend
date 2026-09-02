#!/usr/bin/env node
// Generates a ChartDB metadata JSON from the Postgres database.
// Usage: npm run generateChartDB [-- --db <url>] [-- --out <path>]
// Output: chartdb.json in the project root
//
// Load it at https://chart.weirdcat.uk/ with Import database -> PostgreSQL -> paste the
// file contents into the "Smart Query output" box. ChartDB is a static frontend with no
// API, so that paste is the only way in; nothing here can push to it.

import { Connection } from 'postgrejs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

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

const outPath = resolve(flag('out', 'chartdb.json'));
const query = readFileSync(resolve(scriptDir, 'chartdb-metadata.sql'), 'utf8');

// A plain Connection rather than the pool in src/access/primitives: this is a one-shot dev
// script, and going through the app's access layer would put a documentation tool inside
// the runtime data path that ACCESS.md reserves for real resources.
const db = new Connection(url);
await db.connect();

try {
  const result = await db.query(query, { objectRows: true });
  const raw = result.rows?.[0]?.metadata_json_to_import;
  if (!raw) throw new Error('The metadata query returned no row.');

  // Re-serialize instead of writing the raw string: the query emits one very long line,
  // and pretty-printing makes the committed file reviewable in a diff. Parsing here also
  // fails loudly on malformed output rather than silently in ChartDB's paste box.
  const metadata = JSON.parse(raw);
  writeFileSync(outPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const tables = metadata.tables.filter((t) => t.type !== 'VIEW').length;
  console.log(
    `ChartDB metadata written to ${outPath} ` +
      `(${tables} tables, ${metadata.views.length} views, ${metadata.fk_info.length} relationships)`
  );
} finally {
  await db.close();
}
