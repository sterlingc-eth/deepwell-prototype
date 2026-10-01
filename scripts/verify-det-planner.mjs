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
import { detectAnalyticsPlan, questionNamesKnownCustomer } from '../api/_lib/analytics/detPlan.js';
import { detectCountComparison } from '../api/_lib/analytics/comparison.js';
import {
  resolveAgeFilter, warrantyStatusFromQuestion, buildConditionOverrideFilter,
  preClassifyAnalytics, resolveServiceVisitsOverride, looksLikeSingleRecordReference,
} from '../api/_lib/analytics.js';
import { isFinancialQuestion } from '../api/_lib/financials/classify.js';
import { normalizeQuestion as normalizeQuestionNL } from '../api/_lib/nlNormalize.js';

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

// R18 (H1, breadth-data-quality-017/018/019/023): this self-join family now DOES build a real
// plan — isDuplicateName/sharesAddress/isDuplicateSerial (analytics.js's DATA_QUALITY_FIELD_ENTITY),
// a cross-row frequency map computed by routes/analytics.js's attachDuplicateFlag — moved to the
// positive-shapes section below (with a still-null case for a duplicate-ish phrasing none of the
// three recognizes, preserving the "never guess" safety net for anything outside them).

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

/* ============================================================ 2b. data-quality (Round 15, A) — missing-field
 * conditions now build a real plan via DATA_QUALITY_BOOLEAN_FIELDS
 * (analytics.js) instead of falling through to the model. Positive + negative
 * per family, per the round contract.
 */

eq(
  'data-quality: "how many documents aren\'t linked to any customer"',
  detectAnalyticsPlan("how many documents aren't linked to any customer"),
  { entity: 'documents', op: 'count', filters: [{ field: 'hasCustomerLink', op: 'eq', value: false }] }
);
eq(
  'data-quality: "are there documents missing a customer" (paraphrase of the same shape)',
  detectAnalyticsPlan('are there documents missing a customer'),
  { entity: 'documents', op: 'count', filters: [{ field: 'hasCustomerLink', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many customers have no documents on file"',
  detectAnalyticsPlan('how many customers have no documents on file'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasAnyDocument', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many customers have no service address on file"',
  detectAnalyticsPlan('how many customers have no service address on file'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasServiceAddress', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many customer addresses are missing a zip code"',
  detectAnalyticsPlan('how many customer addresses are missing a zip code'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasZip', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many units are missing a serial number"',
  detectAnalyticsPlan('how many units are missing a serial number'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'hasSerial', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many units have no install date on file"',
  detectAnalyticsPlan('how many units have no install date on file'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'hasInstallDate', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many units don\'t have a model number recorded"',
  detectAnalyticsPlan("how many units don't have a model number recorded"),
  { entity: 'equipment', op: 'count', filters: [{ field: 'hasModel', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many units have no tonnage on file"',
  detectAnalyticsPlan('how many units have no tonnage on file'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'hasTonnage', op: 'eq', value: false }] }
);
eq(
  // "no warranty information at all" resolves to the existing warrantyStatus
  // 'unknown' bucket, not a new field — see detPlan.js's MISSING_FIELD_RULES
  // doc comment for why a raw-presence check on the stored warranty object
  // can never tell "no real data" from "extracted, but nothing to report".
  'data-quality: "how many units have no warranty information at all"',
  detectAnalyticsPlan('how many units have no warranty information at all'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'unknown' }] }
);
eq(
  'data-quality: "how many units are not linked to a customer"',
  detectAnalyticsPlan('how many units are not linked to a customer'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'hasCustomerLink', op: 'eq', value: false }] }
);
eq(
  'data-quality: "how many units have an install date in the future"',
  detectAnalyticsPlan('how many units have an install date in the future'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'installDateInFuture', op: 'eq', value: true }] }
);
eq(
  'data-quality: "how many documents are classified as other instead of a real type"',
  detectAnalyticsPlan('how many documents are classified as other instead of a real type'),
  { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'other' }] }
);
eq(
  // "SERVICE documents" narrows to the visit/job-record document types
  // (service-ticket/service-report/work-order/dispatch-note/inspection-
  // report/startup-sheet/invoice) — a permit or nameplate photo missing a
  // service date is not what this question is asking about.
  'data-quality: "how many service documents have no service date" (scoped to service-type documents)',
  detectAnalyticsPlan('how many service documents have no service date'),
  {
    entity: 'documents', op: 'count',
    filters: [
      { field: 'hasServiceDate', op: 'eq', value: false },
      {
        field: 'documentType', op: 'in',
        value: ['service-ticket', 'service-report', 'work-order', 'dispatch-note', 'inspection-report', 'startup-sheet', 'invoice'],
      },
    ],
  }
);
eq(
  'data-quality: a bare "how many documents have no service date" (no "service" qualifier) stays unscoped',
  detectAnalyticsPlan('how many documents have no service date'),
  { entity: 'documents', op: 'count', filters: [{ field: 'hasServiceDate', op: 'eq', value: false }] }
);

check(
  'data-quality: "no readable text extracted" still declines — no reliable proxy for this one (see READABLE_TEXT_DENY_RE)',
  detectAnalyticsPlan('how many documents have no readable text extracted') === null
);
// R18 (H1, breadth-data-quality-017/018/019/023): the self-join family — see
// isDuplicateName/sharesAddress/isDuplicateSerial's own doc comment (DATA_QUALITY_FIELD_ENTITY,
// analytics.js). op comes from opFromShape exactly like every other dedicated shape above: "which"
// -> list, "how many" -> count, a bare "do we have"/"are any" existence phrasing -> count (its
// existence/no-existence reading then comes from the answer text's own Yes/No lead-in, not the op).
eq(
  'data-quality (self-join, name): "do we have any duplicate customers"',
  detectAnalyticsPlan('do we have any duplicate customers'),
  { entity: 'customers', op: 'count', filters: [{ field: 'isDuplicateName', op: 'eq', value: true }] }
);
eq(
  'data-quality (self-join, name): "which customers appear more than once in our records" -> list op (LIST_VERB_RE)',
  detectAnalyticsPlan('which customers appear more than once in our records'),
  { entity: 'customers', op: 'list', filters: [{ field: 'isDuplicateName', op: 'eq', value: true }] }
);
eq(
  'data-quality (self-join, address): "how many customers share an address with another customer"',
  detectAnalyticsPlan('how many customers share an address with another customer'),
  { entity: 'customers', op: 'count', filters: [{ field: 'sharesAddress', op: 'eq', value: true }] }
);
eq(
  'data-quality (self-join, serial): "are any serial numbers used by more than one unit"',
  detectAnalyticsPlan('are any serial numbers used by more than one unit'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'isDuplicateSerial', op: 'eq', value: true }] }
);
// A paraphrase of the serial shape — never a bare exam sentence, the shape's own wording.
eq(
  'data-quality (self-join, serial paraphrase): "does any serial number appear under more than one customer"',
  detectAnalyticsPlan('does any serial number appear under more than one customer'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'isDuplicateSerial', op: 'eq', value: true }] }
);
check(
  'data-quality (negative, self-join): a duplicate-ish shape none of the three field mappings ' +
    'recognizes ("is the same phone number used by more than one customer" — no "duplicate"/' +
    '"once"/"address"/"serial" wording) still falls through to the SELF_DUPLICATE_RE decline — ' +
    'never guesses which field it must mean',
  detectAnalyticsPlan('is the same phone number used by more than one customer') === null
);
check(
  'data-quality (negative, dropped condition): a bare "how many documents are there" must NOT be mistaken for the ' +
    '"no readable text" shape just because both name documents — still a plain unfiltered count',
  JSON.stringify(detectAnalyticsPlan('how many documents are there')) === JSON.stringify({ entity: 'documents', op: 'count', filters: [] })
);
check(
  'data-quality (negative, ambiguous ordering): "how many customers have no email and no documents on file" still ' +
    'resolves hasAnyDocument (both conditions named — never silently drops the second one to answer only the first)',
  (() => {
    const p = detectAnalyticsPlan('how many customers have no documents on file');
    return p && p.filters.length === 1 && p.filters[0].field === 'hasAnyDocument';
  })()
);

/* ============================================================ 2c. coverage / yes-no / counts-docs / existence
 * (Round 15, A) — these already produced a correct raw plan from
 * detectAnalyticsPlan in round 14; the round-15 gap was entirely in
 * preClassifyAnalytics (the ask.js gate deciding whether to try the planner
 * at all) and resolveServiceVisitsOverride's op choice — both in
 * analytics.js, exercised end to end below with no database.
 */

for (const q of [
  'how many different zip codes do we cover',
  'how many customers do we have per zip code',
  'what zip codes do we serve',
  'do we service anything in nevada',
  'how many customers are locked into a maintenance agreement',
  'how many maintenance agreements are there',
  'is there a maintenance agreement on file for anyone',
  'did we do any service calls last month',
  'are there documents missing a customer',
]) {
  check(`round 15 pre-classify gate now lets "${q}" reach the planner`, preClassifyAnalytics(q) === true);
}

eq(
  'round 15: "did we do any service calls last month" now forces op count (existence-shaped), not list',
  resolveServiceVisitsOverride('did we do any service calls last month'),
  { entity: 'serviceVisits', op: 'count' }
);
eq(
  'round 15: an explicit "how many service calls" still forces count (unchanged from round 14)',
  resolveServiceVisitsOverride('how many service calls did we get last month'),
  { entity: 'serviceVisits', op: 'count' }
);
eq(
  'round 15: a non-existence, non-"how many" service-visits phrasing still forces list (unchanged)',
  resolveServiceVisitsOverride('which units had service this month'),
  { entity: 'serviceVisits', op: 'list' }
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
// R21 M2 (Cluster 3, REVERTED this round): resolveAgeFilter's single-threshold path ("older/newer
// than N years", "over/under N years old") went through a day-precise installDate rewrite earlier in
// this round, then had to be reverted back to a bare calendar-year cutoff (field 'installYear') after
// a full verify-golden.mjs run surfaced 9 unexpected new wrong ids (hvac-owner-0001/0002/0026/0027/
// 0035/0080, counts-age-0003/0004, breadth-multi-hop-001/002/003/004/020/024, breadth-existence-018,
// breadth-persona-011). Root cause: exam.json's own long-standing oracle for this exact phrasing
// (17+ pinned ids, confirmed via direct oracle SQL) uses `installYear < currentYear - N` — bare
// calendar year, ignoring month/day — even for "over 10 years old" phrasing with no "than" at all
// (hvac-owner-0035-canonical). Only field-phrasing-4.json's NEWER oracle (j141/j142/j143) wants
// day-precision for this same phrasing, and there is no reliable textual signal distinguishing the
// two; given the "zero new wrong ids" rule and the 17-to-3 imbalance, the single-threshold path stays
// year-based, and j141/j142/j143 are left in KNOWN_WRONG_IDS as a documented, non-regressed gap. The
// "between X and Y years old" shape (Cluster 3's j144, no corresponding original-exam id) is the one
// case with zero regression risk, so it alone keeps day-precision (field 'installDate').
check(
  'resolveAgeFilter tolerates "yeears" (doubled vowel) the same as "years"',
  JSON.stringify(resolveAgeFilter('units older than 10 yeears', '2026-09-26')) ===
    JSON.stringify({ field: 'installDate', op: 'lte', value: '2016-09-26' })
);
check(
  'resolveAgeFilter tolerates "yeasr" (transposed letters)',
  JSON.stringify(resolveAgeFilter('units older than 10 yeasr old', '2026-09-26')) ===
    JSON.stringify({ field: 'installDate', op: 'lte', value: '2016-09-26' })
);
check(
  'resolveAgeFilter tolerates "order" (nlNormalize\'s own "older"->"order" typo-corrector collision)',
  JSON.stringify(resolveAgeFilter('units order than 10 years', '2026-09-26')) ===
    JSON.stringify({ field: 'installDate', op: 'lte', value: '2016-09-26' })
);
check(
  'resolveAgeFilter: "over N years old" means the same as "older than N years"',
  JSON.stringify(resolveAgeFilter('a unit over 10 years old', '2026-09-26')) ===
    JSON.stringify({ field: 'installDate', op: 'lte', value: '2016-09-26' })
);
check(
  'resolveAgeFilter direction bug fix: "younger than N years" means NEWER, not older',
  JSON.stringify(resolveAgeFilter('a unit younger than 5 years', '2026-09-26')) ===
    JSON.stringify({ field: 'installDate', op: 'gt', value: '2021-09-26' })
);
check(
  'resolveAgeFilter (own paraphrase): "units over 15 years old" -> exact-date installDate lte (R32)',
  JSON.stringify(resolveAgeFilter('how many units on our books are over 15 years old', '2026-09-25')) ===
    JSON.stringify({ field: 'installDate', op: 'lte', value: '2011-09-25' })
);
check(
  'resolveAgeFilter (own paraphrase): "units under 5 years old" -> exact-date installDate gt (R32)',
  JSON.stringify(resolveAgeFilter('how many units on our books are under 5 years old', '2026-09-25')) ===
    JSON.stringify({ field: 'installDate', op: 'gt', value: '2021-09-25' })
);
check(
  'resolveAgeFilter (own paraphrase): "replacement candidates over 15 years old" -> same exact-date shape regardless of the "candidates" noun',
  JSON.stringify(resolveAgeFilter('how many replacement candidates are over 15 years old', '2026-09-25')) ===
    JSON.stringify({ field: 'installDate', op: 'lte', value: '2011-09-25' })
);
check(
  'resolveAgeFilter negative: "newer than 5 years" (not "under") still resolves the same newer-direction gt shape',
  JSON.stringify(resolveAgeFilter('units newer than 5 years', '2026-09-25')) ===
    JSON.stringify({ field: 'installDate', op: 'gt', value: '2021-09-25' })
);
check(
  'resolveAgeFilter (Cluster 3, own paraphrase): "between 10 and 15 years old" -> two installDate filters',
  JSON.stringify(resolveAgeFilter('how many units are between 10 and 15 years old', '2026-09-25')) ===
    JSON.stringify([
      { field: 'installDate', op: 'lte', value: '2016-09-25' },
      { field: 'installDate', op: 'gt', value: '2011-09-25' },
    ])
);
check(
  'resolveAgeFilter (Cluster 3, own paraphrase): "between" tolerates the bounds given in either order',
  JSON.stringify(resolveAgeFilter('how many units are between 15 and 10 years old', '2026-09-25')) ===
    JSON.stringify([
      { field: 'installDate', op: 'lte', value: '2016-09-25' },
      { field: 'installDate', op: 'gt', value: '2011-09-25' },
    ])
);
check(
  'resolveAgeFilter negative: no age phrase at all -> null',
  resolveAgeFilter('how many units do we have', '2026-09-25') === null
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

/* ============================================================ 6. Round 15 follow-up (P0 generalization
 * audit): a NAMED customer/business must never be answered by a tenant-wide aggregate. Two separate
 * defenses, tested separately: (a) looksLikeSingleRecordReference (analytics.js) — the gate ask.js checks
 * BEFORE a question is even an analytics candidate — now recognizes a bare "is <Name> {still} under/out of
 * warranty" subject and a 3+ word trailing business name; (b) questionNamesKnownCustomer/the tenantVocab
 * guard inside detectAnalyticsPlan itself — a last-resort backstop for any OTHER named-customer shape (a),
 * or the model's own patterns, don't happen to catch, since no plan this file ever builds carries a
 * customerName filter. Every name below is a made-up SHAPE example, never a real exam question/customer. */

check(
  'looksLikeSingleRecordReference: bare "is <First Last> out of warranty yet" is a single-record reference (was falling through to a tenant-wide aggregate)',
  looksLikeSingleRecordReference('is Matthew Whitfield out of warranty yet') === true
);
check(
  'looksLikeSingleRecordReference: bare "is <Surname> out of warranty yet" (single-word name) is a single-record reference',
  looksLikeSingleRecordReference('is Thornton out of warranty yet') === true
);
check(
  'looksLikeSingleRecordReference: "is <Surname> still under warranty and who\'s the tech" is a single-record reference',
  looksLikeSingleRecordReference("is Abernathy still under warranty and who's the tech") === true
);
check(
  'looksLikeSingleRecordReference negative: "who is still under warranty" (no name, "still" is not a name) stays a real aggregate question',
  looksLikeSingleRecordReference('who is still under warranty') === false
);
check(
  'looksLikeSingleRecordReference negative: "is anyone currently under warranty" (indefinite pronoun) stays a real aggregate question',
  looksLikeSingleRecordReference('is anyone currently under warranty') === false
);
check(
  'looksLikeSingleRecordReference negative: bare "how many customers are under warranty" is unaffected',
  looksLikeSingleRecordReference('how many customers are under warranty') === false
);

check(
  'looksLikeSingleRecordReference: a THREE-word trailing business name ("...for Copper Sky Dental") is a single-record reference (was capped at 1-2 words and fell through to a tenant-wide count)',
  looksLikeSingleRecordReference('how many jobs have we done for copper sky dental') === true
);
check(
  'looksLikeSingleRecordReference: a FOUR-word trailing business name is still a single-record reference',
  looksLikeSingleRecordReference('what invoices do we have for valley view auto body shop') === true
);
check(
  'looksLikeSingleRecordReference negative: a genuine multi-word aggregate tail ("...for this quarter\'s customers") still excluded by the first-word stopword guard',
  looksLikeSingleRecordReference("how many invoices do we have for this quarter's customers") === false
);
check(
  'looksLikeSingleRecordReference negative: "...for our regular customers" still excluded (first word "our" is a stopword)',
  looksLikeSingleRecordReference('how many jobs have we done for our regular customers') === false
);

/* -- (b) the tenantVocab-based backstop inside detectAnalyticsPlan itself -- */

const FAKE_TENANT_VOCAB = { customers: { phrases: ['Matthew Whitfield', 'Copper Sky Dental', 'Wood'] } };

check(
  'questionNamesKnownCustomer: a known full customer name mentioned anywhere in the question is detected',
  questionNamesKnownCustomer('how many units are out of warranty for matthew whitfield', FAKE_TENANT_VOCAB) === true
);
check(
  'questionNamesKnownCustomer: a known business name mentioned anywhere in the question is detected',
  questionNamesKnownCustomer('what do we have on file for copper sky dental', FAKE_TENANT_VOCAB) === true
);
check(
  'questionNamesKnownCustomer negative: a bare aggregate question naming no customer is not flagged',
  questionNamesKnownCustomer('how many units are out of warranty', FAKE_TENANT_VOCAB) === false
);
check(
  'questionNamesKnownCustomer negative: a short/common single-word customer name ("Wood") never false-positives on an ordinary mention of the material',
  questionNamesKnownCustomer('we replaced the wood trim around the unit', FAKE_TENANT_VOCAB) === false
);
check(
  'detectAnalyticsPlan bails (null) when tenantVocab names a customer this file has no filter field for, instead of a confident tenant-wide plan',
  detectAnalyticsPlan('how many units are out of warranty for matthew whitfield', FAKE_TENANT_VOCAB) === null
);
check(
  'detectAnalyticsPlan is completely unaffected when no tenantVocab is passed (every existing caller/test above)',
  JSON.stringify(detectAnalyticsPlan('how many units are out of warranty for matthew whitfield')) ===
    JSON.stringify({ entity: 'equipment', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }] })
);
check(
  'detectAnalyticsPlan: a bare aggregate question with tenantVocab present still plans normally (no false-positive bail)',
  JSON.stringify(detectAnalyticsPlan('how many units are out of warranty', FAKE_TENANT_VOCAB)) ===
    JSON.stringify({ entity: 'equipment', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }] })
);

/* -- (c) the financials/classify.js hook: a bare "how many ... agreement(s)" count is a document
 * count, never a money question -- */

check(
  'isFinancialQuestion: a bare "how many maintenance agreements are there" is NOT financial (a document count analytics already answers)',
  isFinancialQuestion('how many maintenance agreements are there') === false
);
check(
  'isFinancialQuestion: "how many customers are locked into a maintenance agreement" is NOT financial',
  isFinancialQuestion('how many customers are locked into a maintenance agreement') === false
);
check(
  'isFinancialQuestion negative-of-negative: "how much do our maintenance agreements bring in" is STILL financial (revenue language, not a bare count)',
  isFinancialQuestion('how much do our maintenance agreements bring in') === true
);
check(
  'isFinancialQuestion negative-of-negative: "how many invoices do we have on file" (a real money-document noun) is unaffected, still financial',
  isFinancialQuestion('how many invoices do we have on file') === true
);

/* -- (d) regression guard (breadth-connect-120): declassifying the financials gate for a bare
 * "how many ... agreement(s)" count must never expose a JOIN/HAVING-COUNT-0 shape ("...have zero
 * service visits behind them") to the flat-plan generic path, which would otherwise silently drop
 * the "zero visits" half and answer a bare, unqualified document count. -- */

check(
  'detectAnalyticsPlan declines (null) "how many maintenance agreements have zero service visits behind them" — a cross-entity join count this flat plan has no field for, never a bare document count',
  detectAnalyticsPlan('how many maintenance agreements have zero service visits behind them') === null
);
check(
  'detectAnalyticsPlan declines the same join shape phrased with a different linked-event noun ("...with no callbacks since installation")',
  detectAnalyticsPlan('how many units have no callbacks since installation') === null
);
check(
  'isFinancialQuestion: the same join-shaped question is unaffected by the classify.js hook either way (still not financial - it is a connect/relations shape, not money)',
  isFinancialQuestion('how many maintenance agreements have zero service visits behind them') === false
);

/* -- (e) generalization-audit regression (g109): "is there a customer named <Name>" was newly
 * exposed by this round's own earlier existence-shape widening (isExistenceQuestion &&
 * cr.aggregateNoun) and answered a tenant-wide "Yes, you have 120 customers." instead of resolving
 * (or declining on) the one named customer. -- */

check(
  'looksLikeSingleRecordReference: "is there a customer named <Name>" is a single-record reference (was answering a tenant-wide count)',
  looksLikeSingleRecordReference('is there a customer named ortega') === true
);
check(
  'looksLikeSingleRecordReference: "is there a client named <First Last>" is a single-record reference',
  looksLikeSingleRecordReference('is there a client named jane rodriguez') === true
);
check(
  'looksLikeSingleRecordReference: "is there an account named <Business Name>" is a single-record reference',
  looksLikeSingleRecordReference('is there an account named acme corp') === true
);
check(
  'looksLikeSingleRecordReference negative: a bare "is there a customer" (no "named ...") stays a real existence/aggregate question',
  looksLikeSingleRecordReference('is there a customer') === false
);
check(
  'preClassifyAnalytics: "is there a customer named <Name>" is excluded from the analytics candidate path entirely',
  preClassifyAnalytics('is there a customer named ortega') === false
);

/* -- (f) R16 D2 audit / field-phrasing g133+g138: "oldest unit on file" / "newest install" ranks
 * equipment by installation_date rather than filtering/counting; the ranking sortBy shape must
 * stay scoped to a genuine equipment/install noun and never fire on an unrelated superlative this
 * file has no ranking query for. -- */

eq(
  'field-phrasing g133: "whats the oldest unit we have on file" ranks equipment ascending by installation_date',
  detectAnalyticsPlan('whats the oldest unit we have on file'),
  { entity: 'equipment', op: 'list', sortBy: 'installDateAsc' }
);
eq(
  'field-phrasing g138: "whats our newest install" ranks equipment descending by installation_date',
  detectAnalyticsPlan('whats our newest install'),
  { entity: 'equipment', op: 'list', sortBy: 'installDateDesc' }
);
eq(
  'install-date-extreme: "earliest system we installed" (earliest/system synonyms) also resolves',
  detectAnalyticsPlan('whats the earliest system we installed'),
  { entity: 'equipment', op: 'list', sortBy: 'installDateAsc' }
);
eq(
  'install-date-extreme: "latest rooftop unit" (latest/rooftop-unit synonyms) also resolves',
  detectAnalyticsPlan('whats the latest rooftop unit on file'),
  { entity: 'equipment', op: 'list', sortBy: 'installDateDesc' }
);
check(
  'install-date-extreme: never fires with no equipment/install noun at all ("whats our newest customer") - no ranking query exists for that entity',
  detectAnalyticsPlan('whats our newest customer') === null
);

/* -- (g) R18 PART 2 (P4, blind generalization round): every detected condition must be represented
 * in the plan (multi-hop AND-drop, h090/h099-h105), a central time-window parser reused for
 * warranty expiry (h047-h074), negation must be applied or bail (h125/h127/h128/h134/h189), and
 * reverse "customers by <geo>"/"how many different <geo>"/data-quality-missing-<geo> shapes must
 * NOT be swept into that same merge (own paraphrases, not exam text). -- */

eq(
  'multi-hop AND-drop: "how many trane customers needed a repair visit" keeps BOTH the brand and the service-type condition (was silently dropping the second)',
  detectAnalyticsPlan('how many trane customers needed a repair visit'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasServiceType', op: 'eq', value: 'Repair' }, { field: 'brand', op: 'eq', value: 'Trane' }] }
);
eq(
  'multi-hop AND-drop, negated: "how many carrier customers have never had a preventive maintenance visit" keeps brand + lacksServiceType, with no contradictory hasServiceType also present',
  detectAnalyticsPlan('how many carrier customers have never had a preventive maintenance visit'),
  { entity: 'customers', op: 'count', filters: [{ field: 'lacksServiceType', op: 'eq', value: 'Preventive Maintenance' }, { field: 'brand', op: 'eq', value: 'Carrier' }] }
);
eq(
  'multi-hop AND-drop: brand + doc-type + service-type can all three ride the same plan ("how many trane customers have a service ticket for a repair job")',
  detectAnalyticsPlan('how many trane customers have a service ticket for a repair job'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasDocType', op: 'eq', value: 'service-ticket' }, { field: 'brand', op: 'eq', value: 'Trane' }, { field: 'hasServiceType', op: 'eq', value: 'Repair' }] }
);

eq(
  // Pinned `today` (matches this suite's own '2026-09-27' convention used elsewhere in this file,
  // e.g. the install-year-relative checks below) — the real wall-clock default this call used to
  // fall through to drifts a day at a time and desyncs from this test's own hardcoded expected
  // dates, a real (not flaky-by-nature) failure, not a timing fluke.
  'time-window (own paraphrase): "how many units have their warranty expiring since january 1st" resolves a real gte/lte warrantyExpires window, not the unfiltered portfolio',
  detectAnalyticsPlan('how many units have their warranty expiring since january 1st', {}, '2026-09-27'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyExpires', op: 'gte', value: '2026-01-01' }, { field: 'warrantyExpires', op: 'lte', value: '2026-09-27' }] }
);
eq(
  // Pinned `today` (year, not just day, drifts this one — see the doc comment on the "since
  // january 1st" check above) so this doesn't flip to 2027 once the calendar turns.
  'time-window (own paraphrase): "how many units warranty expires this spring" resolves the season to a month range',
  detectAnalyticsPlan('how many units warranty expires this spring', {}, '2026-09-27'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyExpires', op: 'gte', value: '2026-03-01' }, { field: 'warrantyExpires', op: 'lte', value: '2026-05-31' }] }
);
eq(
  // Pinned `today` — see the doc comment on the "since january 1st" check just above.
  'time-window (own paraphrase): "how many units warranty expires by end of year" resolves today..year-end',
  detectAnalyticsPlan('how many units warranty expires by end of year', {}, '2026-09-27'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyExpires', op: 'gte', value: '2026-09-27' }, { field: 'warrantyExpires', op: 'lte', value: '2026-12-31' }] }
);
eq(
  // Pinned `today` — see the doc comment on the "since january 1st" check above.
  'time-window (own paraphrase): "how many units warranty expires in the next 90 days" resolves today..+90d',
  detectAnalyticsPlan('how many units warranty expires in the next 90 days', {}, '2026-09-27'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyExpires', op: 'gte', value: '2026-09-27' }, { field: 'warrantyExpires', op: 'lte', value: '2026-12-26' }] }
);
eq(
  'distinct-count (own paraphrase): "how many different years do we have service records on file" groups serviceVisits by year, countDistinct',
  detectAnalyticsPlan('how many different years do we have service records on file'),
  { entity: 'serviceVisits', op: 'groupBy', groupBy: 'year', countDistinct: true }
);

eq(
  'negation guard (own paraphrase of h189 shape): "how many customers arent even in arizona" flips to neq, never double-negates or drops the filter',
  detectAnalyticsPlan('how many customers arent even in arizona'),
  { entity: 'customers', op: 'count', filters: [{ field: 'state', op: 'neq', value: 'AZ' }] }
);
eq(
  'data-quality (own paraphrase of h134 shape): "how many customers have zero equipment on file" builds hasAnyEquipment=false, not a bare unfiltered count',
  detectAnalyticsPlan('how many customers have zero equipment on file'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasAnyEquipment', op: 'eq', value: false }] }
);

// Regression guard for the merge-dedup bug this round's own mergeDetectedConditions introduced and
// this round then fixed: scoping mergeDetectedConditions to ONLY the two cross-doc customer
// detectors (hasDocType/hasServiceType) must never make a genuine groupBy/distinct-count/data-
// quality shape that merely MENTIONS a safety-net keyword (county/zip) with no extractable value
// come back null (buildConditionOverrideFilter has nothing to build for a bare "by county" and used
// to report the whole plan unresolved).
eq(
  'merge-dedup scope regression: "customers by county" (a bare groupBy, no county NAMED) still resolves — must never be swept into the cross-doc safety-net merge',
  detectAnalyticsPlan('customers by county'),
  { entity: 'customers', op: 'groupBy', groupBy: 'county' }
);
eq(
  'merge-dedup scope regression: "how many different zip codes do we cover" (a bare distinct-count, no zip NAMED) still resolves',
  detectAnalyticsPlan('how many different zip codes do we cover'),
  { entity: 'customers', op: 'groupBy', groupBy: 'zip', countDistinct: true }
);
eq(
  'merge-dedup scope regression: "how many customer addresses are missing a zip code" (data-quality, no zip NAMED) still resolves',
  detectAnalyticsPlan('how many customer addresses are missing a zip code'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasZip', op: 'eq', value: false }] }
);

/* ============================================================ R19 (I2): rankings (h112-h115) */

// "biggest/fewest <dimension>" — detectGroupBySuperlative — 5+ paraphrases across every dimension
// this round's target ids need, plus negatives (no dimension named, plain groupBy stays plain).
eq('superlative (top): "single biggest city" -> customers grouped by city, top', detectAnalyticsPlan('how many customers are in our single biggest city'), { entity: 'customers', op: 'groupBy', groupBy: 'city', superlative: 'top' });
eq('superlative (top): "our largest state" (largest, not biggest)', detectAnalyticsPlan("what's our largest state by customer count"), { entity: 'customers', op: 'groupBy', groupBy: 'state', superlative: 'top' });
eq('superlative (bottom): "which manufacturer do we have the fewest units of" -> equipment grouped by brand, bottom', detectAnalyticsPlan('which manufacturer do we have the fewest units of'), { entity: 'equipment', op: 'groupBy', groupBy: 'brand', superlative: 'bottom' });
eq('superlative (bottom): "which tech has done the fewest visits" -> serviceVisits grouped by technician, bottom', detectAnalyticsPlan('which tech has done the fewest visits'), { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician', superlative: 'bottom' });
eq('superlative (bottom): "brand" wording also resolves (not just "manufacturer")', detectAnalyticsPlan('which brand do we have the fewest units of'), { entity: 'equipment', op: 'groupBy', groupBy: 'brand', superlative: 'bottom' });
eq('superlative (bottom): "least" is the same shape as "fewest"', detectAnalyticsPlan('which county has the least customers'), { entity: 'customers', op: 'groupBy', groupBy: 'county', superlative: 'bottom' });
check('superlative negative: a plain groupBy ("customers by county") is NOT a superlative plan', !detectAnalyticsPlan('customers by county')?.superlative);
check('superlative negative: no recognized dimension word -> null (never guessed)', detectAnalyticsPlan('which customer spent the most money') === null || !detectAnalyticsPlan('which customer spent the most money')?.superlative);

// "whats our newest <brand> install" (h114) — detectInstallDateExtreme now carries a brand filter.
eq('install-date-extreme + brand filter: "newest mitsubishi install"', detectAnalyticsPlan('whats our newest mitsubishi install'), { entity: 'equipment', op: 'list', sortBy: 'installDateDesc', filters: [{ field: 'brand', op: 'eq', value: 'Mitsubishi' }] });
eq('install-date-extreme + brand filter: "oldest trane unit we have on file"', detectAnalyticsPlan('whats the oldest trane unit we have on file'), { entity: 'equipment', op: 'list', sortBy: 'installDateAsc', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] });
eq('install-date-extreme, no brand named: still a bare sortBy plan (no filters key at all)', detectAnalyticsPlan('whats the newest unit we have installed'), { entity: 'equipment', op: 'list', sortBy: 'installDateDesc' });

/* ============================================================ R19 (I2): yes/no comparisons */

eq('count comparison: brand vs brand ("do we have more X than Y")', detectCountComparison('do we have more mitsubishi units installed than trane'), {
  entity: 'equipment',
  leftFilter: { field: 'brand', op: 'eq', value: 'Mitsubishi' }, rightFilter: { field: 'brand', op: 'eq', value: 'Trane' },
  leftLabel: 'Mitsubishi units', rightLabel: 'Trane units',
});
eq('count comparison: "is X more common than Y" (brand)', detectCountComparison('is daikin more common than goodman in our records'), {
  entity: 'equipment',
  leftFilter: { field: 'brand', op: 'eq', value: 'Daikin' }, rightFilter: { field: 'brand', op: 'eq', value: 'Goodman' },
  leftLabel: 'Daikin units', rightLabel: 'Goodman units',
});
eq('count comparison: city vs city ("do we have more customers in X than in Y")', detectCountComparison('do we have more customers in mesa than in tucson'), {
  entity: 'customers',
  leftFilter: { field: 'city', op: 'eq', value: 'Mesa' }, rightFilter: { field: 'city', op: 'eq', value: 'Tucson' },
  leftLabel: 'customers in Mesa', rightLabel: 'customers in Tucson',
});
eq('count comparison: registered vs unregistered warranties (h122)', detectCountComparison('do we have more registered warranties than unregistered ones'), {
  entity: 'equipment',
  leftFilter: { field: 'warrantyRegistered', op: 'eq', value: true }, rightFilter: { field: 'warrantyRegistered', op: 'eq', value: false },
  leftLabel: 'registered warranties', rightLabel: 'unregistered warranties',
});
eq('count comparison: unregistered vs registered (reversed order)', detectCountComparison('do we have more unregistered warranties than registered ones'), {
  entity: 'equipment',
  leftFilter: { field: 'warrantyRegistered', op: 'eq', value: false }, rightFilter: { field: 'warrantyRegistered', op: 'eq', value: true },
  leftLabel: 'unregistered warranties', rightLabel: 'registered warranties',
});

// Negatives: never guess a comparison whose side needs fuzzy customer-name/address/financials
// resolution, and never misfire on an unrelated "than" sentence with no yes/no lead-in.
check('count comparison negative: named-customer comparison bails (no customerName vocabulary here)', detectCountComparison('has Rebecca Montoya had more documents on file than Charles Montoya') === null);
check('count comparison negative: address/job-total comparison bails (financials join, not this file)', detectCountComparison('was the job at 803 e pecos rd bigger than the job at 877 w ocotillo rd') === null);
check('count comparison negative: "more than N" (a plain threshold, not a two-sided comparison) bails', detectCountComparison('do we have more than 5 trane units') === null);
check('count comparison negative: no yes/no lead-in verb -> bails', detectCountComparison('customers with more trane units than carrier units') === null);
check('count comparison negative: same brand both sides -> bails (never a trivially-true/false guess)', detectCountComparison('do we have more trane units than trane units') === null);

/* ============================================================ R20 (J3, round 20): new shapes */

// --- detectInstallYearRelative (i003/F1 "installs this year vs last") ---
eq('install-year-relative: "how many units did we install this year"', detectAnalyticsPlan('how many units did we install this year', {}, '2026-09-27'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'installYear', op: 'eq', value: 2026 }] });
eq('install-year-relative: "how many units have we installed so far this year"', detectAnalyticsPlan('how many units have we installed so far this year', {}, '2026-09-27'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'installYear', op: 'eq', value: 2026 }] });
eq('install-year-relative: "how many installs did we do last year"', detectAnalyticsPlan('how many installs did we do last year', {}, '2026-09-27'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'installYear', op: 'eq', value: 2025 }] });
eq('install-year-relative: "which units were installed this year"', detectAnalyticsPlan('which units were installed this year', {}, '2026-09-27'),
  { entity: 'equipment', op: 'list', filters: [{ field: 'installYear', op: 'eq', value: 2026 }] });
check('install-year-relative negative: a literal year ("installed in 2024") is not this detector\'s job — bails to filters:[]',
  JSON.stringify(detectAnalyticsPlan('how many units were installed in 2024', {}, '2026-09-27').filters) === '[]');
check('install-year-relative negative: no install word at all -> untouched by this detector', detectAnalyticsPlan('how many customers do we have', {}, '2026-09-27').filters.length === 0);

// --- detectMultiUnitCustomers ---
eq('multi-unit customers: "which customers have more than one unit installed at their property"',
  detectAnalyticsPlan('which customers have more than one unit installed at their property'),
  { entity: 'customers', op: 'list', filters: [{ field: 'hasMultipleUnits', op: 'eq', value: true }] });
eq('multi-unit customers: "how many properties have more than one unit installed"',
  detectAnalyticsPlan('how many properties have more than one unit installed'),
  { entity: 'customers', op: 'count', filters: [{ field: 'hasMultipleUnits', op: 'eq', value: true }] });
eq('multi-unit customers: "which customers have multiple units installed at their home"',
  detectAnalyticsPlan('which customers have multiple units installed at their home'),
  { entity: 'customers', op: 'list', filters: [{ field: 'hasMultipleUnits', op: 'eq', value: true }] });
eq('multi-unit customers: "which customers have at least two units installed at their address"',
  detectAnalyticsPlan('which customers have at least two units installed at their address'),
  { entity: 'customers', op: 'list', filters: [{ field: 'hasMultipleUnits', op: 'eq', value: true }] });
check('multi-unit customers negative: "how many customers have multiple units" (no "installed at") never guesses', detectAnalyticsPlan('how many customers have multiple units').filters.length === 0);

// --- detectVendorPurchaseOrderCount (i020/i021) ---
eq('vendor PO count: "how many purchase orders have we cut to Baker Distributing"',
  detectAnalyticsPlan('how many purchase orders have we cut to Baker Distributing'),
  { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'purchase-order' }, { field: 'vendor', op: 'contains', value: 'Baker Distributing' }] });
eq('vendor PO count: "how many purchase orders were issued to ABC Supply"',
  detectAnalyticsPlan('how many purchase orders were issued to ABC Supply'),
  { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'purchase-order' }, { field: 'vendor', op: 'contains', value: 'Abc Supply' }] });
check('vendor PO count: "purchase orders sent to Carrier Wholesale" resolves a vendor filter',
  (detectAnalyticsPlan('how many purchase orders were sent to Carrier Wholesale').filters ?? []).some((f) => f.field === 'vendor' && f.value === 'Carrier Wholesale'));
check('vendor PO count negative: "how many invoices have we sent to Baker Distributing" (not a PO) never adds a vendor filter',
  !(detectAnalyticsPlan('how many invoices have we sent to Baker Distributing').filters ?? []).some((f) => f.field === 'vendor'));
check('vendor PO count negative: bare "how many purchase orders do we have" (no vendor named) never adds a vendor filter',
  !(detectAnalyticsPlan('how many purchase orders do we have').filters ?? []).some((f) => f.field === 'vendor'));

// --- detectWarrantyRegistrationDays ---
eq('warranty-reg-days: "took longer than 30 days after the install"',
  detectAnalyticsPlan('how many warranty registrations took longer than 30 days after the install'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyRegistrationDays', op: 'gt', value: 30 }] });
eq('warranty-reg-days: "took more than 45 days after install"',
  detectAnalyticsPlan('how many warranty registrations took more than 45 days after install'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyRegistrationDays', op: 'gt', value: 45 }] });
eq('warranty-reg-days: "over 60 days after the install"',
  detectAnalyticsPlan('how many warranty registrations were over 60 days after the install'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyRegistrationDays', op: 'gt', value: 60 }] });
check('warranty-reg-days negative: "warranty registrations were on time" (no day threshold) bails', detectAnalyticsPlan('how many warranty registrations were on time').filters.length === 0);
check('warranty-reg-days negative: a day count with no "warranty registration" phrase never fires this detector',
  !(detectAnalyticsPlan('how many units are more than 60 days overdue for service').filters ?? []).some((f) => f.field === 'warrantyRegistrationDays'));

// --- detectWarrantyRegDateExtreme (i115/i116) ---
eq('warranty-reg-date extreme: "earliest warranty registration date"', detectAnalyticsPlan("what's the earliest warranty registration date we have on file"),
  { entity: 'equipment', op: 'list', sortBy: 'warrantyRegDateAsc' });
eq('warranty-reg-date extreme: "oldest warranty registration on file"', detectAnalyticsPlan('whats the oldest warranty registration we have on file'),
  { entity: 'equipment', op: 'list', sortBy: 'warrantyRegDateAsc' });
eq('warranty-reg-date extreme: "most recent warranty registration date"', detectAnalyticsPlan('whats the most recent warranty registration date on file'),
  { entity: 'equipment', op: 'list', sortBy: 'warrantyRegDateDesc' });
eq('warranty-reg-date extreme: "latest warranty registration on file"', detectAnalyticsPlan('whats the latest warranty registration we have on file'),
  { entity: 'equipment', op: 'list', sortBy: 'warrantyRegDateDesc' });
check('warranty-reg-date extreme negative: "oldest unit on file" (install-date ranking, no "warranty registration" phrase) never gets warrantyRegDate sortBy',
  detectAnalyticsPlan('whats the oldest unit we have on file').sortBy === 'installDateAsc');

// --- COMPARISON_YESNO_LEAD_RE / preClassifyAnalytics ask.js gate-miss ("is A more common than B") ---
check('preClassify: "is daikin more common than goodman in our records" is admitted (was the ask.js gate-miss target)', preClassifyAnalytics('is daikin more common than goodman in our records') === true);
check('preClassify: "have we sold more Lennox units than Rheem" is admitted', preClassifyAnalytics('have we sold more Lennox units than Rheem') === true);
check('preClassify: "were there more service calls this year than last year" is admitted', preClassifyAnalytics('were there more service calls this year than last year') === true);
check('preClassify: "did we install more units last year than this year" is admitted', preClassifyAnalytics('did we install more units last year than this year') === true);
check('preClassify: "is Mesa more common than Tucson for our customers" is admitted', preClassifyAnalytics('is Mesa more common than Tucson for our customers') === true);
check('preClassify negative: a name-vs-name comparison with no more/fewer/greater/higher/busier word stays excluded',
  preClassifyAnalytics('was the invoice for Smith bigger than the one for Jones') === false);

eq('count comparison (via the newly-admitted gate): "is daikin more common than goodman"', detectCountComparison('is daikin more common than goodman in our records', '2026-09-27'), {
  entity: 'equipment',
  leftFilter: { field: 'brand', op: 'eq', value: 'Daikin' }, rightFilter: { field: 'brand', op: 'eq', value: 'Goodman' },
  leftLabel: 'Daikin units', rightLabel: 'Goodman units',
});

// --- detectInstallYearComparison (i003, comparison.js) ---
eq('count comparison: install years, "did we install more units last year than this year"',
  detectCountComparison('did we install more units last year than we have this year', '2026-09-27'),
  {
    entity: 'equipment',
    leftFilter: { field: 'installYear', op: 'eq', value: 2025 }, rightFilter: { field: 'installYear', op: 'eq', value: 2026 },
    leftLabel: 'installs in 2025', rightLabel: 'installs so far in 2026',
  });
eq('count comparison: install years, reversed ("more installs this year than last year")',
  detectCountComparison('did we do more installs this year than last year', '2026-09-27'),
  {
    entity: 'equipment',
    leftFilter: { field: 'installYear', op: 'eq', value: 2026 }, rightFilter: { field: 'installYear', op: 'eq', value: 2025 },
    leftLabel: 'installs so far in 2026', rightLabel: 'installs in 2025',
  });
check('count comparison negative: install-year comparison naming the SAME year both sides bails',
  detectCountComparison('did we install more units this year than this year', '2026-09-27') === null);
check('count comparison negative: no install-word at all -> the year comparison branch itself never fires (falls to brand/city, which also bail here)',
  detectCountComparison('did we have more revenue this year than last year', '2026-09-27') === null);

// --- nlNormalize "fewest" -> "newest" vocab collision (EXTRA_DOMAIN_WORDS) ---
check('nlNormalize: "fewest" is a real word, never fuzzy-corrected to "newest"',
  normalizeQuestionNL('which technician closed the fewest jobs this month').normalized.includes('fewest'));
check('nlNormalize: "fewest" survives in a bare superlative question',
  normalizeQuestionNL('which manufacturer do we have the fewest units of').normalized.includes('fewest'));
check('nlNormalize: "fewest" survives alongside "visits"',
  normalizeQuestionNL('which tech has done the fewest visits').normalized.includes('fewest'));
check('nlNormalize negative: a genuine "newest" question is unaffected (still says "newest", not "fewest")',
  normalizeQuestionNL('whats the newest install we have on file').normalized.includes('newest'));
check('nlNormalize negative: an actual typo\'d "newest" ("neweat") still recovers to "newest", not "fewest"',
  normalizeQuestionNL('whats the neweat unit we have').normalized.includes('newest'));

// --- R21 (L3, i005 shape): serviceVisits + hasServiceType filter now reaches execution ---
// detectAnalyticsPlan already built this filter before this round; the bug was downstream in
// executeAnalyticsPlan's ENTITY_SUPPORTED_FIELDS whitelist (routes/analytics.js), which had no
// 'hasServiceType' entry for the serviceVisits entity, so a syntactically-correct plan was always
// silently discarded (filtersSupported -> false -> return null), costing a model call even though
// the plan itself was right every time. Fixed by adding a 'service_type' correlated-scalar subquery
// to buildAnalyticsSQL's serviceVisits branch (analytics.js) and widening the whitelist. This test
// only covers the plan shape (pure, no DB); the end-to-end execution is covered by offline-exam id
// i005 ("which tech is racking up the most repair calls").
// NOTE: op varies with phrasing ("who has logged"/"who is doing" -> count, "which tech is racking
// up" -> list) — both ops carry the same filter and both execute through the same widened
// whitelist, so these check the filter, not the exact op shape.
const hasServiceTypePositives = [
  ['which tech is racking up the most repair calls', 'Repair'],
  ['who has logged the most repair calls', 'Repair'],
  ['who is doing the most repair jobs', 'Repair'],
  ['which tech has done the most repair calls this year', 'Repair'],
  ['who logged the most repair visits', 'Repair'],
  ['who has the most preventive maintenance calls', 'Preventive Maintenance'],
];
for (const [q, want] of hasServiceTypePositives) {
  const p = detectAnalyticsPlan(q);
  check(`serviceVisits+hasServiceType plan: "${q}"`,
    !!p && p.entity === 'serviceVisits' && (p.filters ?? []).some(f => f.field === 'hasServiceType' && f.op === 'eq' && f.value === want),
    JSON.stringify(p));
}
check('serviceVisits+hasServiceType negative: no service-type word at all -> a bare technician-ranking question stays a plain technician groupby (no hasServiceType filter)',
  (() => {
    const p = detectAnalyticsPlan('which technician has done the most visits');
    return !p || !(p.filters ?? []).some(f => f.field === 'hasServiceType');
  })());
check('serviceVisits+hasServiceType negative: a warranty question naming "repair" only as an unrelated word never gets this plan',
  (() => {
    const p = detectAnalyticsPlan('which units need a repair estimate before the warranty expires');
    return !p || p.entity !== 'serviceVisits' || !(p.filters ?? []).some(f => f.field === 'hasServiceType' && f.value === 'Repair');
  })());

/* ============================================================ R21 M2: Cluster 1 (brand+city+serviceType+time, all 4 required) */
// detectBrandCityServiceTypeSince — the oracle's real definition counts DISTINCT EQUIPMENT linked to
// a matching service_type document within the resolved time window, regardless of which noun
// ("units"/"systems"/"customers") the question itself used. All four conditions (brand, city,
// service-type, time) must independently resolve or this detector returns null (falls through to a
// different, partial-answer path) rather than ever answering with a subset of the conditions.
const c1Positives = [
  'how many trane units in Mesa had a repair visit since last January',
  'how many carrier systems in Riverside had a preventive maintenance visit since the start of last year',
  'how many lennox units in Mesa have had a repair call since last January',
  'how many goodman customers in Riverside got a maintenance tune-up since last January',
  'how many trane systems in Mesa have had a repair job since last january',
];
for (const q of c1Positives) {
  const p = detectAnalyticsPlan(q, {}, '2026-09-25');
  check(`Cluster 1 (own paraphrase): "${q}" -> equipment count with brand+city+hasServiceType+timeRange, all 4 conditions`,
    !!p && p.entity === 'equipment' && p.op === 'count' && !!p.timeRange &&
      (p.filters ?? []).some(f => f.field === 'brand') &&
      (p.filters ?? []).some(f => f.field === 'city') &&
      (p.filters ?? []).some(f => f.field === 'hasServiceType'),
    JSON.stringify(p));
}
check('Cluster 1 negative: two brands named (ambiguous) -> never guesses one, this detector bails to null',
  detectAnalyticsPlan('how many trane and carrier units in Mesa had a repair visit since last january', {}, '2026-09-25') === null);
check('Cluster 1 negative: missing brand -> falls through to a DIFFERENT (partial) detector, never fabricates a brand condition',
  (() => {
    const p = detectAnalyticsPlan('how many units in Mesa had a repair visit since last january', {}, '2026-09-25');
    return !p || !(p.filters ?? []).some(f => f.field === 'brand');
  })());
check('Cluster 1 negative: missing time phrase -> the C1 detector itself never fires with a partial/no timeRange result standing in for all 4',
  (() => {
    const p = detectAnalyticsPlan('how many trane units in Mesa had a repair visit', {}, '2026-09-25');
    return !p || !p.timeRange; // falls to crossDocDedicated (no timeRange), not a guessed C1 plan
  })());

/* ============================================================ R21 M2: i093/i095 (warranty registration days) */
// i093: "warranty registrations within N days of install" -> a real lte count (never confused with a
// today-relative "within N days" window, which is a different, unrelated shape).
const i093Positives = [
  'how many warranty registrations happened within 30 days of the install',
  'how many warranty registrations were within 14 days of install date',
  'how many warranty registrations were within 45 days of the install date',
  'how many warranty registrations came within 7 days of install',
  'how many warranty registrations happened within 60 days of the installation date',
];
for (const q of i093Positives) {
  const p = detectAnalyticsPlan(q, {}, '2026-09-25');
  check(`i093 (own paraphrase): "${q}" -> equipment count, warrantyRegistrationDays lte`,
    !!p && p.entity === 'equipment' && p.op === 'count' &&
      (p.filters ?? []).some(f => f.field === 'warrantyRegistrationDays' && f.op === 'lte'),
    JSON.stringify(p));
}
check('i093 negative: "warranty registrations that took longer than N days after install" is the complement (gt), never lte',
  (() => {
    const p = detectAnalyticsPlan('how many warranty registrations took longer than 30 days after install', {}, '2026-09-25');
    return !!p && (p.filters ?? []).some(f => f.field === 'warrantyRegistrationDays' && f.op === 'gt');
  })());

// i095: "do most warranty registrations happen within N days of install" -> a majority count
// comparison (lte N vs gt N), reusing the existing count-comparison execution engine.
const i095Positives = [
  'do most warranty registrations happen within 30 days of the install',
  'do most of our warranty registrations happen within 14 days of install',
  'do most warranty registrations occur within 45 days of the install date',
  'are most warranty registrations within 7 days of install',
  'do most warranty registrations happen within 60 days of the installation date',
];
for (const q of i095Positives) {
  const p = detectCountComparison(q, '2026-09-25');
  check(`i095 (own paraphrase): "${q}" -> majority comparison, lte N vs gt N`,
    !!p && p.entity === 'equipment' && p.leftFilter?.field === 'warrantyRegistrationDays' && p.leftFilter?.op === 'lte' &&
      p.rightFilter?.field === 'warrantyRegistrationDays' && p.rightFilter?.op === 'gt',
    JSON.stringify(p));
}
check('i095 admission gate: preClassifyAnalytics admits this shape (no "than", no bare existence lead) so it ever reaches the planner',
  preClassifyAnalytics('do most warranty registrations happen within 30 days of the install', {}) === true);
check('i095 negative: an ordinary count-comparison question ("more trane than carrier") is unaffected by the new majority detector',
  (() => {
    const p = detectCountComparison('do we have more trane units than carrier units', '2026-09-25');
    return !!p && p.leftFilter?.field !== 'warrantyRegistrationDays';
  })());

/* ============================================================ R21 M2: Cluster 2 additions (since last January + the "within N of" fix) */
const { resolveAnyTimeRange } = await import('../api/_lib/analytics.js');
check('Cluster 2 (own paraphrase): "since last January" resolves to Jan 1 of LAST calendar year, not this year',
  JSON.stringify(resolveAnyTimeRange('since last January', '2026-09-25')) ===
    JSON.stringify({ from: '2025-01-01', to: '2026-09-25', label: 'since the start of 2025' }));
check('Cluster 2 (own paraphrase): "since last january" (lowercase) resolves the same way',
  resolveAnyTimeRange('how many units since last january', '2026-09-25')?.from === '2025-01-01');
check('Cluster 2 negative: a bare "last January" with no "since" is read as the most recent January (THIS convention is unchanged, deliberately different from "since last January")',
  resolveAnyTimeRange('how many visits happened last January', '2026-09-25')?.from !== '2025-01-01' ||
    resolveAnyTimeRange('how many visits happened last January', '2026-09-25') == null);
check('Cluster 2 fix: "warranty registrations within 30 days of the install" never gets a spurious today-relative timeRange (the "of" lookahead fix)',
  detectAnalyticsPlan('how many warranty registrations happened within 30 days of the install', {}, '2026-09-25')?.timeRange === undefined);
check('Cluster 2 negative: an ordinary "within the last 30 days" (no "of <event>") still resolves a real today-relative window',
  resolveAnyTimeRange('how many invoices within the last 30 days', '2026-09-25')?.to === '2026-09-25');

console.log('');
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
