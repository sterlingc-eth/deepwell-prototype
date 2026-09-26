/**
 * Financials layer — database access (M3-config/22-document-financials.sql).
 *
 * Every function takes the recordsStore `db` (the object withTenant hands its callback), so
 * every statement already runs inside a tenant transaction with app.tenant_id set and
 * FORCE ROW LEVEL SECURITY in effect; nothing here trusts a tenant id from a caller.
 *
 * TOLERANT OF THE MIGRATION NOT BEING PASTED: `financialsTableExists` probes to_regclass()
 * (a catalogue read that cannot abort the transaction, unlike a failed SELECT) and every
 * public entry point returns a benign "off" result when the tables are absent. A positive
 * probe is memoized for the life of the warm instance; a negative one is re-checked every
 * 30 s so pasting the migration takes effect without a redeploy.
 *
 * No question text, amounts or names are ever logged here.
 */
import {
  MONEY_FIELDS, EDITABLE_FIELDS, REVIEW_FLAGS, effectiveHeader, recomputeFlags, needsReview, validateCorrection,
} from './normalize.js';
import { jobCostingColumnsExist } from './jobCosting.js';

const TENANT = "(current_setting('app.tenant_id', true))::uuid";
const NEGATIVE_TTL_MS = 30_000;

let tableKnown = null; // true | {falseUntil:number}
export function _resetFinancialsProbe() { tableKnown = null; }

export async function financialsTableExists(db) {
  if (tableKnown === true) return true;
  if (tableKnown && tableKnown.falseUntil > Date.now()) return false;
  try {
    const r = await db.raw("SELECT to_regclass('public.document_financials') IS NOT NULL AS ok, to_regclass('public.document_financial_lines') IS NOT NULL AS ok2", []);
    const ok = Boolean(r.rows[0]?.ok && r.rows[0]?.ok2);
    tableKnown = ok ? true : { falseUntil: Date.now() + NEGATIVE_TTL_MS };
    return ok;
  } catch {
    return false; // a transient failure is never memoized
  }
}

/** Does this tenant have at least one financial row carrying a total? (RLS-scoped.) */
export async function tenantHasFinancialRows(db) {
  if (!(await financialsTableExists(db))) return false;
  const r = await db.raw('SELECT EXISTS (SELECT 1 FROM document_financials WHERE total IS NOT NULL OR corrections ? \'total\') AS has', []);
  return Boolean(r.rows[0]?.has);
}

/** Small catalogue block for describe_data, or null when the feature is off / empty. */
export async function financialsCatalogue(db) {
  if (!(await financialsTableExists(db))) return null;
  const r = await db.raw(
    `SELECT count(*)::int AS rows, count(*) FILTER (WHERE total IS NOT NULL OR corrections ? 'total')::int AS with_total,
            count(*) FILTER (WHERE verified_by IS NOT NULL)::int AS verified
       FROM document_financials`, []);
  const row = r.rows[0];
  return row && row.rows > 0 ? { documents: row.rows, withTotal: row.with_total, verifiedByPerson: row.verified } : null;
}

/* ------------------------------------------------------------------- writes */

const HEADER_COLS = [
  'doc_kind', 'direction', 'currency', 'invoice_number', 'po_number', 'invoice_date', 'due_date', 'period_start', 'period_end',
  'agreement_term', 'subtotal', 'tax', 'total', 'amount_paid', 'balance_due', 'status', 'customer_name', 'vendor_name',
];

/**
 * Insert or replace the extracted financials of one document (header + lines), idempotently.
 * A row a person has corrected or verified is NEVER overwritten: returns {written:false,
 * reason:'human_reviewed'}. `norm` is normalizeFinancials()'s output.
 * @returns {Promise<{written: boolean, reason?: string, financialId?: string}>}
 */
export async function upsertFinancials(db, documentId, norm, { model } = {}) {
  if (!norm?.ok || !norm.header) return { written: false, reason: 'not_financial' };
  if (!(await financialsTableExists(db))) return { written: false, reason: 'table_missing' };
  const h = norm.header;
  const r = await db.raw(
    `INSERT INTO document_financials
       (tenant_id, document_id, doc_kind, direction, currency, invoice_number, po_number, invoice_date, due_date, period_start, period_end,
        agreement_term, subtotal, tax, total, amount_paid, balance_due, status, customer_name, vendor_name, confidence, flags, evidence, model, extracted_at)
     VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7::date, $8::date, $9::date, $10::date, $11, $12::numeric, $13::numeric, $14::numeric,
             $15::numeric, $16::numeric, $17, $18, $19, $20::numeric, $21::text[], $22::jsonb, $23, NOW())
     ON CONFLICT (tenant_id, document_id) DO UPDATE SET
       doc_kind = EXCLUDED.doc_kind, direction = EXCLUDED.direction, currency = EXCLUDED.currency,
       invoice_number = EXCLUDED.invoice_number, po_number = EXCLUDED.po_number, invoice_date = EXCLUDED.invoice_date,
       due_date = EXCLUDED.due_date, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
       agreement_term = EXCLUDED.agreement_term, subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax, total = EXCLUDED.total,
       amount_paid = EXCLUDED.amount_paid, balance_due = EXCLUDED.balance_due, status = EXCLUDED.status,
       customer_name = EXCLUDED.customer_name, vendor_name = EXCLUDED.vendor_name, confidence = EXCLUDED.confidence,
       flags = EXCLUDED.flags, evidence = EXCLUDED.evidence, model = EXCLUDED.model, extracted_at = NOW()
     WHERE document_financials.corrections = '{}'::jsonb AND document_financials.verified_by IS NULL
     RETURNING id`,
    [
      documentId, h.doc_kind, h.direction, h.currency, h.invoice_number, h.po_number, h.invoice_date, h.due_date, h.period_start,
      h.period_end, h.agreement_term, h.subtotal, h.tax, h.total, h.amount_paid, h.balance_due, h.status, h.customer_name,
      h.vendor_name, norm.confidence, `{${norm.flags.map((f) => `"${f}"`).join(',')}}`, JSON.stringify(norm.evidence ?? {}), model ?? null,
    ]
  );
  const financialId = r.rows[0]?.id;
  if (!financialId) return { written: false, reason: 'human_reviewed' };
  // Job costing (M3-config/36): a separate UPDATE, not part of the main INSERT above, because
  // the job_key/job_key_source/job_confidence/job_raw columns may not exist yet — tolerant of
  // the migration not being pasted, exactly like financialsTableExists is for the whole feature.
  if (h.job_key && (await jobCostingColumnsExist(db))) {
    await db.raw(
      'UPDATE document_financials SET job_key = $2, job_key_source = $3, job_confidence = $4::numeric, job_raw = $5 WHERE id = $1',
      [financialId, h.job_key, h.job_key_source, h.job_confidence, h.job_raw]
    );
  }
  await db.raw('DELETE FROM document_financial_lines WHERE financial_id = $1', [financialId]);
  if (norm.lines.length) {
    await db.raw(
      `INSERT INTO document_financial_lines (tenant_id, financial_id, document_id, line_no, description, qty, unit_price, amount, category_guess, page_no)
       SELECT ${TENANT}, $1, $2, x.line_no, x.description, x.qty, x.unit_price, x.amount, x.category_guess, x.page_no
         FROM jsonb_to_recordset($3::jsonb) AS x(line_no int, description text, qty numeric, unit_price numeric, amount numeric, category_guess text, page_no int)`,
      [financialId, documentId, JSON.stringify(norm.lines.map((l) => ({
        line_no: l.line_no, description: l.description, qty: l.qty, unit_price: l.unit_price, amount: l.amount_str,
        category_guess: l.category_guess, page_no: l.page_no,
      })))]
    );
  }
  return { written: true, financialId };
}

/* -------------------------------------------------------------------- reads */

/** One document's financials for the review screen: stored row, effective values, lines. */
export async function getDocumentFinancials(db, documentId) {
  if (!(await financialsTableExists(db))) return { enabled: false, financials: null };
  const r = await db.raw('SELECT * FROM document_financials WHERE document_id = $1 AND tenant_id = ' + TENANT, [documentId]);
  const row = r.rows[0];
  if (!row) return { enabled: true, financials: null };
  const lines = (await db.raw(
    'SELECT line_no, description, qty, unit_price, amount, category_guess, page_no FROM document_financial_lines WHERE financial_id = $1 ORDER BY line_no', [row.id])).rows;
  return { enabled: true, financials: shapeRow(row, lines) };
}

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));

function shapeRow(row, lines = []) {
  const eff = effectiveHeader({
    ...row,
    invoice_date: ymd(row.invoice_date), due_date: ymd(row.due_date), period_start: ymd(row.period_start), period_end: ymd(row.period_end),
  });
  const fields = {};
  for (const k of EDITABLE_FIELDS) {
    const orig = row[k] instanceof Date ? ymd(row[k]) : row[k] ?? null;
    fields[k] = {
      value: eff[k] ?? null,
      original: orig == null ? null : String(orig),
      corrected: Object.prototype.hasOwnProperty.call(row.corrections ?? {}, k),
      evidence: row.evidence?.[k] ?? null,
    };
  }
  return {
    documentId: row.document_id,
    docKind: row.doc_kind,
    direction: row.direction,
    currency: row.currency,
    confidence: row.confidence == null ? null : Number(row.confidence),
    flags: row.flags ?? [],
    needsReview: needsReview(row),
    verifiedBy: row.verified_by ?? null,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    correctedBy: row.corrected_by ?? null,
    fields,
    lines: lines.map((l) => ({ lineNo: l.line_no, description: l.description, qty: l.qty, unitPrice: l.unit_price, amount: l.amount, page: l.page_no })),
  };
}

/** Documents whose financials need a person: flagged arithmetic, or low confidence, not yet verified. */
export async function listFinancialsNeedingReview(db, { limit = 200 } = {}) {
  if (!(await financialsTableExists(db))) return { enabled: false, items: [] };
  const r = await db.raw(
    `SELECT f.document_id, d.original_filename AS filename, f.doc_kind, f.total, f.flags, f.confidence, f.invoice_number
       FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.tenant_id = f.tenant_id
      WHERE f.tenant_id = ${TENANT} AND f.verified_by IS NULL
        AND (f.flags && $1::text[] OR f.confidence < 0.85)
      ORDER BY f.confidence NULLS FIRST, f.extracted_at DESC LIMIT $2`,
    [`{${REVIEW_FLAGS.join(',')}}`, Math.max(1, Math.min(500, limit))]
  );
  return {
    enabled: true,
    items: r.rows.map((x) => ({
      documentId: x.document_id, filename: x.filename, docKind: x.doc_kind, invoiceNumber: x.invoice_number,
      total: x.total, flags: x.flags ?? [], confidence: x.confidence == null ? null : Number(x.confidence),
    })),
  };
}

/* ------------------------------------------------------------- human actions */

export class FinancialsError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'FinancialsError'; this.status = status; }
}

/**
 * A person corrects one financial field. The original stays; the correction is stored
 * beside it (document_financials.corrections), verification is cleared, and the
 * arithmetic flags are recomputed on what they typed.
 */
export async function correctFinancialField(db, { documentId, field, value, by }) {
  if (!(await financialsTableExists(db))) throw new FinancialsError('Financials are not enabled yet (database update pending).', 503);
  const v = validateCorrection(field, value);
  if (!v.ok) throw new FinancialsError(v.error, 400);
  const cur = (await db.raw('SELECT * FROM document_financials WHERE document_id = $1 AND tenant_id = ' + TENANT, [documentId])).rows[0];
  if (!cur) throw new FinancialsError('No financial data for this document', 404);
  await db.raw(
    `UPDATE document_financials
        SET corrections = corrections || jsonb_build_object($2::text, $3::text), corrected_by = $4, corrected_at = NOW(),
            verified_by = NULL, verified_at = NULL
      WHERE id = $1`,
    [cur.id, field, v.value, String(by ?? 'You').slice(0, 80)]
  );
  return recheck(db, cur.id);
}

/** Re-evaluate flags/confidence of one row from its effective values + lines. */
async function recheck(db, financialId) {
  const row = (await db.raw('SELECT * FROM document_financials WHERE id = $1', [financialId])).rows[0];
  const lines = (await db.raw('SELECT qty, unit_price, amount FROM document_financial_lines WHERE financial_id = $1', [financialId])).rows;
  const { flags, confidence } = recomputeFlags({ ...row, invoice_date: ymd(row.invoice_date), due_date: ymd(row.due_date) }, lines);
  await db.raw('UPDATE document_financials SET flags = $2::text[], confidence = $3::numeric WHERE id = $1', [financialId, `{${flags.map((f) => `"${f}"`).join(',')}}`, confidence]);
  return getDocumentFinancials(db, row.document_id);
}

export async function verifyFinancials(db, { documentId, by }) {
  if (!(await financialsTableExists(db))) throw new FinancialsError('Financials are not enabled yet (database update pending).', 503);
  const r = await db.raw(
    'UPDATE document_financials SET verified_by = $2, verified_at = NOW() WHERE document_id = $1 AND tenant_id = ' + TENANT + ' RETURNING id',
    [documentId, String(by ?? 'You').slice(0, 80)]
  );
  if (!r.rows[0]) throw new FinancialsError('No financial data for this document', 404);
  return getDocumentFinancials(db, documentId);
}

/* ------------------------------------------------------------------ backfill */

/**
 * Money-kind documents that have page text but no financials row yet, oldest first, keyset
 * paged on documents.id so a run never revisits a document it already handled.
 */
export async function listBackfillCandidates(db, { afterId = null, limit = 25, documentTypes }) {
  if (!(await financialsTableExists(db))) return [];
  const r = await db.raw(
    `SELECT d.id, d.document_type
       FROM documents d
      WHERE d.tenant_id = ${TENANT} AND d.document_type = ANY($1::text[])
        AND ($2::uuid IS NULL OR d.id > $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM document_financials f WHERE f.document_id = d.id AND f.tenant_id = d.tenant_id)
        AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.tenant_id = d.tenant_id AND length(btrim(p.text)) > 0)
      ORDER BY d.id LIMIT $3`,
    [documentTypes, afterId, Math.max(1, Math.min(100, limit))]
  );
  return r.rows;
}

/** {remaining, done} counts for the backfill status line. */
export async function backfillCounts(db, { documentTypes }) {
  if (!(await financialsTableExists(db))) return { enabled: false, eligible: 0, done: 0, remaining: 0 };
  const r = await db.raw(
    `SELECT count(*)::int AS eligible,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM document_financials f WHERE f.document_id = d.id AND f.tenant_id = d.tenant_id))::int AS done
       FROM documents d
      WHERE d.tenant_id = ${TENANT} AND d.document_type = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND p.tenant_id = d.tenant_id AND length(btrim(p.text)) > 0)`,
    [documentTypes]
  );
  const { eligible, done } = r.rows[0];
  return { enabled: true, eligible, done, remaining: eligible - done };
}

export const _internals = { HEADER_COLS, MONEY_FIELDS };
