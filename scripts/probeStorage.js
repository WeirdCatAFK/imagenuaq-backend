#!/usr/bin/env node
// Round-trips content through the real MinIO bucket and prints what came back at each step.
// Usage: npm run storage:probe
//
// A script and not a test because it answers questions about the live service -- is the
// bucket there, do the credentials work, does a second upload of the same bytes dedupe --
// against whatever bucket .env names, which the suite must never touch. The API-level cases
// in tests/documents.test.js run against their own bucket.
import { randomBytes } from 'node:crypto';
import { buffer } from 'node:stream/consumers';

import {
  openStorage,
  closeStorage,
  putContent,
  statContent,
  readContent,
  deleteContent,
} from '../src/access/primitives/minioStorage.js';

/** Prints a step and what it returned. */
function step(title, value) {
  console.log(`\n== ${title}`);
  console.dir(value, { depth: null });
}

try {
  await openStorage();
  step('bucket', process.env.MINIO_DOCUMENTS_BUCKET);

  const bytes = randomBytes(64 * 1024);
  const first = await putContent(bytes);
  step('put', first);

  const second = await putContent(bytes);
  step('put again (should say existed: true)', second);

  step('stat', await statContent(first.hash));

  const read = await readContent(first.hash);
  const back = await buffer(read.stream);
  step('read back matches', back.equals(bytes));

  step('delete', await deleteContent(first.hash));
  step('delete again (should be false)', await deleteContent(first.hash));
  step('stat after delete (should be null)', await statContent(first.hash));
} catch (error) {
  console.error(`\n${error.name} ${error.code ?? ''}: ${error.message}`);
  process.exitCode = 1;
} finally {
  closeStorage();
}
