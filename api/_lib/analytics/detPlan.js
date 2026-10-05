/**
 * Round 14 (K3): a DETERMINISTIC analytics planner. Builds the exact same
 * "raw plan" shape planAnalyticsQuestion's one Haiku tool-use call produces
 * (an `{entity, op, groupBy?, filters?, sortBy?}` object matching
 * ANALYTICS_TOOL's schema) from regex/vocabulary matching alone — no model
 * call, no I/O, no `db`. planAnalyticsQuestion (routes/analytics.js) tries
 * this FIRST and only calls the model when this returns null; whatever this
 * returns is fed through the EXACT SAME post-processing every model plan
 * already gets (resolveServiceVisitsOverride, reconcileTimeRange,
 * resolveAgeFilter, dateBasis, validatePlan) — so this file never
 * duplicates any of that, and a plan this file gets wrong in some small way
 * is still caught by validatePlan/missingConditions exactly like a wrong
 * model plan would be.
 *
 * THE ONE RULE THAT MATTERS (same as analytics.js's own): never guess. A
 * question whose shape this file doesn't recognize with confidence returns
 * null — the caller falls through to the model (or, offline, to
 * needs-model) exactly like a fast-path miss. Getting a plan WRONG here is
 * far worse than falling back, so every detector below is narrow and
 * shape-based (never keyed to a specific exam question's exact wording —
 * every shape here is a general English construction a dispatcher/owner
 * could type in many paraphrases/typos, all of which normalizeQuestion
 * already funnels to the same normalized words this file matches on).
 *
 * Filter-building deliberately reuses analytics.js's OWN, already-tested
 * condition detectors — detectedConditions/buildConditionOverrideFilter,
 * warrantyStatusFromQuestion — the same functions the "the model's plan
 * silently dropped a condition" override path already trusts to turn a
 * matched word into a real filter (see analytics.js's own doc comments on
 * missingConditions/buildConditionOverrideFilter). This file's own job is
 * the other half those functions don't do: deciding entity/op/groupBy/
 * sortBy from the question's shape and picking out the two filter kinds
 * (documentType, technician) that the missing-condition safety net does not
 * cover (CONDITION_PLAN_FIELD, analytics.js, has no entry for either).
 */
import {
  ENTITY_SYNONYMS,
  GROUP_BY_FIELDS,
  detectedConditions,
  buildConditionOverrideFilter,
  warrantyStatusFromQuestion,
  hasAmbiguousWarrantyStatusNegation,
  isExistenceQuestion,
  resolveAnyTimeRange,
  SERVICE_TYPE_PHRASE_RE,
  serviceTypeValueOf,
} from '../analytics.js';
import { docTypeFromWord, docTypeSynonymAlternation } from '../documentTypes.js';

/* ============================================================ small helpers */

function escapeRe(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function altOf(words) {
  return [...new Set(words)].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
}

function titleCaseWords(s) {
  return String(s ?? '')
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

// Same noun tables preClassifyAnalytics/ANALYTICS_SYSTEM_PROMPT already key
// off (ENTITY_SYNONYMS, analytics.js) — a synonym added there is picked up
// here automatically, never a second hand-copied list.
const CUSTOMER_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.customers)})\\b`, 'i');
const EQUIPMENT_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.equipment)})\\b`, 'i');
const DOCUMENT_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.documents)})\\b`, 'i');
const SERVICE_VISIT_NOUN_RE = new RegExp(`\\b(${altOf(ENTITY_SYNONYMS.serviceVisits)})\\b`, 'i');
const WARRANTY_NOUN_RE = /\bwarrant(?:y|ies)\b/i;
const DOC_TYPE_WORD_RE = new RegExp(`\\b(${docTypeSynonymAlternation()})\\b`, 'i');

const HOW_MANY_RE = /\bhow many\b/i;
const LIST_VERB_RE = /\b(which|list|show me|give me)\b/i;

/** Index of the first match of `re` in `q`, or Infinity when it never matches
 *  — lets entityFromNouns below pick whichever noun the question names
 *  EARLIEST, the same "the head noun is the real subject" heuristic a human
 *  reader uses ("how many CUSTOMERS are running units older than 15 years"
 *  is about customers; "how many DOCUMENTS aren't linked to any customer" is
 *  about documents, even though both sentences also mention the other
 *  noun). */
function firstIndex(re, q) {
  const m = re.exec(q);
  return m ? m.index : Infinity;
}

/**
 * Entity from the question's own nouns — the earliest-matching one wins
 * (see firstIndex's own doc comment). 'warranties' is picked over
 * 'equipment' only when a warrantyStatus condition is present AND no
 * equipment noun matches at all (equipment/warranties are the identical SQL
 * entity — see analytics.js's buildAnalyticsSQL — so this only ever changes
 * the wording, never the count). Defaults to 'customers' when nothing
 * matches at all (same default the ANALYTICS_TOOL schema documents for the
 * model: "If the question names no entity, assume customers").
 */
function entityFromNouns(q) {
  const candidates = [
    { entity: 'customers', idx: firstIndex(CUSTOMER_NOUN_RE, q) },
    { entity: 'documents', idx: firstIndex(DOCUMENT_NOUN_RE, q) },
    { entity: 'equipment', idx: firstIndex(EQUIPMENT_NOUN_RE, q) },
    { entity: 'serviceVisits', idx: firstIndex(SERVICE_VISIT_NOUN_RE, q) },
  ];
  candidates.sort((a, b) => a.idx - b.idx);
  const best = candidates[0];
  if (best.idx === Infinity) {
    if (WARRANTY_NOUN_RE.test(q)) return 'warranties';
    return 'customers';
  }
  return best.entity;
}

/** count vs list — 'which'/'list'/'show me' means individual rows; a bare
 *  "how many" (or no explicit quantifier at all — a bare "mesa customers")
 *  means a single count. Never 'groupBy'/'sum' — those are decided by their
 *  own dedicated detectors below, tried first. */
function opFromShape(q) {
  return LIST_VERB_RE.test(q) && !HOW_MANY_RE.test(q) ? 'list' : 'count';
}

/** Conditions this file hands off to analytics.js's OWN, already-tested
 *  filter builder — every one of these has a CONDITION_PLAN_FIELD entry
 *  (analytics.js), so a condition this misses is independently re-detected
 *  and backfilled (or honestly declined) by missingConditions/
 *  buildConditionOverrideFilter in routes/analytics.js's runAnalyticsQuestion
 *  — never silently dropped. Building them here too (rather than leaving
 *  every one of them to that safety net) matters for one reason:
 *  suspiciousUnfilteredCustomerPlan (analytics.js) falls back to the model
 *  whenever a customers list/count plan has NO filters at all and the
 *  question names a 2+-digit number (a zip, most ages) — so a filter this
 *  function can build must be built here, before that gate ever runs. */
// R18 P4 (C2, multi-hop AND-drop): 'serviceType' added — "how many trane customers needed a
// repair visit" names TWO conditions (brand + a repair-visit condition); buildConditionOverrideFilter
// resolves it via SERVICE_TYPE_PHRASE_RE the same way it resolves brand/city/etc, and a plan
// that can't resolve it (buildConditionOverrideFilter returning null for a genuinely detected
// condition) makes buildSafetyNetFilters' own `unresolved` flag bail the WHOLE plan, same as
// every other safety-net condition.
const SAFETY_NET_CONDITIONS = ['email', 'phone', 'brand', 'county', 'city', 'state', 'zip', 'warranty', 'serviceType'];

/** Returns {filters, unresolved} — `unresolved` is true when a REAL condition was detected in the
 *  question text (detectedConditions) but buildConditionOverrideFilter declined to turn it into a filter
 *  (e.g. a negated brand mention on a customers-entity question — see that function's own doc comment).
 *  That is never the same as "no condition detected" — silently continuing with whatever filters WERE
 *  built would answer a different, unfiltered question with full confidence, exactly the "plan silently
 *  drops a condition" bug this whole file exists to prevent — so detectAnalyticsPlan below must bail
 *  (return null) whenever this comes back true, rather than ever returning a partial plan. */
function buildSafetyNetFilters(question, entity) {
  const found = detectedConditions(question);
  const filters = [];
  let unresolved = false;
  for (const c of SAFETY_NET_CONDITIONS) {
    if (!found.has(c)) continue;
    const f = buildConditionOverrideFilter(c, question, entity);
    if (f) filters.push(f);
    else unresolved = true;
  }
  return { filters, unresolved };
}

/** "How many units have expiring soon?" / "units running out" — the same
 *  warranty-status wording warrantyStatusFromQuestion (analytics.js) already
 *  recognizes, just without the literal word "warrant" anywhere in the
 *  sentence (that function requires it as a guard against misreading an
 *  unrelated "expired"/"active" word elsewhere). Safe to relax only in the
 *  equipment/warranties context this is always called with: "expiring
 *  soon"/"out of warranty"/"still active" said about a UNIT essentially
 *  always means that unit's own warranty status in this domain. */
// Reviewer NO-GO (2026-09-26, round 14): "how many units are not expired" / "which units aren't under
// warranty" name a real warranty-status condition that warrantyStatusFromQuestion correctly refuses to
// guess a bucket for (negation makes it genuinely ambiguous — see that function's own doc comment) —
// but silently building NO filter at all for a question that plainly named one is the exact same
// "silently drops a condition" bug as ever, just via a different path. The sentinel below lets this
// file's own caller bail on the WHOLE plan (never guess which of the other buckets was meant) instead of
// mistaking "negated" for "no warranty condition here at all".
const WARRANTY_STATUS_AMBIGUOUS = Symbol('warrantyStatusAmbiguous');
const REGISTRATION_CONJUNCT_RE = /\b(?:but|and|that\s+are|that\s+is|which\s+are|yet)\s+(?:still\s+)?(?:not\s+|never\s+)?(?:un)?registered\b/i;

// R21 M2 (Cluster 2, j047: "in the last 5 years, how many systems have we put in" — a plain
// install-count question with no warranty mention at all): impliedWarrantyStatus's own "relaxed"
// fallback below blindly appends " warranty" to try bare phrasings like "still active"/"covered"
// that only read as a warranty condition once the word is there — but a question ending in a bare
// trailing preposition ("...have we put in", "...units are still under") forms an ACCIDENTAL "in
// warranty"/"under warranty" match purely from the concatenation seam, not from anything the
// question said. Guarded off whenever q's last real word is one of STRICT_ACTIVE_STATUS_RE's own
// two preposition-led phrases' lead word ("in"/"under") with nothing warranty-related after it.
const TRAILING_BARE_PREPOSITION_RE = /\b(?:in|under)\s*$/i;
const OTHER_COVERAGE_RE = /\b(?:agreements?|plans?|contracts?|memberships?|insurance|polic(?:y|ies)|subscriptions?)\b/i;

function impliedWarrantyStatus(q, entity) {
  // R35 adversarial pass: "covered by warranty but not registered" carries a SECOND condition (registration) this plan has no filter for —
  // never silently dropped (the whole plan bails instead of answering the bare warranty count).
  if (REGISTRATION_CONJUNCT_RE.test(q)) return WARRANTY_STATUS_AMBIGUOUS;
  const direct = warrantyStatusFromQuestion(q);
  if (direct) return direct;
  if (hasAmbiguousWarrantyStatusNegation(q)) return WARRANTY_STATUS_AMBIGUOUS;
  if (entity !== 'equipment' && entity !== 'warranties') return null;
  if (TRAILING_BARE_PREPOSITION_RE.test(q.trim())) return null;
  // R35: "covered by a maintenance agreement / service plan / contract" names a DIFFERENT kind of coverage — never a warranty status,
  // and never silently dropped either (the whole deterministic plan bails, same as an ambiguous negation).
  if (OTHER_COVERAGE_RE.test(q)) return /\b(?:covered|coverage|cover)\b/i.test(q) ? WARRANTY_STATUS_AMBIGUOUS : null;
  const relaxed = `${q} warranty`;
  const relaxedStatus = warrantyStatusFromQuestion(relaxed);
  if (relaxedStatus) return relaxedStatus;
  if (hasAmbiguousWarrantyStatusNegation(relaxed)) return WARRANTY_STATUS_AMBIGUOUS;
  return null;
}

/** "runs on R-22" / "uses R-410A" — a refrigerant CODE (the stored
 *  convention this corpus uses is "R-" + digits + an optional trailing
 *  letter, e.g. "R-410A"/"R-454B") named right after "runs on"/"uses"/
 *  "on <code>". A bare mention with no recognizable code (e.g. a stray "r"
 *  somewhere unrelated) never matches — this is deliberately narrow so it
 *  only ever fires on a real refrigerant-code token, never a guess. */
const REFRIGERANT_CODE_RE = /\br-?(\d{2,4}[a-z]?)\b/i;

function detectRefrigerantMention(q) {
  return REFRIGERANT_CODE_RE.test(q);
}

function buildRefrigerantFilter(q) {
  const m = REFRIGERANT_CODE_RE.exec(q);
  return m ? { field: 'refrigerant', op: 'eq', value: `R-${m[1].toUpperCase()}` } : null;
}

/** "customers without any contact info (on file) at all" — neither the bare
 *  word "email" nor "phone" appears, so detectedConditions' own CONTACT_WORD_RE
 *  never fires for either — a real, common owner phrasing for exactly the
 *  hasEmail=false AND hasPhone=false combination. */
const NO_CONTACT_INFO_RE = /\b(?:no|not have|don'?t have|without|missing|lacking)\s+(?:any\s+)?contact\s+(?:info(?:rmation)?|details?)\b/i;

/** "installs ... since 2020" — see its one use-site's own doc comment. */
const SINCE_YEAR_RE = /\bsince\s+(\d{4})\b/i;

/**
 * R20 (J3, F1 "installs this year vs last"): "how many units have we installed so far this year" /
 * "how many units did we install last year" — a real calendar-YEAR cutoff on the unit's own
 * installation_date, named with "this year"/"last year" rather than a literal 4-digit year
 * (SINCE_YEAR_RE's own territory just above). Scoped to a genuine install-event mention (the
 * INSTALL_WORD_RE verb, not just any equipment noun) so an unrelated "units under warranty this
 * year" question is left to the ordinary warranty/time-window paths instead of being reinterpreted
 * as an install-year filter it never named. installYear is a plain numeric FILTER_FIELD (op 'eq'
 * already works via matchesFilter's generic numeric compare — see that function's own doc comment),
 * so no new plan vocabulary is needed, just the year arithmetic itself (done here from `today`, the
 * same "code computes the year, never the model" rule resolveAgeFilter/detectWarrantyExpiryWindow
 * already follow).
 */
const INSTALL_WORD_RE = /\binstall(?:ed|s|ation)?\b|\bput\s+in\b|\bput\s+them?\s+in\b/i;
const THIS_YEAR_INSTALL_RE = /\b(?:so\s+far\s+)?this\s+year\b/i;
const LAST_YEAR_INSTALL_RE = /\blast\s+year\b/i;
// R21 M2 (Cluster 2, j040/j041/j061 "before (the) summer ... this year", and every OTHER
// resolveExtendedTimeRange phrasing — "within the past 5 years", "since ...", "in the last N
// years", a bare season, etc.): a bare "this year"/"last year" match below is a coarse CALENDAR-
// YEAR-only filter (installYear eq); any of these more specific phrasings must win first, or (for
// "before summer ... this year") the "this year" substring inside it would otherwise be caught by
// THIS_YEAR_INSTALL_RE and silently widen "Jan-May" into the WHOLE year.
// NOTE: deliberately NOT a bare `\bsince\b` — "since 2020" (a literal 4-digit year) is SINCE_YEAR_RE's
// own, older, brand-aware territory just below (equipmentLike && SINCE_YEAR_RE), which this must
// never shadow; only the qualitative "since the start of last year"/"since last year began" shape
// (no literal year at all) belongs to resolveAnyTimeRange.
const EXTENDED_TIME_PHRASE_RE =
  /\bbefore\s+(?:the\s+)?summer\b|\bsince\s+(?:the\s+sta\w*\s+of\s+)?last\s+year(?:\s+began)?\b|\b(?:within|in)\s+the\s+(?:last|past)\s+\d+\s+(?:day|days|week|weeks|month|months|year|years)\b|\b(?:this|last|past)\s+(?:winter|spring|summer|fall|autumn)\b|\bytd\b|\byear[\s-]?to[\s-]?date\b|\bthis\s+quarter\b|\blast\s+quarter\b|\bpast\s+quarter\b/i;

function detectInstallYearRelative(q, today) {
  if (!INSTALL_WORD_RE.test(q) || !EQUIPMENT_NOUN_RE.test(q)) return null;
  if (EXTENDED_TIME_PHRASE_RE.test(q)) return null;
  const now = today ? new Date(today) : new Date();
  if (Number.isNaN(now.getTime())) return null;
  const currentYear = now.getUTCFullYear();
  let year = null;
  if (LAST_YEAR_INSTALL_RE.test(q)) year = currentYear - 1;
  else if (THIS_YEAR_INSTALL_RE.test(q)) year = currentYear;
  if (year === null) return null;
  return { entity: 'equipment', op: opFromShape(q), filters: [{ field: 'installYear', op: 'eq', value: year }] };
}

/**
 * R21 M2 (Cluster 2, j040/j041/j046/j061: "before the summer this year", "within the past 5
 * years", "before summer hit this year" — all naming an install EVENT, not a calendar-year
 * bucket): resolveAnyTimeRange (analytics.js's ONE central relative-time resolver, extended this
 * round with before-summer/within-N-years/trailing-quarter/since-last-year/bare-past-week) gives
 * the exact day-grain {from,to} every one of these phrasings needs; detectInstallYearRelative just
 * above only ever handles the two COARSE bare "this year"/"last year" cases (a real calendar-year
 * bucket, not a day-precise window) and now explicitly yields to this for everything else via
 * EXTENDED_TIME_PHRASE_RE. plan.timeRange is applied against installation_date the same day-grain
 * way documents/serviceVisits already apply theirs — see routes/analytics.js's equipment branch.
 */
function detectInstallDateRelativeRange(q, today) {
  if (!INSTALL_WORD_RE.test(q) || !EQUIPMENT_NOUN_RE.test(q)) return null;
  if (!EXTENDED_TIME_PHRASE_RE.test(q)) return null;
  const range = resolveAnyTimeRange(q, today);
  if (!range) return null;
  return { entity: 'equipment', op: opFromShape(q), filters: [], timeRange: { from: range.from, to: range.to } };
}

/**
 * R20 (J3, i011): "how many properties do we have more than one unit installed at" — a per-customer
 * equipment count > 1 (a GROUP BY ... HAVING shape no flat filter value alone could express), the
 * customers-side mirror of hasAnyEquipment (which only ever answers the zero/nonzero question, not
 * "more than one"). hasMultipleUnits (analytics.js's DATA_QUALITY_FIELD_ENTITY) is computed the same
 * correlated-subquery way as hasAnyEquipment — see buildAnalyticsSQL's own customers branch.
 */
const MULTI_UNIT_CUSTOMER_RE =
  /\b(?:more\s+than\s+one|multiple|two\s+or\s+more|at\s+least\s+two)\s+units?\b[\s\S]{0,20}\binstalled\s+at\b|\bproperties\b[\s\S]{0,30}\bmore\s+than\s+one\s+unit\b/i;

function detectMultiUnitCustomers(q) {
  if (!MULTI_UNIT_CUSTOMER_RE.test(q)) return null;
  return { entity: 'customers', op: opFromShape(q), filters: [{ field: 'hasMultipleUnits', op: 'eq', value: true }] };
}

/**
 * R20 (J3, F1 "per-name purchase-order checks" sibling / i020-i021): "how many purchase orders have
 * we cut/issued/sent to Baker Distributing" — a documents count filtered to BOTH the purchase-order
 * document type and the vendor named right after cut/issued/sent/placed/written ... to. `vendor` is a
 * plain string FILTER_FIELD matched via matchesFilter's generic 'contains' path (analytics.js) against
 * the vendor_name extraction buildAnalyticsSQL's documents branch now also selects — no closed vendor
 * vocabulary needed (unlike a customer name, a vendor name here is read straight off the question, the
 * same way a city/brand value already is). Requires an explicit purchase-order mention AND an action
 * verb + "to" so this never fires on an unrelated "documents linked to <name>" sentence.
 */
const VENDOR_PO_RE =
  /\bpurchase\s+orders?\b[\s\S]{0,30}?\b(?:cut|issued|sent|placed|written|made\s+out)\s+to\s+([a-z][a-z0-9 &.,'-]*?)\s*[?.!]*$/i;

function detectVendorPurchaseOrderCount(q) {
  const m = VENDOR_PO_RE.exec(q);
  if (!m) return null;
  const vendor = titleCaseWords(m[1].trim());
  if (!vendor) return null;
  return {
    entity: 'documents',
    op: 'count',
    filters: [
      { field: 'documentType', op: 'eq', value: 'purchase-order' },
      { field: 'vendor', op: 'contains', value: vendor },
    ],
  };
}

/**
 * D4: "which maintenance agreements expire in 2026" / "how many agreements run through 2027" / "contracts ending in 2028" - the year names the END
 * of the agreement's term (the last date of "Agreement Period: start - end"), a forward-looking record field that legitimately sits in the future.
 * Without this the year became a service-date window on the agreement document (-> "No documents match that") or, for a future year, the generic
 * "that's a future date, nothing on file" decline. Needs an agreement/contract noun, an END cue and at least one 4-digit year; a question about
 * an EVENT in a future year ("agreements signed in 2029") has no end cue and is left to the future-date decline.
 */
const AGREEMENT_NOUN_RE = /\b(?:(?:maintenance|service|annual|hvac|pm)\s+(?:agreements?|contracts?|plans?)|agreements?|contracts?|memberships?)\b/i;
const AGREEMENT_END_CUE_RE = /\b(?:expir\w*|ends?|ending|renew\w*|lapse\w*|(?:run|runs|running|good|valid|active|effective|in\s+effect|current|lasts?|lasting)\s+(?:through|thru|until|till|to)|in\s+force|(?:still\s+)?(?:active|valid|running)\s+(?:in|during|at|by)|(?:run|runs|running|extend\w*|go|goes|going|last\w*|stay\w*)\s+(?:past|beyond))\b/i;
const AGREEMENT_EXCLUDE_RE = /\b(?:warrant(?:y|ies)|registered|registration|invoice[sd]?|paid|signed|started|began|begin)\b/i;

function detectAgreementEnd(q) {
  if (!AGREEMENT_NOUN_RE.test(q) || !AGREEMENT_END_CUE_RE.test(q) || AGREEMENT_EXCLUDE_RE.test(q)) return null;
  const years = [...q.matchAll(/\b((?:19|20|21)\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length || years.length > 2) return null;
  const filters = [{ field: 'documentType', op: 'eq', value: 'maintenance-agreement' }];
  const lo = Math.min(...years); const hi = Math.max(...years);
  const end = (op, y, md) => filters.push({ field: 'agreementEnd', op, value: `${y}-${md}` });
  if (years.length === 2 && lo !== hi) {
    if (!/\b(?:between|from)\b[\s\S]*\b(?:and|to|through|thru)\b|\b\d{4}\s*(?:-|–|to|through)\s*\d{4}\b/i.test(q)) return null;
    end('gte', lo, '01-01'); end('lte', hi, '12-31');
  } else {
    const y = lo;
    // "run through the end of 2026" / "still in force at the end of 2026": the "end" is the end of the YEAR, not an end-date cue, so it is taken out before
    // the expire/end test; "through"/"until"/"at the end of" a year = still running on its last day (end date >= Dec 31); "active/in force IN 2027" = still
    // running at some point in that year (end date >= Jan 1).
    const qn = q.replace(/\bend\s+of\s+(?:the\s+)?(?:year\s+)?(?=\d{4})/gi, ' ');
    const standaloneEnd = /\b(?:expir\w*|ends?|ending)\b/i.test(qn);
    if (!standaloneEnd && /\b(?:run|runs|running|good|valid|active|effective|in\s+effect|in\s+force|current|lasts?|lasting)\s+(?:through|thru|until|till|to)\b|\b(?:through|thru|until|till)\s+(?:at\s+least\s+)?(?:the\s+)?(?:end\s+of\s+)?(?:year\s+)?\d{4}|\b(?:in\s+force|in\s+effect|active|valid|running)\s+(?:at|by)\s+(?:the\s+)?end\s+of\s+(?:the\s+)?(?:year\s+)?\d{4}/i.test(q)) end('gte', y, '12-31');
    else if (!standaloneEnd && /\b(?:still\s+)?(?:in\s+force|in\s+effect|active|valid|running)\s+(?:in|during)\s+(?:the\s+year\s+)?\d{4}/i.test(q)) end('gte', y, '01-01');
    else if (/\b(?:by|on\s+or\s+before|no\s+later\s+than)\s+(?:the\s+)?(?:end\s+of\s+)?(?:year\s+)?\d{4}/i.test(q)) end('lte', y, '12-31');
    else if (/\bbefore\s+(?:the\s+)?(?:end\s+of\s+)?(?:year\s+)?\d{4}/i.test(q)) end('lt', y, '01-01');
    else if (/\b(?:after|later\s+than|beyond|past)\s+(?:the\s+)?(?:end\s+of\s+)?(?:year\s+)?\d{4}/i.test(q)) end('gt', y, '12-31');
    else { end('gte', y, '01-01'); end('lte', y, '12-31'); }
  }
  return { entity: 'documents', op: HOW_MANY_RE.test(q) ? 'count' : 'list', filters };
}

/**
 * D8: "how many commercial permits do we have" / "which residential permits are in Chandler" / "permits issued by the City of Tucson" - a permit's
 * scope (commercial vs residential, from its "Scope of Work" line) and issuing city are real conditions on a permit that no filter carried, so the
 * count was every permit ("You have 27 documents"). Needs a permit noun and at least one of scope / city; a permit NUMBER, a state/county/zip, or both
 * scopes in one question is not something this can apply, so the whole plan bails (the question goes to the next lane) instead of answering the
 * broader question. Returns the plan, the BAIL sentinel, or null (no permit scope/city condition named at all - existing behaviour untouched).
 */
const OUT_OF_STATE_RE = /\bout[\s-]*of[\s-]*(?:the\s+)?state\b|\bnon[\s-]*(?:local|resident)\b|\boutside\s+(?:of\s+)?(?:the\s+)?state\b|\bnot\s+(?:in|from)\s+(?:the\s+)?(?:our\s+)?(?:home\s+)?state\b|\bother\s+states?\b|\b(?:another|an?\s+different|different|diff)\s+state\b/i;
const PERMIT_BAIL = Symbol('permitBail');
function detectPermitFilters(q) {
  if (!/\bpermits?\b/i.test(q)) return null;
  const hasCommercial = /\bcomm?ercial\b/i.test(q); const hasResidential = /\bresidential\b/i.test(q);
  const found = detectedConditions(q);
  const cityWanted = found.has('city');
  // A permit prints no issue date: any year/month window on a permit question ("how many permits were issued in 2026") hands on, never a false "0 documents in 2026".
  if (found.has('month') || /\b(?:19|20)\d{2}\b|\b(?:this|last)\s+(?:year|month|quarter)\b|\byear\s+to\s+date\b|\bytd\b/i.test(q)) {
    if (!/\b(?:bp|pm|mp|pr)-?\d{3,}/i.test(q)) return PERMIT_BAIL;
  }
  if (!hasCommercial && !hasResidential && !cityWanted) return null;
  // A question about CUSTOMERS with / without a permit ("which Tucson customers don't have a permit on file") is a customer list, not a permit count:
  // with a scope word it cannot be applied here (bail); without one it is left to the existing customer paths.
  if (/\b(?:customers?|clients?|accounts?|homeowners?|businesses|who)\b|\b(?:don'?t|doesn'?t|do\s+not|does\s+not|without|never|missing|lack\w*|haven'?t|hasn'?t|no|not)\b/i.test(q)) return hasCommercial || hasResidential ? PERMIT_BAIL : null;
  if (/\b(?:bp|pm|mp|pr)-?\d{3,}/i.test(q) || (hasCommercial && hasResidential)) return PERMIT_BAIL;
  if (found.has('county') || found.has('state') || found.has('zip') || found.has('brand') || found.has('money') || found.has('email') || found.has('phone') || found.has('warranty')) return PERMIT_BAIL;
  // A permit prints no issue date, so a year/month/"this year" window cannot be applied to it: never answer "none on file" (the window zeroed the set) or the broader
  // count as if the window were applied - hand on instead.
  if (found.has('month') || /\b(?:19|20)\d{2}\b|\b(?:this|last)\s+(?:year|month|quarter)\b|\byear\s+to\s+date\b|\bytd\b/i.test(q)) return PERMIT_BAIL;
  const filters = [{ field: 'documentType', op: 'eq', value: 'permit' }];
  if (hasCommercial || hasResidential) filters.push({ field: 'permitScope', op: 'eq', value: hasCommercial ? 'commercial' : 'residential' });
  if (cityWanted) {
    const c = buildConditionOverrideFilter('city', q, 'documents');
    if (!c || c.op !== 'eq') return PERMIT_BAIL;
    filters.push({ field: 'permitCity', op: 'eq', value: c.value.toLowerCase() });
  }
  return { entity: 'documents', op: HOW_MANY_RE.test(q) ? 'count' : 'list', filters };
}

/**
 * R21 (M2, g103): "how many trane jobs have we done total" — a bare brand-only count of DOCUMENTS
 * linked to an equipment entity of that manufacturer (see routes/analytics.js's
 * queryDocumentsByEquipmentBrand for the exact join this oracle wants — no service_date/service-visit
 * gating at all, unlike every other "<brand> ... visit/repair/tune-up ..." shape below, which counts
 * actual dated VISITS). Deliberately narrow: ONLY a bare "<brand> jobs (done|completed|run) ... total"
 * with no OTHER named condition (no city, no service-type, no time window) — a question naming any of
 * those is cluster 1's own richer multi-constraint shape (a "which visits/jobs" question with a real
 * time or geo qualifier), never this bare document-count definition, so this bails (null) the moment
 * detectedConditions sees more than the one brand condition.
 */
const BRAND_JOBS_TOTAL_RE =
  /\bjobs?\b[\s\S]{0,15}\b(?:have\s+we\s+|has\s+(?:the\s+shop|the\s+crew)\s+)?(?:done|completed|performed|run)\b[\s\S]{0,15}\btotal\b|\btotal\b[\s\S]{0,15}\bjobs?\b[\s\S]{0,15}\b(?:have\s+we\s+)?(?:done|completed|performed|run)\b/i;

function detectBrandJobsDocumentCount(q) {
  if (!BRAND_JOBS_TOTAL_RE.test(q)) return null;
  const found = detectedConditions(q);
  if (!found.has('brand') || found.size > 1) return null;
  const brand = buildConditionOverrideFilter('brand', q, 'equipment');
  if (!brand) return null;
  return { entity: 'documents', op: 'count', filters: [{ field: 'linkedEquipmentBrand', op: 'eq', value: brand.value }] };
}

/**
 * R20 (J3, i094): "how many warranty registrations took longer than 30 days after install" — the
 * per-unit gap (in days) between warranty.registrationOnFile and the unit's own install date,
 * compared against whatever threshold the question actually names (never hard-coded to 30 — a
 * paraphrase asking about 60 or 14 days must compare against ITS OWN number). warrantyRegistrationDays
 * is a plain numeric FILTER_FIELD (shapeEquipmentRow, routes/analytics.js) — null on a unit missing
 * either date, which matchesFilter's own "actual == null -> never matches" rule already excludes from
 * every op, exactly like the oracle's own join (a unit with no registration row can't appear in it).
 */
const WARRANTY_REG_DAYS_RE =
  /\bwarranty\s+registrations?\b[\s\S]{0,25}\b(?:took\s+longer\s+than|longer\s+than|more\s+than|over)\s+(\d{1,3})\s*days?\s+after\s+(?:the\s+)?install/i;
// R21 M2 (deferred list, i093 "how many warranty registrations went in within 30 days of the
// install date"): the complement of WARRANTY_REG_DAYS_RE just above — "within N days of" names an
// AT-MOST threshold (op 'lte'), never the "took longer than" over-threshold shape, so this is its
// own regex/op pair rather than a third alternative folded into that one (the two must never share
// an op). Matched separately so a paraphrase using "of the install"/"of install" (no "after") still
// resolves — "within N days of" is unambiguous on its own; "after install" adds nothing WARRANTY_REG_DAYS_RE
// doesn't already need for ITS OWN "took longer than" phrasing.
const WARRANTY_REG_DAYS_WITHIN_RE =
  /\bwarranty\s+registrations?\b[\s\S]{0,25}\bwithin\s+(\d{1,3})\s*days?\s+of\s+(?:the\s+)?install/i;

function detectWarrantyRegistrationDays(q) {
  const m = WARRANTY_REG_DAYS_RE.exec(q);
  if (m) return { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyRegistrationDays', op: 'gt', value: Number(m[1]) }] };
  const w = WARRANTY_REG_DAYS_WITHIN_RE.exec(q);
  if (w) return { entity: 'equipment', op: 'count', filters: [{ field: 'warrantyRegistrationDays', op: 'lte', value: Number(w[1]) }] };
  return null;
}

/* ============================================================ dimension words
 * (groupBy/coverage shapes — "by <dim>", "per <dim>", "how many different
 * <dim>", "each <dim>") — canonical GROUP_BY_FIELDS names, matched via their
 * own plain-English plural/singular spelling.
 */
const DIM_WORD_TO_FIELD = {
  zip: 'zip', 'zip code': 'zip', 'zip codes': 'zip',
  county: 'county', counties: 'county',
  city: 'city', cities: 'city',
  state: 'state', states: 'state',
  brand: 'brand', brands: 'brand',
  // R19 (I2, h113): "manufacturer" is the same closed BRAND_WORDS-backed dimension as "brand" —
  // just the word an owner uses when asking "which MANUFACTURER do we have the fewest units of"
  // rather than "which brand". Same GROUP_BY_FIELDS value ('brand'), never a second column.
  manufacturer: 'brand', manufacturers: 'brand',
  technician: 'technician', technicians: 'technician',
  // R19 (I2, h115): "tech" is the everyday-speech short form of "technician" ("which tech has done
  // the fewest visits") — same dimension, same forced 'serviceVisits' entity below.
  tech: 'technician', techs: 'technician',
  month: 'month', months: 'month',
  'document type': 'documentType', 'document types': 'documentType',
  'warranty status': 'warrantyStatus',
};
const DIM_ALT = altOf(Object.keys(DIM_WORD_TO_FIELD));

/* ============================================================ dedicated shape detectors
 * Tried, in order, before the generic entity/op/filter path below — each one
 * is a narrow, well-known shape that the generic path would get wrong
 * (a different entity, a different op) if left to it.
 */

/** "how many jobs did Wyatt Coburn do last month" / "how many jobs did Danny
 *  Ochoa run this month" — a NAMED technician as the subject of do/run/
 *  close(out)/complete/handle. Never resolveServiceVisitsOverride's own
 *  territory (that regex only ever matches a generic "we"/"did we service"
 *  subject) — this is the same shape for a specific PERSON instead. */
const TECHNICIAN_ACTION_RE =
  /\b(?:did|do|does)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+(?:do|run|close(?:\s+out)?|complete|handle)\b/i;
// R20 (J3, i014/i015): "how many jobs HAS Denise Ford CLOSED OUT total" / "...HAVE they COMPLETED
// total" — the same named-technician-as-subject shape as TECHNICIAN_ACTION_RE just above, only with
// a has/have auxiliary (present-perfect) instead of did/do/does, so the verb that follows the name is
// the PAST-PARTICIPLE form (closed/completed/handled/done/run) rather than the bare one.
// R21 (M2, cluster 4, j151-j156): "how many jobs total HAS Kevin Pratt BEEN OUT ON" — the same
// present-perfect, named-technician-as-subject shape, just with "been (out) on" instead of a plain
// past participle. Genuinely common everyday phrasing ("been out on a job"), not this exam's own
// wording — added as one more alternative of the SAME verb slot, not a new detector.
const TECHNICIAN_ACTION_PERFECT_RE =
  /\b(?:has|have)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})\s+(?:done|run|closed(?:\s+out)?|completed|handled|been(?:\s+out)?\s+on)\b/i;
const NON_NAME_STOPWORDS = new Set([
  'we', 'you', 'they', 'it', 'he', 'she', 'the', 'our', 'any', 'each', 'this', 'that',
  'customers', 'clients', 'units', 'equipment', 'jobs', 'work', 'service',
]);

/** "ddanny ochoa" — a doubled FIRST letter typo of a proper name (there is no
 *  closed technician-name vocabulary for normalizeQuestion's own fuzzy
 *  corrector to check a name against, so this common slip reaches this file
 *  uncorrected). Collapsing a doubled leading letter is a general typo shape,
 *  not a name-specific fix — the same "repeated-letter slip" family as the
 *  "yeears"/"eexpiring" tolerances above. */
function dedupeLeadingLetter(word) {
  const m = /^([a-z])\1(\w{3,})$/i.exec(word);
  return m ? m[1] + m[2] : word;
}

function detectTechnicianAction(q) {
  const m = TECHNICIAN_ACTION_RE.exec(q) ?? TECHNICIAN_ACTION_PERFECT_RE.exec(q);
  if (!m) return null;
  const name = m[1].trim().split(/\s+/).map(dedupeLeadingLetter).join(' ');
  const firstWord = name.split(/\s+/)[0].toLowerCase();
  if (NON_NAME_STOPWORDS.has(firstWord)) return null;
  return {
    entity: 'serviceVisits',
    op: opFromShape(q),
    filters: [{ field: 'technician', op: 'eq', value: titleCaseWords(name) }],
  };
}

/** "breakdown by technician" / "each technician (close out/did/ran) ..." /
 *  "which technician did the most jobs" — technician is the ONLY dimension
 *  word that names no OTHER entity noun of its own ("jobs"/"units"/...) most
 *  of the time, so it needs its own forced-entity rule the same way
 *  resolveServiceVisitsOverride forces entity for its own shapes — a bare
 *  noun-based default would otherwise land on 'customers', which has no
 *  'technician' column at all. */
const TECHNICIAN_GROUPBY_RE =
  /\bbreakdown\s+by\s+technician\b|\beach\s+technician\b|\bwhich\s+technician\b[\s\S]*\b(?:most|top)\b/i;

function detectTechnicianGroupBy(q) {
  if (!TECHNICIAN_GROUPBY_RE.test(q)) return null;
  return { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician' };
}

/** "how many different zip codes/counties/cities/states/brands/technicians
 *  do we cover/serve/have" / "how many distinct document types do we
 *  actually track" — the DIMENSION's own distinct-value count, never a
 *  per-group breakdown (see analytics.js's formatAnalyticsAnswer, which
 *  reads plan.countDistinct to answer with a single number instead of a
 *  breakdown list). "distinct" is the same request as "different" — a plain
 *  everyday synonym, not a second shape. */
const DIFFERENT_DIM_RE = new RegExp(`\\bhow many (?:different|distinct)\\s+(${DIM_ALT})\\b`, 'i');

/**
 * Field-phrasing g133/g138 ("whats the oldest unit we have on file" /
 * "whats our newest install") — equipment RANKED by installation_date, never
 * a filtered/counted question. Scoped to a genuine equipment/install noun
 * (EQUIPMENT_NOUN_RE, the same table entityFromNouns above reads) so an
 * unrelated superlative this file has no ranking query for ("our newest
 * customer", "the latest invoice") is left alone rather than guessed at —
 * this shape, unlike sortBy for customers (validatePlan, analytics.js),
 * plugs into queryInstallDateExtreme/formatInstallDateExtremeAnswer
 * (routes/analytics.js), never buildAnalyticsSQL's plain filtered path.
 */
// R19 (I2, h114): "whats our newest mitsubishi install" — the oldest/newest RANKING must still
// respect a brand named in the same sentence (queryInstallDateExtreme, routes/analytics.js, now
// takes plan.filters and narrows the candidate set to it before finding the extreme date) — reuses
// buildConditionOverrideFilter('brand', ...) exactly like every other brand mention in this file
// rather than a second brand-word table. A question naming no brand gets no filter, same as before.
// R21 M2 (Cluster 3, j147: "whose unit did we most recently install") — a genuine synonym of
// "newest"/"latest" that names the same installDateDesc ranking with neither word present at all.
const MOST_RECENTLY_INSTALLED_RE = /\bmost\s+recently\s+install(?:ed)?\b/i;

function detectInstallDateExtreme(q) {
  if (!EQUIPMENT_NOUN_RE.test(q)) return null;
  const sortBy = /\b(oldest|earliest)\b/i.test(q)
    ? 'installDateAsc'
    : /\b(newest|latest)\b/i.test(q) || MOST_RECENTLY_INSTALLED_RE.test(q)
      ? 'installDateDesc'
      : null;
  if (!sortBy) return null;
  const plan = { entity: 'equipment', op: 'list', sortBy };
  const brand = buildConditionOverrideFilter('brand', q, 'equipment');
  if (brand) plan.filters = [brand];
  // R21 M2 (Cluster 3, j148/j149: "how old is the oldest/newest unit we've got, in years") — same
  // ranking, but the answer wanted is the AGE IN YEARS of that extreme unit, not the record itself
  // or its raw install date (routes/analytics.js's formatInstallDateExtremeAnswer branches on this).
  if (/\bhow\s+old\b/i.test(q)) plan.ageInYears = true;
  return plan;
}

/**
 * Round 16 part 2, D2 item 3: exported so api/ask.js (F4) can stop routing this exact shape to the
 * agent-first path. agent/intents.js's isUnitRankingQuestion (and ask.js's own analyticsCandidate
 * gate, ~L872, plus the isAgentFirstQuestion check at ~L1656) both predate this file's new
 * detectInstallDateExtreme/queryInstallDateExtreme/formatInstallDateExtremeAnswer support and were
 * written when "the closed-vocabulary analytics planner has no sort for equipment" was still true —
 * it no longer is, for this one shape (oldest/newest/earliest/latest unit|system|equipment|install).
 * ask.js does not import analytics/detPlan.js today (only analytics.js, which cannot re-export
 * this — detPlan.js already imports from analytics.js, so the reverse import is circular and
 * throws a TDZ error on ENTITY_SYNONYMS at load) and is outside F2's ownership this round, so this
 * export is a hook, not a wire-up — see the round report for the exact ask.js patch needed (a new
 * import straight from './_lib/analytics/detPlan.js' plus two call-site edits) to stop
 * double-routing g133/g138-shaped questions to the model-backed agent when this deterministic path
 * can already answer them for free.
 */
export function isInstallDateExtremeQuestion(question) {
  return detectInstallDateExtreme(String(question ?? '')) !== null;
}

// R20 (J3, i115/i116): "what's the earliest/most recent warranty registration date we have on
// file" — a RANKING over data.warranty.registrationOnFile, never a plain filtered count.
// Requires the explicit phrase "warranty registration(s)" so an unrelated "oldest unit"
// (detectInstallDateExtreme above) or "most recent invoice" is never mistaken for this shape.
const WARRANTY_REG_DATE_RE = /\bwarranty\s+registrations?\b/i;
function detectWarrantyRegDateExtreme(q) {
  if (!WARRANTY_REG_DATE_RE.test(q)) return null;
  const sortBy = /\b(oldest|earliest)\b/i.test(q) ? 'warrantyRegDateAsc' : /\b(newest|latest|most\s+recent)\b/i.test(q) ? 'warrantyRegDateDesc' : null;
  if (!sortBy) return null;
  return { entity: 'equipment', op: 'list', sortBy };
}

// R20 (J3, i030): "how many distinct document types do we actually track" used to fall through
// to the 'customers' default below — documents have no per-customer documentType column at all,
// so that silently answered a bare customer count instead. documentType is its own entity, same
// as brand/technician just below. Shared by every DIM_WORD_TO_FIELD-driven distinct-value
// detector (count, list) so the entity mapping never drifts apart between them.
function entityForDimension(field) {
  return field === 'brand' ? 'equipment' : field === 'technician' ? 'serviceVisits' : field === 'documentType' ? 'documents' : 'customers';
}

function detectDistinctDimensionCount(q) {
  const m = DIFFERENT_DIM_RE.exec(q);
  if (!m) return null;
  const field = DIM_WORD_TO_FIELD[m[1].toLowerCase()];
  if (!field) return null;
  return { entity: entityForDimension(field), op: 'groupBy', groupBy: field, countDistinct: true };
}

/**
 * R23 (D2, field-phrasing-5.json k143/k186/k187): "how many technicians do we have logging jobs
 * in this system" / "which manufacturers do we service, across every unit on the books" / "list
 * every technician we've got logging jobs in the system" — a bare (no "different"/"distinct")
 * "how many <dim>"/"which <dim> do we ..."/"list every <dim>" question about the technician or
 * manufacturer/brand dimension ITSELF still means "the distinct values of that dimension", exactly
 * like DIFFERENT_DIM_RE's own shape just above — but with no "different"/"distinct" word to key
 * off. Left entityFromNouns' generic fallback (below) used to win these instead: "jobs"/"service"/
 * "unit" is also a genuine SERVICE_VISIT_NOUN_RE/EQUIPMENT_NOUN_RE word in the SAME sentence, so a
 * bare "how many technicians ... jobs ..." question silently became a plain, unfiltered
 * service-visit COUNT ("You have 317 service visits") instead of the technician dimension's own
 * distinct value the question actually named — confident, but a completely different number.
 * Scoped to ONLY technician/brand (never city/state/zip/month/documentType/warrantyStatus, which
 * already have their own tested, narrower bare-phrasing paths elsewhere in this file — widening
 * this to every GROUP_BY_FIELDS dimension is unnecessary risk this round never needed to take) —
 * and guarded against a genuine per-technician THRESHOLD question ("how many technicians logged
 * more than 50 jobs each") that only happens to start the same way, which this file has no plan
 * shape for at all and must never guess at (return null, not a wrong distinct count).
 */
const BARE_COUNT_DIMS = ['technician', 'technicians', 'tech', 'techs', 'brand', 'brands', 'manufacturer', 'manufacturers'];
const BARE_COUNT_DIM_ALT = altOf(BARE_COUNT_DIMS);
const BARE_DIM_COUNT_RE = new RegExp(`\\bhow many\\s+(${BARE_COUNT_DIM_ALT})\\b`, 'i');
const BARE_DIM_PER_ITEM_THRESHOLD_RE = /\b(?:more|fewer|less)\s+than\b|\bat least\b|\bover\s+\d|\bunder\s+\d|\beach\b/i;

function detectBareDimensionDistinctCount(q) {
  if (!BARE_DIM_COUNT_RE.test(q) || BARE_DIM_PER_ITEM_THRESHOLD_RE.test(q)) return null;
  const m = BARE_DIM_COUNT_RE.exec(q);
  const field = DIM_WORD_TO_FIELD[m[1].toLowerCase()];
  if (!field) return null;
  return { entity: entityForDimension(field), op: 'groupBy', groupBy: field, countDistinct: true };
}

/** Same dimension/scope as detectBareDimensionDistinctCount just above, for the LIST shape instead
 *  of the bare count: "which manufacturers/technicians do we <verb>" or "list every/all
 *  manufacturer(s)/technician(s) ...". Never the "which technician has the most jobs" superlative
 *  shape (detectGroupBySuperlative, tried first in the chain below) — that names a RANKING word
 *  ("most"/"fewest"/...) this regex doesn't match at all. */
const LIST_DISTINCT_DIM_RE = new RegExp(
  `\\bwhich\\s+(${BARE_COUNT_DIM_ALT})\\b[\\s\\S]{0,40}\\b(?:do we|have we|are on)\\b|` +
    `\\blist\\s+(?:every|all(?:\\s+of)?)\\b[\\s\\S]{0,10}(${BARE_COUNT_DIM_ALT})\\b`,
  'i'
);

function detectDistinctDimensionList(q) {
  const m = LIST_DISTINCT_DIM_RE.exec(q);
  if (!m) return null;
  const word = (m[1] ?? m[2] ?? '').toLowerCase();
  const field = DIM_WORD_TO_FIELD[word];
  if (!field) return null;
  return { entity: entityForDimension(field), op: 'groupBy', groupBy: field, distinctList: true };
}

/**
 * R23 (D2, field-phrasing-5.json k139): "has Denise Ford done more jobs than Ray Sutton" — a
 * technician HEAD-TO-HEAD yes/no comparison. Tried BEFORE detectTechnicianAction (this file's own
 * dedicated chain, below) specifically because that detector's own aux+NAME+verb regex already
 * matches the LEFT half of this exact same sentence ("has Denise Ford done") and, tried first,
 * would silently answer with just Denise Ford's own bare visit count — always a nonzero, always-
 * "truthy" answer that happens to grade "correct" whenever the true comparison is "yes" and WRONG
 * whenever it's actually "no" (a tie or the left technician trailing), never a real comparison at
 * all. Builds a single 'count' plan (never 'groupBy' — see validatePlan's own doc comment on why
 * that matters here) filtered to `technician in [left, right]`, so routes/analytics.js's existing,
 * already-tested dateless-technician-row correction (only ever applied for a non-groupBy plan that
 * carries a `technician` filter) counts both sides the SAME correct way a single named technician's
 * own bare total already does — never the groupBy/superlative join h115/k141 document as
 * undercounting some technicians. formatAnalyticsAnswer's own `plan.headToHead` branch re-splits
 * the two technicians' rows back apart by their own `technician` value to get each side's real
 * count and states Yes/No accordingly (correct on a genuine tie, in both directions).
 */
const TECH_HEAD_TO_HEAD_VERB = "(?:done|run|closed(?:\\s+out)?|completed|handled|logged|worked|had|been(?:\\s+out)?\\s+on)";
const TECH_NAME_TOKEN = "[a-z][a-z.'-]*(?:\\s+[a-z][a-z.'-]*){1,2}";
const TECH_HEAD_TO_HEAD_RE = new RegExp(
  `^\\s*(?:has|have|does|do|did)\\s+(${TECH_NAME_TOKEN})\\s+${TECH_HEAD_TO_HEAD_VERB}\\b` +
    `[\\s\\S]*?\\bmore\\s+(?:jobs?|visits?|calls?|service\\s+calls?)\\b[\\s\\S]*?\\bthan\\b\\s+(${TECH_NAME_TOKEN})\\s*[?.]?\\s*$`,
  'i'
);

function detectTechnicianHeadToHead(q) {
  const m = TECH_HEAD_TO_HEAD_RE.exec(q);
  if (!m) return null;
  const left = titleCaseWords(m[1].trim().split(/\s+/).map(dedupeLeadingLetter).join(' '));
  const right = titleCaseWords(m[2].trim().split(/\s+/).map(dedupeLeadingLetter).join(' '));
  if (!left || !right || left.toLowerCase() === right.toLowerCase()) return null;
  // R24 review: "has the new tech done more jobs than the old crew" is not two names — never compare
  // (and never state "0 jobs") for phrases that start with an article/pronoun/generic noun.
  const HEAD_TO_HEAD_EXTRA_STOPWORDS = new Set(['a', 'an', 'my', 'your', 'their', 'his', 'her', 'new', 'old', 'other', 'another', 'every', 'all', 'some', 'no']);
  for (const n of [left, right]) {
    const first = n.split(/\s+/)[0].toLowerCase();
    if (NON_NAME_STOPWORDS.has(first) || HEAD_TO_HEAD_EXTRA_STOPWORDS.has(first)) return null;
  }
  return {
    entity: 'serviceVisits',
    op: 'count',
    filters: [{ field: 'technician', op: 'in', value: [left, right] }],
    headToHead: { left, right, leftLabel: `${left}'s jobs`, rightLabel: `${right}'s jobs` },
  };
}

/** "what zip codes do we serve/cover" / "customers by county" / "jobs per
 *  month" / "X per <dim>" / "each <dim>" (non-technician) / "breakdown by
 *  <dim>" / "group(ed) by <dim>" — a plain per-group breakdown, entity
 *  chosen the ordinary noun-based way (never forced, unlike technician). */
const GROUPBY_PHRASE_RE = new RegExp(
  `\\b(?:group(?:ed)?\\s+by|breakdown\\s+by|by)\\s+(${DIM_ALT})\\b|` +
    `\\bper\\s+(${DIM_ALT})\\b|` +
    `\\beach\\s+(${DIM_ALT})\\b|` +
    `\\bwhat\\s+(${DIM_ALT})\\b[\\s\\S]*\\b(?:do we (?:serve|cover|have)|are (?:on file|covered))\\b`,
  'i'
);

function detectGroupByPhrase(q) {
  const m = GROUPBY_PHRASE_RE.exec(q);
  if (!m) return null;
  const word = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
  const field = DIM_WORD_TO_FIELD[word];
  if (!field || !GROUP_BY_FIELDS.includes(field)) return null;
  if (field === 'technician') return { entity: 'serviceVisits', op: 'groupBy', groupBy: 'technician' };
  const entity = field === 'brand' ? 'equipment' : entityFromNouns(q);
  return { entity, op: 'groupBy', groupBy: field };
}

/**
 * R19 (I2, h112/h113/h115): "how many customers are in our single biggest city" / "which manufacturer
 * do we have the fewest units of" / "which tech has done the fewest visits" — a groupBy breakdown is
 * the right DATA (groupRows, analytics.js, already sorts every group largest-first), but the question
 * wants only the ONE extreme group's own name/count, never the full per-group list detectGroupByPhrase
 * builds. `superlative: 'top'|'bottom'` marks a plan for exactly that — see routes/analytics.js's
 * formatGroupBySuperlativeAnswer for how it picks the extreme named group (skipping the "Unknown"
 * bucket, which groupRows always sorts last regardless of its real count) and cites only that group's
 * own rows. Scoped to a genuine dimension word (DIM_ALT) so a question with no groupable dimension is
 * left alone, same discipline as every other detector here.
 */
// R21 (M2, h109): "busiest"/"most active" added — "who's our busiest technician" is the same
// top-superlative groupBy shape as "our biggest city"/"largest brand", just with the everyday
// synonym a shop actually uses for a technician's own visit count, not this exam's own wording.
const SUPERLATIVE_TOP_RE = new RegExp(`\\b(?:single\\s+)?(?:biggest|largest|busiest|most\\s+active)\\s+(${DIM_ALT})\\b`, 'i');
const SUPERLATIVE_BOTTOM_RE = new RegExp(
  `\\b(?:fewest|least|smallest)\\b[\\s\\S]*?\\b(${DIM_ALT})\\b|\\b(${DIM_ALT})\\b[\\s\\S]*?\\b(?:fewest|least|smallest)\\b`,
  'i'
);

function detectGroupBySuperlative(q) {
  const topM = SUPERLATIVE_TOP_RE.exec(q);
  const botM = !topM ? SUPERLATIVE_BOTTOM_RE.exec(q) : null;
  const m = topM ?? botM;
  if (!m) return null;
  const word = (m[1] ?? m[2] ?? '').toLowerCase();
  const field = DIM_WORD_TO_FIELD[word];
  if (!field || !GROUP_BY_FIELDS.includes(field)) return null;
  const entity = field === 'brand' ? 'equipment' : field === 'technician' ? 'serviceVisits' : entityFromNouns(q);
  return { entity, op: 'groupBy', groupBy: field, superlative: topM ? 'top' : 'bottom' };
}

/** "Trane vs Carrier units" / "Trane versus Carrier" — a brand comparison:
 *  groupBy brand narrowed to an `in` filter of just those two (or more)
 *  brands, exactly the shape ANALYTICS_FEW_SHOT's own "trane vs carrier
 *  units" example teaches the model. Reuses buildConditionOverrideFilter's
 *  own brand-word recognition (the same closed BRAND_WORDS table
 *  analytics.js already keys detectedConditions('brand') off) rather than a
 *  second hand-written brand list. */
const COMPARISON_JOIN_RE = /\b(?:vs\.?|versus|or)\b/i;

function detectBrandComparison(q) {
  if (!COMPARISON_JOIN_RE.test(q)) return null;
  if (!detectedConditions(q).has('brand')) return null;
  const parts = q.split(COMPARISON_JOIN_RE);
  if (parts.length < 2) return null;
  const brands = [];
  for (const part of parts) {
    const f = buildConditionOverrideFilter('brand', part);
    if (f && !brands.includes(f.value)) brands.push(f.value);
  }
  if (brands.length < 2) return null;
  return { entity: 'equipment', op: 'groupBy', groupBy: 'brand', filters: [{ field: 'brand', op: 'in', value: brands }] };
}

/** "customers locked into / enrolled in / signed up for / under a
 *  maintenance agreement" — the sentence's SUBJECT noun ("customers") is
 *  earliest, so the plain noun-based entity picker (entityFromNouns) would
 *  wrongly land on 'customers' — but the oracle counts the DOCUMENTS of that
 *  type (a customer "locked into an agreement" is really asking "how many
 *  such agreements are on file"), the same "documents" shape every other
 *  bare doc-type count few-shot already teaches ("how many permits do we
 *  have" -> documents). A real, generalizable English construction, not one
 *  tied to this exam's own wording. */
const LOCKED_INTO_DOCTYPE_RE = /\blocked into\s+(?:an?\s+)?([a-z][a-z\s-]*?)\s*[?.!]*\s*$/i;

function detectLockedIntoDocType(q) {
  const m = LOCKED_INTO_DOCTYPE_RE.exec(q);
  if (!m) return null;
  const docType = docTypeFromWord(m[1].trim());
  if (!docType) return null;
  return { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: docType }] };
}

/** "which customers are on a maintenance plan" / "have a PO on file" / "have
 *  a permit on file" / "are enrolled in / signed up for a <docType>" — unlike
 *  "locked into" (above), this phrasing asks about CUSTOMERS existentially
 *  linked to a document of that type (matches queryCustomersByDocTypeCondition's
 *  own hasDocType/lacksDocType semantics, routes/analytics.js) — a customer
 *  count/list, never a raw document count. Negation ("don't have a permit on
 *  file") flips it to lacksDocType.
 *
 *  R21 (M2, j072): "missing" added — "how many customers are missing a startup sheet entirely" is
 *  the exact same lacksDocType shape as "don't have.../no.../lacking..." just worded with "missing"
 *  instead, a word this list omitted even though it is the single most common everyday phrasing for
 *  "we don't have this on file". Its absence made j072 read as a POSITIVE hasDocType mention instead
 *  (the count of customers WHO HAVE a startup sheet, not who lack one) — silently the wrong count,
 *  not a decline. */
const DOCTYPE_NEGATION_RE = /\b(?:don'?t|doesn'?t|do\s+not|does\s+not|without|no|never|haven'?t|hasn'?t|lack(?:ing)?|missing)\b/i;

function detectCustomersHasDocType(q) {
  if (entityFromNouns(q) !== 'customers') return null;
  const m = DOC_TYPE_WORD_RE.exec(q);
  if (!m) return null;
  const docType = docTypeFromWord(m[1]);
  if (!docType) return null;
  const negated = DOCTYPE_NEGATION_RE.test(q.slice(0, m.index));
  return {
    entity: 'customers',
    op: opFromShape(q),
    filters: [{ field: negated ? 'lacksDocType' : 'hasDocType', op: 'eq', value: docType }],
  };
}

/**
 * R18 P4 (blind generalization round 18 part 2, C2 multi-hop AND-drop / C4 negation): "how many
 * trane customers needed a repair visit" / "how many carrier customers have had a repair call" /
 * "how many customers have never had a preventive maintenance visit" / "customers who have had
 * only preventive maintenance, never a repair" — a customer existentially linked to a service
 * VISIT of a given type (extractions.service_type — see SERVICE_TYPE_FILTER_FIELDS' own doc
 * comment, analytics.js), the event-level sibling of detectCustomersHasDocType just above (a
 * document TYPE). Every SERVICE_TYPE_PHRASE_RE match in the question is read independently for its
 * own nearby negation (never just the first one), so "only X, never Y" builds BOTH a hasServiceType
 * AND a lacksServiceType filter in the same plan — the one shape a single safety-net condition
 * (buildConditionOverrideFilter, which only ever returns ONE filter) could never express.
 */
function detectCustomersHasServiceType(q) {
  if (entityFromNouns(q) !== 'customers') return null;
  const matches = [...q.matchAll(new RegExp(SERVICE_TYPE_PHRASE_RE.source, 'gi'))];
  if (!matches.length) return null;
  let hasValue = null;
  let lacksValue = null;
  for (const m of matches) {
    const value = serviceTypeValueOf(m[1]);
    if (hasNearbyNegation(q.slice(0, m.index), 4)) {
      if (!lacksValue) lacksValue = value;
    } else if (!hasValue) {
      hasValue = value;
    }
  }
  if (!hasValue && !lacksValue) return null;
  const filters = [];
  if (hasValue) filters.push({ field: 'hasServiceType', op: 'eq', value: hasValue });
  if (lacksValue && lacksValue !== hasValue) filters.push({ field: 'lacksServiceType', op: 'eq', value: lacksValue });
  return { entity: 'customers', op: opFromShape(q), filters };
}

/**
 * R21 M2 (deferred list, Cluster 1/C1, r21_blind4_clusters.json — 22 ids, e.g. j001 "how many
 * Carrier units in Tempe have had a preventive maintenance visit since the start of last year"):
 * a genuine THREE-way AND — brand + (customer's) city + a service-type visit, always additionally
 * scoped to a "since <time>" window on that qualifying visit's own service_date. No prior detector
 * combined all of these: the generic safety-net path (buildSafetyNetFilters) has no notion of a
 * cross-doc service-type EXISTS at all, and detectCustomersHasServiceType (just above) only
 * combines brand+city+serviceType for entity 'customers' — with no time-window support once
 * merged, and the wrong entity for this shape regardless (see below).
 *
 * Confirmed via every one of C1's 22 ids' own oracle SQL: the count is ALWAYS distinct EQUIPMENT
 * entities (`entity_type='equipment'`) matching brand + customer service_address city, with an
 * EXISTS-linked document of the named service_type in the time window — even for the ids worded
 * "...customers in <city> got a ... visit" (j007/j011/j015/j021/j028/j031/j034): the question's own
 * noun is never a reliable entity signal for this shape, so this detector always forces 'equipment'
 * and never defers to entityFromNouns.
 *
 * All FOUR conditions (brand, city, service-type, time) must resolve to a real value; any one
 * missing bails to null (never a partial/silently-narrower plan) — see buildConditionOverrideFilter
 * and resolveAnyTimeRange's own "never guess" doc comments, the same discipline this whole file
 * applies everywhere else.
 */
function detectBrandCityServiceTypeSince(q, today) {
  const brand = buildConditionOverrideFilter('brand', q, 'equipment');
  if (brand?.op !== 'eq') return null;
  const city = buildConditionOverrideFilter('city', q, 'equipment');
  if (city?.op !== 'eq') return null;
  const stMatch = SERVICE_TYPE_PHRASE_RE.exec(q);
  if (!stMatch) return null;
  const serviceType = serviceTypeValueOf(stMatch[1]);
  const range = resolveAnyTimeRange(q, today);
  if (!range) return null;
  return {
    entity: 'equipment',
    op: opFromShape(q),
    filters: [brand, city, { field: 'hasServiceType', op: 'eq', value: serviceType }],
    timeRange: { from: range.from ?? null, to: range.to ?? null },
  };
}

/**
 * R18 P4 (C2): the general "every detected condition must be represented in the plan" guard —
 * applied to any dedicated shape detector's plan whose entity is 'customers' (the shapes this bug
 * class actually hit: detectCustomersHasDocType/detectCustomersHasServiceType dropped a SECOND
 * condition — brand, city, ... — the dedicated detector itself never looks for, exactly the "how
 * many mitsubishi customers have a maintenance agreement on file" bug: the doc-type filter was
 * right, but "mitsubishi" vanished). Reuses buildSafetyNetFilters — the SAME detector
 * detectAnalyticsPlan's own generic path already trusts — so a condition it can't confidently turn
 * into a filter bails the WHOLE plan (never a partial, silently-wrong one) rather than being
 * merged in half-built. Filters already present on the dedicated plan are left alone (never
 * duplicated or overridden) — this only ever ADDS a condition the dedicated detector didn't
 * already cover. Scoped to `entity === 'customers'` because that's the only entity every
 * SAFETY_NET_CONDITIONS field (brand/city/county/state/zip/warranty/serviceType) is actually
 * meaningful for via the customer-equipment join (routes/analytics.js's
 * EQUIPMENT_FIELDS_VIA_CUSTOMER_JOIN) or a customer-scoped cross-doc query — a dedicated plan for
 * any OTHER entity (documents/equipment/serviceVisits) is left untouched.
 */
// Fields that share ONE semantic "slot" for merge-dedup purposes even though they are different
// filter field names — a plan that already carries EITHER side of the pair has already fully
// resolved that condition (has/lacks, negation included), so the safety net's own (negation-blind)
// version of the same condition must never be added alongside it. Without this, "how many carrier
// customers have never had a preventive maintenance visit" — already correctly resolved by
// detectCustomersHasServiceType to lacksServiceType=PM — got a SECOND, contradictory
// hasServiceType=PM filter bolted on by the safety net's own 'serviceType' condition (which has no
// idea the dedicated detector already read the negation).
const MERGE_DEDUP_SLOT = {
  hasServiceType: 'serviceType', lacksServiceType: 'serviceType',
  hasDocType: 'docType', lacksDocType: 'docType',
};

function mergeDetectedConditions(plan, q) {
  if (!plan || plan.entity !== 'customers') return plan;
  const { filters: extra, unresolved } = buildSafetyNetFilters(q, plan.entity);
  if (unresolved) return null;
  if (!extra.length) return plan;
  const existingFields = new Set((plan.filters ?? []).map((f) => f.field));
  const existingSlots = new Set(
    (plan.filters ?? []).map((f) => MERGE_DEDUP_SLOT[f.field]).filter(Boolean)
  );
  const merged = [...(plan.filters ?? [])];
  for (const f of extra) {
    if (existingFields.has(f.field)) continue;
    if (MERGE_DEDUP_SLOT[f.field] && existingSlots.has(MERGE_DEDUP_SLOT[f.field])) continue;
    merged.push(f);
    existingFields.add(f.field);
  }
  return { ...plan, filters: merged };
}

/**
 * R18 P4 (C3, time-window drop): "how many units had their warranty expire in the past year" /
 * "any warranties expiring in the next 90 days" / "how many warranties expire by the end of this
 * calendar year" / "how many units warranty has expired so far this year" — a real calendar
 * WINDOW on the unit's own warranty.expires date, distinct from the fixed warrantyStatus bucket
 * (impliedWarrantyStatus, below — a fixed <=365-day-out slice) and unlike every other timeRange
 * consumer (documents/serviceVisits), never wired through plan.timeRange (equipment/warranties
 * questions never read plan.timeRange at all — see executeAnalyticsPlan, routes/analytics.js) —
 * this builds the concrete warrantyExpires filter bounds directly, reusing resolveAnyTimeRange
 * (the SAME central date-range parser reconcileTimeRange already applies to every other entity)
 * so a phrasing that function recognizes is honored here too, with no second date-math
 * implementation. Requires an explicit "expire(s)/expired" word (never a bare "under warranty" —
 * that's impliedWarrantyStatus's own, non-time-windowed territory) so this never fires for a
 * question that named no real window at all.
 */
const WARRANTY_EXPIRE_WORD_RE = /\bwarrant(?:y|ies)\b[\s\S]{0,20}\b(?:expir\w*|ends?|ending|lapse\w*|runs?\s+out)\b|\b(?:expir\w*|ends?|ending|lapse\w*)\b[\s\S]{0,20}\bwarrant(?:y|ies)\b/i;
// D4: "warranties that run through 2030" / "good until 2031" - the term runs to (at least) the end of that year.
const WARRANTY_RUN_THROUGH_RE = /\bwarrant(?:y|ies)\b[\s\S]{0,40}\b(?:run|runs|running|good|valid|active|covered|last|lasts|lasting)\s+(?:through|thru|until|till|to)\s+(?:the\s+end\s+of\s+)?((?:19|20|21)\d{2})\b/i;

// R21 (review fix): `today` was silently dropped here — every OTHER date-sensitive detector on the
// same `dedicated` chain below (detectInstallYearRelative, detectInstallDateRelativeRange) already
// threads the caller's own `today` through; this one fell back to the real wall clock regardless of
// what detectAnalyticsPlan was given, so a "since january 1st"/"by end of year"/"in the next 90 days"
// warranty-expiry window silently drifted a day (or a year, for the January-1st lower bound) out of
// sync with a pinned `today` — exactly the confident-wrong-date failure this file exists to prevent
// (routes/analytics.js passes its own `today` through to detectAnalyticsPlan for this very reason).
function detectWarrantyExpiryWindow(q, today) {
  const through = WARRANTY_RUN_THROUGH_RE.exec(q);
  if (through) return { entity: 'equipment', op: opFromShape(q), filters: [{ field: 'warrantyExpires', op: 'gte', value: `${through[1]}-12-31` }] };
  if (!WARRANTY_EXPIRE_WORD_RE.test(q)) return null;
  const range = resolveAnyTimeRange(q, today);
  if (!range) return null;
  const filters = [];
  if (range.from) filters.push({ field: 'warrantyExpires', op: 'gte', value: range.from });
  if (range.to) filters.push({ field: 'warrantyExpires', op: 'lte', value: range.to });
  if (!filters.length) return null;
  return { entity: 'equipment', op: opFromShape(q), filters };
}

const TON_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10 };
const TONNAGE_MENTION_RE = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|ten)[\s-]*(?:tons?|tonners?|tonnage)\b/gi;
/** Distinct tonnages named in the question as bare numbers ("3 ton", "two-ton", "5 tons"); [] when none. */
function detectTonnageMentions(q) {
  const out = new Set();
  for (const m of String(q).matchAll(TONNAGE_MENTION_RE)) {
    const raw = m[1].toLowerCase();
    const n = TON_WORDS[raw] ?? Number(raw);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out];
}

/** "how many different years do we have customers on file for" — a DISTINCT-year count over
 *  service_date records (extractions.field_key='service_date'), forced to entity 'serviceVisits'
 *  the same way detectTechnicianGroupBy/detectDistinctDimensionCount force an entity a bare noun
 *  reading would get wrong ("customers" is the earliest noun here, but there is no customer-level
 *  "year" column — the years on file are the service visits' own dates). `year` is a groupBy
 *  dimension keyOf/GROUP_BY_FIELDS (analytics.js/routes/analytics.js) derive from each visit's own
 *  month string, never a real stored column. */
const DIFFERENT_YEARS_RE = /\bhow many different years?\b|\bhow many years?\b[\s\S]{0,20}\bon file\b/i;

function detectDistinctYearsCount(q) {
  if (!DIFFERENT_YEARS_RE.test(q)) return null;
  return { entity: 'serviceVisits', op: 'groupBy', groupBy: 'year', countDistinct: true };
}

/* ============================================================ main entry point */

/**
 * `question` is already-normalized text (routes/analytics.js's
 * planAnalyticsQuestion calls this with the same `question_n` it would hand
 * the model) — lowercased, typo-corrected, abbreviation-expanded. Returns a
 * raw plan object (the same shape `toolUse?.input` has) or null. Never
 * throws.
 */
/**
 * Self-join "does this row duplicate another row" shapes ("duplicate
 * customers", "appear more than once", "share an address with another
 * customer", "used by more than one unit") — a real condition, but not one
 * any flat entity/op/groupBy/filter plan can express (it needs a GROUP BY …
 * HAVING count(*) > 1 over the SAME entity, not a filter value). No plan
 * feature for this exists yet; naming it here (rather than leaving it to
 * fall through the generic path below) matters because these questions are
 * often otherwise-bare existence/list shapes ("do we have any duplicate
 * customers?") that would, without this check, produce a confident but
 * WRONG plain count/existence plan.
 */
// Round 15 (A) regression guard: "are there any equipment serial numbers
// that appear under more than one customer" is the same self-join family as
// "used by more than one unit" just paired with a different noun
// (customer/account/property instead of unit) — round 15's own
// preClassifyAnalytics widening (existence-shaped questions) now lets this
// shape reach detectAnalyticsPlan at all, so it must be named here rather
// than silently falling into the generic bare-count path below.
const SELF_DUPLICATE_RE =
  /\b(duplicate\s+customers?|appear\s+more\s+than\s+once|share\s+an?\s+address|used\s+by\s+more\s+than\s+one\s+unit|more\s+than\s+once\s+in\s+our\s+records|appear\s+under\s+more\s+than\s+one|more\s+than\s+one\s+customer\b|under\s+more\s+than\s+one\s+(?:customer|account))\b/i;

/**
 * R18 (H1, breadth-data-quality-017/018/019/023): SELF_DUPLICATE_RE's own doc comment above says
 * "No plan feature for this exists yet" - that changed this round. isDuplicateName/sharesAddress/
 * isDuplicateSerial (analytics.js's DATA_QUALITY_FIELD_ENTITY) are computed exactly like the flat
 * count(*) > 1 self-join the comment describes, just via a cross-row frequency map attached to
 * every already-fetched row (routes/analytics.js's attachDuplicateFlag) instead of a SQL HAVING
 * clause - the executor never fetches a FILTERED set for an unrecognized boolean field (see
 * buildAnalyticsSQL's own doc comment), so every row for the entity is already there to compute
 * the frequency over. Three concrete, narrow mappings (never a generic catch-all) so a
 * duplicate-shaped question none of these three recognizes still falls through to
 * SELF_DUPLICATE_RE's honest decline below, exactly as before this round.
 */
const DUPLICATE_ADDRESS_RE = /\bshare\s+an?\s+address\b/i;
const DUPLICATE_SERIAL_RE =
  /\bserial\s+numbers?\b[\s\S]{0,40}\bmore\s+than\s+one\s+(?:unit|equipment)\b|\bused\s+by\s+more\s+than\s+one\s+unit\b|\bappear(?:s)?\s+under\s+more\s+than\s+one\s+(?:customer|account)\b|\bunder\s+more\s+than\s+one\s+(?:customer|account)\b/i;
const DUPLICATE_NAME_RE =
  /\bduplicate\s+customers?\b|\bappear(?:s)?\s+more\s+than\s+once(?:\s+in\s+our\s+records)?\b|\bcustomers?\b[\s\S]{0,20}\bmore\s+than\s+once\b/i;

function detectDuplicateCondition(q) {
  // Checked in this order (address / serial before the generic "name" one) so the address and
  // serial phrasings, which never mention "once", can't be shadowed by a broader name match — and
  // so they get their own field even though they also loosely fit "duplicate ... records".
  if (DUPLICATE_ADDRESS_RE.test(q)) {
    return { entity: 'customers', op: opFromShape(q), filters: [{ field: 'sharesAddress', op: 'eq', value: true }] };
  }
  if (DUPLICATE_SERIAL_RE.test(q)) {
    return { entity: 'equipment', op: opFromShape(q), filters: [{ field: 'isDuplicateSerial', op: 'eq', value: true }] };
  }
  if (DUPLICATE_NAME_RE.test(q)) {
    return { entity: 'customers', op: opFromShape(q), filters: [{ field: 'isDuplicateName', op: 'eq', value: true }] };
  }
  return null;
}

/** Content-search shapes ("did any jobs involve/mention X", symptom words) —
 *  the real distinguishing condition is free-text search inside a document/
 *  visit note, which this planner's closed filter vocabulary cannot express
 *  at all (there is no "notes contain X" FILTER_FIELD). Left unrecognized,
 *  the generic path below would otherwise happily return a bare, wrong,
 *  unfiltered entity count/list just because a "how many"/"which" quantifier
 *  is present — this must return null instead so the question falls through
 *  to a path that actually searches text (contentCount / the agent). */
const CONTENT_SEARCH_DENY_RE =
  /\b(mention|involv|complain|noisy|rattl|hum(?:m)?ing|freez\w*|crack\w*|leak\w*|smell\w*|smoke|burn(?:ed|ing)?|tripp?ed|breaker|error\s+code|symptom)/i;

/** Multi-hop / self-referential "connect" shapes (K4's territory, per the
 *  round contract) — a mismatch between two of a customer's OWN records, a
 *  value repeated across DIFFERENT customers, or a combination of a time
 *  condition with an absent-document condition that this flat plan vocabulary
 *  cannot express as a single filter. Must return null so these fall through
 *  to relations/decompose (or the agent) rather than being confidently
 *  mis-answered as a bare filtered count. */
// "march" here also means "match" — nlNormalize.js's own general fuzzy-typo
// corrector (VOCAB includes month names) silently mangles "doesn't match"
// into "doesn't march" (edit distance 1: t->r) before this ever runs, the
// exact same collision class as "older"->"order" (see resolveAgeFilter's own
// doc comment, analytics.js) — worked around locally here rather than in
// nlNormalize.js (outside this round's file ownership).
// R21 (M2): the standalone `no\s+warranty\s+registration` alternative that used to live here
// blocked EVERY "no warranty registration" question, including the plain, single-condition h052
// shape ("how many units have no warranty registration on file") that MISSING_FIELD_RULES below
// already has a real, correct answer for (warrantyRegistered:false) — a coverage regression this
// deny was never meant to cause. The genuine multi-hop shape this alternative existed for
// (breadth-connect-048..059: "installed more than 90 days ago ... with no warranty registration on
// file") is still denied regardless, via the OTHER `installed\s+more\s+than\s+\d+\s+days\s+ago`
// alternative just below, which every one of those questions also contains — so removing the
// standalone "no warranty registration" phrase costs that cluster nothing.
const CONNECT_DENY_RE =
  /\b(more than once|doesn'?t (?:match|march)|don'?t (?:match|march)|shared by|share[sd]?\s+an?\s+address|different address|address\s+mismatch|serial\s+numbers?\s+appear|quotes?d?\s+but\s+not\s+installed|replaced\s+more\s+than\s+once|installed\s+more\s+than\s+\d+\s+days\s+ago)\b|\bquotes?d?\b[\s\S]{0,60}\b(?:not\s+had|haven'?t\s+had|has\s+not\s+had|hasn'?t\s+had)\b[\s\S]{0,20}\binstalled\b/i;

// Round 15 follow-up (regression fix, breadth-connect-120): "how many
// maintenance agreements have zero service visits behind them" — a count of
// ONE entity (agreements) qualified by an EVENT COUNT on a DIFFERENT, related
// entity (service visits) being zero — is a join/HAVING-COUNT-0 shape this
// flat plan vocabulary has no field for at all, the same class of question
// CONNECT_DENY_RE already exists to decline. This used to reach here only
// through the financials money gate's own (over-broad) "agreement" match,
// which then escalated it to the real agent — narrowing that gate (this
// round's financials/classify.js hook) exposed it to this file directly,
// where the generic "how many <doc-type word>" path answered a bare,
// unqualified document count and silently dropped the "zero visits" half of
// the question entirely. Never a single-entity "no X on file" own-field
// check (those stay MISSING_FIELD_RULES' territory, below) — this is
// specifically an EVENT/VISIT noun from a DIFFERENT table being zero.
const ZERO_LINKED_EVENTS_RE =
  /\b(?:zero|no)\s+(?:service\s+)?(?:visits?|callbacks?|jobs?|invoices?|calls?|tickets?|work\s*orders?)\s+(?:behind\s+(?:them|it)|(?:since|after)\s+(?:install|installation|signup|purchase)|associated\s+with\s+(?:them|it)|to\s+(?:their|its)\s+name)\b/i;

/** A "follow-up" fragment referring back to a PREVIOUS turn's answer
 *  ("Expired warranties -- what about just the Mesa ones?") — this planner
 *  sees only the single question text, never prior conversation state, so it
 *  cannot know what "just the Mesa ones" is narrowing. Recognized by the
 *  em/en-dash (or " -- ") construct joining a topic fragment to a narrowing
 *  clause; returning null here (rather than guessing a plan from whichever
 *  noun happens to appear) is the same "never guess" rule as everywhere else
 *  in this file. */
const FOLLOW_UP_FRAGMENT_RE = /\s(?:--|—|-)\s.*\b(?:just|only|now)\b/i;

/** "no readable text extracted" — the one data-quality shape this file still
 *  declines: whether a document's OCR/facets pass ever produced any text at
 *  all has no reliable proxy in the closed plan vocabulary (the golden
 *  fixture's `facets` rows are not a signal this planner's tests can pin down
 *  either way — see the round 15 handoff), so this stays a deliberate
 *  fall-through rather than a guess dressed up as a filter. */
const READABLE_TEXT_DENY_RE = /\breadable text\b/i;

/**
 * R20 (J3, F6 "NEW this round" cluster): "how many open warranty claims do we have right now" /
 * "have we sent a renewal reminder on any of the maintenance agreements" — a warranty CLAIM and a
 * maintenance-agreement renewal REMINDER are business concepts this corpus never tracks at all (no
 * claim_number/claim_status/renewal_notice_sent field is ever extracted — see
 * extractFields.js/documentTypes.js's own field lists). Left unrecognized, the generic path below
 * would otherwise happily match "warranty"/"claims" to the bare warranties entity, or "maintenance
 * agreements" to a plain document-type count, and answer with total confidence (a portfolio-wide
 * unit/document count that has nothing to do with what was actually asked) — exactly the "answers a
 * business concept that was never recorded" failure mode this file's own header comment exists to
 * prevent. Denied at the TOP level, same as READABLE_TEXT_DENY_RE just above, so a miss here can
 * never fall through to a confident bare-count guess.
 */
const UNTRACKED_CONCEPT_DENY_RE = /\bwarranty\s+claims?\b|\brenewal\s+reminders?\b/i;

/**
 * Round 15 (A): "data-quality" / missing-field shapes — "documents aren't
 * linked to any customer", "customers have no documents on file", "no
 * service address on file", "missing a serial number", "no install date on
 * file", "don't have a model number recorded", "no tonnage on file", "no
 * warranty information at all", "units not linked to a customer", "install
 * date in the future", "documents classified as 'other'", "service documents
 * have no service date". Each maps to exactly one of analytics.js's
 * DATA_QUALITY_BOOLEAN_FIELDS (or, for "classified as other", a literal
 * documentType filter) — a closed, per-entity-restricted boolean vocabulary
 * validatePlan already enforces, so a rule below can never smuggle in a field
 * the executor doesn't actually know how to check. Every regex is anchored to
 * the CONDITION wording (never an exam id or exact sentence), so a paraphrase
 * ("units are missing a serial", "no serial on file") matches the same as the
 * canonical phrasing; a shape none of these recognizes falls through to
 * READABLE_TEXT_DENY_RE / the generic path / the model exactly as before.
 * `entity` here is fixed per rule (never entityFromNouns) because each field
 * only ever means one thing regardless of which noun the sentence happens to
 * lead with — see analytics.js's DATA_QUALITY_FIELD_ENTITY doc comment.
 */
const MISSING_FIELD_RULES = [
  // documents <-> customer link ("aren't linked", "missing a customer") — checked before the
  // customer-facing rules below so "documents missing a customer" never falls into hasAnyDocument.
  {
    entity: 'documents', field: 'hasCustomerLink', value: false,
    re: /\bdocuments?\b[\s\S]{0,30}\b(?:aren'?t|are\s+not|is\s+not|isn'?t|not)\s+linked(?:\s+to)?\s+(?:any\s+)?customers?\b|\bdocuments?\b[\s\S]{0,20}\bmissing\s+a\s+customer\b/i,
  },
  {
    // R20 (J3, i029): "zero documents of any kind on file" — the same condition as "no documents on
    // file", just with "zero"/"not a single" for "no" and an optional "of any kind" qualifier an
    // owner adds for emphasis, never a different field.
    entity: 'customers', field: 'hasAnyDocument', value: false,
    re: /\bcustomers?\b[\s\S]{0,25}\b(?:no|zero|not\s+a\s+single)\s+documents?\s+(?:of\s+any\s+kind\s+)?on\s+file\b|\bcustomers?\b[\s\S]{0,25}\b(?:don'?t|do\s+not)\s+have\s+(?:any\s+)?documents?\s+(?:of\s+any\s+kind\s+)?on\s+file\b/i,
  },
  {
    entity: 'customers', field: 'hasServiceAddress', value: false,
    re: /\bno\s+service\s+address\s+on\s+file\b|\bmissing\s+a\s+service\s+address\b/i,
  },
  {
    entity: 'customers', field: 'hasZip', value: false,
    re: /\baddress(?:es)?\b[\s\S]{0,20}\bmissing\s+a?\s*zip\s*codes?\b|\bno\s+zip\s*codes?\s+on\s+file\b/i,
  },
  {
    entity: 'equipment', field: 'hasSerial', value: false,
    re: /\bmissing\s+a?\s*serial\s*(?:numbers?)?\b|\bno\s+serial\s*(?:numbers?)?\s+on\s+file\b/i,
  },
  {
    entity: 'equipment', field: 'hasInstallDate', value: false,
    re: /\bno\s+install(?:ation)?\s+dates?\s+on\s+file\b|\bmissing\s+a?n?\s*install(?:ation)?\s+date\b/i,
  },
  {
    entity: 'equipment', field: 'hasModel', value: false,
    re: /\b(?:don'?t|doesn'?t|do\s+not|does\s+not)\s+have\s+a?\s*model\s*(?:numbers?)?\s*(?:recorded)?\b|\bno\s+model\s*(?:numbers?)?\s+(?:recorded|on\s+file)\b|\bmissing\s+a?\s*model\s*(?:numbers?)?\b/i,
  },
  {
    // R18 P4 (blind generalization round 18 part 2, h128): "how many units have no tonnage
    // listed" — the same condition as "no tonnage on file", just a paraphrase ("listed" for "on
    // file") this regex didn't cover yet.
    entity: 'equipment', field: 'hasTonnage', value: false,
    re: /\bno\s+tonnage\s+(?:on\s+file|listed)\b|\bmissing\s+(?:a\s+|the\s+)?tonnage\b|\btonnage\s+(?:is\s+)?(?:not\s+listed|missing)\b/i,
  },
  {
    // R20 (J3, i009) + R21 (M2, h052): "how many warranty registrations are we still missing" /
    // "how many units have NO warranty registration on file" / "don't have a warranty registration
    // on file" — registrationState !== 'on_file'. Checked BEFORE the positive `warrantyRegistered:
    // true` rule just below (not merely as a negation of it) specifically because that rule's own
    // phrase ("warranty registration ... on file") is a plain substring of "no warranty registration
    // on file" too — h052 used to reach the POSITIVE rule first, match that substring, and (since
    // hasNearbyNegation only recognizes "not/never/without", never a bare "no") answer the exact
    // opposite of what was asked. Putting this rule first means a "no.../missing.../don't have..."
    // question is fully resolved here and never even reaches the positive rule's regex.
    entity: 'equipment', field: 'warrantyRegistered', value: false,
    re: /\bwarranty\s+registrations?\b[\s\S]{0,25}\b(?:missing|outstanding|(?:haven'?t|have\s+not)\s+(?:done|completed|filed|submitted))\b|\bmissing\b[\s\S]{0,20}\bwarranty\s+registrations?\b|\bno\s+warranty\s+registrations?\s+(?:on\s+file|recorded|on\s+record)\b|\b(?:don'?t|do\s+not|doesn'?t|does\s+not)\s+have\s+(?:a\s+|any\s+)?warranty\s+registrations?\b/i,
  },
  {
    // R18 P4 (h053): "how many units are actually registered for warranty" — data.warranty.
    // registrationState === 'on_file' (see WARRANTY_REGISTERED_ROW_KEY, routes/analytics.js),
    // never the warrantyStatus coverage bucket (a unit can be registered AND expired, or
    // unregistered AND still active — the two are independent facts). Never matches a "no .../
    // missing .../don't have..." sentence — the false-value rule just above already claimed every
    // one of those phrasings and returns before this rule is even tried.
    entity: 'equipment', field: 'warrantyRegistered', value: true,
    re: /\b(?:actually\s+)?registered\s+for\s+warranty\b|\bwarranty\s+registration\s+(?:is\s+)?on\s+file\b/i,
  },
  {
    // R18 P4 (C4, negation, h134): "how many customers have zero equipment on file" — the
    // customers-side mirror of hasAnyDocument.
    entity: 'customers', field: 'hasAnyEquipment', value: false,
    re: /\bzero\s+equipment\s+on\s+file\b|\bno\s+equipment\s+on\s+file\b|\b(?:don'?t|do\s+not)\s+have\s+(?:any\s+)?equipment\b/i,
  },
  // "no warranty information AT ALL" -> warrantyStatus 'unknown', not a new
  // hasWarrantyInfo boolean: deriveWarranty (warrantyRules.js) always writes
  // a non-empty "stable" object onto every unit (registrationOnFile: null,
  // registrationState: 'unknown', ... even when nothing was ever extracted),
  // so "the warranty column is a non-empty object" is true for every unit
  // and can never distinguish real data from none at all. warrantyStatusOf
  // already resolves exactly this case to 'unknown' (alertTier returns
  // 'unknown' whenever there's no expiry date to compute from) — the same
  // bucket warrantyStatusFromQuestion/impliedWarrantyStatus already answer
  // for a "warranty status unknown" phrasing, just reached by a wording
  // (WARRANTY_STATUS_WORD_RE has no "no ... information" phrase) that
  // function doesn't itself recognize.
  {
    entity: 'equipment', field: 'warrantyStatus', value: 'unknown',
    re: /\bno\s+warranty\s+information\b|\bmissing\s+(?:all\s+)?warranty\s+information\b/i,
  },
  {
    entity: 'equipment', field: 'hasCustomerLink', value: false,
    re: /\b(?:units?|equipment)\b[\s\S]{0,30}\b(?:aren'?t|are\s+not|is\s+not|isn'?t|not)\s+linked(?:\s+to)?\s+(?:a\s+)?customers?\b/i,
  },
  {
    entity: 'equipment', field: 'installDateInFuture', value: true,
    re: /\binstall(?:ation)?\s+dates?\s+(?:that\s+are\s+|is\s+|are\s+)?in\s+the\s+future\b/i,
  },
];

/** "SERVICE documents" (as opposed to a permit/photo/proposal/registration/
 *  agreement/correspondence/shop-internal record) — the canonical document
 *  types that name an actual visit or job, the general business-paperwork
 *  category a dispatcher means by that word, never a specific exam id/text.
 *  Every other document type (permit, nameplate-photo, proposal-quote,
 *  warranty-registration, maintenance-agreement, purchase-order,
 *  equipment-record, correspondence, internal) is paperwork ABOUT a unit or
 *  account, not a record of doing the work itself. */
const SERVICE_DOCUMENT_TYPES = [
  'service-ticket', 'service-report', 'work-order', 'dispatch-note', 'inspection-report', 'startup-sheet', 'invoice',
];
const SERVICE_DOCUMENTS_RE = /\bservice\s+documents?\b/i;

{
  const noServiceDateRe = /\bno\s+service\s+dates?\b/i;
  MISSING_FIELD_RULES.push({
    entity: 'documents', field: 'hasServiceDate', value: false,
    re: noServiceDateRe,
    // "SERVICE documents have no service date" additionally narrows to the
    // SERVICE_DOCUMENT_TYPES set above — a bare "documents have no service
    // date" (no "service" qualifier) stays a plain documents-wide check.
    extraFilters: (q) => (SERVICE_DOCUMENTS_RE.test(q) ? [{ field: 'documentType', op: 'in', value: SERVICE_DOCUMENT_TYPES }] : []),
  });
}

/** "documents classified as 'other' instead of a real type" — a literal
 *  documentType filter, never docTypeFromWord (the word "other" names no
 *  business document type and so is deliberately absent from
 *  DOCUMENT_TYPE_SYNONYMS/docTypeSynonymAlternation — it's the catch-all
 *  DOCUMENT_TYPE_IDS member every unclassified/legacy value normalizes to,
 *  see documentTypes.js's normalizeDocumentType). */
const DOC_TYPE_OTHER_RE = /\bclassified\s+as\s+['"]?other['"]?\b/i;

/** Review fix (R15 blocking defect): every MISSING_FIELD_RULES regex bakes its
 *  own negation word ("no", "missing", "isn't linked", ...) directly into the
 *  shape it matches, but none of them guard against a FURTHER negation
 *  immediately in front of that match — "which units are NOT missing a
 *  serial number" (== HAS a serial number, the opposite of what the rule's
 *  own `value` asserts) still matches "missing a serial number" as a plain
 *  substring and silently produced the confidently wrong count (0, the same
 *  as "which units ARE missing a serial number"). Rather than re-derive the
 *  double-negated meaning here (risking a different confident-wrong shape),
 *  bail this rule entirely when a negation word sits within a few words
 *  immediately before its own match — the contract's own rule for exactly
 *  this situation: "return null (fall through) when unsure". A small
 *  trailing-word window (rather than requiring strict adjacency) also
 *  catches "don't have a missing install date" (negation separated from
 *  "missing" by a filler verb/article), while staying short enough that an
 *  unrelated "not" much earlier in the sentence ("he did not install it
 *  himself, but it's missing a serial number") never suppresses a real
 *  match. */
function hasNearbyNegation(before, maxWords = 4) {
  const words = before.trim().split(/\s+/).filter(Boolean).slice(-maxWords);
  return words.some((w) => /^(?:not|never|without)$/i.test(w) || /n't$/i.test(w));
}

// R21 (M2, regression guard for h129): "which manufacturer has the most units with no warranty
// registration on file" names a MISSING_FIELD_RULES condition (no warranty registration) but is
// really asking for the one extreme GROUP under that condition (a groupBy+superlative shape, "which
// <dim> has the most/fewest ..."), never a bare portfolio-wide count of it. Narrowing CONNECT_DENY_RE
// above (h052/j072) now lets this reach detectMissingFieldCondition before the dedicated groupBy/
// superlative detectors ever get a turn — bailing here (rather than silently answering the bare
// count and dropping the ranking half of the question) keeps this exactly as it measured before that
// change (falls through, same as any shape no detector here confidently resolves) rather than
// making it newly, confidently wrong.
const GROUPBY_SUPERLATIVE_SHAPE_RE = new RegExp(
  `\\bwhich\\s+(?:${DIM_ALT})\\b[\\s\\S]{0,40}\\b(?:most|fewest|least|biggest|largest|smallest|highest|lowest)\\b`,
  'i'
);

function detectMissingFieldCondition(q) {
  if (READABLE_TEXT_DENY_RE.test(q)) return null;
  if (GROUPBY_SUPERLATIVE_SHAPE_RE.test(q)) return null;
  for (const rule of MISSING_FIELD_RULES) {
    const m = rule.re.exec(q);
    if (m) {
      if (hasNearbyNegation(q.slice(0, m.index))) return null;
      const extra = typeof rule.extraFilters === 'function' ? rule.extraFilters(q) : [];
      return { entity: rule.entity, op: 'count', filters: [{ field: rule.field, op: 'eq', value: rule.value }, ...extra] };
    }
  }
  if (DOC_TYPE_OTHER_RE.test(q)) {
    return { entity: 'documents', op: 'count', filters: [{ field: 'documentType', op: 'eq', value: 'other' }] };
  }
  return null;
}

/**
 * Round 15 follow-up (P0, generalization audit): a central, tenantVocab-aware
 * backstop — never a substitute for the shape-based exclusions above (those
 * still run first and cost nothing), but a last line of defense for a named-
 * customer/business shape this file's own regex bank does not yet recognize
 * at all. NONE of the plans this file ever builds carries a `customerName`
 * filter (that field only ever gets filled by the MODEL path, which has
 * schema-linked vocabulary to work from) — so if this tenant's own name
 * glossary says the question names one of ITS customers by (close to) full
 * name, no plan built here could ever actually be scoped to that customer,
 * and answering with a tenant-wide aggregate instead would be exactly the
 * "confident wrong answer" this whole file exists to avoid. Bail (null) and
 * let the caller fall through to the model, which DOES have the vocabulary
 * to build a correctly-scoped `customerName` filter. Whole-phrase,
 * word-boundary match only (never a bare short word — "Wood" the customer
 * must not false-positive on every mention of the material) and skipped
 * entirely when no tenantVocab was supplied (every existing caller/test that
 * never threads it through keeps its exact current behavior).
 */
function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function questionNamesKnownCustomer(q, tenantVocab) {
  const phrases = tenantVocab?.customers?.phrases;
  if (!Array.isArray(phrases) || !phrases.length) return false;
  for (const raw of phrases) {
    const name = String(raw ?? '').trim();
    // A single short/common word ("Wood", "Ace") is too weak a signal on its
    // own to bail an otherwise-confident aggregate plan over; a real full
    // name always has at least two words or one longer than a short surname.
    if (name.length < 4 || (!/\s/.test(name) && name.length < 6)) continue;
    const pattern = name.split(/\s+/).map(escapeRegExp).join('\\s+');
    if (new RegExp(`\\b${pattern}\\b`, 'i').test(q)) return true;
  }
  return false;
}

/** R35 adversarial pass: an unfiltered whole-table LIST is never the answer to a superlative / ranking question ("which brand has the most
 *  repairs" was answered "120 customers.") — the ranking dimension was dropped, so the plan is refused and the question goes on. */
const SUPERLATIVE_RE = /\b(?:most|least|fewest|highest|lowest|top|best|worst|biggest|smallest)\b/i;
export function detectAnalyticsPlan(question, tenantVocab, today) {
  const plan = detectAnalyticsPlanInner(question, tenantVocab, today);
  const bare = plan && plan.op === 'list' && plan.entity === 'customers' && !(plan.filters ?? []).length && Object.keys(plan).every((k) => k === 'entity' || k === 'op' || k === 'filters');
  if (bare && SUPERLATIVE_RE.test(String(question ?? ''))) return null;
  return plan;
}

function detectAnalyticsPlanInner(question, tenantVocab, today) {
  try {
    const q = String(question ?? '').trim();
    if (!q) return null;
    if (tenantVocab && questionNamesKnownCustomer(q, tenantVocab)) return null;
    // R18 (H1): checked BEFORE the generic SELF_DUPLICATE_RE decline just below — see
    // detectDuplicateCondition's own doc comment for why this specific family can now be answered.
    const dup = detectDuplicateCondition(q);
    if (dup) return dup;
    if (SELF_DUPLICATE_RE.test(q)) return null;
    if (CONTENT_SEARCH_DENY_RE.test(q)) return null;
    // R35 adversarial pass: a registration condition ANDed onto a warranty status ("covered by warranty but not registered") has no filter
    // here; never answered as the bare warranty count.
    if (REGISTRATION_CONJUNCT_RE.test(q)) return null;
    if (CONNECT_DENY_RE.test(q)) return null;
    if (ZERO_LINKED_EVENTS_RE.test(q)) return null;
    if (FOLLOW_UP_FRAGMENT_RE.test(q)) return null;
    // "no readable text extracted" — see READABLE_TEXT_DENY_RE's own doc
    // comment. Denied at the TOP level (not just inside
    // detectMissingFieldCondition) so a miss here never falls through to the
    // generic bare-quantifier path below and answers a bare, unfiltered
    // "how many documents" instead — a confident wrong answer, the one
    // outcome this whole file exists to avoid.
    if (READABLE_TEXT_DENY_RE.test(q)) return null;
    // F6 (warranty "claim" / renewal "reminder") — see UNTRACKED_CONCEPT_DENY_RE's own doc comment.
    if (UNTRACKED_CONCEPT_DENY_RE.test(q)) return null;

    // ---- dedicated shapes, most specific first --------------------------
    // D4: an agreement END year must be recognised before the cross-document ("customers with a maintenance agreement") and
    // missing-field detectors, which would otherwise read "maintenance contracts ... 2031" as a customer count in that year.
    const agreementEnd = detectAgreementEnd(q);
    if (agreementEnd) return agreementEnd;
    const permitFilters = detectPermitFilters(q);
    if (permitFilters === PERMIT_BAIL) return null;
    if (permitFilters) return permitFilters;
    const missingField = detectMissingFieldCondition(q);
    if (missingField) return missingField;
    const lockedDocType = detectLockedIntoDocType(q);
    if (lockedDocType) return lockedDocType;

    // R18 P4 (multi-hop AND-drop): mergeDetectedConditions is ONLY applied to the two cross-doc
    // customer detectors (hasDocType/hasServiceType) below, whose whole job is "count customers with
    // THIS condition" and so are exactly the shape a second, brand/geo/contact-info condition rides
    // along with unnoticed (h090, h099-h105) — every OTHER dedicated detector (groupBy, distinct-count,
    // technician, install-date ranking, brand comparison) has its own complete, self-contained filter
    // semantics, and merging arbitrary safety-net filters into those risks a false "unresolved" bail
    // the moment the question merely mentions a safety-net keyword (county/zip/city/state) with no
    // extractable value of its own — e.g. "customers by county" (a groupBy, no county NAMED) or "how
    // many different zip codes do we cover" (a distinct-count, no zip NAMED) used to come back null
    // because buildConditionOverrideFilter('zip'|'county', ...) has nothing to build and reports
    // unresolved. Keep those detectors' results exactly as they build them.
    // R21 M2 (deferred list, Cluster 1/C1 — 22 ids): checked BEFORE crossDocDedicated just below —
    // "how many <brand> units/systems/customers in <city> have had/needed a <service-type> since
    // <time>" always resolves to the SAME oracle-defined equipment count regardless of the
    // question's own noun ("units"/"systems"/"customers" all count identically — see
    // detectBrandCityServiceTypeSince's own doc comment), so a "customers"-worded id among the 22
    // (j007/j011/j015/j021/j028/j031/j034) must never fall to detectCustomersHasServiceType's own
    // entity:'customers' plan first — that plan can never express the brand+city+time AND this
    // shape needs all at once.
    const brandCityServiceType = detectBrandCityServiceTypeSince(q, today);
    if (brandCityServiceType) return brandCityServiceType;

    const crossDocDedicated = detectCustomersHasDocType(q) ?? detectCustomersHasServiceType(q);
    if (crossDocDedicated) return mergeDetectedConditions(crossDocDedicated, q);

    const dedicated =
      detectWarrantyExpiryWindow(q, today) ??
      detectWarrantyRegistrationDays(q) ??
      detectDistinctYearsCount(q) ??
      detectTechnicianHeadToHead(q) ??
      detectTechnicianAction(q) ??
      detectTechnicianGroupBy(q) ??
      detectWarrantyRegDateExtreme(q) ??
      detectInstallDateExtreme(q) ??
      detectInstallYearRelative(q, today) ??
      detectInstallDateRelativeRange(q, today) ??
      detectMultiUnitCustomers(q) ??
      detectVendorPurchaseOrderCount(q) ??
      detectBrandJobsDocumentCount(q) ??
      detectDistinctDimensionCount(q) ??
      detectGroupBySuperlative(q) ??
      // R23 (D2): tried AFTER detectGroupBySuperlative — "which manufacturer do we have the
      // FEWEST units of" (h113) must keep winning that ranking, never fall to a plain distinct
      // list just because it also happens to name "which manufacturer ... do we have".
      detectBareDimensionDistinctCount(q) ??
      detectDistinctDimensionList(q) ??
      detectBrandComparison(q) ??
      detectGroupByPhrase(q);
    if (dedicated) return dedicated;

    // ---- generic entity/op/filter path -----------------------------------
    let entity = entityFromNouns(q);
    const op = opFromShape(q);
    const { filters, unresolved } = buildSafetyNetFilters(q, entity);
    if (unresolved) return null;
    // D9: "how many customers are out of state" names no state, so nothing built a filter and the count was every customer. "Out of state" is
    // relative to the shop's home state, which only the executor can resolve from the customer list (routes/analytics.js, OUT_OF_STATE_HOME).
    // Only the customer list is answered here; a units/documents/visits question would get a customer count, so that plan bails to the next lane instead.
    if (OUT_OF_STATE_RE.test(q) && !filters.some((f) => f.field === 'state')) {
      if (entity !== 'customers') return null;
      filters.push({ field: 'state', op: 'neq', value: 'HOME' });
    }

    // R18 P4 (C2, multi-hop AND-drop): captured BEFORE the entity is possibly forced to
    // 'customers' just below, and used for every equipment-level condition after that point —
    // "how many trane units in mesa are still under warranty" (h091) used to force entity to
    // 'customers' (for the geo join) and then check `entity === 'equipment'` for the
    // installYear/warrantyStatus/refrigerant conditions right after, so none of them were ever
    // applied once the geo filter was present — the SAME "warrantyStatus" the question plainly
    // named silently vanished. queryCustomersByEquipmentFilter (routes/analytics.js) already joins
    // in every one of these equipment-level filters when they ride along with a customers-entity
    // plan, so building them is always safe regardless of which entity ends up on the final plan.
    const equipmentLike = entity === 'equipment' || entity === 'warranties';
    // impliedWarrantyStatus's own "relaxed" fallback (no literal "warrant" word at all — "units
    // expiring soon") is only meaningful for the unit's OWN entity, never the customers entity a
    // geo join may force `entity` to just below — captured here, before that reassignment.
    const warrantyStatusEntity = entity;

    // Equipment/warranties rows carry NO address of their own in this corpus
    // (only the CUSTOMER row does) — a geo filter (city/county/state/zip) can
    // only ever be resolved by joining back to the customer, so force the
    // entity to 'customers' whenever one is present; queryCustomersByEquipmentFilter
    // (routes/analytics.js) already joins in any equipment-level filters
    // (brand/warrantyStatus/installYear/...) that ride along with it.
    if (
      equipmentLike &&
      filters.some((f) => f.field === 'city' || f.field === 'county' || f.field === 'state' || f.field === 'zip')
    ) {
      entity = 'customers';
    }

    if (entity === 'documents') {
      const m = DOC_TYPE_WORD_RE.exec(q);
      if (m) {
        const docType = docTypeFromWord(m[1]);
        if (docType) filters.push({ field: 'documentType', op: 'eq', value: docType });
      }
    }

    // "how many Trane installs have we done SINCE 2020" — a literal 4-digit
    // year named on an equipment/install question means the INSTALL year cutoff,
    // never a document/visit created_at range (equipment has no created_at
    // concept in this domain) — resolveAgeFilter (analytics.js) only ever
    // parses "older/newer than N years", never a literal calendar year, so
    // this is this file's own job to build.
    if (equipmentLike && !filters.some((f) => f.field === 'installYear')) {
      const sm = SINCE_YEAR_RE.exec(q);
      if (sm) filters.push({ field: 'installYear', op: 'gte', value: Number(sm[1]) });
    }

    if (entity === 'customers' && NO_CONTACT_INFO_RE.test(q)) {
      if (!filters.some((f) => f.field === 'hasEmail')) filters.push({ field: 'hasEmail', op: 'eq', value: false });
      if (!filters.some((f) => f.field === 'hasPhone')) filters.push({ field: 'hasPhone', op: 'eq', value: false });
    }

    // warrantyStatus (equipment/warranties only — analytics.js's
    // detectedConditions/buildConditionOverrideFilter('warranty', ...) already
    // covers this via the safety-net loop above for ANY entity, but harmless
    // to be explicit and it saves a round trip through missingConditions for
    // the common "how many units are out of warranty" shape.
    if (equipmentLike && !filters.some((f) => f.field === 'warrantyStatus')) {
      const status = impliedWarrantyStatus(q, warrantyStatusEntity);
      if (status === WARRANTY_STATUS_AMBIGUOUS) return null; // never guess which bucket a negation meant
      if (status) filters.push({ field: 'warrantyStatus', op: 'eq', value: status });
    }

    // Refrigerant: named right in the question ("runs on R-22") but NOT one
    // of the safety-net conditions (CONDITION_PLAN_FIELD, analytics.js, has
    // no entry for it) — unlike those, a refrigerant mention this file fails
    // to turn into a filter is never silently dropped: better to fall
    // through to the model than confidently count every unit when the
    // question named one specific refrigerant.
    if (equipmentLike && detectRefrigerantMention(q)) {
      const rf = buildRefrigerantFilter(q);
      if (!rf) return null;
      if (!filters.some((f) => f.field === 'refrigerant')) filters.push(rf);
    }

    // R34: "how many 3 ton units" / "how many two-ton Trane units" / "units that are 5 tons" - a nameplate TONNAGE is a real unit
    // attribute (FILTER_FIELDS 'tonnage'; stored as "3 ton") that nothing built a filter for, so the count came back as every unit
    // ("You have 132 pieces of equipment."). Applied to units, or to customers via their units; anywhere else a named tonnage cannot be
    // honoured, so the plan is declined (falls through) rather than answered without it.
    {
      const tons = detectTonnageMentions(q);
      if (tons.length) {
        if (tons.length > 1 || !(equipmentLike || entity === 'customers')) return null;
        if (!filters.some((f) => f.field === 'tonnage')) filters.push({ field: 'tonnage', op: 'eq', value: `${tons[0]} ton` });
      }
    }

    // A bare noun phrase with NOTHING recognized at all (no filter, no
    // "how many"/list-verb/existence quantifier) is too weak a signal to
    // trust — e.g. a stray "customers" mention inside a sentence this file
    // misparsed. isExistenceQuestion (analytics.js) is the same "do/does/is/
    // are/did/have/has we/there/you/our shop" shape preClassifyAnalytics's
    // own WE_YES_NO_RE and applyExistenceShape already treat as a real
    // quantifier ("do we have any Ruud units", "did we do any service calls
    // last month").
    const hasQuantifier = HOW_MANY_RE.test(q) || LIST_VERB_RE.test(q) || isExistenceQuestion(q);
    if (!filters.length && !hasQuantifier) return null;

    return { entity, op, filters };
  } catch {
    return null;
  }
}
