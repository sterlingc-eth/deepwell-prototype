/**
 * Quote vs invoice: a question asking for a quote / estimate / proposal for a named customer is answered ONLY from documents of
 * type proposal-quote. With none on file: "No quote on file for X" (an invoice may be mentioned, labelled as an invoice) - an
 * invoice total is never presented as the quote. Customer = a stored customer name appearing whole in the question; no/ambiguous
 * match -> null (falls through to the normal chain). Kill switch: DONOVAN_QUOTE_LOOKUP=0.
 * pure: parseQuoteQuestion     db: runQuoteLookup
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const QUOTE_RE = /\b(?:quot(?:e|es|ed|ing)|qoutes?|qutoes?|quotte|estimat\w*|estmat\w*|proposals?|bid|bids)\b/i;
const SKIP_RE = /\b(?:invoice\w*|how many|number of|count|list|all|every|total|sum|average|avg|most|least|vs|versus|compared?|any|anyone|waiting|pending|open|outstanding|which|who|accepted|approved|declined|expired|unsigned|sent)\b/i;

/** Pure. @returns {question} or null. */
export function parseQuoteQuestion(question) {
  if (process.env.DONOVAN_QUOTE_LOOKUP === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200 || !QUOTE_RE.test(raw) || SKIP_RE.test(raw)) return null;
  return { question: raw };
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/'s\b/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateLabel = (d) => { const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return Number.isNaN(+x) ? null : x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

export async function runQuoteLookup(db, intent) {
  const { rows: names } = await db.raw(
    `SELECT DISTINCT n FROM (SELECT data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
       UNION SELECT customer_name FROM document_financials WHERE ${TENANT_SQL}) x WHERE n IS NOT NULL AND length(n) >= 5`, []);
  const q = ` ${norm(intent.question)} `;
  const hits = names.map((r) => r.n).filter((n) => q.includes(` ${norm(n)} `));
  const keep = [...new Set(hits.map(norm))].filter((a, _, all) => !all.some((b) => b !== a && b.includes(a)));
  if (keep.length !== 1) return null;
  const key = keep[0];
  const display = hits.find((n) => norm(n) === key);
  const { rows } = await db.raw(
    `SELECT f.document_id, f.total, f.invoice_date::text AS d, d.document_type
       FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
      WHERE f.${TENANT_SQL} AND d.document_type IN ('proposal-quote', 'invoice') AND regexp_replace(lower(f.customer_name), '[^a-z0-9 ]+', ' ', 'g') = $1
      ORDER BY f.invoice_date DESC NULLS LAST`, [key]);
  const quotes = rows.filter((r) => r.document_type === "proposal-quote" && r.total != null);
  const invoices = rows.filter((r) => r.document_type === "invoice");
  if (!quotes.length) {
    const inv = invoices.length ? ` (${invoices.length === 1 ? "There is an invoice" : `There are ${invoices.length} invoices`} on file for ${display}, but an invoice is not a quote.)` : "";
    return attachCitations(
      { kind: "no-answer", text: `No quote on file for ${display}.${inv}`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: invoices.length ? await documentRecordsFor(db, invoices.slice(0, 5).map((r) => r.document_id)) : [], total: invoices.length, kind: "searched", basis: `Looked for proposal / quote documents for ${display}; none on file.` }
    );
  }
  const line = (r) => `${usd(r.total)}${dateLabel(r.d) ? ` (${dateLabel(r.d)})` : ""}`;
  const text = quotes.length === 1 ? `The quote for ${display} was ${line(quotes[0])}.` : `${display} has ${quotes.length} quotes on file: ${quotes.slice(0, 6).map(line).join("; ")}.`;
  const facts = quotes.slice(0, 20).map((r) => ({ label: "Quote", value: line(r), sources: [{ documentId: r.document_id, location: { field: "total" } }] }));
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "quote_lookup" } }), {
    records: await documentRecordsFor(db, quotes.map((r) => r.document_id)), total: quotes.length,
    basis: `Read the proposal / quote documents for ${display}; invoices are not quotes and were not used.`,
  });
}
