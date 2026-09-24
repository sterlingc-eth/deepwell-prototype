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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANK = join(ROOT, "test-docs", "question-bank", "bank.json");
const OUT = join(ROOT, "test-docs", "scorecard", "exam.json");
const CHECK = process.argv.includes("--check");

/* ------------------------------------------------------------------ quotas (bases per category) */
const QUOTA = {
  comparisons: 8, "counts-age": 5, "counts-brand": 8, "counts-docs": 12, "counts-geo": 12, "counts-warranty": 6,
  coverage: 5, "data-hygiene": 8, "follow-up": 4, history: 8, lists: 6,
  "live-misses-2026-09-21": 10, "live-misses-2026-09-21b": 4, "live-misses-2026-09-22": 12, "live-misses-2026-09-22b": 8,
  lookups: 26, "maintenance-due": 5, money: 6, notes: 8, technician: 5, time: 6, "two-condition": 12, warranty: 12, "yes-no": 5,
};
const VARIANT_EVERY = 3; // every 3rd selected base also gets its typo + abbreviated wording
const RUBRIC_CAP = 0.15;

/* ------------------------------------------------------------------ SQL building blocks */
const ADDR = (col) => col;
const CITY = (col) => `substring(${ADDR(col)} from ',[[:space:]]*([^,]+),[[:space:]]*[A-Z]{2}[[:space:]]+[0-9]{5}')`;
const STATE = (col) => `substring(${ADDR(col)} from ',[[:space:]]*([A-Z]{2})[[:space:]]+[0-9]{5}')`;
const ZIP = (col) => `substring(${ADDR(col)} from '([0-9]{5})(-[0-9]{4})?[[:space:]]*$')`;
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
function buildAnalytics(entry, text) {
  const ex = entry.expect ?? {};
  if (ex.unsupported || !["customers", "equipment", "warranties", "documents"].includes(ex.entity)) return null;
  const filters = ex.filters ?? [];
  const yrs = (/\b(\d+)\s+years?\b/i.exec(text) ?? [])[1];
  const yearsAgo = yrs ? Number(yrs) : null;
  const wantsList = /^\s*(?:which|who|who's|whos|list|give me|show|name)\b/i.test(text) && !/\bhow many\b/i.test(text);
  const isYesNo = typeof ex.answerValue === "boolean";
  const q = new Q();
  // "the top brand", "the busiest zip" answer one item, not the whole grouping; an unfiltered question with a time or
  // expiry qualifier ("expires in the next 90 days") is not something these structured filters can express.
  if (/\b(?:most|top|biggest|largest|highest|least|fewest|best)\b/i.test(text)) return null;
  if (!filters.length && !ex.groupBy && !(/\bhow many\b/i.test(text) && !/\b(?:next|this|last|since|days?|months?|years?|weeks?|quarter|expir|due|warrant|older|newer)\b/i.test(text))) return null;

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
  if (ent === "customers" && wantsList && typeof ex.answerValue === "number" && ex.answerValue <= 25) {
    return { cmp: "set", sql: `SELECT c.data->>'customer_name' AS item FROM ${from}${where} ORDER BY 1`, params: q.params };
  }
  if (wantsList && ent !== "customers") return null;
  return { cmp: "number", sql: `SELECT count(*) AS n FROM ${from}${where}`, params: q.params };
}

/* ------------------------------------------------------------------ subjects (a named customer or an address) */
const NOT_NAMES = new Set(["account", "unit", "job", "system", "customer", "the", "a", "an", "us", "me", "file", "record", "records"]);
const esc = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

function subjectOf(text) {
  const a = /\b(\d{1,5}\s+(?:[NSEW]\s+)?[A-Za-z0-9.]+(?:\s+[A-Za-z0-9.]+){0,2}?\s(?:St|Ave|Rd|Dr|Blvd|Ln|Way|Ct|Pkwy|Hwy|Cir|Pl)\b)/i.exec(text);
  if (a) return { kind: "addr", value: a[1].replace(/\s+/g, " ").trim() };
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
  const pat = s.kind === "addr" ? q.p(`${esc(s.value)}%`) : q.p(`%${esc(s.value)}%`);
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
    docs: `SELECT l.document_id FROM document_entity_links l WHERE l.entity_id IN (${custs})`,
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
  return { cmp: "value", sql: `SELECT e.data->>'${field}' AS v FROM entities e WHERE e.id IN (${sub.equip}) AND coalesce(e.data->>'${field}', '') <> ''`, params: q.params, requires: requiresOf(sub, q) };
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
  return { cmp: "number", sql: `SELECT count(*) AS n FROM documents d WHERE ${DOCTYPE("d.document_type")} = 'invoice' AND d.id IN (${sub.docs})`, params: q.params, requires: requiresOf(sub, q) };
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
  const q = new Q(); const sub = subjectSql(s, q);
  return { cmp: "value", sql: `SELECT max(${ISO("y.value")})::text AS v FROM extractions y WHERE y.field_key = 'service_date' AND y.document_id IN (${sub.docs})`, params: q.params, requires: requiresOf(sub, q) };
}
function installer(text) {
  const s = subjectOf(text); if (!s) return null;
  const q = new Q(); const sub = subjectSql(s, q);
  return { cmp: "value", sql: `SELECT y.value AS v FROM extractions y WHERE y.field_key = 'installed_by' AND coalesce(y.value, '') <> '' AND y.document_id IN (${sub.docs})`, params: q.params, requires: requiresOf(sub, q) };
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
function techRubric() {
  return {
    cmp: "rubric", rubric: "Gives per-technician job counts (or names the busiest technician) consistent with the reference, or honestly says the technician data is limited. A shorter period must not exceed the all-time reference totals.",
    sql: `SELECT t.value || ': ' || count(DISTINCT t.document_id) || ' jobs on file' AS ref FROM extractions t WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' GROUP BY t.value ORDER BY count(DISTINCT t.document_id) DESC LIMIT 12`, params: [],
  };
}
function timeCount(text) {
  const t = text.toLowerCase(); const q = new Q(); const w = windowOf(text, q);
  if (!w) return null;
  if (/\b(?:jobs?|service calls?|visits?)\b/.test(t)) {
    return { cmp: "number", sql: `SELECT count(*) AS n FROM extractions y WHERE y.field_key = 'service_date' AND ${ISO("y.value")} >= ${w.start} AND ${ISO("y.value")} < ${w.end}`, params: q.params };
  }
  const type = /\binvoices?\b/.test(t) ? "invoice" : /\b(?:quotes?|proposals?)\b/.test(t) ? "proposal-quote" : null;
  const ty = type ? ` AND ${DOCTYPE("d.document_type")} = ANY(${q.p(DOCTYPE_ALIASES[type])}::text[])` : "";
  const dateExpr = /\b(?:add|added|uploaded)\b/.test(t) ? "d.created_at::date" : DOC_DATE;
  return { cmp: "number", sql: `SELECT count(*) AS n FROM documents d WHERE ${dateExpr} >= ${w.start} AND ${dateExpr} < ${w.end}${ty}`, params: q.params };
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
  const q = new Q();
  return {
    cmp: "rubric", rubric: "Either lists customers whose most recent dated service is more than 12 months ago, consistent with the reference, or says plainly it cannot determine who is overdue. Must not invent customers or dates.",
    sql: `SELECT c.data->>'customer_name' || ' | last service ' || coalesce(max(${ISO("y.value")})::text, 'never') AS ref FROM entities c LEFT JOIN document_entity_links l ON l.entity_id = c.id LEFT JOIN extractions y ON y.document_id = l.document_id AND y.field_key = 'service_date' WHERE c.entity_type = 'customer' AND c.merged_into IS NULL GROUP BY c.id, c.data HAVING max(${ISO("y.value")}) IS NULL OR max(${ISO("y.value")}) < ${q.today()} - 365 ORDER BY 1 LIMIT 15`,
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

/* ------------------------------------------------------------------ classification */
const isMoney = (e, t) => e.category === "money" || e.expect?.conditionsOnly?.includes("money") || /financials layer|invoice totals/.test(e.expect?.note ?? "")
  || /\$|\b(?:revenue|owed?|unpaid|collected|billed|invoiced|dollar|ticket size|amount we)\b/i.test(t);

/** @returns {{cmp, sql, params, requires?, rubric?} | null}  (exported for scripts/verify-scorecard.mjs) */
export function classify(entry) {
  const text = entry.text;
  const ex = entry.expect ?? {};
  const t = text.toLowerCase();

  if (isMoney(entry, text)) return FAM.money();
  if (/compressor/.test(t) && /replac/.test(t)) return FAM.compressor();
  if (/filter size|filter change/.test(t) && ex.unsupported) return FAM.filterSize();
  if (/(overdue|due for|tune-?up|haven'?t had|not had service|next filter|fall maintenance)/.test(t) && !ex.filters) return overdueRubric();

  if (ex.route === "analytics" && ex.entity === "serviceVisits") {
    if (ex.filters?.some((f) => f.field === "technician")) return techJobs(text);
    if (/\btech(?:nician)?s?\b/.test(t) || /\b(?:who|which)\b.*\b(?:most|fewest)\b/.test(t)) return techRubric();
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
  if (/\b(?:what do we have on file|last \d+ visits|last service ticket|how many times have we been|visits at|history)\b/.test(t)) return historyRubric(text);
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
        questions.push(q);
      }
    });
  }

  const rubric = questions.filter((q) => q.cmp === "rubric").length;
  const byCat = {}; const byCmp = {};
  for (const q of questions) { byCat[q.category] = (byCat[q.category] ?? 0) + 1; byCmp[q.cmp] = (byCmp[q.cmp] ?? 0) + 1; }
  const body = JSON.stringify(questions);
  const version = `2026-09-23.${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
  const doc = {
    version,
    note: "GENERATED by scripts/gen-scorecard.mjs from test-docs/question-bank/bank.json - do not edit by hand. Each question's oracle is SQL over the base tables; see the generator header.",
    counts: { total: questions.length, byCategory: byCat, byComparison: byCmp },
    questions,
  };

  // contract checks
  const problems = [];
  if (questions.length < 260 || questions.length > 340) problems.push(`total ${questions.length} outside 260..340`);
  if (rubric / questions.length > RUBRIC_CAP) problems.push(`rubric ${rubric}/${questions.length} exceeds ${RUBRIC_CAP * 100}%`);
  for (const cat of Object.keys(QUOTA)) if (!byCat[cat]) problems.push(`category with no questions: ${cat}`);
  if (new Set(questions.map((q) => q.id)).size !== questions.length) problems.push("duplicate ids");
  for (const q of questions) {
    if (!/^\s*(?:with|select)\b/i.test(q.oracle.sql)) problems.push(`${q.id}: oracle is not a SELECT`);
    const need = Math.max(0, ...[...q.oracle.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    if (need !== q.oracle.params.length) problems.push(`${q.id}: oracle uses ${need} params but binds ${q.oracle.params.length}`);
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
