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

const NUMW = "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|million|and|[- ])+";
const OPS = [
  [/\b(?:at\s+least|no\s+less\s+than|minimum\s+of)\b/, ">=", "at least"],
  [/\b(?:at\s+most|no\s+more\s+than|maximum\s+of|up\s+to)\b/, "<=", "at most"],
  [/\b(?:over|above|more\s+than|greater\s+than|exceed(?:s|ing)?|higher\s+than|bigger\s+than|larger\s+than)\b/, ">", "over"],
  [/\b(?:under|below|less\s+than|lower\s+than|smaller\s+than|cheaper\s+than)\b/, "<", "under"],
];
const COUNT_RE = /\b(?:how\s+many|number\s+of|count\s+of|count)\b/i;

/** Pure. @returns {kind, ...} or null. */
export function parseCountQualifier(question) {
  if (process.env.DONOVAN_COUNT_QUALIFIERS === "0") return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200 || !COUNT_RE.test(raw)) return null;
  const q = raw.toLowerCase().replace(/[?!.]+$/, "").trim();

  // invoices over/under an amount spelled in words or as 3k
  if (/\binvoices?\b/.test(q) && !/\b(?:for|from|by|at|to)\s+[a-z]+\s+[a-z]+\s*$/.test(q.replace(/\b(?:dollars?|bucks)\b/, ""))) {
    for (const [re, op, label] of OPS) {
      const m = q.match(new RegExp(`${re.source}\\s+\\$?\\s*(?:(\\d+(?:\\.\\d+)?)\\s*(k)\\b|(${NUMW}))\\s*(?:dollars?|bucks)?(?:\\s*(?:each|apiece|a\\s+piece))?(?=\\s*$|\\s+(?:do|did|have|are|on|we|in)\\b)`));
      if (!m) continue;
      let amount = null;
      if (m[1]) amount = Number(m[1]) * 1000;
      else if (m[3]) amount = wordsToNumber(m[3].trim());
      if (amount == null || !Number.isFinite(amount) || amount <= 0) continue;
      return { kind: "invoice-amount", op, label, amount };
    }
  }
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
    const { rows } = await db.raw(
      `SELECT f.document_id, f.total::float8 AS total FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
        WHERE f.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = 'invoice' AND f.total IS NOT NULL`, []);
    const hits = rows.filter((r) => ({ ">": r.total > intent.amount, ">=": r.total >= intent.amount, "<": r.total < intent.amount, "<=": r.total <= intent.amount })[intent.op]);
    const text = `${hits.length} of ${rows.length} invoices on file are ${intent.label} ${usd(intent.amount)} (by invoice total).`;
    return attachCitations(answerEnvelope({ text, facts: [{ label: `Invoices ${intent.label} ${usd(intent.amount)}`, value: String(hits.length), sources: hits.slice(0, 20).map((r) => ({ documentId: r.document_id, location: { field: "total" } })) }], extra: { fastIntent: "count_qualifier" } }),
      { records: await documentRecordsFor(db, hits.slice(0, 200).map((r) => r.document_id)), total: hits.length, claimedCount: hits.length, basis: `Compared the total on each of the ${rows.length} invoices to ${usd(intent.amount)}.` });
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
      ? `${out.length} of ${rows.length} customers have a service address outside ${home} (${home} is where most of your customers are): ${list}.${noState ? ` ${noState} customer${noState === 1 ? " has" : "s have"} no state on file.` : ""}`
      : `No customers have a service address outside ${home} (${home} is where most of your customers are).`;
    return attachCitations(answerEnvelope({ text, facts: out.slice(0, 20).map((r) => ({ label: "Out-of-state customer", value: `${r.name} (${r.st})`, entityIds: [r.id], sources: [] })), extra: { fastIntent: "count_qualifier" } }),
      { records: await customerRecordsFor(db, out.map((r) => r.id)), total: out.length, claimedCount: out.length, basis: `Read the state in the service address of ${withState.length} customers; "out of state" = not ${home}, the most common state.` });
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
    const text = `${hits.length} of ${rows.length} permits on file are ${intent.scope} (by the "Scope of Work" line on the permit).${rest ? ` ${rest} permit${rest === 1 ? " is" : "s are"} neither labelled commercial nor residential.` : ""}`;
    return attachCitations(answerEnvelope({ text, facts: [{ label: `${intent.scope[0].toUpperCase()}${intent.scope.slice(1)} permits`, value: String(hits.length), sources: hits.slice(0, 20).map((id) => ({ documentId: id, location: {} })) }], extra: { fastIntent: "count_qualifier" } }),
      { records: await documentRecordsFor(db, hits.slice(0, 200)), total: hits.length, claimedCount: hits.length, basis: `Read the "Scope of Work" line on each of the ${rows.length} permits.` });
  }
  return null;
}
