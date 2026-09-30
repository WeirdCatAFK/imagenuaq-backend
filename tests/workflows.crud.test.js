import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  softDelete,
  tokenFor,
  logsFor,
  sql,
} from "./helpers/fixtures.js";

// Flow templates (RF-FLW-02, RF-PRY-06): phases of parallel stages, published as immutable
// versions, written only by workflow.manage.
describe("/api/workflows", () => {
  let server;
  let admin;
  let adminToken;
  let workerToken;
  let design;
  let print;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();
    admin = await createActive({ email: ACCOUNTS[0], role: "admin" });
    await createActive({ email: ACCOUNTS[1], role: "worker" });
    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    design = await createArea("Diseño de prueba");
    print = await createArea("Impresión de prueba");
  });

  const stage = (overrides = {}) => ({
    areaId: design.id,
    title: "Propuesta de diseño",
    inputs: ["cotizacion"],
    outputs: ["propuesta_pdf"],
    inputNote: "Cotización firmada",
    outputNote: "PDF de propuesta",
    estimatedDays: 4,
    ...overrides,
  });

  const flow = () => [
    { name: "Diseño", stages: [stage(), stage({ title: "V.B. interno", estimatedDays: 1 })] },
    { name: "Producción", stages: [stage({ areaId: print.id, title: "Imprimir", outputs: [] })] },
  ];

  const create = (body, token = adminToken) => server.post("/api/workflows", { token, body });

  async function member(areaId, email) {
    const user = await createActive({ email, role: "worker" });
    await sql(
      `insert into area_members (area_id, user_id, is_area_leader) values ($1, $2, false)
       on conflict do nothing`,
      [areaId, user.id],
    );
    return user;
  }

  test("creates a template with its version 1, phases and stages in order", async () => {
    const res = await create({ code: "manual", name: "Manual de identidad", phases: flow() });

    assert.equal(res.status, 201);
    const made = res.body.workflow;
    assert.equal(made.code, "manual");
    assert.equal(made.version, 1);
    assert.equal(made.isActive, true);
    assert.equal(made.publishedBy, admin.id);
    assert.deepEqual(made.phases.map((p) => [p.seq, p.name]), [[1, "Diseño"], [2, "Producción"]]);
    assert.deepEqual(made.phases[0].stages.map((s) => [s.seq, s.title]), [
      [1, "Propuesta de diseño"],
      [2, "V.B. interno"],
    ]);

    const first = made.phases[0].stages[0];
    assert.equal(first.areaName, design.name);
    assert.deepEqual(first.inputs, ["cotizacion"]);
    assert.deepEqual(first.outputs, ["propuesta_pdf"]);
    assert.equal(first.inputNote, "Cotización firmada");
    assert.equal(first.estimatedDays, 4);
    assert.equal(first.defaultAssigneeId, null);

    const logs = await logsFor("workflows", made.id);
    assert.deepEqual(logs.map((l) => l.action), ["record_created"]);
  });

  test("lists templates with counts, and reads one", async () => {
    const made = (await create({ code: "manual", name: "Manual", phases: flow() })).body.workflow;

    const list = await server.get("/api/workflows", { token: adminToken });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.workflows.map((w) => [w.code, w.version, w.phaseCount, w.stageCount]),
      [["manual", 1, 2, 3]],
    );
    assert.equal(list.body.workflows[0].phases, undefined, "the list carries counts, not content");

    const one = await server.get(`/api/workflows/${made.id}`, { token: adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.workflow.phases.length, 2);

    assert.equal((await server.get("/api/workflows/999999", { token: adminToken })).status, 404);
  });

  test("publishing v2 leaves v1 as it was", async () => {
    const made = (await create({ code: "manual", name: "Manual", phases: flow() })).body.workflow;

    const v2 = await server.post(`/api/workflows/${made.id}/versions`, {
      token: adminToken,
      body: { phases: [{ name: "Todo junto", stages: [stage({ title: "Hacerlo" })] }] },
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version.version, 2);
    assert.equal(v2.body.version.code, "manual");
    assert.deepEqual(v2.body.version.phases.map((p) => p.name), ["Todo junto"]);

    const latest = await server.get(`/api/workflows/${made.id}`, { token: adminToken });
    assert.equal(latest.body.workflow.version, 2);

    const v1 = await server.get(`/api/workflows/versions/${made.workflowVersionId}`, {
      token: adminToken,
    });
    assert.equal(v1.status, 200);
    assert.deepEqual(v1.body.version.phases.map((p) => p.name), ["Diseño", "Producción"]);

    const versions = await server.get(`/api/workflows/${made.id}/versions`, { token: adminToken });
    assert.deepEqual(versions.body.versions.map((v) => [v.version, v.phaseCount]), [[2, 1], [1, 2]]);
  });

  test("a duplicate code is a 409, a missing one a 400", async () => {
    assert.equal((await create({ code: "manual", name: "A", phases: flow() })).status, 201);

    const again = await create({ code: "manual", name: "B", phases: flow() });
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /already exists/);

    assert.equal((await create({ name: "Sin código", phases: flow() })).status, 400);
    assert.equal((await create({ code: "x", phases: flow() })).status, 400);
  });

  test("each refusal names the phase and stage it is about", async () => {
    const cases = [
      [[], /non-empty array/],
      [[{ name: "Vacía", stages: [] }], /Phase 1 has no stages/],
      [[{ stages: [stage()] }], /Phase 1: name is required/],
      [[{ name: "A", stages: [stage(), stage({ areaId: 999999 })] }], /Phase 1, stage 2: area 999999 does not exist/],
      [[{ name: "A", stages: [stage({ outputs: ["NumeroOrden"] })] }], /Phase 1, stage 1: .*snake_case/],
      [[{ name: "A", stages: [stage({ estimatedDays: 0 })] }], /estimatedDays must be a whole number/],
      [[{ name: "A", stages: [stage({ estimatedDays: undefined })] }], /estimatedDays/],
      [[{ name: "A", stages: [stage({ title: "  " })] }], /title is required/],
    ];

    for (const [phases, message] of cases) {
      const res = await create({ code: "x", name: "X", phases });
      assert.equal(res.status, 400, `expected a 400 for ${JSON.stringify(phases)}`);
      assert.match(res.body.error.message, message);
    }
    assert.equal((await sql("select count(*)::int as n from workflows"))[0].n, 0);
  });

  test("a default person must be an active member of the stage's area", async () => {
    const inArea = await member(design.id, "miembro@uaq.mx");
    const outsider = await member(print.id, "fuera@uaq.mx");
    const gone = await member(design.id, "baja@uaq.mx");
    await softDelete(gone.id);

    const ok = await create({
      code: "con_persona",
      name: "Con persona",
      phases: [{ name: "A", stages: [stage({ defaultAssigneeId: inArea.id }), stage({ defaultAssigneeId: null })] }],
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.workflow.phases[0].stages[0].defaultAssigneeName, "Prueba Usuario");

    for (const user of [outsider, gone]) {
      const res = await create({
        code: `x_${user.id}`,
        name: "X",
        phases: [{ name: "A", stages: [stage({ defaultAssigneeId: user.id })] }],
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /is not an active member of/);
    }
  });

  test("an inactive template refuses a new version; rename and deactivate", async () => {
    const made = (await create({ code: "manual", name: "Manual", phases: flow() })).body.workflow;

    const renamed = await server.patch(`/api/workflows/${made.id}`, {
      token: adminToken,
      body: { name: "Manual de marca" },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.workflow.name, "Manual de marca");
    assert.equal(renamed.body.workflow.version, 1, "a rename publishes nothing");

    assert.equal((await server.patch(`/api/workflows/${made.id}`, { token: adminToken, body: {} })).status, 400);

    const gone = await server.delete(`/api/workflows/${made.id}`, { token: adminToken });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.workflow.isActive, false);
    assert.equal((await server.delete(`/api/workflows/${made.id}`, { token: adminToken })).status, 409);

    const publish = await server.post(`/api/workflows/${made.id}/versions`, {
      token: adminToken,
      body: { phases: flow() },
    });
    assert.equal(publish.status, 409);
    assert.match(publish.body.error.message, /inactive/);

    const logs = await logsFor("workflows", made.id);
    assert.deepEqual(logs.map((l) => l.action), ["record_created", "record_updated", "record_deleted"]);
  });

  test("reads need a session; writes need workflow.manage", async () => {
    assert.equal((await server.get("/api/workflows")).status, 401);
    assert.equal((await server.get("/api/workflows", { token: workerToken })).status, 200);
    assert.equal((await create({ code: "w", name: "W", phases: flow() }, workerToken)).status, 403);
  });

  test("an area a template uses cannot be deleted", async () => {
    assert.equal((await create({ code: "manual", name: "Manual", phases: flow() })).status, 201);

    const res = await server.delete(`/api/areas/${print.id}`, { token: adminToken });
    assert.equal(res.status, 409);
  });
});
