import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server.js';
import {
  reset,
  resetCases,
  createActive,
  createSchema,
  tokenFor,
  logsFor,
  sql,
  TEST_SCHEMA_PREFIX,
} from './helpers/fixtures.js';

// Templates the RF-SOL-01 way: a format is started from another one by copying its latest
// fields into a new identity's version 1.
describe('POST /api/schemas/:id/clone', () => {
  let server;
  let admin;
  let adminToken;
  let workerToken;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: ACCOUNTS[0], role: 'admin' });
    await createActive({ email: ACCOUNTS[1], role: 'worker' });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  function clone(id, body, token = adminToken) {
    return server.post(`/api/schemas/${id}/clone`, { token, body });
  }

  test('copies the LATEST version, not version 1', async () => {
    const source = await createSchema('origen');
    const v2 = await server.post(`/api/schemas/${source.id}/versions`, {
      token: adminToken,
      body: {
        fields: {
          deliverables: [
            { code: 'evento', name: 'Evento', type: 'text', required: true },
            { code: 'fecha', name: 'Fecha', type: 'date' },
          ],
          information: [],
        },
      },
    });
    assert.equal(v2.status, 201);

    const res = await clone(source.id, { code: `${TEST_SCHEMA_PREFIX}copia`, name: 'Copia' });

    assert.equal(res.status, 201);
    const { schema } = res.body;
    assert.equal(schema.code, `${TEST_SCHEMA_PREFIX}copia`);
    assert.equal(schema.version, 1);
    assert.equal(schema.publishedBy, admin.id);
    assert.deepEqual(schema.fields.deliverables.map((f) => f.code), ['evento', 'fecha']);
    assert.deepEqual(schema.fields.information, []);
    assert.notEqual(schema.id, source.id);

    // The copy is its own identity: a version on it does not touch the source.
    const [row] = await sql('select count(*)::int as n from schema_versions where schema_id = $1', [source.id]);
    assert.equal(row.n, 2);

    const logs = await logsFor('schemas', schema.id);
    assert.deepEqual(logs.map((l) => l.action), ['record_created']);
    assert.equal(logs[0].after_data.cloned_from, source.id);
  });

  test('a seeded starter format clones', async () => {
    const [starter] = await sql("select id from schemas where code = 'papel_institucional'");
    const res = await clone(starter.id, { code: `${TEST_SCHEMA_PREFIX}papel_fcq`, name: 'Papel FCQ' });

    assert.equal(res.status, 201);
    assert.ok(res.body.schema.fields.deliverables.some((f) => f.code === 'tiraje' && f.required === true));
  });

  test('refuses a taken code with 409 and leaves nothing behind', async () => {
    const source = await createSchema('fuente');
    await createSchema('tomado');

    const res = await clone(source.id, { code: `${TEST_SCHEMA_PREFIX}tomado`, name: 'Tomado' });

    assert.equal(res.status, 409);
    const [row] = await sql('select count(*)::int as n from schemas where code like $1', [`${TEST_SCHEMA_PREFIX}%`]);
    assert.equal(row.n, 2);
  });

  test('404s on an unknown source, 400 without code or name', async () => {
    assert.equal((await clone(999999, { code: `${TEST_SCHEMA_PREFIX}x`, name: 'X' })).status, 404);

    const source = await createSchema('fuente2');
    assert.equal((await clone(source.id, { name: 'Sin código' })).status, 400);
    assert.equal((await clone(source.id, { code: `${TEST_SCHEMA_PREFIX}sin_nombre` })).status, 400);
  });

  test('needs schema.manage', async () => {
    const source = await createSchema('fuente3');
    const res = await clone(source.id, { code: `${TEST_SCHEMA_PREFIX}w`, name: 'W' }, workerToken);
    assert.equal(res.status, 403);
  });
});
