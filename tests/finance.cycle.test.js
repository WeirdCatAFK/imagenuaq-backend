// The collection cycle (RF-FIN-10 to RF-FIN-16): oficios that carry a project's invoices and move
// forward with a date per step, payments both ways with their tracking folio, and referenced
// receipts validated by someone other than their author.
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
  let admin;
  let adminToken;
  let area;
  let uploader;
  let workerToken;
  let edwin;
  let edwinToken;
  let hildaToken;

  before(async () => {
    server = await startServer();
    await reset();
    admin = await createActive({ email: ADMIN, role: "admin" });
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
    await createActive({ email: "hilda.cobro@uaq.mx", role: "finance" });
    hildaToken = await tokenFor(server, "hilda.cobro@uaq.mx");
  });

  const project = async (body = {}) =>
    (await server.post("/api/projects", { token: adminToken, body: { title: "Papel institucional", ...body } }))
      .body.project;
  const invoice = async (projectId, amount = 100) =>
    (await server.post(`/api/finance/projects/${projectId}/invoices`, { token: workerToken, body: { amount } }))
      .body.invoice;
  const oficio = (projectId, body, token = edwinToken) =>
    server.post(`/api/finance/projects/${projectId}/oficios`, { token, body });
  const move = (oficioId, status) =>
    server.post(`/api/finance/oficios/${oficioId}/status`, { token: edwinToken, body: { status } });
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
      assert.equal(created.body.oficio.status, "issued");
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

    test("moves forward, may skip, dates only the steps reached, and sends its invoices", async () => {
      const made = await project();
      const one = await invoice(made.id);
      const created = (await oficio(made.id, { folio: "OF-020", amount: 100, invoiceIds: [one.id] })).body.oficio;

      const answered = await move(created.id, "answered");
      assert.equal(answered.status, 200);
      assert.equal(answered.body.oficio.status, "answered");
      assert.ok(answered.body.oficio.answeredAt);
      assert.equal(answered.body.oficio.sentAt, null);
      assert.equal(answered.body.oficio.invoices[0].status, "sent");
      assert.equal((await move(created.id, "signed")).status, 409);
      assert.equal((await move(created.id, "issued")).status, 400);

      const sentInvoice = (await server.get(`/api/finance/invoices/${one.id}`, { token: workerToken })).body.invoice;
      assert.equal(sentInvoice.oficioFolio, "OF-020");
      assert.ok(sentInvoice.sentAt);
    });

    test("leaving issued and being paid remind the actor to email the uploaders", async () => {
      const made = await project();
      const one = await invoice(made.id);
      const created = (await oficio(made.id, { folio: "OF-030", amount: 100, invoiceIds: [one.id] })).body.oficio;
      await move(created.id, "sent");
      await move(created.id, "paid");

      const reminders = await sql(
        "select dedup_key, message from notifications where user_id = $1 order by id",
        [edwin.id],
      );
      assert.deepEqual(reminders.map((row) => row.dedup_key), [
        `oficio-email:${created.id}:sent`,
        `oficio-email:${created.id}:paid`,
      ]);
      assert.match(reminders[0].message, /^Oficio OF-030 enviado: escribe el correo a imprenta\.cobro@uaq\.mx de que/);
      assert.equal((await sql("select 1 from notifications where user_id = $1", [uploader.id])).length, 0);
    });

    test("its invoices change and it can be deleted only while issued", async () => {
      const made = await project();
      const [a, b] = [await invoice(made.id), await invoice(made.id)];
      const created = (await oficio(made.id, { folio: "OF-040", amount: 100, invoiceIds: [a.id] })).body.oficio;
      const path = `/api/finance/oficios/${created.id}`;

      const swapped = await server.patch(path, { token: edwinToken, body: { invoiceIds: [b.id] } });
      assert.deepEqual(swapped.body.oficio.invoices.map((row) => row.id), [b.id]);

      await move(created.id, "sent");
      assert.equal((await server.patch(path, { token: edwinToken, body: { invoiceIds: [a.id] } })).status, 409);
      assert.equal((await server.patch(path, { token: edwinToken, body: { note: "Timbrado" } })).status, 200);
      assert.equal((await server.delete(path, { token: edwinToken })).status, 409);

      const loose = (await oficio(made.id, { folio: "OF-041", amount: 100, invoiceIds: [a.id] })).body.oficio;
      assert.equal((await server.delete(`/api/finance/oficios/${loose.id}`, { token: edwinToken })).status, 200);
      const freed = (await server.get(`/api/finance/invoices/${a.id}`, { token: edwinToken })).body.invoice;
      assert.equal(freed.oficioId, null);
    });

    test("one sent more than 15 days ago is unanswered, listed oldest first and flagged", async () => {
      const made = await project();
      const [a, b] = [await invoice(made.id), await invoice(made.id)];
      const old = (await oficio(made.id, { folio: "OF-050", amount: 100, invoiceIds: [a.id] })).body.oficio;
      const fresh = (await oficio(made.id, { folio: "OF-051", amount: 100, invoiceIds: [b.id] })).body.oficio;
      await move(old.id, "sent");
      await move(fresh.id, "signed");
      await sql("update oficios set sent_at = now() - interval '20 days' where id = $1", [old.id]);
      await sql("update oficios set sent_at = now() - interval '3 days' where id = $1", [fresh.id]);

      const listed = await server.get("/api/finance/oficios?unansweredDays=15", { token: edwinToken });
      assert.deepEqual(listed.body.oficios.map((row) => row.id), [old.id]);
      assert.equal(listed.body.oficios[0].daysUnanswered >= 20, true);
      assert.ok((await standing(made.id)).flags.includes("oficio_unanswered"));

      await runJob("finance-gaps", new Date());
      const [digest] = await sql(
        "select message from notifications where user_id = $1 and dedup_key like 'finance-gaps:finance:%'",
        [edwin.id],
      );
      assert.match(digest.message, /1 con oficios sin respuesta/);
    });
  });

  describe("invoice status", () => {
    test("in_payment needs the payment folio, and paid comes after it", async () => {
      const made = await project();
      const one = await invoice(made.id);
      const path = `/api/finance/invoices/${one.id}/status`;
      const set = (body, token = hildaToken) => server.post(path, { token, body });

      assert.equal((await set({ status: "paid" })).status, 409);
      assert.equal((await set({ status: "in_payment" })).status, 400);
      assert.equal((await set({ status: "in_payment", paymentFolio: "F-9" }, workerToken)).status, 403);
      const paying = await set({ status: "in_payment", paymentFolio: "F-9" });
      assert.equal(paying.body.invoice.status, "in_payment");
      assert.equal(paying.body.invoice.paymentFolio, "F-9");
      assert.equal((await set({ status: "paid" })).body.invoice.status, "paid");
      assert.equal((await set({ status: "sent" })).status, 400);
    });
  });

  describe("payments", () => {
    test("go both ways, never move a status, and the ones without a folio are listed", async () => {
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
      assert.equal(after.status, "issued");
      const paidInvoice = (await server.get(`/api/finance/invoices/${one.id}`, { token: edwinToken })).body.invoice;
      assert.equal(paidInvoice.balance, "0.00");
      assert.equal(paidInvoice.status, "uploaded");

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
    test("are validated by someone else, and a rejection goes back to draft", async () => {
      const made = await project();
      const created = await server.post(`/api/finance/projects/${made.id}/receipts`, {
        token: edwinToken,
        body: { amount: 500, requester: "Facultad de Derecho", reference: "REF-1" },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.receipt.status, "draft");
      const path = `/api/finance/receipts/${created.body.receipt.id}`;
      const validate = (decision, token, comment) =>
        server.post(`${path}/validation`, { token, body: { decision, comment } });

      assert.equal((await validate("approved", hildaToken)).status, 409);
      assert.equal((await server.post(`${path}/submit`, { token: edwinToken })).body.receipt.status, "pending_validation");
      assert.equal((await validate("approved", edwinToken)).status, 403);
      assert.equal((await validate("approved", workerToken)).status, 403);

      const rejected = await validate("rejected", hildaToken, "Falta la referencia bancaria");
      assert.equal(rejected.body.receipt.status, "draft");
      assert.equal(rejected.body.receipt.validationComment, "Falta la referencia bancaria");
      assert.equal((await server.post(`${path}/status`, { token: edwinToken, body: { status: "issued" } })).status, 409);

      await server.patch(path, { token: edwinToken, body: { reference: "REF-1-BANCO" } });
      await server.post(`${path}/submit`, { token: edwinToken });
      const validated = await validate("approved", adminToken);
      assert.equal(validated.body.receipt.status, "validated");
      assert.equal(String(validated.body.receipt.validatedBy), String(admin.id));

      assert.equal((await server.patch(path, { token: edwinToken, body: { amount: 1 } })).status, 409);
      const status = (value) => server.post(`${path}/status`, { token: edwinToken, body: { status: value } });
      assert.equal((await status("paid")).status, 409);
      assert.equal((await status("issued")).body.receipt.status, "issued");
      assert.equal((await status("paid")).body.receipt.status, "paid");
      assert.equal((await status("cancelled")).status, 409);

      assert.deepEqual(
        (await logsFor("receipts", created.body.receipt.id)).map((row) => row.action),
        [
          "receipt_created", "receipt_submitted", "receipt_rejected", "receipt_updated",
          "receipt_submitted", "receipt_validated", "receipt_status_changed", "receipt_status_changed",
        ],
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
