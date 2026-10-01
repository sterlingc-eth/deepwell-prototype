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
import { isDeterministicFinancialsEnabled } from "./switches.js";
import { normalizeDate } from "../extractFields.js";
import { canonicalTypeId } from "../documentTypes.js";

const KIND_BY_TYPE = { invoice: "invoice", "proposal-quote": "estimate", "maintenance-agreement": "agreement" };

/**
 * Pure. The `extract_financials` tool input for one stored document, or null when the text is not a fully
 * understood labelled money form of `docType`.
 * @param {{page_no:number,text:string}[]} pages
 * @param {string} docType  the document's stored type
 */
export function financialsInputFromText(pages, docType) {
  const type = canonicalTypeId(docType);
  const kind = KIND_BY_TYPE[type];
  if (!kind) return null;
  const det = extractFromText(pages, { skipInstallGuard: true });
  if (!det.accepted || det.type !== type) return null;
  const f = (key) => det.toolInput.fields.find((x) => x.key === key);
  const cost = f("cost");
  if (!cost) return null;
  const money = (fld) => ({ value: fld.value, page_no: fld.page_no, verbatim: fld.verbatim, confidence: 0.9 });
  const input = { kind, direction: "receivable", currency: "USD", printed_status: "none", total: money(cost), line_items: [], confidence: 0.9 };
  const inv = f("invoice_number");
  if (inv) input.invoice_number = inv.value;
  if (det.docDate) input.invoice_date = det.docDate;
  const cust = f("customer_name");
  if (cust) input.customer_name = cust.value;
  const addr = f("service_address");
  if (addr) input.job_address = addr.value;
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
      return { type: opts.documentType || doc.document_type, pages: await db.listPages(documentId) };
    });
    if (loaded && isFinancialDocumentType(loaded.type)) {
      const input = financialsInputFromText(loaded.pages, loaded.type);
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
