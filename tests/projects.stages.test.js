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

// The stage machine (RF-FLW-01, RF-FLW-07). `done` is not reachable from here: a stage is
// completed by a sign-off, which projects.approvals covers.
describe("/api/projects/:id/stages", () => {
  let server;
  let adminToken;
  let area;
  let other;

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
    other = await createArea("Impresión de prueba");
  });

  async function project(body = {}) {
    const res = await server.post("/api/projects", {
      token: adminToken,
      body: { title: "Proyecto", ...body },
    });
    assert.equal(res.status, 201);
    return res.body.project;
  }

  const addStage = (projectId, body) =>
    server.post(`/api/projects/${projectId}/stages`, { token: adminToken, body });

  const patchStage = (projectId, stageId, body) =>
    server.patch(`/api/projects/${projectId}/stages/${stageId}`, { token: adminToken, body });

  test("adds a pending stage and lists it", async () => {
    const made = await project();

    const res = await addStage(made.id, { areaId: area.id, title: "Diseño" });
    assert.equal(res.status, 201);
    assert.equal(res.body.stage.status, "pending");
    assert.equal(res.body.stage.attempt, 1);
    assert.equal(res.body.stage.areaName, area.name);
    assert.equal(res.body.stage.startedAt, null);

    const list = await server.get(`/api/projects/${made.id}/stages`, { token: adminToken });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.stages.map((s) => s.title), ["Diseño"]);
  });

  test("an active stage is stamped and announced", async () => {
    const made = await project();
    const res = await addStage(made.id, { areaId: area.id, title: "Diseño", status: "active" });

    assert.equal(res.status, 201);
    assert.ok(res.body.stage.startedAt);

    const logs = await logsFor("project_stages", res.body.stage.id);
    assert.deepEqual(logs.map((l) => l.action), ["record_created", "stage_activated"]);
  });

  test("the same area and seq again is a second stage in that phase, not a rerun", async () => {
    const made = await project();
    const first = await addStage(made.id, { areaId: area.id, title: "Propuesta", seq: 1 });
    const second = await addStage(made.id, { areaId: area.id, title: "V.B. interno", seq: 1 });

    assert.equal(second.status, 201);
    assert.equal(first.body.stage.attempt, 1);
    assert.equal(second.body.stage.attempt, 1);
    assert.equal(second.body.stage.phaseId, first.body.stage.phaseId);
    assert.equal(first.body.stage.phaseName, "Fase 1");
    assert.notEqual(second.body.stage.flowStageId, first.body.stage.flowStageId);
    assert.deepEqual([first.body.stage.position, second.body.stage.position], [1, 2]);

    const phases = await logsFor("flow_phases", first.body.stage.phaseId);
    assert.deepEqual(phases.map((row) => row.action), ["record_created"]);
    const definitions = await logsFor("flow_stages", second.body.stage.flowStageId);
    assert.deepEqual(definitions.map((row) => row.action), ["record_created"]);
  });

  test("a new seq opens its own phase, and phases start at 1", async () => {
    const made = await project();
    const first = await addStage(made.id, { areaId: area.id, title: "Diseño", seq: 1 });
    const later = await addStage(made.id, { areaId: other.id, title: "Impresión", seq: 2 });

    assert.equal(later.status, 201);
    assert.equal(later.body.stage.phaseName, "Fase 2");
    assert.notEqual(later.body.stage.phaseId, first.body.stage.phaseId);

    const zero = await addStage(made.id, { areaId: area.id, title: "X", seq: 0 });
    assert.equal(zero.status, 400);
    assert.match(zero.body.error.message, /starts at 1/);
  });

  test("notes and days round-trip, and null clears them", async () => {
    const made = await project();
    const res = await addStage(made.id, {
      areaId: area.id,
      title: "Diseño",
      inputNote: "Oficio de la entidad",
      outputNote: "PDF de propuesta",
      estimatedDays: 4,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.stage.inputNote, "Oficio de la entidad");
    assert.equal(res.body.stage.outputNote, "PDF de propuesta");
    assert.equal(res.body.stage.estimatedDays, 4);

    const cleared = await patchStage(made.id, res.body.stage.id, {
      inputNote: null,
      estimatedDays: null,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.stage.inputNote, null);
    assert.equal(cleared.body.stage.estimatedDays, null);
    assert.equal(cleared.body.stage.outputNote, "PDF de propuesta");

    const tooLong = await addStage(made.id, { areaId: area.id, title: "X", estimatedDays: 400 });
    assert.equal(tooLong.status, 400);
  });

  test("a retitle reaches every attempt; a reassignment touches only one", async () => {
    const worker = await createActive({ email: "diseno@uaq.mx", role: "worker" });
    const made = await project();
    const res = await addStage(made.id, { areaId: area.id, title: "Diseño", status: "active" });
    const stage = res.body.stage;

    const rejected = await server.post(`/api/projects/${made.id}/stages/${stage.id}/approvals`, {
      token: adminToken,
      body: { decision: "rejected", comment: "Otra vez" },
    });
    assert.equal(rejected.status, 201);
    const rerun = rejected.body.reopened[0];
    assert.equal(rerun.flowStageId, stage.flowStageId);

    const retitled = await patchStage(made.id, rerun.id, { title: "Diseño corregido" });
    assert.equal(retitled.status, 200);
    const reassigned = await patchStage(made.id, rerun.id, { assignedTo: worker.id });
    assert.equal(reassigned.status, 200);

    const list = await server.get(`/api/projects/${made.id}/stages`, { token: adminToken });
    assert.deepEqual(
      list.body.stages.map((s) => [s.attempt, s.title, s.assignedTo]),
      [[1, "Diseño corregido", null], [2, "Diseño corregido", worker.id]],
    );
  });

  test("refuses to create a stage done or blocked", async () => {
    const made = await project();

    const done = await addStage(made.id, { areaId: area.id, title: "X", status: "done" });
    assert.equal(done.status, 400);
    assert.match(done.body.error.message, /completed by an approval/);

    const blocked = await addStage(made.id, { areaId: area.id, title: "X", status: "waiting_external" });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error.message, /cannot start blocked/);
  });

  test("refuses an unknown area or assignee as a 400", async () => {
    const made = await project();

    assert.equal((await addStage(made.id, { areaId: 999999, title: "X" })).status, 400);
    const badUser = await addStage(made.id, { areaId: area.id, title: "X", assignedTo: 999999 });
    assert.equal(badUser.status, 400);
    assert.match(badUser.body.error.message, /referenced record/);
  });

  test("pending to active stamps started_at; active to blocked needs a reason", async () => {
    const made = await project();
    const stage = (await addStage(made.id, { areaId: area.id, title: "Diseño" })).body.stage;

    const started = await patchStage(made.id, stage.id, { status: "active" });
    assert.equal(started.status, 200);
    assert.ok(started.body.stage.startedAt);

    const noReason = await patchStage(made.id, stage.id, { status: "waiting_external" });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error.message, /blockedReason is required/);

    const blocked = await patchStage(made.id, stage.id, {
      status: "waiting_external",
      blockedReason: "Falta la firma de la dependencia",
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.stage.blockedReason, "Falta la firma de la dependencia");
  });

  test("leaving the blocked state clears the reason", async () => {
    const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
    const stage = made.stages[0];

    await patchStage(made.id, stage.id, { status: "waiting_external", blockedReason: "Esperando" });
    const back = await patchStage(made.id, stage.id, { status: "active" });

    assert.equal(back.status, 200);
    assert.equal(back.body.stage.status, "active");
    assert.equal(back.body.stage.blockedReason, null);
  });

  test("cancelling stamps ended_at, and a finished stage cannot change status", async () => {
    const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
    const stage = made.stages[0];

    const cancelled = await patchStage(made.id, stage.id, { status: "cancelled" });
    assert.equal(cancelled.status, 200);
    assert.ok(cancelled.body.stage.endedAt);

    const again = await patchStage(made.id, stage.id, { status: "active" });
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /reruns instead/);
  });

  test("done is refused through the patch", async () => {
    const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
    const res = await patchStage(made.id, made.stages[0].id, { status: "done" });

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /recording an approval/);
  });

  test("reassigning and retitling work without touching the status", async () => {
    const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });
    const [{ id: userId }] = await sql("select id from users limit 1");

    const res = await patchStage(made.id, made.stages[0].id, {
      title: "Diseño de la propuesta",
      assignedTo: userId,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.stage.title, "Diseño de la propuesta");
    assert.equal(String(res.body.stage.assignedTo), String(userId));
    assert.equal(res.body.stage.status, "active", "untouched");
  });

  test("a stage of another project is a 404, not someone else's row", async () => {
    const mine = await project({ stages: [{ areaId: area.id, title: "Mía" }] });
    const theirs = await project({ stages: [{ areaId: other.id, title: "Ajena" }] });

    const res = await patchStage(theirs.id, mine.stages[0].id, { status: "cancelled" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.message, "Stage not found for that project.");
  });

  test("an empty patch and a missing project are refused", async () => {
    const made = await project({ stages: [{ areaId: area.id, title: "Diseño" }] });

    assert.equal((await patchStage(made.id, made.stages[0].id, {})).status, 400);
    assert.equal((await server.get("/api/projects/999999/stages", { token: adminToken })).status, 404);
    assert.equal((await addStage(999999, { areaId: area.id, title: "X" })).status, 404);
  });

  test("concurrent stages in two areas are both active (RF-FLW-09)", async () => {
    const made = await project({
      stages: [
        { areaId: area.id, title: "Diseño", seq: 1 },
        { areaId: other.id, title: "Impresión", seq: 1 },
      ],
    });

    // Same seq, so both start: the current stage is a set, not a pointer.
    assert.equal(made.activeStageIds.length, 2);
    assert.deepEqual(made.stages.map((s) => s.status), ["active", "active"]);
  });
});
