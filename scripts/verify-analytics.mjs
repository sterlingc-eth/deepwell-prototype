/**
 * Unit checks for Donovan's analytics path (handoffs/DONOVAN_ANALYTICS_A_2026-09-21.md).
 * Pure only — no database, no network, no Anthropic call. Covers:
 *   1. The pre-classifier: 25 example questions (15 positive analytics
 *      questions the brief names + 10 negatives that must stay with
 *      fastPath/retrieval) — this IS the "deterministic pre-classifier test"
 *      the brief asks for; the Haiku planner itself is exercised only via the
 *      recorded-plan fixture in section 2, never over the network.
 *   2. A fixture of recorded plans (what Haiku would have returned for real
 *      questions) run through validatePlan -> buildAnalyticsSQL ->
 *      formatAnalyticsAnswer, end to end, with no DB.
 *   3. validatePlan: schema/vocabulary rejection (the "fall through when the
 *      plan is invalid" case).
 *   4. Geo derivation: AZ addresses incl. suites, missing zip, 9-digit zip,
 *      city+state with no zip, out-of-state.
 *   5. County lookup: ZIP-prefix default, 5-digit exceptions, city fallback,
 *      unknown ZIP/city.
 *   6. SQL builder: per-entity shape and parameterization, against a fixture.
 *   7. Answer formatting: count/groupBy/list/sum, the ambiguity rule, the
 *      50-row cap (raised from 12, round-2 gap 2) with "and N more".
 *   8. Filter matching, grouping, brand/year/warranty-status helpers.
 *   10. Reviewer NO-GO A2 (2026-09-21) — analytics cache key derivation.
 *   11. Reviewer round 2 (2026-09-21) gap 1 — classifier phrasings that fell
 *       through to retrieval on the live corpus ("which customers have Trane
 *       units", "who has X units", "customers with expired warranties",
 *       "units older than N years", "how many <brand> units").
 *   12. Reviewer round 2 (2026-09-21) gaps 1+3 — the brand-filtered
 *       customers->equipment join, end to end against a mock db.
 *   13. Reviewer round 3 (2026-09-21) item 3 — WHO_HAS_RE over an "at
 *       <number> <word>" single-record reference with no street suffix.
 *   14. Reviewer round 4 (2026-09-21) item 1 — plain-English entity synonyms
 *       ("how many clients do we have", "how many rooftop units", "who's
 *       our biggest customer") shared between the classifier and the
 *       planner's system prompt.
 *
 *   node scripts/verify-analytics.mjs
 */
import {
  preClassifyAnalytics,
  looksLikeSingleRecordReference,
  suspiciousUnfilteredCustomerPlan,
  validatePlan,
  deriveState,
  deriveZip,
  deriveGeo,
  countyForZip,
  countyForCity,
  normalizeStateValue,
  matchesFilter,
  matchesAllFilters,
  groupRows,
  buildAnalyticsSQL,
  formatAnalyticsAnswer,
  brandMatches,
  installYearOf,
  warrantyStatusOf,
  MAX_FACT_ROWS,
  UNKNOWN_BUCKET,
  ANALYTICS_PROMPT_VERSION,
  analyticsQuestionHash,
  analyticsPlanHash,
  ENTITY_SYNONYMS,
  ANALYTICS_SYSTEM_PROMPT,
  TOP_CUSTOMERS_LIMIT,
  resolveQuestionTimeRange,
  reconcileTimeRange,
  monthRangeLabel,
  detectedConditions,
  missingConditions,
  unsupportedConditionAnswer,
  isMoneyQuestion,
  moneyFallbackAnswer,
  MONEY_FALLBACK_TEXT,
  ANALYTICS_FEW_SHOT,
  ANALYTICS_FEW_SHOT_BLOCK,
} from '../api/_lib/analytics.js';
import { isAnalyticsEnabled, executeAnalyticsPlan, runAnalyticsQuestion } from '../api/_lib/routes/analytics.js';
import { hashQuestion, normalizeQuestion } from '../api/ask.js';
import { parseContactLookupQuestion, fuzzyNameMatches, nameTokens, buildContactAnswer, buildAmbiguousContactAnswer } from '../api/_lib/contactLookup.js';
import { extractStreetTokens, correctStreetTypos } from '../api/_lib/streetVocab.js';
import { insertAskMiss } from '../api/_lib/missStore.js';

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ======================================================================
 * 1. Pre-classifier corpus — 25 example questions.
 * ====================================================================== */

const POSITIVE_QUESTIONS = [
  'how many customers do we have in Arizona',
  'how many customers in Arizona',
  'how many clients do we have in Maricopa',
  'list customers in Gilbert',
  'list all customers in Chandler',
  'how many units are out of warranty',
  'how many pieces of equipment are out of warranty',
  'which customers have Trane units',
  'which customers have Goodman equipment',
  'how many documents did we add this month',
  'how many documents did we add last month',
  'who did we service in August',
  'who did we service last month',
  'how many Goodman units are older than 10 years',
  'how many Trane units are older than 5 years',
  'how many customers are in Pinal County',
  'total customers by county',
  'give me a breakdown of customers by city',
  'group equipment by brand',
  'how many invoices do we have from Carrier customers',
  'how many warranties do we have that are expiring',
  'show me a breakdown by technician',
  'how many customers do we have in Pima',
  'count customers in Tucson',
  'how many equipment records are there by brand',
];
check('positive corpus has >= 25 questions', POSITIVE_QUESTIONS.length >= 25, String(POSITIVE_QUESTIONS.length));
for (const q of POSITIVE_QUESTIONS) {
  check(`pre-classify (positive) :: "${q}"`, preClassifyAnalytics(q) === true);
}

const NEGATIVE_QUESTIONS = [
  ['how many documents does Plaza Dental have', 'per-entity possessive count, stays with retrieval'],
  ['does the unit at 3247 Elm have a warranty', 'single-record warranty status, fastPath owns this'],
  ['does Henderson have a maintenance agreement', 'possessive single-record question'],
  ['what is the serial number on the Trane condenser', 'single field lookup, fastPath'],
  ['when does the warranty on the unit at 3247 Elm St expire', 'single-record warranty_expires'],
  ['how many tons is the Goodman unit at 12 Main St', 'single-record attribute, has an address subject'],
  ['what is the model number', 'no aggregate noun, no quantifier context'],
  ['who installed the unit at 500 Oak St', 'single-record installer lookup'],
  ['thanks', 'not a question at all'],
  ['', 'empty string'],
];
for (const [q, why] of NEGATIVE_QUESTIONS) {
  check(`pre-classify (negative) :: "${q}" (${why})`, preClassifyAnalytics(q) === false);
}

/* ======================================================================
 * 1b. Reviewer NO-GO A1 (2026-09-21) — adversarial single-record checks.
 * WHICH_CUSTOMERS_RE / WHO_SERVICED_RE / GROUP_SHAPE_RE bypass the generic
 * AGGREGATE_NOUN/CONTEXT vocabulary check, so a question naming a specific
 * street address or a serial/model-shaped token must be excluded BEFORE any
 * of those trigger regexes gets a chance to fire — verified directly here,
 * distinct from section 1's corpus, plus the shared entry point.
 * ====================================================================== */

const ADVERSARIAL_SINGLE_RECORD = [
  ['Which customers are at 1234 Main St, Mesa AZ?', 'street address, would bypass via WHICH_CUSTOMERS_RE'],
  ['which customer owns serial 4N2119-08772', 'serial-shaped identifier token'],
  ['who is at 640 W Guadalupe', 'street reference with no recognized suffix word'],
  ['list customers at 500 Oak St', 'street address, would bypass via QUANTIFIER "list"'],
  ['which customers live at 220 N Center St', 'street address, would bypass via WHICH_CUSTOMERS_RE'],
  ['how many tons is the Whitmore unit', 'single-record attribute, no location/brand context at all'],
  ['which customer has model GSX140361K', 'model-shaped identifier token'],
];
check('adversarial corpus has >= 7 single-record cases', ADVERSARIAL_SINGLE_RECORD.length >= 7, String(ADVERSARIAL_SINGLE_RECORD.length));
for (const [q, why] of ADVERSARIAL_SINGLE_RECORD) {
  check(`pre-classify (adversarial, single-record) :: "${q}" (${why})`, preClassifyAnalytics(q) === false);
}

const ADVERSARIAL_STILL_ANALYTICS = [
  'how many customers in Mesa',
  'which customers have Trane units',
  'list customers in Pinal County',
  'which customers have Goodman equipment',
  'how many customers do we have in Pinal County',
];
check('adversarial corpus has >= 5 still-analytics controls', ADVERSARIAL_STILL_ANALYTICS.length >= 5, String(ADVERSARIAL_STILL_ANALYTICS.length));
for (const q of ADVERSARIAL_STILL_ANALYTICS) {
  check(`pre-classify (adversarial, still analytics) :: "${q}"`, preClassifyAnalytics(q) === true);
}

check(
  'ADVERSARIAL total >= 12 (reviewer asked for 12 adversarial checks)',
  ADVERSARIAL_SINGLE_RECORD.length + ADVERSARIAL_STILL_ANALYTICS.length >= 12,
  String(ADVERSARIAL_SINGLE_RECORD.length + ADVERSARIAL_STILL_ANALYTICS.length)
);

// looksLikeSingleRecordReference and suspiciousUnfilteredCustomerPlan directly.
check('looksLikeSingleRecordReference: street address', looksLikeSingleRecordReference('Which customers are at 1234 Main St, Mesa AZ?'));
check('looksLikeSingleRecordReference: serial token', looksLikeSingleRecordReference('which customer owns serial 4N2119-08772'));
check('looksLikeSingleRecordReference: no address/identifier -> false', !looksLikeSingleRecordReference('how many customers in Mesa'));
check('looksLikeSingleRecordReference: short number alone is not an identifier', !looksLikeSingleRecordReference('how many Trane units are older than 5 years'));

check(
  'suspiciousUnfilteredCustomerPlan: unfiltered customers list + 4-digit street number -> true',
  suspiciousUnfilteredCustomerPlan({ entity: 'customers', op: 'list', filters: [] }, 'which customers are at 1234 Main St')
);
check(
  'suspiciousUnfilteredCustomerPlan: unfiltered customers count + number -> true',
  suspiciousUnfilteredCustomerPlan({ entity: 'customers', op: 'count', filters: [] }, 'how many customers are at 85234')
);
check(
  'suspiciousUnfilteredCustomerPlan: filters present -> false regardless of digits',
  !suspiciousUnfilteredCustomerPlan({ entity: 'customers', op: 'list', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }] }, 'which customers are at 1234 Main St')
);
check(
  'suspiciousUnfilteredCustomerPlan: no 2+ digit number -> false',
  !suspiciousUnfilteredCustomerPlan({ entity: 'customers', op: 'count', filters: [] }, 'how many customers do we have')
);
check(
  'suspiciousUnfilteredCustomerPlan: non-customers entity -> false',
  !suspiciousUnfilteredCustomerPlan({ entity: 'equipment', op: 'list', filters: [] }, 'which units are at 1234 Main St')
);
check(
  'suspiciousUnfilteredCustomerPlan: groupBy op -> false (not list/count)',
  !suspiciousUnfilteredCustomerPlan({ entity: 'customers', op: 'groupBy', groupBy: 'city', filters: [] }, 'breakdown of 1234 customers by city')
);

/* ======================================================================
 * 2. Recorded-plan fixture — end to end, no network, no DB.
 * Each entry is what the Haiku planner is expected to have returned for a
 * real question, run through the full pure pipeline.
 * ====================================================================== */

const FIXTURES = [
  {
    name: 'count customers in Arizona',
    plan: { entity: 'customers', op: 'count', filters: [{ field: 'state', op: 'eq', value: 'AZ' }] },
    rows: [
      { service_address: '1 Main St, Gilbert, AZ 85234' },
      { service_address: '2 Main St, Mesa, AZ 85201' },
      { service_address: '3 Main St, Las Vegas, NV 89101' },
    ],
    expectAzCount: 2,
  },
  {
    name: 'groupBy county for Maricopa customers',
    plan: { entity: 'customers', op: 'groupBy', groupBy: 'city', filters: [{ field: 'county', op: 'eq', value: 'Maricopa' }] },
  },
  {
    name: 'which customers have Trane units',
    plan: { entity: 'equipment', op: 'list', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] },
  },
  {
    name: 'out-of-warranty count',
    plan: { entity: 'warranties', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }] },
  },
  {
    name: 'Goodman units older than 10 years',
    plan: { entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Goodman' }, { field: 'installYear', op: 'lt', value: 2016 }] },
  },
];

for (const fx of FIXTURES) {
  const plan = validatePlan(fx.plan);
  check(`fixture "${fx.name}" :: plan validates`, plan !== null);
  if (!plan) continue;
  const built = buildAnalyticsSQL(plan);
  check(`fixture "${fx.name}" :: SQL builder returns a string`, typeof built.sql === 'string' && built.sql.length > 0);
  check(`fixture "${fx.name}" :: SQL is tenant-scoped`, built.sql.includes("current_setting('app.tenant_id', true)"));
  check(`fixture "${fx.name}" :: SQL params is an array`, Array.isArray(built.params));
}

/* ======================================================================
 * 3. validatePlan — schema/vocabulary rejection (fall-through case).
 * ====================================================================== */

eq('validatePlan: valid minimal plan', validatePlan({ entity: 'customers', op: 'count' }), {
  entity: 'customers', op: 'count', groupBy: undefined, filters: [], timeRange: undefined, limit: 500,
});
check('validatePlan: null input -> null', validatePlan(null) === null);
check('validatePlan: non-object input -> null', validatePlan('nope') === null);
check('validatePlan: unknown entity -> null', validatePlan({ entity: 'invoices_x', op: 'count' }) === null);
check('validatePlan: unknown op -> null', validatePlan({ entity: 'customers', op: 'delete' }) === null);
check('validatePlan: groupBy op with no groupBy field -> null', validatePlan({ entity: 'customers', op: 'groupBy' }) === null);
check('validatePlan: groupBy op with invalid groupBy field -> null', validatePlan({ entity: 'customers', op: 'groupBy', groupBy: 'sql' }) === null);
check('validatePlan: filter with unknown field -> null (whole plan rejected)', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'ssn', op: 'eq', value: 'x' }] }) === null);
check('validatePlan: filter with unknown op -> null', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'DROP TABLE', value: 'x' }] }) === null);
check('validatePlan: filter with empty value -> null', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: '' }] }) === null);
check('validatePlan: "in" op requires an array value -> null otherwise', validatePlan({ entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'in', value: 'Trane' }] }) === null);
check('validatePlan: "in" op with an array value is fine', validatePlan({ entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'in', value: ['Trane', 'Carrier'] }] }) !== null);
check('validatePlan: warrantyStatus filter must be a known status', validatePlan({ entity: 'warranties', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'lapsed' }] }) === null);
check('validatePlan: warrantyStatus "expired" is accepted', validatePlan({ entity: 'warranties', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }] }) !== null);
check('validatePlan: malformed timeRange -> null', validatePlan({ entity: 'documents', op: 'count', timeRange: { from: 'August' } }) === null);
check('validatePlan: YYYY-MM timeRange is fine', validatePlan({ entity: 'documents', op: 'count', timeRange: { from: '2026-08' } }) !== null);
check('validatePlan: negative limit -> null', validatePlan({ entity: 'customers', op: 'list', limit: -5 }) === null);
check('validatePlan: limit clamps to MAX_LIMIT (500)', validatePlan({ entity: 'customers', op: 'list', limit: 999999 }).limit === 500);
check('validatePlan: SQL text injected as a field value is rejected as a field, not executed', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: '1=1; DROP TABLE entities;--', op: 'eq', value: 'x' }] }) === null);

/* ======================================================================
 * 4. Geo derivation.
 * ====================================================================== */

eq('deriveState: trailing "AZ 85234"', deriveState('123 Main St, Gilbert, AZ 85234'), 'AZ');
eq('deriveState: no comma before state', deriveState('12 Main St, Tempe AZ 85281'), 'AZ');
eq('deriveState: spelled-out Arizona', deriveState('12 Main St, Somewhere, Arizona'), 'AZ');
eq('deriveState: no state present', deriveState('12 Main St'), null);
eq('deriveZip: plain 5-digit', deriveZip('123 Main St, Gilbert, AZ 85234'), '85234');
eq('deriveZip: 9-digit ZIP+4 truncates to 5', deriveZip('123 Main St, Gilbert, AZ 85234-1234'), '85234');
eq('deriveZip: missing zip', deriveZip('123 Main St, Gilbert, AZ'), null);
eq('deriveGeo: suite segment does not break city', deriveGeo('880 S Dobson Rd, Suite 110, Chandler, AZ 85224').city, 'Chandler');
eq('deriveGeo: suite segment does not break county', deriveGeo('880 S Dobson Rd, Suite 110, Chandler, AZ 85224').county, 'Maricopa');
eq('deriveGeo: no comma before state+zip', deriveGeo('12 Main St, Apt 4B, Tempe AZ 85281').city, 'Tempe');
eq('deriveGeo: missing zip falls back to city lookup', deriveGeo('1 Main St, Gilbert, AZ').county, 'Maricopa');
eq('deriveGeo: out-of-state address', deriveGeo('500 Vegas Blvd, Las Vegas, NV 89101').county, 'Clark');
eq('deriveGeo: out-of-state address state code', deriveGeo('500 Vegas Blvd, Las Vegas, NV 89101').state, 'NV');
eq('deriveGeo: no address at all -> all null', deriveGeo(null), { city: null, state: null, zip: null, county: null });
eq('deriveGeo: unrecognized zip/city -> Unknown-able (null county)', deriveGeo('1 Rue de Nowhere, Paris, FR').county, null);

/* ======================================================================
 * 5. County lookup.
 * ====================================================================== */

eq('countyForZip: Maricopa default (850 prefix)', countyForZip('85001'), 'Maricopa');
eq('countyForZip: Pinal exception inside Maricopa-prefix range', countyForZip('85140'), 'Pinal');
eq('countyForZip: Pima default (857 prefix, Tucson)', countyForZip('85701'), 'Pima');
eq('countyForZip: Cochise default (856 prefix, Sierra Vista)', countyForZip('85635'), 'Cochise');
eq('countyForZip: Pima exception inside Cochise-prefix range (Marana)', countyForZip('85653'), 'Pima');
eq('countyForZip: Santa Cruz exception (Nogales)', countyForZip('85621'), 'Santa Cruz');
eq('countyForZip: Yuma exception', countyForZip('85364'), 'Yuma');
eq('countyForZip: La Paz exception (Parker)', countyForZip('85344'), 'La Paz');
eq('countyForZip: unassigned prefix -> null', countyForZip('85400'), null);
eq('countyForZip: not a 5-digit string -> null', countyForZip('AZ'), null);
eq('countyForZip: out-of-range zip -> null (table only covers AZ)', countyForZip('10001'), null);
eq('countyForCity: AZ city, no state given', countyForCity('Gilbert'), 'Maricopa');
eq('countyForCity: AZ city, case-insensitive', countyForCity('GILBERT', 'az'), 'Maricopa');
eq('countyForCity: out-of-state city with state', countyForCity('Chicago', 'IL'), 'Cook');
eq('countyForCity: unknown city -> null', countyForCity('Nowheresville', 'ZZ'), null);
eq('normalizeStateValue: spelled out', normalizeStateValue('Arizona'), 'AZ');
eq('normalizeStateValue: lowercase code', normalizeStateValue('az'), 'AZ');
eq('normalizeStateValue: empty -> null', normalizeStateValue(''), null);

/* ======================================================================
 * 6. SQL builder shape, per entity.
 * ====================================================================== */

{
  const plan = validatePlan({ entity: 'customers', op: 'list', filters: [{ field: 'customerName', op: 'contains', value: 'Dental' }] });
  const built = buildAnalyticsSQL(plan);
  check('SQL (customers): selects entities table', built.sql.includes('FROM entities'));
  check('SQL (customers): filters entity_type = customer', built.sql.includes("entity_type = 'customer'"));
  check('SQL (customers): pushes customerName as a parameterized ILIKE', built.sql.includes('ILIKE $1') && built.params[0] === '%Dental%');
  check('SQL (customers): caps at 500', built.sql.includes('LIMIT 500'));
}
{
  const plan = validatePlan({ entity: 'equipment', op: 'list', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
  const built = buildAnalyticsSQL(plan);
  check('SQL (equipment): selects entities table', built.sql.includes('FROM entities'));
  check('SQL (equipment): filters entity_type = equipment', built.sql.includes("entity_type = 'equipment'"));
  check('SQL (equipment): pushes brand as a parameterized column filter', built.params.includes('Trane'));
}
{
  const plan = validatePlan({ entity: 'warranties', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }] });
  const built = buildAnalyticsSQL(plan);
  check('SQL (warranties): reuses the equipment table (warrantyStatus is computed in JS, not SQL)', built.sql.includes("entity_type = 'equipment'"));
  check('SQL (warranties): warrantyStatus never becomes literal SQL text', !built.sql.toLowerCase().includes('expired'));
}
{
  const plan = validatePlan({ entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'invoice' }] });
  const built = buildAnalyticsSQL(plan);
  check('SQL (documents): selects documents table', built.sql.includes('FROM documents'));
  check('SQL (documents): pushes documentType as a parameter', built.params.includes('invoice'));
}
{
  const plan = validatePlan({ entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician' });
  const built = buildAnalyticsSQL(plan);
  check('SQL (serviceVisits): reads extractions, not raw SQL from the model', built.sql.includes('FROM extractions'));
  check('SQL (serviceVisits): scoped to service_date field_key', built.sql.includes("field_key = 'service_date'"));
}
{
  // A filter whose field this entity's row shape has no column for (city on
  // documents) must not be silently dropped into a WHERE it can't express —
  // buildAnalyticsSQL simply never adds it; the executor-level
  // filtersSupported() guard (routes/analytics.js) is what turns this into a
  // fall-through, checked structurally here via absence from params.
  const plan = validatePlan({ entity: 'documents', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Gilbert' }] });
  const built = buildAnalyticsSQL(plan);
  check('SQL builder never pushes an unmapped field into params', !built.params.includes('Gilbert'));
}

/* ======================================================================
 * 7. Answer formatting.
 * ====================================================================== */

{
  const plan = validatePlan({ entity: 'customers', op: 'count' });
  const out = formatAnalyticsAnswer(plan, { total: 14, unfilteredTotal: 31 });
  check('format count: mentions the count', out.text.includes('14 customers'));
  check('format count: mentions the unfiltered total in parens', out.text.includes('31'));
  eq('format count: one fact row', out.facts.length, 1);
}
{
  const plan = validatePlan({ entity: 'customers', op: 'groupBy', groupBy: 'city' });
  const groups = [
    { key: 'Gilbert', count: 5 }, { key: 'Mesa', count: 4 },
    { key: 'Chandler', count: 3 }, { key: 'Tempe', count: 2 },
  ];
  const out = formatAnalyticsAnswer(plan, { total: 14, groups });
  check('format groupBy: text names every city', ['Gilbert', 'Mesa', 'Chandler', 'Tempe'].every((c) => out.text.includes(c)));
  eq('format groupBy: one fact per group', out.facts.length, 4);
  eq('format groupBy: fact label/value are city/count', out.facts[0], { label: 'Gilbert', value: '5', sources: [] });
}
{
  // MAX_FACT_ROWS cap + "and N more" — reviewer NO-GO (2026-09-21, round 2,
  // gap 2) raised this from 12 to 50; the test itself scales off
  // MAX_FACT_ROWS rather than a hardcoded row count, so it stays correct
  // whatever the cap is.
  const plan = validatePlan({ entity: 'equipment', op: 'groupBy', groupBy: 'brand' });
  const groups = Array.from({ length: MAX_FACT_ROWS + 3 }, (_, i) => ({ key: `Brand${i}`, count: MAX_FACT_ROWS + 3 - i }));
  const out = formatAnalyticsAnswer(plan, { total: 100, groups });
  eq('format groupBy: facts capped at MAX_FACT_ROWS', out.facts.length, MAX_FACT_ROWS);
  check('format groupBy: text says how many more', out.text.includes('3 more'));
}
check('gap 2: MAX_FACT_ROWS raised to 50', MAX_FACT_ROWS, 50);
{
  const plan = validatePlan({ entity: 'equipment', op: 'list', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
  const rows = [{ label: 'Trane condenser', value: 'XR16', entityId: 'c1' }];
  const out = formatAnalyticsAnswer(plan, { total: 1, rows });
  check('format list: text mentions the count', out.text.includes('1'));
  eq('format list: fact carries entityId (linkable)', out.facts[0].entityId, 'c1');
}
{
  // Gap 2: list op past the 50-row cap keeps "and N more", not a bare
  // "showing the first N" with no count of what was left out.
  const plan = validatePlan({ entity: 'customers', op: 'list' });
  const rows = Array.from({ length: MAX_FACT_ROWS + 18 }, (_, i) => ({ label: `Customer ${i}`, value: 'Mesa', entityId: `c${i}` }));
  const out = formatAnalyticsAnswer(plan, { total: rows.length, rows });
  eq('gap 2: list facts capped at MAX_FACT_ROWS (50)', out.facts.length, MAX_FACT_ROWS);
  check('gap 2: list text says "and N more" past the cap', out.text.includes('and 18 more'));
  check('gap 2: list text still states the true total', out.text.includes(String(rows.length)));
}
{
  // Gap 2: a list at or under the cap needs no "and N more" at all.
  const plan = validatePlan({ entity: 'customers', op: 'list' });
  const rows = Array.from({ length: 9 }, (_, i) => ({ label: `Customer ${i}`, value: 'Mesa', entityId: `c${i}` }));
  const out = formatAnalyticsAnswer(plan, { total: 9, rows });
  check('gap 2: list under the cap has no "more" text', !out.text.includes('more'));
}
{
  const plan = validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'county', op: 'eq', value: 'Pima' }] });
  const broaderGroups = [{ key: 'Maricopa', count: 14 }, { key: 'Pinal', count: 3 }];
  const out = formatAnalyticsAnswer(plan, { total: 0, broaderGroups });
  check('ambiguity rule: 0 results names what data actually has', out.text.includes('Maricopa') && out.text.includes('Pinal'));
  check('ambiguity rule: never a bare "0 customers." with no context', out.text !== '0 customers.');
}
{
  const plan = validatePlan({ entity: 'documents', op: 'sum' });
  const out = formatAnalyticsAnswer(plan, { total: 3, sum: 1234.5 });
  check('format sum: renders currency', out.text.includes('$1,234.50') || out.text.includes('1,234.5'));
}

/* ======================================================================
 * 8. Filter matching / grouping / small helpers.
 * ====================================================================== */

check('matchesFilter: eq case-insensitive', matchesFilter({ brand: 'TRANE' }, { field: 'brand', op: 'eq', value: 'trane' }));
check('matchesFilter: neq', matchesFilter({ brand: 'Trane' }, { field: 'brand', op: 'neq', value: 'Carrier' }));
check('matchesFilter: contains', matchesFilter({ customerName: 'Plaza Dental Group' }, { field: 'customerName', op: 'contains', value: 'dental' }));
check('matchesFilter: gt on numeric string', matchesFilter({ installYear: '2020' }, { field: 'installYear', op: 'gt', value: 2015 }));
check('matchesFilter: lt false when not less', !matchesFilter({ installYear: '2020' }, { field: 'installYear', op: 'lt', value: 2015 }));
check('matchesFilter: in matches any', matchesFilter({ brand: 'Carrier' }, { field: 'brand', op: 'in', value: ['Trane', 'Carrier'] }));
check('matchesFilter: null field never matches', !matchesFilter({ brand: null }, { field: 'brand', op: 'eq', value: 'Trane' }));
check('matchesAllFilters: all must pass', matchesAllFilters({ brand: 'Trane', state: 'AZ' }, [{ field: 'brand', op: 'eq', value: 'Trane' }, { field: 'state', op: 'eq', value: 'AZ' }]));
check('matchesAllFilters: one failing filter fails the row', !matchesAllFilters({ brand: 'Trane', state: 'NV' }, [{ field: 'brand', op: 'eq', value: 'Trane' }, { field: 'state', op: 'eq', value: 'AZ' }]));

{
  const rows = [{ city: 'Gilbert' }, { city: 'Gilbert' }, { city: 'Mesa' }, { city: null }];
  const groups = groupRows(rows, (r) => r.city);
  eq('groupRows: counts correctly', groups.find((g) => g.key === 'Gilbert').count, 2);
  eq('groupRows: null buckets to Unknown', groups.find((g) => g.key === UNKNOWN_BUCKET).count, 1);
  eq('groupRows: Unknown always sorts last', groups[groups.length - 1].key, UNKNOWN_BUCKET);
}

check('brandMatches: exact', brandMatches('Trane', 'Trane'));
check('brandMatches: case/legal-suffix variance', brandMatches('Goodman Mfg. Co.', 'goodman'));
check('brandMatches: different brands do not match', !brandMatches('Trane', 'Carrier'));
eq('installYearOf: full date', installYearOf('2016-03-04'), 2016);
eq('installYearOf: month precision', installYearOf('2016-03'), 2016);
eq('installYearOf: missing -> null', installYearOf(null), null);
eq('warrantyStatusOf: expired tier -> expired', warrantyStatusOf({ expires: '2020-01-01' }, '2026-09-21'), 'expired');
eq('warrantyStatusOf: ok tier -> active', warrantyStatusOf({ expires: '2030-01-01' }, '2026-09-21'), 'active');
eq('warrantyStatusOf: expiring-30 tier folds into "expiring"', warrantyStatusOf({ expires: '2026-10-01' }, '2026-09-21'), 'expiring');
eq('warrantyStatusOf: no data -> unknown', warrantyStatusOf(null, '2026-09-21'), 'unknown');

/* ======================================================================
 * 9. Env flag.
 * ====================================================================== */
check('isAnalyticsEnabled: default true', isAnalyticsEnabled({}) === true);
check('isAnalyticsEnabled: ASK_ANALYTICS=0 disables', isAnalyticsEnabled({ ASK_ANALYTICS: '0' }) === false);

/* ======================================================================
 * 10. Reviewer NO-GO A2 (2026-09-21) — cache key derivation.
 * Analytics cache reads/writes must be namespaced away from the retrieval+
 * model path's own question_hash/prompt-version, and two DISTINCT plans must
 * never be able to collide under the same Tier-2 (plan) hash.
 * ====================================================================== */

const SAMPLE_QUESTION = 'how many customers in Arizona';
const RETRIEVAL_HASH = hashQuestion(normalizeQuestion(SAMPLE_QUESTION));
const ANALYTICS_HASH = analyticsQuestionHash(SAMPLE_QUESTION);

check('analyticsQuestionHash: never equals the retrieval path\'s hashQuestion for the same text', ANALYTICS_HASH !== RETRIEVAL_HASH);
check('analyticsQuestionHash: deterministic for the same question', analyticsQuestionHash(SAMPLE_QUESTION) === analyticsQuestionHash(SAMPLE_QUESTION));
check('analyticsQuestionHash: near-identical phrasing normalizes to the same hash', analyticsQuestionHash('How many customers in Arizona?') === ANALYTICS_HASH);
check('analyticsQuestionHash: a different question gets a different hash', analyticsQuestionHash('how many customers in Nevada') !== ANALYTICS_HASH);
check('analyticsQuestionHash: looks like a real sha256 hex digest', /^[0-9a-f]{64}$/.test(ANALYTICS_HASH));

check('ANALYTICS_PROMPT_VERSION: is a 12-char hex fingerprint', /^[0-9a-f]{12}$/.test(ANALYTICS_PROMPT_VERSION));

{
  const planA = validatePlan({ entity: 'customers', op: 'groupBy', groupBy: 'county', filters: [{ field: 'state', op: 'eq', value: 'AZ' }] });
  const planB = validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'county', op: 'eq', value: 'Pima' }] });
  const planAAgain = validatePlan({ entity: 'customers', op: 'groupBy', groupBy: 'county', filters: [{ field: 'state', op: 'eq', value: 'AZ' }] });
  // Same filters, different array order — must canonicalize to the SAME hash.
  const planAReordered = validatePlan({
    entity: 'equipment', op: 'count',
    filters: [{ field: 'installYear', op: 'lt', value: 2016 }, { field: 'brand', op: 'eq', value: 'Goodman' }],
  });
  const planAOriginalOrder = validatePlan({
    entity: 'equipment', op: 'count',
    filters: [{ field: 'brand', op: 'eq', value: 'Goodman' }, { field: 'installYear', op: 'lt', value: 2016 }],
  });

  check('analyticsPlanHash: distinct plans never collide', analyticsPlanHash(planA) !== analyticsPlanHash(planB));
  check('analyticsPlanHash: the same plan hashes identically every time', analyticsPlanHash(planA) === analyticsPlanHash(planAAgain));
  check('analyticsPlanHash: filter order does not change the hash (canonicalized)', analyticsPlanHash(planAReordered) === analyticsPlanHash(planAOriginalOrder));
  check('analyticsPlanHash: looks like a real sha256 hex digest', /^[0-9a-f]{64}$/.test(analyticsPlanHash(planA)));
  check('analyticsPlanHash: never equals analyticsQuestionHash of anything (disjoint namespaces)', analyticsPlanHash(planA) !== ANALYTICS_HASH);
}

/* ======================================================================
 * 11. Reviewer round 2 (2026-09-21) gap 1 — live-corpus classifier misses.
 * Every one of these fell through to retrieval and got a partial, unfiltered
 * model answer instead of a real analytics one. Exact strings from the
 * coordinator's report, plus the negatives/controls that must stay unchanged.
 * ====================================================================== */

const GAP1_POSITIVE_QUESTIONS = [
  'Which customers have Trane units?',
  'Which customers have Goodman units?',
  'Which customers have York units?',
  'How many units have an unknown warranty status?',
  'who has Trane units',
  'customers with expired warranties',
  'units older than 10 years',
  'how many Trane units',
  'how many Goodman units',
  'which customers have refrigerant R-22',
  'customers with Carrier units',
  'who has Rheem units',
];
check('gap 1 corpus has >= 10 exact live-reported phrasings', GAP1_POSITIVE_QUESTIONS.length >= 10, String(GAP1_POSITIVE_QUESTIONS.length));
for (const q of GAP1_POSITIVE_QUESTIONS) {
  check(`gap 1 pre-classify (positive) :: "${q}"`, preClassifyAnalytics(q) === true);
}

// Controls: the round-1 (A1) single-record exclusions must still hold after
// widening the classifier for gap 1 — a brand/age word must never override a
// street address or serial/model identifier.
const GAP1_STILL_EXCLUDED = [
  ['who has the Trane unit at 1234 Main St, Mesa AZ', 'street address still wins over WHO_HAS_RE'],
  ['customers with serial 4N2119-08772', 'identifier token still wins over NOUN_WITH_RE'],
  ['does the unit at 3247 Elm have a warranty', 'possessive single-record, unaffected by gap 1'],
];
for (const [q, why] of GAP1_STILL_EXCLUDED) {
  check(`gap 1 pre-classify (still excluded) :: "${q}" (${why})`, preClassifyAnalytics(q) === false);
}

/* ======================================================================
 * 12. Reviewer round 2 (2026-09-21) gaps 1 + 3 — brand->customers join.
 * "which customers have Trane units" already passed the classifier AND
 * validatePlan (brand is in the closed vocabulary) but was rejected at the
 * EXECUTOR level (no equipment-level column on `customers`) and fell through
 * to retrieval anyway. This runs executeAnalyticsPlan end to end against a
 * mock db (no real Postgres) to pin the fix, including gap 3's row detail
 * ("Linda Fitzgerald · Trane 4TTR4036 · Mesa").
 * ====================================================================== */

{
  const equipmentRows = [
    {
      id: 'eq1', customer_id: 'cust1', model: '4TTR4036', manufacturer: 'Trane', equipment_type: 'RTU',
      tonnage: '3', refrigerant: 'R-410A', installation_date: '2019-05-01',
      service_address: '123 Main St, Mesa, AZ 85201', warranty: null, updated_at: '2026-01-01',
    },
    {
      id: 'eq2', customer_id: 'cust2', model: 'XR16', manufacturer: 'Goodman', equipment_type: 'Condenser',
      tonnage: '2', refrigerant: 'R-410A', installation_date: '2020-01-01',
      service_address: '55 Oak Ave, Gilbert, AZ 85234', warranty: null, updated_at: '2026-01-01',
    },
  ];
  const customerRows = [
    { id: 'cust1', customer_name: 'Linda Fitzgerald', service_address: '123 Main St, Mesa, AZ 85201' },
  ];
  const mockDb = {
    raw: async (sql) => {
      if (sql.includes("entity_type = 'equipment'")) return { rows: equipmentRows };
      if (sql.includes("entity_type = 'customer'")) return { rows: customerRows };
      return { rows: [] };
    },
  };
  const plan = validatePlan({ entity: 'customers', op: 'list', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
  check('gap 1: brand filter on customers validates (closed vocabulary)', plan !== null);
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  check('gap 1: brand->customers join is handled, not a fall-through null', answer !== null);
  eq('gap 1: only the Trane customer is returned (Goodman excluded)', answer.facts.length, 1);
  eq('gap 3: row label is the customer name', answer.facts[0].label, 'Linda Fitzgerald');
  eq('gap 3: row detail is "brand model · city"', answer.facts[0].value, 'Trane 4TTR4036 · Mesa');
  eq('gap 1/3: row is linkable to the customer entity', answer.facts[0].entityId, 'cust1');
}
{
  // No matching unit at all -> a real 0, not a crash or a fall-through null.
  const mockDb = { raw: async () => ({ rows: [] }) };
  const plan = validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  check('gap 1: zero matching units -> a real answer, not null', answer !== null);
  check('gap 1: zero matching units -> text says 0', answer.text.includes('0 customer'));
}

/* ======================================================================
 * 13. Reviewer round 3 (2026-09-21) item 3 — WHO_HAS_RE over an "at <number>
 * <word>" single-record reference. STREET_ADDRESS_RE requires a recognized
 * street-suffix word ("Main St"); "1234 Main" alone (no suffix) slipped
 * through round 2's WHO_HAS_RE bypass. AT_ADDRESS_RE closes that.
 * ====================================================================== */

check('looksLikeSingleRecordReference: "at <number> <word>" with no street suffix', looksLikeSingleRecordReference('who has the unit at 1234 Main'));
check('looksLikeSingleRecordReference: "at <number> <word>" still catches a full street address too', looksLikeSingleRecordReference('who has the unit at 1234 Main St'));
check('looksLikeSingleRecordReference: no "at <number> <word>" shape -> unaffected', !looksLikeSingleRecordReference('who has Trane units'));

const ROUND3_ITEM3_EXCLUDED = [
  ['who has the unit at 1234 Main', 'no recognized street suffix, still a single-record reference'],
  ['who has the Trane unit at 500 Oak', 'brand word present, "at <number> <word>" still wins'],
  ['customers with a unit at 42 Elm', 'NOUN_WITH_RE would otherwise fire'],
];
for (const [q, why] of ROUND3_ITEM3_EXCLUDED) {
  check(`round 3 item 3 pre-classify (excluded) :: "${q}" (${why})`, preClassifyAnalytics(q) === false);
}
// Controls: real aggregate questions with no "at <number> <word>" shape must
// still classify, unaffected by this narrower exclusion.
for (const q of ['who has Trane units', 'which customers have Goodman units?', 'customers with expired warranties']) {
  check(`round 3 item 3 pre-classify (still analytics) :: "${q}"`, preClassifyAnalytics(q) === true);
}

/* ======================================================================
 * 14. Reviewer round 4 (2026-09-21) item 1 — plain-English synonyms.
 * "how many clients do we have" answered "Nothing in your records answers
 * that" on live use: "clients" was recognized but a bare "do we have"
 * question with no location/time/brand word failed the old CONTEXT gate.
 * ====================================================================== */

const ROUND4_ITEM1_POSITIVE = [
  'how many clients do we have',
  'how many accounts do we have',
  'how many homeowners do we service',
  'how many households are on file',
  'how many properties do we have',
  'how many sites do we service',
  'how many houses do we service',
  'how many businesses do we have',
  'how many jobs did we do in August',
  'how many visits did we have this week',
  'how many service calls did we make',
  'how many rooftop units do we have',
  'how many ACs do we have',
  'how many heat pumps are on file',
  'how many files did we upload this week',
  'how many docs did we get this month',
  'how many work orders do we have',
  "who's our biggest customer",
  'who is our biggest client',
  'top 10 customers',
  'our largest accounts',
];
check('round 4 item 1 corpus has >= 15 exact live-reported phrasings', ROUND4_ITEM1_POSITIVE.length >= 15, String(ROUND4_ITEM1_POSITIVE.length));
for (const q of ROUND4_ITEM1_POSITIVE) {
  check(`round 4 item 1 pre-classify (positive) :: "${q}"`, preClassifyAnalytics(q) === true);
}

const ROUND4_ITEM1_NEGATIVE = [
  ['how many tons is the Whitmore unit', 'named singular record, not an aggregate'],
  ['who has the unit at 1234 Main', 'single-record "at <number> <word>" reference'],
  ['does Henderson have a maintenance agreement', 'possessive single-record question'],
  ['which customer owns serial 4N2119-08772', 'serial-shaped identifier token'],
  ['thanks', 'not a question at all'],
];
check('round 4 item 1 negatives has >= 5 cases', ROUND4_ITEM1_NEGATIVE.length >= 5, String(ROUND4_ITEM1_NEGATIVE.length));
for (const [q, why] of ROUND4_ITEM1_NEGATIVE) {
  check(`round 4 item 1 pre-classify (negative) :: "${q}" (${why})`, preClassifyAnalytics(q) === false);
}

// One synonym table, two consumers: the planner's system prompt must mention
// every synonym the classifier's own AGGREGATE_NOUN recognizes, so the model
// can map "clients"/"accounts"/... back to the canonical entity name.
check('ENTITY_SYNONYMS: customers synonyms all appear in the system prompt', ENTITY_SYNONYMS.customers.every((w) => ANALYTICS_SYSTEM_PROMPT.includes(w)));
check('ENTITY_SYNONYMS: equipment synonyms all appear in the system prompt', ENTITY_SYNONYMS.equipment.every((w) => ANALYTICS_SYSTEM_PROMPT.includes(w)));
check('ENTITY_SYNONYMS: documents synonyms all appear in the system prompt', ENTITY_SYNONYMS.documents.every((w) => ANALYTICS_SYSTEM_PROMPT.includes(w)));
check('ENTITY_SYNONYMS: serviceVisits synonyms all appear in the system prompt', ENTITY_SYNONYMS.serviceVisits.every((w) => ANALYTICS_SYSTEM_PROMPT.includes(w)));
check('ANALYTICS_SYSTEM_PROMPT: mentions sortBy for "biggest customer"', ANALYTICS_SYSTEM_PROMPT.includes('sortBy') && ANALYTICS_SYSTEM_PROMPT.toLowerCase().includes('biggest'));

// validatePlan: sortBy vocabulary.
check('validatePlan: sortBy equipmentCount on customers/list is valid', validatePlan({ entity: 'customers', op: 'list', sortBy: 'equipmentCount' }) !== null);
check('validatePlan: sortBy documentCount on customers/list is valid', validatePlan({ entity: 'customers', op: 'list', sortBy: 'documentCount' }) !== null);
check('validatePlan: unknown sortBy value -> null (whole plan rejected)', validatePlan({ entity: 'customers', op: 'list', sortBy: 'revenue' }) === null);
check('validatePlan: sortBy on a non-customers entity -> null', validatePlan({ entity: 'equipment', op: 'list', sortBy: 'equipmentCount' }) === null);
check('validatePlan: sortBy on op "count" -> null (only "list" supports ranking)', validatePlan({ entity: 'customers', op: 'count', sortBy: 'equipmentCount' }) === null);
eq('validatePlan: sortBy caps the limit to TOP_CUSTOMERS_LIMIT even if a larger limit was set', validatePlan({ entity: 'customers', op: 'list', sortBy: 'equipmentCount', limit: 500 }).limit, TOP_CUSTOMERS_LIMIT);

// End to end against a mock db: "who's our biggest customer" ranks by
// equipment count, formats as a ranking (not a bare count), and caps at 10.
{
  const custRows = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`, customer_name: `Customer ${i}`, service_address: '1 Main St', metric: 20 - i,
  }));
  const mockDb = {
    raw: async (sql, params) => {
      if (sql.includes('entities e ON e.customer_id')) {
        check('gap: biggest-customer query passes the plan-validated limit as $1', params[0] === TOP_CUSTOMERS_LIMIT);
        return { rows: custRows.slice(0, params[0]) };
      }
      return { rows: [] };
    },
  };
  const plan = validatePlan({ entity: 'customers', op: 'list', sortBy: 'equipmentCount' });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  eq('round 4 item 1: biggest-customer answer is capped at TOP_CUSTOMERS_LIMIT rows', answer.facts.length, TOP_CUSTOMERS_LIMIT);
  eq('round 4 item 1: top row is the highest equipment count', answer.facts[0].label, 'Customer 0');
  eq('round 4 item 1: row detail reads "N units"', answer.facts[0].value, '20 units');
  check('round 4 item 1: text reads as a ranking, not a bare count', answer.text.startsWith('Your top 10 customers by equipment count'));
}
{
  // documentCount variant uses the document_entity_links join and says "N documents".
  const mockDb = {
    raw: async (sql, params) => {
      if (sql.includes('document_entity_links')) {
        return { rows: [{ id: 'c1', customer_name: 'Plaza Dental', service_address: '1 Main St', metric: 7 }] };
      }
      return { rows: [] };
    },
  };
  const plan = validatePlan({ entity: 'customers', op: 'list', sortBy: 'documentCount' });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  eq('round 4 item 1: documentCount row detail reads "N documents"', answer.facts[0].value, '7 documents');
  check('round 4 item 1: documentCount text names the right measure', answer.text.includes('document count'));
}
{
  // No customers on file at all -> a real, honest answer, not a crash.
  const mockDb = { raw: async () => ({ rows: [] }) };
  const plan = validatePlan({ entity: 'customers', op: 'list', sortBy: 'equipmentCount' });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  eq('round 4 item 1: zero customers -> honest empty answer', answer.text, 'No customers on file yet.');
}

/* ======================================================================
 * 15. Live miss (2026-09-21) item 1 — "how many jobs did we do in August"
 * fell through to retrieval. Deterministic month resolution (never the
 * model's own date math), the classifier still routing the shape, and the
 * documents SQL keying month off the extracted service_date, not created_at.
 * ====================================================================== */

eq('resolveQuestionTimeRange: bare month name -> current year', resolveQuestionTimeRange('how many jobs did we do in August', '2026-09-21'), { from: '2026-08', to: '2026-08' });
eq('resolveQuestionTimeRange: bare month in the future -> previous year', resolveQuestionTimeRange('how many jobs did we do in December', '2026-09-21'), { from: '2025-12', to: '2025-12' });
eq('resolveQuestionTimeRange: month name with an explicit year is used as-is', resolveQuestionTimeRange('how many jobs did we do in August 2024', '2026-09-21'), { from: '2024-08', to: '2024-08' });
eq('resolveQuestionTimeRange: "this month"', resolveQuestionTimeRange('how many jobs did we do this month', '2026-09-21'), { from: '2026-09', to: '2026-09' });
eq('resolveQuestionTimeRange: "last month"', resolveQuestionTimeRange('how many jobs did we do last month', '2026-09-21'), { from: '2026-08', to: '2026-08' });
eq('resolveQuestionTimeRange: "last month" across a year boundary', resolveQuestionTimeRange('how many jobs did we do last month', '2026-01-15'), { from: '2025-12', to: '2025-12' });
eq('resolveQuestionTimeRange: no month phrase -> null (model\'s own timeRange, if any, is kept)', resolveQuestionTimeRange('how many jobs did we do', '2026-09-21'), null);

eq('monthRangeLabel: single-month range', monthRangeLabel({ from: '2026-08', to: '2026-08' }), 'August 2026');
eq('monthRangeLabel: multi-month range -> null (not a "N X in Month Year" answer)', monthRangeLabel({ from: '2026-01', to: '2026-08' }), null);
eq('monthRangeLabel: no timeRange -> null', monthRangeLabel(null), null);

for (const q of [
  'how many jobs did we do in August',
  'how many service visits were there last month',
  'how many invoices did we complete in 2024',
  'how many calls did we do in September',
]) {
  check(`item 1 pre-classify (positive) :: "${q}"`, preClassifyAnalytics(q) === true);
}

{
  // "N X in Month Year" wording, once formatAnalyticsAnswer sees a validated
  // single-month range — the pattern the live miss's fix answer follows.
  const plan = validatePlan({ entity: 'documents', op: 'count', timeRange: { from: '2026-08', to: '2026-08' } });
  const out = formatAnalyticsAnswer(plan, { total: 5 });
  eq('item 1: count answer names the resolved month', out.text, '5 documents in August 2026.');
}
{
  const plan = validatePlan({ entity: 'documents', op: 'count', timeRange: { from: '2026-08', to: '2026-08' } });
  const built = buildAnalyticsSQL(plan);
  check('item 1: documents-by-month SQL reads the extracted service_date, not just created_at', built.sql.includes("field_key = 'service_date'"));
}

/* ======================================================================
 * 16. Live miss (2026-09-21) item 2 — "how many customers have an email on
 * file" returned the plain customer count; the email condition had nowhere
 * to go in the closed vocabulary and was silently dropped. hasEmail/hasPhone
 * end to end: classifier, validatePlan, SQL, matchesFilter, fact label.
 * ====================================================================== */

for (const q of [
  'how many customers have an email on file',
  'how many customers are missing a phone number',
  'customers missing a phone number',
  'customers without a phone number',
]) {
  check(`item 2 pre-classify (positive) :: "${q}"`, preClassifyAnalytics(q) === true);
}
check('item 2 pre-classify (negative) :: single-record possessive still excluded', preClassifyAnalytics('does Henderson have an email on file') === false);

check('validatePlan: hasEmail true on customers is valid', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: true }] }) !== null);
eq('validatePlan: hasEmail normalizes a stringified boolean', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: 'false' }] }).filters[0].value, false);
check('validatePlan: hasPhone on a non-customers entity -> null', validatePlan({ entity: 'equipment', op: 'count', filters: [{ field: 'hasPhone', op: 'eq', value: true }] }) === null);
check('validatePlan: hasEmail with op other than "eq" -> null', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'neq', value: true }] }) === null);
check('validatePlan: hasEmail with a non-boolean value -> null', validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: 'maybe' }] }) === null);

{
  const plan = validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: true }] });
  const built = buildAnalyticsSQL(plan);
  check('SQL (customers): hasEmail=true builds an IS NOT NULL/non-empty predicate', built.sql.includes("email' IS NOT NULL") && built.sql.includes("email' <> ''"));
}
{
  const plan = validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasPhone', op: 'eq', value: false }] });
  const built = buildAnalyticsSQL(plan);
  check('SQL (customers): hasPhone=false builds an IS NULL/empty predicate', built.sql.includes("phone' IS NULL") && built.sql.includes("phone' = ''"));
}

check('matchesFilter: hasEmail true matches a row with an email', matchesFilter({ email: 'a@b.com' }, { field: 'hasEmail', op: 'eq', value: true }));
check('matchesFilter: hasEmail true does not match a blank email', !matchesFilter({ email: '' }, { field: 'hasEmail', op: 'eq', value: true }));
check('matchesFilter: hasPhone false matches a row with no phone', matchesFilter({ phone: null }, { field: 'hasPhone', op: 'eq', value: false }));
check('matchesFilter: hasPhone false does not match a row with a phone', !matchesFilter({ phone: '480-555-0000' }, { field: 'hasPhone', op: 'eq', value: false }));

{
  const custRows = [
    { id: 'c1', customer_name: 'A', service_address: '1 Main St, Mesa, AZ 85201', email: 'a@x.com', phone: null, updated_at: '2026-01-01' },
    { id: 'c2', customer_name: 'B', service_address: '2 Main St, Mesa, AZ 85201', email: '', phone: '480-555-0000', updated_at: '2026-01-01' },
  ];
  const mockDb = { raw: async () => ({ rows: custRows }) };
  const plan = validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: true }] });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  eq('item 2: hasEmail filter narrows to the one customer with an email', answer.facts[0].value, '1');
  eq('item 2: fact label reflects the email condition', answer.facts[0].label, 'Customers with an email on file');
}
{
  const custRows = [
    { id: 'c1', customer_name: 'A', service_address: '1 Main St, Mesa, AZ 85201', email: 'a@x.com', phone: null, updated_at: '2026-01-01' },
  ];
  const mockDb = { raw: async () => ({ rows: custRows }) };
  const plan = validatePlan({ entity: 'customers', op: 'count', filters: [{ field: 'hasPhone', op: 'eq', value: false }] });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  eq('item 2: fact label reflects the missing-phone condition', answer.facts[0].label, 'Customers missing a phone number');
}

/* ======================================================================
 * 17. "how many Carrier units do we service" returned 9 with a generic
 * "Pieces of equipment" fact label — should name the brand it filtered to.
 * ====================================================================== */

{
  const plan = validatePlan({ entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Carrier' }] });
  const out = formatAnalyticsAnswer(plan, { total: 9 });
  eq('item 3: brand-filtered equipment count label names the brand', out.facts[0].label, 'Carrier units');
}
{
  // No brand filter -> unaffected, still the generic noun label.
  const plan = validatePlan({ entity: 'equipment', op: 'count' });
  const out = formatAnalyticsAnswer(plan, { total: 40 });
  eq('item 3: unfiltered equipment count keeps the generic label', out.facts[0].label, 'Pieces of equipment');
}

/* ======================================================================
 * 18. Reviewer NO-GO round 5 (2026-09-21).
 * ====================================================================== */

// Item 2: MONTH_NAME_RE year capture also accepts "of"/comma-separated years.
eq('resolveQuestionTimeRange: "August of 2023"', resolveQuestionTimeRange('how many jobs did we do in August of 2023', '2026-09-21'), { from: '2023-08', to: '2023-08' });
eq('resolveQuestionTimeRange: "August, 2023"', resolveQuestionTimeRange('how many jobs did we do in August, 2023', '2026-09-21'), { from: '2023-08', to: '2023-08' });

// Item 2: precedence between the model's own timeRange and the deterministic
// override — the model wins only when well-formed AND its year is actually
// written in the question; otherwise the deterministic reading wins.
eq(
  'reconcileTimeRange: model year matches a year written in the question -> model wins',
  reconcileTimeRange({ from: '2019-08', to: '2019-08' }, 'how many jobs did we do in August 2019', '2026-09-21'),
  { from: '2019-08', to: '2019-08' }
);
eq(
  'reconcileTimeRange: model year does NOT match the question -> deterministic override wins',
  reconcileTimeRange({ from: '2021-08', to: '2021-08' }, 'how many jobs did we do in August 2019', '2026-09-21'),
  { from: '2019-08', to: '2019-08' }
);
eq(
  'reconcileTimeRange: question names no year at all -> deterministic override wins even if model guessed one',
  reconcileTimeRange({ from: '2026-08', to: '2026-08' }, 'how many jobs did we do in August', '2026-09-21'),
  { from: '2026-08', to: '2026-08' }
);
eq(
  'reconcileTimeRange: malformed model timeRange -> deterministic override wins',
  reconcileTimeRange({ from: 'August' }, 'how many jobs did we do in August', '2026-09-21'),
  { from: '2026-08', to: '2026-08' }
);
eq(
  'reconcileTimeRange: no month phrase in the question at all -> model timeRange passed through untouched',
  reconcileTimeRange({ from: '2024-01', to: '2024-12' }, 'how many jobs did we do since 2024', '2026-09-21'),
  { from: '2024-01', to: '2024-12' }
);

// Item 1: hasEmail/hasPhone through the customers<-equipment join path
// (brand/model/etc filters) must read the CUSTOMER's own email/phone, never
// silently compare against undefined.
{
  const equipmentRows = [
    { id: 'eq1', customer_id: 'c1', model: '4TTR4036', manufacturer: 'Trane', equipment_type: 'RTU', service_address: '1 Main St, Mesa, AZ 85201', updated_at: '2026-01-01' },
    { id: 'eq2', customer_id: 'c2', model: 'XR16', manufacturer: 'Trane', equipment_type: 'RTU', service_address: '2 Main St, Mesa, AZ 85201', updated_at: '2026-01-01' },
  ];
  const customerRows = [
    { id: 'c1', customer_name: 'Has Email', service_address: '1 Main St, Mesa, AZ 85201', email: 'a@x.com', phone: null },
    { id: 'c2', customer_name: 'No Email', service_address: '2 Main St, Mesa, AZ 85201', email: '', phone: '480-555-0000' },
  ];
  const mockDb = {
    raw: async (sql) => {
      if (sql.includes("entity_type = 'equipment'")) return { rows: equipmentRows };
      if (sql.includes("entity_type = 'customer'")) return { rows: customerRows };
      return { rows: [] };
    },
  };
  const plan = validatePlan({
    entity: 'customers', op: 'list',
    filters: [{ field: 'brand', op: 'eq', value: 'Trane' }, { field: 'hasEmail', op: 'eq', value: true }],
  });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  eq('round 5 item 1: brand+hasEmail join only returns the customer that actually has an email', answer.facts.length, 1);
  eq('round 5 item 1: the surviving row is the right customer', answer.facts[0].label, 'Has Email');
}
{
  // Same join, hasEmail:false this time (the customer with NO email).
  const equipmentRows = [
    { id: 'eq1', customer_id: 'c1', model: '4TTR4036', manufacturer: 'Trane', equipment_type: 'RTU', service_address: '1 Main St, Mesa, AZ 85201', updated_at: '2026-01-01' },
    { id: 'eq2', customer_id: 'c2', model: 'XR16', manufacturer: 'Trane', equipment_type: 'RTU', service_address: '2 Main St, Mesa, AZ 85201', updated_at: '2026-01-01' },
  ];
  const customerRows = [
    { id: 'c1', customer_name: 'Has Email', service_address: '1 Main St, Mesa, AZ 85201', email: 'a@x.com', phone: null },
    { id: 'c2', customer_name: 'No Email', service_address: '2 Main St, Mesa, AZ 85201', email: '', phone: '480-555-0000' },
  ];
  const mockDb = {
    raw: async (sql) => {
      if (sql.includes("entity_type = 'equipment'")) return { rows: equipmentRows };
      if (sql.includes("entity_type = 'customer'")) return { rows: customerRows };
      return { rows: [] };
    },
  };
  const plan = validatePlan({
    entity: 'customers', op: 'list',
    filters: [{ field: 'brand', op: 'eq', value: 'Trane' }, { field: 'hasEmail', op: 'eq', value: false }],
  });
  const answer = await executeAnalyticsPlan(mockDb, plan, { today: '2026-09-21' });
  eq('round 5 item 1: brand+hasEmail:false join returns the customer with no email', answer.facts.length, 1);
  eq('round 5 item 1: the surviving row is the right customer', answer.facts[0].label, 'No Email');
}

// Item 3: the honest fallback when the plan drops a condition the question named.
check('detectedConditions: "email" question names the email condition', detectedConditions('how many customers have an email on file').has('email'));
check('detectedConditions: no relevant words -> empty set', detectedConditions('how many customers do we have').size === 0);
{
  // Email condition DROPPED by the plan (filters is empty) -> fallback text, no facts.
  const plan = { entity: 'customers', op: 'count', filters: [] };
  const missing = missingConditions(plan, 'how many customers have an email on file');
  check('round 5 item 3: dropped email condition is detected as missing', missing.has('email'));
  const answer = unsupportedConditionAnswer([...missing][0]);
  check('unsupported-condition answer uses the plan entity noun',
    unsupportedConditionAnswer('month', 'equipment').text === "I can count pieces of equipment, but I can't filter by month yet.");
  eq('round 5 item 3: fallback text names the dropped condition', answer.text, "I can count customers, but I can't filter by email yet.");
  eq('round 5 item 3: fallback answer carries no facts', answer.facts.length, 0);
}
{
  // Email condition PRESENT in the plan -> nothing missing, normal count proceeds.
  const plan = { entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: true }] };
  const missing = missingConditions(plan, 'how many customers have an email on file');
  eq('round 5 item 3: email condition present in the plan -> nothing missing', missing.size, 0);
}

/* ======================================================================
 * 15. Live miss cluster 2 (2026-09-21) — money questions must always get the
 * fixed honest fallback, never reach the planner, and detectedConditions
 * must flag 'money' for every phrasing from the live sample.
 * ====================================================================== */
{
  const MONEY_QUESTIONS = [
    "What's the total dollar amount of our open invoices?",
    "What's the total we billed in invoices this year?",
    "Who's our biggest customer by revenue?",
    'how much did we invoice last month',
    'How much have we billed year to date?',
    'Are we owed any money?',
    // Reviewer NO-GO (round 5, item 1): "invoiced" was missed because the
    // regex only spelled out literal "invoice" — now stemmed.
    "what's the total dollar amount of our open invoices",
    'how much did we bill last month',
    'biggest customer by revenue',
    'total invoiced this year',
  ];
  for (const q of MONEY_QUESTIONS) {
    check(`money: detectedConditions flags "${q}"`, detectedConditions(q).has('money'));
    check(`money: isMoneyQuestion flags "${q}"`, isMoneyQuestion(q));
  }
  const NON_MONEY = [
    'how many customers do we have',
    'which customers have Trane units',
    'when was the unit at 3247 Elm St installed',
    // Reviewer NO-GO (round 5, item 1): stemming "invoice" must not turn
    // ordinary invoice-count/lookup questions into money questions.
    'how many invoices this year',
    'list invoices for Ramirez',
    'show me the invoice from March',
    'how many customers in Mesa',
  ];
  for (const q of NON_MONEY) {
    check(`money: does not fire on "${q}"`, !isMoneyQuestion(q));
  }
  const answer = moneyFallbackAnswer();
  eq('money: fallback text is the fixed, exact copy', answer.text, MONEY_FALLBACK_TEXT);
  eq('money: fallback carries no facts', answer.facts.length, 0);
  eq('money: fallback kind is "answer" (not an error)', answer.kind, 'answer');
}

/* ======================================================================
 * 16. Live miss cluster 3 (2026-09-21) — maintenance-due synonyms must all
 * be detected and, since no last-service-date filter field exists, always
 * fall to the honest "can't filter by maintenance yet" answer rather than
 * an unfiltered count.
 * ====================================================================== */
{
  const MAINTENANCE_QUESTIONS = [
    'Which customers are overdue for maintenance?',
    'List customers due for a tune-up',
    'Which customers have not had service in 12 months?',
    "Customers who haven't been serviced",
    'customers who need service',
  ];
  for (const q of MAINTENANCE_QUESTIONS) {
    check(`maintenance: detectedConditions flags "${q}"`, detectedConditions(q).has('maintenance'));
    const missing = missingConditions({ entity: 'customers', op: 'list', filters: [] }, q);
    check(`maintenance: always missing (no such plan field exists)`, missing.has('maintenance'));
  }
  const answer = unsupportedConditionAnswer('maintenance', 'customers');
  eq('maintenance: fallback text names the condition', answer.text, "I can count customers, but I can't filter by maintenance yet.");
  eq('maintenance: fallback carries no facts', answer.facts.length, 0);
  check('maintenance: does not fire on an unrelated customer count', !detectedConditions('how many customers do we have').has('maintenance'));
}

/* ======================================================================
 * 17. Live miss cluster 1 (2026-09-21) — contact-lookup-by-name shape
 * detection, including the negative cases it must never hijack (an
 * address-based lookup, an analytics question, or a bare mention of the
 * field word with no name attached).
 * ====================================================================== */
{
  const POSITIVES = [
    ["what's the phone number on file for donna thornton", 'phone', 'donna thornton'],
    ["what's the email for sandra wyckoff", 'email', 'sandra wyckoff'],
    ["what's the ph# on file for brian chavez", 'phone', 'brian chavez'],
    ['whats the phone numbr for thomas mercer', 'phone', 'thomas mercer'],
    ["what's the service address for james patterson", 'address', 'james patterson'],
    // Reviewer NO-GO (round 5, item 2): possessive/name-before-field phrasing.
    ["whats thomas mercer's phone number", 'phone', 'thomas mercer'],
    ["donna thornton's email", 'email', 'donna thornton'],
    ['brian chavez address?', 'address', 'brian chavez'],
    // Reviewer NO-GO (round 6, item 2): short field-word typos the 5+-letter
    // general normalization floor structurally can't reach, plus running on
    // the normalized (not raw) question.
    ["what's the phne number on file for amy isaacson", 'phone', 'amy isaacson'],
    ["what's the emali for sandra wyckoff", 'email', 'sandra wyckoff'],
  ];
  for (const [q, field, name] of POSITIVES) {
    const parsed = parseContactLookupQuestion(q);
    check(`contact-lookup: detects shape for "${q}"`, parsed !== null);
    if (parsed) {
      eq(`contact-lookup: field for "${q}"`, parsed.field, field);
      eq(`contact-lookup: name phrase for "${q}"`, parsed.namePhrase.toLowerCase(), name);
    }
  }

  const NEGATIVES = [
    'who is at 1234 Main St',
    'serial for 123 W Ray Rd',
    'how many customers have a phone',
    "what's the address for 1234 Main St, Mesa",
    'does the customer have a warranty',
  ];
  for (const q of NEGATIVES) {
    check(`contact-lookup: never hijacks "${q}"`, parseContactLookupQuestion(q) === null);
  }

  check('contact-lookup: surname fuzzy match (typo)', fuzzyNameMatches('Thomas Mercer', nameTokens('thomas mercer')));
  check('contact-lookup: surname-only search matches', fuzzyNameMatches('Donna Thornton', nameTokens('thornton')));
  check(
    'contact-lookup: disagreeing first name never matches',
    !fuzzyNameMatches('Diane Chavez', nameTokens('brian chavez'))
  );

  const row = { id: 'c1', customer_number: 'C-00001', customer_name: 'Donna Thornton', phone: '(480) 555-0112', email: 'donna.thornton2@outlook.com', service_address: '123 X St, Mesa, AZ' };
  const found = buildContactAnswer('phone', row);
  check('contact-lookup: full-record answer names the customer and every field on file', found.text.includes('Donna Thornton') && found.text.includes('555-0112') && found.text.includes('outlook.com'));
  eq('contact-lookup: facts link back to the customer entity', found.facts[0].entityId, 'c1');

  const missingRow = { id: 'c2', customer_number: 'C-00002', customer_name: 'No Phone Customer', phone: null, email: 'x@y.com', service_address: '1 Main St' };
  const missingAnswer = buildContactAnswer('phone', missingRow);
  eq('contact-lookup: missing requested field is answered honestly', missingAnswer.text, 'No phone on file for No Phone Customer.');
  eq('contact-lookup: honest miss carries no facts', missingAnswer.facts.length, 0);

  const ambiguous = buildAmbiguousContactAnswer('smith', [
    { id: 'c3', customer_number: 'C-00003', customer_name: 'John Smith' },
    { id: 'c4', customer_number: 'C-00004', customer_name: 'Jane Smith' },
  ]);
  check('contact-lookup: ambiguous match names both candidates', ambiguous.text.includes('John Smith') && ambiguous.text.includes('Jane Smith'));
  eq('contact-lookup: ambiguous match returns one fact per candidate', ambiguous.facts.length, 2);
}

/* ======================================================================
 * 18. Live miss cluster 4 (2026-09-21) — street-name typo correction is a
 * pure function of (question, tenant street vocabulary): it only fixes a
 * token within edit distance 1 of a real word in THAT vocabulary, never a
 * word already recognized generally, and never a short/digit token.
 * ====================================================================== */
{
  const vocab = extractStreetTokens([
    '766 N Vista Dr, Tucson, AZ 85704',
    '248 W Huard Rd, Tucson, AZ 85705',
    '174 N College Ave, Tucson, AZ 85719',
  ]);
  check('street-typo: extracts real street tokens from addresses', vocab.has('vista') && vocab.has('huard') && vocab.has('college'));

  {
    const { corrected, corrections } = correctStreetTypos('when was the unit at 766 n val ivsta dr, tucson installed', vocab);
    eq('street-typo: corrects "ivsta" -> "vista"', corrected, 'when was the unit at 766 n val vista dr, tucson installed');
    eq('street-typo: reports the correction it made', corrections[0]?.from, 'ivsta');
  }
  {
    const { corrected } = correctStreetTypos('model number of the unit at 174 n collehe av', vocab);
    check('street-typo: corrects "collehe" -> "college"', corrected.includes('college'));
  }
  {
    const { corrected, corrections } = correctStreetTypos("what's the serial number of the unit at 248 w huard rd", vocab);
    eq('street-typo: an already-correct street name is left untouched', corrected, "what's the serial number of the unit at 248 w huard rd");
    eq('street-typo: no correction reported when nothing needed fixing', corrections.length, 0);
  }
  {
    // A word the GLOBAL vocabulary already recognizes must never be
    // "corrected" against a tenant's street list, even if it happens to be
    // one edit away from a street token — nlNormalize's VOCAB always wins.
    const { corrected } = correctStreetTypos('how many customers do we have', vocab);
    eq('street-typo: leaves an ordinary sentence alone', corrected, 'how many customers do we have');
  }
  check(
    'street-typo: common street-suffix abbreviations survive untouched (too short to ever be "corrected")',
    ['rd', 'st', 'dr', 'ave', 'blvd', 'ln', 'ct'].every((w) => correctStreetTypos(`unit on ${w} street`, vocab).corrected === `unit on ${w} street`)
  );
  {
    // Reviewer NO-GO (round 5, item 3): correction must be restricted to the
    // address span itself — a trailing, unrelated word one edit away from a
    // tenant street token must never be rewritten just because it happens to
    // sit later in the same question.
    const nameVocab = new Set(['chandler']);
    const { corrected, corrections } = correctStreetTypos(
      'who is at 1234 Elm St, ask for Chander in accounting',
      nameVocab
    );
    eq(
      'street-typo: a name outside the address span is never "corrected" against street vocab',
      corrected,
      'who is at 1234 Elm St, ask for Chander in accounting'
    );
    eq('street-typo: no correction reported for the out-of-span name', corrections.length, 0);
  }
}

/* ======================================================================
 * 19. Reviewer NO-GO (2026-09-21, round 6, item 1) — production still served
 * a stale cached "49 customers." for a maintenance-due question after the
 * missingConditions fix landed, because that check only ran once a plan
 * existed, downstream of runAnalyticsQuestion's Tier-1 cache probe. Proves
 * the money/maintenance guards now run BEFORE any cache lookup: a
 * `withTenant` that would hand back a wrong cached answer if ever called
 * must never be consulted for these questions.
 * ====================================================================== */
{
  let withTenantCalled = false;
  const poisonedWithTenant = async (_ctxArg, fn) =>
    fn({
      raw: async () => {
        withTenantCalled = true;
        return { rows: [{ answer: { kind: 'answer', text: '49 customers.', facts: [] }, corpus_stamp: 'x', created_at: new Date().toISOString() }] };
      },
    });

  const result = await runAnalyticsQuestion({
    withTenant: poisonedWithTenant,
    ctxArg: {},
    question: 'Which customers are overdue for maintenance?',
    today: '2026-09-21',
  });
  check('pre-cache guard: maintenance question never consults the cache', !withTenantCalled);
  check(
    'pre-cache guard: maintenance question returns the honest fallback, not a cached count',
    result.handled && result.data.text.includes("can't filter by maintenance")
  );
  eq('pre-cache guard: maintenance question makes no model call', result.modelCalled, false);
}
{
  let withTenantCalled = false;
  const poisonedWithTenant = async (_ctxArg, fn) =>
    fn({
      raw: async () => {
        withTenantCalled = true;
        return { rows: [{ answer: { kind: 'answer', text: '$0.00', facts: [] }, corpus_stamp: 'x', created_at: new Date().toISOString() }] };
      },
    });

  const result = await runAnalyticsQuestion({
    withTenant: poisonedWithTenant,
    ctxArg: {},
    question: "What's the total dollar amount of our open invoices?",
    today: '2026-09-21',
  });
  check('pre-cache guard: money question never consults the cache', !withTenantCalled);
  eq('pre-cache guard: money question returns the exact honest fallback text', result.data.text, MONEY_FALLBACK_TEXT);
  eq('pre-cache guard: money question makes no model call', result.modelCalled, false);
}

/* ======================================================================
 * 15. Day 2 training plan (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md) —
 *     ANALYTICS_FEW_SHOT: every positive example's plan must pass
 *     validatePlan (a curated example that the closed vocabulary itself
 *     would reject is worse than no example at all), every negative
 *     example's question must actually trip the real detector its
 *     `fallback` marker names (so the prompt's "never plan this" guidance
 *     can never drift out of sync with what the code actually intercepts),
 *     and the whole rendered block must stay within the ~900-token budget
 *     (estimated the same chars/4 way promptCache.js's own doc comment
 *     describes, floored — see that file for why this is a safe
 *     under-estimate, never an over-claim).
 * ====================================================================== */
check('ANALYTICS_FEW_SHOT has 18-25 examples', ANALYTICS_FEW_SHOT.length >= 18 && ANALYTICS_FEW_SHOT.length <= 25, String(ANALYTICS_FEW_SHOT.length));
check('ANALYTICS_FEW_SHOT has exactly 3 negative (fallback) examples', ANALYTICS_FEW_SHOT.filter((ex) => ex.fallback).length === 3);

for (const ex of ANALYTICS_FEW_SHOT) {
  if (ex.fallback) {
    const detector =
      ex.fallback === 'money' ? isMoneyQuestion(ex.q)
      : ex.fallback === 'maintenance' ? detectedConditions(ex.q).has('maintenance')
      : ex.fallback === 'single-record' ? looksLikeSingleRecordReference(ex.q)
      : false;
    check(`few-shot negative :: "${ex.q}" actually trips its "${ex.fallback}" detector`, detector);
    check(`few-shot negative :: "${ex.q}" carries no plan`, ex.plan === undefined);
  } else {
    check(`few-shot :: "${ex.q}" plan passes validatePlan`, validatePlan(ex.plan) !== null);
  }
}

const FEW_SHOT_TOKEN_ESTIMATE = Math.ceil(ANALYTICS_FEW_SHOT_BLOCK.length / 4);
check(
  `ANALYTICS_FEW_SHOT_BLOCK stays under the 900-token budget (chars/4 estimate: ${FEW_SHOT_TOKEN_ESTIMATE})`,
  FEW_SHOT_TOKEN_ESTIMATE <= 900
);
check('ANALYTICS_SYSTEM_PROMPT ends with the few-shot block (stable prefix first, for prompt caching)', ANALYTICS_SYSTEM_PROMPT.endsWith(ANALYTICS_FEW_SHOT_BLOCK));

// Miss logging must never poison the caller's transaction: a missing
// ask_misses table (migration 23 not yet run) must SAVEPOINT / ROLLBACK TO
// SAVEPOINT around the failed INSERT and never throw.
{
  const calls = [];
  const fakeDb = { raw: async (sql) => { calls.push(sql); if (/INSERT INTO ask_misses/.test(sql)) throw new Error('relation "ask_misses" does not exist'); } };
  let threw = false;
  try { await insertAskMiss(fakeDb, { question: 'x', outcome: 'no-answer' }); } catch { threw = true; }
  check('insertAskMiss never throws when the table is missing', !threw);
  check('insertAskMiss opens a SAVEPOINT before the INSERT', /^SAVEPOINT ask_miss_insert/.test(calls[0] ?? ''));
  check('insertAskMiss rolls back to the SAVEPOINT on failure', calls.some((c) => /ROLLBACK TO SAVEPOINT ask_miss_insert/.test(c)));
  const calls2 = [];
  const okDb = { raw: async (sql) => { calls2.push(sql); } };
  await insertAskMiss(okDb, { question: 'x', outcome: 'no-answer' });
  check('insertAskMiss releases the SAVEPOINT on success', calls2.some((c) => /RELEASE SAVEPOINT ask_miss_insert/.test(c)));
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
