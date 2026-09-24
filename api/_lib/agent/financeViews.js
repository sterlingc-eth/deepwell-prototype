/**
 * Donovan agent — the FINANCIAL views (financials layer, handoffs/FINANCIALS_2026-09-23.md).
 *
 * Two more virtual views, appended by tools.js's buildViewsSql after the base views:
 *
 *   financials     one row per money document (invoice / credit memo / quote / PO /
 *                  maintenance agreement) with the human-corrected values already applied
 *   invoice_lines  one row per printed line item
 *
 * They are built on the SAME base CTEs the agent already has (`doc_links`, `customers`) so a
 * customer link made or fixed in Review moves the invoice with it, and every real table they
 * read (document_financials, document_financial_lines, documents) is ENABLE + FORCE ROW LEVEL
 * SECURITY (M3-config/22), read inside the agent's tenant transaction — so tenant B's invoices
 * are unreachable exactly like tenant B's customers are.
 *
 * When M3-config/22 has not been pasted (`hasFinancials` false) the views still EXIST — as empty
 * relations with the same columns — so the model's SQL never errors on the missing table and
 * simply sees "no financial data", and the prompt's rule (totals ONLY from these views) leads it
 * to cannot_answer instead of guessing.
 *
 * Amounts are NUMERIC(12,2): SUM() in SQL is exact to the cent. The model must never add up
 * amounts itself.
 */

const TENANT = "(current_setting('app.tenant_id', true))::uuid";
const t = (alias) => `${alias}.tenant_id = ${TENANT}`;

export const FINANCE_VIEW_NAMES = Object.freeze(["financials", "invoice_lines"]);

/** The tables the finance views read (also listed in sqlGuard's REAL_TABLES). */
export const FINANCE_REAL_TABLES = Object.freeze(["document_financials", "document_financial_lines"]);

/** Effective (corrected-over-original) value of one column, as text -> cast. */
function eff(col, cast) {
  return `(CASE WHEN f.corrections ? '${col}' THEN NULLIF(f.corrections->>'${col}', '') ELSE f.${col}::text END)::${cast}`;
}

export function financeViewsSql({ hasFinancials = true } = {}) {
  if (!hasFinancials) {
    return `
financials AS (
  SELECT NULL::uuid AS document_id, NULL::text AS filename, NULL::text AS stage, NULL::text AS doc_kind, NULL::text AS direction,
         NULL::text AS currency, NULL::text AS invoice_number, NULL::text AS po_number, NULL::date AS invoice_date, NULL::date AS due_date,
         NULL::date AS doc_date, NULL::text AS agreement_term, NULL::numeric AS subtotal, NULL::numeric AS tax, NULL::numeric AS total,
         NULL::numeric AS amount_paid, NULL::numeric AS balance_due, NULL::text AS status, NULL::numeric AS open_balance,
         NULL::int AS days_past_due, NULL::uuid AS customer_id, NULL::text AS customer_name, NULL::text AS vendor_name,
         NULL::numeric AS confidence, NULL::boolean AS verified, NULL::boolean AS flagged, NULL::text AS flags,
         NULL::int AS total_page, NULL::timestamptz AS created_at
   WHERE false
),
invoice_lines AS (
  SELECT NULL::uuid AS document_id, NULL::int AS line_no, NULL::text AS description, NULL::numeric AS qty, NULL::numeric AS unit_price,
         NULL::numeric AS amount, NULL::text AS category_guess, NULL::int AS page_no, NULL::text AS doc_kind, NULL::uuid AS customer_id,
         NULL::text AS customer_name
   WHERE false
)`.trim();
  }
  const flagged = `(f.flags && ARRAY['total_mismatch','lines_mismatch','line_math','balance_mismatch','status_conflict','amount_not_on_page','due_before_invoice','non_usd']::text[])`;
  return `
financials AS (
  SELECT f.document_id, d.original_filename AS filename, d.stage, f.doc_kind, f.direction, f.currency,
         f.invoice_number, f.po_number,
         ${eff("invoice_date", "date")} AS invoice_date, ${eff("due_date", "date")} AS due_date,
         COALESCE(${eff("invoice_date", "date")}, ${eff("period_start", "date")}) AS doc_date,
         f.agreement_term,
         ${eff("subtotal", "numeric")} AS subtotal, ${eff("tax", "numeric")} AS tax, ${eff("total", "numeric")} AS total,
         ${eff("amount_paid", "numeric")} AS amount_paid, ${eff("balance_due", "numeric")} AS balance_due,
         ${eff("status", "text")} AS status,
         CASE WHEN COALESCE(${eff("status", "text")}, 'unknown') IN ('unpaid', 'partial')
              THEN COALESCE(${eff("balance_due", "numeric")}, ${eff("total", "numeric")} - COALESCE(${eff("amount_paid", "numeric")}, 0))
              ELSE 0 END AS open_balance,
         CASE WHEN COALESCE(${eff("status", "text")}, 'unknown') IN ('unpaid', 'partial') AND ${eff("due_date", "date")} < current_date
              THEN current_date - ${eff("due_date", "date")} END AS days_past_due,
         dc.customer_id, COALESCE(dc.customer_name, f.customer_name) AS customer_name, f.vendor_name,
         f.confidence, (f.verified_by IS NOT NULL) AS verified,
         (f.verified_by IS NULL AND ${flagged}) AS flagged,
         array_to_string(f.flags, ',') AS flags,
         NULLIF(f.evidence->'total'->>'page', '')::int AS total_page,
         f.created_at
    FROM document_financials f
    JOIN documents d ON d.id = f.document_id AND ${t("d")}
    LEFT JOIN LATERAL (
      SELECT l.customer_id, c.name AS customer_name
        FROM doc_links l JOIN customers c ON c.customer_id = l.customer_id
       WHERE l.document_id = f.document_id
       ORDER BY l.via, l.customer_id LIMIT 1
    ) dc ON true
   WHERE ${t("f")}
),
invoice_lines AS (
  SELECT l.document_id, l.line_no, l.description, l.qty, l.unit_price, l.amount, l.category_guess, l.page_no,
         fi.doc_kind, fi.customer_id, fi.customer_name
    FROM document_financial_lines l
    JOIN financials fi ON fi.document_id = l.document_id
   WHERE ${t("l")}
)`.trim();
}

/** What the model is told about the finance views (appended to VIEW_DOCS in tools.js). */
export const FINANCE_VIEW_DOCS = `- financials(document_id, filename, stage, doc_kind, direction, currency, invoice_number, po_number, invoice_date, due_date, doc_date, agreement_term, subtotal, tax, total, amount_paid, balance_due, status, open_balance, days_past_due, customer_id, customer_name, vendor_name, confidence, verified, flagged, flags, total_page, created_at) — one row per money document, human corrections already applied, amounts exact to the cent (NUMERIC). doc_kind: 'invoice' | 'credit_memo' (negative amounts) | 'statement' | 'receipt' | 'estimate' (proposal/quote) | 'change_order' | 'po' (purchase order) | 'agreement' (maintenance agreement; total = the fee printed on it). direction: 'receivable' (we billed a customer) or 'payable' (a vendor billed us). status: 'paid' | 'unpaid' | 'partial' | 'unknown' (unknown = no payment status printed; NOT the same as unpaid). open_balance = what is still owed on an unpaid/partial row (0 otherwise). invoice_date/due_date/doc_date are real DATEs (compare like invoice_date >= '2026-01-01'; month = to_char(invoice_date, 'YYYY-MM')). total IS NULL means the document prints no total (never guess one). flagged = the printed numbers do not add up and a person has not confirmed them yet.
- invoice_lines(document_id, line_no, description, qty, unit_price, amount, category_guess, page_no, doc_kind, customer_id, customer_name) — printed line items of a money document.
MONEY RULES (the only place dollar totals may come from): "invoiced / billed / revenue / sales" = SUM(total) FROM financials WHERE direction = 'receivable' AND doc_kind IN ('invoice', 'credit_memo') AND currency = 'USD' AND total IS NOT NULL. Never count 'estimate', 'statement', 'po' or 'agreement' rows as revenue. "Open / unpaid / owed to us" = status IN ('unpaid', 'partial') using SUM(open_balance); overdue = also days_past_due > 0. Always run the SUM in SQL (never add amounts yourself) and in the SAME query also select count(*) of rows summed plus count(*) FILTER (WHERE total IS NULL) of matching rows that print no total, and say in text: how many documents the number sums and how many were excluded and why ("3 invoices print no total and are excluded"; rows with a NULL invoice_date cannot be placed in a period - count and mention them). Then run one more query listing document_id, invoice_number, total for the rows summed (max 40) and cite those documents as sources (location {field:'total'}). If financials returns no rows, say no invoice totals have been captured yet (cannot_answer) - never estimate.
Money shapes: last invoice for a customer: SELECT document_id, invoice_number, invoice_date, total, status FROM financials WHERE customer_id = '<id>' AND direction = 'receivable' AND doc_kind = 'invoice' ORDER BY invoice_date DESC NULLS LAST LIMIT 1. Revenue by month: SELECT to_char(invoice_date, 'YYYY-MM') AS month, count(*) AS invoices, sum(total) AS amount FROM financials WHERE direction = 'receivable' AND doc_kind IN ('invoice', 'credit_memo') AND total IS NOT NULL AND invoice_date IS NOT NULL GROUP BY 1 ORDER BY 1.`;
