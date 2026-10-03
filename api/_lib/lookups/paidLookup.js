/**
 * "What did X pay / owe" for ONE named customer. The documents record what was invoiced, not what was collected, so the answer is that
 * customer's invoiced total (cited) plus a plain note that paid-vs-unpaid is not recorded. A name that is not a stored customer says
 * "not on file" (never a company total). Vendor / supplier / company-wide / when / late / list shapes are not claimed, and a name that
 * is a near-miss or a partial of a stored name is left to the older path. Invoices that DO carry an amount paid are left to the older path.
 * Kill switch: DONOVAN_PAID_LOOKUP=0.
 * pure: parsePaidQuestion     db: runPaidLookup
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const PAY_RE = /\b(?:paid|payed|pay|pays|paying|owe|owes|owed|owing)\b/i;
const SKIP_RE = /\b(?:vendors?|suppliers?|supply|distribut\w*|po|pos|purchase|parts?|payroll|wages?|salary|tax|taxes|rent|insurance|invoices?|bills?|billed|when|what date|what day|the date|how long|how often|late|early|on time|overdue|unpaid|open|outstanding|balance|list|which|who|whom|everyone|everybody|anyone|anybody|all|every|each|total|how many|average|avg|most|least|top|year|month|week|quarter|today|yesterday|vs|versus|compared?|quote\w*|estimate\w*|i|we owe|do we|did we pay|do i|did i|should|can|could)\b/i;
const WHO_STOP = new Set(["i", "we", "you", "they", "he", "she", "it", "us", "me", "customers", "customer", "clients", "client", "everyone", "anyone", "someone", "people", "somebody", "the customer", "the client", "a customer", "that customer", "this customer", "the company", "company"]);
const NOT_A_NAME = /\b(?:job|jobs|work|invoice|invoices|bill|bills|unit|units|system|systems|install\w*|repair\w*|service|permit|contract|warranty|equipment|furnace|ac|hvac|unpaid|paid|money|cash|check|cheque|card|credit|cost|price|visit|call|ticket|order|week|month|year|today|ones?)\b/i;
const CAND_RES = [
  /\b(?:did|does|do|has|have|had|will|would|is|was)\s+(.+?)\s+(?:pay|paid|payed|owe|owed|owes|paying|owing)\b/i,
  /\b(?:get|got|gotten|getting|receive[d]?|collect(?:ed)?|pay|paid|payed)\s+(?:us\s+)?(?:paid\s+)?(?:from|by)\s+(.+)$/i,
  /^(?:\W*)([a-z][a-z'.&-]*(?:\s+[a-z][a-z'.&-]*){0,3})\s+(?:owes|owe|paid|payed)\b/i,
];

const norm = (s) => String(s ?? "").toLowerCase().replace(/'s\b/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function candidate(raw) {
  for (const re of CAND_RES) {
    const m = re.exec(raw);
    if (!m) continue;
    let c = m[1].replace(/[?!.]+$/g, "").replace(/\b(?:us|so far|to date|yet|for (?:the|that|this) \w+|last time|again|anything|in full|all of it)\b/gi, " ").replace(/\s+/g, " ").trim();
    c = c.replace(/^(?:the|a|an)\s+/i, "");
    if (!c || WHO_STOP.has(norm(c)) || NOT_A_NAME.test(c) || /\d/.test(c)) continue;
    if (c.split(" ").length > 4) continue;
    return c;
  }
  return null;
}

/** Pure. @returns {question, cand} or null. */
export function parsePaidQuestion(question) {
  if (process.env.DONOVAN_PAID_LOOKUP === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 160 || !PAY_RE.test(raw) || SKIP_RE.test(raw)) return null;
  return { question: raw, cand: candidate(raw) };
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export async function runPaidLookup(db, intent) {
  const { rows: names } = await db.raw(
    `SELECT DISTINCT n FROM (SELECT data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
       UNION SELECT customer_name FROM document_financials WHERE ${TENANT_SQL}) x WHERE n IS NOT NULL AND length(n) >= 3`, []);
  const all = names.map((r) => r.n);
  const q = ` ${norm(intent.question)} `;
  const hits = all.filter((n) => q.includes(` ${norm(n)} `));
  const keep = [...new Set(hits.map(norm))].filter((a, _, arr) => !arr.some((b) => b !== a && b.includes(a)));
  if (keep.length > 1) return null;
  if (keep.length === 0) {
    const cand = intent.cand;
    if (!cand) return null;
    const c = norm(cand), cw = c.split(" ");
    if (c.length < 4) return null;
    // near-miss or partial of a stored name: not ours to call "not on file"
    for (const n of all) {
      const nn = norm(n), nw = nn.split(" ");
      if (lev(c, nn) <= 2 || nn.includes(c) || c.includes(nn) || cw.some((w) => w.length >= 4 && nw.some((x) => x === w || lev(w, x) <= 1))) return null;
    }
    return attachCitations(
      { kind: "no-answer", text: `${cand} is not on file as a customer, so I have no invoices to total for them.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Looked for a customer named ${cand}; none on file.` }
    );
  }
  const key = keep[0];
  const display = hits.find((n) => norm(n) === key);
  const { rows } = await db.raw(
    `SELECT f.document_id, f.total, f.amount_paid, f.invoice_date::text AS d
       FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
      WHERE f.${TENANT_SQL} AND d.document_type = 'invoice' AND f.total IS NOT NULL AND regexp_replace(lower(f.customer_name), '[^a-z0-9 ]+', ' ', 'g') = $1
      ORDER BY f.invoice_date DESC NULLS LAST`, [key]);
  if (!rows.length || rows.some((r) => r.amount_paid != null)) return null;
  const total = rows.reduce((a, r) => a + Number(r.total), 0);
  const n = rows.length;
  const text = `${display} has been invoiced ${usd(total)}${n === 1 ? " (1 invoice)" : ` across ${n} invoices`}. Payment status isn't recorded in the documents, so I can't tell you how much of that has been paid or is still owed.`;
  const facts = rows.slice(0, 20).map((r) => ({ label: "Invoiced", value: usd(r.total), sources: [{ documentId: r.document_id, location: { field: "total" } }] }));
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "paid_lookup" } }), {
    records: await documentRecordsFor(db, rows.map((r) => r.document_id)), total: n,
    basis: `Added up the invoice totals for ${display}. The documents do not record what was paid.`,
  });
}
