import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  createSchema,
  tokenFor,
  logsFor,
  sql,
} from "./helpers/fixtures.js";

// Routing by flow (request-flows, DATAMODEL.md §2.5): a request owns a copy of its flow, sits in
// the inbox of every area of the first phase, and hands the same phases to its project.
describe("a request's flow", () => {
  let server;
  let adminToken;
  let schema;
  let design;
  let texts;
  let print;

  const ACCOUNTS = ["coordinacion@uaq.mx"];

  const FIELDS = {
    deliverables: [{ code: "descripcion", name: "Descripción", type: "text", required: true }],
    information: [],
  };

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ACCOUNTS[0], role: "admin" });
    adminToken = await tokenFor(server, ACCOUNTS[0]);
  });

  after(async () => {
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    design = await createArea("Diseño de prueba");
    texts = await createArea("Textos de prueba");
    print = await createArea("Impresión de prueba");
    schema = await createSchema("papel", FIELDS);
  });

  const stage = (areaId, title, overrides = {}) => ({ areaId, title, estimatedDays: 2, ...overrides });

  // Two areas in parallel first, then the print shop.
  const phases = () => [
    { name: "Diseño", stages: [stage(design.id, "Propuesta"), stage(texts.id, "Textos")] },
    { name: "Producción", stages: [stage(print.id, "Imprimir", { outputs: ["numero_orden"] })] },
  ];

  async function request(overrides = {}) {
    const res = await server.post("/api/requests", {
      token: adminToken,
      body: { schemaId: schema.id, title: "Papel", data: { descripcion: "Hojas" }, ...overrides },
    });
    assert.equal(res.status, 201);
    return res.body.request;
  }

  async function template(code = "papel_flujo") {
    const res = await server.post("/api/workflows", {
      token: adminToken,
      body: { code, name: "Papel", phases: phases() },
    });
    assert.equal(res.status, 201);
    return res.body.workflow;
  }

  const setFlow = (id, body) => server.put(`/api/requests/${id}/flow`, { token: adminToken, body });
  const inbox = async (areaId) =>
    (await server.get(`/api/requests?areaId=${areaId}`, { token: adminToken })).body.requests.map((r) => r.id);

  test("applying a template copies its latest version, and the template stays as it was", async () => {
    const made = await template();
    const mine = await request();

    const res = await setFlow(mine.id, { workflowId: made.id });
    assert.equal(res.status, 200);
    const flow = res.body.request.flow;
    assert.equal(flow.workflowVersionId, made.workflowVersionId);
    assert.equal(flow.workflowName, "Papel");
    assert.deepEqual(flow.phases.map((p) => p.name), ["Diseño", "Producción"]);

    const copied = flow.phases[0].stages.map((s) => s.id);
    const original = made.phases[0].stages.map((s) => s.id);
    assert.equal(copied.some((id) => original.includes(id)), false, "a copy, not the template's rows");

    const again = await server.get(`/api/workflows/${made.id}`, { token: adminToken });
    assert.deepEqual(again.body.workflow.phases[0].stages.map((s) => s.id), original);

    const logs = await logsFor("requests", mine.id);
    assert.equal(logs.at(-1).action, "record_updated");
  });

  test("a designed flow is validated, replaces the old one, and can be removed", async () => {
    const mine = await request();

    const bad = await setFlow(mine.id, { phases: [{ name: "Vacía", stages: [] }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /Phase 1 has no stages/);

    assert.equal((await setFlow(mine.id, { phases: phases() })).status, 200);
    const replaced = await setFlow(mine.id, { phases: [{ name: "Única", stages: [stage(print.id, "Imprimir")] }] });
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.body.request.flow.phases.map((p) => p.name), ["Única"]);
    assert.equal(replaced.body.request.flow.workflowVersionId, null, "designed here, from no template");

    const count = await sql("select count(*)::int as n from flow_phases where request_id = $1", [mine.id]);
    assert.equal(count[0].n, 1, "the old phases went");

    const removed = await server.delete(`/api/requests/${mine.id}/flow`, { token: adminToken });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.request.flow, null);
  });

  test("neither or both is a 400; an unknown or inactive template is refused", async () => {
    const made = await template();
    const mine = await request();

    assert.equal((await setFlow(mine.id, {})).status, 400);
    assert.equal((await setFlow(mine.id, { workflowId: made.id, phases: phases() })).status, 400);
    assert.equal((await setFlow(mine.id, { workflowId: 999999 })).status, 404);

    await server.delete(`/api/workflows/${made.id}`, { token: adminToken });
    assert.equal((await setFlow(mine.id, { workflowId: made.id })).status, 409);
  });

  test("it sits in the inbox of every first-phase area, and nowhere else", async () => {
    const routed = await request();
    const unrouted = await request({ title: "Sin repartir" });
    await setFlow(routed.id, { phases: phases() });

    assert.ok((await inbox(design.id)).includes(routed.id));
    assert.ok((await inbox(texts.id)).includes(routed.id));
    assert.ok(!(await inbox(print.id)).includes(routed.id), "second phase is not its inbox yet");

    const none = await inbox("none");
    assert.ok(none.includes(unrouted.id));
    assert.ok(!none.includes(routed.id), "a flow is a routing");

    const listed = await server.get(`/api/requests?areaId=${design.id}`, { token: adminToken });
    const row = listed.body.requests.find((r) => r.id === routed.id);
    assert.equal(row.hasFlow, true);
    assert.deepEqual([...row.firstPhaseAreas].sort(), [design.name, texts.name].sort());
  });

  test("a first-phase area may use its own statuses", async () => {
    const mine = await request();
    await setFlow(mine.id, { phases: phases() });
    const [own] = await sql(
      `insert into statuses (area_id, code, label, sort_order) values ($1, 'en_boceto', 'En boceto', 10)
       returning id`,
      [texts.id],
    );
    const [other] = await sql(
      `insert into statuses (area_id, code, label, sort_order) values ($1, 'en_prensa', 'En prensa', 10)
       returning id`,
      [print.id],
    );

    const ok = await server.put(`/api/requests/${mine.id}/status`, { token: adminToken, body: { statusId: own.id } });
    assert.equal(ok.status, 200);
    const refused = await server.put(`/api/requests/${mine.id}/status`, { token: adminToken, body: { statusId: other.id } });
    assert.equal(refused.status, 400);
  });

  describe("converting", () => {
    const convert = (id, body = {}) => server.post(`/api/requests/${id}/convert`, { token: adminToken, body });

    test("the project takes the same phases, the first one active", async () => {
      const made = await template();
      const mine = await request();
      const flowed = (await setFlow(mine.id, { workflowId: made.id })).body.request.flow;

      const res = await convert(mine.id);
      assert.equal(res.status, 201);
      const project = res.body.project;
      assert.equal(project.workflowVersionId, made.workflowVersionId);

      const definitions = flowed.phases.flatMap((p) => p.stages.map((s) => s.id)).sort();
      assert.deepEqual(project.stages.map((s) => s.flowStageId).sort(), definitions, "moved, not copied");
      assert.deepEqual(
        project.stages.map((s) => [s.title, s.status, s.phaseName]),
        [["Propuesta", "active", "Diseño"], ["Textos", "active", "Diseño"], ["Imprimir", "pending", "Producción"]],
      );
      assert.deepEqual(project.stages.find((s) => s.title === "Imprimir").outputs, ["numero_orden"]);

      const left = await sql("select count(*)::int as n from flow_phases where request_id = $1", [mine.id]);
      assert.equal(left[0].n, 0, "the request no longer owns phases");

      const logs = await logsFor("project_stages", project.stages[0].id);
      assert.deepEqual(logs.map((l) => l.action), ["stage_activated"]);
    });

    test("the suggested person becomes the assignee while still in the area", async () => {
      const stays = await createActive({ email: "queda@uaq.mx", role: "worker" });
      const leaves = await createActive({ email: "se_va@uaq.mx", role: "worker" });
      await sql("insert into area_members (area_id, user_id, is_area_leader) values ($1, $2, false), ($1, $3, false)", [
        design.id,
        stays.id,
        leaves.id,
      ]);
      const mine = await request();
      await setFlow(mine.id, {
        phases: [{
          name: "Diseño",
          stages: [
            stage(design.id, "Propuesta", { defaultAssigneeId: stays.id }),
            stage(design.id, "V.B.", { defaultAssigneeId: leaves.id }),
          ],
        }],
      });
      await sql("delete from area_members where user_id = $1", [leaves.id]);

      const res = await convert(mine.id);
      assert.equal(res.status, 201);
      const byTitle = Object.fromEntries(res.body.project.stages.map((s) => [s.title, s.assignedTo]));
      assert.equal(byTitle["Propuesta"], stays.id);
      assert.equal(byTitle["V.B."], null);

      const suggested = await sql(
        `select count(*)::int as n from flow_stages fs join flow_phases fp on fp.id = fs.phase_id
          where fp.project_id = $1 and fs.default_assignee_id is not null`,
        [res.body.project.id],
      );
      assert.equal(suggested[0].n, 0, "a project's stages carry an assignee, not a suggestion");
    });

    test("stages together with a flow is a 400", async () => {
      const mine = await request();
      await setFlow(mine.id, { phases: phases() });

      const res = await convert(mine.id, { stages: [{ areaId: design.id, title: "A mano" }] });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /already has a flow/);
    });

    test("another request's flow is dropped and reported", async () => {
      const first = await request();
      const second = await request({ title: "Otra" });
      await setFlow(first.id, { phases: phases() });
      await setFlow(second.id, { phases: [{ name: "Otra", stages: [stage(print.id, "Imprimir")] }] });

      const res = await convert(first.id, { requestIds: [second.id] });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.discardedFlows, [second.folio]);
      assert.deepEqual([...new Set(res.body.project.stages.map((s) => s.phaseName))], ["Diseño", "Producción"]);

      const left = await sql("select count(*)::int as n from flow_phases where request_id = $1", [second.id]);
      assert.equal(left[0].n, 0);
    });

    test("approving the first phase starts the next", async () => {
      const mine = await request();
      await setFlow(mine.id, { phases: phases() });
      const project = (await convert(mine.id)).body.project;
      const sign = (stageId) =>
        server.post(`/api/projects/${project.id}/stages/${stageId}/approvals`, {
          token: adminToken,
          body: { decision: "approved" },
        });

      const [proposal, textsStage] = project.stages.filter((s) => s.status === "active");
      assert.deepEqual((await sign(proposal.id)).body.opened, []);
      const last = await sign(textsStage.id);
      assert.deepEqual(last.body.opened.map((s) => s.title), ["Imprimir"]);
    });

    test("without a flow, conversion works as before", async () => {
      const mine = await request();
      const res = await convert(mine.id, { stages: [{ areaId: design.id, title: "A mano" }] });
      assert.equal(res.status, 201);
      assert.equal(res.body.project.workflowVersionId, null);
      assert.deepEqual(res.body.discardedFlows, []);
    });
  });
});
