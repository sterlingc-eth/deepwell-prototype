/**
 * R45 (Builder 2) - GENERAL, composable aggregation templates answered from the records with no model call.
 *
 *   share      "what percent of our units are Carrier", "share of customers in Mesa", "% of invoices that are unpaid"
 *   average    "average invoice amount", "average quote", "average age of our equipment" (+ a brand / year)
 *   top        "top five customers by billing", "top 3 technicians by service calls", "top brands by unit count"
 *   busiest    "busiest month for service calls", "slowest month for invoices", "which year had the most installs"
 *   group      "service calls per technician", "revenue by month", "invoices by customer", "units by brand", "documents by type"
 *   compare    "compare Carrier vs Trane unit counts and say which is older on average", "Mesa versus Tempe customers"
 *
 * Every template is built from the SAME few row sets (units, customers, dated service visits, money documents) and the SAME count / sum /
 * average primitives, so a new question shape is a new COMBINATION of subject x filter x dimension x measure, not a new code path.
 * Each answer states what was computed ("average of 48 invoices with an amount"), what was left out and why, and never guesses:
 *   - parse is CLOSED: after the recognised slots are removed, every remaining word must be a glue word or a value this tenant's data has
 *     (a brand, city, technician, customer or vendor). One unparsed word => null => the question carries on down the normal chain;
 *   - a measure the records do not hold (e.g. a payment status nobody recorded, an amount a document does not print) is said, not invented.
 *
 * pure: parseTemplate     db: runTemplate
 */
import { unframe } from "./unframe.js";
import { splitVersus } from "../analytics/comparison.js";
import { canonicalBrandLabel } from "../analytics/brandCanon.js";
import { attachCitations, documentRecord, unitRecord, customerRecord } from "../citations/records.js";
import { answerEnvelope, TENANT_SQL, todayIso } from "../scope.js";

export const templatesEnabled = () => process.env.DONOVAN_AGG_TEMPLATES !== "0";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/%/g, " percent ").replace(/[^a-z0-9'\s/-]/g, " ").replace(/\s+/g, " ").trim();
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const GLUE = new Set(("a an the we our us i you it is are was were be been do does did has have had what whats what's which who whose when where how many much number count of in on at for by to from with and or "
  + "size sizes that thats this these those there any all each every some please file files record records on-file listed shown currently current right now still so far overall total ever just really actually "
  + "me show give tell list get can could would should say also then than as be being per service serviced services maintain maintained manage managed track tracked own handle handled work worked take taken keep kept on-file got into over across during within").split(/\s+/));

/* ---------------------------------------------------------------- slot vocabularies */
// closed-class words can never be a brand / city / name: a leftover one means "not a template question", so the claim is never made
const STOPWORDS = new Set("more less fewer greater larger smaller than then one two three four five six seven eight nine ten who whom whose why while would could should might must shall will may not no nor yes only own same other another such very too into onto upon within without about above below".split(" "));
const SUBJECTS = [
  ["equipment", /\b(?:units?|systems?|equipment|furnaces?|a\/?cs?|air conditioners?|heat pumps?|condensers?|hvac)\b/],
  ["customers", /\b(?:customers?|clients?)\b/],
  ["visits", /\b(?:service (?:calls?|visits?|tickets?|work)|visits?|calls?|tickets?|jobs?|work orders?|callouts?)\b/],
  ["invoice", /\binvoices?\b/],
  ["quote", /\b(?:quotes?|estimates?|proposals?)\b/],
  ["po", /\b(?:purchase orders?|pos?)\b/],
  ["agreement", /\b(?:maintenance )?(?:agreements?|contracts?)\b/],
  ["docs", /\b(?:documents?|docs?|paperwork)\b/],
];
const MONEY_KINDS = { invoice: "invoice", quote: "estimate", po: "po", agreement: "agreement" };
const KIND_NOUN = { invoice: "invoice", quote: "quote", po: "purchase order", agreement: "agreement" };
const DIMS = [
  ["tech", /\b(?:technicians?|techs?|tecs?)\b/],
  ["customer", /\b(?:customers?|clients?)\b/],
  ["vendor", /\b(?:vendors?|suppliers?)\b/],
  ["brand", /\b(?:brands?|manufacturers?|makes?)\b/],
  ["city", /\b(?:cit(?:y|ies)|towns?)\b/],
  ["svctype", /\b(?:service types?|types? of (?:service|work|visit|call)|job types?)\b/],
  ["doctype", /\b(?:document types?|doc types?|types? of (?:document|doc|paperwork)|kinds? of (?:document|doc|paperwork)|types?|kinds?)\b/],
  ["month", /\bmonths?\b/],
  ["year", /\b(?:years?|annually|yearly)\b/],
];
const AMOUNT_RE = /\b(?:amounts?|billings?|billed|revenue|sales|invoiced|dollars?|worth|spend|spent|spending|income|earned|earnings|money|value|business|total value|sum)\b/;
const COUNT_CUE_RE = /\b(?:count|number|how many|counts)\b/;
const CUES = {
  share: /\b(?:percent(?:age)?|share|proportion|fraction|portion|ratio)\b|\bhow much of\b/,
  avg: /\b(?:average|avg|mean|typical)\b/,
  busy: /\b(?:busiest|slowest|quietest|busy|slow|peak|least busy|most active|least active)\b|\bwhich (?:month|year) (?:had|has|saw|did we have|were we)\b[^.]*\b(?:most|fewest|least|highest|lowest|biggest|smallest)\b|\b(?:month|year) with the (?:most|fewest|least|highest|lowest)\b/,
  top: /\b(?:top|biggest|largest|best|highest|leading|greatest)\b|\b(?:most|least|fewest|lowest) (?:active|valuable|profitable)\b/,
  versus: /\b(?:compare|compared to|comparison|versus|vs|against)\b|\bdifference between\b/,
  // R3 B2: "total of Kevin Pratt's invoices", "what do Kevin Pratt's invoices add up to": the dollar sum of one scoped set
  sum: /\b(?:total|sum)\s+(?:of|for)\b|\badd(?:s|ed)?\s+up\b/,
  // R3 B2: "who wrote the most invoices", "which technician logged the fewest repair tickets": a technician ranking with no "top" word
  who: /\bwho\s+(?:wrote|logged|handled|ran|did|completed|issued|created|made|worked|serviced|performed|closed|had|has)\b[^.?]*\b(?:most|fewest|least)\b|\bwhich\s+(?:tech|technician)\b[^.?]*\b(?:most|fewest|least)\b|\b(?:fewest|least)\b[^.?]*\b(?:by|per)\s+tech(?:nician)?\b/,
};
const WARRANTY_RES = [
  ["covered", /\b(?:still )?(?:under|in|with|have|has) (?:a )?(?:active |current |valid )?warranty\b|\bcovered\b|\bactive warrant(?:y|ies)\b/],
  ["expired", /\b(?:out of|no longer under|not under|without) warranty\b|\bexpired warrant(?:y|ies)\b|\bwarranty (?:has |is )?expired\b|\bexpired\b/],
];
const STATUS_RES = [["paid", /\bpaid\b/], ["unpaid", /\b(?:unpaid|open|outstanding|overdue|past due|late)\b/]];
const SVC_RES = [
  ["Preventive Maintenance", /\b(?:(?:preventive|preventative)(?:\s+maintenance)?|maintenance|tune-?ups?|pm)\b/],
  ["Repair", /\b(?:repairs?|breakdowns?)\b/],
  ["Emergency", /\bemergenc(?:y|ies)\b/],
  ["Installation", /\binstallations? (?:visits?|calls?|tickets?|jobs?)\b/],
  ["Inspection", /\binspections?\b/],
  ["Startup", /\bstart-?ups?\b/],
];

function take(q, re) { const m = re.exec(q); if (!m) return null; return { m, rest: (q.slice(0, m.index) + " " + q.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim() }; }

const wantAmountOrSum = (q) => /\b(?:total|sum|add(?:s|ed)? up)\b/.test(q);

/** Pure. @returns {kind:'template', t:'share'|'avg'|'top'|'busy'|'group'|'compare', ...} or null. */
export function parseTemplate(question) {
  if (!templatesEnabled()) return null;
  let q = norm(unframe(question));
  if (!q || q.length > 190) return null;
  q = q.replace(/\bhow many (\w+) (?:do we have|have we got|are there)\b/, "how many $1");
  // "Kevin Pratt's invoices": the possessive is not part of the name
  q = q.replace(/\b([a-z]{3,})'s\b/g, (m, w) => (["what", "that", "there", "here", "who", "how", "where", "when", "let", "which", "whose"].includes(w) ? m : w));
  // B3: "invoice total" / "quote value" / "by total" name the dollar amount of the documents, not a count of them
  q = q.replace(/\b(invoice|quote|estimate|proposal|bill|purchase order|po)s?\s+(?:totals?|values?)\b/g, "$1 amount").replace(/\bby\s+(?:the\s+)?(?:total|dollar value)\b/g, "by amount");
  const cue = {};
  for (const [k, re] of Object.entries(CUES)) cue[k] = re.test(q);
  const nCue = Object.values(cue).filter(Boolean).length;
  const hasDim = /\b(?:by|per|for each|each|broken down by|grouped by|split by|across)\b/.test(q) && DIMS.some(([, re]) => re.test(q.slice(q.search(/\b(?:by|per|for each|each|broken down by|grouped by|split by|across)\b/))));
  const sums = /\b(?:total|sum|revenue|invoiced|billed|billing|sales|how many|number of|count|counts)\b/.test(q);
  let t = null;
  if (cue.versus) t = "compare";
  else if (cue.share && !cue.avg) t = "share";
  else if (cue.avg && !cue.share) t = "avg";
  else if (cue.busy && /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:busiest|slowest|quietest)\b|\b(?:busiest|slowest|quietest)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(q) && /\b(?:techs?|technicians?|customers?|brands?|vendors?|cit(?:y|ies))\b/.test(q)) t = "top"; // "3 busiest techs" is a top-3
  else if (cue.busy) t = "busy";
  else if (cue.top || cue.who) t = "top";
  else if (cue.sum) t = "sum";
  else if (hasDim && nCue === 0 && (sums || SUBJECTS.some(([, re]) => re.test(q)))) t = "group";
  else if (/\bwhich (?:month|year)\b/.test(q) && /\b(?:most|fewest|least|highest|lowest)\b/.test(q)) t = "busy";
  if (!t) return null;
  // B3 fix round: grammar this reader does not apply is released, never answered as the plain positive question
  if (t !== "compare" && /\b(?:not|[a-z]+n't|other than|except|excluding|aside from|apart from|besides)\b/.test(q)) return null; // negation
  if (t === "share" && /\bor\b/.test(q)) return null; // a union of two values
  if (/\b(?:bottom|worst)\b/.test(q) && t !== "compare") return null; // the other end of a ranking
  if (t !== "compare" && (/\b(?:this|last|past|current|previous)\s+(?:month|week|quarter)\b/.test(q) || /\b(?:last|past)\s+\d+\s+(?:days?|weeks?|months?)\b/.test(q))) return null; // a rolling window this reader does not apply
  if (t === "group" && /\b(?:most|least|fewest|highest|lowest|biggest|largest|smallest|best|worst|which|who|whose|oldest|newest|latest|earliest|worth)\b/.test(q)) return null; // a superlative is not a plain breakdown
  if (nCue > 1 && !(t === "compare")) return null; // two cues at once ("top and average") is not one template
  let rest = q;
  const out = { kind: "template", t, question: q, raw: String(question ?? "") };

  // measure
  const wantAmount = AMOUNT_RE.test(q) && !COUNT_CUE_RE.test(q.replace(/\bnumber of\b/, "number of")) ? true : AMOUNT_RE.test(q) && !/\b(?:how many|number of|count)\b/.test(q);
  // period
  const yr = take(rest, /\b(?:in|during|for|of|from)\s+(20\d\d|19\d\d)\b|\b(this|last) year\b/);
  if (yr) { out.year = yr.m[1] ? Number(yr.m[1]) : yr.m[2] === "this" ? "this" : "last"; rest = yr.rest; }
  else if (/\b(?:19|20)\d\d\b/.test(rest) || /\d/.test(rest.replace(/\b(?:top|first)\s+\d+\b/, "").replace(/\b\d+\s+(?:biggest|largest|best|highest|top)\b/, ""))) { if (!/^\d+$/.test(rest.replace(/\D/g, "")) || /\b(?:19|20)\d\d\b/.test(rest)) { /* stray digits: unparsed */ } }

  // top-N number
  let n = null;
  const nm = take(rest, /\b(?:top|first|biggest|largest|best|highest|busiest)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:biggest|largest|best|highest|top|busiest)\b/);
  if (nm) { const w = nm.m[1] ?? nm.m[2]; n = /^\d+$/.test(w) ? Number(w) : NUM_WORDS[w]; rest = nm.rest; }

  // dimension (group-by) and subject
  let dim = null;
  const dm = take(rest, /\b(?:by|per|for each|each|broken down by|grouped by|split by|across|of each)\s+(?:the\s+)?(?:(?:month|year|technician|tech|customer|client|vendor|supplier|brand|manufacturer|make|city|town|service type|job type|document type|doc type|type|kind)s?)\b/);
  if (dm) { dim = DIMS.find(([, re]) => re.test(dm.m[0]))?.[0] ?? null; rest = dm.rest; }
  let subject = null;
  const hits = [];
  for (const [k, re] of SUBJECTS) { const m = re.exec(rest); if (m) hits.push([k, m]); }
  if (hits.length > 1 && t !== "compare" && hits.some(([k]) => k === "customers") && !dim) {
    const other = hits.find(([k]) => k !== "customers");
    if (other && (t === "top" || t === "busy" || t === "group")) { dim = "customer"; hits.splice(hits.findIndex(([k]) => k === "customers"), 1); }
  }
  if (hits.length) {
    const [k, m] = hits[0]; subject = k; rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    // B3: other words for the same kind of thing ("tickets ... PM visits") are the subject again, not an unknown condition
    const same = SUBJECTS.find(([kk]) => kk === k)?.[1];
    if (same) rest = rest.replace(new RegExp(same.source, "g"), " ").replace(/\s+/g, " ").trim();
  }
  if (!subject) { const im = /\b(?:installs?|installations?|installed)\b/.exec(rest); if (im) { subject = "equipment"; rest = rest.replace(im[0], " ").replace(/\s+/g, " ").trim(); } }
  rest = rest.replace(/\b(?:installs?|installations?|installed)\b/g, " ").replace(/\s+/g, " ").trim();
  // "top|busiest ... <dimension noun as plural subject>"  (top five customers / technicians / brands)
  if ((t === "top") && !dim) {
    for (const [k, re] of DIMS) {
      const m = re.exec(rest);
      if (m && /s\b/.test(m[0]) && ["tech", "customer", "vendor", "brand", "city"].includes(k)) { dim = k; rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim(); break; }
    }
    if (!dim && subject === "customers") { dim = "customer"; subject = null; }
  }
  if (t === "top" && cue.who && !dim) {
    dim = "tech"; if (n == null) n = 1;
    rest = rest.replace(/\b(?:who|which|what)\b|\btech(?:nician)?s?\b|\b(?:wrote|write|logged|handled|ran|did|completed|issued|created|made|worked|serviced|performed|closed|had|has)\b|\b(?:most|fewest|least)\b/g, " ").replace(/\s+/g, " ").trim();
  }
  if (cue.who && /\b(?:fewest|least)\b/.test(q)) out.low = true;
  if (cue.who) out.who = true;
  if (t === "busy" && !dim) { const m = /\b(month|year)s?\b/.exec(rest); if (m) { dim = m[1]; rest = rest.replace(m[0], " ").replace(/\s+/g, " ").trim(); } else dim = "month"; }
  if (t === "top" && subject === "customers" && dim === "customer") subject = null;

  // filters from closed vocabularies
  const filters = {};
  const wr = WARRANTY_RES.map(([k, re]) => [k, take(rest, re)]).find(([, r]) => r);
  if (wr) { filters.warranty = wr[0]; rest = wr[1].rest; }
  const sv = SVC_RES.map(([k, re]) => [k, take(rest, re)]).find(([, r]) => r);
  if (sv && (subject === "visits" || (!subject && t !== "share"))) { filters.svc = sv[0]; rest = sv[1].rest; }
  const st = STATUS_RES.map(([k, re]) => [k, take(rest, re)]).find(([, r]) => r);
  if (st && MONEY_KINDS[subject]) { filters.status = st[0]; rest = st[1].rest; }
  const em = take(rest, /\b(?:have|has|with|having)\s+(?:an?\s+)?(e-?mail|phone)(?:\s+(?:address|number))?(?:\s+on file)?\b/);
  if (em && subject === "customers") { filters.has = /phone/.test(em.m[1]) ? "phone" : "email"; rest = em.rest; }
  const age = take(rest, /\b(?:age|ages|old|older|newer|newest|oldest|years old)\b/);
  const wantAge = Boolean(age);
  if (age) rest = age.rest;

  // measure words consumed
  const am = take(rest, AMOUNT_RE);
  if (am) rest = am.rest;
  out.measure = wantAmount || t === "sum" ? "amount" : "count";

  // versus: split the original question around the versus word into two sides of the same dimension
  if (t === "compare") {
    const sides = splitVersus(q);
    if (!sides) return null;
    out.sides = sides;
    rest = rest.replace(/\b(?:compare|compared to|comparison|versus|vs|against|difference between|between|and|which|is|are|older|younger|newer|more|fewer|less|bigger|larger|average|on average|say|counts?|totals?)\b/g, " ").replace(/\s+/g, " ").trim();
  }

  const left = rest.split(/\s+/).filter((w) => w && !GLUE.has(w) && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !["top", "first", "biggest", "largest", "best", "highest", "average", "avg", "mean", "percent", "percentage", "share", "proportion", "fraction", "portion", "ratio", "busiest", "slowest", "quietest", "busy", "slow", "peak", "most", "fewest", "least", "lowest", "greatest", "leading", "active", "active", "typical", "had", "month", "year", "months", "years", "customer", "customers", "wh"].includes(w));
  if (left.length > 6) return null;
  Object.assign(out, { subject, dim, filters, n, wantAge, unknown: left });
  if (t === "top" && n != null && (n === 0 || n > 25)) return null; // "top 0" asks for nothing; above 25 is more than this reader lists
  if (t === "top" && dim === "customer" && !/\b(?:count|number of|how many|most (?:invoices?|jobs?|visits?|tickets?|calls?))\b/.test(q) && /\b(?:biggest|largest|best|top|highest|greatest)\b/.test(q)) {
    // "biggest customer" is the one who was invoiced the most: by dollars, the same way every time (never a count with ties broken by name)
    out.measure = "amount"; if (!out.subject || !MONEY_KINDS[out.subject]) out.subject = "invoice";
    if (n == null && /\b(?:biggest|largest|best|top|highest|greatest)\s+customer\b(?!s)/.test(q)) out.n = 1;
  }
  if (t === "top" && n == null && !out.n && /\b(?:busiest|biggest|largest|best|top|highest)\s+(?:tech|technician|brand|vendor|city)\b(?!s)/.test(q)) out.n = 1;
  if (t === "share") {
    // the denominator must carry every filter except the one measured: it is only known when the thing counted is named plainly ("of our tickets", "of units")
    const dm = q.match(/\b(?:percent(?:age)?|share|proportion|fraction|portion|ratio)\s+of\s+(.+?)\s+(?:that\s+|which\s+)?(?:are|were|is|was|have|has|had|in|with|for|over|under)\b/);
    const seg = dm ? dm[1].replace(/\b(?:our|the|all|every|my)\b/g, " ").replace(/\s+/g, " ").trim() : null;
    const subj = SUBJECTS.find(([k]) => k === subject)?.[1];
    if (!seg || !subj || seg.replace(new RegExp(subj.source, "g"), " ").replace(/\s+/g, " ").trim()) return null;
    // two conditions on the measured side: which one is the base is not said
    const conds = Object.keys(filters).length + (left.length ? 1 : 0);
    if (conds > 1) return null;
  }
  // B3: "tickets" are the service-ticket documents, not every document that records a visit
  if (subject === "visits" && /\btickets?\b/.test(q)) out.visitsDoc = "service-ticket";
  // shape sanity per template
  if (t === "share" && !(Object.keys(filters).length || left.length)) return null;
  if (t === "share" && !subject) return null;
  if (t === "avg" && !(subject || wantAge)) return null;
  if (t === "avg" && wantAge && !subject) out.subject = "equipment";
  // R3 B2: "the five biggest invoices in 2023": the biggest documents themselves, not a ranking of a group
  if (t === "top" && !dim && MONEY_KINDS[subject] && n != null && n >= 1 && /\b(?:biggest|largest|highest|top)\b/.test(q) && !wantAge) { out.listDocs = true; out.measure = "amount"; }
  else if (t === "top" && !dim) return null;
  if (t === "sum" && !(MONEY_KINDS[subject] && wantAmountOrSum(q))) return null;
  if (t === "group" && !dim) return null;
  if (t === "compare" && !(subject || wantAge || left.length)) return null;
  return out;
}

/* ---------------------------------------------------------------- data access */
const ROW_CAP = 40000;
const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const cityOf = (addr) => { const p = String(addr ?? "").split(",").map((s) => s.trim()).filter(Boolean); return p.length >= 3 ? p[p.length - 2] : p.length === 2 ? p[0] : null; };
const ymd = (v) => { const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const yearsBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / (365.25 * 86400000);

async function loadEquipment(db) {
  const { rows } = await db.raw(
    `SELECT id, data->>'manufacturer' AS manufacturer, data->>'equipment_type' AS equipment_type, data->>'model' AS model, data->>'serial_number' AS serial_number,
            data->>'service_address' AS address, substr(data->>'installation_date', 1, 10) AS installed, substr(data#>>'{warranty,expires}', 1, 10) AS expires
       FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT ${ROW_CAP + 1}`, []);
  if (rows.length > ROW_CAP) return null;
  return rows.map((r) => ({ ...r, brand: r.manufacturer ? canonicalBrandLabel(r.manufacturer) : null, city: cityOf(r.address), date: ymd(r.installed), warr: ymd(r.expires) }));
}
async function loadCustomers(db) {
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name, data->>'service_address' AS address, nullif(trim(data->>'email'), '') AS email, nullif(trim(data->>'phone'), '') AS phone
       FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} LIMIT ${ROW_CAP + 1}`, []);
  if (rows.length > ROW_CAP) return null;
  return rows.map((r) => ({ ...r, city: cityOf(r.address) }));
}
async function loadVisits(db) {
  const { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, d.created_at,
            (SELECT COALESCE(NULLIF(x.corrected_value, ''), x.value) FROM extractions x WHERE x.document_id = d.id AND x.field_key = 'service_date' ORDER BY x.created_at LIMIT 1) AS sdate,
            (SELECT COALESCE(NULLIF(x.corrected_value, ''), x.value) FROM extractions x WHERE x.document_id = d.id AND x.field_key = 'technician' ORDER BY x.created_at LIMIT 1) AS tech,
            (SELECT COALESCE(NULLIF(x.corrected_value, ''), x.value) FROM extractions x WHERE x.document_id = d.id AND x.field_key = 'service_type' ORDER BY x.created_at LIMIT 1) AS stype
       FROM documents d WHERE d.${TENANT_SQL} AND EXISTS (SELECT 1 FROM extractions x WHERE x.document_id = d.id AND x.field_key = 'service_date') LIMIT ${ROW_CAP + 1}`, []);
  if (rows.length > ROW_CAP) return null;
  return rows.map((r) => ({ ...r, date: ymd(r.sdate), tech: r.tech ? String(r.tech).trim() : null, svc: r.stype ? String(r.stype).trim() : null }));
}
async function loadMoney(db, kind) {
  const ok = await db.raw("SELECT to_regclass('public.document_financials') IS NOT NULL AS ok", []);
  if (!ok.rows[0]?.ok) return null;
  const direction = kind === "po" ? "payable" : "receivable";
  const { rows } = await db.raw(
    `SELECT f.document_id AS id, d.original_filename,
            COALESCE(NULLIF(regexp_replace(f.corrections->>'total', '[^0-9.-]', '', 'g'), '')::numeric, f.total) AS total,
            substr(COALESCE(NULLIF(f.corrections->>'invoice_date', ''), f.invoice_date::text), 1, 10) AS dt,
            COALESCE(NULLIF(f.corrections->>'customer_name', ''), f.customer_name) AS customer,
            COALESCE(NULLIF(f.corrections->>'vendor_name', ''), f.vendor_name) AS vendor,
            COALESCE(NULLIF(f.corrections->>'status', ''), f.status) AS status, f.currency, f.invoice_number,
            (SELECT COALESCE(NULLIF(x.corrected_value, ''), x.value) FROM extractions x WHERE x.document_id = f.document_id AND x.field_key = 'technician' ORDER BY x.created_at LIMIT 1) AS tech
       FROM document_financials f JOIN documents d ON d.id = f.document_id
      WHERE f.${TENANT_SQL} AND f.doc_kind = $1 AND f.direction = $2 LIMIT ${ROW_CAP + 1}`, [MONEY_KINDS_SQL[kind], direction]);
  if (rows.length > ROW_CAP) return null;
  return rows.map((r) => ({ ...r, total: r.total == null ? null : Number(r.total), date: ymd(r.dt), customer: r.customer ? String(r.customer).trim() : null, vendor: r.vendor ? String(r.vendor).trim() : null, tech: r.tech ? String(r.tech).trim() : null }));
}
const MONEY_KINDS_SQL = MONEY_KINDS;
async function loadDocTypes(db) {
  const { rows } = await db.raw(`SELECT id, document_type, original_filename FROM documents WHERE ${TENANT_SQL} LIMIT ${ROW_CAP + 1}`, []);
  return rows.length > ROW_CAP ? null : rows;
}

/** A tenant value found as a whole phrase in the question. */
function phraseIn(q, value) {
  const v = norm(value);
  return v.length >= 3 && new RegExp(`(?:^|\\s)${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(q);
}
/** Which tenant values (brand/city/tech/customer/vendor) the leftover words name; ok=false if a word is left unexplained. */
function resolveValues(unknown, q, pools) {
  const found = [];
  const used = new Set();
  for (const [kind, values] of Object.entries(pools)) {
    for (const v of [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length)) {
      if (!phraseIn(q, v)) continue;
      const words = norm(v).split(" ");
      if (!words.some((w) => unknown.includes(w))) continue;
      if (words.every((w) => used.has(w))) continue;
      found.push({ kind, value: v });
      for (const w of words) used.add(w);
    }
  }
  // a surname alone (techs / customers) when it is unique
  const left = unknown.filter((w) => !used.has(w));
  for (const w of [...left]) {
    for (const kind of ["tech"]) {
      const m = [...new Set((pools[kind] ?? []).filter(Boolean))].filter((v) => norm(v).split(" ").pop() === w);
      if (m.length === 1) { found.push({ kind, value: m[0] }); used.add(w); }
    }
  }
  return { found, ok: unknown.every((w) => used.has(w)) };
}

/* ---------------------------------------------------------------- shared primitives (count / sum / avg / group) */
const sumOf = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
function groupBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (k == null || k === "") continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }
const periodOk = (row, year, today) => { if (year == null) return true; const y = year === "this" ? Number(today.slice(0, 4)) : year === "last" ? Number(today.slice(0, 4)) - 1 : year; return row.date != null && row.date.slice(0, 4) === String(y); };
const periodLabel = (year, today) => (year == null ? "" : year === "this" ? ` in ${today.slice(0, 4)}` : year === "last" ? ` in ${Number(today.slice(0, 4)) - 1}` : ` in ${year}`);
const NOUN = { equipment: ["unit", "units"], customers: ["customer", "customers"], visits: ["service visit", "service visits"], docs: ["document", "documents"], invoice: ["invoice", "invoices"], quote: ["quote", "quotes"], po: ["purchase order", "purchase orders"], agreement: ["agreement", "agreements"] };
const noun = (s, n) => NOUN[s][n === 1 ? 0 : 1];
const DIM_LABEL = { tech: "technician", customer: "customer", vendor: "vendor", brand: "brand", city: "city", svctype: "service type", doctype: "document type", month: "month", year: "year" };

/** Rows + the dated / attribute accessors for one subject. */
async function loadSubject(db, subject) {
  if (subject === "equipment") return { rows: await loadEquipment(db), dims: { brand: (r) => r.brand, city: (r) => r.city, year: (r) => r.date?.slice(0, 4), month: (r) => r.date?.slice(0, 7) }, datedBy: "install date" };
  if (subject === "customers") return { rows: await loadCustomers(db), dims: { city: (r) => r.city }, datedBy: null };
  if (subject === "visits") return { rows: await loadVisits(db), dims: { tech: (r) => r.tech, svctype: (r) => r.svc, doctype: (r) => r.document_type, year: (r) => r.date?.slice(0, 4), month: (r) => r.date?.slice(0, 7) }, datedBy: "service date" };
  if (subject === "docs") return { rows: await loadDocTypes(db), dims: { doctype: (r) => r.document_type }, datedBy: null };
  if (MONEY_KINDS[subject]) return { rows: await loadMoney(db, subject), dims: { customer: (r) => r.customer, vendor: (r) => r.vendor, tech: (r) => r.tech, year: (r) => r.date?.slice(0, 4), month: (r) => r.date?.slice(0, 7) }, datedBy: "document date", money: true };
  return null;
}

function cite(subject, rows, group) {
  const cap = rows.slice(0, 150);
  if (subject === "equipment") return cap.map((r) => unitRecord({ id: r.id, manufacturer: r.manufacturer, equipment_type: r.equipment_type, model: r.model, serial_number: r.serial_number }, group ? { group } : {}));
  if (subject === "customers") return cap.map((r) => customerRecord({ id: r.id, customer_name: r.name, service_address: r.address }, group ? { group } : {}));
  return cap.map((r) => documentRecord({ id: r.id, original_filename: r.original_filename, document_type: r.document_type }, group ? { group } : {}));
}
const done = (text, subject, rows, basis, extra = {}) =>
  attachCitations(answerEnvelope({ text, facts: [], extra: { fastIntent: "agg_template", ...extra } }), { records: cite(subject, rows), total: rows.length, kind: "searched", basis });
const honest = (text, basis) =>
  attachCitations({ kind: "no-answer", text, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] }, { records: [], total: 0, kind: "searched", basis });

/** Apply the closed filters (+ resolved tenant values) to the subject's rows. Returns {rows, label, base, problem} or null if a filter does not apply to the subject. */
function applyFilters(subject, S, intent, resolved, today, { predicateOnly = false } = {}) {
  let rows = S.rows;
  const labels = [];
  const f = intent.filters ?? {};
  if (intent.visitsDoc && subject === "visits") rows = rows.filter((r) => r.document_type === intent.visitsDoc);
  if (intent.year != null) { if (!S.datedBy) return null; rows = rows.filter((r) => periodOk(r, intent.year, today)); }
  if (predicateOnly) return { rows, labels };
  for (const v of resolved) {
    if (v.kind === "brand") { if (subject !== "equipment") return null; const b = canonicalBrandLabel(v.value); rows = rows.filter((r) => r.brand === b); labels.push(b); }
    else if (v.kind === "city") { if (!S.dims.city) return null; rows = rows.filter((r) => r.city && r.city.toLowerCase() === v.value.toLowerCase()); labels.push(`in ${v.value}`); }
    else if (v.kind === "tech") { if (subject !== "visits" && !S.money) return null; rows = rows.filter((r) => r.tech && r.tech.toLowerCase() === v.value.toLowerCase()); labels.push(`by ${v.value}`); }
    else if (v.kind === "customer") { if (!S.money) return null; rows = rows.filter((r) => r.customer && r.customer.toLowerCase() === v.value.toLowerCase()); labels.push(`for ${v.value}`); }
    else if (v.kind === "vendor") { if (!S.money) return null; rows = rows.filter((r) => r.vendor && r.vendor.toLowerCase() === v.value.toLowerCase()); labels.push(`from ${v.value}`); }
  }
  if (f.warranty) {
    if (subject !== "equipment") return null;
    const withEnd = rows.filter((r) => r.warr);
    rows = withEnd.filter((r) => (f.warranty === "covered" ? r.warr >= today : r.warr < today));
    labels.push(f.warranty === "covered" ? "under warranty" : "out of warranty");
  }
  if (f.svc) { if (subject !== "visits") return null; rows = rows.filter((r) => r.svc && r.svc.toLowerCase() === f.svc.toLowerCase()); labels.push(`${f.svc.toLowerCase()} visits`); }
  if (f.has) { if (subject !== "customers") return null; rows = rows.filter((r) => r[f.has]); labels.push(`with ${f.has === "email" ? "an email" : "a phone"} on file`); }
  if (f.status) {
    if (!S.money) return null;
    const known = rows.filter((r) => r.status && r.status !== "unknown");
    if (!known.length) return { rows: [], labels, statusUnknown: rows.length };
    rows = known.filter((r) => (f.status === "paid" ? r.status === "paid" : r.status !== "paid"));
    labels.push(f.status === "paid" ? "paid" : "unpaid");
  }
  return { rows, labels };
}

/* ---------------------------------------------------------------- templates */
async function resolvePools(db, subject, S) {
  const pools = {};
  if (subject === "equipment") { pools.brand = [...new Set((S.rows ?? []).map((r) => r.brand).filter(Boolean))]; pools.city = [...new Set((S.rows ?? []).map((r) => r.city).filter(Boolean))]; }
  else if (subject === "customers") pools.city = [...new Set((S.rows ?? []).map((r) => r.city).filter(Boolean))];
  else if (subject === "visits") pools.tech = [...new Set((S.rows ?? []).map((r) => r.tech).filter(Boolean))];
  else if (S.money) { pools.customer = [...new Set((S.rows ?? []).map((r) => r.customer).filter(Boolean))]; pools.vendor = [...new Set((S.rows ?? []).map((r) => r.vendor).filter(Boolean))]; pools.tech = [...new Set((S.rows ?? []).map((r) => r.tech).filter(Boolean))]; }
  return pools;
}

export async function runTemplate(db, intent, { today } = {}) {
  const t0 = todayIso(today);
  let subject = intent.subject;
  if (!subject) {
    if (intent.t === "busy") subject = intent.measure === "amount" ? "invoice" : "visits";
    else if (intent.t === "group" || intent.t === "top") subject = intent.dim === "tech" || intent.dim === "svctype" ? "visits" : intent.dim === "brand" ? "equipment" : intent.dim === "doctype" ? "docs" : intent.dim === "vendor" ? "po" : intent.measure === "amount" || intent.dim === "customer" ? "invoice" : null;
  }
  if (!subject) return null;
  if (intent.measure === "amount" && !MONEY_KINDS[subject]) { if (subject === "customers") subject = "invoice"; else return null; }
  if (intent.t === "compare") return compareTemplate(db, intent, subject, t0);
  const S = await loadSubject(db, subject);
  if (!S?.rows) return null;
  if (intent.low && intent.dim === "tech") {
    // the fewest ranking counts every technician on the roster, including those with none in the window
    const { rows: tr } = await db.raw(`SELECT DISTINCT trim(COALESCE(NULLIF(corrected_value, ''), value)) AS v FROM extractions WHERE field_key = 'technician' AND ${TENANT_SQL} AND COALESCE(value, '') <> ''`, []);
    S.roster = tr.map((r) => String(r.v)).filter(Boolean);
  }
  const pools = await resolvePools(db, subject, S);
  const rv = resolveValues(intent.unknown, intent.question, pools);
  if (!rv.ok) return null;
  const fl = applyFilters(subject, S, intent, rv.found, t0);
  if (!fl) return null;
  switch (intent.t) {
    case "share": return shareTemplate(subject, S, intent, rv.found, t0);
    case "avg": return avgTemplate(subject, S, intent, fl, t0);
    case "sum": return sumTemplate(subject, S, intent, fl, rv.found, t0);
    case "busy": return busyTemplate(subject, S, intent, fl, t0);
    case "top":
      if (intent.listDocs) return listDocsTemplate(subject, S, intent, fl, t0);
      return groupTemplate(subject, S, intent, fl, t0);
    case "group": return groupTemplate(subject, S, intent, fl, t0);
    default: return null;
  }
}

function shareTemplate(subject, S, intent, resolved, today) {
  // numerator = every filter; denominator = the subject with the period only
  const base = applyFilters(subject, S, intent, [], today, { predicateOnly: true });
  const num = applyFilters(subject, S, intent, resolved, today);
  if (!base || !num) return null;
  if (num.statusUnknown) return honest(`I can't give that share: none of the ${plural(num.statusUnknown, noun(subject, 1))} on file records a payment status, so there is nothing to count as ${intent.filters.status === "paid" ? "paid" : "unpaid"}.`, `Checked the payment status of every ${noun(subject, 1)} on file; none has one recorded.`);
  if (!num.labels.length) return null;
  const den = base.rows.length;
  if (!den) return honest(`There are no ${noun(subject, 2)} on file${periodLabel(intent.year, today)}, so there is no share to compute.`, `Counted the ${noun(subject, 2)} on file; none.`);
  const nn = num.rows.length;
  const pct = Math.round((nn / den) * 1000) / 10;
  const pred = num.labels.join(" and ");
  const noEnd = intent.filters.warranty ? base.rows.filter((r) => !r.warr).length : 0;
  const text = `${nn.toLocaleString("en-US")} of ${plural(den, noun(subject, 1), noun(subject, 2))}${periodLabel(intent.year, today)} (${pct}%) are ${pred}.`.replace(/ are with /, " have ") + (noEnd ? ` (${plural(noEnd, "unit")} with no warranty end date on file count as not covered.)` : "");
  return done(text, subject, num.rows, `Counted ${nn} of the ${den} ${noun(subject, 2)} on file${periodLabel(intent.year, today)} that are ${pred}, and divided by ${den}.`, { aggTemplate: "share" });
}

function avgTemplate(subject, S, intent, fl, today) {
  const rows = fl.rows;
  const label = fl.labels.length ? ` ${fl.labels.join(" ")}` : "";
  if (intent.wantAge) {
    if (subject !== "equipment") return null;
    const dated = rows.filter((r) => r.date);
    if (!dated.length) return honest(`No unit${label ? ` ${fl.labels.join(" ")}` : ""} on file has an install date, so I can't work out an average age.`, "Checked the install date of every unit; none has one.");
    const avg = dated.reduce((a, r) => a + yearsBetween(r.date, today), 0) / dated.length;
    const gone = rows.length - dated.length;
    return done(`The average age is ${avg.toFixed(1)} years, across ${dated.length.toLocaleString("en-US")}${fl.labels.length ? ` ${fl.labels.join(" ")}` : ""} ${dated.length === 1 ? "unit" : "units"} with an install date${gone ? ` (${gone} without a date left out)` : ""}.`, "equipment", dated, `Averaged today minus the install date over ${dated.length} units that have one.`, { aggTemplate: "avg-age" });
  }
  if (!S.money) {
    if (subject === "visits" || subject === "customers" || subject === "equipment" || subject === "docs") return null;
  }
  if (intent.dim) {
    // R3 B2: "average invoice per technician": one average per group, never the shop-wide average with the grouping dropped
    const keyFn = S.dims[intent.dim];
    if (!keyFn || !S.money) return null;
    const m = groupBy(rows.filter((r) => r.total != null), keyFn);
    if (!m.size) return honest(`None of the ${noun(subject, 2)} on file shows an amount, so there is nothing to average.`, "Checked the amount of every matching document; none prints one.");
    const list = [...m.entries()].map(([k, rs]) => ({ key: k, rows: rs, avg: sumOf(rs, (r) => r.total) / rs.length })).sort((a, b) => b.avg - a.avg || String(a.key).localeCompare(String(b.key)));
    const lines = list.slice(0, 25).map((x) => `${showKey(x.key)} ${money(x.avg)} (${plural(x.rows.length, noun(subject, 1), noun(subject, 2))})`).join("; ");
    return done(`Average ${noun(subject, 1)} per ${dimNoun(intent.dim)}${label}${periodLabel(intent.year, today)}: ${lines}${list.length > 25 ? `; and ${list.length - 25} more` : ""}.`, subject, list.flatMap((x) => x.rows), `Averaged the amount of each ${dimNoun(intent.dim)}'s ${noun(subject, 2)} that have an amount.`, { aggTemplate: "avg_group" });
  }
  const priced = rows.filter((r) => r.total != null);
  if (!priced.length) return honest(`None of the ${plural(rows.length, noun(subject, 1), noun(subject, 2))} on file shows an amount, so there is nothing to average.`, "Checked the amount of every matching document; none prints one.");
  const sum = sumOf(priced, (r) => r.total);
  const gone = rows.length - priced.length;
  return done(`The average ${noun(subject, 1)} is ${money(sum / priced.length)}: the average of ${plural(priced.length, noun(subject, 1), noun(subject, 2))}${label}${periodLabel(intent.year, today)} that have an amount (${money(sum)} in total)${gone ? `; ${gone} with no amount are left out` : ""}.`, subject, priced, `Averaged the printed total of ${priced.length} ${noun(subject, 2)}.`, { aggTemplate: "avg-amount" });
}

/** "total of Kevin Pratt's invoices": the sum of the printed amounts of one scoped set (a technician or a customer named in the question). */
function sumTemplate(subject, S, intent, fl, resolved, today) {
  if (!S.money || !resolved.length) return null; // an unscoped total belongs to the money reader
  const rows = fl.rows;
  const label = fl.labels.length ? ` ${fl.labels.join(" ")}` : "";
  const priced = rows.filter((r) => r.total != null);
  if (!rows.length) return honest(`No ${noun(subject, 2)}${label}${periodLabel(intent.year, today)} are on file, so the total is ${money(0)}.`, `Looked for ${noun(subject, 2)}${label}; none.`);
  const sum = sumOf(priced, (r) => r.total);
  const gone = rows.length - priced.length;
  const by = resolved.some((v) => v.kind === "tech") ? " (matched on the technician named on each invoice)" : "";
  return done(`${plural(priced.length, noun(subject, 1), noun(subject, 2))}${label}${periodLabel(intent.year, today)} ${priced.length === 1 ? "totals" : "total"} ${money(sum)}${by}${gone ? `; ${plural(gone, noun(subject, 1), noun(subject, 2))} with no amount ${gone === 1 ? "is" : "are"} not included` : ""}.`, subject, priced, `Added the printed amount of ${plural(priced.length, noun(subject, 1), noun(subject, 2))}${label}${periodLabel(intent.year, today)}.`, { aggTemplate: "sum" });
}

/** "the five biggest invoices in 2023": the documents themselves, largest first; a tie at the cut-off is said. */
function listDocsTemplate(subject, S, intent, fl, today) {
  if (!S.money || intent.dim) return null;
  const priced = fl.rows.filter((r) => r.total != null).sort((a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id)));
  if (!priced.length) return null;
  const nTop = Math.min(intent.n ?? 5, 25);
  const top = priced.slice(0, nTop);
  const edge = priced[nTop];
  const tie = edge && edge.total === top[top.length - 1].total ? ` Note: another ${noun(subject, 1)} ties at ${money(edge.total)}, so the cut-off is not unique.` : "";
  const asked = intent.n > priced.length ? ` (you asked for ${intent.n}; that is all there are)` : "";
  const lines = top.map((r, i) => `${i + 1}. ${r.invoice_number ? `#${r.invoice_number} ` : ""}${r.customer ? `${r.customer} ` : ""}${money(r.total)}${r.date ? ` (${r.date})` : ""}`).join("; ");
  return done(`The ${top.length === 1 ? "biggest" : `${top.length} biggest`} ${noun(subject, top.length === 1 ? 1 : 2)}${periodLabel(intent.year, today)}${asked}: ${lines}.${tie}`, subject, top, `Ranked ${plural(priced.length, noun(subject, 1), noun(subject, 2))}${periodLabel(intent.year, today)} that have an amount by that amount.`, { aggTemplate: "top_docs" });
}

function groups(subject, S, intent, rows) {
  const keyFn = S.dims[intent.dim];
  if (!keyFn) return null;
  const m = groupBy(rows, keyFn);
  const useAmount = intent.measure === "amount" && S.money;
  const list = [...m.entries()].map(([k, rs]) => {
    const priced = useAmount ? rs.filter((r) => r.total != null) : rs;
    return { key: k, rows: priced, value: useAmount ? sumOf(priced, (r) => r.total) : rs.length, n: rs.length };
  });
  return { list, useAmount, keyed: [...m.values()].reduce((a, rs) => a + rs.length, 0) };
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const showKey = (k) => (/^\d{4}-\d{2}$/.test(String(k)) ? `${MONTHS[Number(String(k).slice(5)) - 1]} ${String(k).slice(0, 4)}` : String(k));
const fmtVal = (g, useAmount) => (useAmount ? money(g.value) : g.value.toLocaleString("en-US"));
const dimNoun = (dim) => DIM_LABEL[dim] ?? dim;

function busyTemplate(subject, S, intent, fl, today) {
  if (intent.dim !== "month" && intent.dim !== "year") return null;
  if (!S.dims[intent.dim]) return null;
  const g = groups(subject, S, intent, fl.rows);
  if (!g || !g.list.length) return null; // nothing dated: leave it to the older lanes rather than say "no data"
  const slow = /\b(?:slowest|quietest|least|fewest|lowest|smallest|slow)\b/.test(intent.question);
  const target = (slow ? Math.min : Math.max)(...g.list.map((x) => x.value));
  const tied = g.list.filter((x) => x.value === target).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const what = g.useAmount ? `${noun(subject, 1)} total` : noun(subject, 2);
  const names = tied.slice(0, 6).map((x) => showKey(x.key)).join(", ");
  const text = `${slow ? "Slowest" : "Busiest"} ${intent.dim} by ${what}: ${tied.length > 1 ? `${tied.length} are tied at ${fmtVal(tied[0], g.useAmount)} (${names}${tied.length > 6 ? ", ..." : ""})` : `${names} with ${fmtVal(tied[0], g.useAmount)}`}. Counted over ${plural(g.keyed, noun(subject, 1), noun(subject, 2))} that have a ${S.datedBy ?? "date"}${periodLabel(intent.year, today)}; ${intent.dim}s with none are not counted.`;
  return done(text, subject, tied.flatMap((x) => x.rows), `Grouped ${g.keyed} dated ${noun(subject, 2)} by ${intent.dim} and compared the ${g.useAmount ? "totals" : "counts"}.`, { aggTemplate: "busy" });
}

function groupTemplate(subject, S, intent, fl, today) {
  if (!S.dims[intent.dim]) return null;
  const g = groups(subject, S, intent, fl.rows);
  if (!g) return null;
  if (!g.list.length) return null;
  const chrono = intent.t === "group" && (intent.dim === "month" || intent.dim === "year");
  const sorted = g.list.sort(chrono ? (a, b) => String(a.key).localeCompare(String(b.key)) : (a, b) => b.value - a.value || String(a.key).localeCompare(String(b.key)));
  const what = g.useAmount ? `${noun(subject, 1)} totals` : noun(subject, 2);
  const unkeyed = fl.rows.length - g.keyed;
  const tail = unkeyed ? ` (${plural(unkeyed, noun(subject, 1), noun(subject, 2))} with no ${dimNoun(intent.dim)} on file are not included)` : "";
  if (intent.t === "top" && intent.low) {
    // R3 B2: "which technician logged the fewest repair tickets": the lowest value, everyone tied at it listed
    const list0 = [...g.list];
    if (intent.dim === "tech" && S.roster) { const have = new Set(list0.map((x) => String(x.key).toLowerCase())); for (const r of S.roster) if (!have.has(r.toLowerCase())) list0.push({ key: r, rows: [], value: 0, n: 0 }); }
    const asc = list0.sort((a, b) => a.value - b.value || String(a.key).localeCompare(String(b.key)));
    const lowV = asc[0].value;
    const tied = asc.filter((x) => x.value === lowV);
    const what2 = g.useAmount ? `invoice amount` : noun(subject, 2);
    const names = tied.slice(0, 8).map((x) => showKey(x.key)).join(", ");
    const lab2 = fl.labels.length ? ` (${fl.labels.join(" ")})` : "";
    const head = g.useAmount ? "Lowest" : "Fewest";
    return done(`${tied.length === 1 ? `${head} ${what2}${lab2}${periodLabel(intent.year, today)}: ${names}, ${fmtVal(tied[0], g.useAmount)}` : `${tied.length} ${dimNoun(intent.dim)}s tie for the ${head.toLowerCase()} ${what2}${lab2}${periodLabel(intent.year, today)} at ${fmtVal(tied[0], g.useAmount)}: ${names}${tied.length > 8 ? ", ..." : ""}`}. Computed over ${plural(g.keyed, noun(subject, 1), noun(subject, 2))}${tail}.`, subject, tied.flatMap((x) => x.rows), `Grouped ${plural(g.keyed, noun(subject, 1), noun(subject, 2))} by ${dimNoun(intent.dim)} and took the lowest ${g.useAmount ? "total" : "count"}, counting every technician on file.`, { aggTemplate: "bottom" });
  }
  if (intent.t === "top") {
    if ((intent.n ?? 5) > 25 && sorted.length > 25) return null; // more than this reader lists: released, never silently cut to a smaller list
    if (intent.n === 0) return null;
    const nTop = Math.max(1, Math.min(intent.n ?? 5, 25));
    const asked = intent.n != null && intent.n > sorted.length;
    const top = sorted.slice(0, nTop);
    const edge = sorted[nTop];
    const tie = edge && top.length && edge.value === top[top.length - 1].value ? ` Note: ${sorted.filter((x) => x.value === edge.value).length > 1 ? "others tie" : "the next one ties"} at ${fmtVal(edge, g.useAmount)}, so the cut-off is not unique.` : "";
    const lines = top.map((x, i) => `${i + 1}. ${showKey(x.key)} ${fmtVal(x, g.useAmount)}`).join("; ");
    const basisN = g.useAmount ? `${plural(g.list.reduce((a, x) => a + x.rows.length, 0), noun(subject, 1), noun(subject, 2))} with an amount` : `${plural(g.keyed, noun(subject, 1), noun(subject, 2))}`;
    if (top.length === 1 && !asked) {
      const adj = g.useAmount ? "Biggest" : (intent.dim === "tech" || intent.dim === "month" || intent.dim === "year" || /busiest/.test(intent.question ?? "")) ? "Busiest" : "Top";
      const one = top[0];
      if (intent.who && !g.useAmount) return done(`Most ${noun(subject, 2)}${periodLabel(intent.year, today)}: ${showKey(one.key)}, ${fmtVal(one, g.useAmount)}. Computed over ${basisN}${tail}.${tie}`, subject, top.flatMap((x) => x.rows), `Grouped by ${dimNoun(intent.dim)}, counted and ranked.`, { aggTemplate: "top" });
      return done(`${adj} ${dimNoun(intent.dim)} by ${g.useAmount ? `${noun(subject, 1)} amount` : `number of ${noun(subject, 2)}`}${periodLabel(intent.year, today)}: ${showKey(one.key)}, ${fmtVal(one, g.useAmount)}. Computed over ${basisN}${tail}.${tie}`, subject, top.flatMap((x) => x.rows), `Grouped by ${dimNoun(intent.dim)}, ${g.useAmount ? "summed the printed totals" : "counted"} and ranked.`, { aggTemplate: "top" });
    }
    return done(`${asked ? `All ${top.length} ${dimNoun(intent.dim)}${top.length === 1 ? "" : "s"} on file (you asked for ${intent.n}), ranked` : `Top ${top.length} ${dimNoun(intent.dim)}${top.length === 1 ? "" : "s"}`} by ${g.useAmount ? `${noun(subject, 1)} amount` : `number of ${noun(subject, 2)}`}${periodLabel(intent.year, today)}: ${lines}. Computed over ${basisN}${tail}.${tie}`, subject, top.flatMap((x) => x.rows), `Grouped by ${dimNoun(intent.dim)}, ${g.useAmount ? "summed the printed totals" : "counted"} and ranked.`, { aggTemplate: "top" });
  }
  const shown = sorted.slice(0, 25);
  const lines = shown.map((x) => `${showKey(x.key)} ${fmtVal(x, g.useAmount)}`).join(", ");
  const total = g.useAmount ? money(sumOf(sorted, (x) => x.value)) : sumOf(sorted, (x) => x.value).toLocaleString("en-US");
  return done(`${g.useAmount ? `${noun(subject, 1)} totals` : `${total} ${noun(subject, 2)}`} by ${dimNoun(intent.dim)}${periodLabel(intent.year, today)}${g.useAmount ? ` (${total} in all)` : ""}: ${lines}${sorted.length > shown.length ? `, and ${sorted.length - shown.length} more` : ""}${tail}.`, subject, sorted.flatMap((x) => x.rows), `Grouped by ${dimNoun(intent.dim)} and ${g.useAmount ? "summed the printed totals" : "counted"}.`, { aggTemplate: "group" });
}

async function compareTemplate(db, intent, subject, today) {
  const sides = intent.sides;
  // the dimension both sides share: a brand, a city, a technician or a service type found in the tenant's data
  const S = await loadSubject(db, subject);
  if (!S?.rows) return null;
  const pools = await resolvePools(db, subject, S);
  const resolvedSides = sides.map((s) => resolveValues(norm(s).split(" ").filter((w) => !GLUE.has(w)), norm(s), pools));
  if (resolvedSides.some((r) => r.found.length !== 1)) return null;
  const [a, b] = resolvedSides.map((r) => r.found[0]);
  if (a.kind !== b.kind || a.value.toLowerCase() === b.value.toLowerCase()) return null;
  const whole = resolveValues(intent.unknown, intent.question, pools);
  const sidewords = new Set([...norm(a.value).split(" "), ...norm(b.value).split(" ")]);
  if (!intent.unknown.every((w) => sidewords.has(w) || whole.found.some((f) => norm(f.value).split(" ").includes(w)))) return null;
  const each = [a, b].map((v) => {
    const fl = applyFilters(subject, S, { ...intent, filters: intent.filters }, [v], today);
    return fl ? { v, rows: fl.rows } : null;
  });
  if (each.some((x) => !x)) return null;
  const parts = [];
  const unit = noun(subject, 2);
  const cmp = (lbl, x, y, higher = true) => (x === y ? `they tie on ${lbl}` : `${(x > y) === higher ? each[0].v.value : each[1].v.value} has the ${higher ? "higher" : "lower"} ${lbl}`);
  const line = each.map((e) => {
    const bits = [`${plural(e.rows.length, noun(subject, 1), unit)}`];
    if (intent.wantAge && subject === "equipment") {
      const dated = e.rows.filter((r) => r.date);
      e.avgAge = dated.length ? dated.reduce((s, r) => s + yearsBetween(r.date, today), 0) / dated.length : null;
      bits.push(e.avgAge == null ? "no install dates" : `average age ${e.avgAge.toFixed(1)} years over ${dated.length} with an install date`);
    }
    if (intent.measure === "amount" && S.money) {
      const priced = e.rows.filter((r) => r.total != null);
      e.sum = sumOf(priced, (r) => r.total);
      bits.push(`${money(e.sum)} across ${plural(priced.length, noun(subject, 1), unit)} with an amount`);
    }
    return `${e.v.value}: ${bits.join(", ")}`;
  });
  parts.push(line.join("; versus "));
  if (each[0].rows.length !== each[1].rows.length) parts.push(`${each[0].rows.length > each[1].rows.length ? each[0].v.value : each[1].v.value} has more ${unit}`);
  else parts.push(`both have ${each[0].rows.length} ${unit}`);
  if (intent.wantAge && each[0].avgAge != null && each[1].avgAge != null) parts.push(each[0].avgAge === each[1].avgAge ? "they are the same age on average" : `${each[0].avgAge > each[1].avgAge ? each[0].v.value : each[1].v.value} is older on average`);
  if (intent.measure === "amount" && S.money) parts.push(cmp("total", each[0].sum, each[1].sum));
  return done(`${parts[0]}. ${parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join(". ")}${parts.length > 1 ? "." : ""}`, subject, each.flatMap((e) => e.rows), `Counted ${noun(subject, 2)} for ${a.value} and for ${b.value}${intent.wantAge ? " and averaged their install ages" : ""}.`, { aggTemplate: "compare" });
}
