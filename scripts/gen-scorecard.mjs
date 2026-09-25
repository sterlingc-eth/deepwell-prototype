#!/usr/bin/env node
/**
 * Generates the Donovan Scorecard golden exam: test-docs/scorecard/exam.json (~300 questions).
 *
 *   node scripts/gen-scorecard.mjs           # (re)write the exam file and print the coverage table
 *   node scripts/gen-scorecard.mjs --check   # fail (exit 1) if the checked-in exam.json is stale or out of contract
 *
 * WHERE THE QUESTIONS COME FROM: test-docs/question-bank/bank.json (6,048 entries: 756 bases x 8 wording variants,
 * 24 categories incl. the live-miss categories). For every category the generator picks a deterministic, spread-out
 * sample of canonical bases and adds the typo + abbreviated wording of every third one, so each category is tested
 * in its plain and its messy forms. The bank's own `answerValue` is deliberately NOT used as the answer key: it is
 * pinned to one demo corpus. Each question instead carries an ORACLE - a small SQL query over the shop's BASE tables
 * (entities, documents, extractions, document_entity_links, document_pages) that recomputes the right answer for
 * whatever data the tenant has today. The oracle shares no code with Donovan (no analytics.js, no views, no agent
 * tools): geography is a regex over service_address, warranty status is `data->'warranty'->>'expires'` against
 * today, so a bug in Donovan's own logic cannot also live in the answer key. A question about a customer or
 * address the tenant does not have is skipped (`requires` guard), never failed.
 *
 * Comparison types (api/_lib/scorecard/compare.js): number (exact), set (precision and recall >= 0.9), value
 * (accepted alternatives), yesno, honest-zero (the records cannot answer: pass only if nothing is invented),
 * rubric (one Haiku grading call; capped at 15% of the exam).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { breadthQuestions } from "../test-docs/scorecard/breadth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANK = join(ROOT, "test-docs", "question-bank", "bank.json");
const OUT = join(ROOT, "test-docs", "scorecard", "exam.json");
const CHECK = process.argv.includes("--check");

/* ------------------------------------------------------------------ quotas (bases per category) */
const QUOTA = {
  comparisons: 8, "counts-age": 5, "counts-brand": 8, "counts-docs": 12, "counts-geo": 12, "counts-warranty": 6,
  coverage: 5, "data-hygiene": 8, "follow-up": 4, history: 8, lists: 6,
  "live-misses-2026-09-21": 10, "live-misses-2026-09-21b": 4, "live-misses-2026-09-22": 12, "live-misses-2026-09-22b": 8,
  lookups: 26, "maintenance-due": 5, notes: 8, technician: 5, time: 6, "two-condition": 12, warranty: 12, "yes-no": 5,
};
const VARIANT_EVERY = 3; // every 3rd selected base also gets its typo + abbreviated wording
const RUBRIC_CAP = 0.15;
const BREADTH_CATEGORIES = ["financials", "content", "semantic", "multi-hop", "trends", "rankings", "tech-performance", "data-quality", "existence", "explain", "persona"];

/* ------------------------------------------------------------------ SQL building blocks */
const ADDR = (col) => col;
// GEOGRAPHY (adjudicated 2026-09-24, see test-docs/scorecard/ADJUDICATION.md): a customer's city / state / zip come from
// the one free-text service address. The regexes tolerate the shapes real addresses have - "City, ST 85201",
// "City ST 85201" (no comma before the state: the shape the first version silently dropped, losing one customer from
// every "customers in Mesa / AZ" count), ZIP+4, "Suite/Apt" segments, and a state with no zip. A customer whose
// address has no recognisable state/city is counted in NO bucket (never invented into one).
const STATE_ZIP_TAIL = "(^|[[:space:],])[A-Za-z]{2}[[:space:]]*[0-9]{5}([[:space:]-]*[0-9]{4})?[[:space:]]*$";
const CITY = (col) => `(SELECT z.s FROM (SELECT btrim(regexp_replace(regexp_replace(t.seg, '${STATE_ZIP_TAIL}', ''), '(^|[[:space:],])[A-Z]{2}[[:space:]]*$', '')) AS s, t.ord FROM unnest(string_to_array(${ADDR(col)}, ',')) WITH ORDINALITY AS t(seg, ord) WHERE t.ord > 1) z WHERE z.s <> '' AND z.s !~ '[0-9]' AND z.s !~* '^(suite|ste|unit|apt|apartment|bldg|building|floor|fl|room|rm|lot|space|spc)([[:space:].]|$)' ORDER BY z.ord DESC LIMIT 1)`;
const STATE = (col) => `COALESCE(upper(substring(${ADDR(col)} from '(?:^|[^A-Za-z])([A-Za-z]{2})[[:space:]]*[0-9]{5}([[:space:]-]*[0-9]{4})?[[:space:]]*$')), upper(substring(${ADDR(col)} from ',[[:space:]]*([A-Za-z]{2})[[:space:]]*$')), CASE WHEN ${ADDR(col)} ~* '\\marizona\\M' THEN 'AZ' END)`;
const ZIP = (col) => `substring(${ADDR(col)} from '([0-9]{5})([[:space:]-]*[0-9]{4})?[[:space:]]*$')`;
const GEO = { city: CITY, state: STATE, zip: ZIP };
const ISO = (col) => `(CASE WHEN ${col} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(${col}, 1, 10)::date END)`;
const DOCTYPE = (col) => `lower(replace(${col}, '_', '-'))`;
const DOCTYPE_ALIASES = {
  invoice: ["invoice"], permit: ["permit"], "maintenance-agreement": ["maintenance-agreement", "maintenance-plan"],
  "warranty-registration": ["warranty-registration", "warranty"], "service-ticket": ["service-ticket", "service-report"],
  "work-order": ["work-order"], "proposal-quote": ["proposal-quote", "proposal", "quote"], "dispatch-note": ["dispatch-note"],
  "inspection-report": ["inspection-report"], "startup-sheet": ["startup-sheet"], "purchase-order": ["purchase-order"],
  "nameplate-photo": ["nameplate-photo", "nameplate"], "equipment-record": ["equipment-record"], correspondence: ["correspondence"],
};

// A "service visit" document: work that was done on site. A maintenance agreement, permit, warranty card, quote,
// PO or nameplate photo carries dates too (start, issue, expiry) but is not a visit, so those never answer
// "when did we last service it" / "how many times have we been there" (adjudicated: a future agreement date was
// being read as a "last service").
const VISIT_TYPES = ["service-ticket", "service-report", "work-order", "dispatch-note", "inspection-report", "startup-sheet", "invoice"];
const VISIT_SQL_ARR = (q) => `${q.p(VISIT_TYPES)}::text[]`;

class Q {
  constructor() { this.params = []; this.todayIdx = 0; }
  p(v) { this.params.push(v); return `$${this.params.length}`; }
  today() { if (!this.todayIdx) { this.params.push("@today"); this.todayIdx = this.params.length; } return `$${this.todayIdx}::date`; }
}

const wstatus = (e, q) => {
  const ex = `(${e}.data->'warranty'->>'expires')`;
  return `(CASE WHEN ${ex} IS NULL OR ${ex} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown'
     WHEN substr(${ex}, 1, 10)::date < ${q.today()} THEN 'expired'
     WHEN substr(${ex}, 1, 10)::date - ${q.today()} <= 365 THEN 'expiring' ELSE 'active' END)`;
};
const installYear = (e) => `(CASE WHEN ${e}.data->>'installation_date' ~ '^[0-9]{4}' THEN substr(${e}.data->>'installation_date', 1, 4)::int END)`;
const OPS = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
const EQUIP = "entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL";
const eaddr = (e = "e") => `COALESCE(${e}.data->>'service_address', (SELECT c0.data->>'service_address' FROM entities c0 WHERE c0.id = ${e}.customer_id))`;

/** One filter as a predicate on equipment alias e. null = not expressible. */
function equipPred(f, q, yearsAgo) {
  const op = OPS[f.op];
  switch (f.field) {
    case "brand": return f.op === "eq" ? `lower(e.data->>'manufacturer') = lower(${q.p(String(f.value))})` : null;
    case "warrantyStatus": return f.op === "eq" ? `${wstatus("e", q)} = ${q.p(String(f.value))}` : null;
    case "installYear": {
      if (!op || typeof f.value !== "number") return null;
      const rhs = yearsAgo != null ? `(EXTRACT(YEAR FROM ${q.today()})::int - ${Math.trunc(yearsAgo)})` : q.p(f.value);
      return `${installYear("e")} ${op} ${rhs}`;
    }
    case "city": case "state": case "zip": return f.op === "eq" ? `lower(${GEO[f.field](eaddr())}) = lower(${q.p(String(f.value))})` : null;
    default: return null;
  }
}
/** One filter as a predicate on customer alias c. */
function customerPred(f, q, yearsAgo) {
  switch (f.field) {
    case "city": case "state": case "zip": return f.op === "eq" ? `lower(${GEO[f.field]("(c.data->>'service_address')")}) = lower(${q.p(String(f.value))})` : null;
    case "hasEmail": return f.value ? `coalesce(c.data->>'email', '') <> ''` : `coalesce(c.data->>'email', '') = ''`;
    case "hasPhone": return f.value ? `coalesce(c.data->>'phone', '') <> ''` : `coalesce(c.data->>'phone', '') = ''`;
    case "documentType": {
      const alts = DOCTYPE_ALIASES[String(f.value)];
      if (!alts || f.op !== "eq") return null;
      return `EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id WHERE l.entity_id = c.id AND ${DOCTYPE("d.document_type")} = ANY(${q.p(alts)}::text[]))`;
    }
    case "brand": case "warrantyStatus": case "installYear": {
      const inner = equipPred(f, q, yearsAgo);
      return inner ? `EXISTS (SELECT 1 FROM ${EQUIP} AND e.customer_id = c.id AND ${inner})` : null;
    }
    default: return null;
  }
}

/** Build the SQL for a structured analytics expectation. Returns {sql, params, cmp} or null when not expressible. */
/** A bank entry that only NAMES its conditions (conditionsOnly, no filters) must still be graded on them: derive the filters from the wording or give up. */
function deriveFilters(ex, text) {
  const out = [];
  const t = text.toLowerCase();
  const negative = /\b(?:no|without|missing|lack|lacking|dont have|don'?t have|doesnt have|doesn'?t have|not have|have not|havent|haven'?t)\b/.test(t);
  for (const cond of ex.conditionsOnly ?? []) {
    if (cond === "email") out.push({ field: "hasEmail", op: "eq", value: !negative });
    else if (cond === "phone") out.push({ field: "hasPhone", op: "eq", value: !negative });
    else if (cond === "state") { const m = /\b(arizona|az|nevada|nv)\b/i.exec(text); if (m) out.push({ field: "state", op: "eq", value: /^(?:arizona|az)$/i.test(m[1]) ? "AZ" : "NV" }); else return null; }
    else if (cond === "city") { const m = /\b(?:in|from)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s*\??$/.exec(text.trim()); if (m) out.push({ field: "city", op: "eq", value: m[1] }); else return null; }
    else return null; // brand / county / month / maintenance / money: no derivation here (another family handles it, or it is skipped)
  }
  return out;
}

function buildAnalytics(entry, text) {
  let ex = entry.expect ?? {};
  if (ex.unsupported || !["customers", "equipment", "warranties", "documents"].includes(ex.entity)) return null;
  // "How many CUSTOMERS have a unit newer than 5 years" counts customers, not units (adjudicated: the bank filed these under `equipment`).
  if ((ex.entity === "equipment" || ex.entity === "warranties") && !ex.groupBy && /\b(?:customers?|clients?|accounts?)\b/i.test(text) && !/\b(?:units?|systems?|equipment)\s+(?:do|does|per)\b/i.test(text)) ex = { ...ex, entity: "customers" };
  let filters = ex.filters ?? [];
  if (!filters.length && ex.conditionsOnly?.length) {
    const d = deriveFilters(ex, text);
    if (!d) return null;
    filters = d;
  }
  const yrs = (/\b(\d+)\s+years?\b/i.exec(text) ?? [])[1];
  const yearsAgo = yrs ? Number(yrs) : null;
  const wantsList = /^\s*(?:which|who|who's|whos|list|give me|show|name)\b/i.test(text) && !/\bhow many\b/i.test(text);
  const isYesNo = typeof ex.answerValue === "boolean";
  const q = new Q();
  // "the top brand", "the busiest zip" answer one item, not the whole grouping; an unfiltered question with a time or
  // expiry qualifier ("expires in the next 90 days") is not something these structured filters can express.
  if (/\b(?:most|top|biggest|largest|highest|least|fewest|best)\b/i.test(text)) return null;
  if (!filters.length && !ex.groupBy && !(/\bhow many\b/i.test(text) && !/\b(?:next|this|last|since|days?|months?|years?|weeks?|quarter|expir|due|warrant|older|newer|e-?mail|phone|county|brand|arizona|nevada|(?:in|from)\s+[A-Z][a-z]+)\b/i.test(text))) return null;

  const preds = [];
  const ent = ex.entity;
  for (const f of filters) {
    let pr;
    if (ent === "customers") pr = customerPred(f, q, yearsAgo);
    else if (ent === "documents") {
      const alts = f.field === "documentType" && f.op === "eq" ? DOCTYPE_ALIASES[String(f.value)] : null;
      pr = alts ? `${DOCTYPE("d.document_type")} = ANY(${q.p(alts)}::text[])` : null;
    } else pr = equipPred(f, q, yearsAgo);
    if (!pr) return null;
    preds.push(pr);
  }
  const where = preds.length ? ` AND ${preds.join(" AND ")}` : "";
  const from = ent === "customers" ? "entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL"
    : ent === "documents" ? "documents d WHERE true" : EQUIP;

  if (ex.groupBy) {
    let key;
    if (["city", "state", "zip"].includes(ex.groupBy) && ent === "customers") key = GEO[ex.groupBy]("(c.data->>'service_address')");
    else if (ex.groupBy === "brand" && ent !== "customers" && ent !== "documents") key = "lower(e.data->>'manufacturer')";
    else if (ex.groupBy === "warrantyStatus" && (ent === "equipment" || ent === "warranties")) key = wstatus("e", q);
    else if (ex.groupBy === "documentType" && ent === "documents") key = DOCTYPE("d.document_type");
    else return null;
    if (typeof ex.answerValue === "number") return { cmp: "number", sql: `SELECT count(DISTINCT ${key}) AS n FROM ${from}${where}`, params: q.params };
    if (ex.answerValue && typeof ex.answerValue === "object" && Object.keys(ex.answerValue).length > 30) return null;
    // Items carry the count ("Mesa|13") only when the question asks for counts; a bare "which brands / what zips" is names only.
    const withCounts = /\b(?:how many|count|counts|per|breakdown|group|grouped|number of|by)\b/i.test(text);
    return { cmp: "set", sql: `SELECT ${withCounts ? "k || '|' || n" : "k"} AS item FROM (SELECT ${key} AS k, count(*) AS n FROM ${from}${where} GROUP BY 1) g WHERE k IS NOT NULL ORDER BY n DESC, k`, params: q.params };
  }
  if (isYesNo) return { cmp: "yesno", sql: `SELECT EXISTS (SELECT 1 FROM ${from}${where}) AS v`, params: q.params };
  // "Which customers ..." is a list. A list the bank knows is long stays a count; one with no known size is graded as a list and skipped at run time if it is too long to chat.
  if (ent === "customers" && wantsList && (typeof ex.answerValue === "number" ? ex.answerValue <= 25 : true)) {
    return { cmp: "set", ...(typeof ex.answerValue === "number" ? {} : { maxItems: 25 }), sql: `SELECT c.data->>'customer_name' AS item FROM ${from}${where} ORDER BY 1`, params: q.params };
  }
  if (wantsList && ent !== "customers") return null;
  return { cmp: "number", sql: `SELECT count(*) AS n FROM ${from}${where}`, params: q.params };
}

/* ------------------------------------------------------------------ subjects (a named customer or an address) */
const NOT_NAMES = new Set(["account", "unit", "job", "system", "customer", "the", "a", "an", "us", "me", "file", "record", "records"]);
const esc = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

function subjectOf(text) {
  const a = /\b(\d{1,5}\s+(?:[NSEW]\s+)?[A-Za-z0-9.]+(?:\s+[A-Za-z0-9.]+){0,2}?\s(?:St|Ave|Rd|Dr|Blvd|Ln|Way|Ct|Pkwy|Hwy|Cir|Pl)\b)(?:\.?,?\s*((?:Apt|Apartment|Suite|Ste|Unit|#)\.?\s*[A-Za-z0-9-]+))?/i.exec(text);
  if (a) return { kind: "addr", value: a[1].replace(/\s+/g, " ").trim(), ...(a[2] ? { unit: a[2].replace(/\s+/g, " ").trim() } : {}) };
  const full = /\b(?:for|of|on file for|about)\s+(?:the\s+)?([A-Za-z][A-Za-z'.-]+\s+[A-Za-z][A-Za-z'.-]+)\s*\??$/i.exec(text.trim());
  if (full && !NOT_NAMES.has(full[1].split(" ")[1].toLowerCase()) && !NOT_NAMES.has(full[1].split(" ")[0].toLowerCase())) return { kind: "name", value: full[1] };
  const poss = /\b([A-Z][a-z]{2,})['’]s\b/.exec(text);
  if (poss) return { kind: "name", value: poss[1] };
  const the = /\b(?:the|for|on|at)\s+([A-Z][a-z]{2,})\s+(?:unit|account|job|system|install|equipment|proposal)\b/.exec(text);
  if (the) return { kind: "name", value: the[1] };
  const tail = /\b(?:for|of|on|at)\s+([A-Z][a-z]{2,})\s*\??$/.exec(text.trim());
  if (tail && !NOT_NAMES.has(tail[1].toLowerCase())) return { kind: "name", value: tail[1] };
  const lower = /\b(?:for|of)\s+([a-z]{3,}(?:\s+[a-z]{3,})?)\s*\??$/.exec(text.trim());
  if (lower && !NOT_NAMES.has(lower[1].split(" ")[0])) return { kind: "name", value: lower[1] };
  return null;
}

/** SQL fragments for a subject. Returns {req, docs, equip} with the shared ILIKE param already bound. */
function subjectSql(s, q) {
  // An address with an Apt/Suite/Unit means THAT unit: "3300 S Alma School Rd, Apt 104" must not fold in the other apartments of the complex.
  const pat = s.kind === "addr" ? q.p(s.unit ? `${esc(s.value)}%${esc(s.unit)}%` : `${esc(s.value)}%`) : q.p(`%${esc(s.value)}%`);
  if (s.kind === "addr") {
    return {
      pat,
      req: `SELECT count(*) AS n FROM entities x WHERE x.merged_into IS NULL AND x.data->>'service_address' ILIKE ${pat}`,
      docs: `SELECT l.document_id FROM document_entity_links l JOIN entities x ON x.id = l.entity_id WHERE x.data->>'service_address' ILIKE ${pat}
             UNION SELECT y.document_id FROM extractions y WHERE y.field_key = 'service_address' AND y.value ILIKE ${pat}`,
      equip: `SELECT e.id FROM ${EQUIP} AND e.data->>'service_address' ILIKE ${pat}`,
      cust: `SELECT c.id FROM entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE ${pat}`,
    };
  }
  const custs = `SELECT c.id FROM entities c WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.data->>'customer_name' ILIKE ${pat}`;
  return {
    pat,
    req: `SELECT count(*) AS n FROM entities x WHERE x.entity_type = 'customer' AND x.merged_into IS NULL AND x.data->>'customer_name' ILIKE ${pat}`,
    // documents ABOUT the customer: linked to the customer or to one of its units
    docs: `SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (${custs})
           UNION SELECT l.document_id FROM document_entity_links l JOIN entities e ON e.id = l.entity_id WHERE e.entity_type = 'equipment' AND e.customer_id IN (${custs})`,
    equip: `SELECT e.id FROM ${EQUIP} AND e.customer_id IN (${custs})`,
    cust: custs,
  };
}
const requiresOf = (sub, q) => ({ sql: sub.req, params: q.params.slice(0, 1) });

/* ------------------------------------------------------------------ text-driven families */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function windowOf(text, q) {
  const t = text.toLowerCase();
  const T = q.today();
  if (/\bthis month\b/.test(t)) return { start: `date_trunc('month', ${T})::date`, end: `(date_trunc('month', ${T}) + interval '1 month')::date` };
  if (/\blast month\b/.test(t)) return { start: `(date_trunc('month', ${T}) - interval '1 month')::date`, end: `date_trunc('month', ${T})::date` };
  if (/\b(?:this year|year to date|ytd)\b/.test(t)) return { start: `date_trunc('year', ${T})::date`, end: `(date_trunc('year', ${T}) + interval '1 year')::date` };
  const m = new RegExp(`\\b(?:in|during|for)\\s+(${MONTHS.join("|")})\\b`).exec(t);
  if (m) {
    const n = MONTHS.indexOf(m[1]) + 1;
    const start = `make_date(CASE WHEN ${n} > EXTRACT(MONTH FROM ${T})::int THEN EXTRACT(YEAR FROM ${T})::int - 1 ELSE EXTRACT(YEAR FROM ${T})::int END, ${n}, 1)`;
    return { start, end: `(${start} + interval '1 month')::date` };
  }
  return null;
}

const SVC_DATE = `(SELECT max(${ISO("y.value")}) FROM extractions y WHERE y.field_key = 'service_date' AND y.document_id = d.id)`;
const DOC_DATE = `COALESCE(${SVC_DATE}, d.created_at::date)`;

const FAM = {};

/** unsupported / not-tracked -> honest-zero with a data guard so the question retires itself when the data appears */
FAM.money = () => {
  const q = new Q();
  return { cmp: "honest-zero", sql: `SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '(financ|ledger)'`, params: q.params };
};
FAM.compressor = () => ({ cmp: "honest-zero", sql: `SELECT count(*) AS n FROM document_pages WHERE text ILIKE '%compressor%'`, params: [] });
FAM.filterSize = () => ({ cmp: "honest-zero", sql: `SELECT count(*) AS n FROM document_pages WHERE text ILIKE '%filter size%' OR text ILIKE '%filter:%'`, params: [] });

function contactLookup(text) {
  const s = subjectOf(text);
  if (!s || s.kind !== "name") return null;
  const q = new Q(); const sub = subjectSql(s, q);
  const col = /e-?mail/i.test(text) ? "email" : "phone";
  return { cmp: "value", sql: `SELECT c.data->>'${col}' AS v FROM entities c WHERE c.id IN (${sub.cust}) AND coalesce(c.data->>'${col}', '') <> ''`, params: q.params, requires: requiresOf(sub, q) };
}
function unitField(field, text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q);
  // An installation date printed on one of the customer's documents is "on file" too (adjudicated: the unit record alone was too narrow).
  const fromDocs = field === "installation_date" ? ` UNION SELECT y.value AS v FROM extractions y WHERE y.field_key = 'installation_date' AND coalesce(y.value, '') <> '' AND y.document_id IN (${sub.docs})` : "";
  return { cmp: "value", sql: `SELECT e.data->>'${field}' AS v FROM entities e WHERE e.id IN (${sub.equip}) AND coalesce(e.data->>'${field}', '') <> ''${fromDocs}`, params: q.params, requires: requiresOf(sub, q) };
}
function unitAge(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q); const T = q.today();
  const yr = installYear("e");
  // accepted: the install date itself, or the age in whole years (either side of the birthday)
  return {
    cmp: "value",
    sql: `SELECT v FROM (SELECT e.data->>'installation_date' AS v FROM entities e WHERE e.id IN (${sub.equip}) UNION SELECT (EXTRACT(YEAR FROM ${T})::int - ${yr})::text FROM entities e WHERE e.id IN (${sub.equip}) UNION SELECT (EXTRACT(YEAR FROM ${T})::int - ${yr} - 1)::text FROM entities e WHERE e.id IN (${sub.equip})) z WHERE v IS NOT NULL`,
    params: q.params, requires: requiresOf(sub, q),
  };
}
function unitWarranty(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q);
  return { cmp: "value", sql: `SELECT ${wstatus("e", q)} AS v FROM entities e WHERE e.id IN (${sub.equip})`, params: q.params, requires: requiresOf(sub, q) };
}
function invoiceCount(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q);
  const inv = `${DOCTYPE("d.document_type")} = 'invoice'`;
  return {
    cmp: "number", sql: `SELECT count(*) AS n FROM documents d WHERE ${inv} AND d.id IN (${sub.docs})`, params: q.params, requires: requiresOf(sub, q),
    // A surname that matches several customers (two Delgados) is ambiguous: an answer about ONE of them is right if it names which.
    alt: { sql: `SELECT (SELECT count(DISTINCT l.document_id) FROM document_entity_links l JOIN documents d ON d.id = l.document_id LEFT JOIN entities e ON e.id = l.entity_id
      WHERE ${inv} AND (l.entity_id = c.id OR e.customer_id = c.id)) AS n, lower(c.data->>'customer_name') AS says FROM entities c WHERE c.id IN (${sub.cust})`, params: q.params },
  };
}
function docExists(text) {
  const t = text.toLowerCase();
  const type = /maintenance (?:agreement|plan)/.test(t) ? "maintenance-agreement" : /\bpermit\b/.test(t) ? "permit" : /\b(?:po|purchase order)\b/.test(t) ? "purchase-order"
    : /nameplate/.test(t) ? "nameplate-photo" : /startup/.test(t) ? "startup-sheet" : /warranty registration/.test(t) ? "warranty-registration" : /proposal|quote/.test(t) ? "proposal-quote" : null;
  const s = subjectOf(text); if (!type || !s) return null;
  const q = new Q(); const sub = subjectSql(s, q); const ty = q.p(DOCTYPE_ALIASES[type]);
  return { cmp: "yesno", sql: `SELECT EXISTS (SELECT 1 FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${ty}::text[]) AND d.id IN (${sub.docs})) AS v`, params: q.params, requires: requiresOf(sub, q) };
}
function lastService(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q); const T = q.today(); const vt = VISIT_SQL_ARR(q);
  // last service = the newest COMPLETED visit (a service-type document dated on or before today); a future date is a scheduled visit, never "last".
  return {
    cmp: "value",
    sql: `SELECT max(z.dt)::text AS v FROM (SELECT ${ISO("y.value")} AS dt FROM extractions y JOIN documents d ON d.id = y.document_id
      WHERE y.field_key = 'service_date' AND ${DOCTYPE("d.document_type")} = ANY(${vt}) AND y.document_id IN (${sub.docs})) z WHERE z.dt <= ${T}`,
    params: q.params, requires: requiresOf(sub, q),
  };
}
/** "how many times have we been to X" - visits = distinct completed service dates; a per-document count is accepted only if the answer says it counted documents. */
function visitCount(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q); const T = q.today(); const vt = VISIT_SQL_ARR(q);
  const base = (docs) => `FROM extractions y JOIN documents d ON d.id = y.document_id WHERE y.field_key = 'service_date' AND ${DOCTYPE("d.document_type")} = ANY(${vt}) AND ${ISO("y.value")} <= ${T} AND y.document_id IN (${docs})`;
  const perCust = `SELECT count(DISTINCT ${ISO("y.value")}) AS n, lower(c.data->>'customer_name') AS says FROM entities c JOIN document_entity_links l ON l.entity_id = c.id JOIN extractions y ON y.document_id = l.document_id JOIN documents d ON d.id = y.document_id
      WHERE c.id IN (${sub.cust}) AND y.field_key = 'service_date' AND ${DOCTYPE("d.document_type")} = ANY(${vt}) AND ${ISO("y.value")} <= ${T} GROUP BY c.id, c.data`;
  return {
    cmp: "number", sql: `SELECT count(DISTINCT ${ISO("y.value")}) AS n ${base(sub.docs)}`, params: q.params, requires: requiresOf(sub, q),
    alt: { sql: `SELECT count(DISTINCT y.document_id) AS n, 're:(documents?|tickets?|work orders?|records?|reports?|invoices?)' AS says ${base(sub.docs)} UNION ALL ${perCust}`, params: q.params },
  };
}
function installer(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q);
  // No structured "installed by" field exists; the installer is on file only if a document's own text says who installed it.
  return { cmp: "value", sql: `SELECT DISTINCT (regexp_match(p.text, '[Ii]nstall(?:ed|ation)?[[:space:]]+(?:was[[:space:]]+)?(?:performed[[:space:]]+|completed[[:space:]]+)?by:?[[:space:]]+([A-Z][a-z]+([[:space:]]+[A-Z][a-z]+)?)'))[1] AS v
    FROM document_pages p WHERE p.document_id IN (${sub.docs}) AND p.text ~ '[Ii]nstall(ed|ation)?[[:space:]]+(was[[:space:]]+)?(performed[[:space:]]+|completed[[:space:]]+)?by'`, params: q.params, requires: requiresOf(sub, q) };
}
function historyRubric(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q);
  return {
    cmp: "rubric", rubric: "Describes what the shop has on file for this customer or address (document types and service dates) without inventing any; if the reference is empty it says nothing is on file.",
    sql: `SELECT ${DOCTYPE("d.document_type")} || ' | ' || d.original_filename || ' | ' || coalesce(${SVC_DATE}::text, 'no service date') AS ref FROM documents d WHERE d.id IN (${sub.docs}) ORDER BY d.created_at DESC LIMIT 12`,
    params: q.params, requires: requiresOf(sub, q),
  };
}
// TEAM F (scorecard correctness, 2026-09-24): "last N visits at X" was previously routed into
// historyRubric() above - a generic "what's on file" summary graded against documents ordered by
// UPLOAD date. That rubric never says the answer must be N dated VISITS (not just any document), so
// a plausible-looking answer that was actually a file summary (or was ordered by the wrong date)
// could pass, and a genuinely correct "last 3 visits" answer could be graded against the wrong
// reference order and fail (R3_FAILS_2026-09-24: "last 3 visits at zimmerman's/quintana's - answers
// look plausible but graded fail"). Its own function + reference query, ordered by SERVICE date and
// filtered to visit-type documents only, same as lastService()/visitCount() already do.
function lastVisitsRubric(text) {
  const s = subjectOf(text); if (!s) return null;
  const nMatch = /\blast\s+(\d{1,2})\s+visits?\b/i.exec(text);
  const n = nMatch ? Math.max(1, Math.min(10, Number(nMatch[1]))) : 3;
  const q = new Q(); const sub = subjectSql(s, q); const vt = VISIT_SQL_ARR(q);
  return {
    cmp: "rubric",
    rubric: `Lists up to the ${n} most recent SERVICE VISITS (documents with a service_date) for this customer or address, newest first, each with its own date; if fewer than ${n} exist, lists what there is and says so. A generic file summary with no visit dates, or dates that do not match what is on record, does not answer this. Must not invent a visit or a date.`,
    citeWhat: "each visit it names",
    sql: `SELECT ${SVC_DATE}::text || ' | ' || ${DOCTYPE("d.document_type")} AS ref FROM documents d
          WHERE d.id IN (${sub.docs}) AND ${DOCTYPE("d.document_type")} = ANY(${vt}) AND ${SVC_DATE} IS NOT NULL
          ORDER BY ${SVC_DATE} DESC LIMIT ${n}`,
    params: q.params, requires: requiresOf(sub, q),
  };
}
function techJobs(text) {
  const nm = /\b(?:did|has)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:run|do|close|complete|make)/.exec(text);
  const q = new Q();
  const w = windowOf(text, q);
  if (!nm || !w) return null;
  const pat = q.p(`%${esc(nm[1])}%`);
  return {
    cmp: "number",
    sql: `SELECT count(DISTINCT t.document_id) AS n FROM extractions t JOIN extractions y ON y.document_id = t.document_id AND y.field_key = 'service_date' WHERE t.field_key = 'technician' AND t.value ILIKE ${pat} AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`,
    params: q.params, requires: { sql: `SELECT count(*) AS n FROM extractions t WHERE t.field_key = 'technician' AND t.value ILIKE $1`, params: [`%${esc(nm[1])}%`] },
  };
}
/** A completed job = a document with a service_date; its technician is the document's technician extraction. Per-tech counts are deterministic, so they are a SET ("Danny Ochoa|12"), not a model-graded rubric. */
const TECH_JOBS = (w) => `FROM extractions t JOIN extractions y ON y.document_id = t.document_id AND y.field_key = 'service_date' WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> ''${w ? ` AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}` : ""}`;
function techBreakdown(text) {
  const q = new Q(); const w = windowOf(text, q);
  const t = text.toLowerCase();
  if (/\b(?:most|fewest|least|busiest|top|best|highest|lowest)\b/.test(t)) {
    const dir = /\b(?:fewest|least|lowest)\b/.test(t) ? "ASC" : "DESC";
    return { cmp: "value", sql: `WITH g AS (SELECT t.value AS k, count(DISTINCT t.document_id) AS n ${TECH_JOBS(w)} GROUP BY t.value) SELECT k AS v FROM g WHERE n = (SELECT ${dir === "ASC" ? "min" : "max"}(n) FROM g)`, params: w ? q.params : [] };
  }
  return { cmp: "set", maxItems: 25, sql: `SELECT t.value || '|' || count(DISTINCT t.document_id) AS item ${TECH_JOBS(w)} GROUP BY t.value ORDER BY count(DISTINCT t.document_id) DESC, t.value`, params: w ? q.params : [] };
}
function timeCount(text) {
  const t = text.toLowerCase(); const q = new Q(); const w = windowOf(text, q);
  if (!w) return null;
  if (/\b(?:jobs?|service calls?|visits?)\b/.test(t)) {
    // a visit = one document + one service date (a duplicated extraction row is not a second visit)
    return { cmp: "number", sql: `SELECT count(DISTINCT y.document_id || ${ISO("y.value")}::text) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`, params: q.params };
  }
  const type = /\binvoices?\b/.test(t) ? "invoice" : /\b(?:quotes?|proposals?)\b/.test(t) ? "proposal-quote" : null;
  const ty = type ? ` AND ${DOCTYPE("d.document_type")} = ANY(${q.p(DOCTYPE_ALIASES[type])}::text[])` : "";
  // "added / uploaded / received" = the day it entered the system (created_at); anything else = the work date. When the wording is
  // ambiguous the OTHER reading is accepted, but only if the answer says which one it counted.
  const upload = /\b(?:add|added|adds|uploaded|upload|received|scanned|imported)\b/.test(t);
  const main = upload ? "d.created_at::date" : DOC_DATE;
  const other = upload ? DOC_DATE : "d.created_at::date";
  const count = (dateExpr) => `SELECT count(*) AS n FROM documents d WHERE ${dateExpr} >= ${w.start} AND ${dateExpr} < ${w.end}${ty}`;
  const says = upload ? "re:(service|work|visit|document) dates?|dated|by date|serviced|work performed" : "re:(upload|uploaded|added|created|entered)";
  return { cmp: "number", sql: count(main), params: q.params, alt: { sql: `${count(other).replace("SELECT count(*) AS n", `SELECT count(*) AS n, '${says}' AS says`)}`, params: q.params } };
}
function serviced(text) {
  const t = text.toLowerCase(); const q = new Q(); const w = windowOf(text, q);
  if (!w) return null;
  const base = `FROM extractions y JOIN document_entity_links l ON l.document_id = y.document_id JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`;
  if (/\bunits?\b|\bequipment\b/.test(t)) {
    return { cmp: "rubric", rubric: "Lists the units/equipment (or their customers) serviced in the period, consistent with the reference; says so plainly if none.", sql: `SELECT DISTINCT c.data->>'customer_name' AS ref ${base} LIMIT 25`, params: q.params };
  }
  if (/\bcustomers?\b/.test(t)) return { cmp: "set", sql: `SELECT DISTINCT c.data->>'customer_name' AS item ${base}`, params: q.params };
  return null;
}
function overdueRubric() {
  const q = new Q(); const T = q.today(); const vt = VISIT_SQL_ARR(q);
  return {
    cmp: "rubric", rubric: "Names customers whose most recent completed service visit was more than 12 months ago, consistent with the reference (the reference is the first 15 such customers; naming other customers is fine only if their last visit is also older than 12 months). Must not list customers with a visit in the last 12 months, and must not invent dates. Describing what an agreement covers is not an answer.",
    sql: `SELECT c.data->>'customer_name' || ' | last service ' || max(v.dt)::text AS ref FROM entities c JOIN (SELECT l.entity_id, ${ISO("y.value")} AS dt FROM document_entity_links l JOIN documents d ON d.id = l.document_id JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date'
      WHERE ${DOCTYPE("d.document_type")} = ANY(${vt})) v ON v.entity_id = c.id AND v.dt <= ${T} WHERE c.entity_type = 'customer' AND c.merged_into IS NULL GROUP BY c.id, c.data HAVING max(v.dt) < ${T} - 365 ORDER BY 1 LIMIT 15`,
    params: q.params,
  };
}
function extremeUnit(text) {
  const t = text.toLowerCase();
  const dir = /oldest/.test(t) ? "ASC" : /newest|latest|most recent/.test(t) ? "DESC" : null;
  if (!dir) return null;
  return {
    cmp: "value",
    sql: `SELECT v FROM (SELECT e.data->>'serial_number' AS v, ${installYear("e")} AS y FROM ${EQUIP} AND ${installYear("e")} IS NOT NULL AND coalesce(e.data->>'serial_number','') <> '' ORDER BY ${installYear("e")} ${dir} LIMIT 3) z`,
    params: [],
  };
}
function notesRubric(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q);
  return {
    cmp: "rubric", rubric: "Reports notes/observations that actually appear in the customer's documents, consistent with the reference; says nothing is on file if the reference is empty. Must not invent notes.",
    sql: `SELECT left(regexp_replace(p.text, '[[:space:]]+', ' ', 'g'), 200) AS ref FROM document_pages p WHERE p.document_id IN (${sub.docs}) AND p.text ~* '(note|comment|remark|observ|recommend)' ORDER BY p.created_at DESC LIMIT 6`,
    params: q.params, requires: requiresOf(sub, q),
  };
}

/** "Do we have more invoices or more service tickets?" -> a small rubric over the two types' counts. */
const MORE_TYPES = [
  [/\binvoices?\b/, ["invoice"], ["invoice", "invoices"]], [/\b(?:service )?tickets?\b|\bservice (?:calls?|reports?)\b/, ["service-ticket", "service-report"], ["service ticket", "service tickets", "ticket", "tickets"]],
  [/\bwork orders?\b/, ["work-order"], ["work order", "work orders"]], [/\bpermits?\b/, ["permit"], ["permit", "permits"]],
  [/\b(?:quotes?|proposals?)\b/, ["proposal-quote", "proposal", "quote"], ["quote", "quotes", "proposal", "proposals"]], [/\b(?:maintenance )?agreements?\b|\bmaintenance plans?\b/, ["maintenance-agreement", "maintenance-plan"], ["agreement", "agreements", "maintenance agreement", "maintenance agreements"]],
  [/\b(?:purchase orders?|pos)\b/, ["purchase-order"], ["purchase order", "purchase orders", "po", "pos"]], [/\bwarranty (?:registrations?|cards?)\b/, ["warranty-registration", "warranty"], ["warranty registration", "warranty registrations", "warranty"]],
];
function moreOf(text) {
  const m = /\bmore\s+(.+?)\s+or\s+(?:more\s+)?(.+?)(?:\s+(?:on file|do we have|in the system))?\s*\??$/i.exec(text.trim());
  if (!m) return null;
  const side = (frag) => MORE_TYPES.find(([re]) => re.test(frag.toLowerCase()));
  const a = side(m[1]); const b = side(m[2]);
  if (!a || !b || a === b) return null;
  const q = new Q(); const pa = q.p([...a[1], ...b[1]]);
  return {
    cmp: "rubric", rubric: "Says which of the two document types the shop has MORE of (or that they are tied), consistent with the reference counts. Naming the wrong one, or a non-answer, fails.",
    sql: `SELECT k || ': ' || n || ' documents' AS ref FROM (SELECT ${DOCTYPE("d.document_type")} AS k, count(*) AS n FROM documents d WHERE ${DOCTYPE("d.document_type")} = ANY(${pa}::text[]) GROUP BY 1) g ORDER BY n DESC`, params: q.params,
  };
}

/* ------------------------------------------------------------------ classification */
const isMoney = (e, t) => e.category === "money" || e.expect?.conditionsOnly?.includes("money") || /financials layer|invoice totals/.test(e.expect?.note ?? "")
  || /\$|\b(?:revenue|owed?|unpaid|collected|billed|invoiced|dollar|ticket size|amount we)\b/i.test(t);

/** @returns {{cmp, sql, params, requires?, rubric?} | null}  (exported for scripts/verify-scorecard.mjs) */
export function classify(entry) {
  const text = entry.text;
  const ex = entry.expect ?? {};
  const t = text.toLowerCase();

  if (isMoney(entry, text)) return FAM.money();
  if (/\bmore\b.+\bor\b/.test(t) && ex.groupBy === "documentType") return moreOf(text);
  if (/compressor/.test(t) && /replac/.test(t)) return FAM.compressor();
  if (/filter size|filter change/.test(t) && ex.unsupported) return FAM.filterSize();
  if (/(overdue|due for|tune-?up|haven'?t had|not had service|next filter|fall maintenance)/.test(t) && !ex.filters) return overdueRubric();

  if (ex.route === "analytics" && ex.entity === "serviceVisits") {
    if (ex.filters?.some((f) => f.field === "technician")) return techJobs(text);
    if (/\btech(?:nician)?s?\b/.test(t) || /\b(?:who|which)\b.*\b(?:most|fewest)\b/.test(t)) return techBreakdown(text);
    return serviced(text) ?? timeCount(text);
  }
  if (ex.route === "analytics" && ex.entity === "documents" && ex.timeRange !== undefined && !ex.groupBy) {
    const r = timeCount(text);
    if (r) return r;
  }
  if (ex.route === "analytics" && ex.entity && ex.unsupported !== true) {
    const a = buildAnalytics(entry, text);
    if (a) return a;
  }
  if (ex.route === "analytics") return null;

  // ---- lookup / retrieval style
  if (/\b(?:phone|ph#|phone numbr|email|e-mail)\b/.test(t)) return contactLookup(text);
  if (/\bserial\b/.test(t)) return unitField("serial_number", text);
  if (/\binstalled\b.*\b(?:when|date)\b|\bwhen was\b.*\binstalled\b|install date/.test(t)) return unitField("installation_date", text);
  if (/\bwho installed\b/.test(t)) return installer(text);
  if (/\b(?:who makes|what brand|manufacturer|make of)\b/.test(t)) return unitField("manufacturer", text);
  if (/\bwhat model\b|\bmodel (?:is|of)\b/.test(t)) return unitField("model", text);
  if (/\btonnage\b/.test(t)) return unitField("tonnage", text);
  if (/\brefrigerant\b/.test(t)) return unitField("refrigerant", text);
  if (/\bhow old\b/.test(t)) return unitAge(text);
  if (/\bwarranty\b/.test(t) && /\b(?:under|in warranty|still|status|active|expired|covered)\b/.test(t)) return unitWarranty(text);
  if (/\b(?:oldest|newest|latest)\b.*\bunit/.test(t) || /\bunit\b.*\b(?:oldest|newest)\b/.test(t)) return extremeUnit(text);
  if (/\binvoices?\b/.test(t) && /\b(?:list|show|all|for)\b/.test(t) && !/\bdo we have\b/.test(t)) return invoiceCount(text);
  if (/\b(?:do we have|did we|does .+ have|is there|show me the)\b/.test(t) && /(maintenance (?:agreement|plan)|permit|\bpo\b|purchase order|nameplate|startup|warranty registration|proposal|quote)/.test(t)) return docExists(text);
  if (/\b(?:when did we last|last service|when were we last|last time we)\b/.test(t)) return lastService(text);
  if (/\bhow many times (?:have|did) we (?:been|gone|visited|serviced)\b|\bhow many (?:visits|service calls|jobs) (?:have we|did we|at|to|for)\b/.test(t)) return visitCount(text);
  if (/\blast\s+\d{1,2}\s+visits?\b/.test(t)) return lastVisitsRubric(text);
  if (/\b(?:what do we have on file|last service ticket|how many times have we been|visits at|history)\b/.test(t)) return historyRubric(text);
  if (/\bnotes?\b/.test(t)) return notesRubric(text);
  return null;
}

/* ------------------------------------------------------------------ selection */
function main() {
  const bank = JSON.parse(readFileSync(BANK, "utf8"));
  const byBase = new Map();
  for (const e of bank) { if (!byBase.has(e.base)) byBase.set(e.base, {}); byBase.get(e.base)[e.variant] = e; }
  const canon = bank.filter((e) => e.variant === "canonical" && e.text.length <= 240);

  const questions = [];
  const seenText = new Set();
  const unclassified = {};
  for (const cat of Object.keys(QUOTA).sort()) {
    const pool = canon.filter((e) => e.category === cat).sort((a, b) => a.id.localeCompare(b.id));
    const classed = [];
    for (const e of pool) {
      const spec = classify(e);
      if (!spec) { unclassified[cat] = (unclassified[cat] ?? 0) + 1; continue; }
      const fam = `${spec.cmp}:${spec.sql.replace(/\$\d+|'[^']*'|\d+/g, "?").slice(0, 60)}`;
      classed.push({ e, spec, fam });
    }
    // round-robin across query "families" so a category is not 26 copies of one shape; inside a family the order is a
    // deterministic hash of the id (an even spread over the bank, stable across runs)
    const fams = new Map();
    for (const c of classed) { if (!fams.has(c.fam)) fams.set(c.fam, []); fams.get(c.fam).push(c); }
    const h = (c) => createHash("sha1").update(c.e.id).digest("hex");
    const lists = [...fams.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([, l]) => l.sort((x, y) => h(x).localeCompare(h(y))));
    const chosen = [];
    for (let round = 0; chosen.length < QUOTA[cat] && lists.some((l) => l.length > round); round++) {
      for (const l of lists) { if (chosen.length < QUOTA[cat] && l[round]) chosen.push(l[round]); }
    }
    chosen.forEach((c, i) => {
      const variants = ["canonical"];
      if (i % VARIANT_EVERY === 0) variants.push("typo", "abbreviated");
      for (const v of variants) {
        const entry = byBase.get(c.e.base)?.[v];
        if (!entry || entry.text.length > 280) continue;
        const key = entry.text.trim().toLowerCase();
        if (seenText.has(key)) continue;
        seenText.add(key);
        const q = {
          id: entry.id, base: c.e.base, variant: v, category: cat, text: entry.text, cmp: c.spec.cmp,
          oracle: { sql: c.spec.sql.replace(/\s+/g, " ").trim(), params: c.spec.params, ...(c.spec.requires ? { requires: { sql: c.spec.requires.sql.replace(/\s+/g, " ").trim(), params: c.spec.requires.params } } : {}) },
        };
        if (c.spec.rubric) q.rubric = c.spec.rubric;
        if (c.spec.citeWhat) q.citeWhat = c.spec.citeWhat; // TEAM F: what the rubric grader must see cited (runner.js's gradeAnswer)
        if (c.spec.alt) q.oracle.alt = { sql: c.spec.alt.sql.replace(/\s+/g, " ").trim(), params: c.spec.alt.params };
        if (c.spec.maxItems) q.maxItems = c.spec.maxItems;
        if (entry.persona) q.persona = entry.persona;
        questions.push(q);
      }
    });
  }

  // BREADTH: the hand-written categories the bank lacks (financials, document content, semantic paraphrase, multi-hop, trends,
  // rankings, technician performance, data quality, existence, explain, personas). See test-docs/scorecard/breadth.mjs.
  const kit = { Q, ISO, DOCTYPE, DOCTYPE_ALIASES, GEO, EQUIP, wstatus, installYear, esc, subjectSql, VISIT_TYPES, MONTHS };
  const breadth = breadthQuestions(kit);
  // a bank question with the same wording as a breadth one (the retiring "money" honest-zeros) yields to the real one
  const breadthText = new Set(breadth.map((b) => b.text.trim().toLowerCase()));
  for (let i = questions.length - 1; i >= 0; i--) if (breadthText.has(questions[i].text.trim().toLowerCase())) questions.splice(i, 1);
  for (const b of breadth) questions.push(b);

  const rubric = questions.filter((q) => q.cmp === "rubric").length;
  const byCat = {}; const byCmp = {};
  for (const q of questions) { byCat[q.category] = (byCat[q.category] ?? 0) + 1; byCmp[q.cmp] = (byCmp[q.cmp] ?? 0) + 1; }
  const body = JSON.stringify(questions);
  const version = `2026-09-24.${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
  const doc = {
    version,
    note: "GENERATED by scripts/gen-scorecard.mjs from test-docs/question-bank/bank.json - do not edit by hand. Each question's oracle is SQL over the base tables; see the generator header.",
    counts: { total: questions.length, byCategory: byCat, byComparison: byCmp },
    questions,
  };

  // contract checks
  const problems = [];
  if (questions.length < 480 || questions.length > 800) problems.push(`total ${questions.length} outside 480..800`);
  if (breadth.length < 200) problems.push(`breadth questions ${breadth.length} < 200`);
  for (const cat of BREADTH_CATEGORIES) if (!breadth.some((b) => b.category === cat)) problems.push(`breadth category with no questions: ${cat}`);
  if (rubric / questions.length > RUBRIC_CAP) problems.push(`rubric ${rubric}/${questions.length} exceeds ${RUBRIC_CAP * 100}%`);
  for (const cat of Object.keys(QUOTA)) if (!byCat[cat]) problems.push(`category with no questions: ${cat}`);
  if (new Set(questions.map((q) => q.id)).size !== questions.length) problems.push("duplicate ids");
  for (const q of questions) {
    if (!/^\s*(?:with|select)\b/i.test(q.oracle.sql)) problems.push(`${q.id}: oracle is not a SELECT`);
    const need = Math.max(0, ...[...q.oracle.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    if (need !== q.oracle.params.length) problems.push(`${q.id}: oracle uses ${need} params but binds ${q.oracle.params.length}`);
    if (q.oracle.alt) {
      const an = Math.max(0, ...[...q.oracle.alt.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      if (an !== q.oracle.alt.params.length) problems.push(`${q.id}: alt uses ${an} params but binds ${q.oracle.alt.params.length}`);
    }
    if (q.oracle.requires) {
      const rn = Math.max(0, ...[...q.oracle.requires.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      if (rn !== q.oracle.requires.params.length) problems.push(`${q.id}: requires uses ${rn} params but binds ${q.oracle.requires.params.length}`);
    }
  }

  if (CHECK) {
    const onDisk = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
    if (!onDisk || onDisk.version !== version) problems.push(`exam.json is stale (disk ${onDisk?.version ?? "missing"} vs generated ${version}); run node scripts/gen-scorecard.mjs`);
    if (problems.length) { console.error(`gen-scorecard --check FAILED:\n - ${problems.join("\n - ")}`); process.exit(1); }
    console.log(`gen-scorecard --check ok: ${questions.length} questions, version ${version}`);
    return;
  }
  if (problems.length) { console.error(`gen-scorecard: contract problems:\n - ${problems.join("\n - ")}`); process.exitCode = 1; }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`wrote ${OUT}: ${questions.length} questions (${rubric} rubric = ${Math.round((rubric / questions.length) * 100)}%), version ${version}`);
  console.table(Object.keys(QUOTA).map((c) => ({ category: c, questions: byCat[c] ?? 0, unclassifiedInPool: unclassified[c] ?? 0 })));
  console.log("by comparison:", byCmp);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
