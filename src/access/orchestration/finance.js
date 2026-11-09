// The finance cycle: quotes, invoices, oficios, payments, referenced receipts and providers, and
// what each project is still missing (RF-FIN-01 to RF-FIN-18). Areas rarely upload everything, so
// little is required and finance reads the gaps instead (DATAMODEL §2.20). Every write logs itself
// in the same statement, not via events.
import query from "../resources/query.js";
import notifications from "./notifications.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  UNIQUE_VIOLATION,
  optionalText,
  requireText,
  requireId,
  optionalId,
  optionalBoolean,
  optionalDate,
  uniqueIds,
} from "../../utils/validate.js";

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

/** RF-FIN-10. `sent` is set by the oficio that carries the invoice; the rest by INVOICE_MOVES. */
const INVOICE_STATUSES = ["uploaded", "sent", "in_payment", "paid"];

/** RF-FIN-10: where an invoice may move by hand, from which statuses, and the date it stamps. */
const INVOICE_MOVES = {
  in_payment: { from: ["uploaded", "sent"], stamp: "in_payment_at" },
  paid: { from: ["in_payment"], stamp: "paid_at" },
};

/** RF-FIN-12: an oficio's steps in order. It moves forward and may skip; each step reached is dated. */
const OFICIO_STEPS = ["issued", "sent", "signed", "answered", "paid"];
const OFICIO_STAMPS = { sent: "sent_at", signed: "signed_at", answered: "answered_at", paid: "paid_at" };

/** RF-FIN-15: `incoming` pays an oficio, `outgoing` pays a provider's invoice. */
const PAYMENT_DIRECTIONS = ["incoming", "outgoing"];

/**
 * RF-FIN-16: a referenced receipt is drafted, submitted, validated by someone else, then issued
 * and paid; a rejection returns it to draft. These are the moves after validation.
 */
const RECEIPT_STATUSES = ["draft", "pending_validation", "validated", "issued", "paid", "cancelled"];
const RECEIPT_MOVES = {
  issued: { from: ["validated"], stamp: "issued_at" },
  paid: { from: ["issued"], stamp: "paid_at" },
  cancelled: { from: ["draft", "pending_validation", "validated", "issued"], stamp: "cancelled_at" },
};

/** What finance's project list can be filtered by; computed in query.financeProjects(). */
export const FINANCE_FLAGS = [
  "missing_invoices",
  "costed_no_quote",
  "delivered_no_invoice",
  "invoice_not_in_oficio",
  "oficio_unanswered",
  "payment_no_folio",
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

const OFICIO_FIELDS = {
  folio: ["folio", (v) => requireText(v, "folio", FOLIO_MAX)],
  recipient: ["recipient", (v) => optionalText(v, "recipient", NAME_MAX)],
  amount: ["amount", (v) => requireAmount(v, "amount")],
  note: ["note", (v) => optionalText(v, "note", TEXT_MAX)],
  stampedFileId: ["stamped_file_id", (v) => optionalId(v, "stampedFileId")],
};

const PAYMENT_FIELDS = {
  providerId: ["provider_id", (v) => optionalId(v, "providerId")],
  amount: ["amount", (v) => requireAmount(v, "amount")],
  paidOn: ["paid_on", (v) => optionalDate(v, "paidOn")],
  trackingFolio: ["tracking_folio", (v) => optionalText(v, "trackingFolio", FOLIO_MAX)],
  proofFileId: ["proof_file_id", (v) => optionalId(v, "proofFileId")],
  note: ["note", (v) => optionalText(v, "note", TEXT_MAX)],
};

const RECEIPT_FIELDS = {
  quoteId: ["quote_id", (v) => optionalId(v, "quoteId")],
  requester: ["requester", (v) => optionalText(v, "requester", NAME_MAX)],
  amount: ["amount", (v) => requireAmount(v, "amount")],
  reference: ["reference", (v) => optionalText(v, "reference", FOLIO_MAX)],
  concept: ["concept", (v) => optionalText(v, "concept", TEXT_MAX)],
  fileId: ["file_id", (v) => optionalId(v, "fileId")],
};

/** The file columns a finance record may point at, each checked to lie in the project's folder. */
const FILE_COLUMNS = { file_id: "fileId", stamped_file_id: "stampedFileId", proof_file_id: "proofFileId" };

/** `column in ('a', 'b')` for a guard. The values are this module's own constants, never input. */
const inList = (column, values) => `${column} in (${values.map((value) => `'${value}'`).join(", ")})`;

/**
 * Reads `input` through `spec` into column values. `partial` skips absent keys (a PATCH); a full
 * read parses every key, so a required one that is missing is a 400. `allowEmpty` lets a partial
 * read find nothing, when the caller changes something else.
 *
 * @throws {ApiError} 400, or when a partial read has nothing to change.
 */
function readFields(input, spec, { partial = false, allowEmpty = false } = {}) {
  const fields = {};
  for (const [key, [column, parse]] of Object.entries(spec)) {
    if (partial && input?.[key] === undefined) continue;
    fields[column] = parse(input?.[key]);
  }
  if (partial && !allowEmpty && Object.keys(fields).length === 0) throw ApiError.badRequest("Nothing to change.");
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
    const [quotes, invoices, oficios, payments, receipts] = await Promise.all([
      query.listQuotes({ projectId: id, limit: PAGE_MAX }),
      query.listInvoices({ projectId: id, limit: PAGE_MAX }),
      query.listOficios({ projectId: id, limit: PAGE_MAX }),
      query.listPayments({ projectId: id, limit: PAGE_MAX }),
      query.listReceipts({ projectId: id, limit: PAGE_MAX }),
    ]);
    return {
      ...shapeStanding(standing),
      quotes: quotes.map(shapeQuote),
      invoices: invoices.map(shapeInvoice),
      oficios: oficios.map(shapeOficio),
      payments: payments.map(shapePayment),
      receipts: receipts.map(shapeReceipt),
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

  /**
   * Refuses to mark a project as having no finance while it holds any finance record or a declared
   * invoice count: marking it would hide them (DATAMODEL §2.20).
   *
   * @throws {ApiError} 409
   */
  async assertCanSkip(projectId) {
    const [standing] = await query.financeProjects({ projectId });
    if (!standing) return;
    const records = standing.quotes + standing.uploaded + standing.oficios + standing.payments + standing.receipts;
    if (records > 0 || standing.expected !== null) {
      throw ApiError.conflict("A project with finance records or expected invoices cannot be marked as having no finance.");
    }
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

  /** @throws {ApiError} 404 unless a live project, 409 when it is marked as having no finance. */
  async #liveProject(projectId) {
    const id = requireId(projectId, "projectId");
    const project = await query.getProject(id);
    if (!project) throw ApiError.notFound("Project not found.");
    if (project.no_finance) throw ApiError.conflict("This project is marked as having no finance.");
    return id;
  }

  /**
   * Checks the ids a finance record points at: a live provider, a quote of the same project, live
   * files under the project's folder.
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
    for (const [column, field] of Object.entries(FILE_COLUMNS)) {
      if (fields[column] != null && !(await query.isProjectFile(projectId, fields[column]))) {
        throw ApiError.badRequest(`${field} is not a file in this project's folder.`);
      }
    }
  }

  /** Oficios across projects; with `unansweredDays`, those waiting longer, oldest first (RF-FIN-13). @throws {ApiError} 400 */
  async listOficios({ status, projectId, unansweredDays, limit, offset } = {}) {
    const days =
      unansweredDays === undefined || unansweredDays === "" ? null : Number(unansweredDays);
    if (days !== null && (!Number.isInteger(days) || days < 0)) {
      throw ApiError.badRequest("unansweredDays must be a non-negative integer.");
    }
    const rows = await query.listOficios({
      status: optionalChoice(status, "status", OFICIO_STEPS),
      projectId: optionalId(projectId, "projectId"),
      unansweredDays: days,
      ...page({ limit, offset }),
    });
    return rows.map(shapeOficio);
  }

  /** @throws {ApiError} 404 */
  async getOficio(oficioId) {
    const row = await query.getOficio(requireId(oficioId, "oficioId"));
    if (!row) throw ApiError.notFound("Oficio not found.");
    return shapeOficio(row);
  }

  /**
   * Issues an oficio charging the requesting entity, with the invoices it carries (RF-FIN-11).
   *
   * @throws {ApiError} 400 on a bad field or an invoice of another project, 404, 409 on a folio
   *   already used or an invoice already sent or in another oficio.
   */
  async createOficio(projectId, input) {
    const id = await this.#liveProject(projectId);
    const fields = readFields(input, OFICIO_FIELDS);
    const invoiceIds = uniqueIds(input?.invoiceIds, "invoiceIds");
    await this.#checkReferences(id, fields);
    await this.#checkOficioInvoices(id, invoiceIds, null);
    const row = await uniquely(
      () => query.createOficio({ ...fields, project_id: id, created_by: actorId() }, invoiceIds, actorId()),
      "An oficio with that folio already exists.",
    );
    return this.getOficio(row.id);
  }

  /**
   * Corrects an oficio. Its fields change at any step -- the stamped document arrives once it is
   * signed -- but `invoiceIds`, which replaces its invoices, only while it is `issued`.
   *
   * @throws {ApiError} 400, 404, 409 on a folio already used, or invoices of an oficio already sent.
   */
  async updateOficio(oficioId, input) {
    const oficio = await this.getOficio(oficioId);
    const hasInvoices = input?.invoiceIds !== undefined;
    const fields = readFields(input, OFICIO_FIELDS, { partial: true, allowEmpty: hasInvoices });
    await this.#checkReferences(oficio.projectId, fields);

    if (Object.keys(fields).length > 0) {
      const row = await uniquely(
        () => query.updateOficio(oficio.id, fields, { actorId: actorId() }),
        "An oficio with that folio already exists.",
      );
      if (!row) throw ApiError.notFound("Oficio not found.");
    }
    if (hasInvoices) {
      if (oficio.status !== "issued") throw ApiError.conflict("The invoices of an oficio already sent cannot change.");
      const invoiceIds = uniqueIds(input.invoiceIds, "invoiceIds");
      await this.#checkOficioInvoices(oficio.projectId, invoiceIds, oficio.id);
      if (!(await query.setOficioInvoices(oficio.id, invoiceIds, actorId()))) {
        throw ApiError.conflict("The invoices of an oficio already sent cannot change.");
      }
    }
    return this.getOficio(oficio.id);
  }

  /**
   * Moves an oficio forward, possibly skipping steps; only the step reached gets its date
   * (RF-FIN-12). Leaving `issued` marks its invoices `sent`. Reaching `sent` (or skipping past it)
   * and reaching `paid` remind the actor to email the people who uploaded its invoices.
   *
   * @throws {ApiError} 400 on an unknown step, 404, 409 when it is not ahead of the current one.
   */
  async advanceOficio(oficioId, { status } = {}) {
    const oficio = await this.getOficio(oficioId);
    const next = optionalChoice(status, "status", OFICIO_STEPS.slice(1));
    if (next === null) throw ApiError.badRequest("status is required.");
    const from = OFICIO_STEPS.slice(0, OFICIO_STEPS.indexOf(next));
    if (!from.includes(oficio.status)) {
      throw ApiError.conflict(`An oficio that is ${oficio.status} cannot move to ${next}.`);
    }

    const row = await query.advanceOficio(
      oficio.id,
      { status: next, stampColumn: OFICIO_STAMPS[next], from, at: new Date().toISOString() },
      actorId(),
    );
    if (!row) throw ApiError.conflict("The oficio changed meanwhile; reload it.");

    const step = next === "paid" ? "paid" : oficio.status === "issued" ? "sent" : null;
    if (step) await notifications.remindOficioEmail({ id: oficio.id, folio: oficio.folio }, actorId(), step);
    return this.getOficio(oficio.id);
  }

  /** Deletes an oficio still `issued`, releasing its invoices. @throws {ApiError} 404, 409 once sent. */
  async deleteOficio(oficioId) {
    const oficio = await this.getOficio(oficioId);
    const row = await query.deleteOficio(oficio.id, actorId(), new Date().toISOString());
    if (!row) throw ApiError.conflict("An oficio already sent cannot be deleted.");
    return shapeOficio({ ...row, invoices: [] });
  }

  /**
   * Moves an invoice to `in_payment`, with the folio that proves it (RF-FIN-10), or from there to
   * `paid`. `sent` is never set here: the oficio sets it.
   *
   * @throws {ApiError} 400 on an unknown status or a missing folio, 404, 409 when not allowed from its status.
   */
  async setInvoiceStatus(invoiceId, { status, paymentFolio } = {}) {
    const invoice = await this.getInvoice(invoiceId);
    const next = optionalChoice(status, "status", Object.keys(INVOICE_MOVES));
    if (next === null) throw ApiError.badRequest("status is required.");
    const move = INVOICE_MOVES[next];
    if (!move.from.includes(invoice.status)) {
      throw ApiError.conflict(`An invoice that is ${invoice.status} cannot move to ${next}.`);
    }

    const fields = { status: next, [move.stamp]: new Date().toISOString() };
    if (next === "in_payment") fields.payment_folio = requireText(paymentFolio, "paymentFolio", FOLIO_MAX);
    const row = await query.updateInvoice(invoice.id, fields, {
      action: "invoice_status_changed",
      actorId: actorId(),
      guard: inList("x.status", move.from),
    });
    if (!row) throw ApiError.conflict("The invoice changed meanwhile; reload it.");
    return this.getInvoice(row.id);
  }

  /** Payments across projects; `missingFolio` keeps those without a tracking folio (RF-FIN-14). @throws {ApiError} 400 */
  async listPayments({ direction, projectId, missingFolio, limit, offset } = {}) {
    const rows = await query.listPayments({
      direction: optionalChoice(direction, "direction", PAYMENT_DIRECTIONS),
      projectId: optionalId(projectId, "projectId"),
      missingFolio: optionalBoolean(missingFolio, "missingFolio"),
      ...page({ limit, offset }),
    });
    return rows.map(shapePayment);
  }

  /** @throws {ApiError} 404 */
  async getPayment(paymentId) {
    const row = await query.getPayment(requireId(paymentId, "paymentId"));
    if (!row) throw ApiError.notFound("Payment not found.");
    return shapePayment(row);
  }

  /**
   * Records a payment: `incoming` pays an oficio of the project, `outgoing` pays one of its
   * invoices. It never moves a status; the oficio or invoice shows what is left (`balance`).
   *
   * @throws {ApiError} 400 on a bad field, a missing target or one of another project, 404.
   */
  async createPayment(projectId, input) {
    const id = await this.#liveProject(projectId);
    const direction = optionalChoice(input?.direction, "direction", PAYMENT_DIRECTIONS);
    if (direction === null) throw ApiError.badRequest("direction is required.");
    const fields = readFields(input, PAYMENT_FIELDS);
    await this.#checkReferences(id, fields);

    const target = { oficio_id: null, invoice_id: null };
    if (direction === "incoming") {
      target.oficio_id = requireId(input?.oficioId, "oficioId");
      if ((await query.getOficio(target.oficio_id))?.project_id !== id) {
        throw ApiError.badRequest("oficioId is not an oficio of this project.");
      }
    } else {
      target.invoice_id = requireId(input?.invoiceId, "invoiceId");
      if ((await query.getInvoice(target.invoice_id))?.project_id !== id) {
        throw ApiError.badRequest("invoiceId is not an invoice of this project.");
      }
    }

    const row = await query.createPayment(
      { ...fields, ...target, project_id: id, direction, created_by: actorId() },
      actorId(),
    );
    return this.getPayment(row.id);
  }

  /** Corrects a payment, typically adding its tracking folio later. @throws {ApiError} 400, 404 */
  async updatePayment(paymentId, input) {
    const payment = await this.getPayment(paymentId);
    const fields = readFields(input, PAYMENT_FIELDS, { partial: true });
    await this.#checkReferences(payment.projectId, fields);
    const row = await query.updatePayment(payment.id, fields, { actorId: actorId() });
    if (!row) throw ApiError.notFound("Payment not found.");
    return this.getPayment(row.id);
  }

  /** @throws {ApiError} 404 */
  async deletePayment(paymentId) {
    const payment = await this.getPayment(paymentId);
    const row = await query.updatePayment(payment.id, { deleted_at: new Date().toISOString() }, {
      action: "payment_deleted",
      actorId: actorId(),
    });
    if (!row) throw ApiError.notFound("Payment not found.");
    return shapePayment(row);
  }

  /** Referenced receipts across projects. @throws {ApiError} 400 */
  async listReceipts({ status, projectId, limit, offset } = {}) {
    const rows = await query.listReceipts({
      status: optionalChoice(status, "status", RECEIPT_STATUSES),
      projectId: optionalId(projectId, "projectId"),
      ...page({ limit, offset }),
    });
    return rows.map(shapeReceipt);
  }

  /** @throws {ApiError} 404 */
  async getReceipt(receiptId) {
    const row = await query.getReceipt(requireId(receiptId, "receiptId"));
    if (!row) throw ApiError.notFound("Receipt not found.");
    return shapeReceipt(row);
  }

  /**
   * Drafts a referenced receipt: coordination charging the requesting entity (RF-FIN-15).
   *
   * @throws {ApiError} 400 on a bad field, a quote of another project or a file outside it, 404.
   */
  async createReceipt(projectId, input) {
    const id = await this.#liveProject(projectId);
    const fields = readFields(input, RECEIPT_FIELDS);
    await this.#checkReferences(id, fields);
    const row = await query.createReceipt({ ...fields, project_id: id, created_by: actorId() }, actorId());
    return this.getReceipt(row.id);
  }

  /** Corrects a draft. @throws {ApiError} 400, 404, 409 once submitted. */
  async updateReceipt(receiptId, input) {
    const receipt = await this.getReceipt(receiptId);
    const fields = readFields(input, RECEIPT_FIELDS, { partial: true });
    await this.#checkReferences(receipt.projectId, fields);
    const row = await query.updateReceipt(receipt.id, fields, { actorId: actorId(), guard: "x.status = 'draft'" });
    if (!row) throw ApiError.conflict("Only a draft receipt can be changed.");
    return this.getReceipt(row.id);
  }

  /** Sends a draft to be validated (RF-FIN-16). @throws {ApiError} 404, 409 unless a draft. */
  async submitReceipt(receiptId) {
    const receipt = await this.getReceipt(receiptId);
    const row = await query.updateReceipt(
      receipt.id,
      { status: "pending_validation", submitted_at: new Date().toISOString() },
      { action: "receipt_submitted", actorId: actorId(), guard: "x.status = 'draft'" },
    );
    if (!row) throw ApiError.conflict("Only a draft receipt can be submitted.");
    return this.getReceipt(row.id);
  }

  /**
   * Validates a submitted receipt, or sends it back to draft with the reason (RF-FIN-16). Never by
   * whoever created it. The route requires `finance.validate`.
   *
   * @throws {ApiError} 400 on a missing decision, 403 on the creator, 404, 409 unless awaiting validation.
   */
  async validateReceipt(receiptId, { decision, comment } = {}) {
    const receipt = await this.getReceipt(receiptId);
    const verdict = optionalChoice(decision, "decision", ["approved", "rejected"]);
    if (verdict === null) throw ApiError.badRequest("decision is required.");
    if (receipt.createdBy !== null && String(receipt.createdBy) === String(actorId())) {
      throw ApiError.forbidden("A receipt cannot be validated by whoever created it.");
    }

    const note = optionalText(comment, "comment", TEXT_MAX);
    const approved = verdict === "approved";
    const fields = approved
      ? { status: "validated", validated_by: actorId(), validated_at: new Date().toISOString(), validation_comment: note }
      : { status: "draft", validation_comment: note };
    const row = await query.updateReceipt(receipt.id, fields, {
      action: approved ? "receipt_validated" : "receipt_rejected",
      actorId: actorId(),
      guard: "x.status = 'pending_validation'",
    });
    if (!row) throw ApiError.conflict("Only a receipt awaiting validation can be validated.");
    return this.getReceipt(row.id);
  }

  /**
   * Issues a validated receipt, marks an issued one paid, or cancels any not yet paid.
   *
   * @throws {ApiError} 400 on an unknown status, 404, 409 when not allowed from its status.
   */
  async setReceiptStatus(receiptId, { status } = {}) {
    const receipt = await this.getReceipt(receiptId);
    const next = optionalChoice(status, "status", Object.keys(RECEIPT_MOVES));
    if (next === null) throw ApiError.badRequest("status is required.");
    const move = RECEIPT_MOVES[next];
    if (!move.from.includes(receipt.status)) {
      throw ApiError.conflict(`A receipt that is ${receipt.status} cannot move to ${next}.`);
    }
    const row = await query.updateReceipt(
      receipt.id,
      { status: next, [move.stamp]: new Date().toISOString() },
      { action: "receipt_status_changed", actorId: actorId(), guard: inList("x.status", move.from) },
    );
    if (!row) throw ApiError.conflict("The receipt changed meanwhile; reload it.");
    return this.getReceipt(row.id);
  }

  /**
   * Checks the invoices an oficio is to carry: of this project, live, `uploaded`, and in no other
   * oficio than `oficioId`.
   *
   * @throws {ApiError} 400 on an invoice of another project, 409 on one already sent or taken.
   */
  async #checkOficioInvoices(projectId, invoiceIds, oficioId) {
    for (const invoiceId of invoiceIds) {
      const invoice = await query.getInvoice(invoiceId);
      if (invoice?.project_id !== projectId) {
        throw ApiError.badRequest(`Invoice ${invoiceId} is not an invoice of this project.`);
      }
      if (invoice.status !== "uploaded" || (invoice.oficio_id !== null && invoice.oficio_id !== oficioId)) {
        throw ApiError.conflict(`Invoice ${invoiceId} is already sent or in another oficio.`);
      }
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
    oficioId: row.oficio_id ?? null,
    oficioFolio: row.oficio_folio ?? null,
    paymentFolio: row.payment_folio,
    paidAmount: amount(row.paid_amount ?? 0),
    balance: amount(Number(row.amount) - Number(row.paid_amount ?? 0)),
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
    noFinance: row.no_finance,
    closedAt: row.closed_at,
    archivedAt: row.archived_at,
    expectedInvoices: row.expected,
    uploadedInvoices: row.uploaded,
    missingInvoices: row.missing,
    invoiced: amount(row.invoiced),
    quotes: row.quotes,
    oficios: row.oficios,
    payments: row.payments,
    receipts: row.receipts,
    flags: row.flags,
  };
}

function shapeOficio(row) {
  const invoices = (row.invoices ?? []).map((invoice) => ({ ...invoice, amount: amount(invoice.amount) }));
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key ?? null,
    projectTitle: row.project_title ?? null,
    folio: row.folio,
    recipient: row.recipient,
    amount: amount(row.amount),
    note: row.note,
    stampedFileId: row.stamped_file_id,
    status: row.status,
    sentAt: row.sent_at,
    signedAt: row.signed_at,
    answeredAt: row.answered_at,
    paidAt: row.paid_at,
    daysUnanswered: row.days_unanswered ?? null,
    invoices,
    invoicesTotal: amount(row.invoices_total ?? 0),
    amountMismatch: amount(row.amount) !== amount(row.invoices_total ?? 0),
    paidAmount: amount(row.paid_amount ?? 0),
    balance: amount(Number(row.amount) - Number(row.paid_amount ?? 0)),
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

/** A `date` column as `YYYY-MM-DD`; postgrejs reads it as local midnight. */
function asDate(value) {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date)) return value;
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function shapePayment(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key ?? null,
    direction: row.direction,
    oficioId: row.oficio_id,
    oficioFolio: row.oficio_folio ?? null,
    invoiceId: row.invoice_id,
    invoiceFolio: row.invoice_folio ?? null,
    providerId: row.provider_id,
    providerName: row.provider_name ?? null,
    amount: amount(row.amount),
    paidOn: asDate(row.paid_on),
    trackingFolio: row.tracking_folio,
    proofFileId: row.proof_file_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function shapeReceipt(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project_key ?? null,
    quoteId: row.quote_id,
    requester: row.requester,
    amount: amount(row.amount),
    reference: row.reference,
    concept: row.concept,
    fileId: row.file_id,
    status: row.status,
    submittedAt: row.submitted_at,
    validatedBy: row.validated_by,
    validatedAt: row.validated_at,
    validationComment: row.validation_comment,
    issuedAt: row.issued_at,
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export default new Finance();
