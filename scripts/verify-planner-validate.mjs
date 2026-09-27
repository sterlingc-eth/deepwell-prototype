/**
 * ROUND 20 (J4, credit-return readiness), task 1: checks for
 * api/_lib/planner/validate.js — the guard that sits between "the model
 * returned an analytics plan" and "the executor trusts it".
 *
 * Pure only — no database, no network, no Anthropic call (the SDK is never
 * imported here). Every plan below is hand-built exactly the shape a model's
 * tool_use `input` would have (BEFORE analytics.js's own validatePlan runs on
 * it) — this file never calls the real planner.
 *
 *   node scripts/verify-planner-validate.mjs
 */
import {
  detectConstraints, findMissingConstraints, findInventedFilters, findUnknownEntityIds, validateModelPlan,
} from '../api/_lib/planner/validate.js';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ============================================================ 1. detectConstraints adapter */

check(
  'detectConstraints: a plain brand question detects "brand"',
  detectConstraints('how many trane units do we have').has('brand')
);
check(
  'detectConstraints: a question with no recognized condition detects nothing',
  detectConstraints('how many customers do we have').size === 0
);

/* ============================================================ 2. missing-condition rejection
 * (a thin pass-through to analytics.js's own missingConditions — the point of this block is
 * proving the WIRING, not re-testing that function's own logic, which verify-det-planner.mjs and
 * verify-analytics.mjs already cover in depth.) */

{
  const question = 'how many customers in Mesa have an email on file';
  const planDroppedEmail = { entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Mesa' }] };
  check('missing: detects the dropped hasEmail condition', findMissingConstraints(planDroppedEmail, question).has('email'));
  const result = validateModelPlan(planDroppedEmail, question);
  check('missing: validateModelPlan rejects a plan missing a stated condition', result.ok === false && result.reason.startsWith('missing-condition:'));
}
{
  const question = 'how many trane units do we have';
  const goodPlan = { entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] };
  const result = validateModelPlan(goodPlan, question);
  check('missing: a plan that keeps every stated condition passes', result.ok === true, JSON.stringify(result));
}

/* ============================================================ 3. invented-filter rejection —
 * the genuinely NEW check this file adds: a plan can satisfy the closed field/op vocabulary while
 * still naming a VALUE the question never said. */

{
  // The question names Trane; the model's plan names Carrier instead — same schema-valid shape,
  // completely different (and silently wrong) answer.
  const question = 'how many trane units do we have';
  const wrongBrandPlan = { entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Carrier' }] };
  const invented = findInventedFilters(wrongBrandPlan, question);
  eq('invented: a brand the question never named is flagged', invented, [{ field: 'brand', value: 'Carrier' }]);
  const result = validateModelPlan(wrongBrandPlan, question);
  check('invented: validateModelPlan rejects the wrong-brand plan', result.ok === false && result.reason.startsWith('invented-filter:'));
}
{
  const question = 'how many customers do we have in Gilbert';
  const wrongCityPlan = { entity: 'customers', op: 'count', filters: [{ field: 'city', op: 'eq', value: 'Chandler' }] };
  check('invented: a city the question never named is flagged', findInventedFilters(wrongCityPlan, question).length === 1);
}
{
  // State is stored as a 2-letter code; the question spells the state out in full. A bare substring
  // check on "az" against "arizona" would falsely flag this as invented — the guard must special-case it.
  const question = 'how many customers in Arizona do we have';
  const plan = { entity: 'customers', op: 'count', filters: [{ field: 'state', op: 'eq', value: 'AZ' }] };
  check('invented: a state code is recognized against the full state name in the question', findInventedFilters(plan, question).length === 0);
  const badPlan = { entity: 'customers', op: 'count', filters: [{ field: 'state', op: 'eq', value: 'NV' }] };
  check('invented: the OTHER state code is still flagged when the question names neither', findInventedFilters(badPlan, question).length === 1);
}
{
  // documentType's filter value is a database id ("invoice"); the question uses the plain-English
  // plural ("invoices") — the synonym table, not a literal id match, decides this.
  const question = 'how many invoices do we have on file';
  const plan = { entity: 'customers', op: 'count', filters: [{ field: 'hasDocType', op: 'eq', value: 'invoice' }] };
  // hasDocType/lacksDocType are boolean-shaped presence filters, not the free-text documentType
  // field — never checked by the invented-filter guard (their value space is a closed id, already
  // fully enforced by analytics.js's own validatePlan). Confirms this guard does not misfire on them.
  check('invented: hasDocType is not a free-text field this guard second-guesses', findInventedFilters(plan, question).length === 0);
  const groupPlan = { entity: 'documents', op: 'groupBy', groupBy: 'documentType', filters: [{ field: 'documentType', op: 'eq', value: 'invoice' }] };
  check('invented: a documentType value is recognized via its synonym words, not the raw id', findInventedFilters(groupPlan, question).length === 0);
  const wrongTypePlan = { entity: 'documents', op: 'groupBy', groupBy: 'documentType', filters: [{ field: 'documentType', op: 'eq', value: 'permit' }] };
  check('invented: a documentType value with no matching synonym in the question is flagged', findInventedFilters(wrongTypePlan, question).length === 1);
}
{
  // Numeric/derived fields (installYear) are excluded from this guard on purpose — they are usually
  // computed from a relative phrase ("older than 10 years"), never typed verbatim.
  const question = 'how many units were installed before 2015';
  const plan = { entity: 'equipment', op: 'count', filters: [{ field: 'installYear', op: 'lt', value: 2015 }] };
  check('invented: a derived numeric field (installYear) is never flagged', findInventedFilters(plan, question).length === 0);
}
{
  // A boolean/enum field's own value is fully closed by analytics.js's validatePlan already (true/
  // false, or one of WARRANTY_STATUSES) — this guard only checks warrantyStatus for "the question
  // mentions warranty at all", never the specific bucket.
  const question = 'how many units have an email on file';
  const plan = { entity: 'customers', op: 'count', filters: [{ field: 'hasEmail', op: 'eq', value: true }] };
  check('invented: hasEmail (boolean) is never second-guessed by value', findInventedFilters(plan, question).length === 0);
  const warrantyPlan = { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyStatus', op: 'eq', value: 'expired' }] };
  check('invented: warrantyStatus flagged when the question never mentions warranty at all', findInventedFilters(warrantyPlan, 'how many units do we have').length === 1);
  check('invented: warrantyStatus NOT flagged once the question mentions warranty, any bucket', findInventedFilters(warrantyPlan, 'how many units are out of warranty').length === 0);
}

/* ============================================================ 4. entity-id guard (forward-looking) */

{
  const plan = { entity: 'customers', op: 'list', filters: [{ field: 'entityId', op: 'eq', value: 'not-in-tenant' }] };
  eq('entity-id: no knownEntityIds supplied -> never rejects (fails open)', findUnknownEntityIds(plan, {}), []);
  const known = new Set(['abc-123']);
  eq('entity-id: a value outside the known set is flagged once supplied', findUnknownEntityIds(plan, { knownEntityIds: known }), [{ field: 'entityId', value: 'not-in-tenant' }]);
  const okPlan = { entity: 'customers', op: 'list', filters: [{ field: 'entityId', op: 'eq', value: 'abc-123' }] };
  eq('entity-id: a value inside the known set passes', findUnknownEntityIds(okPlan, { knownEntityIds: known }), []);
}

/* ============================================================ 5. validateModelPlan: bad input never throws */

{
  let threw = false;
  let result;
  try { result = validateModelPlan(null, 'anything'); } catch { threw = true; }
  check('validateModelPlan: null plan never throws, rejects instead', !threw && result.ok === false);
  try { result = validateModelPlan('not an object', 'anything'); } catch { threw = true; }
  check('validateModelPlan: a non-object plan never throws, rejects instead', !threw && result.ok === false);
  try { result = validateModelPlan({ entity: 'customers', op: 'count' }, ''); } catch { threw = true; }
  check('validateModelPlan: an empty question never throws', !threw);
}

/* ============================================================ 6. ROUND 20 (J4/J1 wiring): the SAME
 * constraint parser the precision guard uses (guard/constraints.js's extractConstraints) now backs
 * detectConstraints/findMissingConstraints too — 'distinct'/'superlative' are schema-verified
 * impossible for a raw model plan to ever satisfy, so any question naming them rejects the model plan
 * unconditionally; 'comparator'/'negation' ARE model-expressible, so only reject when the plan truly has
 * no matching filter. */

check(
  'detectConstraints: now also recognizes the extra guard/constraints.js types (comparator)',
  detectConstraints('how many units are more than 10 years old').has('comparator')
);
{
  // distinct: "how many unique brands do we have" — ANALYTICS_TOOL has no countDistinct
  // property a model tool_use call could ever set, so ANY plan here is rejected.
  const question = 'how many unique brands do we have';
  const plan = { entity: 'equipment', op: 'groupBy', groupBy: 'brand', filters: [] };
  check('extra-missing: a distinct-count question rejects a model plan unconditionally', findMissingConstraints(plan, question).has('distinct'));
  const result = validateModelPlan(plan, question);
  check('extra-missing: validateModelPlan rejects the distinct-count model plan', result.ok === false && result.reason.startsWith('missing-condition:'));
}
{
  // superlative: "the earliest warranty registration date" — SORT_FIELDS (the model's own sortBy enum)
  // has no warrantyRegDateAsc/Desc value, so this too is unconditional.
  const question = 'what is the earliest warranty registration date we have on file';
  const plan = { entity: 'equipment', op: 'list', filters: [] };
  check('extra-missing: a date-superlative question rejects a model plan unconditionally', findMissingConstraints(plan, question).has('superlative'));
}
{
  // comparator: model-expressible (ANALYTICS_TOOL tells the model to use installYear op gt/lt) — only
  // missing when the plan truly drops the numeric filter.
  const question = 'how many units are more than 10 years old';
  const droppedPlan = { entity: 'equipment', op: 'count', filters: [] };
  check('extra-missing: comparator flagged when the plan has no gt/lt/gte/lte filter at all', findMissingConstraints(droppedPlan, question).has('comparator'));
  const keptPlan = { entity: 'equipment', op: 'count', filters: [{ field: 'installYear', op: 'lt', value: 2016 }] };
  check('extra-missing: comparator NOT flagged once the plan has a real numeric filter', !findMissingConstraints(keptPlan, question).has('comparator'));
  const result = validateModelPlan(keptPlan, question);
  check('extra-missing: validateModelPlan accepts the comparator-satisfying plan', result.ok === true, JSON.stringify(result));
}
{
  // negation: model-expressible (lacksDocType / a has* field set false) — only missing when the plan
  // has no such filter.
  const question = 'do we have zero invoices on file';
  const droppedPlan = { entity: 'customers', op: 'count', filters: [] };
  check('extra-missing: negation flagged when the plan has no lacks*/has*=false filter', findMissingConstraints(droppedPlan, question).has('negation'));
  const keptPlan = { entity: 'customers', op: 'count', filters: [{ field: 'lacksDocType', op: 'eq', value: 'invoice' }] };
  check('extra-missing: negation NOT flagged once the plan has a real lacks* filter', !findMissingConstraints(keptPlan, question).has('negation'));
}
{
  // Every existing missing-condition/invented-filter behavior is untouched by this wiring — a plain
  // brand question with no extra-constraint phrasing keeps passing exactly as before.
  const question = 'how many trane units do we have';
  const goodPlan = { entity: 'equipment', op: 'count', filters: [{ field: 'brand', op: 'eq', value: 'Trane' }] };
  const result = validateModelPlan(goodPlan, question);
  check('extra-missing: an ordinary plan with none of the extra constraint shapes is unaffected', result.ok === true, JSON.stringify(result));
}

console.log('');
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
