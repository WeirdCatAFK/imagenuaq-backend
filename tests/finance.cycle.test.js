// Collection records (RF-FIN-11 to RF-FIN-15): oficios that carry a project's invoices, payments both
// ways with their tracking folio, and referenced receipts. None has stages; corrections are asked for.
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
import { runJob } from "../src/scheduler.js";

const ADMIN = "coordinacion.cobro@uaq.mx";

describe("/api/finance collection cycle", () => {
  let server;
  let adminToken;
  let area;
  let uploader;
  let workerToken;
  let edwin;
  let edwinToken;

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ADMIN, role: "admin" });
    adminToken = await tokenFor(server, ADMIN);
    await grantPermissions(server, adminToken, "worker", ["project.read", "project.write"]);
  });

  after(async () => {
    try {
      await grantPermissions(server, adminToken, "worker", []);
      await resetCases();
      await reset();
    } finally {
      await server?.close();
    }
  });

  beforeEach(async () => {
    await resetCases([ADMIN]);
    area = await createArea("Imprenta cobro");
    uploader = await createActive({ email: "imprenta.cobro@uaq.mx", area: area.name });
    workerToken = await tokenFor(server, "imprenta.cobro@uaq.mx");
    edwin = await createActive({ email: "edwin@uaq.mx", role: "finance" });
    edwinToken = await tokenFor(server, "edwin@uaq.mx");
  });

  const project = async (body = {}) =>
    (await server.post("/api/projects", {
      token: adminToken,
      body: { title: "Papel institucional", stages: [{ areaId: area.id, title: "Impresión" }], ...body },
    })).body.project;
  const invoice = async (projectId, amount = 100) =>
    (await server.post(`/api/finance/projects/${projectId}/invoices`, { token: workerToken, body: { amount } }))
      .body.invoice;
  const oficio = (projectId, body, token = edwinToken) =>
    server.post(`/api/finance/projects/${projectId}/oficios`, { token, body });
  const standing = async (projectId) =>
    (await server.get(`/api/finance/projects/${projectId}`, { token: edwinToken })).body.finance;

  describe("oficios", () => {
    test("groups the project's invoices, and refuses others' or ones already taken", async () => {
      const made = await project();
      const [a, b] = [await invoice(made.id, 100), await invoice(made.id, 50.5)];
      const other = await project({ title: "Otro" });
      const foreign = await invoice(other.id);

      const created = await oficio(made.id, { folio: "OF-001", recipient: "Facultad", amount: 150.5, invoiceIds: [a.id, b.id] });
      assert.equal(created.status, 201);
      assert.equal(created.body.oficio.invoicesTotal, "150.50");
      assert.equal(created.body.oficio.amountMismatch, false);
      assert.deepEqual(created.body.oficio.invoices.map((row) => row.id), [a.id, b.id]);

      assert.equal((await oficio(made.id, { folio: "OF-002", amount: 1, invoiceIds: [foreign.id] })).status, 400);
      assert.equal((await oficio(made.id, { folio: "OF-003", amount: 1, invoiceIds: [a.id] })).status, 409);
      assert.equal((await oficio(made.id, { folio: "of-001", amount: 1 })).status, 409);
      assert.equal((await oficio(made.id, { folio: "OF-004", amount: 1 }, workerToken)).status, 403);

      const logged = await logsFor("invoices", a.id);
      assert.equal(logged.at(-1).action, "invoice_updated");
      assert.equal(String(logged.at(-1).after_data.oficio_id), String(created.body.oficio.id));
    });

    test("a typed amount that differs from its invoices is flagged, not refused", async () => {
      const made = await project();
      const one = await invoice(made.id, 100);
      const created = await oficio(made.id, { folio: "OF-010", amount: 90, invoiceIds: [one.id] });
      assert.equal(created.body.oficio.amountMismatch, true);
    });

    test("its invoices change at any time, and deleting it releases them", async () => {
      const made = await project();
      const [a, b] = [await invoice(made.id), await invoice(made.id)];
      const created = (await oficio(made.id, { folio: "OF-040", amount: 100, invoiceIds: [a.id] })).body.oficio;
      const path = `/api/finance/oficios/${created.id}`;

      const swapped = await server.patch(path, { token: edwinToken, body: { invoiceIds: [b.id], note: "Timbrado" } });
      assert.equal(swapped.status, 200);
      assert.deepEqual(swapped.body.oficio.invoices.map((row) => row.id), [b.id]);
      assert.equal(swapped.body.oficio.note, "Timbrado");
      assert.equal("status" in swapped.body.oficio, false);

      const taken = (await oficio(made.id, { folio: "OF-041", amount: 100, invoiceIds: [a.id] })).body.oficio;
      assert.equal((await server.patch(path, { token: edwinToken, body: { invoiceIds: [a.id] } })).status, 409);

      assert.equal((await server.delete(`/api/finance/oficios/${taken.id}`, { token: edwinToken })).status, 200);
      const freed = (await server.get(`/api/finance/invoices/${a.id}`, { token: edwinToken })).body.invoice;
      assert.equal(freed.oficioId, null);
    });

    test("the finance digest counts projects with a pending correction, and the uploader hears of it", async () => {
      const made = await project();
      const one = await invoice(made.id);
      await oficio(made.id, { folio: "OF-050", amount: 100, invoiceIds: [one.id] });
      await server.post(`/api/finance/invoices/${one.id}/correction`, { token: edwinToken, body: { note: "Monto mal" } });

      const [told] = await sql("select title, message from notifications where user_id = $1", [uploader.id]);
      assert.equal(told.message, "Monto mal");
      assert.match(told.title, /^Corrige la factura/);

      await runJob("finance-gaps", new Date());
      const [digest] = await sql(
        "select message from notifications where user_id = $1 and dedup_key like 'finance-gaps:finance:%'",
        [edwin.id],
      );
      assert.match(digest.message, /1 con correcciones pendientes\.$/);
    });
  });

  describe("payments", () => {
    test("go both ways, and the ones without a folio are listed", async () => {
      const made = await project();
      const one = await invoice(made.id, 100);
      const created = (await oficio(made.id, { folio: "OF-060", amount: 100, invoiceIds: [one.id] })).body.oficio;
      const pay = (body) => server.post(`/api/finance/projects/${made.id}/payments`, { token: edwinToken, body });

      const incoming = await pay({ direction: "incoming", oficioId: created.id, amount: 40, paidOn: "2026-10-20" });
      assert.equal(incoming.status, 201);
      assert.equal(incoming.body.payment.paidOn, "2026-10-20");
      const outgoing = await pay({ direction: "outgoing", invoiceId: one.id, amount: 100, trackingFolio: "R-1" });
      assert.equal(outgoing.status, 201);

      assert.equal((await pay({ direction: "incoming", invoiceId: one.id, amount: 1 })).status, 400);
      assert.equal((await pay({ direction: "sideways", oficioId: created.id, amount: 1 })).status, 400);

      const after = (await server.get(`/api/finance/oficios/${created.id}`, { token: edwinToken })).body.oficio;
      assert.equal(after.paidAmount, "40.00");
      assert.equal(after.balance, "60.00");
      const paidInvoice = (await server.get(`/api/finance/invoices/${one.id}`, { token: edwinToken })).body.invoice;
      assert.equal(paidInvoice.balance, "0.00");

      const missing = await server.get("/api/finance/payments?missingFolio=true", { token: edwinToken });
      assert.deepEqual(missing.body.payments.map((row) => row.id), [incoming.body.payment.id]);
      assert.ok((await standing(made.id)).flags.includes("payment_no_folio"));

      const fixed = await server.patch(`/api/finance/payments/${incoming.body.payment.id}`, {
        token: edwinToken,
        body: { trackingFolio: "R-2" },
      });
      assert.equal(fixed.body.payment.trackingFolio, "R-2");
      assert.equal((await standing(made.id)).flags.includes("payment_no_folio"), false);
    });
  });

  describe("referenced receipts", () => {
    test("are recorded, corrected and deleted, with no validation", async () => {
      const made = await project();
      const created = await server.post(`/api/finance/projects/${made.id}/receipts`, {
        token: edwinToken,
        body: { amount: 500, requester: "Facultad de Derecho", reference: "REF-1" },
      });
      assert.equal(created.status, 201);
      assert.equal("status" in created.body.receipt, false);
      const path = `/api/finance/receipts/${created.body.receipt.id}`;

      await server.post(`${path}/correction`, { token: edwinToken, body: { note: "Falta la referencia bancaria" } });
      const fixed = await server.patch(path, { token: edwinToken, body: { reference: "REF-1-BANCO" } });
      assert.equal(fixed.body.receipt.reference, "REF-1-BANCO");
      assert.equal(fixed.body.receipt.correctionNote, null);

      assert.equal((await server.delete(path, { token: workerToken })).status, 403);
      assert.equal((await server.delete(path, { token: edwinToken })).status, 200);
      assert.equal((await server.get(path, { token: edwinToken })).status, 404);
      assert.equal((await standing(made.id)).receipts.length, 0);

      assert.deepEqual(
        (await logsFor("receipts", created.body.receipt.id)).map((row) => row.action),
        ["receipt_created", "correction_requested", "receipt_updated", "receipt_deleted"],
      );
    });

    test("a quote must be of the same project, and a project with no finance refuses one", async () => {
      const made = await project();
      const other = await project({ title: "Otro" });
      const foreign = (await server.post(`/api/finance/projects/${other.id}/quotes`, {
        token: workerToken,
        body: { amount: 1 },
      })).body.quote;
      const receipt = (body, projectId = made.id) =>
        server.post(`/api/finance/projects/${projectId}/receipts`, { token: edwinToken, body });
      assert.equal((await receipt({ amount: 1, quoteId: foreign.id })).status, 400);

      const skipped = await project({ title: "Acomodo" });
      await server.patch(`/api/projects/${skipped.id}`, { token: adminToken, body: { noFinance: true } });
      assert.equal((await receipt({ amount: 1 }, skipped.id)).status, 409);
      assert.equal((await oficio(skipped.id, { folio: "OF-070", amount: 1 })).status, 409);
    });
  });
});
