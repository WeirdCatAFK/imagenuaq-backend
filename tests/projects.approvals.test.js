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
  roleId,
  sql,
} from "./helpers/fixtures.js";

// The sign-off (RF-FLW-03) and what a rejection does to the stage (§2.6).
describe("/api/projects/:id/stages/:stageId/approvals", () => {
  let server;
  let admin;
  let worker;
  let adminToken;
  let workerToken;
  let area;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();

    admin = await createActive({ email: ACCOUNTS[0], role: "admin" });
    worker = await createActive({ email: ACCOUNTS[1], role: "worker" });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await grantWorker([]);
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
    area = await createArea("Diseño de prueba");
  });

  async function grantWorker(permissions) {
    const res = await server.put(`/api/roles/${await roleId("worker")}/permissions`, {
      token: adminToken,
      body: { permissions },
    });
    assert.equal(res.status, 200);
  }

  async function project(stages = [{ areaId: null, title: "Diseño" }]) {
    const res = await server.post("/api/projects", {
      token: adminToken,
      body: {
        title: "Proyecto",
        stages: stages.map((s) => ({ ...s, areaId: s.areaId ?? area.id })),
      },
    });
    assert.equal(res.status, 201);
    return res.body.project;
  }

  const sign = (projectId, stageId, body, token = adminToken) =>
    server.post(`/api/projects/${projectId}/stages/${stageId}/approvals`, { token, body });

  test("approving completes the stage and reopens nothing", async () => {
    const made = await project();
    const stage = made.stages[0];

    const res = await sign(made.id, stage.id, { decision: "approved", comment: "Va" });

    assert.equal(res.status, 201);
    assert.equal(res.body.approval.decision, "approved");
    assert.equal(res.body.approval.approverUserId, admin.id);
    assert.equal(res.body.approval.approverName, null, "the insert shape carries no name; the read joins it");
    assert.equal(res.body.approval.comment, "Va");
    assert.equal(res.body.stage.status, "done");
    assert.ok(res.body.stage.endedAt);
    assert.deepEqual(res.body.reopened, []);

    const logs = await logsFor("project_stages", stage.id);
    assert.deepEqual(logs.map((l) => l.action), ["stage_activated", "stage_completed"]);
    assert.equal((await logsFor("approvals", res.body.approval.id)).length, 1);
  });

  test("rejecting completes the stage and opens the next attempt (RF-FLW-03)", async () => {
    const made = await project();
    const stage = made.stages[0];

    const res = await sign(made.id, stage.id, {
      decision: "rejected",
      comment: "Faltan los logotipos",
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.stage.status, "done", "the attempt that was rejected closes");
    assert.equal(res.body.reopened.length, 1);

    const rerun = res.body.reopened[0];
    assert.equal(rerun.attempt, 2);
    assert.equal(rerun.status, "active");
    assert.equal(rerun.title, stage.title);
    assert.equal(String(rerun.areaId), String(area.id));
    assert.notEqual(rerun.id, stage.id);

    // Both attempts stay readable: the history is not overwritten.
    const read = await server.get(`/api/projects/${made.id}`, { token: adminToken });
    assert.deepEqual(read.body.project.stages.map((s) => [s.attempt, s.status]), [[1, "done"], [2, "active"]]);
    assert.deepEqual(read.body.project.activeStageIds, [rerun.id]);
    assert.equal(read.body.project.stages[0].approvals.length, 1);
    assert.equal(read.body.project.stages[0].approvals[0].approverName, admin.full_name);
  });

  test("the rerun keeps the assignee", async () => {
    const made = await project([{ areaId: area.id, title: "Diseño", assignedTo: worker.id }]);
    const res = await sign(made.id, made.stages[0].id, { decision: "rejected" });

    assert.equal(res.status, 201);
    assert.equal(String(res.body.reopened[0].assignedTo), String(worker.id));
  });

  test("a rejected rerun can be approved, and the attempts pile up in order", async () => {
    const made = await project();

    const first = await sign(made.id, made.stages[0].id, { decision: "rejected" });
    const second = await sign(made.id, first.body.reopened[0].id, { decision: "approved" });

    assert.equal(second.status, 201);
    assert.equal(second.body.stage.attempt, 2);
    assert.equal(second.body.stage.status, "done");
    assert.deepEqual(second.body.reopened, []);

    const stages = await server.get(`/api/projects/${made.id}/stages`, { token: adminToken });
    assert.deepEqual(stages.body.stages.map((s) => s.attempt), [1, 2]);
  });

  test("a blocked stage can still be signed off", async () => {
    const made = await project();
    await server.patch(`/api/projects/${made.id}/stages/${made.stages[0].id}`, {
      token: adminToken,
      body: { status: "waiting_external", blockedReason: "Esperando la conformidad" },
    });

    const res = await sign(made.id, made.stages[0].id, { decision: "approved" });
    assert.equal(res.status, 201);
    assert.equal(res.body.stage.status, "done");
  });

  test("a stage that is not open cannot be signed off twice", async () => {
    const made = await project();
    assert.equal((await sign(made.id, made.stages[0].id, { decision: "approved" })).status, 201);

    const again = await sign(made.id, made.stages[0].id, { decision: "approved" });
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /Only an open stage/);
  });

  test("a pending stage cannot be signed off", async () => {
    const made = await project([
      { areaId: area.id, title: "Primera", seq: 1 },
      { areaId: area.id, title: "Segunda", seq: 2 },
    ]);
    const pending = made.stages.find((s) => s.status === "pending");

    const res = await sign(made.id, pending.id, { decision: "approved" });
    assert.equal(res.status, 409);
  });

  test("evidence is accepted, and an unknown file is a 400", async () => {
    const made = await project();

    const bad = await sign(made.id, made.stages[0].id, { decision: "approved", evidenceFileId: 999999 });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /referenced record/);

    // The stage survived the failed attempt: nothing was half-written.
    const stages = await server.get(`/api/projects/${made.id}/stages`, { token: adminToken });
    assert.equal(stages.body.stages[0].status, "active");
    assert.equal((await sql("select count(*)::int as n from approvals"))[0].n, 0);
  });

  test("refuses a decision that is neither", async () => {
    const made = await project();
    const res = await sign(made.id, made.stages[0].id, { decision: "quizás" });

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /approved|rejected/);
  });

  test("any project.write holder may sign, and no one else", async () => {
    const made = await project();

    assert.equal((await sign(made.id, made.stages[0].id, { decision: "approved" }, workerToken)).status, 403);

    await grantWorker(["project.read", "project.write"]);
    try {
      // The worker is in no area of this project, and signs anyway: the permission is the policy.
      const res = await sign(made.id, made.stages[0].id, { decision: "approved" }, workerToken);
      assert.equal(res.status, 201);
      assert.equal(res.body.approval.approverUserId, worker.id);
    } finally {
      await grantWorker([]);
    }
  });

  test("a stage of another project is a 404", async () => {
    const mine = await project();
    const theirs = await project();

    assert.equal((await sign(theirs.id, mine.stages[0].id, { decision: "approved" })).status, 404);
  });
});
