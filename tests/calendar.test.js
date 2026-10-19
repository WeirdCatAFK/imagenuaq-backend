// The calendar (RF-CAL-02, RF-CAL-03, RF-CAL-05): stage events kept by the server, who sees what,
// absences without their reason, the recurrence subset, and closure windows that only mark.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  grantPermissions,
  sql,
} from "./helpers/fixtures.js";

/** Today plus `days`, as YYYY-MM-DD in Querétaro's time, which is how the server cuts days. */
function day(days = 0) {
  const now = new Date(Date.now() + days * 86_400_000);
  return now.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

describe("/api/calendar", () => {
  let server;
  let adminToken;
  let design;
  let print;
  let ana;
  let anaToken;
  let beto;

  const ADMIN = "coordinacion@uaq.mx";

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "worker", ["project.read", "task.read", "calendar.read"]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    design = await createArea("Diseño");
    print = await createArea("Impresión");
    ana = await createActive({ email: "ana@uaq.mx", area: design.name, fullName: "Ana" });
    beto = await createActive({ email: "beto@uaq.mx", area: design.name, fullName: "Beto" });
    await createActive({ email: "carla@uaq.mx", area: print.name, fullName: "Carla" });
    anaToken = await tokenFor(server, "ana@uaq.mx");
  });

  async function project(body = {}) {
    const res = await server.post("/api/projects", { token: adminToken, body: { title: "Proyecto", ...body } });
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

  const read = (token, query = "") =>
    server.get(`/api/calendar?from=${day(-1)}&to=${day(30)}${query}`, { token });

  test("an active stage is an event until the project's due date, following its assignee and its end", async () => {
    const made = await project({ title: "Cartel", dueOn: day(5) });
    const step = await stage(made.id, design.id, { title: "Diseño", assignedTo: ana.id, status: "active" });
    await stage(made.id, design.id, { title: "Aún no", assignedTo: ana.id });

    const res = await read(adminToken, "&scope=all");
    assert.equal(res.status, 200);
    const stages = res.body.events.filter((e) => e.kind === "stage");
    assert.deepEqual(stages.map((e) => e.title), [`${made.key} · Diseño`]);
    assert.equal(stages[0].userName, "Ana");
    assert.equal(stages[0].editable, false);
    const end = new Date(stages[0].endsAt).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    assert.equal(end, day(6));

    const moved = await server.put(`/api/tasks/stages/${step.id}/assignee`, {
      token: adminToken, body: { userId: beto.id },
    });
    assert.equal(moved.status, 200);
    const [who] = await sql(
      "select array_agg(user_id) as users from event_participants where event_id = $1 and user_id is not null",
      [stages[0].id],
    );
    assert.deepEqual(who.users.map(String), [String(beto.id)]);

    const signed = await server.post(`/api/projects/${made.id}/stages/${step.id}/approvals`, {
      token: adminToken, body: { decision: "approved" },
    });
    assert.equal(signed.status, 201);
    const later = await read(adminToken, "&scope=all");
    const still = later.body.events.find((e) => e.id === stages[0].id);
    assert.ok(new Date(still.endsAt) <= new Date(Date.now() + 2 * 86_400_000));
  });

  test("a project's due date is a marker, a renamed stage shows its new name, and a finished stage stays", async () => {
    const made = await project({ title: "Revista", dueOn: day(4) });
    const step = await stage(made.id, design.id, { title: "Maqueta", assignedTo: ana.id, status: "active" });
    await project({ title: "De otra área", dueOn: day(4) }).then((other) =>
      stage(other.id, print.id, { title: "Ajena", status: "active" }),
    );

    const renamed = await server.patch(`/api/projects/${made.id}/stages/${step.id}`, {
      token: adminToken, body: { title: "Maqueta final" },
    });
    assert.equal(renamed.status, 200);

    const res = await read(anaToken);
    const due = res.body.events.filter((e) => e.kind === "due");
    assert.deepEqual(due.map((e) => [e.title, e.day]), [[`${made.key} · Revista`, day(4)]]);
    const bar = res.body.events.find((e) => e.stageId === step.id);
    assert.equal(bar.title, `${made.key} · Maqueta final`);

    const signed = await server.post(`/api/projects/${made.id}/stages/${step.id}/approvals`, {
      token: adminToken, body: { decision: "approved" },
    });
    assert.equal(signed.status, 201);
    const after = await read(anaToken);
    assert.ok(after.body.events.some((e) => e.stageId === step.id), "a finished stage keeps its bar");
  });

  test("a worker sees their area and the global events, not another area; only coordination asks for all", async () => {
    const made = await project();
    await stage(made.id, design.id, { title: "De diseño", status: "active" });
    await stage(made.id, print.id, { title: "De impresión", status: "active" });
    const global = await server.post("/api/calendar/events", {
      token: adminToken,
      body: { type: "festivo", title: "Día de la UAQ", allDay: true, startsAt: `${day(2)}T06:00:00Z`, endsAt: `${day(3)}T06:00:00Z` },
    });
    assert.equal(global.status, 201);

    const res = await read(anaToken);
    assert.equal(res.status, 200);
    const titles = res.body.events.map((e) => e.title);
    assert.ok(titles.includes(`${made.key} · De diseño`));
    assert.ok(!titles.includes(`${made.key} · De impresión`));
    assert.ok(titles.includes("Día de la UAQ"));

    const mine = await read(anaToken, "&scope=mine");
    assert.deepEqual(mine.body.events.map((e) => e.title), ["Día de la UAQ"]);

    assert.equal((await read(anaToken, "&scope=all")).status, 403);
    assert.equal((await server.post("/api/calendar/events", { token: anaToken, body: {} })).status, 403);
  });

  test("absences come from the availability view, with no reason", async () => {
    const [type] = await sql("select id from absence_types where code = 'dia_institucional'");
    const [eventType] = await sql("select id from event_types where code = 'ausencia'");
    const [event] = await sql(
      `insert into events (event_type_id, title, starts_at, ends_at, all_day)
       values ($1, 'motivo-secreto', $2::date, $2::date + 2, true) returning id`,
      [eventType.id, day(1)],
    );
    await sql("insert into event_participants (event_id, user_id) values ($1, $2)", [event.id, beto.id]);
    await sql(
      `insert into absences (event_id, reason, absence_type_id, status) values ($1, 'privado', $2, 'approved')`,
      [event.id, type.id],
    );

    const res = await read(anaToken);
    const away = res.body.events.filter((e) => e.kind === "absence");
    assert.deepEqual(away.map((e) => e.userName), ["Beto"]);
    assert.ok(!JSON.stringify(res.body).includes("privado"));
    assert.ok(!JSON.stringify(res.body).includes("motivo-secreto"));
  });

  test("a yearly festivo repeats across years, an exception cancels one, and other rules are refused", async () => {
    const made = await server.post("/api/calendar/events", {
      token: adminToken,
      body: {
        type: "festivo", title: "Aniversario", allDay: true, rule: "FREQ=YEARLY",
        startsAt: "2024-12-12T06:00:00Z", endsAt: "2024-12-13T06:00:00Z",
      },
    });
    assert.equal(made.status, 201);
    await sql("insert into event_exceptions (event_id, original_start, is_cancelled) values ($1, '2025-12-12T06:00:00Z', true)", [made.body.id]);

    const dec = (year) => server.get(`/api/calendar?from=${year}-12-01&to=${year}-12-31&scope=all`, { token: adminToken });
    assert.equal((await dec(2026)).body.events.filter((e) => e.title === "Aniversario").length, 1);
    assert.equal((await dec(2025)).body.events.filter((e) => e.title === "Aniversario").length, 0);

    const daily = await server.post("/api/calendar/events", {
      token: adminToken,
      body: { title: "Diario", rule: "FREQ=DAILY", startsAt: "2026-01-01T16:00:00Z", endsAt: "2026-01-01T17:00:00Z" },
    });
    assert.equal(daily.status, 400);

    const moved = await server.patch(`/api/calendar/events/${made.body.id}`, {
      token: adminToken, body: { startsAt: "2024-12-11T06:00:00Z", endsAt: "2024-12-12T06:00:00Z" },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.rule, "FREQ=YEARLY");
  });

  test("a personal note reaches only its author, an area note the area, and only the author moves it", async () => {
    const betoToken = await tokenFor(server, "beto@uaq.mx");
    const note = (token, body) => server.post("/api/calendar/notes", { token, body: { day: day(2), ...body } });

    const personal = await note(anaToken, { text: "llevar cámara" });
    assert.equal(personal.status, 201);
    const shared = await note(anaToken, { text: "junta de diseño", scope: "area", areaId: design.id });
    assert.equal(shared.status, 201);
    assert.equal((await note(anaToken, { text: "x", scope: "area", areaId: print.id })).status, 403);
    assert.equal((await note(anaToken, { text: "x", scope: "global" })).status, 403);

    const notes = async (token, scope = "") =>
      (await read(token, scope)).body.events.filter((e) => e.kind === "note").map((e) => e.title).sort();
    assert.deepEqual(await notes(anaToken), ["junta de diseño", "llevar cámara"]);
    assert.deepEqual(await notes(betoToken), ["junta de diseño"]);
    assert.deepEqual(await notes(adminToken, "&scope=all"), ["junta de diseño"]);

    const foreign = await server.patch(`/api/calendar/notes/${personal.body.id}`, { token: betoToken, body: { text: "mío" } });
    assert.equal(foreign.status, 403);
    const moved = await server.patch(`/api/calendar/notes/${personal.body.id}`, { token: anaToken, body: { day: day(3) } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.day, day(3));
    assert.equal((await server.delete(`/api/calendar/notes/${shared.body.id}`, { token: anaToken })).status, 204);
    assert.deepEqual(await notes(betoToken), []);
  });

  test("closure windows never overlap and mark costed projects without blocking them", async () => {
    const window = await server.post("/api/calendar/closures", {
      token: adminToken, body: { name: "Cierre", startsOn: day(0), endsOn: day(40) },
    });
    assert.equal(window.status, 201);
    const clash = await server.post("/api/calendar/closures", {
      token: adminToken, body: { name: "Otro", startsOn: day(10), endsOn: day(50) },
    });
    assert.equal(clash.status, 409);

    const costed = await project({ title: "Con costo", hasCost: true, dueOn: day(5) });
    const free = await project({ title: "Sin costo", dueOn: day(5) });
    await stage(costed.id, design.id, { status: "active" });

    const detail = await server.get(`/api/projects/${costed.id}`, { token: adminToken });
    assert.equal(detail.body.project.inClosure, true);
    const other = await server.get(`/api/projects/${free.id}`, { token: adminToken });
    assert.equal(other.body.project.inClosure, false);

    const res = await read(adminToken, "&scope=all");
    assert.deepEqual(res.body.closures.map((c) => c.name), ["Cierre"]);
    assert.equal(res.body.events.find((e) => e.projectId === costed.id).inClosure, true);
  });
});
