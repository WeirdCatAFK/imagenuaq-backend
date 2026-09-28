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
  roleId,
  sql,
  TEST_SCHEMA_PREFIX,
} from './helpers/fixtures.js';

// Request formats (RF-SOL-01): the identity, its immutable versions, and the field shape
// orchestration/schemas.js normalises before anything is stored.
describe('/api/schemas', () => {
  let server;
  let admin;
  let adminToken;
  let workerToken;

  const ACCOUNTS = ['coordinacion@uaq.mx', 'disenador@uaq.mx'];

  const FIELDS = {
    deliverables: [
      { code: 'tiraje', name: 'Tiraje', type: 'quantity', note: 'Total de piezas', required: true },
      { code: 'fecha_entrega', name: 'Fecha de entrega', type: 'date' },
    ],
    information: [
      { code: 'dependencia', name: 'Dependencia', type: 'text', note: '', required: true },
    ],
  };

  /** FIELDS with one section replaced, for the validation cases. */
  const withSection = (section, list) => ({ ...FIELDS, [section]: list });

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

  async function create(body, token = adminToken) {
    return server.post('/api/schemas', { token, body });
  }

  describe('POST /', () => {
    test('creates the schema and its version 1 with the fields normalised', async () => {
      const res = await create({ code: `${TEST_SCHEMA_PREFIX}papel`, name: 'Papel', fields: FIELDS });

      assert.equal(res.status, 201);
      const { schema } = res.body;
      assert.equal(schema.code, `${TEST_SCHEMA_PREFIX}papel`);
      assert.equal(schema.version, 1);
      assert.equal(schema.isActive, true);
      assert.ok(schema.schemaVersionId);

      // Both sections come back, in order, with the defaults filled in and baseType
      // attached from the data_types catalogue.
      assert.deepEqual(Object.keys(schema.fields), ['deliverables', 'information']);
      assert.deepEqual(schema.fields.deliverables.map((f) => f.code), ['tiraje', 'fecha_entrega']);
      assert.deepEqual(schema.fields.deliverables[0], {
        code: 'tiraje', name: 'Tiraje', type: 'quantity', note: 'Total de piezas',
        required: true, baseType: 'number',
      });
      // note and required defaulted, not dropped.
      assert.deepEqual(schema.fields.deliverables[1], {
        code: 'fecha_entrega', name: 'Fecha de entrega', type: 'date', note: '',
        required: false, baseType: 'date',
      });
      assert.equal(schema.fields.information[0].code, 'dependencia');
    });

    test('the publisher is the session, whatever the body says', async () => {
      const res = await create({
        code: `${TEST_SCHEMA_PREFIX}quien`, name: 'Quién', fields: FIELDS, publishedBy: 999999,
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.schema.publishedBy, admin.id);
    });

    test('writes record_created to the trail', async () => {
      const res = await create({ code: `${TEST_SCHEMA_PREFIX}traza`, name: 'Traza', fields: FIELDS });
      assert.equal(res.status, 201);

      const logs = await logsFor('schemas', res.body.schema.id);
      assert.deepEqual(logs.map((l) => l.action), ['record_created']);
      assert.equal(logs[0].user_id, admin.id);
    });

    test('refuses a taken code with 409', async () => {
      await createSchema('repetido');
      const res = await create({ code: `${TEST_SCHEMA_PREFIX}repetido`, name: 'Otra vez', fields: FIELDS });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'A schema with that code already exists.');
    });

    const BAD_FIELDS = [
      ['a code with spaces', withSection('information', [{ code: 'con espacio', name: 'X', type: 'text' }]), /snake_case/],
      ['an uppercase code', withSection('information', [{ code: 'Dependencia', name: 'X', type: 'text' }]), /snake_case/],
      ['an unknown type', withSection('information', [{ code: 'x', name: 'X', type: 'moneda' }]), /does not exist/],
      ['a non-boolean required', withSection('information', [{ code: 'x', name: 'X', type: 'text', required: 'si' }]), /required must be a boolean/],
      ['a note that is not a string', withSection('information', [{ code: 'x', name: 'X', type: 'text', note: 5 }]), /note must be a string/],
      ['no name', withSection('information', [{ code: 'x', name: ' ', type: 'text' }]), /must have a name/],
      ['a field that is not an object', withSection('information', ['dependencia']), /must be an object/],
      // The shape of the document itself.
      ['a flat array', [{ code: 'x', name: 'X', type: 'text' }], /not a flat array/],
      ['a missing section', { deliverables: [{ code: 'x', name: 'X', type: 'text' }] }, /"information" is required/],
      ['a section that is not an array', { deliverables: {}, information: [] }, /"deliverables" is required and must be an array/],
      ['an unknown section', { ...FIELDS, extras: [] }, /Unknown section "extras"/],
      ['both sections empty', { deliverables: [], information: [] }, /at least one field/],
    ];

    for (const [label, fields, message] of BAD_FIELDS) {
      test(`refuses ${label} with 400 naming the problem`, async () => {
        const res = await create({ code: `${TEST_SCHEMA_PREFIX}malo`, name: 'Malo', fields });
        assert.equal(res.status, 400);
        assert.match(res.body.error.message, message);
      });
    }

    test('refuses a code repeated ACROSS the two sections', async () => {
      // One namespace: the code is the key in requests.data and in project_field_values,
      // and neither knows which section it came from.
      const res = await create({
        code: `${TEST_SCHEMA_PREFIX}choque`,
        name: 'Choque',
        fields: {
          deliverables: [{ code: 'tiraje', name: 'Tiraje', type: 'quantity' }],
          information: [{ code: 'tiraje', name: 'Tiraje otra vez', type: 'text' }],
        },
      });

      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /repeated; codes are unique across both sections/);
    });

    test('accepts an empty section as long as the other is not', async () => {
      const res = await create({
        code: `${TEST_SCHEMA_PREFIX}solo_info`,
        name: 'Solo informacion',
        fields: { deliverables: [], information: [{ code: 'dependencia', name: 'Dependencia', type: 'text' }] },
      });

      assert.equal(res.status, 201);
      assert.deepEqual(res.body.schema.fields.deliverables, []);
      assert.equal(res.body.schema.fields.information.length, 1);
    });

    test('needs schema.manage', async () => {
      const res = await create({ code: `${TEST_SCHEMA_PREFIX}nope`, name: 'No', fields: FIELDS }, workerToken);
      assert.equal(res.status, 403);
    });
  });

  describe('reads', () => {
    test('lists every schema with its latest version, starters included', async () => {
      await createSchema('uno');
      const res = await server.get('/api/schemas', { token: workerToken });

      assert.equal(res.status, 200);
      const codes = res.body.schemas.map((s) => s.code);
      assert.ok(codes.includes(`${TEST_SCHEMA_PREFIX}uno`));
      const starter = res.body.schemas.find((x) => x.code === 'papel_institucional');
      assert.ok(starter, 'the seeded starter format');
      // The seeds were rewritten into the sections shape by schema-field-sections.
      assert.deepEqual(Object.keys(starter.fields), ['deliverables', 'information']);
      assert.ok(starter.fields.deliverables.some((f) => f.code === 'tiraje' && f.required === true));
      assert.ok(starter.fields.information.some((f) => f.code === 'numero_orden'));
    });

    test('GET /:id/versions lists newest first and GET /versions/:id reads one', async () => {
      const schema = await createSchema('versiones');
      const v2 = await server.post(`/api/schemas/${schema.id}/versions`, {
        token: adminToken,
        body: { fields: FIELDS },
      });
      assert.equal(v2.status, 201);
      assert.equal(v2.body.version.version, 2);

      const list = await server.get(`/api/schemas/${schema.id}/versions`, { token: workerToken });
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.versions.map((v) => v.version), [2, 1]);
      // Version 1 is what it was: the fixture's one-per-section document, not v2's.
      assert.equal(list.body.versions[1].fields.deliverables.length, 1);
      assert.equal(list.body.versions[1].fields.information.length, 1);

      const one = await server.get(`/api/schemas/versions/${v2.body.version.id}`, { token: workerToken });
      assert.equal(one.status, 200);
      assert.equal(one.body.version.schemaCode, `${TEST_SCHEMA_PREFIX}versiones`);
      assert.equal(one.body.version.fields.deliverables.length, 2);
    });

    test('404s on a missing schema or version', async () => {
      assert.equal((await server.get('/api/schemas/999999', { token: workerToken })).status, 404);
      assert.equal((await server.get('/api/schemas/999999/versions', { token: workerToken })).status, 404);
      assert.equal((await server.get('/api/schemas/versions/999999', { token: workerToken })).status, 404);
    });
  });

  describe('POST /:id/versions', () => {
    test('a published version cannot be edited in place, even by SQL', async () => {
      const schema = await createSchema('inmutable');
      await assert.rejects(
        sql('update schema_versions set fields = $2::jsonb where id = $1', [
          schema.schema_version_id,
          '{"deliverables": [], "information": []}',
        ]),
        /cannot be edited/,
      );
    });

    test('refuses a new version on an inactive schema', async () => {
      const schema = await createSchema('inactivo');
      assert.equal((await server.delete(`/api/schemas/${schema.id}`, { token: adminToken })).status, 200);

      const res = await server.post(`/api/schemas/${schema.id}/versions`, {
        token: adminToken,
        body: { fields: FIELDS },
      });
      assert.equal(res.status, 409);
    });
  });

  describe('PATCH /:id and DELETE /:id', () => {
    test('renames and reactivates, leaving versions alone', async () => {
      const schema = await createSchema('editable');
      assert.equal((await server.delete(`/api/schemas/${schema.id}`, { token: adminToken })).status, 200);

      const res = await server.patch(`/api/schemas/${schema.id}`, {
        token: adminToken,
        body: { name: 'Renombrado', isActive: true },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.schema.name, 'Renombrado');
      assert.equal(res.body.schema.isActive, true);
      assert.equal(res.body.schema.version, 1);

      const logs = await logsFor('schemas', schema.id);
      assert.deepEqual(logs.map((l) => l.action), ['record_deleted', 'record_updated']);
    });

    test('refuses an empty patch and a second deactivation', async () => {
      const schema = await createSchema('vacio');
      assert.equal((await server.patch(`/api/schemas/${schema.id}`, { token: adminToken, body: {} })).status, 400);
      assert.equal((await server.delete(`/api/schemas/${schema.id}`, { token: adminToken })).status, 200);
      assert.equal((await server.delete(`/api/schemas/${schema.id}`, { token: adminToken })).status, 409);
    });

    test('a worker granted schema.manage may write', async () => {
      const grant = await server.put(`/api/roles/${await roleId('worker')}/permissions`, {
        token: adminToken,
        body: { permissions: ['schema.manage'] },
      });
      assert.equal(grant.status, 200);
      try {
        const res = await create({ code: `${TEST_SCHEMA_PREFIX}worker`, name: 'Worker', fields: FIELDS }, workerToken);
        assert.equal(res.status, 201);
      } finally {
        await server.put(`/api/roles/${await roleId('worker')}/permissions`, {
          token: adminToken,
          body: { permissions: [] },
        });
      }
    });
  });
});
