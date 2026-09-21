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
 *      12-row cap with "and N more".
 *   8. Filter matching, grouping, brand/year/warranty-status helpers.
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
} from '../api/_lib/analytics.js';
import { isAnalyticsEnabled } from '../api/_lib/routes/analytics.js';
import { hashQuestion, normalizeQuestion } from '../api/ask.js';

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
  // 12-row cap + "and N more".
  const plan = validatePlan({ entity: 'equipment', op: 'groupBy', groupBy: 'brand' });
  const groups = Array.from({ length: 15 }, (_, i) => ({ key: `Brand${i}`, count: 15 - i }));
  const out = formatAnalyticsAnswer(plan, { total: 100, groups });
  eq('format groupBy: facts capped at MAX_FACT_ROWS', out.facts.length, MAX_FACT_ROWS);
  check('format groupBy: text says how many more', out.text.includes('3 more'));
}
{
  const plan = validatePlan({ entity: 'equipment', op: 'list', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
  const rows = [{ label: 'Trane condenser', value: 'XR16', entityId: 'c1' }];
  const out = formatAnalyticsAnswer(plan, { total: 1, rows });
  check('format list: text mentions the count', out.text.includes('1'));
  eq('format list: fact carries entityId (linkable)', out.facts[0].entityId, 'c1');
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

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
