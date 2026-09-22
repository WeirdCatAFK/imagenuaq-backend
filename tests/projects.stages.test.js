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

  test("the same area and seq again is the next attempt, not a collision", async () => {
    const made = await project();
    const first = await addStage(made.id, { areaId: area.id, title: "Diseño", seq: 1 });
    const second = await addStage(made.id, { areaId: area.id, title: "Diseño", seq: 1 });

    assert.equal(second.status, 201);
    assert.equal(first.body.stage.attempt, 1);
    assert.equal(second.body.stage.attempt, 2);
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
