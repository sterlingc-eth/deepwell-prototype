/**
 * Count questions whose qualifier used to be dropped (answered as an unqualified company total). Closed shapes only:
 *   - "how many invoices over three thousand dollars" (amount spelled in words / 3k; > >= < <=), from invoice totals
 *   - "how many customers are out of state" (service-address state differs from the shop's home = most common state)
 *   - "how many commercial / residential permits" (permit page "Scope of Work:" line)
 * No match -> null (falls through, unchanged). Kill switch: DONOVAN_COUNT_QUALIFIERS=0.
 * pure: parseCountQualifier, wordsToNumber     db: runCountQualifier
 */
import { attachCitations } from "../citations/records.js";
import { documentRecordsFor, customerRecordsFor } from "../citations/enrich.js";
import { TENANT_SQL, answerEnvelope } from "../scope.js";
import { extractWindow } from "./dateQualifiers.js";

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Pure. "three thousand five hundred" -> 3500, "twenty five hundred" -> 2500, "a grand" -> 1000; null when not a pure number phrase. */
export function wordsToNumber(text) {
  const toks = String(text ?? "").toLowerCase().replace(/-/g, " ").replace(/\band\b/g, " ").split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  let total = 0, cur = 0, seen = false;
  for (const t of toks) {
    if (t in ONES) cur += ONES[t];
    else if (t in TENS) cur += TENS[t];
    else if (t === "a" || t === "an") { if (!seen) cur += 1; else return null; }
    else if (t === "hundred") cur = (cur || 1) * 100;
    else if (t === "thousand" || t === "grand" || t === "k") { total += (cur || 1) * 1000; cur = 0; }
    else if (t === "million") { total += (cur || 1) * 1e6; cur = 0; }
    else return null;
    seen = true;
  }
  return total + cur;
}

export const NUMW = "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|million|and|[- ])+";
export const OPS = [
  [/\b(?:at\s+least|no\s+less\s+than|minimum\s+of)\b/, ">=", "at least"],
  [/\b(?:at\s+most|no\s+more\s+than|maximum\s+of|up\s+to)\b/, "<=", "at most"],
  [/\b(?:over|above|more\s+than|greater\s+than|exceed(?:s|ing)?|higher\s+than|bigger\s+than|larger\s+than)\b/, ">", "over"],
  [/\b(?:under|below|less\s+than|lower\s+than|smaller\s+than|cheaper\s+than)\b/, "<", "under"],
];
const AMT_FILLER = new Set("how many number of count the our all we do did have has are is were was there invoice invoices on in file total totals worth dated date written sent issued made that a an with".split(" "));
const DATEISH = /\b(?:(?:19|20)\d{2}|q[1-4]|quarter|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|last|this|past|ago|today|yesterday|week|month|year|since|between|before|after|until|during)\b/;
const NOHOW_LEAD = /^\s*(?:(?:which|what|list|show(?:\s+me)?|give\s+me|find|any|are\s+there|do\s+we\s+have|have\s+we\s+(?:got|had))\b.*)?\binvoices?\b/i;
const NOHOW_FILLER = new Set("which what list show me give find any are there".split(" "));
const COUNT_RE = /\b(?:how\s+many|number\s+of|count\s+of|count)\b/i;

const AMT_OPS_ON = () => process.env.DONOVAN_AMOUNT_OPS !== "0";
const AMT_NOUN = /\b(?:invoices?|bills?|jobs?\s+(?:billed|invoiced)|billed|invoiced)\b/;
const TRAIL_OPS = { more: ">=", higher: ">=", above: ">=", greater: ">=", bigger: ">=", larger: ">=", less: "<=", lower: "<=", under: "<=", below: "<=", fewer: "<=", smaller: "<=", cheaper: "<=" };
const TRAIL_LABEL = { ">=": "at least", "<=": "at most" };

/** Pure. @returns {kind, ...} or null. */
export function parseCountQualifier(question) {
  if (process.env.DONOVAN_COUNT_QUALIFIERS === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200) return null;
  // Amount questions without "how many" ("invoices over $500 in 2010", "which invoices are over $3000 in 2013"): claimed only WITH a readable date window.
  const noHow = !COUNT_RE.test(raw);
  if (noHow && (process.env.DONOVAN_AMOUNT_NOHOW === "0" || process.env.DONOVAN_AMOUNT_WINDOW === "0" || !NOHOW_LEAD.test(raw))) return null;
  const q = raw.toLowerCase().replace(/[?!.]+$/, "").trim();

  // invoices over/under an amount spelled in words, as 3k, or (with a date window only) in digits; optional date window (in 2012, since 2020-01-01, between 2010 and 2012)
  if ((AMT_OPS_ON() ? AMT_NOUN.test(q) : /\binvoices?\b/.test(q)) && !/\b(?:for|from|by|at|to)\s+[a-z]+\s+[a-z]+\s*$/.test(q.replace(/\b(?:dollars?|bucks)\b/, ""))) {
    for (const [re, op, label] of [...(AMT_OPS_ON() ? [[null, "trail", ""]] : []), ...OPS]) {
      let m;
      if (op === "trail") {
        // "$X or more" / "X or less": inclusive bounds written after the amount
        const t = q.match(new RegExp(`\\$?\\s*(?:(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\b|(${NUMW}))\\s*(?:dollars?|bucks)?\\s+or\\s+(more|higher|above|greater|bigger|larger|less|lower|under|below|fewer|smaller|cheaper)\\b(?:\\s*(?:each|apiece|a\\s+piece))?(?=\\s*$|\\s+(?:do|did|have|are|on|we|in|since|from|between|during|after|before|until|till)\\b)`));
        if (!t) continue;
        m = [t[0], t[1], t[2], t[3]]; m.trailOp = TRAIL_OPS[t[4]];
      } else m = q.match(new RegExp(`${re.source}\\s+\\$?\\s*(?:(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\b|(${NUMW}))\\s*(?:dollars?|bucks)?(?:\\s*(?:each|apiece|a\\s+piece))?(?=\\s*$|\\s+(?:do|did|have|are|on|we|in|since|from|between|during|after|before|until|till)\\b)`));
      if (!m) continue;
      const opx = m.trailOp ?? op, labelx = m.trailOp ? TRAIL_LABEL[m.trailOp] : label;
      let amount = null;
      if (m[1]) amount = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
      else if (m[3]) amount = wordsToNumber(m[3].trim());
      if (amount == null || !Number.isFinite(amount) || amount <= 0) continue;
      const remainder = q.replace(m[0], " ");
      const w = process.env.DONOVAN_AMOUNT_WINDOW === "0" ? null : extractWindow(remainder);
      if (w) {
        // only filler may remain besides the amount and the date: a name / status / anything else is a qualifier we would drop
        if (w.rest.split(" ").filter(Boolean).some((x) => !AMT_FILLER.has(x) && !(noHow && NOHOW_FILLER.has(x)))) return null;
        return { kind: "invoice-amount", op: opx, label: labelx, amount, window: { from: w.from, to: w.to, label: w.label, open: !!w.open, range: !!w.range } };
      }
      if (noHow) return null; // no how-many and no readable date: leave untouched
      if (process.env.DONOVAN_AMOUNT_WINDOW !== "0" && DATEISH.test(remainder)) return null; // a date we cannot read (Q3, last month): never answer as all-time
      // bare digits without a date: the older path answers plain "invoices over/under N" (unchanged); claim the rest (at least / exceed / or more / bills / jobs billed)
      const oldPath = !m[2] && /^\d/.test(m[0].replace(/^\D+/, "")) && !m[3];
      if (oldPath && !(AMT_OPS_ON() && (m.trailOp || !/^(?:over|above|more than|greater than|under|below|less than)\s/.test(m[0]) || !/\binvoices?\b/.test(q)))) continue;
      return { kind: "invoice-amount", op: opx, label: labelx, amount, basis: AMT_OPS_ON() };
    }
  }
  if (noHow) return null;
  // customers out of state
  if (/\bcustomers?\b/.test(q) && /\b(?:out[\s-]+of[\s-]+(?:the[\s-]+)?state|outside\s+(?:of\s+)?(?:the\s+)?state|non[\s-]*local|from\s+another\s+state|in\s+(?:a\s+)?different\s+state|other\s+states?)\b/.test(q)) return { kind: "out-of-state" };
  // commercial / residential permits
  const pm = q.match(/^(?:how\s+many|number\s+of|count\s+of|count)\s+(?:of\s+)?(?:the\s+|our\s+|all\s+(?:of\s+)?(?:the\s+|our\s+)?)?(commercial|residential)\s+(?:hvac\s+|mechanical\s+|building\s+)?permits?(?:\s+(?:do\s+we\s+have|we\s+have|are\s+there|on\s+file|do\s+we\s+have\s+on\s+file|in\s+total|total|have\s+we\s+(?:pulled|got)|did\s+we\s+pull))*$/);
  if (pm) return { kind: "permit-scope", scope: pm[1] };
  return null;
}

const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const stateOf = (addr) => (/,\s*([A-Z]{2})\s+\d{5}/.exec(String(addr ?? "")) ?? [])[1] ?? null;

export async function runCountQualifier(db, intent) {
  if (intent.kind === "invoice-amount") {
    const { rows: all } = await db.raw(
      `SELECT f.document_id, f.total::float8 AS total FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
        WHERE f.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = 'invoice' AND f.total IS NOT NULL`, []);
    let rows = all, win = "";
    const W = intent.window;
    if (W) {
      const { rows: dr } = await db.raw(`SELECT x.document_id, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS v FROM extractions x WHERE x.${TENANT_SQL} AND x.field_key = 'invoice_date'`, []);
      const dateOf = new Map();
      for (const r of dr) if (!dateOf.has(r.document_id)) { const mm = /(\d{4})-(\d{2})-(\d{2})/.exec(String(r.v ?? "")) ?? null; const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(r.v ?? "")); dateOf.set(r.document_id, mm ? `${mm[1]}-${mm[2]}-${mm[3]}` : us ? `${us[3]}-${String(+us[1]).padStart(2, "0")}-${String(+us[2]).padStart(2, "0")}` : null); }
      rows = all.filter((r) => { const d = dateOf.get(r.document_id); return d && d >= W.from && d <= W.to; });
      win = W.open ? ` ${W.label}` : W.range ? ` from ${W.label}` : /^\d{4}$|^[A-Z][a-z]+ \d{4}$/.test(W.label) ? ` in ${W.label}` : ` on ${W.label}`;
    }
    const hits = rows.filter((r) => ({ ">": r.total > intent.amount, ">=": r.total >= intent.amount, "<": r.total < intent.amount, "<=": r.total <= intent.amount })[intent.op]);
    const text = W
      ? (rows.length ? `${hits.length} invoice${hits.length === 1 ? "" : "s"} dated${win} ${hits.length === 1 ? "is" : "are"} ${intent.label} ${usd(intent.amount)} (by invoice total).` : `No invoices on file${win}.`)
      : `${hits.length} invoice${hits.length === 1 ? "" : "s"} on file ${hits.length === 1 ? "is" : "are"} ${intent.label} ${usd(intent.amount)} (by invoice total${intent.basis ? `; ${intent.op === ">=" || intent.op === "<=" ? "an invoice of exactly that amount counts" : "an invoice of exactly that amount does not count"}). That counts every invoice on file, any date, paid or unpaid.` : ")."}`;
    return attachCitations(answerEnvelope({ text, facts: [{ label: `Invoices ${intent.label} ${usd(intent.amount)}${win}`, value: String(hits.length), sources: hits.slice(0, 20).map((r) => ({ documentId: r.document_id, location: { field: "total" } })) }], extra: { fastIntent: "count_qualifier" } }),
      { records: await documentRecordsFor(db, hits.slice(0, 200).map((r) => r.document_id)), total: hits.length, claimedCount: hits.length, basis: W ? `Compared the total to ${usd(intent.amount)} on the ${rows.length} invoices whose invoice date is ${W.from} through ${W.to}.` : `Compared the total on every invoice on file (${rows.length} in all) to ${usd(intent.amount)}.` });
  }
  if (intent.kind === "out-of-state") {
    const { rows } = await db.raw(`SELECT id, data->>'customer_name' AS name, data->>'service_address' AS addr FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}`, []);
    const withState = rows.map((r) => ({ ...r, st: stateOf(r.addr) })).filter((r) => r.st);
    if (withState.length < 2) return null;
    const tally = new Map(); for (const r of withState) tally.set(r.st, (tally.get(r.st) ?? 0) + 1);
    const home = [...tally].sort((a, b) => b[1] - a[1])[0][0];
    const out = withState.filter((r) => r.st !== home);
    const noState = rows.length - withState.length;
    const list = out.slice(0, 12).map((r) => `${r.name} (${r.st})`).join(", ");
    const text = out.length
      ? `${out.length} customer${out.length === 1 ? " has" : "s have"} a service address outside ${home} (${home} is where most of your customers are): ${list}.${noState ? ` ${noState} customer${noState === 1 ? " has" : "s have"} no state on file.` : ""}`
      : `No customers have a service address outside ${home} (${home} is where most of your customers are).`;
    return attachCitations(answerEnvelope({ text, facts: out.slice(0, 20).map((r) => ({ label: "Out-of-state customer", value: `${r.name} (${r.st})`, entityIds: [r.id], sources: [] })), extra: { fastIntent: "count_qualifier" } }),
      { records: await customerRecordsFor(db, out.map((r) => r.id)), total: out.length, claimedCount: out.length, basis: `Read the state in the service address of every customer that has one (${withState.length} in all); "out of state" = not ${home}, the most common state.` });
  }
  if (intent.kind === "permit-scope") {
    const { rows } = await db.raw(
      `SELECT d.id, string_agg(p.text, E'\\n' ORDER BY p.page_no) AS body FROM documents d JOIN document_pages p ON p.document_id = d.id AND p.${TENANT_SQL}
        WHERE d.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = 'permit' GROUP BY d.id`, []);
    if (!rows.length) return null;
    const scopeOf = (b) => { const m = /Scope of Work:\s*([^\n]*)/i.exec(String(b ?? "")); return m ? (/\bcommercial\b/i.test(m[1]) ? "commercial" : /\bresidential\b/i.test(m[1]) ? "residential" : "other") : "unknown"; };
    const by = { commercial: [], residential: [], other: [], unknown: [] };
    for (const r of rows) by[scopeOf(r.body)].push(r.id);
    const hits = by[intent.scope];
    const rest = rows.length - by.commercial.length - by.residential.length;
    const text = `${hits.length} ${intent.scope} permit${hits.length === 1 ? "" : "s"} ${hits.length === 1 ? "is" : "are"} on file (by the "Scope of Work" line on the permit).${rest ? ` ${rest} permit${rest === 1 ? " is" : "s are"} neither labelled commercial nor residential.` : ""}`;
    return attachCitations(answerEnvelope({ text, facts: [{ label: `${intent.scope[0].toUpperCase()}${intent.scope.slice(1)} permits`, value: String(hits.length), sources: hits.slice(0, 20).map((id) => ({ documentId: id, location: {} })) }], extra: { fastIntent: "count_qualifier" } }),
      { records: await documentRecordsFor(db, hits.slice(0, 200)), total: hits.length, claimedCount: hits.length, basis: `Read the "Scope of Work" line on each permit (${rows.length} in all).` });
  }
  return null;
}

/** Pure. "total of invoices in 2012" -> "total invoiced in 2012" (the dollar-total path; the older path answered a document count). Null when not that shape. */
export function rewriteInvoiceTotal(question) {
  if (process.env.DONOVAN_AMOUNT_NOHOW === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200) return null;
  const q = raw.toLowerCase().replace(/[?!.]+$/, "").trim();
  const m = q.match(/^(?:(?:what(?:'s|\s+is|\s+was)|show\s+me|give\s+me|tell\s+me)\s+)?(?:the\s+)?total\s+(?:of|for)\s+(?:all\s+)?(?:(?:the|our|my)\s+)?invoices?\s+((?:in|during|for|from|since|between|before|after)\s+.+)$/);
  if (!m) return null;
  const w = extractWindow(m[1]);
  if (!w || w.rest.split(" ").filter(Boolean).some((x) => !AMT_FILLER.has(x))) return null;
  return `total invoiced ${m[1]}`;
}
