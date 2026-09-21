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
} from '../api/_lib/analytics.js';
import { parseContactLookupQuestion } from '../api/_lib/contactLookup.js';

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
  return { normalized, isAnalytics };
}

const results = [];
for (const entry of bank) {
  const { normalized, isAnalytics } = classify(entry.text);
  const expectAnalytics = entry.expect?.route === 'analytics';
  const reasons = [];

  if (isAnalytics !== expectAnalytics) {
    reasons.push(expectAnalytics ? 'route:missed-analytics' : 'route:false-positive-analytics');
  }

  if (entry.expect?.singleRecord === true) {
    if (!looksLikeSingleRecordReference(entry.text)) reasons.push('single-record:not-detected');
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

  results.push({ entry, pass: reasons.length === 0, reasons });
}

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const pct = total ? (100 * passed) / total : 100;

/* ---- per-category / per-variant tables ---------------------------------- */
function tableBy(keyFn) {
  const buckets = new Map();
  for (const r of results) {
    const k = keyFn(r.entry);
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

console.log(`\nQUESTION BANK: ${passed}/${total} (${pct.toFixed(2)}%)`);

if (STRICT && pct < 99) {
  console.error(`--strict: ${pct.toFixed(2)}% is below the 99% bar`);
  process.exit(1);
}
process.exit(0);
