// Quotes, invoices, providers and the finance standing of a project (RF-FIN-01 to RF-FIN-10): areas
// upload, finance decides and reads the gaps, closing never waits on them, and finance files outlive
// the semester sweep.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

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
import { runJob } from "../src/scheduler.js";

const ADMIN = "coordinacion.finanzas@uaq.mx";
const FISCAL = "5FB2822E-396D-4725-8521-CDC4BDD20CCF";

describe("/api/finance", () => {
  let server;
  let adminToken;
  let area;
  let workerToken;
  let money;
  let moneyToken;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "worker", [
      "project.read", "project.write", "document.read", "document.write",
    ]);
  });

  after(async () => {
    try {
      await sql("update file_retention set months = 6, finance_months = 60, finance_keep_forever = false");
      await grantPermissions(server, adminToken, "worker", []);
      await resetCases();
      await reset();
    } finally {
      await server?.close();
    }
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    area = await createArea("Imprenta");
    await createActive({ email: "imprenta@uaq.mx", area: area.name });
    workerToken = await tokenFor(server, "imprenta@uaq.mx");
    money = await createActive({ email: "hilda@uaq.mx", role: "finance" });
    moneyToken = await tokenFor(server, "hilda@uaq.mx");
  });

  const project = async (body = {}) =>
    (await server.post("/api/projects", { token: adminToken, body: { title: "Papel institucional", ...body } }))
      .body.project;

  const upload = async (folderId, token = adminToken) =>
    (await server.post(`/api/documents/folders/${folderId}/files?name=factura.pdf`, {
      token,
      raw: randomBytes(16),
      headers: { "content-type": "application/pdf" },
    })).body.file;

  const quote = (projectId, body, token = workerToken) =>
    server.post(`/api/finance/projects/${projectId}/quotes`, { token, body });
  const invoice = (projectId, body, token = workerToken) =>
    server.post(`/api/finance/projects/${projectId}/invoices`, { token, body });
  const standing = async (projectId) =>
    (await server.get(`/api/finance/projects/${projectId}`, { token: moneyToken })).body.finance;

  describe("quotes", () => {
    test("an area uploads, finance decides, and each write is logged in the same statement", async () => {
      const made = await project();
      const file = await upload(made.folderId);

      const created = await quote(made.id, { amount: "1250.50", entity: "Facultad de Ingeniería", fileId: file.id });
      assert.equal(created.status, 201);
      assert.equal(created.body.quote.status, "issued");
      assert.equal(created.body.quote.amount, "1250.50");

      const decide = (decision, token = moneyToken) =>
        server.post(`/api/finance/quotes/${created.body.quote.id}/decision`, { token, body: { decision, comment: "Ok" } });
      assert.equal((await decide("approved", workerToken)).status, 403);
      assert.equal((await decide("in_review")).body.quote.status, "in_review");
      const approved = await decide("approved");
      assert.equal(approved.body.quote.status, "approved");
      assert.equal(String(approved.body.quote.decidedBy), String(money.id));
      assert.equal((await decide("rejected")).status, 409);

      const edit = await server.patch(`/api/finance/quotes/${created.body.quote.id}`, {
        token: workerToken,
        body: { amount: 10 },
      });
      assert.equal(edit.status, 409);

      const logs = await logsFor("quotes", created.body.quote.id);
      assert.deepEqual(logs.map((log) => log.action), ["quote_created", "quote_decided", "quote_decided"]);
      assert.equal(logs[1].before_data.status, "issued");
      assert.equal(logs[2].after_data.status, "approved");
    });

    test("a bad amount, an unknown provider or a file outside the project is refused", async () => {
      const made = await project();
      const other = await project({ title: "Otro" });
      const foreign = await upload(other.folderId);

      for (const amount of [undefined, -1, "12.345", "abc", true]) {
        assert.equal((await quote(made.id, { amount })).status, 400, String(amount));
      }
      assert.equal((await quote(made.id, { amount: 1, providerId: 999999 })).status, 400);
      assert.equal((await quote(made.id, { amount: 1, fileId: foreign.id })).status, 400);
      assert.equal((await quote(999999, { amount: 1 })).status, 404);
    });

    test("finance lists quotes across projects; an area cannot", async () => {
      const made = await project();
      await quote(made.id, { amount: 5 });
      const res = await server.get("/api/finance/quotes?status=issued", { token: moneyToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.quotes[0].projectKey, made.key);
      assert.equal((await server.get("/api/finance/quotes", { token: workerToken })).status, 403);
    });
  });

  describe("invoices", () => {
    test("only the amount is required, and the same fiscal folio is not uploaded twice", async () => {
      const made = await project();
      const bare = await invoice(made.id, { amount: 300 });
      assert.equal(bare.status, 201);
      assert.equal(bare.body.invoice.status, "uploaded");

      assert.equal((await invoice(made.id, { amount: 1, fiscalFolio: "nope" })).status, 400);
      assert.equal((await invoice(made.id, { amount: 1, fiscalFolio: FISCAL.toLowerCase() })).status, 201);
      assert.equal((await invoice(made.id, { amount: 1, fiscalFolio: FISCAL })).status, 409);
    });

    test("a quote of another project is refused", async () => {
      const made = await project();
      const other = await project({ title: "Otro" });
      const foreign = (await quote(other.id, { amount: 1 })).body.quote;
      assert.equal((await invoice(made.id, { amount: 1, quoteId: foreign.id })).status, 400);
    });

    test("once sent it can be neither changed nor deleted", async () => {
      const made = await project();
      const created = (await invoice(made.id, { amount: 300 })).body.invoice;
      await sql("update invoices set status = 'sent', sent_at = now() where id = $1", [created.id]);

      const path = `/api/finance/invoices/${created.id}`;
      assert.equal((await server.patch(path, { token: workerToken, body: { amount: 1 } })).status, 409);
      assert.equal((await server.delete(path, { token: workerToken })).status, 409);
    });

    test("a deleted one stops counting", async () => {
      const made = await project();
      const created = (await invoice(made.id, { amount: 300 })).body.invoice;
      assert.equal((await server.delete(`/api/finance/invoices/${created.id}`, { token: workerToken })).status, 200);
      assert.equal((await standing(made.id)).uploadedInvoices, 0);
      assert.deepEqual((await logsFor("invoices", created.id)).map((log) => log.action), [
        "invoice_created",
        "invoice_deleted",
      ]);
    });
  });

  describe("providers", () => {
    test("an area registers one, the name is unique, and only finance edits it", async () => {
      const created = await server.post("/api/finance/providers", {
        token: workerToken,
        body: { name: "Papelera del Centro", rfc: "pce010101ab1" },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.provider.rfc, "PCE010101AB1");

      const again = await server.post("/api/finance/providers", { token: workerToken, body: { name: "papelera del centro" } });
      assert.equal(again.status, 409);

      const path = `/api/finance/providers/${created.body.provider.id}`;
      assert.equal((await server.patch(path, { token: workerToken, body: { phone: "1" } })).status, 403);
      assert.equal((await server.patch(path, { token: moneyToken, body: { phone: "442 000" } })).body.provider.phone, "442 000");

      const found = await server.get("/api/finance/providers?q=papel", { token: workerToken });
      assert.equal(found.body.providers.length, 1);
    });
  });

  describe("standing", () => {
    test("flags fewer invoices than declared, costed work with no quote and nothing at all", async () => {
      const made = await project({ hasCost: true });
      assert.deepEqual((await standing(made.id)).flags, ["costed_no_quote", "no_finance_records"]);

      const declare = await server.post(`/api/projects/${made.id}/finance-request`, {
        token: moneyToken,
        body: { kind: "invoice", count: 2 },
      });
      assert.equal(declare.status, 200);
      await invoice(made.id, { amount: 1 });
      await quote(made.id, { amount: 1 });

      const after = await standing(made.id);
      assert.equal(after.expectedInvoices, 2);
      assert.equal(after.uploadedInvoices, 1);
      assert.equal(after.missingInvoices, 1);
      assert.deepEqual(after.flags, ["missing_invoices"]);
      assert.equal(after.invoices.length, 1);

      const listed = await server.get("/api/finance/projects?flag=missing_invoices", { token: moneyToken });
      assert.deepEqual(listed.body.projects.map((row) => row.projectId), [made.id]);
      assert.equal((await server.get("/api/finance/projects?flag=nope", { token: moneyToken })).status, 400);
      assert.equal((await server.get("/api/finance/projects", { token: workerToken })).status, 403);
    });

    test("withdrawing the invoice request clears the declared count", async () => {
      const made = await project();
      const path = `/api/projects/${made.id}/finance-request`;
      await server.post(path, { token: moneyToken, body: { kind: "invoice", count: 3 } });
      await server.post(path, { token: moneyToken, body: { kind: "invoice", needed: false } });
      assert.equal((await standing(made.id)).expectedInvoices, null);
      assert.equal((await server.post(path, { token: moneyToken, body: { kind: "invoice", count: -1 } })).status, 400);
    });

    test("closing with gaps succeeds, returns them and tells finance", async () => {
      const made = await project({ hasCost: true });
      const closed = await server.post(`/api/projects/${made.id}/close`, { token: adminToken });
      assert.equal(closed.status, 200);
      assert.ok(closed.body.project.closedAt);
      assert.deepEqual(closed.body.financeGaps, ["costed_no_quote", "delivered_no_invoice", "no_finance_records"]);

      const [told] = await sql("select * from notifications where user_id = $1 and dedup_key = $2", [
        money.id,
        `project_closed:${made.id}`,
      ]);
      assert.match(told.message, /tiene costo y no tiene cotización, se entregó y no tiene facturas\.$/);
      assert.deepEqual((await logsFor("projects", made.id)).map((log) => log.action).at(-1), "project_closed");
    });

    test("closing a project with nothing to say tells nobody", async () => {
      const made = await project();
      const closed = await server.post(`/api/projects/${made.id}/close`, { token: adminToken });
      assert.deepEqual(closed.body.financeGaps, ["no_finance_records"]);
      const told = await sql("select 1 from notifications where dedup_key = $1", [`project_closed:${made.id}`]);
      assert.equal(told.length, 0);
    });
  });

  describe("no finance", () => {
    const mark = (projectId, noFinance = true) =>
      server.patch(`/api/projects/${projectId}`, { token: adminToken, body: { noFinance } });

    test("a marked project leaves every finance list and closes with no gaps", async () => {
      const made = await project({ title: "Acomodo de sillas" });
      const marked = await mark(made.id);
      assert.equal(marked.status, 200);
      assert.equal(marked.body.project.noFinance, true);

      const listed = await server.get("/api/finance/projects", { token: moneyToken });
      assert.equal(listed.body.projects.some((row) => row.projectId === made.id), false);
      assert.deepEqual((await standing(made.id)).flags, []);

      const closed = await server.post(`/api/projects/${made.id}/close`, { token: adminToken });
      assert.deepEqual(closed.body.financeGaps, []);
      assert.equal((await invoice(made.id, { amount: 1 })).status, 409);
      assert.equal((await quote(made.id, { amount: 1 })).status, 409);
    });

    test("is refused on a costed project, or one already holding finance records", async () => {
      assert.equal((await mark((await project({ hasCost: true })).id)).status, 400);

      const withInvoice = await project();
      await invoice(withInvoice.id, { amount: 1 });
      assert.equal((await mark(withInvoice.id)).status, 409);

      const declared = await project();
      await server.post(`/api/projects/${declared.id}/finance-request`, {
        token: moneyToken,
        body: { kind: "invoice", count: 1 },
      });
      assert.equal((await mark(declared.id)).status, 409);
    });

    test("unmarking brings it back", async () => {
      const made = await project();
      await mark(made.id);
      assert.equal((await mark(made.id, false)).body.project.noFinance, false);
      assert.deepEqual((await standing(made.id)).flags, ["no_finance_records"]);
    });
  });

  describe("retention", () => {
    const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
    const later = (months) => new Date(Date.now() + months * MONTH_MS);

    test("a finance file outlives the semester sweep, then follows its own clock", async () => {
      const made = await project();
      const kept = await upload(made.folderId);
      const plain = await upload(made.folderId);
      await quote(made.id, { amount: 1, fileId: kept.id });
      await sql("update projects set closed_at = now() where id = $1", [made.id]);

      await runJob("file-expiry", later(7));
      const alive = async (id) => (await sql("select deleted_at from files where id = $1", [id]))[0].deleted_at === null;
      assert.equal(await alive(plain.id), false);
      assert.equal(await alive(kept.id), true);

      const forever = await server.put("/api/documents/retention", {
        token: adminToken,
        body: { financeKeepForever: true },
      });
      assert.equal(forever.body.retention.financeKeepForever, true);
      assert.equal(forever.body.retention.financeMonths, 60);
      await runJob("file-expiry", later(61));
      assert.equal(await alive(kept.id), true);

      await server.put("/api/documents/retention", { token: adminToken, body: { financeKeepForever: false } });
      await runJob("file-expiry", later(61));
      assert.equal(await alive(kept.id), false);
    });

    test("the finance settings are validated", async () => {
      const put = (body) => server.put("/api/documents/retention", { token: adminToken, body });
      assert.equal((await put({})).status, 400);
      assert.equal((await put({ financeMonths: 0 })).status, 400);
      assert.equal((await put({ financeKeepForever: "yes" })).status, 400);
    });
  });
});
