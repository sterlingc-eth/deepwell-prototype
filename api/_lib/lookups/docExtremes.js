/**
 * Whole-shop extremes on ONE document type: "oldest / newest / most recent invoice", "cheapest / most expensive invoice",
 * "biggest / smallest / newest / oldest quote". Answers from that type only (invoice vs proposal-quote), cites the document,
 * and never reads a superlative as a customer name or a document count. Only bare shapes are claimed (filler words + one
 * extreme word + the document word); anything with a name, date, month, amount or extra clause falls through.
 * Kill switch: DONOVAN_DOC_EXTREMES=0.
 * pure: parseDocExtreme     db: runDocExtreme
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";

const FILLER = new Set(["what", "whats", "what's", "which", "who", "whos", "is", "was", "are", "were", "our", "the", "my", "a", "an", "one", "we", "ever", "have", "has", "had", "sent", "made", "written", "on", "file", "show", "me", "tell", "give", "find", "get", "pull", "up", "of", "all", "time", "in", "system", "records", "do", "did", "that", "single", "please", "i", "you", "us", "got", "issued", "out", "overall"]);
const EXT = {
  max: ["biggest", "largest", "highest", "priciest", "top", "most expensive", "greatest", "costliest"],
  min: ["smallest", "cheapest", "lowest", "least expensive", "tiniest"],
  newest: ["newest", "latest", "most recent", "last", "recent"],
  oldest: ["oldest", "earliest", "first"],
};
const KIND = { invoice: /^(?:invoices?|invoce|invoive|invioce)$/, quote: /^(?:quotes?|quoet|qoute|estimates?|proposals?)$/ };

export function parseDocExtreme(question) {
  if (process.env.DONOVAN_DOC_EXTREMES === "0") return null;
  let s = String(question ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 80) return null;
  let dir = null, hit = null;
  for (const [d, words] of Object.entries(EXT)) for (const w of words.sort((a, b) => b.length - a.length)) {
    if (new RegExp(`(?:^| )${w}(?= |$)`).test(s)) { if (dir) return null; dir = d; hit = w; s = s.replace(new RegExp(`(?:^| )${w}(?= |$)`), " "); }
  }
  if (!dir) return null;
  const rest = s.split(" ").filter((t) => t && !FILLER.has(t));
  if (rest.length !== 1) return null;
  const kind = Object.keys(KIND).find((k) => KIND[k].test(rest[0]));
  if (kind === "invoice" && ["biggest", "largest", "smallest"].includes(hit)) return null; // older financial path already answers these
  return kind ? { kind, dir, question: String(question) } : null;
}

const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateLabel = (d) => { const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return Number.isNaN(+x) ? null : x.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

export async function runDocExtreme(db, intent) {
  const type = intent.kind === "invoice" ? "invoice" : "proposal-quote";
  const label = intent.kind === "invoice" ? "invoice" : "quote";
  const byDate = intent.dir === "newest" || intent.dir === "oldest";
  const order = byDate ? `f.invoice_date ${intent.dir === "newest" ? "DESC" : "ASC"} NULLS LAST, f.total DESC NULLS LAST` : `f.total ${intent.dir === "max" ? "DESC" : "ASC"}, f.invoice_date DESC NULLS LAST`;
  const where = byDate ? "f.invoice_date IS NOT NULL" : "f.total IS NOT NULL";
  const { rows } = await db.raw(
    `SELECT f.document_id, f.total, f.customer_name, f.invoice_number, f.invoice_date::text AS d
       FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
      WHERE f.${TENANT_SQL} AND d.document_type = $1 AND ${where} ORDER BY ${order} LIMIT 1`, [type]);
  if (!rows.length) {
    return attachCitations(answerEnvelope({ text: `No ${label}s with ${byDate ? "a date" : "a total"} are on file, so I can't say which is the ${intent.dir === "max" ? "biggest" : intent.dir === "min" ? "smallest" : intent.dir}.`, facts: [], extra: { fastIntent: "doc_extreme" } }),
      { records: [], total: 0, kind: "searched", basis: `Looked through every ${label}; none had ${byDate ? "a date" : "a total"}.` });
  }
  const r = rows[0];
  const word = { max: "biggest", min: "smallest", newest: "newest", oldest: "oldest" }[intent.dir];
  const text = `The ${word} ${label} is ${r.total != null ? usd(r.total) : "(no total printed)"}${r.invoice_number ? ` (#${r.invoice_number})` : ""}${r.customer_name ? `, for ${r.customer_name}` : ""}${r.d && dateLabel(r.d) ? `, dated ${dateLabel(r.d)}` : ""}. ${intent.kind === "invoice" ? "Invoices only - not quotes or other documents." : "Quotes only - not invoices."}`;
  const facts = [{ label: `${word[0].toUpperCase()}${word.slice(1)} ${label}`, value: r.total != null ? usd(r.total) : "n/a", sources: [{ documentId: r.document_id, location: { field: "total" } }] }];
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "doc_extreme" } }), {
    records: await documentRecordsFor(db, [r.document_id]), total: 1,
    basis: `Compared every ${label} on file by ${byDate ? "date" : "total"}.`,
  });
}
