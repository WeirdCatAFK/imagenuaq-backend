import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  logsFor,
  sql,
} from "./helpers/fixtures.js";

describe("POST /api/workflows/:id/clone", () => {
  let server;
  let adminToken;
  let design;

  const ACCOUNTS = ["coordinacion@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ACCOUNTS[0], role: "admin" });
    adminToken = await tokenFor(server, ACCOUNTS[0]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    design = await createArea("Diseño de prueba");
  });

  const stage = (overrides = {}) => ({
    areaId: design.id,
    title: "Propuesta",
    estimatedDays: 2,
    ...overrides,
  });

  async function template(phases, code = "origen") {
    const res = await server.post("/api/workflows", {
      token: adminToken,
      body: { code, name: "Origen", phases },
    });
    assert.equal(res.status, 201);
    return res.body.workflow;
  }

  const clone = (id, body) => server.post(`/api/workflows/${id}/clone`, { token: adminToken, body });

  test("copies the latest version into a new template's version 1", async () => {
    const source = await template([{ name: "Primera", stages: [stage()] }]);
    await server.post(`/api/workflows/${source.id}/versions`, {
      token: adminToken,
      body: {
        phases: [
          { name: "Recepción", stages: [stage({ title: "Revisar", outputs: ["folio"], outputNote: "Folio" })] },
          { name: "Diseño", stages: [stage(), stage({ title: "V.B." })] },
        ],
      },
    });

    const res = await clone(source.id, { code: "copia", name: "Copia" });
    assert.equal(res.status, 201);

    const copy = res.body.workflow;
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.version, 1);
    assert.deepEqual(copy.phases.map((p) => p.name), ["Recepción", "Diseño"]);
    assert.deepEqual(copy.phases[1].stages.map((s) => s.title), ["Propuesta", "V.B."]);
    assert.deepEqual(copy.phases[0].stages[0].outputs, ["folio"]);
    assert.equal(copy.phases[0].stages[0].outputNote, "Folio");

    const logs = await logsFor("workflows", copy.id);
    assert.equal(logs[0].action, "record_created");
    assert.equal(String(logs[0].after_data.cloned_from), String(source.id));
  });

  test("a default person who left the area is dropped from the copy", async () => {
    const person = await createActive({ email: "persona@uaq.mx", role: "worker" });
    await sql("insert into area_members (area_id, user_id, is_area_leader) values ($1, $2, false)", [
      design.id,
      person.id,
    ]);
    const source = await template([{ name: "A", stages: [stage({ defaultAssigneeId: person.id })] }]);

    await sql("delete from area_members where user_id = $1", [person.id]);

    const res = await clone(source.id, { code: "copia", name: "Copia" });
    assert.equal(res.status, 201);
    assert.equal(res.body.workflow.phases[0].stages[0].defaultAssigneeId, null);

    const original = await server.get(`/api/workflows/${source.id}`, { token: adminToken });
    assert.equal(original.body.workflow.phases[0].stages[0].defaultAssigneeId, person.id, "the source is untouched");
  });

  test("an unknown source is a 404; a taken code a 409", async () => {
    const source = await template([{ name: "A", stages: [stage()] }]);

    assert.equal((await clone(999999, { code: "copia", name: "Copia" })).status, 404);
    assert.equal((await clone(source.id, { code: "origen", name: "Copia" })).status, 409);
    assert.equal((await clone(source.id, { name: "Copia" })).status, 400);
  });
});
