import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  sql,
} from "./helpers/fixtures.js";

// A published version is sealed by triggers, not by the API's good manners (flow-templates,
// DATAMODEL.md §2.2). These go around the API on purpose: the point is what the database
// refuses when something does.
describe("published flow templates are immutable", () => {
  let server;
  let adminToken;
  let design;
  let made;

  const ACCOUNTS = ["coordinacion@uaq.mx"];

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
    const res = await server.post("/api/workflows", {
      token: adminToken,
      body: {
        code: "sellada",
        name: "Sellada",
        phases: [{ name: "A", stages: [{ areaId: design.id, title: "Propuesta", estimatedDays: 2 }] }],
      },
    });
    assert.equal(res.status, 201);
    made = res.body.workflow;
  });

  async function refused(statement, params = []) {
    await assert.rejects(sql(statement, params), (err) => {
      assert.equal(err.code, "23514", err.message);
      return true;
    });
  }

  test("a version, its phases and its stages cannot be edited", async () => {
    await refused("update workflow_versions set version = 9 where id = $1", [made.workflowVersionId]);
    await refused("update flow_phases set name = 'Otra' where workflow_version_id = $1", [
      made.workflowVersionId,
    ]);
    await refused("update flow_stages set title = 'Otra' where id = $1", [made.phases[0].stages[0].id]);
  });

  test("nothing can be added to a published version", async () => {
    await refused(
      `insert into flow_stages (phase_id, seq, area_id, title) values ($1, 9, $2, 'Tarde')`,
      [made.phases[0].id, design.id],
    );
    await refused(
      `insert into flow_phases (workflow_version_id, seq, name) values ($1, 9, 'Tarde')`,
      [made.workflowVersionId],
    );
  });

  test("a project cannot run a template's stage directly", async () => {
    const project = await server.post("/api/projects", {
      token: adminToken,
      body: { title: "Proyecto", stages: [{ areaId: design.id, title: "Propia" }] },
    });
    assert.equal(project.status, 201);

    await refused("update project_stages set flow_stage_id = $1 where id = $2", [
      made.phases[0].stages[0].id,
      project.body.project.stages[0].id,
    ]);
  });

  test("a project's own definition stays editable", async () => {
    const project = await server.post("/api/projects", {
      token: adminToken,
      body: { title: "Proyecto", stages: [{ areaId: design.id, title: "Propia" }] },
    });
    const stage = project.body.project.stages[0];

    const res = await server.patch(`/api/projects/${project.body.project.id}/stages/${stage.id}`, {
      token: adminToken,
      body: { title: "Propia, corregida" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.stage.title, "Propia, corregida");
  });
});
