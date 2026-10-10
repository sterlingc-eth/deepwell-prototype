/**
 * R32b (Team A3, loop C): shop-wide AGGREGATE questions answered from the records with no model call.
 *
 *   warranty-extreme   "what's the earliest warranty expiration we have on file" / "latest Carrier warranty expiry"
 *   warranty-count     "how many units are not currently under warranty" / "how many York units have an expired warranty"
 *                      (out of warranty = end date before today; "still under warranty" = end date on or after today, shop-wide or per
 *                      brand — R35 owner decision 2026-10-01; "more than a year left" / "expire within a year" are their own buckets;
 *                      "how many customers ..." counts customers with at least one such unit)
 *   tech-never         "which technicians have never logged a preventive maintenance visit" (set difference over the visit documents)
 *   no-text-docs       "how many documents have no readable text extracted"
 *   history-skew       "has most of our service history happened before last year" (yes/no over dated service visits)
 *   date-extreme       "when was the first service visit on file" / "oldest unit installed" / "date of our most recent invoice"
 *   open-in-period     "any invoices from last quarter that are still open" (honest "no invoice carries a payment status" when that is true)
 *
 * Every shape is CLOSED: after the conversational frame is stripped, every word of the question must belong to that shape's own small
 * vocabulary (or be a manufacturer name found on a unit). Any other word - a customer name, an address, a city, a time we do not model -
 * means this file returns null and the question carries on down the normal chain. Nothing here ever guesses.
 *
 * pure: parseAggregate     db: runAggregate
 */
import { unframe } from "./unframe.js";
import { extractWindow } from "./dateQualifiers.js";
import { serviceType, resolveTechnician } from "./namedCompare.js";
import { attachCitations, documentRecord, unitRecord, customerRecord } from "../citations/records.js";
import { answerEnvelope, TENANT_SQL, todayIso } from "../scope.js";
import { formatDateHumanWithIso } from "../fastPath.js";
import { resolveAnyTimeRange } from "../analytics.js";
import { parseTemplate, runTemplate } from "./aggTemplates.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9'\s#-]/g, " ").replace(/\s+/g, " ").trim();
const words = (q) => q.split(/\s+/).filter(Boolean);

const GLUE = new Set(("a an the we our us i you it is are was were be been do does did has have had having what whats what's which who whose when where how many much number count of in on at for by to from with and or "
  + "that thats that's this these those there any all each every some please file files record records system on-file listed logged shown currently current right now still yet so far overall total ever just really actually").split(/\s+/));

/** Words a closed shape may contain besides GLUE (per shape). */
const V = {
  unit: ["unit", "units", "system", "systems", "equipment", "furnace", "furnaces", "ac", "acs", "heater", "heaters", "condenser", "condensers", "piece", "pieces", "hvac"],
  warranty: ["warranty", "warranties", "warrantied", "covered", "coverage", "cover", "uncovered"],
  expiry: ["expiration", "expirations", "expiry", "expiries", "expire", "expires", "expired", "expiring", "end", "ends", "ending", "date", "dates", "run", "runs", "out", "last", "lasts", "date"],
  early: ["earliest", "first", "oldest", "soonest-no"],
  late: ["latest", "last", "furthest", "farthest", "newest", "most", "distant", "far", "recent"],
  negwar: ["not", "no", "longer", "out", "under", "in", "active", "expired", "uncovered"],
  tech: ["their", "record", "records", "technician", "technicians", "tech", "techs", "crew", "guy", "guys", "staff", "team", "tecs", "employees", "employee", "worker", "workers", "who", "whom", "everyone", "anyone", "anybody"],
  never: ["never", "zero", "no", "haven't", "havent", "hasn't", "hasnt", "without", "not", "none", "once", "ever", "who've", "who", "who's", "whove", "they've", "theyve", "they", "ones"],
  logged: ["logged", "done", "worked", "handled", "run", "ran", "performed", "completed", "had", "got", "visit", "visits", "call", "calls", "job", "jobs", "work", "service", "services", "ticket", "tickets", "list", "show", "me", "give", "which", "names", "crew", "on"],
  stype: ["preventive", "preventative", "maintenance", "pm", "pms", "repair", "repairs", "tune-up", "tuneup", "tune-ups", "tuneups"],
  doc: ["document", "documents", "doc", "docs", "file", "files", "scan", "scans", "pdf", "pdfs", "page", "pages", "paperwork"],
  notext: ["return", "returned", "returns", "readable", "extracted", "text", "no", "without", "blank", "empty", "unreadable", "nothing", "came", "back", "with", "failed", "read", "could", "couldn't", "couldnt", "we", "ocr", "result", "results", "anything", "extractable"],
  history: ["service", "history", "visits", "visit", "calls", "work", "tickets", "jobs", "majority", "most", "half", "than", "more", "older", "predate", "predates", "before", "since", "after", "prior", "happened", "happen", "fall", "from", "start", "beginning", "year", "years", "calendar", "later", "rather", "instead", "two", "last", "recent", "recently", "dates", "dated", "date", "back", "go", "goes", "going", "occurred", "occur", "are", "within", "newer", "older"],
  extreme: ["happen", "happened", "happens", "earliest", "first", "oldest", "most", "recent", "latest", "newest", "last", "when", "date", "of", "service", "visit", "visits", "call", "calls", "install", "installed", "installation", "invoice", "invoices", "dated", "issued", "sent", "unit", "units", "system", "systems", "ever", "on", "record", "ticket"],
  open: ["invoice", "invoices", "bill", "bills", "open", "unpaid", "outstanding", "still", "from", "in", "during", "for", "that", "are", "is", "thats", "that's", "which", "any", "are", "there", "last", "this", "past", "quarter", "month", "week", "year", "ytd", "days", "day", "weeks", "months", "years", "90", "30", "60", "7", "14", "yet", "owed", "paid", "not", "q1", "q2", "q3", "q4", "unsettled", "pending", "no", "payment"],
};
const setOf = (...lists) => new Set(lists.flat());

function closed(q, vocab, brands = new Set()) {
  for (const w of words(q)) {
    const t = w.replace(/^'+|'+$/g, "");
    if (!t || GLUE.has(t) || vocab.has(t) || brands.has(t) || /^\d+$/.test(t)) continue;
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ parse */

/** Pure. @returns {kind, question, ...} or null. `question` may still carry a conversational frame. */
export function parseAggregate(question, opts = {}) {
  const hit = parseAggregateCore(question, opts);
  return hit ? { ...hit, question: norm(unframe(question)) } : null;
}

function parseAggregateCore(question, opts = {}) {
  const raw = norm(unframe(question));
  if (!raw || raw.length > 170) return null;
  const q = raw.replace(/\bunits'?\b/g, "units");
  const hasBrandWords = true; // brand tokens are admitted at run time (the DB knows the manufacturers); parse admits any single unknown word flagged below

  // --- R3 warrexp: units/warranties expiring in a named period (this/next year, in 2026, this/next month, Q4 ...). Kill switch DONOVAN_WARR_EXP=0.
  if (process.env.DONOVAN_WARR_EXP !== "0") { const wp = parseWarrPeriod(q); if (wp) return wp; }

  // --- warranty extreme: earliest / latest warranty expiration (never "soonest/next": that is a from-today reading)
  if (/\bwarrant(?:y|ies)\b/.test(q) && !/\bhow many\b|\bnumber of\b|\bcount\b/.test(q)) {
    const early = /\b(?:earliest|first|oldest)\b/.test(q);
    const late = /\b(?:latest|last|furthest|farthest|newest|most distant)\b/.test(q);
    if (early !== late && /\b(?:expir\w*|run(?:s)? out|ends?|end date)\b/.test(q)) {
      const vocab = setOf(V.warranty, V.expiry, V.early, V.late, V.unit, ["on", "file", "which", "what", "date", "of", "have"]);
      const unknown = words(q).filter((w) => !(GLUE.has(w) || vocab.has(w) || /^\d+$/.test(w)));
      if (unknown.length <= 2) return { kind: "warranty-extreme", dir: early ? "asc" : "desc", unknown, hasBrandWords };
    }
  }

  // --- warranty count: units out of / under warranty.
  // R35 (owner decision 2026-10-01): "still under warranty" (and active / current / valid / covered / in warranty) = NOT EXPIRED
  // (end date on or after today), shop-wide too; "more than a year left" is its own strict bucket; "expire within a year" its own.
  // "how many customers ..." counts customers with at least one such unit.
  // R35 loop 1: + "warrantied" / "in-warranty" / "expiring soon" / "no warranty on file" (unknown bucket); "covered by an agreement/plan" is not a warranty.
  if (/\b(?:how many|number of|count of|total)\b/.test(q) && /\b(?:units?|systems?|equipment|furnaces?|condensers?|heaters?|acs?|pieces?|warranties|customers?|clients?|accounts?)\b/.test(q) && /\b(?:warrant(?:y|ies|ied)|covered|coverage|in-warranty)\b/.test(q)
    && !/\b(?:agreements?|plans?|contracts?|memberships?|insurance|polic(?:y|ies)|subscriptions?|registrations?|registered|unregistered|claims?)\b/.test(q)) {
    const customers = /\b(?:customers?|clients?|accounts?)\b/.test(q);
    const overYear = /\b(?:more than|over|at least|longer than)\s+(?:a|one|another|1|12|twelve|365)\s*(?:full\s+)?(?:year|years|yr|yrs|months?|days?)\b|\bfor more than (?:another |a )?year\b|\bmore than a year from now\b/.test(q);
    const withinYear = !overYear && (/\b(?:expir\w*|run(?:s|ning)? out|end(?:s|ing)?|come off(?: warranty)?|lapse|lapsing)\b[^?]{0,40}\b(?:within|in|over)\s+(?:the\s+)?(?:next\s+)?(?:a|one|1|12|twelve|365)?\s*(?:year|yr|months?|days?)\b/.test(q)
      || /\b(?:expir(?:ing|es?)|run(?:s|ning)?\s+out|end(?:s|ing)?|lapsing|coming\s+off(?:\s+warranty)?)\s+soon\b|\babout\s+to\s+(?:expire|run\s+out|end|lapse|come\s+off)\b|\b(?:expir(?:ing|es?)|run(?:s|ning)?\s+out)\s+(?:in\s+)?the\s+next\s+(?:12|twelve)\s+months\b/.test(q));
    // "no warranty on file" / "unknown warranty" / "no warranty end date" — the units with no end date on file
    const unknownState = !overYear && !withinYear && /\b(?:no|without|missing|unknown|blank)\s+(?:a\s+)?(?:warranty\s+)?(?:warranty|end\s+date|expiration|expiry)(?:\s+(?:end\s+)?(?:date|info|information|status|on\s+file|listed|recorded))?\b|\b(?:don'?t|doesn'?t|do\s+not|does\s+not)\s+have\s+(?:a\s+)?warranty\s+(?:end\s+)?(?:date|info|information|on\s+file)\b|\bwarranty\s+(?:status\s+)?(?:is\s+)?unknown\b/.test(q)
      && /\b(?:on\s+file|end\s+date|date|info|information|unknown|missing|status|recorded|listed)\b/.test(q);
    const expired = !overYear && !withinYear && !unknownState && (/\bnot\s+(?:currently\s+|still\s+)?(?:warrantied|in-warranty|covered)\b|\bunwarrantied\b/.test(q) || /\bnot\s+(?:currently\s+|still\s+|presently\s+)?(?:under|in|covered\s+by|within)\s+(?:a\s+)?warranty\b|\bout\s+of\s+warranty\b|\b(?:have|has|with)\s+(?:an?\s+)?expired\s+warrant(?:y|ies)\b|\bwarrant(?:y|ies)\s+(?:has\s+|have\s+)?expired\b|\bno\s+longer\s+(?:covered|under|in)\b|\bexpired\s+warrant(?:y|ies)\b|\bwarranty\s+is\s+(?:over|up|done)\b|\bnot\s+covered\b|\buncovered\b/.test(q) || /\bnot\s+under\s+warranty\s+anymore\b/.test(q));
    const notExpiredWords = /\b(?:haven'?t|have\s+not|hasn'?t|has\s+not|not\s+yet|not)\s+(?:yet\s+)?(?:expired|run\s+out|lapsed|ended)\b|\bunexpired\b|\bnot\s+expired\b/.test(q);
    const active = !overYear && !withinYear && !unknownState && (notExpiredWords || (!expired && (/\b(?:are|is)\s+(?:currently\s+|still\s+)?(?:covered|warrantied|in-warranty)\b|\bwarrantied\b|\bin-warranty\b|\bin\s+coverage\b/.test(q) || /\b(?:still|currently|presently)?\s*(?:under|in|covered\s+by|covered\s+under|within)\s+(?:a\s+)?warranty\b|\bstill\s+(?:covered|have\s+(?:a\s+)?warranty|in\s+effect|good|valid|active)\b|\b(?:active|current|valid|open)\s+warrant(?:y|ies)\b|\bwarrant(?:y|ies)\s+(?:coverage|is\s+active|still\s+(?:active|good|valid|in\s+effect))\b|\bwarrant(?:y|ies)\s+(?:are|is)\s+still\s+(?:active|good|valid|in\s+effect)\b|\bhave\s+(?:an?\s+)?(?:active|valid)\s+warranty\b|\bwarranty\s+coverage\b|\bstill\s+covered\b/.test(q))));
    if (expired || active || overYear || withinYear || unknownState) {
      const vocab = setOf(V.unit, V.warranty, V.negwar, ["soon", "about", "to", "coming", "without", "missing", "unknown", "blank", "date", "info", "information", "status", "recorded", "listed",
        "expiration", "expiry", "don't", "dont", "doesn't", "doesnt", "do", "does", "in-warranty", "coverage", "right", "units'", "unit's", "system's", "systems'", "warranties'", "expired", "expire", "expires", "expiring", "still", "good", "valid", "active", "within", "covered", "by", "have", "has", "with", "is", "over", "up", "done", "currently", "of", "how", "many",
        "more", "than", "year", "years", "yr", "months", "month", "days", "left", "remaining", "another", "least", "longer", "twelve", "one", "next", "come", "off", "run", "runs", "out", "from", "now", "lapse", "lapsing",
        "haven't", "havent", "have", "not", "yet", "unexpired", "current", "open", "effect", "anymore", "today", "total", "customers", "customer", "clients", "client", "accounts", "account", "their", "a", "full", "under", "ends", "end", "ending", "under", "count"]);
      const unknown = words(q).filter((w) => /[a-z0-9]/.test(w) && !(GLUE.has(w) || vocab.has(w) || /^\d+$/.test(w)));
      const state = overYear ? "over-year" : withinYear ? "within-year" : unknownState ? "unknown" : expired ? "expired" : "active";
      // a time window ("expired so far this year", "in 2025", "last month") is a different question (when it expired), not this count
      const windowed = (state === "expired" || state === "active") && /\b(?:years?|months?|weeks?|days?|quarters?|ytd|since|during|before|after|\d{4})\b/.test(q);
      if (unknown.length <= 2 && !windowed) return { kind: "warranty-count", state, customers, unknown };
    }
  }

  // --- technicians who never did a service type
  if (/\b(?:never|zero|no|without|haven'?t|hasn'?t|not|none)\b/.test(q) && /\b(?:technicians?|techs?|crew|guys|staff|team|employees?|workers?|who)\b/.test(q) && !/\bhow many\b/.test(q)) {
    const types = [...new Set([...q.matchAll(/\b(preventive maintenance|preventative maintenance|pms?|repairs?|tune-?ups?)\b/g)].map((m) => serviceType(m[1] === "pms" ? "pm" : m[1])).filter(Boolean))];
    if (types.length === 1) {
      const vocab = setOf(V.tech, V.never, V.logged, V.stype, ["on", "file", "ones", "who", "any"]);
      if (closed(q, vocab)) return { kind: "tech-never", type: types[0] };
      // windowed: "which technicians never did a PM last year" -> no visit of that type dated inside the window (a window must resolve at run time)
      const TIME = ["last", "this", "past", "year", "month", "quarter", "week", "ytd", "days", "day", "weeks", "months", "years", "since", "in", "during", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "q1", "q2", "q3", "q4", "summer", "winter", "spring", "fall", "so", "far", "to", "date", "the", "start", "of", "beginning"];
      if (closed(q, setOf([...vocab], TIME)) && /\b(?:year|month|quarter|week|ytd|days?|weeks|months|years|since|during|january|february|march|april|may|june|july|august|september|october|november|december|q[1-4])\b/.test(q)) return { kind: "tech-never", type: types[0], windowed: true };
    }
  }

  // --- R3 techlist: "list the techs" / "who are our technicians" -> the roster with job counts. Kill switch DONOVAN_TECH_LIST=0.
  if (process.env.DONOVAN_TECH_LIST !== "0" && !/\d/.test(q) && !/\b(?:how many|number|count|total|most|fewest|never)\b/.test(q) && /\b(?:tech|techs|technicians?|technicans?|techncians?|technitians?|roster)\b/.test(q)) {
    const vocab = setOf(["list", "lst", "lists", "show", "me", "name", "names", "give", "roster", "tech", "techs", "technician", "technicians", "technican", "technicans", "techncian", "techncians", "technitian", "technitians", "guys", "crew", "staff", "field", "work", "works", "working", "employ", "employed", "available", "tell", "see", "display", "all", "every", "complete", "full", "whos", "can", "you", "could", "who's", "s"]);
    if (closed(q, vocab)) return { kind: "tech-list" };
  }

  // --- technician extremes over every technician row: "who has done the most jobs overall" / "who has the fewest jobs on file"
  if (/\b(?:most|highest|fewest|least|lowest)\b/.test(q) && /\b(?:jobs?|visits?|calls?|tickets?|job count|visit count)\b/.test(q) && /\b(?:who|which\s+(?:tech|technician|guy|one))\b/.test(q) && !/\b(?:year|month|week|quarter|today|yesterday|this|last|customers?|different|ytd|summer|winter|spring|fall|q[1-4])\b/.test(q)) {
    const vocab = setOf(["who's", "whos", "technician", "technicians", "tech", "techs", "guy", "one", "who", "which", "done", "logged", "worked", "run", "has", "have", "most", "highest", "fewest", "least", "lowest", "jobs", "job", "visits", "visit", "calls", "call", "tickets", "ticket", "count", "overall", "number", "of", "on", "file", "ever", "crew", "our", "the", "ve", "s"]);
    // R3 nameyear: "which tech did the most calls in 2012" must apply the year (a bare number used to be ignored as glue). Kill switch DONOVAN_NAME_YEAR=0.
    const win = process.env.DONOVAN_NAME_YEAR === "0" ? null : extractWindow(q);
    const dirOf = /\b(?:fewest|least|lowest)\b/.test(q) ? "asc" : "desc";
    if (win && closed(win.rest, vocab)) return { kind: "tech-extreme", dir: dirOf, ...ticketScope(q), window: { from: win.from, to: win.to, label: win.label, open: !!win.open, range: !!win.range } };
    if (!win && closed(q, vocab) && !(process.env.DONOVAN_NAME_YEAR !== "0" && /\b(?:19|20)\d\d\b/.test(q))) return { kind: "tech-extreme", dir: dirOf, ...ticketScope(q) };
  }

  // --- per-technician typed count: "repair count for Danny Ochoa" / "PM count for Denise Ford"
  { const m = /^(repair|repairs|pm|pms|preventive maintenance|preventative maintenance)\s+(?:visit\s+|call\s+|job\s+)?count\s+(?:for|by|on)\s+([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*)?)$/.exec(q);
    if (m) { const t = serviceType(m[1] === "pms" ? "pm" : m[1]); if (t) return { kind: "tech-typed-count", type: t, name: m[2] }; } }

  // --- documents with no readable text
  if (/\b(?:how many|number of|count of)\b/.test(q) && /\b(?:documents?|docs?|files?|scans?|pdfs?|pages?)\b/.test(q) && /\b(?:no|without|blank|empty|unreadable|nothing|couldn'?t read|could not read|failed)\b/.test(q) && /\b(?:text|readable|ocr|extract\w*|read)\b/.test(q)) {
    if (closed(q, setOf(V.doc, V.notext, ["on", "any", "page", "pages", "anything"]))) return { kind: "no-text-docs" };
  }

  // --- history skew: most of our service history before / since last year
  if (/\b(?:most|majority|more than half|over half|half)\b/.test(q) && /\b(?:service|visits?|calls?|history|work|jobs?|tickets?)\b/.test(q) && /\blast (?:year|two calendar years)|the last two calendar years|\blast year or later\b/.test(q)) {
    if (closed(q, setOf(V.history))) {
      const sinceish = /\bsince\b|\bor later\b|\blast two calendar years\b|\bfrom last year\b|\bin the last two\b|\bfall in\b|\bnewer\b|\bafter\b|\bmore recent than\b/.test(q) && !/\b(?:rather|instead)\s+than\s+(?:since|after)\b/.test(q);
      const beforeish = /\b(?:before|older|predates?|prior to|earlier)\b/.test(q);
      // "before last year, rather than since" -> before; "since last year rather than before" -> since; "from before last year" -> before
      let side = null;
      if (/\bfrom before last year\b|\bbefore last year\b|\bolder than last year\b|\bpredates? last year\b|\bprior to last year\b/.test(q) && !/\b(?:since|after)\s+last year\s+(?:rather|instead)/.test(q)) side = "before";
      if (!side && sinceish && !beforeish) side = "since";
      if (!side && /\bsince\b[^,]*\b(?:rather|instead)\s+than\s+before\b/.test(q)) side = "since";
      if (side) return { kind: "history-skew", side };
    }
  }

  // --- date extremes: first / most recent service visit, oldest / newest unit installed, earliest / latest invoice
  if (/\b(?:earliest|first|oldest|latest|newest|most recent|last)\b/.test(q) && /\b(?:when|what'?s|what is|date|which)\b/.test(q) && !/\bwarrant/.test(q)) {
    const early = /\b(?:earliest|first|oldest)\b/.test(q);
    const late = /\b(?:latest|newest|most recent|last)\b/.test(q);
    if (early !== late && closed(q, setOf(V.extreme, ["when", "was", "is", "the", "date"]))) {
      let subject = null;
      if (/\b(?:service|visit|call|ticket)s?\b/.test(q) && !/\binvoice|\binstall/.test(q)) subject = "service";
      else if (/\binvoices?\b/.test(q) && !/\binstall|\bservice\b/.test(q)) subject = "invoice";
      else if (/\binstall(?:ed|ation)?\b|\bunits?\b|\bsystems?\b/.test(q) && !/\binvoice|\bservice\b/.test(q)) subject = "install";
      if (subject) return { kind: "date-extreme", subject, dir: early ? "asc" : "desc" };
    }
  }

  // --- open invoices in a period
  if (/\b(?:open|unpaid|outstanding|pending|unsettled)\b/.test(q) && /\binvoices?\b|\bbills?\b/.test(q) && /\b(?:last|this|past|in|during|from)\s+(?:the\s+)?(?:last\s+)?(?:\d+\s+)?(?:quarter|month|week|year|days?|weeks?|months?)\b|\bytd\b|\bq[1-4]\b/.test(q) && !/\bhow much\b|\btotal\b|\bdollar|\$/.test(q)) {
    if (closed(q, setOf(V.open))) return { kind: "open-in-period", question: q };
  }

  // --- R45: general composable templates (share / average / top N / busiest / per-group / A vs B), last so every closed shape above keeps its answer
  const tmpl = opts?.skipTemplate ? null : parseTemplate(question);
  if (tmpl) return { kind: "template", intent: tmpl };
  return null;
}

/* ------------------------------------------------------------------ run */

const EQUIP = `entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`;
const DATE_RE = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}'`;

async function manufacturers(db) {
  const { rows } = await db.raw(`SELECT DISTINCT data->>'manufacturer' AS m FROM entities WHERE ${EQUIP} AND data->>'manufacturer' IS NOT NULL`, []);
  return rows.map((r) => r.m).filter(Boolean);
}

/** The ONE manufacturer named in the question (a word-boundary match), or {unmatched} when an unknown word is left over. */
async function brandScope(db, question, unknown) {
  const mfrs = await manufacturers(db);
  const q = norm(question);
  const hits = mfrs.filter((m) => new RegExp(`\\b${norm(m).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(q));
  const brandWords = new Set(hits.flatMap((m) => norm(m).split(" ")));
  const left = (unknown ?? []).filter((w) => !brandWords.has(w));
  if (left.length || hits.length > 1) return { ok: false };
  return { ok: true, brand: hits[0] ?? null };
}

const unitCite = (rows, group) => rows.slice(0, 150).map((r) => unitRecord({ id: r.id, manufacturer: r.manufacturer, equipment_type: r.equipment_type, model: r.model, serial_number: r.serial_number, customer_id: r.customer_id }, group ? { group } : {}));

export async function runAggregate(db, intent, { today } = {}) {
  try { return await runAggregateCore(db, intent, { today }); } catch (err) { if (process.env.R32_DEBUG) process.stderr.write(`aggregate ${intent.kind}: ${err?.stack}\n`); throw err; }
}

async function runAggregateCore(db, intent, { today } = {}) {
  const t = todayIso(today);
  switch (intent.kind) {
    case "warranty-extreme": return warrantyExtreme(db, intent);
    case "warranty-count": return warrantyCount(db, intent, t);
    case "warranty-period": return warrantyPeriod(db, intent, t);
    case "tech-never": return techNever(db, intent, t);
    case "tech-extreme": return techExtreme(db, intent);
    case "tech-list": return techList(db);
    case "tech-typed-count": return techTypedCount(db, intent);
    case "no-text-docs": return noTextDocs(db);
    case "history-skew": return historySkew(db, intent, t);
    case "date-extreme": return dateExtreme(db, intent);
    case "open-in-period": return openInPeriod(db, intent, t);
    case "template": return runTemplate(db, intent.intent, { today: t });
    default: return null;
  }
}

async function warrantyExtreme(db, intent) {
  const sc = await brandScope(db, intent.question ?? "", intent.unknown);
  if (!sc.ok) return null;
  const params = sc.brand ? [sc.brand] : [];
  const { rows } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'equipment_type' AS equipment_type, data->>'model' AS model, data->>'serial_number' AS serial_number,
            substr(data#>>'{warranty,expires}', 1, 10) AS expires, data->>'service_address' AS address
       FROM entities WHERE ${EQUIP} AND data#>>'{warranty,expires}' ~ ${DATE_RE} ${sc.brand ? "AND lower(data->>'manufacturer') = lower($1)" : ""}
      ORDER BY substr(data#>>'{warranty,expires}', 1, 10) ${intent.dir === "asc" ? "ASC" : "DESC"}, id LIMIT 200`, params);
  const scope = sc.brand ? `${sc.brand} ` : "";
  if (!rows.length) {
    return attachCitations({ kind: "no-answer", text: `No ${scope}unit on file has a warranty end date, so there is no ${intent.dir === "asc" ? "earliest" : "latest"} expiration to report.`, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [] },
      { records: [], total: 0, kind: "searched", basis: `Searched every ${scope}unit's warranty end date; none is on file.` });
  }
  const best = rows[0].expires;
  const tied = rows.filter((r) => r.expires === best);
  const who = tied[0];
  const label = `${[who.manufacturer, who.equipment_type].filter(Boolean).join(" ") || "unit"}${who.address ? ` at ${who.address}` : ""}`;
  const text = `The ${intent.dir === "asc" ? "earliest" : "latest"} ${scope}warranty expiration on file is ${formatDateHumanWithIso(best)} — ${tied.length === 1 ? label : `${tied.length} units share that date, including ${label}`}.`;
  return attachCitations(answerEnvelope({ text, facts: [{ label: `${intent.dir === "asc" ? "Earliest" : "Latest"} ${scope}warranty expiration`, value: formatDateHumanWithIso(best), sources: [] }], extra: { fastIntent: "warranty_extreme" } }),
    { records: unitCite(tied), total: tied.length, kind: "searched", basis: `Compared the warranty end date of every ${scope}unit that has one on file (${rows.length}); the ${intent.dir === "asc" ? "earliest" : "latest"} is listed.` });
}


/* ------------------------------------------------------------ R3 warrexp: expiring by period */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WARR_TYPO = /\bwar+[aeiu]n+t(?:y|ies|ys|ee|ees)\b/g;
const WARR_REJECT = /\b(?:transfer\w*|how long|cover\w*|claims?|registr\w*|agreements?|plans?|contracts?|memberships?|insurance|extended|labou?r|parts|soon|already|expired|ago|customers?|clients?|accounts?|invoices?|quotes?|installed|install|installation|without|unknown|earliest|latest|first|oldest|newest|most|least|never|not|no|longer|still|under|out of|last|past|previous|before|since|after|between|from|than|over)\b/;
const WARR_VOCAB = setOf(V.unit, ["warranty", "warranties", "expiring", "expire", "expires", "end", "ends", "ending", "run", "runs", "running", "out", "up", "lapse", "lapses", "lapsing", "come", "comes", "coming", "off", "list", "show", "me", "tell", "which", "whose", "during", "calendar", "year", "month", "quarter", "next", "this", "that", "can", "you", "are", "due", "by", "within", "of", "ours", "its", "their", "one", "ones", "them", "units", "unit", "s", "d", "q", "th", "st", "nd", "rd", "first", "second", "third", "fourth", "have", "has", "a", "on", "file"]);
function parseWarrPeriod(q) {
  let t = q.replace(WARR_TYPO, "warranty").replace(/\bexpi?r\w*/g, "expiring");
  const hasWar = /\bwarranty\b|\bwarranties\b/.test(t);
  const hasUnit = /\b(?:units?|systems?|equipment|furnaces?|condensers?|heaters?|acs?|hvac|pieces?)\b/.test(t);
  const hasExp = /\bexpiring\b|\b(?:runs?|running)\s+out\b|\blaps\w+\b|\bcomes?\s+off\b|\bcoming\s+off\b|\b(?:ends?|ending)\b|\bup\b/.test(t);
  if (!(hasWar || hasUnit) || !hasExp) return null;
  if (!hasWar && !/\bexpiring\b|\b(?:runs?|running)\s+out\b/.test(t)) return null;
  if (WARR_REJECT.test(q) || /\b(?:expired|expire(?:d)?\s+(?:so far|already))\b/.test(q)) return null;
  if (/\bthe\s+(?:next|coming|following|upcoming)\b|\bnext\s+(?:\d+|a|an|one|two|three|few|several|\w+)\s+(?:months?|years?|days?|weeks?|quarters?)\b|\bwithin\b|\bupcoming\b|\brolling\b/.test(t)) return null; // rolling windows ("in the next year", "within 90 days") stay with the existing count paths
  // exactly one period
  let period = null; let rest = t;
  const take = (re, mk) => { const m = re.exec(rest); if (!m) return false; if (period) { period = "dup"; return true; } period = mk(m); rest = rest.replace(re, " "); return true; };
  const Q = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };
  take(/\bthis\s+(?:calendar\s+|fiscal\s+)?year\b|\bcurrent\s+year\b/, () => ({ t: "year", rel: 0 }));
  take(/\bnext\s+(?:calendar\s+|fiscal\s+)?year\b/, () => ({ t: "year", rel: 1 }));
  take(/\bthis\s+month\b/, () => ({ t: "month", rel: 0 }));
  take(/\bnext\s+month\b/, () => ({ t: "month", rel: 1 }));
  take(/\bthis\s+quarter\b/, () => ({ t: "quarter", rel: 0 }));
  take(/\bnext\s+quarter\b/, () => ({ t: "quarter", rel: 1 }));
  take(/\bq([1-4])(?:\s+(?:of\s+)?(20\d\d))?\b/, (m) => ({ t: "quarter", q: +m[1], y: m[2] ? +m[2] : null }));
  take(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter(?:\s+(?:of\s+)?(20\d\d))?\b/, (m) => ({ t: "quarter", q: Q[m[1]], y: m[2] ? +m[2] : null }));
  take(new RegExp(`\\b(${MONTHS.join("|")})(?:\\s+(20\\d\\d))?\\b`), (m) => ({ t: "month", m: MONTHS.indexOf(m[1]) + 1, y: m[2] ? +m[2] : null }));
  take(/\b(20\d\d)\b/, (m) => ({ t: "year", y: +m[1] }));
  if (!period || period === "dup") return null;
  rest = rest.replace(/\b(?:in|during|for|by|within|the|calendar|fiscal|of)\b/g, " ");
  const unknown = words(rest).filter((w) => /[a-z0-9]/.test(w) && !(GLUE.has(w) || WARR_VOCAB.has(w) || /^\d+$/.test(w)));
  if (unknown.length > 2) return null;
  return { kind: "warranty-period", period, unknown };
}

function warrPeriodWindow(p, today) {
  const y0 = +today.slice(0, 4), m0 = +today.slice(5, 7);
  const pad2 = (n) => String(n).padStart(2, "0");
  const last = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (p.t === "year") { const y = p.y ?? y0 + p.rel; return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) }; }
  if (p.t === "month") {
    let y = p.y ?? y0, m = p.m ?? m0;
    if (p.rel != null) { m = m0 + p.rel; if (m > 12) { m -= 12; y = y0 + 1; } }
    return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${last(y, m)}`, label: `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}` };
  }
  let y = p.y ?? y0, q = p.q ?? Math.ceil(m0 / 3);
  if (p.rel != null) { q += p.rel; if (q > 4) { q -= 4; y = y0 + 1; } }
  const m1 = q * 3 - 2, m2 = q * 3;
  return { from: `${y}-${pad2(m1)}-01`, to: `${y}-${pad2(m2)}-${last(y, m2)}`, label: `Q${q} ${y}` };
}

async function warrantyPeriod(db, intent, today) {
  const sc = await brandScope(db, intent.question ?? "", intent.unknown);
  if (!sc.ok) return null;
  const w = warrPeriodWindow(intent.period, today);
  const params = sc.brand ? [sc.brand] : [];
  const { rows } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'equipment_type' AS equipment_type, data->>'model' AS model, data->>'serial_number' AS serial_number, data->>'service_address' AS address,
            CASE WHEN data#>>'{warranty,expires}' ~ ${DATE_RE} THEN substr(data#>>'{warranty,expires}', 1, 10) END AS expires
       FROM entities WHERE ${EQUIP} ${sc.brand ? "AND lower(data->>'manufacturer') = lower($1)" : ""}`, params);
  if (!rows.length) return null;
  const dated = rows.filter((r) => r.expires);
  const hit = dated.filter((r) => r.expires >= w.from && r.expires <= w.to).sort((a, b) => a.expires.localeCompare(b.expires) || String(a.id).localeCompare(String(b.id)));
  const scope = sc.brand ? `${sc.brand} ` : "";
  const noDate = rows.length - dated.length;
  const basis = `Date basis: each unit's warranty end date on file (the date the warranty stops), not the install date or any service date.${noDate ? ` ${noDate} unit${noDate === 1 ? " has" : "s have"} no warranty end date on file and ${noDate === 1 ? "isn't" : "aren't"} counted.` : ""}`;
  const n = hit.length;
  let text;
  if (!n) text = `No ${scope}unit on file has a warranty ending in ${w.label} (of ${dated.length} with an end date on file). ${basis}`;
  else {
    const past = hit.filter((r) => r.expires < today).length;
    const lead = `${n} ${scope}unit${n === 1 ? " has a warranty" : "s have warranties"} ending in ${w.label}${past ? ` (${past} already ended as of ${today}${past === n ? "" : `, ${n - past} still to come`})` : ""}`;
    const items = hit.slice(0, 10).map((r) => `${[r.manufacturer, r.equipment_type].filter(Boolean).join(" ") || "Unit"}${r.address ? ` at ${r.address}` : ""} - ends ${formatDateHumanWithIso(r.expires)}`);
    text = `${lead}: ${items.join("; ")}${n > 10 ? `; and ${n - 10} more` : ""}. ${basis}`;
  }
  return attachCitations(answerEnvelope({ text, facts: [{ label: `${scope}warranties ending in ${w.label}`, value: String(n), sources: [] }], extra: { fastIntent: "warranty_period" } }),
    { records: unitCite(hit), total: n, claimedCount: n, kind: "searched", basis: `Counted the ${scope}units whose warranty end date falls from ${w.from} to ${w.to}; every counted unit is listed.` });
}

async function warrantyCount(db, intent, today) {
  const sc = await brandScope(db, intent.question ?? "", intent.unknown);
  if (!sc.ok) return null;
  const params = sc.brand ? [sc.brand] : [];
  const { rows } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'equipment_type' AS equipment_type, data->>'model' AS model, data->>'serial_number' AS serial_number,
            CASE WHEN data#>>'{warranty,expires}' ~ ${DATE_RE} THEN substr(data#>>'{warranty,expires}', 1, 10) END AS expires
       FROM entities WHERE ${EQUIP} ${sc.brand ? "AND lower(data->>'manufacturer') = lower($1)" : ""}`, params);
  const total = rows.length;
  if (!total) return null;
  const dated = rows.filter((r) => r.expires);
  const noDate = total - dated.length;
  const daysLeft = (r) => (Date.parse(r.expires) - Date.parse(today)) / 86400000;
  // R35 (owner decision 2026-10-01): a warranty is still in force through its end date (end date >= today); expired = end date before today.
  const expired = dated.filter((r) => r.expires < today);
  const live = dated.filter((r) => r.expires >= today);
  const soonList = live.filter((r) => daysLeft(r) <= 365);
  const overList = live.filter((r) => daysLeft(r) > 365);
  const scope = sc.brand ? `${sc.brand} ` : "";
  const unitsWord = (n) => `${scope}unit${n === 1 ? "" : "s"}`;
  const isAre = (n) => (n === 1 ? "is" : "are");
  const dateNote = noDate ? ` ${noDate} ${noDate === 1 ? "has" : "have"} no warranty end date on file.` : "";
  const noDateList = rows.filter((r) => !r.expires);
  const pick = { expired, active: live, "over-year": overList, "within-year": soonList, unknown: noDateList }[intent.state] ?? live;
  if (intent.customers) {
    const ids = [...new Set(pick.map((r) => r.customer_id).filter(Boolean))];
    const { rows: cust } = ids.length
      ? await db.raw(`SELECT id, data->>'customer_name' AS customer_name FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL} AND id = ANY($1::uuid[])`, [ids])
      : { rows: [] };
    const n = cust.length;
    const what = { expired: "unit out of warranty", active: "unit still under warranty", "over-year": "unit with more than a year of warranty left", "within-year": "unit whose warranty runs out in the next 12 months", unknown: "unit with no warranty end date on file" }[intent.state];
    const text = `${n} customer${n === 1 ? "" : "s"} ${n === 1 ? "has" : "have"} a ${scope}${what}.`;
    return attachCitations(answerEnvelope({ text, facts: [{ label: "Customers", value: String(n), sources: [] }], extra: { fastIntent: "warranty_count" } }),
      { records: cust.map((c) => customerRecord({ id: c.id, customer_name: c.customer_name })).slice(0, 150), total: n, claimedCount: n, kind: "searched", basis: `Counted customers with at least one ${scope}unit whose warranty end date ${intent.state === "unknown" ? "is not on file" : intent.state === "expired" ? `is before ${today}` : `is on or after ${today}`}${intent.state === "over-year" ? " by more than a year" : intent.state === "within-year" ? " and within a year" : ""}.` });
  }
  let text;
  if (intent.state === "expired") {
    text = `${expired.length} ${unitsWord(expired.length)} ${isAre(expired.length)} out of warranty (end date passed), of ${total} on file.${dateNote}`;
  } else if (intent.state === "over-year") {
    text = `${overList.length} ${unitsWord(overList.length)} ${overList.length === 1 ? "has" : "have"} more than a year of warranty left (${live.length} still under warranty in all).`;
  } else if (intent.state === "unknown") {
    text = `${noDateList.length} ${unitsWord(noDateList.length)} ${noDateList.length === 1 ? "has" : "have"} no warranty end date on file (of ${total}).`;
  } else if (intent.state === "within-year") {
    text = `${soonList.length} ${unitsWord(soonList.length)} ${soonList.length === 1 ? "has a warranty" : "have warranties"} running out in the next 12 months.`;
  } else {
    text = `${live.length} ${unitsWord(live.length)} ${isAre(live.length)} still under warranty${soonList.length ? ` — ${soonList.length} of them run${soonList.length === 1 ? "s" : ""} out in the next 12 months` : ""}.${dateNote}`;
  }
  const label = { expired: "units out of warranty", active: "units still under warranty", "over-year": "units with more than a year left", "within-year": "warranties running out in the next 12 months", unknown: "units with no warranty end date" }[intent.state];
  const basis = {
    expired: `Counted the ${scope}units whose warranty end date is before ${today}; every counted unit is listed.`,
    active: `Counted the ${scope}units whose warranty end date is on or after ${today} (not expired); every counted unit is listed.`,
    "over-year": `Counted the ${scope}units whose warranty end date is more than 365 days after ${today}; every counted unit is listed.`,
    "within-year": `Counted the ${scope}units whose warranty end date falls between ${today} and 365 days later; every counted unit is listed.`,
    unknown: `Counted the ${scope}units with no warranty end date on file; every counted unit is listed.`,
  }[intent.state];
  return attachCitations(answerEnvelope({ text, facts: [{ label: `${scope}${label}`, value: String(pick.length), sources: [] }], extra: { fastIntent: "warranty_count" } }),
    { records: unitCite(pick), total: pick.length, claimedCount: pick.length, kind: "searched", basis });
}

async function techNever(db, intent, today) {
  let range = null;
  if (intent.windowed) {
    const r0 = resolveAnyTimeRange(intent.question, today);
    if (!r0?.from || !r0?.to) return null;
    const lo = (v) => (/^\d{4}$/.test(v) ? `${v}-01-01` : /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v);
    const hi = (v) => (/^\d{4}$/.test(v) ? `${v}-12-31` : /^\d{4}-\d{2}$/.test(v) ? new Date(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)), 0)).toISOString().slice(0, 10) : v);
    range = { from: lo(String(r0.from)), to: hi(String(r0.to)), label: r0.label ?? `${r0.from} to ${r0.to}` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) return null;
  }
  const { rows } = await db.raw(
    `SELECT t.value AS tech, s.value AS stype, t.document_id, y.value AS sdate FROM extractions t LEFT JOIN extractions s ON s.document_id = t.document_id AND s.field_key = 'service_type' AND s.${TENANT_SQL}
      LEFT JOIN extractions y ON y.document_id = t.document_id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
      WHERE t.field_key = 'technician' AND t.value IS NOT NULL AND t.${TENANT_SQL}`, []);
  const byTech = new Map();
  for (const r of rows) { if (!byTech.has(r.tech)) byTech.set(r.tech, { n: 0, hit: 0, docs: [] }); const e = byTech.get(r.tech); e.n++; const inWin = !range || (/^\d{4}-\d{2}-\d{2}/.test(String(r.sdate ?? '')) && String(r.sdate).slice(0, 10) >= range.from && String(r.sdate).slice(0, 10) <= range.to); if (r.stype === intent.type && inWin) e.hit++; e.docs.push(r.document_id); }
  if (!byTech.size) return null;
  const never = [...byTech.entries()].filter(([, e]) => e.hit === 0).map(([name, e]) => ({ name, visits: e.n, docs: e.docs }));
  const label = intent.type === "Repair" ? "repair" : "preventive maintenance";
  const win = range ? ` ${/^(?:in|since|from|during|so far|between)\b/i.test(range.label) ? range.label : `in ${range.label}`}` : "";
  if (!never.length) {
    return attachCitations({ kind: "answer", text: `Every technician on file (${byTech.size}) has logged at least one ${label} visit${win}.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: "tech_never" },
      { records: [], total: 0, kind: "searched", basis: `Compared each of the ${byTech.size} technicians' visit documents against the ${label} service type; none is missing.` });
  }
  const facts = never.map((n) => ({ label: n.name, value: `no ${label} visits${win} (${n.visits} visit${n.visits === 1 ? "" : "s"} logged in all)`, sources: [{ documentId: n.docs[0], location: {} }] }));
  const text = `${never.length === 1 ? `${never[0].name} has` : `${never.length} technicians have`} ${range ? "not logged" : "never logged"} a ${label} visit${win}: ${never.map((n) => n.name).join(", ")}. The other ${byTech.size - never.length} ${byTech.size - never.length === 1 ? "has" : "have"} at least one.`;
  const docIds = [...new Set(never.flatMap((n) => n.docs))].slice(0, 120);
  return attachCitations(answerEnvelope({ text, facts, extra: { fastIntent: "tech_never" } }),
    { records: docIds.map((id) => documentRecord({ id })), total: docIds.length, kind: "searched", basis: `Compared the technician on each visit document with its service type; these are the visits of the technicians with no ${label} visit (${byTech.size} technicians in all).` });
}

async function noTextDocs(db) {
  const { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, d.created_at FROM documents d
      WHERE d.${TENANT_SQL} AND NOT EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.id AND coalesce(p.text, '') <> '') ORDER BY d.created_at DESC`, []);
  const { rows: all } = await db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL}`, []);
  const total = all[0]?.n ?? 0;
  if (!rows.length) {
    return attachCitations(answerEnvelope({ text: `No documents are missing text — all ${total} documents have readable text on at least one page.`, facts: [], extra: { fastIntent: "no_text_docs" } }),
      { records: [], total: 0, kind: "searched", basis: `Checked the page text of all ${total} documents; none came back empty.` });
  }
  return attachCitations(answerEnvelope({ text: `${rows.length} of ${total} documents have no readable text on any page.`, facts: [{ label: "Documents with no readable text", value: String(rows.length), sources: rows.slice(0, 25).map((r) => ({ documentId: r.id, location: {} })) }], extra: { fastIntent: "no_text_docs" } }),
    { records: rows.slice(0, 150).map((r) => documentRecord(r)), total: rows.length, claimedCount: rows.length, kind: "searched", basis: "Listed every document whose pages hold no extracted text." });
}

async function historySkew(db, intent, today) {
  const year = Number(today.slice(0, 4));
  const cut = `${year - 1}-01-01`;
  const { rows } = await db.raw(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE substr(value, 1, 10) < $1)::int AS before FROM extractions WHERE field_key = 'service_date' AND value ~ ${DATE_RE} AND ${TENANT_SQL}`, [cut]);
  const n = rows[0]?.n ?? 0; const before = rows[0]?.before ?? 0; const since = n - before;
  if (!n) return null;
  const { rows: docs } = await db.raw(`SELECT DISTINCT x.document_id AS id, d.original_filename, d.document_type FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL} WHERE x.field_key = 'service_date' AND x.value ~ ${DATE_RE} AND x.${TENANT_SQL} LIMIT 200`, []);
  const cite = docs.map((r) => documentRecord(r));
  const yes = intent.side === "before" ? before > since : since > before;
  if (before === since) return attachCitations(answerEnvelope({ text: `No — it's an even split: ${before} dated service visits before ${formatDateHumanWithIso(cut)} and ${since} since.` }), { records: cite, total: n, kind: "searched", basis: `Counted the ${n} dated service visits on each side of ${cut}.` });
  const text = `${yes ? "Yes" : "No"} — ${before} of the ${n} dated service visits happened before ${formatDateHumanWithIso(cut)} and ${since} since.`;
  return attachCitations(answerEnvelope({ text, facts: [{ label: "Visits before the start of last year", value: String(before), sources: [] }, { label: "Visits since the start of last year", value: String(since), sources: [] }], extra: { fastIntent: "history_skew" } }),
    { records: cite, total: n, kind: "searched", basis: `Counted the ${n} dated service visits on each side of ${cut} (a visit is one dated service_date record); the visit documents are listed.` });
}

async function dateExtreme(db, intent) {
  const dir = intent.dir === "asc" ? "ASC" : "DESC";
  const which = intent.dir === "asc" ? "earliest" : "most recent";
  if (intent.subject === "service") {
    const { rows } = await db.raw(
      `SELECT x.document_id AS id, substr(x.value, 1, 10) AS d, d.original_filename, d.document_type FROM extractions x JOIN documents d ON d.id = x.document_id AND d.${TENANT_SQL}
        WHERE x.field_key = 'service_date' AND x.value ~ ${DATE_RE} AND x.${TENANT_SQL} ORDER BY substr(x.value, 1, 10) ${dir}, x.document_id LIMIT 40`, []);
    if (!rows.length) return null;
    const best = rows[0].d; const tied = rows.filter((r) => r.d === best);
    return attachCitations(answerEnvelope({ text: `The ${which} service visit on file is dated ${formatDateHumanWithIso(best)}${tied.length > 1 ? ` (${tied.length} visits share that date)` : ""}.`, facts: [{ label: `${which} service visit`, value: formatDateHumanWithIso(best), sources: [{ documentId: tied[0].id, location: {} }] }], extra: { fastIntent: "date_extreme" } }),
      { records: tied.map((r) => documentRecord(r)), total: tied.length, kind: "searched", basis: `Compared the date of every dated service visit on file; the ${which} is listed.` });
  }
  if (intent.subject === "invoice") {
    const { rows } = await db.raw(
      `SELECT f.document_id AS id, f.invoice_date::text AS d, f.invoice_number, f.customer_name, f.total, d.original_filename FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
        WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.invoice_date IS NOT NULL AND f.${TENANT_SQL} ORDER BY f.invoice_date ${dir}, f.document_id LIMIT 40`, []);
    if (!rows.length) return null;
    const best = rows[0].d.slice(0, 10); const tied = rows.filter((r) => r.d.slice(0, 10) === best);
    const r0 = tied[0];
    const who = [r0.invoice_number ? `invoice ${String(r0.invoice_number).replace(/^#?/, "#")}` : null, r0.customer_name].filter(Boolean).join(", ");
    return attachCitations(answerEnvelope({ text: `The ${which} invoice on file is dated ${formatDateHumanWithIso(best)}${who ? ` (${who})` : ""}${tied.length > 1 ? `; ${tied.length - 1} more share that date` : ""}.`, facts: [{ label: `${which} invoice date`, value: formatDateHumanWithIso(best), sources: [{ documentId: r0.id, location: {} }] }], extra: { fastIntent: "date_extreme" } }),
      { records: tied.map((r) => documentRecord({ id: r.id, original_filename: r.original_filename, document_type: "invoice" })), total: tied.length, kind: "searched", basis: `Compared the date of every invoice on file; the ${which} is listed.` });
  }
  const { rows } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'equipment_type' AS equipment_type, data->>'model' AS model, data->>'serial_number' AS serial_number, substr(data->>'installation_date', 1, 10) AS d, data->>'service_address' AS address
       FROM entities WHERE ${EQUIP} AND data->>'installation_date' ~ ${DATE_RE} ORDER BY substr(data->>'installation_date', 1, 10) ${dir}, id LIMIT 200`, []);
  if (!rows.length) return null;
  const best = rows[0].d; const tied = rows.filter((r) => r.d === best);
  const r0 = tied[0];
  const label = `${[r0.manufacturer, r0.equipment_type].filter(Boolean).join(" ") || "unit"}${r0.address ? ` at ${r0.address}` : ""}`;
  return attachCitations(answerEnvelope({ text: `The ${intent.dir === "asc" ? "earliest" : "most recent"} installation date on file is ${formatDateHumanWithIso(best)} — ${tied.length === 1 ? label : `${tied.length} units share that date, including ${label}`}.`, facts: [{ label: `${which} installation date`, value: formatDateHumanWithIso(best), sources: [] }], extra: { fastIntent: "date_extreme" } }),
    { records: unitCite(tied), total: tied.length, kind: "searched", basis: `Compared the installation date of every unit that has one on file (${rows.length}); the ${which} is listed.` });
}

async function openInPeriod(db, intent, today) {
  // Only honest when NO invoice in the tenant carries a payment status: otherwise the normal money route answers with real statuses.
  const { rows: st } = await db.raw(`SELECT count(*)::int AS n FROM document_financials WHERE status IN ('unpaid', 'partial', 'paid', 'overdue') AND ${TENANT_SQL}`, []);
  if ((st[0]?.n ?? 0) > 0) return null;
  const range0 = resolveAnyTimeRange(intent.question, today);
  if (!range0?.from || !range0?.to) return null;
  const lo = (v) => (/^\d{4}$/.test(v) ? `${v}-01-01` : /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v);
  const hi = (v) => (/^\d{4}$/.test(v) ? `${v}-12-31` : /^\d{4}-\d{2}$/.test(v) ? new Date(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)), 0)).toISOString().slice(0, 10) : v);
  const range = { ...range0, from: lo(String(range0.from)), to: hi(String(range0.to)) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) return null;
  const { rows } = await db.raw(
    `SELECT f.document_id AS id, d.original_filename FROM document_financials f JOIN documents d ON d.id = f.document_id AND d.${TENANT_SQL}
      WHERE f.doc_kind = 'invoice' AND f.direction = 'receivable' AND f.invoice_date >= $1::date AND f.invoice_date <= $2::date AND f.${TENANT_SQL}`, [range.from, range.to]);
  const label = range.label ?? `${range.from} to ${range.to}`;
  const text = `I can't tell which invoices are still open — none of the invoices on file records whether it has been paid. ${rows.length ? `${rows.length} invoice${rows.length === 1 ? " is" : "s are"} dated ${label}; their payment status is not on file.` : `No invoices are dated ${label}.`}`;
  return attachCitations({ kind: "no-answer", text, facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [], fastIntent: "open_in_period" },
    { records: rows.slice(0, 100).map((r) => documentRecord({ id: r.id, original_filename: r.original_filename, document_type: "invoice" })), total: rows.length, kind: "searched", basis: `Checked the payment status of every invoice dated ${label}; none states one.` });
}

/** B3: "the fewest tickets" / "the most invoices" counts that kind of document, not every document that names the technician. */
function ticketScope(q) {
  if (/\btickets?\b/.test(q)) return { docType: "service-ticket", docWord: "service tickets" };
  if (/\binvoices?\b/.test(q)) return { docType: "invoice", docWord: "invoices" };
  return {};
}
async function techRows(db, docType = null) {
  const { rows } = await db.raw(`SELECT t.value AS tech, t.document_id AS id, s.value AS stype FROM extractions t LEFT JOIN extractions s ON s.document_id = t.document_id AND s.field_key = 'service_type' AND s.${TENANT_SQL}
    ${docType ? "JOIN documents dd ON dd.id = t.document_id AND dd.document_type = $1" : ""}
    WHERE t.field_key = 'technician' AND coalesce(t.value, '') <> '' AND t.${TENANT_SQL}`, docType ? [docType] : []);
  return rows;
}

async function techExtreme(db, intent) {
  let rows = await techRows(db, intent.docType ?? null);
  const W = intent.window;
  if (W) {
    const { rows: sd } = await db.raw(`SELECT document_id AS id, coalesce(nullif(corrected_value, ''), value) AS v FROM extractions WHERE field_key = 'service_date' AND ${TENANT_SQL}`, []);
    const isoOf = (v) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "")); if (m) return `${m[1]}-${m[2]}-${m[3]}`; const u = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v ?? "")); return u ? `${u[3]}-${String(+u[1]).padStart(2, "0")}-${String(+u[2]).padStart(2, "0")}` : null; };
    const dateOf = new Map(); for (const r of sd) { const d = isoOf(r.v); if (d && !dateOf.has(r.id)) dateOf.set(r.id, d); }
    rows = rows.filter((r) => { const d = dateOf.get(r.id); return d && d >= W.from && d <= W.to; });
    const when = W.open ? W.label : W.range ? `from ${W.label}` : /^\d{4}$|^[A-Z][a-z]+ \d{4}$/.test(W.label) ? `in ${W.label}` : `on ${W.label}`;
    if (!rows.length) return attachCitations(answerEnvelope({ text: `No technician has a dated job on file ${when}.`, facts: [], extra: { fastIntent: "tech_extreme" } }),
      { records: [], total: 0, kind: "searched", basis: `Looked for service records naming a technician with a service date ${W.from} through ${W.to}; none.` });
    intent = { ...intent, whenText: when };
  }
  if (!rows.length) return null;
  const per = new Map(); for (const r of rows) { if (!per.has(r.tech)) per.set(r.tech, new Set()); per.get(r.tech).add(r.id); }
  const entries = [...per.entries()].map(([name, set]) => ({ name, n: set.size, ids: [...set] })).sort((a, b) => (intent.dir === "asc" ? a.n - b.n : b.n - a.n) || a.name.localeCompare(b.name));
  const best = entries[0].n; const winners = entries.filter((e) => e.n === best);
  const names = winners.map((w) => w.name).join(" and ");
  const word = intent.dir === "asc" ? "fewest" : "most";
  const text = `${names} ${winners.length > 1 ? "are tied for the" : "has the"} ${word} ${intent.docWord ?? "jobs"} ${intent.whenText ? `${intent.whenText}, ` : "on file, "}with ${best}${winners.length > 1 ? " each" : ""} (counting ${intent.docWord ? `the ${intent.docWord} that name` : "every document that names"} the technician${intent.whenText ? " and is dated in that window" : ""}).`;
  const docIds = [...new Set(winners.flatMap((w) => w.ids))].slice(0, 150);
  return attachCitations(answerEnvelope({ text, facts: winners.map((w) => ({ label: w.name, value: String(w.n), sources: [{ documentId: w.ids[0], location: {} }] })), extra: { fastIntent: "tech_extreme" } }),
    { records: docIds.map((id) => documentRecord({ id })), total: docIds.length, kind: "searched", basis: `Counted the documents naming each of the ${entries.length} technicians (${entries.map((e) => `${e.name} ${e.n}`).join(", ")}); the ${word} are listed.` });
}

async function techList(db) {
  const rows = await techRows(db);
  if (!rows.length) return null;
  const per = new Map(); for (const r of rows) { if (!per.has(r.tech)) per.set(r.tech, new Set()); per.get(r.tech).add(r.id); }
  const entries = [...per.entries()].map(([name, set]) => ({ name, n: set.size, ids: [...set] })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const text = `${entries.length} technician${entries.length === 1 ? "" : "s"} on file: ${entries.map((e) => `${e.name} (${e.n} job${e.n === 1 ? "" : "s"})`).join(", ")}.`;
  const docIds = [...new Set(entries.flatMap((e) => e.ids))].slice(0, 150);
  return attachCitations(answerEnvelope({ text, facts: entries.map((e) => ({ label: e.name, value: String(e.n), sources: [{ documentId: e.ids[0], location: {} }] })), extra: { fastIntent: "tech_list" } }),
    { records: docIds.map((id) => documentRecord({ id })), total: docIds.length, kind: "searched", basis: `Listed every distinct technician named on a service record; job counts are the documents naming each (${entries.length} technicians).` });
}

async function techTypedCount(db, intent) {
  const name = await resolveTechnician(db, intent.name);
  if (!name) return null;
  const rows = (await techRows(db)).filter((r) => r.tech === name && r.stype === intent.type);
  const label = intent.type === "Repair" ? "repair" : "preventive maintenance";
  const ids = [...new Set(rows.map((r) => r.id))];
  const text = `${name} has ${ids.length} ${label} visit${ids.length === 1 ? "" : "s"} on file.`;
  return attachCitations(answerEnvelope({ text, facts: [{ label: `${name} ${label} visits`, value: String(ids.length), sources: ids.slice(0, 25).map((id) => ({ documentId: id, location: {} })) }], extra: { fastIntent: "tech_typed_count" } }),
    { records: ids.map((id) => documentRecord({ id })), total: ids.length, claimedCount: ids.length, kind: "searched", basis: `Counted the documents naming ${name} as technician whose service type is ${label}; every counted record is listed.` });
}
