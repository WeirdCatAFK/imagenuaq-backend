// Which projects `project.write` reaches (RF-USR-06): those the caller created, holds a stage of, or
// whose areas they belong to or lead from above. Anyone else reads them and changes nothing.
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

const ADMIN = "coordinacion@uaq.mx";

describe("project.write and taking part", () => {
  let server;
  let adminToken;
  let design;
  let print;
  let ana;
  let anaToken;
  let outsiderToken;
  let made;
  let stage;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
  });

  after(async () => {
    try {
      await grant([]);
      await reset();
    } finally {
      await server.close();
    }
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    await grant(["project.read", "project.write", "request.write"]);
    design = await createArea("Diseño de prueba");
    print = await createArea("Impresión de prueba");
    ana = await createActive({ email: "ana@uaq.mx", area: design.name });
    await createActive({ email: "otra@uaq.mx", area: print.name });
    anaToken = await tokenFor(server, "ana@uaq.mx");
    outsiderToken = await tokenFor(server, "otra@uaq.mx");
    made = await project([{ areaId: design.id, title: "Diseño" }]);
    [stage] = made.stages;
  });

  const grant = (permissions) => grantPermissions(server, adminToken, "worker", permissions);

  async function project(stages = [], token = adminToken) {
    const res = await server.post("/api/projects", { token, body: { title: "Proyecto", stages } });
    assert.equal(res.status, 201);
    return res.body.project;
  }

  const read = async (id, token) => (await server.get(`/api/projects/${id}`, { token })).body.project;
  const retitle = (id, token) => server.patch(`/api/projects/${id}`, { token, body: { title: "Otro" } });

  /** Every write of the router against `made`, each of which a stranger must be refused. */
  const writes = () => {
    const base = `/api/projects/${made.id}`;
    return [
      ["PATCH", () => server.patch(base, { token: outsiderToken, body: { title: "x" } })],
      ["status", () => server.put(`${base}/status`, { token: outsiderToken, body: { statusId: made.statusId } })],
      ["close", () => server.post(`${base}/close`, { token: outsiderToken, body: {} })],
      ["archive", () => server.post(`${base}/archive`, { token: outsiderToken, body: {} })],
      ["requests", () => server.post(`${base}/requests`, { token: outsiderToken, body: { requestIds: [1] } })],
      ["stages", () => server.post(`${base}/stages`, { token: outsiderToken, body: { areaId: print.id, title: "x" } })],
      ["stage", () => server.patch(`${base}/stages/${stage.id}`, { token: outsiderToken, body: { title: "x" } })],
      ["approval", () => server.post(`${base}/stages/${stage.id}/approvals`, { token: outsiderToken, body: { decision: "approved" } })],
      ["delivery", () => server.put(`${base}/stages/${stage.id}/delivery`, { token: outsiderToken, body: { note: "x" } })],
      ["value", () => server.put(`${base}/field-values/cantidad`, { token: outsiderToken, body: { value: "1" } })],
      ["delete value", () => server.delete(`${base}/field-values/cantidad`, { token: outsiderToken })],
      ["quote", () => server.post(`/api/finance/projects/${made.id}/quotes`, { token: outsiderToken, body: { amount: 1 } })],
      ["invoice", () => server.post(`/api/finance/projects/${made.id}/invoices`, { token: outsiderToken, body: { amount: 1 } })],
      ["DELETE", () => server.delete(base, { token: outsiderToken })],
    ];
  };

  test("a stranger reads the project and is refused every write", async () => {
    for (const [name, call] of writes()) assert.equal((await call()).status, 403, name);

    const seen = await read(made.id, outsiderToken);
    assert.equal(seen.editable, false);
    assert.equal(seen.stages[0].canDeliver, false);
    assert.equal(seen.title, "Proyecto");
    assert.equal(seen.archivedAt, null);
  });

  test("a project that does not exist is still a 404", async () => {
    assert.equal((await retitle(999999, outsiderToken)).status, 404);
    assert.equal((await server.delete("/api/projects/999999", { token: outsiderToken })).status, 404);
  });

  test("a stranger is refused on a quote already there", async () => {
    const quote = await server.post(`/api/finance/projects/${made.id}/quotes`, { token: anaToken, body: { amount: 5 } });
    assert.equal(quote.status, 201);
    const path = `/api/finance/quotes/${quote.body.quote.id}`;
    assert.equal((await server.patch(path, { token: outsiderToken, body: { amount: 1 } })).status, 403);
    assert.equal((await server.delete(path, { token: outsiderToken })).status, 403);
    assert.equal((await server.patch(path, { token: anaToken, body: { amount: 6 } })).status, 200);
  });

  test("a member of an area with a stage edits it", async () => {
    assert.equal((await read(made.id, anaToken)).editable, true);
    assert.equal((await retitle(made.id, anaToken)).status, 200);
  });

  test("a member of two areas takes part through either", async () => {
    const admin = await server.put(`/api/areas/${print.id}/members/${ana.id}`, { token: adminToken, body: {} });
    assert.equal(admin.status, 200);
    const theirs = await project([{ areaId: print.id, title: "Impresión" }]);
    assert.equal((await retitle(theirs.id, anaToken)).status, 200);
    assert.equal((await retitle(made.id, anaToken)).status, 200);
  });

  test("whoever created it edits it, with no stage of theirs", async () => {
    const own = await project([], outsiderToken);
    assert.equal(own.editable, true);
    assert.equal((await retitle(own.id, outsiderToken)).status, 200);
    assert.equal((await retitle(own.id, anaToken)).status, 403);
  });

  test("whoever holds a stage edits it after leaving the area", async () => {
    await server.patch(`/api/projects/${made.id}/stages/${stage.id}`, { token: adminToken, body: { assignedTo: ana.id } });
    await server.delete(`/api/areas/${design.id}/members/${ana.id}`, { token: adminToken });
    assert.equal((await retitle(made.id, anaToken)).status, 200);
  });

  test("a leader above the area edits it, and a plain member above does not", async () => {
    const above = await createArea("Coordinación de prueba");
    await server.put(`/api/areas/${design.id}/parent`, { token: adminToken, body: { parentAreaId: above.id } });
    await createActive({ email: "jefa@uaq.mx", area: above.name, isAreaLeader: true });
    await createActive({ email: "par@uaq.mx", area: above.name });

    assert.equal((await retitle(made.id, await tokenFor(server, "jefa@uaq.mx"))).status, 200);
    assert.equal((await retitle(made.id, await tokenFor(server, "par@uaq.mx"))).status, 403);
  });

  test("canSign is the stage's area leader, or one above, or coordination", async () => {
    const signs = async (token) => (await read(made.id, token)).stages[0].canSign;
    assert.equal(await signs(adminToken), true);
    assert.equal(await signs(anaToken), false);
    const above = await createArea("Arriba de prueba");
    await server.put(`/api/areas/${design.id}/parent`, { token: adminToken, body: { parentAreaId: above.id } });
    await createActive({ email: "jefa@uaq.mx", area: above.name, isAreaLeader: true });
    const boss = await tokenFor(server, "jefa@uaq.mx");
    assert.equal(await signs(boss), true);
    const signed = await server.post(`/api/projects/${made.id}/stages/${stage.id}/approvals`, {
      token: boss, body: { decision: "approved" },
    });
    assert.equal(signed.status, 201);
  });

  test("taking part without project.write changes nothing", async () => {
    await grant(["project.read"]);
    const seen = await read(made.id, anaToken);
    assert.equal(seen.editable, false);
    assert.equal((await retitle(made.id, anaToken)).status, 403);
  });

  test("finance.write uploads to any project without taking part", async () => {
    await createActive({ email: "hilda@uaq.mx", role: "finance" });
    const token = await tokenFor(server, "hilda@uaq.mx");
    const res = await server.post(`/api/finance/projects/${made.id}/invoices`, { token, body: { amount: 10 } });
    assert.equal(res.status, 201);
  });

  test("finance.write adds files inside a project's folder, and nowhere else", async () => {
    await createActive({ email: "hilda@uaq.mx", role: "finance" });
    const [{ id: roleId }] = await sql("select id from roles where name = 'finance'");
    const before = (await server.get(`/api/roles/${roleId}/permissions`, { token: adminToken })).body.permissions;
    const codes = before.map((one) => one.code);
    await grantPermissions(server, adminToken, "finance", [...new Set([...codes, "document.read", "document.write"])]);
    try {
      const token = await tokenFor(server, "hilda@uaq.mx");
      const upload = (folderId, as = token) =>
        server.post(`/api/documents/folders/${folderId}/files?name=factura.pdf`, {
          token: as, raw: Buffer.from(`%PDF ${folderId}`), headers: { "content-type": "application/pdf" },
        });

      const sub = await server.post("/api/documents/folders", { token, body: { parentId: made.folderId, name: "finanzas" } });
      assert.equal(sub.status, 201);
      assert.equal((await upload(sub.body.folder.id)).status, 201);
      assert.equal((await upload(made.folderId)).status, 201);

      const renamed = await server.patch(`/api/documents/folders/${made.folderId}`, { token, body: { name: "x" } });
      assert.equal(renamed.status, 403);

      const loose = await server.post("/api/documents/folders", { token: adminToken, body: { name: "Suelta" } });
      assert.equal((await upload(loose.body.folder.id)).status, 403);

      await grant(["project.read", "document.read", "document.write"]);
      assert.equal((await upload(made.folderId, outsiderToken)).status, 403, "needs finance.write");
    } finally {
      await grantPermissions(server, adminToken, "finance", codes);
    }
  });

  test("a stage goes only to a member of its area, when created and when reassigned", async () => {
    const outsider = (await sql("select id from users where email = 'otra@uaq.mx'"))[0].id;
    const onCreate = await server.post("/api/projects", {
      token: adminToken,
      body: { title: "X", stages: [{ areaId: design.id, title: "Diseño", assignedTo: outsider }] },
    });
    assert.equal(onCreate.status, 400);

    const path = `/api/projects/${made.id}/stages`;
    const added = await server.post(path, { token: adminToken, body: { areaId: design.id, title: "Otra", assignedTo: outsider } });
    assert.equal(added.status, 400);
    const moved = await server.patch(`${path}/${stage.id}`, { token: adminToken, body: { assignedTo: outsider } });
    assert.equal(moved.status, 400);
    assert.match(moved.body.error.message, /member of the stage's area/);
    assert.equal((await server.patch(`${path}/${stage.id}`, { token: adminToken, body: { assignedTo: ana.id } })).status, 200);
  });
});
