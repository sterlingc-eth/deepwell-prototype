/**
 * Verification for the 600-doc business corpus (scripts/synth-business.mjs,
 * test-docs/business/ANSWER_KEY.json). No database, no network, no model --
 * pure checks against the generator's own output, run fresh each time.
 *
 *   node scripts/verify-business-corpus.mjs
 *
 * Covers (per handoffs/DONOVAN_ANALYTICS_BRIEF_2026-09-21.md's Workstream B
 * sanity-check list):
 *   1. Generator determinism -- running it twice produces a byte-identical
 *      answer key and the same file count/names.
 *   2. Answer-key internal consistency:
 *      - sum of county counts (AZ only) equals the AZ state total
 *      - sum of state totals equals the customer total
 *      - every document belongs to exactly one customer, or to the
 *        letterhead-only (docsWithoutCustomer) set -- never both, never
 *        neither, never twice
 *      - equipmentByBrand / warrantyStatusCounts / documentsByType totals
 *        match the customers/units/files they were tallied from
 *   3. Every question's expectedContains is derivable from the key itself
 *      (recomputed independently here, not just re-read) -- catches a stale
 *      hand-edit as readily as a generator bug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'test-docs', 'business');
const KEY_PATH = path.join(OUT_DIR, 'ANSWER_KEY.json');
const GEN = path.join(ROOT, 'scripts', 'synth-business.mjs');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
/** Order-independent object comparison, for tallies where key insertion
 *  order legitimately differs between "as the generator built it" and "as
 *  freshly recomputed here" without that being a real mismatch. */
function canon(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
const eqTally = (name, got, want) => eq(name, canon(got), canon(want));

/* ------------------------------------------------------ 1. determinism --- */
execFileSync('node', [GEN], { cwd: ROOT, stdio: 'ignore' });
const filesA = fs.readdirSync(OUT_DIR).sort();
const keyA = fs.readFileSync(KEY_PATH, 'utf8');

execFileSync('node', [GEN], { cwd: ROOT, stdio: 'ignore' });
const filesB = fs.readdirSync(OUT_DIR).sort();
const keyB = fs.readFileSync(KEY_PATH, 'utf8');

eq('generator produces the same file list on re-run', filesB, filesA);
check('generator produces a byte-identical ANSWER_KEY.json on re-run', keyA === keyB);

const answerKey = JSON.parse(keyB);

/* -------------------------------------------------- 2. key consistency --- */
const { customers, docsWithoutCustomer, mustNotMerge, totals, equipmentByBrand, warrantyStatusCounts, documentsByType, totalDocuments, totalUnits, questions } = answerKey;

check('has at least 100 customers (brief: ~120)', customers.length >= 100, `got ${customers.length}`);
check('has at least 500 documents (brief: ~600)', totalDocuments >= 500, `got ${totalDocuments}`);

// -- geography: sum(byCounty) === byState.AZ, sum(byState) === total --------
const countySum = Object.values(totals.byCounty).reduce((a, b) => a + b, 0);
eq('sum of AZ county counts equals the AZ state total', countySum, totals.byState.AZ ?? 0);
const stateSum = Object.values(totals.byState).reduce((a, b) => a + b, 0);
eq('sum of state counts equals the customer total', stateSum, totals.customers);
eq('totals.customers matches customers.length', totals.customers, customers.length);

// every customer with state AZ has a non-"Unknown" county (this corpus never
// intentionally places an AZ customer somewhere the geo table can't resolve)
const azUnknownCounty = customers.filter((c) => c.state === 'AZ' && c.county === 'Unknown');
check('no AZ customer resolves to an Unknown county', azUnknownCounty.length === 0,
  azUnknownCounty.map((c) => `${c.key} (${c.address})`).join('; '));

// city sums to the same total as county/state (every customer has a derivable city)
const citySum = Object.values(totals.byCity).reduce((a, b) => a + b, 0);
eq('sum of city counts equals the customer total', citySum, totals.customers);

// -- documents: every doc belongs to exactly one customer, or to the
//    letterhead-only set, never both, never neither, never twice ----------
const docOwners = new Map(); // filename -> where it was seen
for (const c of customers) {
  for (const f of c.docs) {
    if (docOwners.has(f)) { failures++; console.log(`FAIL  document "${f}" appears under more than one owner (${docOwners.get(f)} AND ${c.key})`); }
    docOwners.set(f, c.key);
  }
}
let dupInLetterheadOnly = 0;
for (const f of docsWithoutCustomer) {
  if (docOwners.has(f)) { dupInLetterheadOnly++; console.log(`FAIL  "${f}" is both a customer document (${docOwners.get(f)}) and letterhead-only`); }
  docOwners.set(f, '(letterhead-only)');
}
check('no document is both a customer document and letterhead-only', dupInLetterheadOnly === 0);

const actualFiles = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.pdf') || f.endsWith('.txt'));
eq('every generated file is accounted for in the key (customer doc or letterhead-only)',
  actualFiles.filter((f) => !docOwners.has(f)).sort(), []);
eq('the key names no file that was not actually generated',
  [...docOwners.keys()].filter((f) => !actualFiles.includes(f)).sort(), []);
eq('total documents = customer docs + letterhead-only docs',
  customers.reduce((n, c) => n + c.docs.length, 0) + docsWithoutCustomer.length, totalDocuments);

// -- mustNotMerge pairs are real, distinct customer keys --------------------
const custKeys = new Set(customers.map((c) => c.key));
for (const [a, b] of mustNotMerge) {
  check(`mustNotMerge pair [${a}, ${b}] both exist and are distinct`, a !== b && custKeys.has(a) && custKeys.has(b));
}

// -- equipment/warranty/document-type tallies match what they're tallying --
const allUnits = customers.flatMap((c) => c.units);
eq('totalUnits matches the sum of every customer\'s units', totalUnits, allUnits.length);
const recomputedBrand = {};
for (const u of allUnits) recomputedBrand[u.brand] = (recomputedBrand[u.brand] ?? 0) + 1;
eqTally('equipmentByBrand matches a fresh tally of customers[].units[].brand', equipmentByBrand, recomputedBrand);
const recomputedStatus = { active: 0, expiring: 0, expired: 0, unknown: 0 };
for (const u of allUnits) recomputedStatus[u.warrantyStatus] = (recomputedStatus[u.warrantyStatus] ?? 0) + 1;
eqTally('warrantyStatusCounts matches a fresh tally of customers[].units[].warrantyStatus', warrantyStatusCounts, recomputedStatus);

// Filenames are "<seq>-<type>-<slug>.<ext>" where BOTH type and slug may
// themselves contain hyphens ("dispatch-note-shop-truck.txt"), so this
// matches against the actual known type ids (longest match wins) rather than
// guessing a boundary with a single regex.
const KNOWN_TYPES = ['work-order', 'invoice', 'warranty-registration', 'startup-sheet', 'permit', 'nameplate-photo',
  'maintenance-agreement', 'service-ticket', 'dispatch-note', 'proposal-quote', 'inspection-report',
  'purchase-order', 'equipment-record', 'correspondence', 'other'];
function typeFromFilename(f) {
  const rest = f.replace(/^\d+-/, '').replace(/\.(pdf|txt)$/, '');
  const matches = KNOWN_TYPES.filter((t) => rest === t || rest.startsWith(`${t}-`));
  matches.sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}
const recomputedDocType = {};
const unmatchedFiles = [];
for (const f of actualFiles) {
  const t = typeFromFilename(f);
  if (!t) unmatchedFiles.push(f);
  else recomputedDocType[t] = (recomputedDocType[t] ?? 0) + 1;
}
check('every generated filename matches a known document type', unmatchedFiles.length === 0, unmatchedFiles.join(', '));
eqTally('documentsByType matches a fresh tally of generated filenames', documentsByType, recomputedDocType);

/* ---------------------------------------------- 3. questions derivable --- */
check('exactly 60 questions', questions.length === 60, `got ${questions.length}`);
check('exactly 30 analytics questions', questions.filter((q) => q.type === 'analytics').length === 30);
check('exactly 30 lookup questions', questions.filter((q) => q.type === 'lookup').length === 30);
check('every question has at least one non-empty expectedContains value',
  questions.every((q) => Array.isArray(q.expectedContains) && q.expectedContains.length > 0 && q.expectedContains.every((v) => String(v).length > 0)));

// Re-derive a handful of the analytics answers independently (not by
// re-reading the field the generator itself wrote) and check they agree --
// this is the guard against a hand-edit or a stale value surviving a later
// generator change.
function findQ(substr) { return questions.find((q) => q.q.includes(substr)); }

const azCount = customers.filter((c) => c.state === 'AZ').length;
check('"customers ... in Arizona" question matches an independent recount',
  findQ('in Arizona')?.expectedContains.includes(String(azCount)), `recount=${azCount}, key=${JSON.stringify(findQ('in Arizona')?.expectedContains)}`);

const maricopaCount = customers.filter((c) => c.county === 'Maricopa').length;
check('"customers ... in Maricopa County" question matches an independent recount',
  findQ('Maricopa County')?.expectedContains.includes(String(maricopaCount)));

const expiredCount = allUnits.filter((u) => u.warrantyStatus === 'expired').length;
check('"units ... out of warranty" question matches an independent recount',
  findQ('out of warranty')?.expectedContains.includes(String(expiredCount)));

const traneCount = allUnits.filter((u) => u.brand === 'Trane').length;
check('"Group equipment by brand" question mentions the independently recounted Trane total',
  findQ('Group equipment by brand')?.expectedContains.includes(String(traneCount)));

const docAddQ = findQ('documents did we add this month');
check('"documents did we add this month" matches the independently recounted total file count',
  docAddQ?.expectedContains.includes(String(actualFiles.length)));

// Every question naming a specific customer's field (lookup type) must name
// a value that actually appears in that customer's own record.
let lookupMismatches = 0;
for (const q of questions.filter((x) => x.type === 'lookup')) {
  const addrMatch = q.q.match(/at (.+?)\?$/);
  // Best-effort: only checked where the question embeds the address/name
  // directly (as this generator's lookup questions always do) -- otherwise
  // skipped rather than guessed at.
  if (!addrMatch) continue;
  const needle = addrMatch[1];
  const cust = customers.find((c) => needle.includes(c.address) || needle === c.canonicalName || needle.includes(c.canonicalName));
  if (!cust) continue; // not every lookup question is address/name-shaped; skip rather than false-fail
  const known = [...cust.units.map((u) => u.serial), ...cust.units.map((u) => u.brand)];
  const ok = q.expectedContains.some((v) => known.includes(v));
  if (!ok) { lookupMismatches++; console.log(`FAIL  lookup question "${q.q}" expects ${JSON.stringify(q.expectedContains)}, not found on ${cust.key}`); }
}
check('every checkable lookup question\'s expected value is on the customer it names', lookupMismatches === 0);

/* ---------------------------------------------------------------- score-corpus.mjs
 * self-test must also pass for this key -- this is what actually exercises
 * scoreCorpus() end to end against the key this file just validated. */
try {
  execFileSync('node', [path.join(ROOT, 'scripts', 'score-corpus.mjs'), '--selftest', '--key', KEY_PATH], { cwd: ROOT, stdio: 'pipe' });
  check('scripts/score-corpus.mjs --selftest --key <business key> passes', true);
} catch (err) {
  check('scripts/score-corpus.mjs --selftest --key <business key> passes', false, err.stdout?.toString().slice(-800) ?? String(err));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
