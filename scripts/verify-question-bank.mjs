#!/usr/bin/env node
/**
 * Runs test-docs/question-bank/bank.json through the normalization +
 * pre-classifier pipeline with ZERO model calls (no Haiku planner, no DB) —
 * see handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md, Day 1.
 *
 * For every entry:
 *   1. normalize the text (nlNormalize.js)
 *   2. decide the route the SAME way api/ask.js's analytics gate does:
 *        !looksLikeSingleRecordReference(rawText) && preClassifyAnalytics(normalized)
 *      and compare it against expect.route ('analytics' vs. 'lookup'/'retrieval',
 *      both of which mean "must not route to analytics")
 *   3. for entries that name a specific record (expect.singleRecord), assert
 *      looksLikeSingleRecordReference(rawText) is true
 *   4. for analytics entries with an expected timeRange, assert
 *      resolveQuestionTimeRange(normalized, TODAY) matches it
 *   5. for analytics entries with conditionsOnly, assert detectedConditions
 *      (normalized) is a SUPERSET of every listed condition
 *
 * Always exits 0 (prints the honest baseline number even at 0%), unless
 * --strict is passed, in which case it exits 1 below 99%.
 *
 *   node scripts/verify-question-bank.mjs [--strict]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeQuestion } from '../api/_lib/nlNormalize.js';
import {
  preClassifyAnalytics,
  looksLikeSingleRecordReference,
  resolveQuestionTimeRange,
  detectedConditions,
  isMoneyQuestion,
} from '../api/_lib/analytics.js';
import { parseContactLookupQuestion } from '../api/_lib/contactLookup.js';

/** filter `field` -> the detectedConditions(question) name it corresponds to
 *  (analytics.js) — used below to check a follow-up/two-condition entry's
 *  plan actually named every condition detectedConditions can independently
 *  recognize in the question text. city/county/state/zip/warrantyStatus/
 *  installYear/documentType/customerName have no such correspondence (there
 *  is no detectedConditions() bit for "names a city" the way there is for
 *  "names an email/phone/brand/county/month word") so they are simply
 *  skipped — see this file's own header comment, Step 2. */
const FILTER_FIELD_TO_CONDITION = {
  brand: 'brand', county: 'county', hasEmail: 'email', hasPhone: 'phone',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANK_PATH = join(__dirname, '..', 'test-docs', 'question-bank', 'bank.json');
const TODAY = '2026-09-21'; // same fixed "today" gen-question-bank.mjs computed timeRanges against

const STRICT = process.argv.includes('--strict');

const bank = JSON.parse(readFileSync(BANK_PATH, 'utf8'));

/** Mirrors api/ask.js's analytics gate exactly (see that file's
 *  `analyticsCandidate`) — the single-record guard runs against the RAW
 *  text (capitalization is the only signal SINGULAR_NAMED_RECORD_RE has),
 *  the vocabulary classifier runs against the NORMALIZED text.
 *
 * Live miss cluster 1 (2026-09-21) added a contact-lookup gate AHEAD of
 * preClassifyAnalytics in the real ask.js: a contact-lookup shape never
 * reaches the analytics gate at all, regardless of what preClassifyAnalytics
 * alone would say (e.g. "on file" contains the word "file", one of
 * AGGREGATE_NOUN's own document synonyms, so "show me what's the phone
 * number on file for X" matches QUANTIFIER+AGGREGATE_NOUN on its own —
 * harmless in production only because contactLookupIntent is checked first
 * there). Mirrored here too. The money gate is NOT mirrored the same way:
 * every 'money' bank entry that expects route 'analytics' documents "this
 * phrasing matches preClassifyAnalytics's own vocabulary", which is still
 * true even though api/ask.js's money gate now answers it first — see the
 * 'money' category's own entries (gen-question-bank.mjs). */
function classify(rawText) {
  const { normalized } = normalizeQuestion(rawText);
  const isContactLookup = Boolean(parseContactLookupQuestion(rawText));
  const isAnalytics =
    !isContactLookup && !looksLikeSingleRecordReference(rawText) && preClassifyAnalytics(normalized);
  return { normalized, isAnalytics, isContactLookup };
}

/** Step 2 (HVAC persona bank, 2026-09-21): an entry naming a capability this
 *  product genuinely doesn't have yet (a relative day-window, "this quarter",
 *  a min/max op, a cross-document-type filter, ...) can only ever be verified
 *  live against a real answer — the honest-fallback TEXT itself is checked by
 *  scripts/verify-analytics.mjs, not here, which has no database. Offline,
 *  the only thing worth asserting is that the question actually REACHES that
 *  fallback (routes to analytics/lookup as expected) rather than silently
 *  falling through to an unfiltered/wrong-looking answer — so these are
 *  scored on routing alone, skipping the singleRecord/timeRange/conditions
 *  checks below that a genuinely-supported entry still has to pass. */
function isNeedsCapability(entry) {
  return Boolean(entry.expect?.unsupported) || (entry.tags ?? []).includes('time-window-unsupported');
}

const results = [];
for (const entry of bank) {
  const { normalized, isAnalytics, isContactLookup } = classify(entry.text);
  const expectAnalytics = entry.expect?.route === 'analytics';
  const reasons = [];
  const needsCapability = isNeedsCapability(entry);

  if (needsCapability) {
    // A money question is answered by api/ask.js's own money gate BEFORE the
    // analytics classifier ever runs (see analytics.js's isMoneyQuestion doc
    // comment) — reaching that gate is just as much "honest routing achieved"
    // as reaching the analytics unsupported-condition fallback is, so either
    // satisfies this relaxed check regardless of what expect.route literally
    // says (some live-miss money entries say 'lookup', the HVAC bank's own
    // bookkeeper money entries say 'analytics' — both really mean "the
    // dispatcher gets an honest answer, never a fabricated one").
    const routed = isAnalytics === expectAnalytics || isMoneyQuestion(normalized);
    if (!routed) reasons.push(expectAnalytics ? 'needs-capability:missed-analytics' : 'needs-capability:false-positive-analytics');
    results.push({ entry, pass: reasons.length === 0, reasons, needsCapability });
    continue;
  }

  if (isAnalytics !== expectAnalytics) {
    reasons.push(expectAnalytics ? 'route:missed-analytics' : 'route:false-positive-analytics');
  }

  // Step 2: a bare-name contact-style lookup ("thornton phone", "pull up
  // Thornton", "what do we have on file for Amy Isaacson") is only a real
  // PASS when it actually reaches a handler that can answer it — either
  // contactLookup.js's own shape detection, or the (address/serial/named-
  // record) singleRecord signal fastPath/retrieval key off. Not routing to
  // analytics alone (the old, weaker check) says nothing about whether the
  // question reaches anything at all.
  if (entry.expect?.route === 'lookup') {
    // A handful of older money entries spell their expectation
    // `{ route: 'lookup', conditionsOnly: ['money'] }` — not a contact/
    // single-record lookup at all, but the money gate's own honest fallback
    // (api/ask.js checks isMoneyQuestion BEFORE contactLookup/analytics ever
    // run — same "reaching the honest gate is the real pass" reasoning the
    // needsCapability branch above already applies). Checking contactLookup/
    // singleRecord shape for these would always fail regardless of any real
    // routing fix, since neither shape was ever what they're asking about.
    const isMoneyLookup = (entry.expect?.conditionsOnly ?? []).includes('money');
    const routedSomewhere =
      isContactLookup || looksLikeSingleRecordReference(entry.text) || (isMoneyLookup && isMoneyQuestion(normalized));
    if (!routedSomewhere) reasons.push('lookup:not-routed');
  }

  if (entry.expect?.singleRecord === true) {
    // contactLookup.js resolving the question is just as much "this reaches
    // a real single-record answer" as looksLikeSingleRecordReference saying
    // so — e.g. "Pull up Thornton" (expect.route 'retrieval') is answered by
    // contactLookup's own "full record" shape, never by an address/serial
    // signal at all.
    if (!looksLikeSingleRecordReference(entry.text) && !isContactLookup) reasons.push('single-record:not-detected');
  }

  if (expectAnalytics && entry.expect?.timeRange !== undefined) {
    const got = resolveQuestionTimeRange(normalized, TODAY);
    if (JSON.stringify(got) !== JSON.stringify(entry.expect.timeRange)) {
      reasons.push('timeRange:mismatch');
    }
  }

  if (expectAnalytics && Array.isArray(entry.expect?.conditionsOnly) && entry.expect.conditionsOnly.length) {
    const got = detectedConditions(normalized);
    const missing = entry.expect.conditionsOnly.filter((c) => !got.has(c));
    if (missing.length) reasons.push('conditions:missing');
  }

  // Step 2: for a follow-up/two-condition entry, assert detectedConditions
  // is a SUPERSET of every filter field that has a known detectedConditions
  // mapping (FILTER_FIELD_TO_CONDITION, above) — i.e. the question's own text
  // actually names every condition its expected plan filters on, so a plan
  // that silently dropped one (missingConditions, analytics.js) would be
  // caught the same way it is live. city/county-less filters (city/state/
  // zip/warrantyStatus/installYear) have no such mapping and are skipped.
  const tags = entry.tags ?? [];
  if (expectAnalytics && (tags.includes('two-condition') || tags.includes('follow-up')) && Array.isArray(entry.expect?.filters)) {
    const expectedConditions = entry.expect.filters
      .map((f) => FILTER_FIELD_TO_CONDITION[f.field])
      .filter(Boolean);
    if (expectedConditions.length) {
      const got = detectedConditions(normalized);
      const missing = expectedConditions.filter((c) => !got.has(c));
      if (missing.length) reasons.push('conditions:missing-two-condition');
    }
  }

  results.push({ entry, pass: reasons.length === 0, reasons, needsCapability });
}

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const pct = total ? (100 * passed) / total : 100;

/* ---- per-category / per-variant tables ---------------------------------- */
function tableBy(keyFn, rows = results) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyFn(r.entry);
    if (k == null) continue;
    if (!buckets.has(k)) buckets.set(k, { total: 0, pass: 0 });
    const b = buckets.get(k);
    b.total++;
    if (r.pass) b.pass++;
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  const nameW = Math.max(...rows.map(([k]) => k.length), 8);
  for (const [k, { total: t, pass: p }] of rows) {
    const rate = t ? ((100 * p) / t).toFixed(1) : '0.0';
    console.log(`  ${k.padEnd(nameW)}  ${String(p).padStart(5)}/${String(t).padEnd(5)}  ${rate.padStart(5)}%`);
  }
}

printTable('Per category:', tableBy((e) => e.category));
printTable('Per variant:', tableBy((e) => e.variant));

/* ---- per-persona / per-tag tables (HVAC persona bank, Step 1) ------------ */
function tableByMulti(keysFn) {
  const buckets = new Map();
  for (const r of results) {
    for (const k of keysFn(r.entry)) {
      if (!buckets.has(k)) buckets.set(k, { total: 0, pass: 0 });
      const b = buckets.get(k);
      b.total++;
      if (r.pass) b.pass++;
    }
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const personaRows = tableBy((e) => e.persona);
if (personaRows.length) printTable('Per persona (HVAC bank):', personaRows);

const tagRows = tableByMulti((e) => e.tags ?? []);
if (tagRows.length) printTable('Per tag (HVAC bank):', tagRows);

/* ---- failure clusters ---------------------------------------------------- */
const failures = results.filter((r) => !r.pass);
const byCause = new Map();
for (const f of failures) {
  const cause = f.reasons.join('+');
  if (!byCause.has(cause)) byCause.set(cause, []);
  byCause.get(cause).push(f);
}
console.log('\nFailure clusters (by cause):');
for (const [cause, list] of [...byCause.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${cause}: ${list.length}`);
}

console.log('\nUp to 40 failing questions (grouped by likely cause):');
let shown = 0;
for (const [cause, list] of [...byCause.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (shown >= 40) break;
  console.log(`\n  -- ${cause} (${list.length} total) --`);
  for (const f of list.slice(0, Math.min(8, 40 - shown))) {
    console.log(`     [${f.entry.category}/${f.entry.variant}] "${f.entry.text}"`);
    shown++;
    if (shown >= 40) break;
  }
}

/* ---- "Needs capability" section (Step 1/2, HVAC persona bank) -----------
 * Every entry with expect.unsupported or the time-window-unsupported tag is
 * scored above on routing alone (isNeedsCapability) — the actual honest-
 * fallback TEXT is a live check (scripts/verify-analytics.mjs), not this
 * offline one. Grouped by `note` (why it's unsupported) and by tag, each
 * counted both by distinct base question and by total bank entry (8 variants
 * each), so this reads as "N missing capabilities affecting M base
 * questions" rather than an inflated per-variant count. */
const needsCapResults = results.filter((r) => r.needsCapability);
if (needsCapResults.length) {
  const needsCapPassed = needsCapResults.filter((r) => r.pass).length;
  const needsCapBases = new Set(needsCapResults.map((r) => r.entry.base)).size;
  console.log(
    `\nNeeds capability: ${needsCapPassed}/${needsCapResults.length} entries routed correctly ` +
      `(${needsCapBases} distinct base questions; the honest-fallback wording itself is verified live, not offline)`
  );

  const byNote = new Map();
  for (const r of needsCapResults) {
    const note = r.entry.expect?.note ?? '(no note)';
    if (!byNote.has(note)) byNote.set(note, { entries: 0, bases: new Set() });
    const b = byNote.get(note);
    b.entries++;
    b.bases.add(r.entry.base);
  }
  console.log('\nNeeds capability, by note:');
  for (const [note, { entries, bases }] of [...byNote.entries()].sort((a, b) => b[1].bases.size - a[1].bases.size)) {
    console.log(`  ${bases.size} base q${bases.size === 1 ? '' : 's'} (${entries} entries) — ${note}`);
  }

  const byTag = new Map();
  for (const r of needsCapResults) {
    for (const t of r.entry.tags ?? []) {
      if (!byTag.has(t)) byTag.set(t, { entries: 0, bases: new Set() });
      const b = byTag.get(t);
      b.entries++;
      b.bases.add(r.entry.base);
    }
  }
  if (byTag.size) {
    console.log('\nNeeds capability, by tag:');
    for (const [tag, { entries, bases }] of [...byTag.entries()].sort((a, b) => b[1].bases.size - a[1].bases.size)) {
      console.log(`  ${tag}: ${bases.size} base qs (${entries} entries)`);
    }
  }
}

console.log(`\nQUESTION BANK: ${passed}/${total} (${pct.toFixed(2)}%)`);

if (STRICT && pct < 99) {
  console.error(`--strict: ${pct.toFixed(2)}% is below the 99% bar`);
  process.exit(1);
}
process.exit(0);
