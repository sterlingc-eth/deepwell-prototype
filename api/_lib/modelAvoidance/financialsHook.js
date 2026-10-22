/**
 * R32 (Team M, model avoidance): deterministic-first money extraction for invoice / quote / agreement documents.
 *
 * financials/extract.js makes one Haiku call per money document (~$0.003). For a plain labelled form the printed
 * total, invoice number, date, customer and job address are sitting on labelled lines, so this hook reads them
 * with the same template extractor used for fields (textExtract.js — same acceptance contract: refuse anything that
 * is not fully understood) and hands the result to the UNCHANGED financials pipeline
 * (extractFinancialsForDocument -> normalizeFinancials -> upsertFinancials) through its `callModel` seam, so every
 * validation (amount must be printed on a page, arithmetic flags, job-key derivation, human-reviewed rows left
 * alone) runs exactly as it does for a model result. Anything not accepted falls through to the original
 * extractFinancialsBestEffort (the model). Lives here, not in financials/, which another team owns.
 *
 * FINANCIALS_DETERMINISTIC=0 (or MODEL_AVOIDANCE=0) restores the model-only behaviour.
 */
import { withTenant } from "../recordsStore.js";
import { extractFinancialsBestEffort, isFinancialsEnabled } from "../financials/hook.js";
import { extractFinancialsForDocument } from "../financials/extract.js";
import { isFinancialDocumentType } from "../financials/normalize.js";
import { extractFromText } from "./textExtract.js";
import { isDeterministicFinancialsEnabled, isGenericExtractEnabled } from "./switches.js";
import { packForTenant } from "../industry/index.js";
import { normalizeDate } from "../extractFields.js";
import { canonicalTypeId } from "../documentTypes.js";
import { loadOwnNames } from "./ownCompany.js";

const KIND_BY_TYPE = { invoice: "invoice", "proposal-quote": "estimate", "maintenance-agreement": "agreement", "purchase-order": "po", receipt: "receipt" };

/**
 * Pure. The `extract_financials` tool input for one stored document, or null when the text is not a fully
 * understood labelled money form of `docType`.
 * @param {{page_no:number,text:string}[]} pages
 * @param {string} docType  the document's stored type
 * @param {{pack?: object|null}} [opts]  the tenant's industry pack (same acceptance rule as field extraction: every
 *   field the type requires found with high confidence, else null and the model reads the money)
 */
export function financialsInputFromText(pages, docType, opts = {}) {
  const type = canonicalTypeId(docType);
  let kind = KIND_BY_TYPE[type];
  if (!kind) return null;
  // Verify round (2026-10-22): a VOID / CANCELLED invoice must not be read as a live invoice with a balance (the new payment
  // reader would store it as UNPAID and "which invoices are unpaid" would count it). Leave it to the model / a person.
  if (kind === "invoice" || kind === "credit_memo") {
    for (const p of pages ?? []) for (const raw of String(p?.text ?? "").split(/\r?\n/)) {
      if (/^\s*[*\-_=#\s]*(?:void(?:ed)?|cancell?ed)[*\-_=#\s]*$/i.test(raw) || /^\s*(?:payment\s+)?status\s*:\s*(?:void(?:ed)?|cancell?ed)\s*\.?\s*$/i.test(raw)) return null;
    }
  }
  // The strict HVAC-template reading first, exactly as before (the hook never passed a pack, so it ran for every
  // industry); then the validated-label reading (receipt / PO / statement-shaped money documents, any pack).
  // Demo round (2026-10-22): the company's own names go in too (same as field extraction), so a supplier's bill addressed
  // to us is read as a bill FROM that supplier, never as an invoice to "us" as the customer.
  const ownNames = Array.isArray(opts.ownNames) ? opts.ownNames : [];
  let det = extractFromText(pages, { skipInstallGuard: true, generic: false, ownNames });
  if (!det.accepted && isGenericExtractEnabled()) det = extractFromText(pages, { skipInstallGuard: true, pack: opts.pack ?? null, ownNames });
  if (!det.accepted || det.type !== type) return null;
  if (det.variant === "credit_memo" && type === "invoice") kind = "credit_memo";
  const f = (key) => det.toolInput.fields.find((x) => x.key === key);
  const cost = f("cost");
  if (!cost) return null;
  const money = (fld) => ({ value: fld.value, page_no: fld.page_no, verbatim: fld.verbatim, confidence: 0.9 });
  const isPo = kind === "po";
  // Demo round (2026-10-22): a bill addressed to US (the own-company guard removed the customer and a vendor was read from
  // "Remit To" / the letterhead) is money WE owe, not money a customer owes us. It used to be stored as receivable, so a
  // supplier's bill showed up under "customers owe us". A document with a customer stays receivable, exactly as before.
  const custF = f("customer_name");
  const vendF = f("vendor");
  const billToUs = !isPo && !custF && !!vendF && (kind === "invoice" || kind === "credit_memo" || kind === "receipt");
  const input = { kind, direction: isPo || billToUs ? "payable" : "receivable", currency: "USD", printed_status: "none", total: money(cost), line_items: [], confidence: 0.9 };
  const inv = f("invoice_number");
  if (inv) { if (isPo) input.po_number = inv.value; else input.invoice_number = inv.value; }
  const dateFld = f("service_date");
  if (det.docDate) input.invoice_date = det.docDate;
  else if ((isPo || kind === "receipt") && dateFld) input.invoice_date = dateFld.value;
  const cust = f("customer_name");
  if (cust && !isPo) input.customer_name = cust.value;
  const vend = f("vendor");
  if (vend && (isPo || billToUs)) input.vendor_name = vend.value;
  const addr = f("service_address");
  if (addr) input.job_address = addr.value;
  // Demo round (2026-10-22): the printed payment state. Before this the deterministic path always sent printed_status
  // "none", so a labelled invoice that printed "Balance Due: $309.60" or "Status: Paid in full" was stored as payment
  // status UNKNOWN and "which invoices are unpaid?" could never count it. Same contract as the model prompt: only what
  // is printed on a labelled line; anything ambiguous is left out (never guessed). normalizeFinancials still checks
  // every amount is on its page and that total - paid = balance.
  if (kind === "invoice" || kind === "credit_memo") {
    Object.assign(input, printedPaymentFromText(pages));
    const due = printedDueDateFromText(pages);
    if (due) input.due_date = due;
  }
  const term = f("agreement_term");
  if (type === "maintenance-agreement" && term) {
    input.agreement_term = term.value;
    const m = /^(\S+)\s*(?:-|to|through|thru)\s*(\S+)$/i.exec(term.value.trim());
    const a = m ? normalizeDate(m[1]) : null;
    const b = m ? normalizeDate(m[2]) : null;
    if (a && b && a.length === 10 && b.length === 10) { input.period_start = a; input.period_end = b; }
  }
  return input;
}

const PAY_STATUS = [
  [/^paid(?:\s+in\s+full)?$/i, "paid"],
  [/^(?:unpaid|not\s+paid|open|due)$/i, "unpaid"],
  [/^(?:past\s+due|overdue)$/i, "overdue"],
  [/^(?:partial(?:ly)?(?:\s+paid)?|partial\s+payment)$/i, "partial"],
];
const MONEY_RE = "\\$?\\s*(-?[\\d,]+\\.\\d{2})";
const BALANCE_LINE = new RegExp(`^\\s*balance(?:\\s+due)?\\s*:\\s*${MONEY_RE}\\s*$`, "i");
const PAID_LINE = new RegExp(`^\\s*(?:amount\\s+paid|total\\s+paid|payments?\\s+received|deposit\\s+received|less\\s+payments?)\\s*:\\s*${MONEY_RE}\\s*$`, "i");
const STATUS_LINE = /^\s*(?:payment\s+)?status\s*:\s*([a-z ]{3,24}?)\s*\.?\s*$/i;

const DUE_LINE = /^\s*(?:due\s+date|payment\s+due|date\s+due|due\s+by)\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\s*$/i;
/** Pure. The one printed due date ("Due Date: 04/13/2026") as YYYY-MM-DD, or null (two different dates -> null). */
export function printedDueDateFromText(pages) {
  const seen = new Set();
  for (const p of pages ?? []) for (const raw of String(p?.text ?? "").split(/\r?\n/)) {
    const m = DUE_LINE.exec(raw.replace(/\s+/g, " ").trim());
    if (m) { const v = normalizeDate(m[1]); if (v && v.length === 10) seen.add(v); }
  }
  return seen.size === 1 ? [...seen][0] : null;
}

/**
 * Pure. The printed payment state of a labelled invoice: {printed_status?, balance_due?, amount_paid?} read ONLY from
 * whole "Label: value" lines (Balance Due / Amount Paid / Deposit Received / Status). A label printed twice with two
 * different values, or a status word this table does not know, yields nothing for that item.
 * @param {{page_no:number,text:string}[]} pages
 */
export function printedPaymentFromText(pages) {
  const found = { balance: [], paid: [], status: [] };
  for (const p of pages ?? []) {
    for (const raw of String(p?.text ?? "").split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) continue;
      let m;
      if ((m = BALANCE_LINE.exec(line))) found.balance.push({ value: m[1].replace(/,/g, ""), page_no: p.page_no, verbatim: line.slice(0, 200), confidence: 0.9 });
      else if ((m = PAID_LINE.exec(line))) found.paid.push({ value: m[1].replace(/,/g, ""), page_no: p.page_no, verbatim: line.slice(0, 200), confidence: 0.9 });
      else if ((m = STATUS_LINE.exec(line))) {
        const hit = PAY_STATUS.find(([re]) => re.test(m[1].trim()));
        if (hit) found.status.push(hit[1]);
      }
    }
  }
  const one = (list, key) => (list.length && list.every((x) => (key ? x[key] === list[0][key] : x === list[0])) ? list[0] : null);
  const out = {};
  const bal = one(found.balance, "value");
  const paid = one(found.paid, "value");
  const status = one(found.status);
  if (bal) out.balance_due = bal;
  if (paid) out.amount_paid = paid;
  if (status) out.printed_status = status;
  else if (bal && Number(bal.value) > 0) out.printed_status = "unpaid";
  return out;
}

/**
 * Same contract as financials/hook.js's extractFinancialsBestEffort (never throws; same argument shape), but tries
 * the deterministic path first.
 * @param {{tenantKey: string, tenantName?: string}} ctx
 * @param {string} documentId
 * @param {{documentType?: string, modelAttempts?: number}} [opts]
 */
export async function extractFinancialsDeterministicFirst(ctx, documentId, opts = {}) {
  if (!isFinancialsEnabled()) return { status: "skipped", reason: "disabled" };
  if (opts.documentType && !isFinancialDocumentType(opts.documentType)) return { status: "skipped", reason: "not_financial" };
  if (!isDeterministicFinancialsEnabled()) return extractFinancialsBestEffort(ctx, documentId, opts);
  try {
    const loaded = await withTenant(ctx, async (db) => {
      const doc = await db.getDocument(documentId);
      if (!doc) return null;
      return { type: opts.documentType || doc.document_type, pages: await db.listPages(documentId), pack: await packForTenant(db), ownNames: await loadOwnNames(db, ctx) };
    });
    if (loaded && isFinancialDocumentType(loaded.type)) {
      const input = financialsInputFromText(loaded.pages, loaded.type, { pack: loaded.pack, ownNames: loaded.ownNames });
      if (input) {
        const res = await extractFinancialsForDocument(ctx, documentId, {
          withTenant, documentType: loaded.type, modelAttempts: opts.modelAttempts, skipBudget: true,
          callModel: async () => ({ input, usage: { inputTokens: 0, outputTokens: 0 } }),
        });
        if (res.status === "written") {
          // provenance: the row says it was read by the deterministic text extractor, not a model
          await withTenant(ctx, (db) => db.raw(
            "UPDATE document_financials SET model = $2 WHERE document_id = $1 AND tenant_id = (current_setting('app.tenant_id', true))::uuid",
            [documentId, "deterministic-text"])).catch(() => {});
          return { ...res, method: "text" };
        }
        if (res.status === "skipped") return { ...res, method: "text" };
        // 'failed' (normalization refused it) -> let the model have a look
      }
    }
  } catch (err) {
    console.error("financials: deterministic path failed, using the model path:", err?.name ?? "error");
  }
  return extractFinancialsBestEffort(ctx, documentId, opts);
}
