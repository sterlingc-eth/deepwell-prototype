/**
 * B3: coverage check against the tracked schema.
 *
 * DeepWell records documents (invoices, tickets, agreements...), the people and units on them, and the fields extracted from them. A question
 * that asks for a MEASURE or ATTRIBUTE the schema has no home for (satisfaction scores, fuel use, bank balances, birthdays, pay rates, vehicle
 * assignments, complaints, no-show rates, clock-in hours, warehouse stock, lead sources) can never be answered from the records, and used to be
 * answered with a nearby number ("29 3 ton units" for warehouse stock) or sent to a paid model.
 *
 *   classifyCoverage(question) -> null | { kind: "untracked_measure", trigger, cls }
 *
 * How it decides (no per-question phrases):
 *  1. MEASURE_CLASSES name families of things a business measures but this schema does not hold. Each class is a set of root words / short shapes.
 *  2. The tracked vocabulary is derived from the schema itself (extracted field keys and labels, document types and their trigger words, entity
 *     synonyms). A class word that is ALSO tracked vocabulary never fires, so adding a field to the schema silently retires the decline.
 *  3. Vetoes keep a real record question out: a street address, a document/invoice number, a how-to or app question.
 * Pure: no DB, no model. The tenant-trace veto (the tenant's own data mentions the concept) runs where the DB is available (earlyDecline.tenantHasTrace).
 * Kill switch: DONOVAN_COVERAGE=0.
 */
import { FIELD_SPECS } from "../extractFields.js";
import { DOCTYPE_TRIGGER_WORDS, DOCUMENT_TYPE_IDS, FIELD_LABELS } from "../documentTypes.js";
import { ENTITY_SYNONYMS } from "../analytics.js";

export const coverageEnabled = () => process.env.DONOVAN_COVERAGE !== "0";

const words = (s) => String(s ?? "").toLowerCase().match(/[a-z]+/g) ?? [];
const stem = (w) => w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, (m, i, s) => (w.length > 4 ? "" : m));

let TRACKED = null;
/** Every word the tracked schema uses: extracted field keys/labels, document types and their trigger words, entity synonyms. */
export function trackedVocabulary() {
  if (TRACKED) return TRACKED;
  const set = new Set();
  const add = (x) => { for (const w of words(x)) { set.add(w); set.add(stem(w)); } };
  for (const f of FIELD_SPECS ?? []) { add(f.key); add(f.label); }
  for (const l of Object.values(FIELD_LABELS ?? {})) add(l);
  for (const id of DOCUMENT_TYPE_IDS ?? []) add(id);
  for (const w of DOCTYPE_TRIGGER_WORDS ?? []) add(w);
  for (const p of Object.values(ENTITY_SYNONYMS ?? {}).flat()) add(p);
  TRACKED = set;
  return set;
}

/** Families of measures/attributes the schema does not hold. `re` matches the shape; `roots` are the words that must NOT be tracked vocabulary. */
const MEASURE_CLASSES = [
  { cls: "satisfaction", re: /\b(?:customer\s+)?satisfaction\b|\bcsat\b|\bnps\b|\bnet\s+promoter\b/i, roots: ["satisfaction", "csat", "nps"] },
  { cls: "fuel", re: /\bgallons?\b|\bfuel\b|\bdiesel\b|\bmileage\b|\bodometer\b|\bgas\s+(?:used|usage|mileage|cost|spend|expense)\b|\bgas\s+did\b/i, roots: ["gallon", "fuel", "diesel", "mileage", "odometer"] },
  { cls: "fleet", re: /\b(?:which|what)\s+(?:truck|van|vehicle|car)\b|\b(?:truck|van|vehicle)\s+(?:is|does|was)\s+[^?]{0,30}\b(?:driv|assign|us)\w*|\blicense\s+plate\b|\b(?:fleet|company)\s+(?:trucks?|vans?|vehicles?)\b/i, roots: ["truck", "vehicle", "fleet"] },
  { cls: "bank", re: /\bbank\s+(?:balance|account|deposit|statement)\b|\bcash\s+(?:balance|on\s+hand|position)\b|\bin\s+the\s+bank\b|\bchecking\s+account\b|\bsavings\b/i, roots: ["bank", "cash", "checking", "savings"] },
  { cls: "birthday", re: /\bbirthday\b|\bbirth\s*date\b|\bdate\s+of\s+birth\b/i, roots: ["birthday", "birthdate", "birth"] },
  { cls: "pay", re: /\b(?:make|makes|earn|earns|paid)\b[^?]{0,30}\bper\s+(?:hour|year|week|month)\b|\bsalar(?:y|ies)\b|\bwages?\b|\bhourly\s+(?:pay|wage)\b|\bpay\s*rate\b|\bpaychecks?\b/i, roots: ["salary", "wage", "paycheck"] },
  { cls: "complaint", re: /\b[Cc]omplain(?:s|ed|ing)?\s+(?:about|on|against)\s+(?:tech(?:nician)?\s+)?[A-Z][a-z]+/, roots: ["complain", "complaint", "unhappy", "dissatisfied", "angry"] },
  { cls: "rate", re: /\bno[\s-]?shows?\b|\bcancell?ation\s+rate\b|\bclose\s+rate\b|\bconversion\s+rate\b|\bchurn\b|\bretention\s+rate\b|\bwin\s+rate\b/i, roots: ["noshow", "churn", "conversion"] },
  { cls: "timeclock", re: /\bclock(?:ed|s|ing)?\s*(?:in|out)?\b|\btime\s*clock\b|\bpunch(?:ed)?\s+(?:in|out)\b|\bhours\s+worked\b/i, roots: ["clock", "punch"] },
  { cls: "warehouse", re: /\bwarehouse\b|\bstock\s+(?:of|on\s+hand)\b|\bon[\s-]hand\s+(?:stock|inventory)\b|\binventory\s+on\s+hand\b/i, roots: ["warehouse", "stock"] },
  { cls: "marketing", re: /\b(?:google|facebook|yelp|bing|instagram|tiktok|nextdoor|angi|thumbtack)\s+(?:ads?|adwords|marketing|campaigns?)\b|\bad\s+(?:spend|campaigns?)\b|\blead\s+sources?\b|\bmarketing\s+(?:spend|channels?|campaigns?)\b|\bwebsite\s+traffic\b|\bseo\b/i, roots: ["adwords", "campaign", "marketing", "seo"] },
];

const STREET_RE = /\b\d{2,6}\s+(?:[nsew]\.?\s+)?[a-z0-9'.-]+(?:\s+[a-z0-9'.-]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|pkwy|hwy|cir|trl)\b/i;
const ID_DIGITS_RE = /\$\s?\d|#\s?\d|\b[a-z]{1,5}-\d|\b\d{3,}-\d|\b\d{5,}\b/i;
const HOWTO_RE = /\bhow\s+(?:do|can|to|would|should)\s+(?:i|we|you)\b|\bhow\s+to\b|\bwhere\s+(?:do|can)\s+i\b|\b(?:upload|import|export|invite|log\s*in|password|subscription|billing|pricing)\b/i;

/** Words that may follow a measure word when the measure itself is what is asked for ("satisfaction score", "fuel spend", "cash balance in the bank"). */
const AFTER_OK = new Set("score scores rating ratings level levels rate rates balance balances spend spending usage cost costs expense expenses used use did does do was were is are last this that per for in of at by to the our we us and or it with from about across over so how what when why also total totals number count average avg year month week day today yesterday days weeks months years ytd now currently".split(" "));
const TRACKED_PREP_RE = /^\s*(?:on|for|about|with|from|in)\s+(?:the|our|a|an|this|that|my|your)?\s*([a-z]+)/i;
function isTheAsk(q, m) {
  const rest = q.slice(m.index + m[0].length);
  const nxt = /^[\s]*([A-Za-z]+)/.exec(rest);
  if (nxt && !/^'/.test(rest) && !AFTER_OK.has(nxt[1].toLowerCase()) && !/^[A-Z]/.test(nxt[1])) return false; // a capitalised word after it is a person's name
  // "savings on the maintenance agreement": a measure word followed by "on/for <tracked noun>" is a modifier of that noun
  const prep = TRACKED_PREP_RE.exec(rest);
  if (prep && /^(?:on|for|about|with)\b/i.test(rest.trim()) && trackedVocabulary().has(prep[1].toLowerCase())) return false;
  const pn = /^[\s]*(?:on|for|about|with)\s+(?:the|our|a|an|this|that|my|your)?\s*(?:[a-z]+\s+)?([a-z]+)/i.exec(rest);
  if (pn && trackedVocabulary().has(pn[1].toLowerCase())) return false;
  return true;
}

export function classifyCoverage(question) {
  if (!coverageEnabled()) return null;
  const q = String(question ?? "").trim();
  if (!q || q.length > 200) return null;
  if (STREET_RE.test(q) || ID_DIGITS_RE.test(q) || HOWTO_RE.test(q)) return null;
  const tracked = trackedVocabulary();
  for (const c of MEASURE_CLASSES) {
    const g = new RegExp(c.re.source, c.re.flags.includes("g") ? c.re.flags : c.re.flags + "g");
    let m = null;
    for (const cand of q.matchAll(g)) { if (isTheAsk(q, cand)) { m = cand; break; } }
    if (!m) continue;
    if (c.roots.some((r) => tracked.has(r))) continue; // the schema now tracks it: nothing to decline
    return { kind: "untracked_measure", trigger: m[0], cls: c.cls };
  }
  return null;
}

/** Words of a coverage trigger's class, for the tenant-trace check (does this tenant's own data mention the concept?). */
export function coverageTraceTerms(trigger) {
  const t = String(trigger ?? "");
  const c = MEASURE_CLASSES.find((x) => x.re.test(t));
  return c ? c.roots.filter((r) => r.length >= 3) : [];
}
