/**
 * Customer x document-type shapes that used to fall through to "You have N customers" / the invoice open-balance path:
 *   - rank:   "customer with the most invoices", "which customer has the fewest quotes", "who has the most permits"
 *   - none:   "customers with no invoices", "how many customers have no quotes", "customers who never had an invoice"
 *   - have:   "how many customers have invoices"
 *   - status: "how many open / pending / accepted quotes" -> quote documents carry no open/accepted status, said plainly (never an invoice answer)
 * Closed vocabulary: every word must be known, otherwise null (falls through unchanged). Counts come from customer-document links.
 * Kill switch: DONOVAN_CUSTOMER_DOC_RANK=0.
 * pure: parseCustomerDocRank     db: runCustomerDocRank
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor, customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";
import { countSubject } from "../understanding/understand.js";

const NOUNS = [
  [/^(?:invoices?|invoiced|invoce|invioce|bills?|billed)$/, "invoice", "invoice"], [/^(?:quotes?|qoute|quoet|estimates?|proposals?)$/, "proposal-quote", "quote"],
  [/^permits?$/, "permit", "permit"], [/^(?:agreements?|contracts?)$/, "maintenance-agreement", "maintenance agreement"],
  [/^(?:tickets?)$/, "service-ticket", "service ticket"], [/^(?:orders?)$/, "work-order", "work order"],
];
const VOCAB = new Set(["how", "many", "number", "of", "count", "are", "is", "there", "we", "have", "has", "had", "do", "does", "did", "the", "our", "my", "a", "an", "any", "which", "what", "who", "whom", "show", "me", "list", "give", "tell",
  "customer", "customers", "client", "clients", "with", "without", "no", "zero", "0", "never", "ever", "got", "received", "gotten", "having", "that", "not", "been", "sent", "given", "all", "got", "on", "file", "right", "now", "currently", "still", "yet", "work", "service", "maintenance", "different", "distinct", "unique"]);
const RANK = { most: "max", fewest: "min", least: "min", highest: "max", lowest: "min" };
const STATUS = new Set(["open", "pending", "outstanding", "unaccepted", "unsigned", "accepted", "approved", "signed", "declined", "won", "lost", "awaiting", "active", "unanswered", "expired", "unconverted", "rejected"]);

export function parseCustomerDocRank(question) {
  if (process.env.DONOVAN_CUSTOMER_DOC_RANK === "0") return null;
  const s = String(question ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim().replace(/\bat least (?:one|1|a)\b/g, "a");
  if (!s || s.length > 80) return null;
  let toks = s.split(" "), noun = null, rank = null, status = null;
  // two-word nouns first
  const joined = toks.join(" ").replace(/\bwork orders?\b/, "orders").replace(/\bservice (?:tickets?|calls?|visits?)\b/, "tickets").replace(/\bmaintenance (?:agreements?|contracts?)\b/, "agreements").replace(/\bpurchase orders?\b/, "po-x");
  toks = joined.split(" ");
  const rest = [];
  for (const t of toks) {
    const n = NOUNS.find(([re]) => re.test(t));
    if (n) { if (noun) return null; noun = n; continue; }
    if (RANK[t]) { if (rank) return null; rank = RANK[t]; continue; }
    if (STATUS.has(t)) { if (status) return null; status = t; continue; }
    rest.push(t);
  }
  if (!noun || rest.some((t) => !VOCAB.has(t))) return null;
  const cust = rest.some((t) => /^(?:customers?|clients?)$/.test(t));
  const asksWho = rest.includes("who") || rest.includes("whom") || cust;
  const neg = rest.some((t) => ["no", "without", "zero", "0", "never", "not"].includes(t));
  if (status && !rank) {
    if (noun[1] !== "proposal-quote" || cust || neg) return null;
    return { mode: "status", noun, status };
  }
  if (status) return null;
  if (rank) return asksWho && !neg ? { mode: "rank", dir: rank, noun } : null;
  if (cust && neg) return { mode: "none", noun };
  // E2 A4: "how many customer invoices do we have" counts INVOICES (customer is a role word there, not the thing counted): leave it to the invoice count.
  if (cust && countSubject(question) && countSubject(question).subject !== "customers") return null;
  if (cust && /\b(?:have|has|with)\b/.test(s) && !/\b(?:list|show)\b/.test(s) && /\bhow many\b|\bnumber of\b|\bcount\b/.test(s)) return { mode: "have", noun };
  return null;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const names = (rows, k = 3) => rows.slice(0, k).map((r) => r.n).join(", ") + (rows.length > k ? ` and ${rows.length - k} more` : "");

export async function runCustomerDocRank(db, intent) {
  const [, type, label] = intent.noun;
  if (intent.mode === "status") {
    const { rows } = await db.raw(`SELECT d.id FROM documents d WHERE d.${TENANT_SQL} AND d.document_type = $1 ORDER BY d.created_at DESC LIMIT 50`, [type]);
    const { rows: c } = await db.raw(`SELECT count(*)::int AS n FROM documents d WHERE d.${TENANT_SQL} AND d.document_type = $1`, [type]);
    const n = c[0]?.n ?? 0;
    return attachCitations(answerEnvelope({
      text: `Your records don't show whether a quote is open, accepted or declined, so I can't count the ${intent.status} ones. There ${n === 1 ? "is" : "are"} ${plural(n, "quote")} on file in total.`,
      facts: [], extra: { fastIntent: "customer_doc_rank" } }),
    { records: await documentRecordsFor(db, rows.map((r) => r.id)), total: n, kind: "searched", basis: `Counted the quote documents on file; none carries an accepted/open status.` });
  }
  const { rows } = await db.raw(
    `SELECT e.id, e.data->>'customer_name' AS n, count(DISTINCT d.id)::int AS c
       FROM entities e LEFT JOIN document_entity_links l ON l.entity_id = e.id
       LEFT JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL} AND d.document_type = $1
      WHERE e.entity_type = 'customer' AND e.merged_into IS NULL AND e.${TENANT_SQL} GROUP BY e.id, e.data->>'customer_name' ORDER BY c DESC, n`, [type]);
  const total = rows.length, plus = rows.filter((r) => r.c > 0), zero = rows.filter((r) => r.c === 0);
  const basis = `Counted the ${label} documents linked to each of ${total} customers.`;
  const done = async (text, picked, facts = []) => {
    const env = answerEnvelope({ text, facts, extra: { fastIntent: "customer_doc_rank" } });
    return attachCitations(env, { records: await customerRecordsFor(db, picked.map((r) => r.id)), total: Math.max(1, picked.length), ...(picked.length ? {} : { kind: "searched" }), basis });
  };
  if (!total) return done("No customers are on file yet.", []);
  if (intent.mode === "none") {
    if (!zero.length) return done(`Every customer (${total}) has at least one ${label} on file - none are without one.`, []);
    return done(`${plural(zero.length, "customer")} (of ${total}) ${zero.length === 1 ? "has" : "have"} no ${label} on file${zero.length <= 10 ? `: ${names(zero, 10)}` : `, for example ${names(zero)}`}.`, zero.slice(0, 6));
  }
  if (intent.mode === "have") return done(`${plural(plus.length, "customer")} (of ${total}) ${plus.length === 1 ? "has" : "have"} at least one ${label} on file.`, plus.slice(0, 6));
  if (!plus.length) return done(`No customer has a ${label} on file, so none stands out.`, []);
  const word = intent.dir === "max" ? "most" : "fewest";
  if (intent.dir === "min" && zero.length) return done(`${plural(zero.length, "customer")} (of ${total}) ${zero.length === 1 ? "has" : "have"} no ${label}s at all, so there is no single fewest. ${zero.length <= 10 ? names(zero, 10) : `For example ${names(zero)}`}.`, zero.slice(0, 6));
  const target = intent.dir === "max" ? plus[0].c : plus[plus.length - 1].c;
  const tied = plus.filter((r) => r.c === target);
  if (tied.length === 1) {
    const next = intent.dir === "max" ? plus.find((r) => r.c < target) : null;
    return done(`${tied[0].n} has the ${word} ${label}s: ${target}${next ? ` (next highest is ${next.c})` : ""}.`, tied);
  }
  const allEq = tied.length === plus.length;
  return done(`No single customer has the ${word} ${label}s - ${tied.length} customers tie at ${target} each${allEq && tied.length === total ? ", which is every customer" : ""}. For example ${names(tied)}.`, tied.slice(0, 6));
}
