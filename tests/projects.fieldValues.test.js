import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  allLogs,
} from "./helpers/fixtures.js";

// The values that cross stages (RF-FLW-06): the order number diseño produces and the print
// shop's billing reads, without re-capture.
describe("/api/projects/:id/field-values", () => {
  let server;
  let adminToken;
  let area;

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
    area = await createArea("Diseño de prueba");
  });

  async function project(body = {}) {
    const res = await server.post("/api/projects", {
      token: adminToken,
      body: { title: "Proyecto", ...body },
    });
    assert.equal(res.status, 201);
    return res.body.project;
  }

  const setValue = (projectId, key, body) =>
    server.put(`/api/projects/${projectId}/field-values/${key}`, { token: adminToken, body });

  test("writes a value with the stage that produced it", async () => {
    const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
    const stage = made.stages[0];

    const res = await setValue(made.id, "numero_orden", {
      value: "A-77",
      producedByStageId: stage.id,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.fieldValue.key, "numero_orden");
    assert.equal(res.body.fieldValue.value, "A-77");
    assert.equal(String(res.body.fieldValue.producedByStageId), String(stage.id));

    const list = await server.get(`/api/projects/${made.id}/field-values`, { token: adminToken });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.fieldValues.map((v) => v.key), ["numero_orden"]);
  });

  test("a correction is an update that keeps the provenance", async () => {
    const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
    const stage = made.stages[0];

    const first = await setValue(made.id, "numero_orden", { value: "A-77", producedByStageId: stage.id });
    const second = await setValue(made.id, "numero_orden", { value: "A-78" });

    assert.equal(second.status, 200);
    assert.equal(second.body.fieldValue.value, "A-78");
    assert.equal(
      String(second.body.fieldValue.producedByStageId),
      String(stage.id),
      "the provenance survives a correction that does not name a stage",
    );
    assert.ok(
      new Date(second.body.fieldValue.updatedAt) >= new Date(first.body.fieldValue.updatedAt),
      "updated_at moved",
    );

    // Still one row: the key is unique per project.
    const list = await server.get(`/api/projects/${made.id}/field-values`, { token: adminToken });
    assert.equal(list.body.fieldValues.length, 1);

    // Created once, then updated: the trail says so without a table of its own.
    const logs = (await allLogs()).filter((l) => l.target_table === "project_field_values");
    assert.deepEqual(logs.map((l) => l.action), ["record_created", "record_updated"]);
  });

  test("stringifies numbers and booleans", async () => {
    const made = await project();

    assert.equal((await setValue(made.id, "tiraje", { value: 500 })).body.fieldValue.value, "500");
    assert.equal((await setValue(made.id, "urgente", { value: true })).body.fieldValue.value, "true");
  });

  test("refuses an empty value, pointing at delete", async () => {
    const made = await project();

    const empty = await setValue(made.id, "pantone", { value: "   " });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /delete the row/);

    assert.equal((await setValue(made.id, "pantone", { value: null })).status, 400);
  });

  test("refuses a key that is not snake_case", async () => {
    const made = await project();

    const res = await setValue(made.id, "NumeroOrden", { value: "A-77" });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /snake_case/);
  });

  test("refuses a stage that belongs to another project", async () => {
    const mine = await project();
    const theirs = await project({ stages: [{ areaId: area.id, title: "Ajena" }] });

    const res = await setValue(mine.id, "numero_orden", {
      value: "A-77",
      producedByStageId: theirs.stages[0].id,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /stage of this project/);
  });

  test("delete removes it, and a second delete is a 404", async () => {
    const made = await project();
    await setValue(made.id, "numero_orden", { value: "A-77" });

    const res = await server.delete(`/api/projects/${made.id}/field-values/numero_orden`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.fieldValue.value, "A-77");

    const again = await server.delete(`/api/projects/${made.id}/field-values/numero_orden`, {
      token: adminToken,
    });
    assert.equal(again.status, 404);
    assert.match(again.body.error.message, /no value under that key/);
  });

  test("404s on a project that does not exist", async () => {
    assert.equal((await server.get("/api/projects/999999/field-values", { token: adminToken })).status, 404);
    assert.equal((await setValue(999999, "numero_orden", { value: "A" })).status, 404);
  });

  test("a value written by one stage is found by RF-IMP-08's lookup", async () => {
    const made = await project({ key: "IMP-1", stages: [{ areaId: area.id, title: "Diseño" }] });
    await setValue(made.id, "numero_orden", { value: "A-77", producedByStageId: made.stages[0].id });

    const found = await server.get("/api/projects?fieldKey=numero_orden&fieldValue=A-77", {
      token: adminToken,
    });
    assert.deepEqual(found.body.projects.map((p) => p.key), ["IMP-1"]);
  });
});
