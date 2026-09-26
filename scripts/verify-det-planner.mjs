/**
 * Round 14 (K3): unit checks for the DETERMINISTIC analytics planner
 * (api/_lib/analytics/detPlan.js) — the one Haiku tool-use call
 * planAnalyticsQuestion (api/_lib/routes/analytics.js) used to make for
 * every counts-geo/brand/age/warranty/docs, coverage, data-hygiene,
 * existence, lists, technician and most time/data-quality question is now
 * tried FIRST, deterministically, with no model call at all.
 *
 * Pure only — no database, no network, no Anthropic call, exactly like
 * scripts/verify-analytics.mjs. This is NOT a duplicate of that file: this
 * one is specifically the "detectAnalyticsPlan never guesses" contract —
 * every negative case here is a real question shape that must come back
 * null (so the caller falls through to the model/needs-model) rather than a
 * confidently wrong plan.
 *
 *   node scripts/verify-det-planner.mjs
 */
import { detectAnalyticsPlan } from '../api/_lib/analytics/detPlan.js';
import { resolveAgeFilter, warrantyStatusFromQuestion, buildConditionOverrideFilter } from '../api/_lib/analytics.js';

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
}

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, `got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`);
}

/* ============================================================ 1. positive shapes, one per target category */

eq(
  'counts-geo: "how many customers in 85122"',
  detectAnalyticsPlan('how many customers in 85122'),
  { entity: 'customers', op: 'count', filters: [{ field: 'zip', op: 'eq', value: '85122' }] }
);

eq(
  'counts-brand: "how many trane units do we have"',
  detectAnalyticsPlan('how many trane units do we have'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] }
);

eq(
  'counts-warranty: "how many units have expiring soon"',
  detectAnalyticsPlan('how many units have expiring soon'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expiring' }] }
);

eq(
  'counts-docs: "how many permits do we have"',
  detectAnalyticsPlan('how many permits do we have'),
  { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'permit' }] }
);

eq(
  'coverage: "how many different zip codes do we cover"',
  detectAnalyticsPlan('how many different zip codes do we cover'),
  { entity: 'customers', op: 'groupBy', groupBy: 'zip', countDistinct: true }
);

eq(
  'data-hygiene: "how many customers have no email on file"',
  detectAnalyticsPlan('how many customers have no email on file'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: false }] }
);

eq(
  'existence: "do we have any ruud units" (an UNKNOWN-to-this-tenant brand still builds a real filter)',
  detectAnalyticsPlan('do we have any ruud units'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Ruud' }] }
);

eq(
  'lists: "which customers are in mesa"',
  detectAnalyticsPlan('which customers are in mesa'),
  { entity: 'customers', op: 'list', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }] }
);

eq(
  'technician: "how many jobs did wyatt coburn do this month"',
  detectAnalyticsPlan('how many jobs did wyatt coburn do this month'),
  { entity: 'serviceVisits', op: 'count', filters: [{ field: 'technician', op: 'eq', value: 'Wyatt Coburn' }] }
);

eq(
  'time (bare total, no filter but a real quantifier): "how many documents did we add last month"',
  detectAnalyticsPlan('how many documents did we add last month'),
  { entity: 'documents', op: 'count', filters: [] }
);

/* ============================================================ 2. dedicated shapes */

eq(
  'hasDocType: "which customers have a permit on file"',
  detectAnalyticsPlan('which customers have a permit on file'),
  { entity: 'customers', op: 'list', filters: [{ field: 'hasDocType', op: 'eq', value: 'permit' }] }
);

eq(
  'lacksDocType (negation before the doc-type word): "which customers don\'t have a permit on file"',
  detectAnalyticsPlan("which customers don't have a permit on file"),
  { entity: 'customers', op: 'list', filters: [{ field: 'lacksDocType', op: 'eq', value: 'permit' }] }
);

eq(
  'locked-into shape counts DOCUMENTS, not customers: "how many customers are locked into a maintenance agreement"',
  detectAnalyticsPlan('how many customers are locked into a maintenance agreement'),
  { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'maintenance-agreement' }] }
);

eq(
  'brand comparison: "trane vs carrier units"',
  detectAnalyticsPlan('trane vs carrier units'),
  { entity: 'equipment', op: 'groupBy', groupBy: 'brand', filters: [{ field: 'brand', op: 'in', value: ['Trane', 'Carrier'] }] }
);

eq(
  'technician groupBy: "breakdown by technician"',
  detectAnalyticsPlan('breakdown by technician'),
  { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician' }
);

eq(
  'groupBy phrase: "customers by county"',
  detectAnalyticsPlan('customers by county'),
  { entity: 'customers', op: 'groupBy', groupBy: 'county' }
);

eq(
  'refrigerant filter: "how many units run on r-410a"',
  detectAnalyticsPlan('how many units run on r-410a'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'refrigerant', op: 'eq', value: 'R-410A' }] }
);

/* ============================================================ 3. equipment/warranties + geo forced to customers
 * (the golden tenant's equipment rows carry no address of their own at all —
 * see detPlan.js's own doc comment on this forcing rule).
 */
eq(
  'geo + brand forces entity to customers: "how many trane customers in mesa"',
  detectAnalyticsPlan('how many trane customers in mesa'),
  {
    entity: 'customers',
    op: 'count',
    filters: [
      { field: 'brand', op: 'eq', value: 'Trane' },
      { field: 'city', op: 'eq', value: 'Mesa' },
    ],
  }
);

eq(
  'since-year install filter: "how many trane installs have we done since 2020"',
  detectAnalyticsPlan('how many trane installs have we done since 2020'),
  {
    entity: 'equipment',
    op: 'count',
    filters: [
      { field: 'brand', op: 'eq', value: 'Trane' },
      { field: 'installYear', op: 'gte', value: 2020 },
    ],
  }
);

/* ============================================================ 4. never guess — negative cases MUST return null */

check('empty question -> null', detectAnalyticsPlan('') === null);
check('whitespace-only question -> null', detectAnalyticsPlan('   ') === null);

check(
  'self-join "duplicate customers" -> null (no flat filter can express this)',
  detectAnalyticsPlan('do we have any duplicate customers') === null
);

check(
  'content-search "mention a rattling noise" -> null (free-text search, not a closed filter)',
  detectAnalyticsPlan('how many jobs mention a rattling noise') === null
);

check(
  'content-search "complained the unit is loud" -> null',
  detectAnalyticsPlan('which customers complained the unit is loud') === null
);

check(
  'connect (address mismatch, K4 territory) -> null',
  detectAnalyticsPlan("how many customers have a document address that doesn't match their record") === null
);

check(
  'connect (quoted but never installed) -> null',
  detectAnalyticsPlan('which customers were quoted a replacement but have not had a new unit installed since') === null
);

check(
  'follow-up fragment (needs prior-turn context this planner never has) -> null',
  detectAnalyticsPlan('expired warranties -- what about just the mesa ones') === null
);

check(
  'data-quality "missing field" shape (no FILTER_FIELD exists for it) -> null',
  detectAnalyticsPlan("how many documents aren't linked to any customer") === null
);

check(
  'data-quality "no service address on file" -> null',
  detectAnalyticsPlan('how many customers have no service address on file') === null
);

check(
  'bare noun, no filter, no quantifier at all -> null',
  detectAnalyticsPlan('customers') === null
);

check(
  'unrelated sentence with a stray entity word -> null',
  detectAnalyticsPlan("what's the weather today") === null
);

/* ============================================================ 5. typo/paraphrase tolerance (shape, never exam text) */

eq(
  'typo tolerance, doubled vowel: "how many units older than 10 yeears do we have"',
  detectAnalyticsPlan('how many units older than 10 yeears do we have'),
  { entity: 'equipment', op: 'count', filters: [] }
);
check(
  'resolveAgeFilter tolerates "yeears" (doubled vowel) the same as "years"',
  JSON.stringify(resolveAgeFilter('units older than 10 yeears', '2026-09-26')) ===
    JSON.stringify({ field: 'installYear', op: 'lt', value: 2016 })
);
check(
  'resolveAgeFilter tolerates "yeasr" (transposed letters)',
  JSON.stringify(resolveAgeFilter('units older than 10 yeasr old', '2026-09-26')) ===
    JSON.stringify({ field: 'installYear', op: 'lt', value: 2016 })
);
check(
  'resolveAgeFilter tolerates "order" (nlNormalize\'s own "older"->"order" typo-corrector collision)',
  JSON.stringify(resolveAgeFilter('units order than 10 years', '2026-09-26')) ===
    JSON.stringify({ field: 'installYear', op: 'lt', value: 2016 })
);
check(
  'resolveAgeFilter: "over N years old" means the same as "older than N years"',
  JSON.stringify(resolveAgeFilter('a unit over 10 years old', '2026-09-26')) ===
    JSON.stringify({ field: 'installYear', op: 'lt', value: 2016 })
);
check(
  'resolveAgeFilter direction bug fix: "younger than N years" means NEWER, not older',
  JSON.stringify(resolveAgeFilter('a unit younger than 5 years', '2026-09-26')) ===
    JSON.stringify({ field: 'installYear', op: 'gte', value: 2021 })
);

check(
  'warrantyStatusFromQuestion tolerates "epxiring" (adjacent-letter transposition of "expiring")',
  warrantyStatusFromQuestion('units have epxiring warranty soon') === 'expiring'
);

check(
  'buildConditionOverrideFilter(phone) recognizes "do not have a phone number" as negative (was defaulting to true)',
  JSON.stringify(buildConditionOverrideFilter('phone', 'customers who do not have a phone number on file')) ===
    JSON.stringify({ field: 'hasPhone', op: 'eq', value: false })
);

eq(
  'technician typo: doubled leading letter "ddanny ochoa" -> "Danny Ochoa"',
  detectAnalyticsPlan('how many jobs did ddanny ochoa run this month'),
  { entity: 'serviceVisits', op: 'count', filters: [{ field: 'technician', op: 'eq', value: 'Danny Ochoa' }] }
);

console.log('');
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
