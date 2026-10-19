// A stage's delivery (RF-FLW-03): the written evidence plus an optional file from the project's
// folder, handed in by the person on the stage without `project.write`, and blank again on a rerun.
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
  grantPermissions,
} from "./helpers/fixtures.js";

describe("/api/projects/:id/stages/:stageId/delivery", () => {
  let server;
  let adminToken;
  let design;
  let ana;
  let anaToken;
  let betoToken;

  const ADMIN = "coordinacion@uaq.mx";

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "worker", [
      "project.read", "document.read", "document.write",
    ]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    design = await createArea("Diseño");
    ana = await createActive({ email: "ana@uaq.mx", area: design.name, fullName: "Ana" });
    await createActive({ email: "beto@uaq.mx", area: design.name, fullName: "Beto" });
    anaToken = await tokenFor(server, "ana@uaq.mx");
    betoToken = await tokenFor(server, "beto@uaq.mx");
  });

  async function activeStage(body = {}) {
    const made = await server.post("/api/projects", { token: adminToken, body: { title: "Proyecto" } });
    const stage = await server.post(`/api/projects/${made.body.project.id}/stages`, {
      token: adminToken,
      body: { areaId: design.id, title: "Diseño", status: "active", assignedTo: ana.id, ...body },
    });
    assert.equal(stage.status, 201);
    return { project: made.body.project, stage: stage.body.stage };
  }

  const deliver = (project, stage, body, token = anaToken) =>
    server.put(`/api/projects/${project.id}/stages/${stage.id}/delivery`, { token, body });

  test("the assignee uploads to the project folder and delivers with a note", async () => {
    const { project, stage } = await activeStage();
    const folder = await server.get(`/api/projects/${project.id}/folder`, { token: anaToken });
    assert.equal(folder.status, 200);
    const upload = await server.post(
      `/api/documents/folders/${folder.body.folder.id}/files?name=${encodeURIComponent("arte.pdf")}`,
      { token: anaToken, raw: Buffer.from("%PDF"), headers: { "content-type": "application/pdf" } },
    );
    assert.equal(upload.status, 201);

    const res = await deliver(project, stage, { note: "Arte final aprobado por la facultad", fileId: upload.body.file.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.stage.deliveryNote, "Arte final aprobado por la facultad");
    assert.equal(String(res.body.stage.deliveryFileId), String(upload.body.file.id));

    const detail = await server.get(`/api/projects/${project.id}`, { token: anaToken });
    const shown = detail.body.project.stages.find((one) => one.id === stage.id);
    assert.equal(shown.deliveryFileName, "arte.pdf");
    assert.equal(shown.deliveredByName, "Ana");

    const logs = await logsFor("project_stages", stage.id);
    assert.ok(logs.some((log) => log.action === "record_updated"));
  });

  test("the file is optional; the note is not", async () => {
    const { project, stage } = await activeStage();
    assert.equal((await deliver(project, stage, { note: "Se entregó en persona" })).status, 200);
    assert.equal((await deliver(project, stage, { note: "  " })).status, 400);
    assert.equal((await deliver(project, stage, { note: "x", fileId: 999999 })).status, 400);
  });

  test("someone else in the area cannot deliver, and a pending stage takes none", async () => {
    const { project, stage } = await activeStage();
    assert.equal((await deliver(project, stage, { note: "mío" }, betoToken)).status, 403);

    const later = await activeStage({ status: "pending" });
    assert.equal((await deliver(later.project, later.stage, { note: "antes" })).status, 409);
  });

  test("a rejected sign-off reopens the stage with a blank delivery and keeps the old one", async () => {
    const { project, stage } = await activeStage();
    await deliver(project, stage, { note: "Primera versión" });
    const signed = await server.post(`/api/projects/${project.id}/stages/${stage.id}/approvals`, {
      token: adminToken,
      body: { decision: "rejected", comment: "Falta el logo" },
    });
    assert.equal(signed.status, 201);

    const detail = await server.get(`/api/projects/${project.id}`, { token: adminToken });
    const [first, second] = detail.body.project.stages;
    assert.equal(first.deliveryNote, "Primera versión");
    assert.equal(second.attempt, 2);
    assert.equal(second.deliveryNote, null);
  });
});
