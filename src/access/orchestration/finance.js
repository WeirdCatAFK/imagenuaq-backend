// Quotes, invoices and providers, and what each project is still missing (RF-FIN-01 to RF-FIN-10,
// RF-FIN-17, RF-FIN-18). Areas rarely upload everything, so little is required and finance reads
// the gaps instead (DATAMODEL §2.20). Every write logs itself in the same statement, not via events.
import query from "../resources/query.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import { UNIQUE_VIOLATION, optionalText, requireText, requireId, optionalId } from "../../utils/validate.js";

const NAME_MAX = 300;
const TEXT_MAX = 4000;
const FOLIO_MAX = 100;
const PAGE_MAX = 200;
const RFC_FORMAT = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;
const UUID_FORMAT = /^[\dA-F]{8}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{12}$/;
const AMOUNT_FORMAT = /^\d{1,10}(\.\d{1,2})?$/;

/** RF-FIN-03: a quote is visible from `issued`; these are the moves finance can make from each status. */
const QUOTE_MOVES = {
  issued: ["in_review", "approved", "rejected"],
  in_review: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

/** RF-FIN-10. `sent` and later arrive with the oficio that carries the invoice (I9b). */
const INVOICE_STATUSES = ["uploaded", "sent", "in_payment", "paid"];

/** What finance's project list can be filtered by; computed in query.financeProjects(). */
export const FINANCE_FLAGS = [
  "missing_invoices",
  "costed_no_quote",
  "delivered_no_invoice",
  "no_finance_records",
];

/**
 * A non-negative amount with at most two decimals, as the string Postgres stores exactly.
 *
 * @throws {ApiError} 400
 */
function requireAmount(value, field) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!AMOUNT_FORMAT.test(text)) {
    throw ApiError.badRequest(`${field} must be a non-negative amount with at most two decimals.`);
  }
  return text;
}

/** @throws {ApiError} 400 unless blank or an RFC. */
function optionalRfc(value) {
  const rfc = optionalText(value, "rfc", 13)?.toUpperCase() ?? null;
  if (rfc !== null && !RFC_FORMAT.test(rfc)) throw ApiError.badRequest("rfc is not a valid RFC.");
  return rfc;
}

/** @throws {ApiError} 400 unless blank or a CFDI UUID. */
function optionalFiscalFolio(value) {
  const folio = optionalText(value, "fiscalFolio", 36)?.toUpperCase() ?? null;
  if (folio !== null && !UUID_FORMAT.test(folio)) {
    throw ApiError.badRequest("fiscalFolio must be the CFDI UUID (8-4-4-4-12 hexadecimal).");
  }
  return folio;
}

/** Body key to `[column, parser]`. Columns are named here, never by the client. */
const PROVIDER_FIELDS = {
  name: ["name", (v) => requireText(v, "name", NAME_MAX)],
  rfc: ["rfc", optionalRfc],
  contactName: ["contact_name", (v) => optionalText(v, "contactName", NAME_MAX)],
  email: ["email", (v) => optionalText(v, "email", 320)],
  phone: ["phone", (v) => optionalText(v, "phone", 50)],
  notes: ["notes", (v) => optionalText(v, "notes", TEXT_MAX)],
};

const QUOTE_FIELDS = {
  providerId: ["provider_id", (v) => optionalId(v, "providerId")],
  entity: ["entity", (v) => optionalText(v, "entity", NAME_MAX)],
  amount: ["amount", (v) => requireAmount(v, "amount")],
  description: ["description", (v) => optionalText(v, "description", TEXT_MAX)],
  fileId: ["file_id", (v) => optionalId(v, "fileId")],
};

const INVOICE_FIELDS = {
  quoteId: ["quote_id", (v) => optionalId(v, "quoteId")],
  providerId: ["provider_id", (v) => optionalId(v, "providerId")],
  amount: ["amount", (v) => requireAmount(v, "amount")],
  material: ["material", (v) => optionalText(v, "material", TEXT_MAX)],
  invoiceFolio: ["invoice_folio", (v) => optionalText(v, "invoiceFolio", FOLIO_MAX)],
  fiscalFolio: ["fiscal_folio", optionalFiscalFolio],
  destination: ["destination", (v) => optionalText(v, "destination", NAME_MAX)],
  fileId: ["file_id", (v) => optionalId(v, "fileId")],
};

/**
 * Reads `input` through `spec` into column values. `partial` skips absent keys (a PATCH); a full
 * read parses every key, so a required one that is missing is a 400.
 *
 * @throws {ApiError} 400, or when a partial read has nothing to change.
 */
function readFields(input, spec, { partial = false } = {}) {
  const fields = {};
  for (const [key, [column, parse]] of Object.entries(spec)) {
    if (partial && input?.[key] === undefined) continue;
    fields[column] = parse(input?.[key]);
  }
  if (partial && Object.keys(fields).length === 0) throw ApiError.badRequest("Nothing to change.");
  return fields;
}

/** `limit` 1..200 (default 50) and `offset` >= 0 from a query string. */
function page({ limit, offset } = {}) {
  const size = limit === undefined || limit === "" ? 50 : Number(limit);
  const skip = offset === undefined || offset === "" ? 0 : Number(offset);
  if (!Number.isInteger(size) || size < 1 || size > PAGE_MAX) {
    throw ApiError.badRequest(`limit must be between 1 and ${PAGE_MAX}.`);
  }
  if (!Number.isInteger(skip) || skip < 0) throw ApiError.badRequest("offset must be a non-negative integer.");
  return { limit: size, offset: skip };
}

/** @throws {ApiError} 400 unless blank or one of `allowed`. */
function optionalChoice(value, field, allowed) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.includes(value)) throw ApiError.badRequest(`${field} must be one of: ${allowed.join(", ")}.`);
  return value;
}

/** The actor's id; finance writes are always someone's. */
function actorId() {
  const actor = currentActor();
  if (!actor) throw ApiError.badRequest("No acting user.");
  return actor.id;
}

/** Translates the one unique index a client can hit into a 409. */
async function uniquely(write, message) {
  try {
    return await write();
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION) throw ApiError.conflict(message);
    throw err;
  }
}

class Finance {
  /** Live providers, filtered by a name fragment (`q`). */
  async listProviders({ q, limit } = {}) {
    const rows = await query.listProviders({ q: optionalText(q, "q", NAME_MAX), ...page({ limit }) });
    return rows.map(shapeProvider);
  }

  /** @throws {ApiError} 404 */
  async getProvider(providerId) {
    const row = await query.getProvider(requireId(providerId, "providerId"));
    if (!row) throw ApiError.notFound("Provider not found.");
    return shapeProvider(row);
  }

  /**
   * Registers a provider. Areas may, so an invoice upload never stalls on a missing name.
   *
   * @throws {ApiError} 400, 409 when a live provider already has the name.
   */
  async createProvider(input) {
    const fields = { ...readFields(input, PROVIDER_FIELDS), created_by: actorId() };
    const row = await uniquely(
      () => query.createProvider(fields, fields.created_by),
      "A provider with that name already exists.",
    );
    return shapeProvider(row);
  }

  /** @throws {ApiError} 400, 404, 409 on a taken name. */
  async updateProvider(providerId, input) {
    const id = requireId(providerId, "providerId");
    const fields = readFields(input, PROVIDER_FIELDS, { partial: true });
    const row = await uniquely(
      () => query.updateProvider(id, fields, actorId()),
      "A provider with that name already exists.",
    );
    if (!row) throw ApiError.notFound("Provider not found.");
    return shapeProvider(row);
  }

  /** Soft-deletes a provider; the quotes and invoices that name it keep the name. @throws {ApiError} 404 */
  async deleteProvider(providerId) {
    const row = await query.deleteProvider(requireId(providerId, "providerId"), actorId());
    if (!row) throw ApiError.notFound("Provider not found.");
    return shapeProvider(row);
  }

  /**
   * One project's finance standing with its quotes and invoices (RF-FIN-07).
   *
   * @throws {ApiError} 404
   */
  async projectSummary(projectId) {
    const id = requireId(projectId, "projectId");
    const [standing] = await query.financeProjects({ projectId: id });
    if (!standing) throw ApiError.notFound("Project not found.");
    const [quotes, invoices] = await Promise.all([
      query.listQuotes({ projectId: id, limit: PAGE_MAX }),
      query.listInvoices({ projectId: id, limit: PAGE_MAX }),
    ]);
    return {
      ...shapeStanding(standing),
      quotes: quotes.map(shapeQuote),
      invoices: invoices.map(shapeInvoice),
    };
  }

  /**
   * Projects with their finance standing, the most missing invoices first; `flag` keeps only the
   * projects showing it (RF-EST-08, RF-FIN-07).
   *
   * @throws {ApiError} 400 on an unknown flag.
   */
  async listProjects({ flag, limit, offset } = {}) {
    const rows = await query.financeProjects({
      flag: optionalChoice(flag, "flag", FINANCE_FLAGS),
      ...page({ limit, offset }),
    });
    return rows.map(shapeStanding);
  }

  /** What finance should know about a project, as finance flags (empty when nothing is off). */
  async gaps(projectId) {
    const [standing] = await query.financeProjects({ projectId });
    return standing?.flags ?? [];
  }

  /** Quotes across projects, newest first (RF-FIN-04). @throws {ApiError} 400 */
  async listQuotes({ status, projectId, limit, offset } = {}) {
    const rows = await query.listQuotes({
      status: optionalChoice(status, "status", Object.keys(QUOTE_MOVES)),
      projectId: optionalId(projectId, "projectId"),
      ...page({ limit, offset }),
    });
    return rows.map(shapeQuote);
  }

  /** @throws {ApiError} 404 */
  async getQuote(quoteId) {
    const row = await query.getQuote(requireId(quoteId, "quoteId"));
    if (!row) throw ApiError.notFound("Quote not found.");
    return shapeQuote(row);
  }

  /**
   * Records a quote on a project, as `issued` (RF-FIN-01, RF-FIN-03).
   *
   * @throws {ApiError} 400 on a bad field, an unknown provider or a file outside the project, 404.
   */
  async createQuote(projectId, input) {
    const id = await this.#liveProject(projectId);
    const fields = readFields(input, QUOTE_FIELDS);
    await this.#checkReferences(id, fields);
    const row = await query.createQuote({ ...fields, project_id: id, created_by: actorId() }, actorId());
    return this.getQuote(row.id);
  }

  /**
   * Corrects a quote still waiting for its decision.
   *
   * @throws {ApiError} 400, 404, 409 once it is approved or rejected.
   */
  async updateQuote(quoteId, input) {
    const quote = await this.getQuote(quoteId);
    const fields = readFields(input, QUOTE_FIELDS, { partial: true });
    await this.#checkReferences(quote.projectId, fields);
    const row = await query.updateQuote(quote.id, fields, {
      actorId: actorId(),
      guard: "x.status in ('issued', 'in_review')",
    });
    if (!row) throw ApiError.conflict("A decided quote cannot be changed.");
    return this.getQuote(row.id);
  }

  /**
   * Moves a quote to `in_review`, `approved` or `rejected` (RF-FIN-03). The route requires
   * `finance.write`.
   *
   * @throws {ApiError} 400, 404, 409 when the move is not allowed from its status.
   */
  async decideQuote(quoteId, { decision, comment } = {}) {
    const quote = await this.getQuote(quoteId);
    const next = optionalChoice(decision, "decision", ["in_review", "approved", "rejected"]);
    if (next === null) throw ApiError.badRequest("decision is required.");
    const allowedFrom = Object.keys(QUOTE_MOVES).filter((status) => QUOTE_MOVES[status].includes(next));
    if (!allowedFrom.includes(quote.status)) {
      throw ApiError.conflict(`A quote that is ${quote.status} cannot move to ${next}.`);
    }

    const now = new Date().toISOString();
    const fields =
      next === "in_review"
        ? { status: next, in_review_at: now }
        : {
            status: next,
            decided_at: now,
            decided_by: actorId(),
            decision_comment: optionalText(comment, "comment", TEXT_MAX),
          };
    const row = await query.updateQuote(quote.id, fields, {
      action: "quote_decided",
      actorId: actorId(),
      guard: `x.status in (${allowedFrom.map((status) => `'${status}'`).join(", ")})`,
    });
    if (!row) throw ApiError.conflict("The quote changed meanwhile; reload it.");
    return this.getQuote(row.id);
  }

  /** @throws {ApiError} 404, 409 once decided. */
  async deleteQuote(quoteId) {
    const quote = await this.getQuote(quoteId);
    const row = await query.updateQuote(quote.id, { deleted_at: new Date().toISOString() }, {
      action: "quote_deleted",
      actorId: actorId(),
      guard: "x.status in ('issued', 'in_review') and not exists (select 1 from invoices i where i.quote_id = x.id and i.deleted_at is null)",
    });
    if (!row) throw ApiError.conflict("A decided quote, or one an invoice points at, cannot be deleted.");
    return shapeQuote(row);
  }

  /** Invoices across projects, newest first (RF-FIN-09). @throws {ApiError} 400 */
  async listInvoices({ status, projectId, limit, offset } = {}) {
    const rows = await query.listInvoices({
      status: optionalChoice(status, "status", INVOICE_STATUSES),
      projectId: optionalId(projectId, "projectId"),
      ...page({ limit, offset }),
    });
    return rows.map(shapeInvoice);
  }

  /** @throws {ApiError} 404 */
  async getInvoice(invoiceId) {
    const row = await query.getInvoice(requireId(invoiceId, "invoiceId"));
    if (!row) throw ApiError.notFound("Invoice not found.");
    return shapeInvoice(row);
  }

  /**
   * Uploads an invoice to a project, as `uploaded`. Only the amount is required (RF-FIN-06).
   *
   * @throws {ApiError} 400 on a bad field, an unknown provider, a quote of another project or a file
   *   outside the project, 404, 409 when the fiscal folio is already uploaded.
   */
  async createInvoice(projectId, input) {
    const id = await this.#liveProject(projectId);
    const fields = readFields(input, INVOICE_FIELDS);
    await this.#checkReferences(id, fields);
    const row = await uniquely(
      () => query.createInvoice({ ...fields, project_id: id, created_by: actorId() }, actorId()),
      "An invoice with that fiscal folio is already uploaded.",
    );
    return this.getInvoice(row.id);
  }

  /**
   * Corrects an invoice not yet sent.
   *
   * @throws {ApiError} 400, 404, 409 once sent or on a fiscal folio already uploaded.
   */
  async updateInvoice(invoiceId, input) {
    const invoice = await this.getInvoice(invoiceId);
    const fields = readFields(input, INVOICE_FIELDS, { partial: true });
    await this.#checkReferences(invoice.projectId, fields);
    const row = await uniquely(
      () => query.updateInvoice(invoice.id, fields, { actorId: actorId(), guard: "x.status = 'uploaded'" }),
      "An invoice with that fiscal folio is already uploaded.",
    );
    if (!row) throw ApiError.conflict("An invoice already sent cannot be changed.");
    return this.getInvoice(row.id);
  }

  /** @throws {ApiError} 404, 409 once sent. */
  async deleteInvoice(invoiceId) {
    const invoice = await this.getInvoice(invoiceId);
    const row = await query.updateInvoice(invoice.id, { deleted_at: new Date().toISOString() }, {
      action: "invoice_deleted",
      actorId: actorId(),
      guard: "x.status = 'uploaded'",
    });
    if (!row) throw ApiError.conflict("An invoice already sent cannot be deleted.");
    return shapeInvoice(row);
  }

  /** @throws {ApiError} 404 unless a live project. */
  async #liveProject(projectId) {
    const id = requireId(projectId, "projectId");
    if (!(await query.getProject(id))) throw ApiError.notFound("Project not found.");
    return id;
  }

  /**
   * Checks the ids a quote or invoice points at: a live provider, a quote of the same project, a
   * live file under the project's folder.
   *
   * @throws {ApiError} 400
   */
  async #checkReferences(projectId, fields) {
    if (fields.provider_id != null && !(await query.getProvider(fields.provider_id))) {
      throw ApiError.badRequest("providerId is not a live provider.");
    }
    if (fields.quote_id != null && (await query.getQuote(fields.quote_id))?.project_id !== projectId) {
      throw ApiError.badRequest("quoteId is not a quote of this project.");
    }
    if (fields.file_id != null && !(await query.isProjectFile(projectId, fields.file_id))) {
      throw ApiError.badRequest("fileId is not a file in this project's folder.");
    }
  }
}

function shapeProvider(row) {
  return {
    id: row.id,
    name: row.name,
    rfc: row.rfc,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

/**
 * Amounts leave as strings with two decimals. postgrejs reads `numeric` as a float, which holds
 * every `numeric(12,2)` exactly, so the fixed formatting loses no cent.
 */
const amount = (value) => (value === null || value === undefined ? null : Number(value).toFixed(2));

function shapeQuote(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key ?? null,
    projectTitle: row.project_title ?? null,
    providerId: row.provider_id,
    providerName: row.provider_name ?? null,
    entity: row.entity,
    amount: amount(row.amount),
    description: row.description,
    fileId: row.file_id,
    status: row.status,
    inReviewAt: row.in_review_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionComment: row.decision_comment,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function shapeInvoice(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key ?? null,
    projectTitle: row.project_title ?? null,
    quoteId: row.quote_id,
    providerId: row.provider_id,
    providerName: row.provider_name ?? null,
    amount: amount(row.amount),
    material: row.material,
    invoiceFolio: row.invoice_folio,
    fiscalFolio: row.fiscal_folio,
    destination: row.destination,
    fileId: row.file_id,
    status: row.status,
    paymentFolio: row.payment_folio,
    sentAt: row.sent_at,
    inPaymentAt: row.in_payment_at,
    paidAt: row.paid_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function shapeStanding(row) {
  return {
    projectId: row.id,
    key: row.key,
    title: row.title,
    requester: row.requester,
    hasCost: row.has_cost,
    closedAt: row.closed_at,
    archivedAt: row.archived_at,
    expectedInvoices: row.expected,
    uploadedInvoices: row.uploaded,
    missingInvoices: row.missing,
    invoiced: amount(row.invoiced),
    quotes: row.quotes,
    flags: row.flags,
  };
}

export default new Finance();
