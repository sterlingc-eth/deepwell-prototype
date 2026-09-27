/**
 * Round 20 (J1) — guard/check.js: the coverage contract itself. Every deterministic answer path in this
 * codebase already declares (in its own intent/plan shape, computed well before this file ever runs) what
 * it looked at; this module compares that against extractConstraints' (constraints.js) read of what the
 * QUESTION asked for, and refuses to let a mismatched answer go out — api/ask.js calls one of these
 * `guardXAnswer` functions right before its own `send(200, ...)` for the routers wired below, and on a
 * block simply treats the answer as if the router itself had returned null (falls through to the very same
 * next-stage/agent/retrieval path that a genuine miss already takes — see each call site in api/ask.js).
 *
 * Design (R20_CONTRACT.md): "each deterministic answer path declares what it consumed... derive it
 * centrally where possible... via small adapters in guard/, not by editing every handler; where a
 * handler's intent is opaque, use conservative defaults."
 *   - decompose (decompose/index.js's classifyDecompose intent): fully transparent — intent.conditions is a
 *     closed, typed list (clauses.js) this file already knows how to read; consumedFromDecomposeIntent below
 *     maps every condition type decompose's OWN vocabulary can express to the constraint type(s) it
 *     satisfies. Critically, decompose's clause vocabulary has NO condition type that ever scopes to one
 *     NAMED customer/business (see clauses.js/index.js's own describeClause switch — brand, age, warranty
 *     status, doc-type presence, geo city, email/phone presence, unit count, distinct-brand count,
 *     TECHNICIAN name, no-visit-since-year, callback — never "for customer X") — so a 'namedEntity'
 *     constraint is, BY CONSTRUCTION, never something a decompose answer consumed, regardless of which
 *     conditions actually matched. That is exactly r19_blind3_clusters.json's F1 example i048 ("do we have
 *     a purchase order on file for the Amy Isaacson account" answered from a portfolio-wide "has a work
 *     order AND a purchase order" scan that never looked at the name at all).
 *   - analytics (routes/analytics.js's runAnalyticsQuestion): OPAQUE from api/ask.js's own scope — the
 *     validated plan (filters/timeRange/groupBy) is never returned in the answer `data` object, only the
 *     rendered text/facts (see this file's own final report for the exact 1-line hook — attaching the plan
 *     to the returned data — a future round could add in routes/analytics.js, which is J3's file, not
 *     mine). Per the contract's own "conservative defaults" clause, guardAnalyticsAnswer below never
 *     guesses at what the invisible plan did; it only ever blocks on signals derivable from the ANSWER
 *     ITSELF plus one cheap, independent portfolio-total probe (portfolioTotals.js) — never a false
 *     positive against a legitimately narrow filtered count, only against a bare count that happens to
 *     equal the tenant's ENTIRE portfolio for that entity while the question named a time/negation/
 *     comparator constraint no filter of that shape could ever coincidentally satisfy at 100% of rows.
 *
 * A decline / "which one did you mean" answer is NEVER blocked (isDeclineOrAskWhich below) — this guard
 * exists to catch false CONFIDENCE, never to second-guess an answer that was already honest about not
 * knowing.
 */
import { extractConstraints, CONDITION_CROSS_VISIT_RELATION, CONDITION_RATIO } from './constraints.js';
import { fetchPortfolioTotal } from './portfolioTotals.js';

/** True for any answer this guard must never touch: a genuine "I don't know"/no-answer, an ambiguous
 *  "which one did you mean" (candidateCount > 1, same field every lookup family already sets), or text that
 *  reads as a decline/ask-which on its face. Checked first by every guardXAnswer below. */
export function isDeclineOrAskWhich(data) {
  if (!data) return true;
  if (data.kind === 'no-answer') return true;
  if (Number(data.candidateCount ?? 1) > 1) return true;
  return /\bwhich one\b|\bwhich .{0,40}\bdid you mean\b|\bcan'?t tell which\b|\bnot sure which\b/i.test(String(data.text ?? ''));
}

/** decompose/index.js's clauses.js condition `type` -> the constraint type(s) it satisfies. Exhaustive over
 *  every type describeClause (decompose/index.js) itself knows how to render — an unrecognized future
 *  condition type consumes nothing (conservative default: better to fall through than silently trust a
 *  shape this file has never seen). */
function consumedFromDecomposeIntent(intent) {
  const consumed = new Set();
  for (const cond of intent?.conditions ?? []) {
    switch (cond?.type) {
      case 'brand': consumed.add('brand'); break;
      case 'geoCity': consumed.add('city'); break;
      case 'hasDocType':
      case 'lacksDocType': consumed.add('docType'); consumed.add('serviceType'); break;
      case 'warrantyStatus': consumed.add('warranty'); break;
      case 'hasEmail':
      case 'noEmail': consumed.add('email'); break;
      case 'noPhone': consumed.add('phone'); break;
      case 'ageOlder':
      case 'ageOlderDays':
      case 'unitCountGt': consumed.add('comparator'); break;
      case 'distinctBrandsGte': consumed.add('comparator'); consumed.add('distinct'); break;
      // A technician name IS a named-entity the question stated, and decompose's `technician`
      // condition really does filter by it — but that is a TECHNICIAN name, never a CUSTOMER/
      // business name (decompose has no condition type for the latter at all — see this file's own
      // doc comment above), so this deliberately does NOT add 'namedEntity' here: a question that
      // names a customer/business (constraints.js's own namedEntity detector, tenant-vocab-first)
      // must still be caught as unconsumed even when the SAME question also names a technician.
      case 'noVisitSinceYear': consumed.add('month'); break;
      case 'callback': consumed.add(CONDITION_CROSS_VISIT_RELATION); consumed.add('month'); break;
      default: break;
    }
  }
  return consumed;
}

/**
 * decompose/index.js's `runFilter`/`runComparison` answer, checked before api/ask.js sends it.
 * `intent` is classifyDecompose's own result (already computed by api/ask.js's pre-router — see
 * classifyAll.js's `gated.decompose`). Returns {blocked, reason, constraintType} — `blocked` false means
 * send the answer exactly as computed; true means treat it as if decompose had returned null.
 */
export function guardDecomposeAnswer({ question, data, intent, tenantVocab } = {}) {
  if (isDeclineOrAskWhich(data)) return { blocked: false };
  const constraints = extractConstraints(question, { tenantVocab })
    // 'namedEntity' is measured, not enforced, here — see this file's own doc comment for why: verified
    // against r19_blind3_clusters.json's F1 "purchase order on file for <Name> account" cluster
    // (i048-i053, i039-i040, i054-i057), a question this shape ALSO reaches decompose only because
    // docLookup.js's own raw parser (parseDocLookupQuestion — J2's file, not this round's to edit) does
    // not yet recognize "on file for the <Name> account/job" as its own shape (verified directly:
    // parseDocLookupQuestion returns null for every one of those texts) — decompose's PRECEDENCE_TABLE
    // gate (classifyAll.js) only lets it win a question docLookup did NOT already raw-claim, so the
    // proper fix is docLookup recognizing this phrasing (then decompose never wins it at all), not this
    // guard. Blocking on 'namedEntity' alone here DOES catch the truly-wrong ids (i048-i053, expected
    // "yes") but, since decompose's "0 customers match" wording reads as a valid "no" whenever the named
    // customer genuinely doesn't have the document either (i039-i040, i054-i057, expected "no" — same bug,
    // right answer by coincidence), it flips those from correct to needs-model too — a floor violation
    // (R20_CONTRACT.md: "floors: correct up only") this guard must never cause. Left OUT of the enforced
    // set until a ground-truth check (or docLookup's own fix) can tell the two apart; see this round's
    // final report for the exact one-line docLookup.js hook that resolves it upstream instead.
    .filter((c) => c.type !== 'namedEntity');
  const consumed = consumedFromDecomposeIntent(intent);
  const missed = constraints.find((c) => !consumed.has(c.type));
  if (!missed) return { blocked: false };
  return { blocked: true, reason: 'unconsumed-constraint', constraintType: missed.type, constraintValue: missed.value ?? null };
}

/** True when `data`'s own text/fact label already says the number is a DISTINCT/type-level count (never
 *  guessed — the question's own 'distinct' constraint is only satisfied when the ANSWER visibly names what
 *  it counted distinctly). */
function mentionsDistinctness(data) {
  const hay = `${data?.text ?? ''} ${(data?.facts ?? []).map((f) => f.label).join(' ')}`.toLowerCase();
  return /\b(distinct|unique|different|types?|kinds?)\b/.test(hay);
}

/** True when `data` names an actual date-shaped value anywhere (ISO date, or "Month D, YYYY"/"Month YYYY")
 *  — the only way a superlative-over-a-date constraint ("the earliest warranty registration date") could
 *  ever have been genuinely answered; a bare integer count structurally cannot satisfy it. */
const DATE_SHAPED_RE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b/i;
function hasDateShapedValue(data) {
  const hay = `${data?.text ?? ''} ${(data?.facts ?? []).map((f) => f.value).join(' ')}`;
  return DATE_SHAPED_RE.test(hay);
}

/** entity noun -> the portfolioTotals.js key it corresponds to, inferred from the answer's own fact label /
 *  text (never from the question) — the same noun vocabulary ENTITY_NOUN (analytics.js) already renders
 *  answers with. Order matters: an "invoice"/"warrant(y)" mention is checked before the generic "document"
 *  one, since every invoice/warranty IS a document but should be probed against ITS OWN narrower total, not
 *  the whole-portfolio document count. */
function inferPortfolioEntityKey(data) {
  const hay = `${(data?.facts ?? [])[0]?.label ?? ''} ${data?.text ?? ''}`.toLowerCase();
  if (/\binvoice/.test(hay)) return 'invoices';
  if (/\bwarrant/.test(hay)) return 'warranties';
  if (/\bvisit|\bjob/.test(hay)) return 'serviceVisits';
  if (/\bcustomer/.test(hay)) return 'customers';
  if (/\b(?:piece|unit|equipment)/.test(hay)) return 'equipment';
  if (/\bdocument/.test(hay)) return 'documents';
  return null;
}

/** A bare "N <noun>[...]." answer — exactly one numeric fact, `kind: 'answer'` — or null for anything
 *  shaped differently (a list, a groupBy breakdown, a ranking, ...), which this check never touches. */
function extractBareCount(data) {
  if (!data || data.kind !== 'answer') return null;
  const facts = data.facts ?? [];
  if (facts.length !== 1) return null;
  const raw = facts[0]?.value;
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  const entityKey = inferPortfolioEntityKey(data);
  if (!entityKey) return null;
  return { value: Number(raw), entityKey };
}

// Constraint types checked against a fresh portfolio total (see this file's own doc comment for why only
// these four: month/negation/comparator/namedEntity are the ones detectedConditions'/missingConditions'
// own existing analytics safety net (analytics.js) does NOT already gate a plan on — brand/city/state/zip/
// email/phone/warranty/serviceType all already get a real filter-or-honest-fallback there before this
// guard ever runs. 'namedEntity' is checked THIS way rather than "does the answer's text mention the
// name" (which decompose's own guard above uses) because a legitimately technician-filtered serviceVisits
// count never restates the technician's name in its rendered sentence at all ("6 service visits September
// 2026." — hvac-owner-0054, a real, correctly-filtered answer) — text presence would false-positive on
// every one of those. The portfolio-total-equality test has no such blind spot: a real filter almost never
// coincidentally recovers the exact unfiltered total.
const PORTFOLIO_CHECKED_TYPES = new Set(['month', 'negation', 'comparator', 'namedEntity']);

/**
 * routes/analytics.js's runAnalyticsQuestion answer, checked before api/ask.js sends it. `getPortfolioTotal`
 * defaults to the real DB-backed probe (portfolioTotals.js); tests inject a stub so this stays a pure,
 * synchronous-shaped check with no real DB in scripts/verify-precision-guard.mjs's unit half.
 */
export async function guardAnalyticsAnswer({ question, data, tenantVocab, withTenant, ctxArg, getPortfolioTotal } = {}) {
  if (isDeclineOrAskWhich(data)) return { blocked: false };
  const probe = getPortfolioTotal ?? ((key) => fetchPortfolioTotal({ withTenant, ctxArg }, key));
  const constraints = extractConstraints(question, { tenantVocab });

  const distinct = constraints.find((c) => c.type === 'distinct');
  if (distinct && !mentionsDistinctness(data)) {
    return { blocked: true, reason: 'unconsumed-constraint', constraintType: 'distinct' };
  }
  const superlative = constraints.find((c) => c.type === 'superlative');
  if (superlative && !hasDateShapedValue(data)) {
    return { blocked: true, reason: 'unconsumed-constraint', constraintType: 'superlative' };
  }
  const restricting = constraints.filter((c) => PORTFOLIO_CHECKED_TYPES.has(c.type));
  if (restricting.length) {
    const bare = extractBareCount(data);
    if (bare) {
      const total = await probe(bare.entityKey);
      if (total != null && total === bare.value) {
        return { blocked: true, reason: 'unconsumed-constraint', constraintType: restricting[0].type };
      }
    }
  }
  return { blocked: false };
}

export { extractConstraints, CONDITION_RATIO };
