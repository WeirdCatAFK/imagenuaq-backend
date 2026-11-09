// The finance cycle and each project's standing (RF-FIN-01 to RF-FIN-18). Areas upload quotes and
// invoices with `project.write`; the rest is `finance.write`, validating a receipt `finance.validate`.
import { Router } from "express";

import finance from "../access/orchestration/finance.js";
import { authenticate, requirePermission, requireAnyPermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const id = (label) => (req) => idParam(req, "id", label);
const projectId = id("project id");
const providerId = id("provider id");
const quoteId = id("quote id");
const invoiceId = id("invoice id");
const oficioId = id("oficio id");
const paymentId = id("payment id");
const receiptId = id("receipt id");

const canRead = requireAnyPermission("project.read", "finance.read");
const canUpload = requireAnyPermission("project.write", "finance.write");

router.use(authenticate);

router.get("/projects", requirePermission("finance.read"), async (req, res) => {
  res.json({ projects: await finance.listProjects(req.query) });
});

router.get("/projects/:id", canRead, async (req, res) => {
  res.json({ finance: await finance.projectSummary(projectId(req)) });
});

router.get("/providers", canRead, async (req, res) => {
  res.json({ providers: await finance.listProviders(req.query) });
});

router.get("/providers/:id", canRead, async (req, res) => {
  res.json({ provider: await finance.getProvider(providerId(req)) });
});

router.post("/providers", canUpload, async (req, res) => {
  res.status(201).json({ provider: await finance.createProvider(req.body ?? {}) });
});

router.patch("/providers/:id", requirePermission("finance.write"), async (req, res) => {
  res.json({ provider: await finance.updateProvider(providerId(req), req.body ?? {}) });
});

router.delete("/providers/:id", requirePermission("finance.write"), async (req, res) => {
  res.json({ provider: await finance.deleteProvider(providerId(req)) });
});

router.get("/quotes", requirePermission("finance.read"), async (req, res) => {
  res.json({ quotes: await finance.listQuotes(req.query) });
});

router.get("/quotes/:id", canRead, async (req, res) => {
  res.json({ quote: await finance.getQuote(quoteId(req)) });
});

router.post("/projects/:id/quotes", canUpload, async (req, res) => {
  res.status(201).json({ quote: await finance.createQuote(projectId(req), req.body ?? {}) });
});

router.patch("/quotes/:id", canUpload, async (req, res) => {
  res.json({ quote: await finance.updateQuote(quoteId(req), req.body ?? {}) });
});

router.post("/quotes/:id/decision", requirePermission("finance.write"), async (req, res) => {
  const { decision, comment } = req.body ?? {};
  res.json({ quote: await finance.decideQuote(quoteId(req), { decision, comment }) });
});

router.delete("/quotes/:id", canUpload, async (req, res) => {
  res.json({ quote: await finance.deleteQuote(quoteId(req)) });
});

router.get("/invoices", requirePermission("finance.read"), async (req, res) => {
  res.json({ invoices: await finance.listInvoices(req.query) });
});

router.get("/invoices/:id", canRead, async (req, res) => {
  res.json({ invoice: await finance.getInvoice(invoiceId(req)) });
});

router.post("/projects/:id/invoices", canUpload, async (req, res) => {
  res.status(201).json({ invoice: await finance.createInvoice(projectId(req), req.body ?? {}) });
});

router.patch("/invoices/:id", canUpload, async (req, res) => {
  res.json({ invoice: await finance.updateInvoice(invoiceId(req), req.body ?? {}) });
});

router.delete("/invoices/:id", canUpload, async (req, res) => {
  res.json({ invoice: await finance.deleteInvoice(invoiceId(req)) });
});

router.post("/invoices/:id/status", requirePermission("finance.write"), async (req, res) => {
  const { status, paymentFolio } = req.body ?? {};
  res.json({ invoice: await finance.setInvoiceStatus(invoiceId(req), { status, paymentFolio }) });
});

router.get("/oficios", requirePermission("finance.read"), async (req, res) => {
  res.json({ oficios: await finance.listOficios(req.query) });
});

router.get("/oficios/:id", canRead, async (req, res) => {
  res.json({ oficio: await finance.getOficio(oficioId(req)) });
});

router.post("/projects/:id/oficios", requirePermission("finance.write"), async (req, res) => {
  res.status(201).json({ oficio: await finance.createOficio(projectId(req), req.body ?? {}) });
});

router.patch("/oficios/:id", requirePermission("finance.write"), async (req, res) => {
  res.json({ oficio: await finance.updateOficio(oficioId(req), req.body ?? {}) });
});

router.post("/oficios/:id/status", requirePermission("finance.write"), async (req, res) => {
  res.json({ oficio: await finance.advanceOficio(oficioId(req), { status: req.body?.status }) });
});

router.delete("/oficios/:id", requirePermission("finance.write"), async (req, res) => {
  res.json({ oficio: await finance.deleteOficio(oficioId(req)) });
});

router.get("/payments", requirePermission("finance.read"), async (req, res) => {
  res.json({ payments: await finance.listPayments(req.query) });
});

router.get("/payments/:id", canRead, async (req, res) => {
  res.json({ payment: await finance.getPayment(paymentId(req)) });
});

router.post("/projects/:id/payments", requirePermission("finance.write"), async (req, res) => {
  res.status(201).json({ payment: await finance.createPayment(projectId(req), req.body ?? {}) });
});

router.patch("/payments/:id", requirePermission("finance.write"), async (req, res) => {
  res.json({ payment: await finance.updatePayment(paymentId(req), req.body ?? {}) });
});

router.delete("/payments/:id", requirePermission("finance.write"), async (req, res) => {
  res.json({ payment: await finance.deletePayment(paymentId(req)) });
});

router.get("/receipts", requirePermission("finance.read"), async (req, res) => {
  res.json({ receipts: await finance.listReceipts(req.query) });
});

router.get("/receipts/:id", canRead, async (req, res) => {
  res.json({ receipt: await finance.getReceipt(receiptId(req)) });
});

router.post("/projects/:id/receipts", requirePermission("finance.write"), async (req, res) => {
  res.status(201).json({ receipt: await finance.createReceipt(projectId(req), req.body ?? {}) });
});

router.patch("/receipts/:id", requirePermission("finance.write"), async (req, res) => {
  res.json({ receipt: await finance.updateReceipt(receiptId(req), req.body ?? {}) });
});

router.post("/receipts/:id/submit", requirePermission("finance.write"), async (req, res) => {
  res.json({ receipt: await finance.submitReceipt(receiptId(req)) });
});

router.post("/receipts/:id/validation", requirePermission("finance.validate"), async (req, res) => {
  const { decision, comment } = req.body ?? {};
  res.json({ receipt: await finance.validateReceipt(receiptId(req), { decision, comment }) });
});

router.post("/receipts/:id/status", requirePermission("finance.write"), async (req, res) => {
  res.json({ receipt: await finance.setReceiptStatus(receiptId(req), { status: req.body?.status }) });
});

export default router;
