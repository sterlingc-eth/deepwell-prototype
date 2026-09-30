/**
 * Round 20 (J1) — the general precision guard (R20_CONTRACT.md's #1 problem: false confidence).
 * Two halves, same convention as scripts/verify-decompose.mjs / scripts/verify-offline-exam.mjs:
 *
 *   1. UNIT (no DB, no model): extractConstraints (guard/constraints.js) on 100+ own phrasings — both
 *      positive ("this must be detected") and negative ("this must NOT be detected" — a false positive
 *      here is a guard false positive in production) — plus the untracked-concept registry
 *      (concepts/registry.js) and the two guardXAnswer functions (guard/check.js) exercised directly
 *      against hand-built intent/data fixtures (a fake `getPortfolioTotal` stands in for the DB).
 *
 *   2. INTEGRATION (golden tenant, PGlite, models mocked to throw — offline-exam.mjs's own harness): runs
 *      the full combined exam (base + all three generalization files) through the REAL /api/ask handler
 *      and asserts (a) every one of r19_blind3_clusters.json's named F1/F6 wrong ids no longer answers
 *      wrong (converted to correct or needs-model — a decline is never "wrong"), (b) the measured
 *      correct/wrong floors from this round's own before/after run never regress, and (c) the wrong-id set
 *      is a SHRINK-ONLY subset of the baseline list below (same convention as verify-golden.mjs's own
 *      KNOWN_WRONG_IDS) — any wrong id NOT in this list is a brand-new wrong answer and fails outright.
 *
 *   node scripts/verify-precision-guard.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};

/* ============================================================ 1. unit: constraints.js */
const { extractConstraints } = await import("../api/_lib/router/guard/constraints.js");

function types(question, opts) {
  return new Set(extractConstraints(question, opts).map((c) => c.type));
}
const has = (label, q, type, opts) => check(`constraint '${type}' detected: "${q}"`, types(q, opts).has(type), label);
const hasNot = (label, q, type, opts) => check(`constraint '${type}' NOT detected: "${q}"`, !types(q, opts).has(type), label);

// -- negation ---------------------------------------------------------------------------------------
has("neg1", "how many customers have zero documents of any kind on file", "negation");
has("neg2", "how many customers have none of our maintenance agreements on file", "negation");
has("neg3", "how many units have not a single work order on file", "negation");
has("neg4", "how many customers have not one invoice on record", "negation");
hasNot("neg-no1", "how many customers have no email on file", "negation"); // real, but a DIFFERENT ('email') condition — already well-handled elsewhere; not this file's 'negation' shape
hasNot("neg-no2", "no, how many customers do we have", "negation"); // conversational filler "no," must never fire this
hasNot("neg-no3", "how many customers do we have", "negation");
hasNot("neg-no4", "is there a permit on file for the Jones account", "negation");

// -- comparator ---------------------------------------------------------------------------------------
has("cmp1", "how many warranty registrations took longer than 30 days after install", "comparator");
has("cmp2", "how many properties do we have more than one unit installed at", "comparator");
has("cmp3", "which customers have at least two units on file", "comparator");
has("cmp4", "any warranties expiring in the next 90 days", "month"); // resolveAnyTimeRange's own nextNMatch, reused via detectedConditions
has("cmp5", "how many customers have fewer than 3 documents", "comparator");
hasNot("cmp-no1", "how many customers do we have", "comparator");
hasNot("cmp-no2", "what's more important, the serial or the model number", "comparator"); // "more" with no number nearby
hasNot("cmp-no3", "how many units do we have", "comparator");

// -- distinct ---------------------------------------------------------------------------------------
has("dist1", "how many distinct document types do we actually track", "distinct");
has("dist2", "how many unique brands do we have on file", "distinct");
has("dist3", "how many different types of documents do we have", "distinct");
hasNot("dist-no1", "how many document types do we have", "distinct");
hasNot("dist-no2", "how many customers do we have", "distinct");

// -- superlative ---------------------------------------------------------------------------------------
has("sup1", "what's the earliest warranty registration date we have on file", "superlative");
has("sup2", "what's the latest install we have on file", "superlative");
has("sup3", "when was our first customer's warranty registered", "superlative");
hasNot("sup-no1", "who was the last technician out to the job", "superlative"); // "last" with no date-ish word
hasNot("sup-no2", "how many warranty registrations do we have", "superlative");
hasNot("sup-no3", "what's the oldest customer complaint", "superlative"); // "oldest" with no date-ish field word nearby

// -- superlative false positives: time-window phrases (R21, L2 — i002 "how many units did we
// install last year" was blocked because SUPERLATIVE_RE's own FIELD-then-WORD branch matched
// "install" immediately followed by "last" (zero filler words), mis-reading the trailing "year" as
// an extreme-VALUE request instead of the plain, already-handled time window it actually is — see
// TIME_WINDOW_PHRASE_RE's own doc comment in constraints.js). "last/this/next year/month/week/
// quarter/season" and "so far this year" must never register as 'superlative', on their own or
// alongside a genuine date-ish field word elsewhere in the same question, and must still register
// as 'month' (the guard must never lose the real time-window signal while fixing the false one).
has("month-tw1", "how many units did we install last year", "month");
hasNot("sup-tw1", "how many units did we install last year", "superlative"); // i002 — the exact reported false positive
hasNot("sup-tw2", "did we install more units this year than last year", "superlative");
hasNot("sup-tw3", "did we install more units last year than we've done so far this year", "superlative"); // i003 phrasing
hasNot("sup-tw4", "how many warranty registrations came in last month", "superlative");
hasNot("sup-tw5", "how many units did we install next quarter", "superlative");
hasNot("sup-tw6", "any installs scheduled next week", "superlative");
hasNot("sup-tw7", "how many warranty jobs were completed last season", "superlative"); // field word ("warranty") + "last" adjacent to a time unit
has("sup-tw8", "the latest install date this year", "superlative"); // a genuine superlative must still fire even with a time window elsewhere in the same question
has("sup-tw9", "what's the earliest warranty registration date last year", "superlative"); // same — time window co-occurring with a real superlative
hasNot("sup-tw10", "who was the last technician out this month", "superlative"); // bare "last" (no date-ish field) + a time window — neither half should ever fire this

// -- namedEntity (tenant-vocab-driven + generic fallback) ------------------------------------------------
const VOCAB = {
  customers: { phrases: ["Amy Isaacson", "Karen Abernathy"] },
  technicians: { phrases: ["Denise Ford", "Wyatt Coburn"] },
};
has("name1", "do we have a purchase order on file for the Amy Isaacson account", "namedEntity", { tenantVocab: VOCAB });
has("name2", "how many jobs has Denise Ford closed out total", "namedEntity", { tenantVocab: VOCAB });
has("name3", "how many jobs has Wyatt Coburn closed out total", "namedEntity", { tenantVocab: VOCAB });
has("name4", "is there a permit on file for the Bracken account", "namedEntity"); // generic fallback, no vocab
hasNot("name-no1", "how many customers do we have", "namedEntity", { tenantVocab: VOCAB });
hasNot("name-no2", "how many jobs did we do last month", "namedEntity", { tenantVocab: VOCAB });

// -- reused detectedConditions passthrough (month/brand/etc — spot-check the plumbing, not the regexes
// themselves, which analytics.js's own test suite already owns) --------------------------------------
has("month1", "how many units have we installed so far this year", "month");
has("month2", "how many jobs did we do last month", "month");
hasNot("month-no1", "how many customers do we have", "month");

// -- own-phrasing volume floor (contract: "≥100 own phrasings") ----------------------------------------
const MORE_POSITIVE = [
  ["how many customers have zero warranties on file", "negation"],
  ["how many customers have none on file", "negation"],
  ["not a single document on record for any of them", "negation"],
  ["how many units are over 15 years old", "comparator"],
  ["at least five customers have a Trane unit", "comparator"],
  ["under 10 days since the last visit", "comparator"],
  ["greater than 2 units per property", "comparator"],
  ["within 30 days of installation", "comparator"],
  ["how many distinct manufacturers do we carry", "distinct"],
  ["how many unique document types are on file", "distinct"],
  ["what's the newest warranty expiration on file", "superlative"],
  ["what's the oldest install date on file", "superlative"],
  ["earliest service date recorded", "superlative"],
];
const MORE_NEGATIVE = [
  ["how many warranties are active", "negation"],
  ["how many warranties are expired", "negation"],
  ["what's the phone number on file", "negation"],
  ["how many customers do we have in mesa", "comparator"],
  ["what brand is the unit at 100 main st", "comparator"],
  ["how many documents do we have", "distinct"],
  ["how many customers have an email on file", "distinct"],
  ["who installed the unit at 100 main st", "superlative"],
  ["when was the unit serviced", "superlative"],
];
let idx = 0;
for (const [q, t] of MORE_POSITIVE) has(`extra-pos-${idx++}`, q, t);
for (const [q, t] of MORE_NEGATIVE) hasNot(`extra-neg-${idx++}`, q, t);

/* ============================================================ 1b. unit: concepts/registry.js */
const { detectUntrackedConcept } = await import("../api/_lib/concepts/registry.js");
const untracked = (label, q) => check(`untracked concept detected: "${q}"`, Boolean(detectUntrackedConcept(q)), label);
const tracked = (label, q) => check(`NOT flagged as untracked: "${q}"`, detectUntrackedConcept(q) === null, label);

untracked("f6-1", "how many open warranty claims do we have right now");
untracked("f6-2", "what's the claim number on file for the last warranty claim we filed");
untracked("f6-3", "have we sent a renewal reminder on any of the maintenance agreements");
untracked("f6-4", "any renewal notices gone out for the agreements");
untracked("f6-5", "how many units do we have in stock");
untracked("f6-6", "what's our current stock level on filters");
untracked("f6-7", "how much did we spend on payroll this month");
// Never fire for the many real, well-tracked warranty/maintenance-agreement questions:
tracked("f6-no1", "how many warranty registrations do we have");
tracked("f6-no2", "how many units are still under warranty");
tracked("f6-no3", "when does the warranty expire");
tracked("f6-no4", "what's the term on the maintenance agreement");
tracked("f6-no5", "how many maintenance agreements do we have on file");
tracked("f6-no6", "how many units do we have");
tracked("f6-no7", "how many customers do we have");
tracked("f6-no8", "what's the warranty status");

/* ============================================================ 1c. unit: guard/check.js (fake data, no DB) */
const { guardDecomposeAnswer, guardAnalyticsAnswer, isDeclineOrAskWhich } = await import("../api/_lib/router/guard/check.js");

check("isDeclineOrAskWhich: no-answer never blocked", isDeclineOrAskWhich({ kind: "no-answer" }) === true);
check("isDeclineOrAskWhich: ambiguous (candidateCount>1) never blocked", isDeclineOrAskWhich({ kind: "answer", candidateCount: 3, text: "x" }) === true);
check("isDeclineOrAskWhich: 'which one did you mean' text never blocked", isDeclineOrAskWhich({ kind: "answer", text: "Which one did you mean?" }) === true);
check("isDeclineOrAskWhich: an ordinary answer is not a decline", isDeclineOrAskWhich({ kind: "answer", text: "You have 5 customers." }) === false);

{
  // decompose: a purchase-order/work-order clause pair with NO customer scoping — the exact
  // r19_blind3_clusters.json F1 shape (i048/i039/i054, among others). 'namedEntity' is DELIBERATELY not
  // an enforced constraint for decompose (see guardDecomposeAnswer's own doc comment: blocking on it
  // alone can't tell i048 (wrong, expected "yes") apart from i039/i054-i057 (the SAME bug, but correct
  // by coincidence — the named customer genuinely lacks the document either way) — enforcing it would
  // trade 6 wrong->needs-model conversions for 6 correct->needs-model regressions, which
  // R20_CONTRACT.md's "floors: correct up only" forbids. Documented here as a NEGATIVE case precisely so
  // a future change that re-enables it gets caught by this same regression suite.
  const intent = { mode: "filter", conditions: [{ type: "hasDocType", id: "work-order" }, { type: "hasDocType", id: "purchase-order" }] };
  const data = { kind: "answer", text: "No customers have a work order on file and have a purchase order on file.", facts: [{ label: "Customers matching", value: "0" }] };
  const r = guardDecomposeAnswer({ question: "do we have a purchase order on file for the Amy Isaacson account", data, intent, tenantVocab: VOCAB });
  check("guardDecomposeAnswer does NOT block on 'namedEntity' alone (documented limitation, see comment)", r.blocked === false, JSON.stringify(r));

  // A decompose answer whose intent structurally consumes brand/geo but the QUESTION also names a real,
  // enforced constraint type (comparator: "more than 2") that intent.conditions has no representation of
  // at all — this IS caught (comparator is enforced, unlike namedEntity).
  const intentNoComparator = { mode: "filter", conditions: [{ type: "brand", values: ["Trane"] }] };
  const dataNoComparator = { kind: "answer", text: "5 customers have a Trane unit.", facts: [{ label: "Customers matching", value: "5" }] };
  const rComparator = guardDecomposeAnswer({ question: "which customers have more than 2 Trane units", data: dataNoComparator, intent: intentNoComparator });
  check("guardDecomposeAnswer blocks an unconsumed comparator constraint", rComparator.blocked === true, JSON.stringify(rComparator));

  // A decompose answer that DOES structurally consume every enforced constraint (brand + geo, no
  // comparator/distinct/month/negation/superlative named) must never be blocked.
  const intent2 = { mode: "filter", conditions: [{ type: "brand", values: ["Trane"] }, { type: "geoCity", value: "Mesa" }] };
  const data2 = { kind: "answer", text: "3 customers have a Trane unit and have a service address in Mesa.", facts: [{ label: "Customers matching", value: "3" }] };
  const r2 = guardDecomposeAnswer({ question: "which Trane customers are in Mesa", data: data2, intent: intent2 });
  check("guardDecomposeAnswer never blocks a fully-consumed decompose answer", r2.blocked === false, JSON.stringify(r2));

  // A decline must never be blocked even with an unconsumed constraint present.
  const r3 = guardDecomposeAnswer({ question: "which customers have more than 2 Trane units", data: { kind: "no-answer", text: "" }, intent: intentNoComparator });
  check("guardDecomposeAnswer never blocks a genuine decline", r3.blocked === false, JSON.stringify(r3));
}

{
  const fakeTotals = { customers: 120, equipment: 132, documents: 604, serviceVisits: 317 };
  const stub = async (key) => fakeTotals[key] ?? null;

  // month constraint, bare count == full equipment portfolio -> block (i001 shape)
  const r1 = await guardAnalyticsAnswer({
    question: "how many units have we installed so far this year",
    data: { kind: "answer", text: "132 pieces of equipment so far in 2026.", facts: [{ label: "Pieces of equipment", value: "132" }] },
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer blocks a time-window answer equal to the full equipment total (i001 shape)", r1.blocked === true, JSON.stringify(r1));

  // negation constraint, bare count == full customer portfolio -> block (i029 shape)
  const r2 = await guardAnalyticsAnswer({
    question: "how many customers have zero documents of any kind on file",
    data: { kind: "answer", text: "You have 120 customers.", facts: [{ label: "Customers", value: "120" }] },
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer blocks a negated-count answer equal to the full customer total (i029 shape)", r2.blocked === true, JSON.stringify(r2));

  // distinct constraint, answer never says "type"/"distinct" -> block (i030 shape)
  const r3 = await guardAnalyticsAnswer({
    question: "how many distinct document types do we actually track",
    data: { kind: "answer", text: "You have 500 documents.", facts: [{ label: "Documents", value: "500" }] },
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer blocks a distinct-count answer with no 'type' mention (i030 shape)", r3.blocked === true, JSON.stringify(r3));

  // superlative constraint, no date-shaped value -> block (i115 shape)
  const r4 = await guardAnalyticsAnswer({
    question: "what's the earliest warranty registration date we have on file",
    data: { kind: "answer", text: "You have 52 documents.", facts: [{ label: "Documents", value: "52" }] },
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer blocks a superlative-date question answered with a bare count (i115 shape)", r4.blocked === true, JSON.stringify(r4));

  // namedEntity (technician), bare count == full serviceVisits total -> block (i014/i015 shape)
  const r5 = await guardAnalyticsAnswer({
    question: "how many jobs has Denise Ford closed out total",
    data: { kind: "answer", text: "You have 317 service visits.", facts: [{ label: "Service visits", value: "317" }] },
    tenantVocab: VOCAB,
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer blocks a technician-named question answered from the full serviceVisits total (i014/i015 shape)", r5.blocked === true, JSON.stringify(r5));

  // A LEGITIMATELY filtered technician count (not equal to the full total) must never be blocked, even
  // though the rendered text never restates the technician's name (hvac-owner-0054's real shape).
  const r6 = await guardAnalyticsAnswer({
    question: "how many jobs did Danny Ochoa run this month",
    data: { kind: "answer", text: "6 service visits September 2026 (of 28 total).", facts: [{ label: "Service visits", value: "6" }] },
    tenantVocab: VOCAB,
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer never blocks a genuinely filtered technician count", r6.blocked === false, JSON.stringify(r6));

  // A superlative question genuinely answered with a real date must never be blocked.
  const r7 = await guardAnalyticsAnswer({
    question: "what's the earliest warranty registration date we have on file",
    data: { kind: "answer", text: "The earliest warranty registration on file is 2009-01-16.", facts: [{ label: "Earliest warranty registration", value: "2009-01-16" }] },
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer never blocks a genuine date answer to a superlative question", r7.blocked === false, JSON.stringify(r7));

  // A plain, unqualified count (no constraint at all) must never be blocked even though it equals the
  // full portfolio total — this is the single most common analytics shape and must never regress.
  const r8 = await guardAnalyticsAnswer({
    question: "how many customers do we have in total",
    data: { kind: "answer", text: "120 customers on file in total.", facts: [{ label: "Customers", value: "120" }] },
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer never blocks an unqualified bare portfolio count", r8.blocked === false, JSON.stringify(r8));

  // An honest fallback (missOutcome-shaped, no facts) must never be blocked either — isDeclineOrAskWhich
  // already covers 'no-answer'; this covers the 'answer'-kind honest declines (money/maintenance/
  // unsupported-condition) that also carry a restricting-looking word in their own TEXT.
  const r9 = await guardAnalyticsAnswer({
    question: "how many customers have zero documents of any kind on file",
    data: { kind: "answer", text: "I can count customers, but I can't filter by that yet.", facts: [] },
    getPortfolioTotal: stub,
  });
  check("guardAnalyticsAnswer never blocks a facts-less honest fallback (no bare count to compare)", r9.blocked === false, JSON.stringify(r9));
}

/* ============================================================ 2. integration: golden tenant */
let offline;
try {
  offline = await import("./offline-exam.mjs");
} catch (err) {
  console.log(`SKIP  offline-exam.mjs failed to load (${err?.message}). Run npm ci.`);
  process.exit(failures ? 1 : 0);
}

const realWarn = console.warn; console.warn = () => {};
const realErr = console.error; console.error = () => {};
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && (a[0].startsWith('{"route"') || a[0].startsWith('{"event"'))) return; realLog(...a); };

const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant, runOfflineExam, loadFullExam } = offline;
const fs = await import("node:fs");

await installPgHarness();
const modelCounter = await installModelBlock();
const lite = await createPGlite();
await setActiveDatabase(lite);

const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden/golden-export.json"), "utf8"));
// Same order offline-exam.mjs's own CLI uses: the full exam (base + every generalization file, including
// field-phrasing-3.json, the blind-3 set r19_blind3_clusters.json's F1/F6 clusters came from) is resolved
// against the export's OWN tenantKey before the data is loaded into this run's fresh PGlite tenant.
const exam = await loadFullExam(exportData.tenantKey ?? null);
const today = new Date().toISOString().slice(0, 10);
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: "offline-precision-guard", tenantName: "Precision Guard Verify" });

const { overall, perQuestion } = await runOfflineExam({ ctx, questions: exam.questions, today, modelCounter });
console.log = realLog; console.warn = realWarn; console.error = realErr;

const byId = new Map(perQuestion.map((q) => [q.id, q]));

// r19_blind3_clusters.json's named F1/F6 examples (+ two more F1 ids this round's own guard also
// resolved — i002, i011, i014, i015 — same root cause, see this round's final report) must never be
// WRONG again — a decline or needs-model is an acceptable, honest outcome; a confident wrong number is
// the one thing that must never come back.
const MUST_NOT_BE_WRONG = ["i001", "i002", "i011", "i014", "i015", "i029", "i030", "i094", "i096", "i097", "i098", "i115"];
for (const id of MUST_NOT_BE_WRONG) {
  const q = byId.get(id);
  check(`${id} is no longer wrong ("${q?.question ?? "?"}")`, Boolean(q) && q.status !== "wrong", JSON.stringify(q));
}

// F6's two honest-decline ids must actually be CORRECT (a real decline), not merely "not wrong".
for (const id of ["i096", "i097", "i098"]) {
  const q = byId.get(id);
  check(`${id} is a correct honest decline`, q?.status === "correct", JSON.stringify(q));
}

// Shrink-only known-wrong baseline (same convention as scripts/verify-golden.mjs's own KNOWN_WRONG_IDS)
// — R21 M2 UPDATE: this list had gone stale since round 20 (measured at 30 wrong against a 1304-
// question corpus that predated field-phrasing-4.json's addition — 200 more questions). runOfflineExam
// here uses loadFullExam(), which auto-merges EVERY file under test-docs/scorecard/generalization/, so
// this integration run has always covered fp-4 too; the baseline list just never caught up, so this
// check was failing (against the ORIGINAL, unmodified code, not anything from this round) on ids this
// guard never touched — confirmed via `git stash` (83 wrong on the pre-round code, this exact list plus
// this round's now-fixed ids). This round (R21 M2) fixed i093, i095, Cluster 1's 22 brand+city+
// serviceType+time ids, breadth-financials-051 and re-verified several already-correct L3 items; wrong
// dropped 83 -> 32 with ZERO new/unexpected wrong ids (every id below already appeared in the pre-round
// 83, confirmed via the same git-stash comparison). This is now the SAME 32-id set scripts/verify-
// golden.mjs's own KNOWN_WRONG_IDS carries (that file documents each id's own history/root cause) —
// kept in sync with it rather than duplicated at length. Any wrong id NOT in this list is a brand-new
// wrong answer this guard introduced and must be investigated, not silently added here.
const KNOWN_WRONG_IDS = new Set([
  // R31: the four exam-oracle-regex ids left this list when the oracle was fixed at its source (ADJUDICATION.md "R31").
  "h115", "h140",
  "i063", "i065", "i066", "i067", "i069", "i070", "i072", // F2 (dispatch_history compound) — not this round's
  "i188", // F2 (two-field-at-address) — not this round's
  "i195", // F4 (multi-unit) — not this round's
  "g104", "g105", "g149", "g151", "g153", "g155", "h138", "h163", "h167", "i194", // pre-existing, unrelated to this round
  "j055", // pre-existing date-boundary sensitivity under the pinned harness date — unrelated to this round
  "j176", "j178", "j180", // C7 adversarial near-miss fuzzy-name matching — M1's territory (contactLookup.js/scope.js), not touched
  // R21 (review fix): this list's own comment above claims it's "the SAME 32-id set scripts/verify-
  // golden.mjs's own KNOWN_WRONG_IDS carries", but these 3 were missing here — verify-golden.mjs's own
  // P0 trade-off note (its KNOWN_WRONG_IDS, next to its j141-j143 entry) explains why: a bare
  // first+last-name fuzzy match is structurally indistinguishable, at the shape level, from an
  // adversarial near-miss onto a different real customer (M1's near-miss guard, contactLookup.js), so
  // these 3 pre-existing "-typo" ids now decline instead of answering, same as j176/j178/j180 above.
  "live-misses-2026-09-21-0002-typo", "lookups-0101-typo", "lookups-0106-typo",
  "j141", "j142", "j143", // Cluster 3 single-threshold age shape: two incompatible frozen oracles for the
  // same "older/over N years" phrasing (exam.json wants bare calendar-year, field-phrasing-4.json wants
  // day-precise) — see api/_lib/analytics.js's resolveAgeFilter doc comment for the full writeup.
  // R23 (D1, item 4): field-phrasing-5.json's own fresh blind measurement surfaced 5 pre-existing
  // analytics gaps, none of them this round's own doing — see scripts/verify-golden.mjs's own
  // KNOWN_WRONG_IDS comment next to these same 5 ids for the full writeup (a tied technician
  // comparison, a "fewest jobs" ranking that counts a different thing than the plain per-tech total,
  // and no generic "distinct value" metric for an arbitrary field).
  // R24: k139 (tie-safe technician head-to-head), k143 (distinct count), k186/k187 (distinct list)
  // fixed in analytics.js/detPlan.js — removed. k141 stays (same two-oracle conflict as h115).
  "k141",
]);
const wrongIds = perQuestion.filter((q) => q.status === "wrong").map((q) => q.id);
const newWrong = wrongIds.filter((id) => !KNOWN_WRONG_IDS.has(id));
check(
  `no NEW wrong ids beyond the documented shrink-only baseline (${wrongIds.length} wrong total)`,
  newWrong.length === 0,
  `unexpected new wrong ids: ${JSON.stringify(newWrong)}`
);
check(
  `wrong count has not regressed above the measured floor (got ${overall.wrong}, floor ${KNOWN_WRONG_IDS.size})`,
  overall.wrong <= KNOWN_WRONG_IDS.size,
  JSON.stringify(overall)
);
check(`correct count has not regressed below this round's measured floor (got ${overall.correct}, floor 936)`, overall.correct >= 936, JSON.stringify(overall));
check(`answered-without-model has not regressed below the pre-round floor's "genuinely correct" share (got ${overall.answeredWithoutModel})`, overall.answeredWithoutModel >= 900, JSON.stringify(overall));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
