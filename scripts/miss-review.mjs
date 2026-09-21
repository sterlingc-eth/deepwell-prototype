#!/usr/bin/env node
/**
 * Weekly miss review (Day 2 training plan,
 * handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): takes the JSON
 * `api/review.js`'s `exportMisses` action returns (or the raw
 * `{outcome, question, question_normalized}[]` shape a direct DB export
 * would give), dedupes by normalized text, classifies each one the SAME way
 * scripts/verify-question-bank.mjs's own `classify()` does — a contact-lookup
 * shape or a single-record reference is 'lookup', a preClassifyAnalytics hit
 * is 'analytics', everything else is 'retrieval' — and prints one candidate
 * `test-docs/question-bank/bank.json`-shaped entry per distinct question,
 * ready to paste into a new category there. Zero model calls, zero database
 * calls: this is pure classification over text someone already exported.
 *
 * Usage:
 *   node scripts/miss-review.mjs path/to/exported-misses.json
 *   node scripts/miss-review.mjs path/to/exported-misses.json --json   # machine-readable, no table
 *
 * Accepted input shapes (auto-detected):
 *   { "items": [{ "text": "...", "suggestedRoute": "..." }, ...] }   (exportMisses)
 *   [{ "text": "..." }, ...]
 *   [{ "question_normalized": "...", "question": "...", "outcome": "..." }, ...]  (raw ask_misses rows)
 */
import { readFileSync } from 'node:fs';
import { normalizeQuestion } from '../api/_lib/nlNormalize.js';
import { preClassifyAnalytics, looksLikeSingleRecordReference } from '../api/_lib/analytics.js';
import { parseContactLookupQuestion } from '../api/_lib/contactLookup.js';

const [, , inputPath, ...flags] = process.argv;
const AS_JSON = flags.includes('--json');

if (!inputPath) {
  console.error('Usage: node scripts/miss-review.mjs <exported-misses.json> [--json]');
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(readFileSync(inputPath, 'utf8'));
} catch (err) {
  console.error(`Could not read/parse ${inputPath}: ${err.message}`);
  process.exit(1);
}

/** Normalizes any of the accepted input shapes down to a flat list of raw
 *  question strings — never trusts a pre-computed suggestedRoute from the
 *  export (that's outcome-based, not text-based; this script re-derives the
 *  route from the text itself, the same way the real classifier would see a
 *  fresh phrasing of it). */
function extractTexts(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return list
    .map((row) => (typeof row === 'string' ? row : row?.text ?? row?.question_normalized ?? row?.question))
    .filter((t) => typeof t === 'string' && t.trim());
}

/** Mirrors scripts/verify-question-bank.mjs's own classify() exactly — see
 *  that file's doc comment for why contact-lookup and single-record both
 *  outrank preClassifyAnalytics regardless of what its own regexes say. */
function classify(rawText) {
  const { normalized } = normalizeQuestion(rawText);
  const isContactLookup = Boolean(parseContactLookupQuestion(rawText));
  const isSingleRecord = looksLikeSingleRecordReference(rawText);
  const isAnalytics = !isContactLookup && !isSingleRecord && preClassifyAnalytics(normalized);
  const route = isAnalytics ? 'analytics' : isContactLookup || isSingleRecord ? 'lookup' : 'retrieval';
  return { normalized, route };
}

const texts = extractTexts(raw);
const seen = new Map(); // normalized -> { rawText, route, count }
for (const text of texts) {
  const { normalized, route } = classify(text);
  if (!seen.has(normalized)) seen.set(normalized, { rawText: text, route, count: 0 });
  seen.get(normalized).count += 1;
}

const entries = [...seen.values()].sort((a, b) => b.count - a.count);

function toBankEntry(e, idx) {
  return {
    id: `miss-review-${String(idx + 1).padStart(4, '0')}`,
    base: e.rawText,
    text: e.rawText,
    variant: 'from-miss-review',
    category: 'miss-review',
    // expect.route is a suggestion, not a verified answer — a human still
    // fills in entity/filters/answerValue (analytics) or the real value
    // (lookup) before this is a usable bank entry; see gen-question-bank.mjs
    // for that shape.
    expect: { route: e.route },
  };
}

if (AS_JSON) {
  console.log(JSON.stringify(entries.map(toBankEntry), null, 2));
  process.exit(0);
}

console.log(`\n${entries.length} distinct question(s) from ${texts.length} miss row(s) in ${inputPath}\n`);

const byRoute = new Map();
for (const e of entries) byRoute.set(e.route, (byRoute.get(e.route) ?? 0) + 1);
console.log('By suggested route:');
for (const [route, n] of [...byRoute.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${route.padEnd(10)} ${n}`);
}
console.log('');

entries.forEach((e, idx) => {
  const bankEntry = toBankEntry(e, idx);
  console.log(`[${e.route}] (${e.count}x) "${e.rawText}"`);
  console.log(`  ${JSON.stringify(bankEntry)}`);
});

console.log(
  `\n${entries.length} candidate entries printed. Copy the ones worth keeping into ` +
    'test-docs/question-bank/bank.json (fill in entity/filters/answerValue for analytics, ' +
    'or the real value for lookup) and re-run npm run verify:question-bank.'
);
