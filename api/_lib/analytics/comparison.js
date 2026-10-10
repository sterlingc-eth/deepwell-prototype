/**
 * R19 (I2, task 2): deterministic yes/no COUNT comparisons — "do we have more Trane than Carrier
 * units", "does Tempe have more customers than Peoria", "do we have more registered warranties than
 * unregistered ones". Both sides of the comparison are the SAME entity/count definition, just
 * filtered to two different named values of ONE closed-vocabulary dimension (brand, city, or
 * equipment warranty-registration state) — never a comparison whose side needs fuzzy customer-name
 * or address resolution ("has Rebecca Montoya had more documents than Charles Montoya", "was the
 * job at 803 E Pecos bigger than...") — those need the model's own schema-linked customer-name
 * vocabulary (see detPlan.js's own questionNamesKnownCustomer doc comment for why this file never
 * builds a customerName filter) or a financials-domain join outside this round's ownership; bailing
 * (null) there is exactly the "never guess" rule every other detector in this family already follows.
 *
 * detectCountComparison(question) -> {entity, leftFilter, rightFilter, leftLabel, rightLabel} | null
 * — PURE, no db, no model call. routes/analytics.js's runCountComparison executes it (two
 * already-tested filter passes over the same fetched row set, reusing applyEntityFilters/brandMatches
 * — never a second, hand-written SQL comparison) and builds the yes/no answer + citations.
 */
import { buildConditionOverrideFilter, SERVICE_TYPE_PHRASE_RE, serviceTypeValueOf } from '../analytics.js';

// Both sides of a real comparison question always sit either side of the word "than" ("do we have
// more X than Y", "is X bigger than Y", "has X had more ... than Y") — splitting there, then running
// the SAME single-value city/brand extractor (buildConditionOverrideFilter) on each half separately,
// is exactly how detectBrandComparison (detPlan.js) already splits a "Trane vs Carrier" question at
// vs/versus/or; this is the identical technique for "than" instead.
const THAN_RE = /\bthan\b/i;

// Scoped to a real yes/no question shape (do/does/is/are/was/were/has/have/did — the same verb
// family EXISTENCE_QUESTION_RE, analytics.js, already keys existence wording off, plus "did" for a
// simple-past comparison like "did we install more units last year than...") so an unrelated
// declarative sentence that happens to contain the word "than" is never mistaken for a comparison.
const YESNO_LEAD_RE = /^\s*(?:do|does|did|is|are|was|were|has|have)\b/i;

/** "do we have more registered warranties than unregistered ones" / "...more unregistered warranties
 *  than registered ones" — the ONE boolean dimension (equipment.warranty.registrationState) this
 *  comparison engine knows, named by its own two fixed English words rather than a brand/city value
 *  a question could name many different ways. Checked before the generic brand/city split below so
 *  it never has to also survive that split (neither word is a brand or city name). */
const WARRANTY_REG_THAN_UNREG_RE = /\bregistered\b[\s\S]*\bthan\b[\s\S]*\bunregistered\b/i;
const WARRANTY_UNREG_THAN_REG_RE = /\bunregistered\b[\s\S]*\bthan\b[\s\S]*\bregistered\b/i;

function detectWarrantyRegisteredComparison(q) {
  if (WARRANTY_REG_THAN_UNREG_RE.test(q)) {
    return {
      entity: 'equipment',
      leftFilter: { field: 'warrantyRegistered', op: 'eq', value: true },
      rightFilter: { field: 'warrantyRegistered', op: 'eq', value: false },
      leftLabel: 'registered warranties', rightLabel: 'unregistered warranties',
    };
  }
  if (WARRANTY_UNREG_THAN_REG_RE.test(q)) {
    return {
      entity: 'equipment',
      leftFilter: { field: 'warrantyRegistered', op: 'eq', value: false },
      rightFilter: { field: 'warrantyRegistered', op: 'eq', value: true },
      leftLabel: 'unregistered warranties', rightLabel: 'registered warranties',
    };
  }
  return null;
}

/**
 * R21 M2 (deferred list, i095, "do most of our warranty registrations happen within 30 days of the
 * install"): a MAJORITY phrasing — no "than" at all, just "do most (of our) ... X" — but the same
 * "one boolean-ish dimension, split into its two complementary sides" shape
 * detectWarrantyRegisteredComparison just above already answers for registered-vs-unregistered; this
 * is the day-threshold cousin (leftFilter/rightFilter partition every non-null
 * warrantyRegistrationDays value exactly once — lte N vs gt N — so "most" is simply leftCount >
 * rightCount, same yes/no rule runCountComparison already applies to every other comparison here).
 * Checked before the "than"-split below since this phrasing never contains "than".
 */
const WARRANTY_REG_DAYS_MAJORITY_RE =
  /\bmost\b[\s\S]{0,40}\bwarranty\s+registrations?\b[\s\S]{0,25}\bwithin\s+(\d{1,3})\s*days?\s+of\s+(?:the\s+)?install/i;

function detectWarrantyRegDaysMajority(q) {
  const m = WARRANTY_REG_DAYS_MAJORITY_RE.exec(q);
  if (!m) return null;
  const n = Number(m[1]);
  return {
    entity: 'equipment',
    leftFilter: { field: 'warrantyRegistrationDays', op: 'lte', value: n },
    rightFilter: { field: 'warrantyRegistrationDays', op: 'gt', value: n },
    leftLabel: `registrations within ${n} days of install`, rightLabel: `registrations more than ${n} days after install`,
  };
}

/** brand vs brand ("do we have more Mitsubishi units installed than Trane", "is Daikin more common
 *  than Goodman in our records") — equipment counted by manufacturer. */
function detectBrandCountComparison(left, right) {
  const l = buildConditionOverrideFilter('brand', left, 'equipment');
  const r = buildConditionOverrideFilter('brand', right, 'equipment');
  if (l?.op !== 'eq' || r?.op !== 'eq' || l.value === r.value) return null;
  return {
    entity: 'equipment', leftFilter: l, rightFilter: r,
    leftLabel: `${l.value} units`, rightLabel: `${r.value} units`,
  };
}

/** city vs city ("do we have more customers in Mesa than in Tucson", "does Tempe have more
 *  customers than Peoria") — customers counted by service-address city. */
function detectCityCountComparison(left, right) {
  const l = buildConditionOverrideFilter('city', left, 'customers');
  const r = buildConditionOverrideFilter('city', right, 'customers');
  if (l?.op !== 'eq' || r?.op !== 'eq' || l.value === r.value) return null;
  return {
    entity: 'customers', leftFilter: l, rightFilter: r,
    leftLabel: `customers in ${l.value}`, rightLabel: `customers in ${r.value}`,
  };
}

// R20 (J3, i003, F1 "installs this year vs last"): "did we install more units last year than
// we've done so far this year" — both sides name a CALENDAR YEAR via "this year"/"last year"
// rather than a brand or city value, so this is its own small extractor rather than a third call
// to buildConditionOverrideFilter (which has no year vocabulary at all). Requires a genuine install
// mention so an unrelated "more customers this year than last year" (a customers-entity question,
// not equipment) is left to detectCityCountComparison/the generic path instead.
const INSTALL_MENTION_RE = /\binstall(?:ed|s|ation)?\b/i;
const THIS_YEAR_RE = /\b(?:so\s+far\s+)?this\s+year\b/i;
const LAST_YEAR_RE = /\blast\s+year\b/i;

function yearPhraseValue(part, currentYear) {
  if (LAST_YEAR_RE.test(part)) return currentYear - 1;
  if (THIS_YEAR_RE.test(part)) return currentYear;
  return null;
}

function detectInstallYearComparison(left, right, today) {
  if (!INSTALL_MENTION_RE.test(left) && !INSTALL_MENTION_RE.test(right)) return null;
  const now = today ? new Date(today) : new Date();
  if (Number.isNaN(now.getTime())) return null;
  const currentYear = now.getUTCFullYear();
  const leftYear = yearPhraseValue(left, currentYear);
  const rightYear = yearPhraseValue(right, currentYear);
  if (leftYear === null || rightYear === null || leftYear === rightYear) return null;
  const labelOf = (y) => (y === currentYear ? `installs so far in ${y}` : `installs in ${y}`);
  return {
    entity: 'equipment',
    leftFilter: { field: 'installYear', op: 'eq', value: leftYear },
    rightFilter: { field: 'installYear', op: 'eq', value: rightYear },
    leftLabel: labelOf(leftYear), rightLabel: labelOf(rightYear),
  };
}

/** R32: "do we have more repair visits than preventive maintenance visits" — two service TYPES (closed vocabulary,
 *  SERVICE_TYPE_PHRASE_RE) counted over the same serviceVisits entity. Both sides must name a type and differ; the
 *  "fewer/less" direction flips which side must be larger. */
const FEWER_RE = /\b(?:fewer|less|smaller|lower)\b/i;
const MORE_RE = /\b(?:more|greater|larger|higher|bigger|most)\b/i;
function detectServiceTypeComparison(q, left, right) {
  const lm = new RegExp(SERVICE_TYPE_PHRASE_RE.source, 'i').exec(left);
  const rm = new RegExp(SERVICE_TYPE_PHRASE_RE.source, 'i').exec(right);
  if (!lm || !rm) return null;
  const lv = serviceTypeValueOf(lm[1]);
  const rv = serviceTypeValueOf(rm[1]);
  if (!lv || !rv || lv === rv) return null;
  if (FEWER_RE.test(left) === MORE_RE.test(left)) return null;
  const fewer = FEWER_RE.test(left);
  const a = { field: 'hasServiceType', op: 'eq', value: lv };
  const b = { field: 'hasServiceType', op: 'eq', value: rv };
  return {
    entity: 'serviceVisits',
    leftFilter: fewer ? b : a, rightFilter: fewer ? a : b,
    leftLabel: `${fewer ? rv : lv} visits`, rightLabel: `${fewer ? lv : rv} visits`,
    fewerAsked: fewer, askedLeftLabel: `${lv} visits`, askedRightLabel: `${rv} visits`,
  };
}

export function detectCountComparison(question, today) {
  const q = String(question ?? '').trim();
  if (!q || !YESNO_LEAD_RE.test(q)) return null;
  const warrantyReg = detectWarrantyRegisteredComparison(q);
  if (warrantyReg) return warrantyReg;
  const warrantyRegDaysMajority = detectWarrantyRegDaysMajority(q);
  if (warrantyRegDaysMajority) return warrantyRegDaysMajority;
  const idx = q.search(THAN_RE);
  if (idx < 0) return null;
  const left = q.slice(0, idx);
  const right = q.slice(idx + 4);
  return (
    detectBrandCountComparison(left, right) ??
    detectCityCountComparison(left, right) ??
    detectInstallYearComparison(left, right, today) ??
    detectServiceTypeComparison(q, left, right)
  );
}

/**
 * R45: the two sides of an "A vs B" / "compare A and B" / "A versus B" question, as raw text (no dimension decided here). Shared by the
 * aggregation templates (lookups/aggTemplates.js), which resolve each side against the tenant's own brands / cities / technicians and
 * answer from the same count and average primitives. Pure. @returns [leftText, rightText] | null
 */
export function splitVersus(question) {
  const q = String(question ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  let m = /^(.*?)\b(?:versus|vs\.?|against|compared (?:to|with))\b(.*)$/.exec(q);
  if (!m) m = /\b(?:compare|comparison of|difference between)\b\s*(.*?)\s+\band\b\s+(.*)$/.exec(q);
  if (!m) return null;
  const clean = (s) => s.replace(/\b(?:compare|comparison|unit|units|customers?|counts?|totals?|and say.*|which is.*|who has.*|then say.*)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const left = clean(m[1]);
  const right = clean(m[2]);
  return left && right ? [left, right] : null;
}
