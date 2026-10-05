/**
 * Person + amount invoice questions that used to drop the person (answered as a company-wide count):
 *   "Linda Fitzgerald invoices over $500", "smith over $500 invoices", "how many invoices over $500 for Linda Fitzgerald", "invoices under 2k for the Mercers"
 * Closed shape: an amount comparison (over/under/at least/at most) + the word "invoice(s)" + 1-3 leftover name words, optionally one readable date window.
 * Every name word must be a whole word of a customer name; several customers sharing a word are all answered (listed per customer).
 * An unmatched, capitalised full name is answered "no customer named ... on file"; anything else unclear returns null (falls through unchanged).
 * Counts come from customer-document links x invoice totals. Kill switch: DONOVAN_PERSON_AMOUNT=0.
 * pure: parsePersonAmount     db: runPersonAmount
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor, customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";
import { extractWindow } from "./dateQualifiers.js";
import { OPS, NUMW, wordsToNumber } from "./countQualifiers.js";

const FILLER = new Set("how many number of count the our all we do did have has are is were was there invoice invoices on in file total totals worth for from by to that a an with which what list show me give find any does and billed customer customers client clients named called who whose bill bills over under".split(" "));
const NOT_NAME = new Set("open unpaid paid overdue outstanding quote quotes permit permits agreement agreements ticket tickets order orders job jobs unit units each apiece dollars dollar bucks".split(" "));

/** Pure. @returns {kind:"person-amount", op, label, amount, names:string[], display, window?, capitalised} or null. */
export function parsePersonAmount(question) {
  if (process.env.DONOVAN_PERSON_AMOUNT === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 160) return null;
  const q = raw.toLowerCase().replace(/[?!.,]+$/, "").replace(/'s\b/g, "").trim();
  if (!/\binvoices?\b/.test(q)) return null;
  for (const [re, op, label] of OPS) {
    const m = q.match(new RegExp(`${re.source}\\s+\\$?\\s*(?:(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\b|(${NUMW}))\\s*(?:dollars?|bucks)?(?:\\s*(?:each|apiece|a\\s+piece))?(?=\\s|$)`));
    if (!m) continue;
    let amount = null;
    if (m[1]) amount = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
    else if (m[3]) amount = wordsToNumber(m[3].trim());
    if (amount == null || !Number.isFinite(amount) || amount <= 0) continue;
    // word-amounts ("over three thousand") may swallow filler like "and"; require the matched amount to be a clean number phrase
    let remainder = q.replace(m[0], " ").replace(/\s+/g, " ").trim();
    let window = null;
    const w = extractWindow(remainder);
    if (w) { window = { from: w.from, to: w.to, label: w.label, open: !!w.open, range: !!w.range }; remainder = w.rest; }
    else if (/\b(?:(?:19|20)\d{2}|q[1-4]|quarter|last|this|past|ago|today|yesterday|week|month|year|since|between|before|after|until|during)\b/.test(remainder)) return null; // a date we cannot read
    const toks = remainder.split(/\s+/).filter((t) => t && !FILLER.has(t));
    if (!toks.length || toks.length > 3) return null;
    if (toks.some((t) => !/^[a-z][a-z'-]*$/.test(t) || NOT_NAME.has(t) || t.length < 2)) return null;
    const capitalised = toks.length >= 2 && toks.every((t) => new RegExp(`\\b${t[0].toUpperCase()}${t.slice(1)}\\b`).test(raw));
    return { kind: "person-amount", op, label, amount, names: toks, display: toks.map((t) => t[0].toUpperCase() + t.slice(1)).join(" "), ...(window ? { window } : {}), capitalised };
  }
  return null;
}

const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cmp = { ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b };

export async function runPersonAmount(db, intent) {
  const { rows: custs } = await db.raw(`SELECT id, data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
  const wordsOf = (n) => new Set(String(n ?? "").toLowerCase().replace(/'s\b/g, "").split(/[^a-z0-9'-]+/).filter(Boolean));
  const matched = custs.filter((c) => { const ws = wordsOf(c.n); return intent.names.every((t) => ws.has(t)); });
  if (!matched.length) {
    if (!intent.capitalised) return null;
    return attachCitations(answerEnvelope({ text: `I don't see a customer named ${intent.display} on file, so I can't count their invoices ${intent.label} ${usd(intent.amount)}.`, facts: [], extra: { fastIntent: "person_amount" } }),
      { records: [], total: 0, kind: "searched", basis: `Looked for a customer named ${intent.display} among ${custs.length} customers.` });
  }
  const ids = matched.map((c) => c.id);
  const { rows: inv } = await db.raw(
    `SELECT DISTINCT l.entity_id, d.id AS document_id, f.total::float8 AS total, f.invoice_number
       FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = 'invoice'
       JOIN document_financials f ON f.document_id = d.id AND f.${TENANT_SQL} AND f.total IS NOT NULL
      WHERE l.entity_id = ANY($1::uuid[])`, [ids]);
  let rows = inv, win = "";
  const W = intent.window;
  if (W) {
    const { rows: dr } = await db.raw(`SELECT x.document_id, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS v FROM extractions x WHERE x.${TENANT_SQL} AND x.field_key = 'invoice_date'`, []);
    const dateOf = new Map();
    for (const r of dr) if (!dateOf.has(r.document_id)) { const mm = /(\d{4})-(\d{2})-(\d{2})/.exec(String(r.v ?? "")); const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(r.v ?? "")); dateOf.set(r.document_id, mm ? `${mm[1]}-${mm[2]}-${mm[3]}` : us ? `${us[3]}-${String(+us[1]).padStart(2, "0")}-${String(+us[2]).padStart(2, "0")}` : null); }
    rows = inv.filter((r) => { const d = dateOf.get(r.document_id); return d && d >= W.from && d <= W.to; });
    win = W.open ? ` ${W.label}` : W.range ? ` from ${W.label}` : /^\d{4}$|^[A-Z][a-z]+ \d{4}$/.test(W.label) ? ` in ${W.label}` : ` on ${W.label}`;
  }
  const hits = rows.filter((r) => cmp[intent.op](r.total, intent.amount));
  const nameOf = new Map(matched.map((c) => [c.id, c.n]));
  const per = matched.map((c) => ({ ...c, all: rows.filter((r) => r.entity_id === c.id), hit: hits.filter((r) => r.entity_id === c.id) }));
  const uniq = (xs) => new Set(xs.map((r) => r.document_id)).size;
  const detail = (hs) => hs.slice(0, 8).map((r) => `${r.invoice_number ? `#${r.invoice_number} ` : ""}${usd(r.total)}`).join(", ") + (hs.length > 8 ? `, and ${hs.length - 8} more` : "");
  let text;
  if (per.length === 1) {
    const p = per[0];
    text = !p.all.length ? `${p.n} has no invoices on file${win}.`
      : `${p.n} has ${plural(p.hit.length, "invoice")}${win} ${intent.label} ${usd(intent.amount)} (of ${plural(p.all.length, "invoice")}${win} on file, by invoice total)${p.hit.length ? `: ${detail(p.hit)}` : ""}.`;
  } else {
    const shown = per.slice(0, 8).map((p) => `${p.n}: ${p.hit.length}`).join("; ");
    text = `${per.length} customers match "${intent.display}". Together they have ${plural(uniq(hits), "invoice")}${win} ${intent.label} ${usd(intent.amount)} (of ${uniq(rows)} on file, by invoice total) - ${shown}${per.length > 8 ? `; and ${per.length - 8} more` : ""}.`;
  }
  const hitDocs = [...new Set(hits.map((r) => r.document_id))];
  return attachCitations(answerEnvelope({ text, facts: [{ label: `${intent.display} invoices ${intent.label} ${usd(intent.amount)}${win}`, value: String(hitDocs.length), entityIds: ids.slice(0, 6), sources: hitDocs.slice(0, 20).map((id) => ({ documentId: id, location: { field: "total" } })) }], extra: { fastIntent: "person_amount" } }),
    { records: hitDocs.length ? await documentRecordsFor(db, hitDocs.slice(0, 200)) : await customerRecordsFor(db, ids.slice(0, 6)), total: Math.max(1, hitDocs.length), claimedCount: hitDocs.length, ...(hitDocs.length ? {} : { kind: "searched" }), basis: `Compared the invoice total to ${usd(intent.amount)} on the ${uniq(rows)} invoices linked to ${per.length === 1 ? per[0].n : `${per.length} customers matching "${intent.display}"`}.` });
}
