/**
 * Round 21 part 2 (M1, PRIORITY 0 + L4 rubric bugs) — own tests for:
 *
 *   1. Near-miss customer names (fp-4 cluster 5, ../r21_blind4_clusters.json C7): a name one edit
 *      away from a real customer must NEVER answer as that (or any other) real customer with full
 *      confidence/PII. resolveNamedCustomers (api/_lib/contactLookup.js) declines with up to 3
 *      candidate NAMES only (no address/phone), unless exactly one candidate is corroborated by an
 *      address/serial stated elsewhere in the same question. ≥20 own near-miss pairs, hand-built from
 *      scripts/golden/golden-export.json's own real customer names (never from any exam file) +
 *      negatives (exact match, corroborated fuzzy, bare-surname broad search) proving the guard is
 *      scoped correctly and leaks no PII.
 *   2. Explicit future year in a question (fp-4 cluster 6, C8): a caller naming a manifestly future
 *      year gets an honest "that's in the future" note instead of silence. ≥5 own paraphrases +
 *      negatives (scope.js's pure explicitFutureYearInQuestion, plus one end-to-end honest-zero path).
 *   3. L4 rubric bugs in M1's own ownership (see scripts/verify-golden.mjs's own "R21 rubric grader
 *      baseline" comment): multi-unit refrigerant partial report, install dates on file but omitted,
 *      installer/warranty compound questions omitting a stated half or fabricating an installer from
 *      an unrelated service visit's technician.
 *
 * Same harness convention as scripts/verify-vocab.mjs / debug-one.mjs: a REAL Postgres (PGlite) loaded
 * from scripts/golden/golden-export.json's own real tenant data, through scripts/offline-exam.mjs's
 * own installPgHarness/installModelBlock/createPGlite/loadExportIntoNewTenant — no network, no model.
 *
 *   node scripts/verify-lookups-r21b.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const TODAY = '2026-09-25'; // the same pinned date scripts/verify-golden.mjs uses

const offline = await import('./offline-exam.mjs');
const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
await installPgHarness();
installModelBlock();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: 'offline:verify-lookups-r21b', tenantName: 'Verify Lookups R21B' });

const { withTenant } = await import('./../api/_lib/recordsStore.js');
const { resolveNamedCustomers } = await import('../api/_lib/contactLookup.js');
const { explicitFutureYearInQuestion } = await import('../api/_lib/scope.js');
const { runDocLookup } = await import('../api/_lib/docLookup.js');
const { askViaHandler } = await import('../api/_lib/scorecard/askCall.js');
const { default: askHandler } = await import('../api/ask.js');
const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };

const withDb = (fn) => withTenant(ctx, fn);
const ask = (question) => askViaHandler({ handler: askHandler, auth, question, today: TODAY });

// A phone or street-number pattern in the answer text/facts would mean a decline leaked PII.
const PHONE_RE = /\b\d{3}[.-]\d{3,4}\b/;
const STREET_NO_RE = /\b\d{2,6}\s+[NSEW]?\s*[A-Za-z]/;
const declineHasNoPii = (d) => {
  const hay = `${d.text} ${(d.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
  return (d.facts ?? []).length === 0 && !PHONE_RE.test(hay) && !STREET_NO_RE.test(hay);
};

/* ============================================================ 1. near-miss name guard */

// [typo, targetRealName] — every typo is exactly one edit (letter swap/insert/delete/substitute)
// from ONE real customer in golden-export.json and does not collide with another. Hand-built by
// M1, never copied from any exam file.
const NEAR_MISS_PAIRS = [
  ['Karen Abernathey', 'Karen Abernathy'],
  ['Kevin Abernathey', 'Kevin Abernathy'],
  ['Kevin Zimmermann', 'Kevin Zimmerman'],
  ['Joseph Norwod', 'Joseph Norwood'],
  ['Rebecca Norwod', 'Rebecca Norwood'],
  ['Kenneth Gallrado', 'Kenneth Gallardo'],
  ['Maria Gallrado', 'Maria Gallardo'],
  ['Sandra Wyckof', 'Sandra Wyckoff'],
  ['Gary Wyckof', 'Gary Wyckoff'],
  ['Nancy Zamorra', 'Nancy Zamora'],
  ['Jason Zamorra', 'Jason Zamora'],
  ['Ashley Vence', 'Ashley Vance'],
  ['Donna Vence', 'Donna Vance'],
  ['Timothy Vence', 'Timothy Vance'],
  ['Emily Whitfeld', 'Emily Whitfield'],
  ['Matthew Whitfeld', 'Matthew Whitfield'],
  ['Matthew Winslo', 'Matthew Winslow'],
  ['Donna Winslo', 'Donna Winslow'],
  ['Michelle Sandovall', 'Michelle Sandoval'],
  ['Michael Sandovall', 'Michael Sandoval'],
  ['David Sandovall', 'David Sandoval'],
  ['Kathleen Jenings', 'Kathleen Jennings'],
  ['Mark Jenings', 'Mark Jennings'],
  ['Richard Osborne', 'Richard Osborn'],
  ['Stephanie Osborne', 'Stephanie Osborn'],
  ['Thomas Osborne', 'Thomas Osborn'],
  // near-miss onto ONE of two similarly-spelled-but-DIFFERENT real customers (Donna Sorensen vs.
  // Donald Sorenson are both real) — the near-miss must still decline, never silently pick either.
  ['Donna Sorenson', 'Donna Sorensen'],
];
check('own near-miss fixture has >= 20 pairs', NEAR_MISS_PAIRS.length >= 20, String(NEAR_MISS_PAIRS.length));

for (const [typo, target] of NEAR_MISS_PAIRS) {
  const question = `Is ${typo} still under warranty?`;
  const { candidates, declined } = await withDb((db) => resolveNamedCustomers(db, question, typo));
  check(`near-miss "${typo}" declines instead of answering as a real customer`, Boolean(declined), JSON.stringify({ candidates: candidates?.length, declined }));
  if (declined) {
    check(`near-miss "${typo}": decline names the real candidate ("${target}")`, declined.text.includes(target), declined.text);
    check(`near-miss "${typo}": decline leaks no PII (no phone/address, no facts)`, declineHasNoPii(declined), JSON.stringify(declined));
  }
}

// negatives -----------------------------------------------------------------------------------
{
  const { candidates, declined } = await withDb((db) => resolveNamedCustomers(db, 'Is Karen Abernathy still under warranty?', 'Karen Abernathy'));
  check('negative: an EXACT real name never declines', !declined, JSON.stringify(declined));
  check('negative: an EXACT real name resolves to exactly that one customer', candidates.length === 1 && candidates[0].customer_name === 'Karen Abernathy');
}
{
  // corroborated: the near-miss name PLUS the real customer's own address stated in the same
  // question resolves normally instead of declining (single candidate + corroboration).
  const q = 'Is Karen Abernathey at 470 E Chandler Blvd still under warranty?';
  const { candidates, declined } = await withDb((db) => resolveNamedCustomers(db, q, 'Karen Abernathey'));
  check('negative: a corroborated single-candidate fuzzy match answers, never declines', !declined, JSON.stringify(declined));
  check('negative: corroborated match resolves to the real corroborated customer', candidates.length === 1 && candidates[0].customer_name === 'Karen Abernathy');
}
{
  // bare-surname broad search (tier 'contains', deliberately exempt from the fuzzy guard) still
  // lists every real match, unchanged from before this round.
  const { candidates, declined } = await withDb((db) => resolveNamedCustomers(db, 'Is Whitfield still under warranty?', 'Whitfield'));
  check('negative: a bare-surname broad match is never guarded (not a fuzzy-only match)', !declined, JSON.stringify(declined));
  check('negative: bare-surname broad match still returns every real Whitfield', candidates.length >= 2, String(candidates.length));
}
{
  // fully made-up name, no real customer within 1 edit at all -> zero candidates, no PII, no fuzzy guess.
  const { candidates, declined } = await withDb((db) => resolveNamedCustomers(db, 'Is Zbigniew Kowalczyk still under warranty?', 'Zbigniew Kowalczyk'));
  check('negative: a name with no real match at all returns zero candidates, never a guess', candidates.length === 0 && !declined, JSON.stringify({ candidates, declined }));
}

/* ============================================================ 2. explicit future year */

const FUTURE_YEAR_PARAPHRASES = [
  'What visits did we have in 2030?',
  'Show me the service calls for 2031.',
  'Any jobs since 2032?',
  'What was installed during 2040?',
  'Give me everything dated 2029.',
  'Visits through 2033?',
];
for (const q of FUTURE_YEAR_PARAPHRASES) {
  const y = explicitFutureYearInQuestion(q, TODAY);
  check(`explicitFutureYearInQuestion detects the future year in "${q}"`, Number.isFinite(y) && y > 2026, String(y));
}
check('explicitFutureYearInQuestion negative: a past year is never flagged', explicitFutureYearInQuestion('What visits did we have in 2020?', TODAY) === null);
check('explicitFutureYearInQuestion negative: no year at all is never flagged', explicitFutureYearInQuestion('What visits did we have last month?', TODAY) === null);
check('explicitFutureYearInQuestion negative: THIS year is never flagged as future', explicitFutureYearInQuestion('What visits did we have in 2026?', TODAY) === null);

{
  // buildVisitAnswer (contactLookup.js) is the pure honest-zero visits builder every real "customer
  // has zero service visits on file" answer in this file goes through — a real customer with zero
  // visits, asked about with an explicit future year, gets the honest zero PLUS the "that's in the
  // future" acknowledgment instead of silently saying nothing about the year actually asked.
  const { buildVisitAnswer } = await import('../api/_lib/contactLookup.js');
  const row = { customer_name: 'Karen Abernathy' };
  const visits = { mostRecent: null, future: [] };
  const text = buildVisitAnswer('last_service_date', row, visits, TODAY, 'When did Karen Abernathy last visit in 2031?').text;
  check('end-to-end future-year note appears on an honest-zero visits answer', /2031/.test(text) && /future/i.test(text), text);
}
{
  const { buildVisitAnswer } = await import('../api/_lib/contactLookup.js');
  const row = { customer_name: 'Karen Abernathy' };
  const visits = { mostRecent: null, future: [] };
  const text = buildVisitAnswer('last_service_date', row, visits, TODAY, 'When did Karen Abernathy last visit?').text;
  check('negative: no future-year note when the question names no future year', !/that's in the future/i.test(text), text);
}

/* ============================================================ 3. L4 rubric bugs (own area) */

{
  // g104/h138/i194 shape: multi-unit refrigerant at a business-name address must report EVERY
  // unit's own refrigerant (or "not on file"), never a flat "ambiguous, can't tell you" decline.
  const asked = await ask('whats the refrigerant at holy trinity church');
  const hay = `${asked?.data?.text ?? ''} ${(asked?.data?.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
  check('g104-shape: multi-unit refrigerant reports per-unit, never a flat decline', !/can't give a single/i.test(hay) && (asked?.data?.facts ?? []).length > 0, hay);
}
{
  const asked = await ask('whats the refrigerant situation at copper sky dental');
  const hay = `${asked?.data?.text ?? ''} ${(asked?.data?.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
  check('h138-shape: multi-unit refrigerant reports per-unit (Trane/Carrier, R-410A + not on file)', /Trane/i.test(hay) && /R-410A/i.test(hay) && /(not on file|no refrigerant)/i.test(hay), hay);
}
{
  const asked = await ask('whats the refrigerant situation at Cactus Rose Restaurant');
  const hay = `${asked?.data?.text ?? ''} ${(asked?.data?.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
  check('i194-shape: multi-unit refrigerant reports per-unit (R-410A + not on file)', /R-410A/i.test(hay) && /(not on file|no refrigerant)/i.test(hay), hay);
}
{
  // g074 negative: 'tonnage' keeps its OLD flat-decline behavior for the identical multi-unit shape
  // (its own honest-zero exam item requires exactly that) — the g104 fix must be scoped to
  // 'refrigerant' only, never widened to every ADDRESS_ENTITY_FIELD_INTENTS member.
  const asked = await ask('whats the tonnage at sunrise valley elementary');
  check('negative: tonnage keeps the flat multi-unit decline (g074 honest-zero, unwidened)', asked?.data?.facts?.length === 0 && !/\d/.test(asked?.data?.text ?? ''), asked?.data?.text);
}
{
  // g105 shape: every unit's real install date is reported, even when only ONE has a per-document
  // extraction behind it (the other two live only on the entity's own record).
  const asked = await ask('when was the unit installed at grace community church');
  const hay = asked?.data?.text ?? '';
  check('g105-shape: all 3 install dates report (June 22/25/28, 2016), none silently "no install date"', /June 22, 2016/.test(hay) && /June 25, 2016/.test(hay) && /June 28, 2016/.test(hay), hay);
}
{
  // h140 shape (same root cause as g105, verified as a bonus fix — see verify-golden.mjs's own note).
  const asked = await ask('when were the units at canyon view dental installed');
  const hay = asked?.data?.text ?? '';
  check('h140-shape: both Canyon View Dental install dates report (Nov 3 and Nov 6, 2023)', /November 3, 2023/.test(hay) && /November 6, 2023/.test(hay), hay);
}
{
  // g149/g153/h163 shape: "who installed it and when for <address>" states BOTH halves honestly —
  // installer never fabricated from an unrelated service visit's technician.
  for (const [q, wantDate] of [
    ['can u tell me who installed it and when for 1913 E University Dr', 'June 22, 2010'],
    ['can u tell me who installed it and when for 3245 S Higley Rd', 'June 10, 2010'],
    ['can you tell me who installed it and when for 803 e pecos rd', 'December 4, 2016'],
  ]) {
    const asked = await ask(q);
    const hay = asked?.data?.text ?? '';
    check(`installer+date compound "${q}": states the real install date`, hay.includes(wantDate), hay);
    check(`installer+date compound "${q}": states installer honestly as not on file (never a visit tech)`, /(not on file|no installer)/i.test(hay), hay);
  }
}

/* --- g151/g155/h167: CODE-verified directly against docLookup.js (bypassing api/ask.js's own
 * `runDocLookup(db, question, { overlay })` call site, which does not pass `today` through — see
 * this round's report for the exact one-line api/ask.js hook this needs; verified here so these 3
 * fixes are provably correct on M1's own side regardless of that un-owned gap). */
{
  const asked = await withDb((db) => runDocLookup(db, 'quick q, is Abernathy still under warranty and whos the tech that did it', { today: TODAY }));
  const hay = asked?.text ?? '';
  check('g151-shape (today supplied): both Abernathys stated, real warranty dates/status', /March 7, 2035/.test(hay) && /active/i.test(hay) && /December 16, 2015/.test(hay) && /expired/i.test(hay), hay);
  check('g151-shape: installer stated honestly as not on file (never a visit tech)', /no installer on file/i.test(hay), hay);
}
{
  const asked = await withDb((db) => runDocLookup(db, 'quick q, is Dominguez still under warranty and whos the tech that did it', { today: TODAY }));
  const hay = asked?.text ?? '';
  check('g155-shape (today supplied): all 3 Dominguez customers listed', /Edward Dominguez/.test(hay) && /Susan Dominguez/.test(hay) && /Ronald Dominguez/.test(hay), hay);
}
{
  const asked = await withDb((db) => runDocLookup(db, 'quick one - warranty status and last visit date for 3282 w camelback rd', { today: TODAY }));
  const hay = asked?.text ?? '';
  check('h167-shape (today supplied): warranty (expired, Nov 19 2022) AND last visit (Apr 25 2022) both stated', /November 19, 2022/.test(hay) && /expired/i.test(hay) && /April 25, 2022/.test(hay), hay);
}

console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
