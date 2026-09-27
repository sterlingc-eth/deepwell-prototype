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
import {
  resolveAgeFilter, warrantyStatusFromQuestion, buildConditionOverrideFilter,
  preClassifyAnalytics, resolveServiceVisitsOverride, looksLikeSingleRecordReference,
} from '../api/_lib/analytics.js';
import { isFinancialQuestion } from '../api/_lib/financials/classify.js';

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
  'time-window (own paraphrase): "how many units have their warranty expiring since january 1st" resolves a real gte/lte warrantyExpires window, not the unfiltered portfolio',
  detectAnalyticsPlan('how many units have their warranty expiring since january 1st'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyExpires', op: 'gte', value: '2026-01-01' }, { field: 'warrantyExpires', op: 'lte', value: '2026-09-27' }] }
);
eq(
  'time-window (own paraphrase): "how many units warranty expires this spring" resolves the season to a month range',
  detectAnalyticsPlan('how many units warranty expires this spring'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyExpires', op: 'gte', value: '2026-03-01' }, { field: 'warrantyExpires', op: 'lte', value: '2026-05-31' }] }
);
eq(
  'time-window (own paraphrase): "how many units warranty expires by end of year" resolves today..year-end',
  detectAnalyticsPlan('how many units warranty expires by end of year'),
  { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyExpires', op: 'gte', value: '2026-09-27' }, { field: 'warrantyExpires', op: 'lte', value: '2026-12-31' }] }
);
eq(
  'time-window (own paraphrase): "how many units warranty expires in the next 90 days" resolves today..+90d',
  detectAnalyticsPlan('how many units warranty expires in the next 90 days'),
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

console.log('');
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
