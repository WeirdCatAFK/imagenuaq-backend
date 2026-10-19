// Each person's stages, the area inbox and the load panel (RF-TSK-01 to RF-TSK-07): who may hand
// work out, urgency over arrival, and a load that counts open stages.
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
  sql,
} from "./helpers/fixtures.js";

describe("/api/tasks", () => {
  let server;
  let adminToken;
  let design;
  let print;
  let lead;
  let leadToken;
  let otherLeadToken;
  let ana;
  let anaToken;
  let beto;

  const ADMIN = "coordinacion@uaq.mx";

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "area_lead", [
      "project.read", "task.read", "task.write",
    ]);
    await grantPermissions(server, adminToken, "worker", ["project.read", "task.read"]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    design = await createArea("Diseño");
    print = await createArea("Impresión");
    lead = await createActive({
      email: "lider@uaq.mx", role: "area_lead", area: design.name, isAreaLeader: true, fullName: "Lía Líder",
    });
    await createActive({
      email: "otro@uaq.mx", role: "area_lead", area: print.name, isAreaLeader: true, fullName: "Otro Líder",
    });
    ana = await createActive({ email: "ana@uaq.mx", area: design.name, fullName: "Ana" });
    beto = await createActive({ email: "beto@uaq.mx", area: design.name, fullName: "Beto" });
    await createActive({ email: "carla@uaq.mx", area: print.name, fullName: "Carla" });
    leadToken = await tokenFor(server, "lider@uaq.mx");
    otherLeadToken = await tokenFor(server, "otro@uaq.mx");
    anaToken = await tokenFor(server, "ana@uaq.mx");
  });

  async function project(body = {}) {
    const res = await server.post("/api/projects", {
      token: adminToken,
      body: { title: "Proyecto", ...body },
    });
    assert.equal(res.status, 201);
    return res.body.project;
  }

  async function stage(projectId, areaId, body = {}) {
    const res = await server.post(`/api/projects/${projectId}/stages`, {
      token: adminToken,
      body: { areaId, title: "Etapa", ...body },
    });
    assert.equal(res.status, 201);
    return res.body.stage;
  }

  const signOff = (projectId, stageId) =>
    server.post(`/api/projects/${projectId}/stages/${stageId}/approvals`, {
      token: adminToken,
      body: { decision: "approved" },
    });

  test("«Mis tareas» lists my open stages, delivered ones until their sign-off", async () => {
    const made = await project();
    const mine = await stage(made.id, design.id, { title: "Diseño", assignedTo: ana.id, status: "active" });
    await stage(made.id, design.id, { title: "De Beto", assignedTo: beto.id, status: "active" });

    const delivered = await server.put(`/api/projects/${made.id}/stages/${mine.id}/delivery`, {
      token: anaToken,
      body: { note: "Arte final" },
    });
    assert.equal(delivered.status, 200);

    const res = await server.get("/api/tasks/mine", { token: anaToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stages.map((s) => s.title), ["Diseño"]);
    assert.equal(res.body.stages[0].deliveryNote, "Arte final");
    assert.equal(res.body.stages[0].deliveredByName, "Ana");

    assert.equal((await signOff(made.id, mine.id)).status, 201);
    const after = await server.get("/api/tasks/mine", { token: anaToken });
    assert.deepEqual(after.body.stages, []);
  });

  test("the inbox ranks by urgency, not arrival, and skips assigned stages", async () => {
    const calm = await project({ title: "Tranquilo", priority: 0 });
    const urgent = await project({ title: "Urgente", priority: 5 });
    await stage(calm.id, design.id, { title: "Primera en llegar" });
    await stage(urgent.id, design.id, { title: "Etapa urgente" });
    await stage(calm.id, design.id, { title: "Asignada", assignedTo: ana.id });
    await stage(calm.id, print.id, { title: "De otra área" });

    const res = await server.get(`/api/tasks/unassigned?areaId=${design.id}`, { token: leadToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i) => i.title), ["Etapa urgente", "Primera en llegar"]);

    assert.equal((await server.get(`/api/tasks/unassigned?areaId=${design.id}`, { token: anaToken })).status, 403);
  });

  test("another area's leader reads neither its inbox nor its load", async () => {
    for (const path of ["unassigned", "workload"]) {
      const res = await server.get(`/api/tasks/${path}?areaId=${design.id}`, { token: otherLeadToken });
      assert.equal(res.status, 403, path);
    }
    const own = await server.get(`/api/tasks/workload?areaId=${print.id}`, { token: otherLeadToken });
    assert.equal(own.status, 200);
    const any = await server.get(`/api/tasks/workload?areaId=${print.id}`, { token: adminToken });
    assert.equal(any.status, 200);
  });

  test("the overview gives coordination every area and a leader only theirs", async () => {
    const late = await project({ title: "Atrasado", dueOn: "2020-01-01" });
    await stage(late.id, design.id, { title: "Sin nadie" });
    await stage(late.id, design.id, { title: "De Ana", assignedTo: ana.id, status: "active" });
    await stage(late.id, print.id, { title: "En impresión" });

    const all = await server.get("/api/tasks/overview", { token: adminToken });
    assert.equal(all.status, 200);
    const byId = Object.fromEntries(all.body.areas.map((a) => [a.id, a]));
    assert.equal(byId[design.id].unassigned, 1);
    assert.equal(byId[design.id].late, 1);
    assert.equal(byId[print.id].unassigned, 1);
    const anaRow = byId[design.id].members.find((m) => m.name === "Ana");
    assert.deepEqual(anaRow.stages.map((s) => s.title), ["De Ana"]);
    assert.equal(anaRow.stages[0].projectTitle, "Atrasado");

    const mine = await server.get("/api/tasks/overview", { token: leadToken });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.areas.map((a) => a.id), [design.id]);

    assert.equal((await server.get("/api/tasks/overview", { token: anaToken })).status, 403);
  });

  test("a leader assigns an inbox stage to a member, and only to one", async () => {
    const made = await project();
    const step = await stage(made.id, design.id);

    const bad = await server.put(`/api/tasks/stages/${step.id}/assignee`, {
      token: leadToken, body: { userId: lead.id + 9999 },
    });
    assert.equal(bad.status, 400);

    const other = await server.put(`/api/tasks/stages/${step.id}/assignee`, {
      token: otherLeadToken, body: { userId: ana.id },
    });
    assert.equal(other.status, 403);

    const ok = await server.put(`/api/tasks/stages/${step.id}/assignee`, {
      token: leadToken, body: { userId: ana.id },
    });
    assert.equal(ok.status, 200);
    assert.equal(String(ok.body.stage.assignedTo), String(ana.id));

    const logs = await logsFor("project_stages", step.id);
    assert.ok(logs.some((log) => log.action === "record_updated"));
  });

  test("the review queue lists delivered stages of the areas I lead, and I sign them from it", async () => {
    const made = await project({ title: "Revisión" });
    const done = await stage(made.id, design.id, { title: "Entregada", assignedTo: ana.id, status: "active" });
    await stage(made.id, design.id, { title: "Sin entregar", assignedTo: ana.id, status: "active" });
    const elsewhere = await stage(made.id, print.id, { title: "De impresión", status: "active" });
    for (const [s, token] of [[done, anaToken], [elsewhere, adminToken]]) {
      const res = await server.put(`/api/projects/${made.id}/stages/${s.id}/delivery`, {
        token, body: { note: "Listo" },
      });
      assert.equal(res.status, 200);
    }

    const queue = await server.get("/api/tasks/review", { token: leadToken });
    assert.equal(queue.status, 200);
    assert.deepEqual(queue.body.stages.map((s) => s.title), ["Entregada"]);
    assert.equal(queue.body.stages[0].assignedToName, "Ana");
    const all = await server.get("/api/tasks/review", { token: adminToken });
    assert.deepEqual(all.body.stages.map((s) => s.title).sort(), ["De impresión", "Entregada"]);
    assert.equal((await server.get("/api/tasks/review", { token: anaToken })).status, 403);

    const foreign = await server.post(`/api/tasks/stages/${elsewhere.id}/approvals`, {
      token: leadToken, body: { decision: "approved" },
    });
    assert.equal(foreign.status, 403);

    const signed = await server.post(`/api/tasks/stages/${done.id}/approvals`, {
      token: leadToken, body: { decision: "rejected", comment: "Falta el logo" },
    });
    assert.equal(signed.status, 201);
    assert.equal(signed.body.approval.decision, "rejected");
    assert.equal(signed.body.reopened.length, 1);
    const after = await server.get("/api/tasks/review", { token: leadToken });
    assert.deepEqual(after.body.stages, []);
  });

  test("load counts open stages, and the suggestion skips who is away", async () => {
    const made = await project();
    await stage(made.id, design.id, { assignedTo: ana.id });
    await stage(made.id, design.id, { assignedTo: ana.id, status: "active" });
    const finished = await stage(made.id, design.id, { assignedTo: beto.id, status: "active" });
    assert.equal((await signOff(made.id, finished.id)).status, 201);

    const [type] = await sql("select id from absence_types where code = 'dia_institucional'");
    const [eventType] = await sql("select id from event_types where code = 'ausencia'");
    const [event] = await sql(
      `insert into events (event_type_id, title, starts_at, ends_at, all_day)
       values ($1, 'Fuera', '2026-11-03 00:00-06', '2026-11-05 00:00-06', true) returning id`,
      [eventType.id],
    );
    await sql("insert into event_participants (event_id, user_id) values ($1, $2)", [event.id, beto.id]);
    await sql(
      `insert into absences (event_id, reason, absence_type_id, status)
       values ($1, 'privado', $2, 'approved')`,
      [event.id, type.id],
    );

    const res = await server.get(
      `/api/tasks/workload?areaId=${design.id}&from=2026-11-02&to=2026-11-08`,
      { token: leadToken },
    );
    assert.equal(res.status, 200);
    const byName = Object.fromEntries(res.body.members.map((m) => [m.name, m]));
    assert.equal(byName.Ana.openStages, 2);
    assert.equal(byName.Beto.openStages, 0);
    assert.equal(byName.Beto.awayDays, 2);
    assert.deepEqual(byName.Beto.awayDates, ["2026-11-03", "2026-11-04"]);
    assert.equal(byName.Ana.stages.length, 2);
    assert.equal(byName["Lía Líder"].openStages, 0);
    assert.equal(res.body.members.find((m) => m.suggested).name, "Lía Líder");
    assert.ok(!JSON.stringify(res.body).includes("privado"));
  });
});
