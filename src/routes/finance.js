// Quotes, invoices, providers and each project's finance standing (RF-FIN-01 to RF-FIN-10, RF-FIN-18).
// Areas upload with `project.write`; deciding and the cross-project lists are finance's own permissions.
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

export default router;
