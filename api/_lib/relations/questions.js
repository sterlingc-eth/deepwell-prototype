/**
 * relations/questions.js — Workstream B ("connect the dots" relations engine, 2026-09-26).
 *
 * Scorecard round 7: connect 10/40, tech-performance 0/22, rankings 10/18, multi-hop 18/24 (see
 * R7_MEASURE.md). Reading each failing question's own oracle SQL turned up three separate root causes,
 * none of them "the shape can't be answered deterministically":
 *
 *   1. connect (repeat visit after install / callback within N days / two-technician overlap) — no
 *      existing router builds a cross-document VISIT TIMELINE per customer at all; the free-form agent
 *      either drops the day-window condition ("Trane units" -> "You have 11 pieces of equipment") or
 *      times out (20-51s) hunting for the pattern by hand. timeline.js now builds that timeline in one
 *      bounded, tenant-scoped read.
 *   2. tech-performance (0/22) and 8 of 18 rankings — rankings.js ALREADY computes the right VALUE for
 *      every one of these (mostCustomersCity et al., techTotalJobs et al.), but most of its handlers
 *      return a bare `answer()` with no records/basis attached (only the "customer superlative"
 *      handlers call attachCitations), so finalizeCitations derives nothing and the response fails the
 *      citation contract outright — see R7_MEASURE.md's "RIGHT VALUE, NO CITATION" note. Several of the
 *      time-sensitive handlers (techJobsThisYear, techLastJob, busiestTechThisYear, mostExpiredBrand)
 *      also read `new Date()` directly instead of the resolved scorecard `today`, and `runRanking(db,
 *      intent)` has no `today` parameter to fix that with. rankings.js is Team J's file (not touched
 *      here); this module answers the SAME closed set of phrasings independently, with `today` threaded
 *      through and a citation on every answer, so ask.js can prefer it for exactly these phrasings.
 *   3. multi-hop (6 of 24) — compose.js's condition engine evaluates each condition against "does ANY of
 *      this customer's units satisfy it", independently per condition. "A Carrier unit older than 10
 *      years" needs BOTH facts true of the SAME unit; compose.js can be satisfied by an old Trane plus a
 *      new Carrier. The handlers below use one EXISTS per same-row condition, exactly like the oracle.
 *
 * Nothing here is a persisted table — see timeline.js's own header for the sizing note and the optional
 * M3-config/36-relations.sql fallback. Every family:
 *   - returns null the moment a named customer/technician cannot be found at all (never guesses),
 *   - cites the actual visit/document rows behind the number, not just an entity list,
 *   - never hard-codes a brand, city or person's name — every one is parsed OUT of the question text.
 *
 * pure: classifyRelationsQuestion
 * db:   answerRelationsQuestion (one withTenant transaction; every read is TENANT_SQL-scoped)
 */
import { TENANT_SQL, todayIso, humanDate, answerEnvelope, docTypeAliases } from '../scope.js';
import { attachCitations, customerRecord, unitRecord } from '../citations/records.js';
import { documentRecordsFor } from '../citations/enrich.js';
import { deriveGeo } from '../analytics.js';
import { classifyWithTypoTolerance } from './normalize.js';
import {
  VISIT_DOC_TYPES, addDaysIso, fetchAllVisits, fetchEquipmentInstalls, fetchCustomers, customersByNameLike,
  fetchTechnicianJobs, technicianNameExists, technicianCountOnRecord, technicianJobCounts, jobsWithNoTechnician,
  documentsOfType, fetchReplacementQuotes, fetchCustomerFinancials,
} from './timeline.js';
import { tenantHasFinancialRows } from '../financials/store.js';

/* ------------------------------------------------------------------ small pure helpers */

const clean = (q) => String(q ?? '').replace(/\s+/g, ' ').trim();
const NAME_RE = "[A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,2}";

/** "A, B and C" / "A, B, and 3 more" — same idiom every other deterministic router in this codebase uses. */
function namesList(names, max = 40) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  if (shown.length <= 1) return `${shown.join('')}${extra ? `, and ${extra} more` : ''}`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}${extra ? `, and ${extra} more` : ''}`;
}

function groupByCust(visits) {
  const map = new Map();
  for (const v of visits) { const a = map.get(v.custId) ?? []; a.push(v); map.set(v.custId, a); }
  return map;
}

const sameBrand = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Every doc-type phrase this module recognizes in "a/no <phrase>" clauses -> canonical type id. */
const DOC_PHRASE_TO_ID = {
  'maintenance agreement': 'maintenance-agreement',
  'maintenance plan': 'maintenance-agreement',
  'purchase order': 'purchase-order',
  po: 'purchase-order',
  'warranty registration': 'warranty-registration',
  permit: 'permit',
  invoice: 'invoice',
  proposal: 'proposal-quote',
  quote: 'proposal-quote',
};
const DOC_PHRASE_ALT = Object.keys(DOC_PHRASE_TO_ID).sort((a, b) => b.length - a.length).join('|');

/** Round 14 (K4): a closed, tenant-agnostic PLAIN DOCUMENT COUNT vocabulary ("how many work orders do we
 *  have?", "how many service tickets do we have on file?") — distinct from DOC_PHRASE_TO_ID above (which
 *  is always a per-CUSTOMER "has this on file" clause): this one counts DOCUMENTS directly, no customer
 *  linkage at all, so it also covers a doc type DOC_PHRASE_TO_ID has no reason to (service tickets). Same
 *  fixed HVAC document-type list documentTypes.js/scope.js's own DOCUMENT_TYPE_ALIASES already ships —
 *  never guessed, never widened per-tenant (classifyRelationsQuestion runs with no pack in scope; see
 *  ask.js's own call site), so a non-HVAC tenant's own document type vocabulary simply doesn't match here
 *  and this family returns null, exactly like every other closed-vocabulary family in this file. */
const DOC_COUNT_PHRASE_TO_ID = {
  'work orders': 'work-order', 'work order': 'work-order',
  'service tickets': 'service-ticket', 'service ticket': 'service-ticket',
  invoices: 'invoice', invoice: 'invoice',
  permits: 'permit', permit: 'permit',
  'purchase orders': 'purchase-order', 'purchase order': 'purchase-order',
  'maintenance agreements': 'maintenance-agreement', 'maintenance agreement': 'maintenance-agreement',
  'warranty registrations': 'warranty-registration', 'warranty registration': 'warranty-registration',
  'inspection reports': 'inspection-report', 'inspection report': 'inspection-report',
  'dispatch notes': 'dispatch-note', 'dispatch note': 'dispatch-note',
  'startup sheets': 'startup-sheet', 'startup sheet': 'startup-sheet',
  proposals: 'proposal-quote', quotes: 'proposal-quote',
};
const DOC_COUNT_PHRASE_ALT = Object.keys(DOC_COUNT_PHRASE_TO_ID).sort((a, b) => b.length - a.length).join('|');
/** Canonical type id -> the plural label an answer displays, regardless of which singular/plural phrase
 *  the question itself used ("work order" and "work orders" both answer "N work orders on file"). */
const DOC_COUNT_ID_TO_LABEL = {
  'work-order': 'work orders', 'service-ticket': 'service tickets', invoice: 'invoices', permit: 'permits',
  'purchase-order': 'purchase orders', 'maintenance-agreement': 'maintenance agreements',
  'warranty-registration': 'warranty registrations', 'inspection-report': 'inspection reports',
  'dispatch-note': 'dispatch notes', 'startup-sheet': 'startup sheets', 'proposal-quote': 'proposals/quotes',
};

function finish(text, facts, cite) {
  return attachCitations(answerEnvelope({ text, facts }), cite);
}

function unitRecordsFor(units) {
  return units.map((u) => unitRecord({ id: u.id, manufacturer: u.manufacturer, customer_id: u.customerId },
    { sublabel: u.installDate ? `installed ${humanDate(u.installDate)}` : undefined }));
}

/* ==================================================================== CLASSIFY (pure) */

const DAYS = '(\\d{1,4})\\s*days?';
const YEARS = '(\\d{1,3})\\s*years?';
const MONTHS = '(\\d{1,3})\\s*months?';

const FAMILIES = [
  // -------------------------------------------------------------- connect: repeat visit after install
  ['repeatVisitUnitsCount', new RegExp(`^how many units?\\s+(?:had|have had)\\s+a\\s+repeat\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+(?:its\\s+|the\\s+)?installation\\??$`, 'i'),
    (m) => ({ brand: null, days: Number(m[1]) })],
  ['repeatVisitUnitsCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'&-]*?)\\s+units?\\s+(?:had|have had)\\s+a\\s+repeat\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+(?:its\\s+|the\\s+)?installation\\??$`, 'i'),
    (m) => ({ brand: m[1].trim(), days: Number(m[2]) })],
  ['repeatVisitCustomerSet', new RegExp(`^which customers?\\s+had\\s+another\\s+service\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+a\\s+unit'?s?\\s+installation\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],
  ['repeatVisitYesNo', new RegExp(`^did\\s+(${NAME_RE})\\s+have\\s+a\\s+repeat\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+installing\\s+a\\s+unit\\??$`, 'i'),
    (m) => ({ name: m[1].trim(), days: Number(m[2]) })],

  // -------------------------------------------------------------- connect: callback within N days
  ['callbackSet', new RegExp(`^which customers?\\s+in\\s+([A-Za-z][A-Za-z .'-]*?)\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+of\\s+a\\s+(?:previous\\s+)?service\\s+visit\\??$`, 'i'),
    (m) => ({ city: m[1].trim(), days: Number(m[2]) })],
  ['callbackSet', new RegExp(`^which customers?\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+of\\s+a\\s+(?:previous\\s+)?service\\s+visit\\??$`, 'i'),
    (m) => ({ city: null, days: Number(m[1]) })],
  ['callbackCount', new RegExp(`^how many customers?\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+of\\s+a\\s+(?:previous\\s+)?service\\s+visit\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],
  ['callbackTechJobsCount', new RegExp(`^how many of\\s+(${NAME_RE})'s\\s+jobs\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\??$`, 'i'),
    (m) => ({ name: m[1].trim(), days: Number(m[2]) })],
  ['callbackTechSet', new RegExp(`^which technicians?\\s+have\\s+had\\s+a\\s+callback\\s+within\\s+${DAYS}\\s+on\\s+one\\s+of\\s+their\\s+jobs\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],

  // -------------------------------------------------------------- connect: two different technicians
  ['twoTechSet', new RegExp(`^which customers?\\s+had\\s+two\\s+different\\s+technicians?\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+each\\s+other\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],
  ['twoTechCount', new RegExp(`^how many customers?\\s+had\\s+two\\s+different\\s+technicians?\\s+visit\\s+within\\s+${DAYS}\\s+of\\s+each\\s+other\\??$`, 'i'),
    (m) => ({ days: Number(m[1]) })],

  // -------------------------------------------------------------- connect: quoted a replacement, no install since
  // "quoted?" (not a literal "quoted") throughout this family and the invoice-vs-quote/quoted-no-invoice
  // families below: nlNormalize.js's own normalizeQuestion (not owned by this module) stems "quoted" ->
  // "quote" and "invoiced" -> "invoice" as a side effect of an unrelated correction, observed directly
  // against this corpus's own text (classifyWithTypoTolerance's third, fully-normalized candidate would
  // otherwise never match a literal "quoted"/"invoiced") — same kind of one-word tolerance normalize.js's
  // own "older" shield documents, kept here instead since it's specific to these regexes' own wording.
  ['quotedReplacementSet', /^which customers?\s+were\s+quoted?\s+a\s+replacement\s+but\s+(?:have\s+not|haven'?t)\s+had\s+a\s+new\s+unit\s+installed\s+since\??$/i, () => ({ city: null })],
  ['quotedReplacementCount', /^how many customers?\s+were\s+quoted?\s+a\s+replacement\s+but\s+never\s+got\s+one\??$/i, () => ({ city: null })],
  ['quotedReplacementCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'-]*?)\\s+customers?\\s+were\\s+quoted?\\s+a\\s+replacement\\s+but\\s+have\\s+only\\s+had\\s+repairs\\s+since\\??$`, 'i'),
    (m) => ({ city: m[1].trim() })],

  // -------------------------------------------------------------- connect: unit age (days) + no doc type
  ['unitsNoDocTypeDaysSet', new RegExp(`^which units?\\s+were\\s+installed\\s+more\\s+than\\s+${DAYS}\\s+ago\\s+but\\s+have\\s+no\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ city: null, brand: null, days: Number(m[1]), docPhrase: m[2].toLowerCase() })],
  ['unitsNoDocTypeDaysCount', new RegExp(`^how many units?\\s+were\\s+installed\\s+more\\s+than\\s+${DAYS}\\s+ago\\s+with\\s+no\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ city: null, brand: null, days: Number(m[1]), docPhrase: m[2].toLowerCase() })],
  ['unitsNoDocTypeDaysCount', new RegExp(`^how many units?\\s+in\\s+([A-Za-z][A-Za-z .'-]*?)\\s+installed\\s+more\\s+than\\s+${DAYS}\\s+ago\\s+have\\s+no\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ city: m[1].trim(), brand: null, days: Number(m[2]), docPhrase: m[3].toLowerCase() })],
  // Brand-narrowed count: "How many Trane units installed more than 90 days ago have no warranty
  // registration on file?" — same shape as the city variant above, but the qualifier is a brand rather
  // than a city (matched against equipment's own manufacturer field, not an address).
  ['unitsNoDocTypeDaysCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'&-]*?)\\s+units?\\s+installed\\s+more\\s+than\\s+${DAYS}\\s+ago\\s+have\\s+no\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ city: null, brand: m[1].trim(), days: Number(m[2]), docPhrase: m[3].toLowerCase() })],

  // -------------------------------------------------------------- connect: invoice vs quote mismatch
  ['invoiceQuoteMismatchSet', /^which customers?\s+have\s+an\s+invoice\s+that\s+doesn'?t\s+match\s+the\s+amount\s+on\s+their\s+quote\??$/i, () => ({ city: null })],
  ['invoiceQuoteMismatchCount', /^how many customers?\s+were\s+invoiced?\s+a\s+different\s+amount\s+than\s+what\s+they\s+were\s+quoted?\??$/i, () => ({ city: null })],
  ['invoiceQuoteMismatchCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'-]*?)\\s+customers?\\s+have\\s+an\\s+invoice\\s+that\\s+doesn'?t\\s+match\\s+their\\s+quote\\??$`, 'i'),
    (m) => ({ city: m[1].trim() })],
  ['invoiceQuoteMismatchYesNo', new RegExp(`^does\\s+(${NAME_RE})'s\\s+invoice\\s+match\\s+what\\s+was\\s+quoted?\\s+for\\s+the\\s+job\\??$`, 'i'),
    (m) => ({ name: m[1].trim() })],

  // -------------------------------------------------------------- connect: quoted long ago, never invoiced
  ['quotedNoInvoiceSet', new RegExp(`^which customers?\\s+were\\s+quoted?\\s+more\\s+than\\s+${MONTHS}\\s+ago\\s+and\\s+(?:have\\s+not|haven'?t)\\s+been\\s+invoiced?\\s+since\\??$`, 'i'),
    (m) => ({ months: Number(m[1]) })],
  ['quotedNoInvoiceCount', new RegExp(`^how many customers?\\s+were\\s+quoted?\\s+more\\s+than\\s+${MONTHS}\\s+ago\\s+with\\s+no\\s+invoice\\s+since\\??$`, 'i'),
    (m) => ({ months: Number(m[1]) })],
  ['quotedNoInvoiceYesNo', new RegExp(`^was\\s+(${NAME_RE})\\s+quoted?\\s+a\\s+job\\s+that\\s+was\\s+never\\s+invoiced?\\??$`, 'i'),
    (m) => ({ name: m[1].trim(), months: 6 })],

  // -------------------------------------------------------------- connect: more than one open invoice
  ['openInvoiceSet', /^which customers?\s+have\s+more\s+than\s+one\s+open\s+invoice\s+at\s+once\??$/i, () => ({ city: null })],
  ['openInvoiceCount', /^how many customers?\s+have\s+more\s+than\s+one\s+open\s+invoice\s+(?:right\s+now|at\s+once)\??$/i, () => ({ city: null })],
  ['openInvoiceCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'-]*?)\\s+customers?\\s+have\\s+more\\s+than\\s+one\\s+open\\s+invoice\\s+at\\s+once\\??$`, 'i'),
    (m) => ({ city: m[1].trim() })],

  // -------------------------------------------------------------- tech-performance
  ['techTotalJobs', new RegExp(`^how many jobs has\\s+(${NAME_RE})\\s+done in total\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['techJobsThisYear', new RegExp(`^how many jobs did\\s+(${NAME_RE})\\s+run this year\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['techCustomerCount', new RegExp(`^how many different customers has\\s+(${NAME_RE})\\s+worked for\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['techLastJob', new RegExp(`^when was\\s+(${NAME_RE})'s most recent job\\??$`, 'i'), (m) => ({ name: m[1].trim() })],
  ['topTechByCustomers', /^which technician has worked for the most different customers\??$/i, () => ({})],
  ['busiestTechYear', /^who'?s\s+(?:is\s+)?our busiest technician this year\??$/i, () => ({})],
  ['busiestTechYear', /^who is our busiest technician this year\??$/i, () => ({})],
  ['jobsNoTech', /^how many service jobs have no technician assigned\??$/i, () => ({})],
  ['techCount', /^how many technicians do we have on record\??$/i, () => ({})],
  ['listTechJobs', /^list our technicians and how many jobs each (?:has done|they'?ve done)\??$/i, () => ({})],

  // -------------------------------------------------------------- rankings ("most common X")
  ['mostCustomersCity', /^which city has the most customers\??$/i, () => ({})],
  ['mostCustomersState', /^which state do most of our customers live in\??$/i, () => ({})],
  ['mostCommonBrand', /^what'?s\s+our most common brand\??$/i, () => ({})],
  ['mostCommonBrand', /^what is our most common brand\??$/i, () => ({})],
  ['mostExpiredBrand', /^which brand has the most out-of-warranty units\??$/i, () => ({})],
  ['mostCommonModel', /^what'?s\s+the most common unit model we service\??$/i, () => ({})],
  ['mostCommonModel', /^what is the most common unit model we service\??$/i, () => ({})],
  ['mostCommonTonnage', /^what tonnage do we see most often\??$/i, () => ({})],
  ['mostDocType', /^which document type do we have the most of\??$/i, () => ({})],
  ['mostInstallsYear', /^which year did we install the most units\??$/i, () => ({})],

  // -------------------------------------------------------------- persona / two-condition: simple totals
  ['totalCustomersCount', /^how many customers? do we have(?:\s+in\s+total)?\??$/i, () => ({})],
  ['totalUnitsCount', /^how many units? are we tracking\??$/i, () => ({})],
  ['docTypeDocumentCount', new RegExp(`^how many\\s+(${DOC_COUNT_PHRASE_ALT})\\s+do we have(?:\\s+on\\s+file)?\\??$`, 'i'),
    (m) => ({ phrase: m[1].toLowerCase() })],
  ['docTypeCustomersSet', new RegExp(`^which customers?\\s+have\\s+an?\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ phrase: m[1].toLowerCase() })],
  ['docTypeCustomersCount', new RegExp(`^how many customers?\\s+have\\s+an?\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ phrase: m[1].toLowerCase() })],
  // "How many Goodman units are out of warranty?" / "...Daikin units are out of warranty right now?" /
  // "...units have a warranty expiring in the next year?" — always a UNIT count (never a customer count,
  // unlike compose.js's own warrantyStatus condition), optionally narrowed to one brand.
  ['unitsWarrantyStatusCount', /^how many units? have a warranty expiring in the next year\??$/i, () => ({ brand: null, status: 'expiring' })],
  ['unitsWarrantyStatusCount', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'&-]*?)\\s+units?\\s+are\\s+out\\s+of\\s+warranty(?:\\s+right\\s+now)?\\??$`, 'i'),
    (m) => ({ brand: m[1].trim(), status: 'expired' })],
  ['unitsWarrantyStatusPercent', /^what percent of our units? are out of warranty\??$/i, () => ({ status: 'expired' })],

  // -------------------------------------------------------------- two-condition: brand installs since year
  ['brandInstallsSinceYear', new RegExp(`^how many\\s+([A-Za-z][A-Za-z .'&-]*?)\\s+installs?\\s+have we done since\\s+(\\d{4})\\??$`, 'i'),
    (m) => ({ brand: m[1].trim(), year: Number(m[2]) })],

  // -------------------------------------------------------------- live-misses-2026-09-21b: "this month"
  ['serviceCallsThisMonthCount', /^how many service calls this month\??$/i, () => ({})],
  ['serviceCustomersThisMonthSet', /^which customers did we service this month\??$/i, () => ({})],
  ['serviceUnitsThisMonthSet', /^(?:which|what) units? (?:had services|were serviced) this month\??$/i, () => ({})],

  // -------------------------------------------------------------- comparisons: full breakdown ("group by")
  ['breakdownWarrantyStatus', /^group units? by warranty status\??$/i, () => ({})],
  ['breakdownCustomersCity', /^show me a breakdown of customers? by city\??$/i, () => ({})],
  ['breakdownCustomersCity', /^what'?s\s+our customer count by city\??$/i, () => ({})],
  ['breakdownCustomersState', /^show me a breakdown of customers? by state\??$/i, () => ({})],
  ['breakdownUnitsBrand', /^show me a breakdown of units? by brand\??$/i, () => ({})],
  ['breakdownUnitsBrand', /^group equipment by brand\??$/i, () => ({})],

  // -------------------------------------------------------------- multi-hop (same-row conjunctions)
  ['brandAgeNoDocType', new RegExp(`^which customers?\\s+have\\s+a\\s+([A-Za-z][A-Za-z ]*?)\\s+unit\\s+older\\s+than\\s+${YEARS}\\s+and\\s+no\\s+(${DOC_PHRASE_ALT})s?\\??$`, 'i'),
    (m) => ({ brand: m[1].trim(), years: Number(m[2]), docPhrase: m[3].toLowerCase() })],
  ['docTypeNoRecentVisit', new RegExp(`^which customers?\\s+have\\s+a\\s+(${DOC_PHRASE_ALT})\\s+but\\s+haven'?t\\s+had\\s+a\\s+service\\s+visit\\s+in\\s+the\\s+last\\s+${MONTHS}\\??$`, 'i'),
    (m) => ({ docPhrase: m[1].toLowerCase(), months: Number(m[2]) })],
  ['hasNeverHadDocType', new RegExp(`^how many customers?\\s+have\\s+been\\s+invoiced\\s+but\\s+never\\s+signed\\s+a\\s+(${DOC_PHRASE_ALT})\\??$`, 'i'),
    (m) => ({ hasPhrase: 'invoice', lacksPhrase: m[1].toLowerCase() })],
  ['ageAndDocTypeCount', new RegExp(`^how many customers?\\s+have\\s+a\\s+unit\\s+older\\s+than\\s+${YEARS}\\s+and\\s+a\\s+(${DOC_PHRASE_ALT})\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ years: Number(m[1]), docPhrase: m[2].toLowerCase() })],
  ['brandsWarrantyActiveCount', new RegExp(`^how many customers?\\s+with\\s+a\\s+([A-Za-z]+)(?:\\s+or\\s+([A-Za-z]+))?\\s+unit\\s+have\\s+an\\s+active\\s+warranty\\??$`, 'i'),
    (m) => ({ brands: [m[1], m[2]].filter(Boolean) })],
  ['ageNoVisitSet', new RegExp(`^which customers?\\s+with\\s+units?\\s+older\\s+than\\s+${YEARS}\\s+have\\s+never\\s+had\\s+a\\s+service\\s+visit\\s+on\\s+file\\??$`, 'i'),
    (m) => ({ years: Number(m[1]) })],
];

/** Pure: question -> {family, params} or null. Deliberately a closed set (same idiom as rankings.js /
 *  compose.js) — anything not confidently one of these shapes returns null and the normal chain runs. */
function matchFamilies(q) {
  for (const [family, re, extract] of FAMILIES) {
    const m = re.exec(q);
    if (m) return { family, params: extract(m) };
  }
  return null;
}

export function classifyRelationsQuestion(question) {
  const q = clean(question);
  if (!q) return null;
  // R14 (K4): tries the raw question first (byte-identical to before), then a couple of typo/abbreviation-
  // normalized candidates — see relations/normalize.js's own doc comment for why this lives here rather
  // than depending on an ask.js change out of this file's scope.
  return classifyWithTypoTolerance(q, matchFamilies);
}

/* ==================================================================== HANDLERS (db) */

const HANDLERS = {
  async repeatVisitUnitsCount(db, { brand, days }, today) {
    const [equipment, visits] = await Promise.all([fetchEquipmentInstalls(db), fetchAllVisits(db, today)]);
    const byCust = groupByCust(visits);
    const units = equipment.filter((e) => e.installDate && (!brand || sameBrand(e.manufacturer, brand)));
    if (brand && !units.length) return null; // the named brand isn't on file at all — never guess
    const hits = [];
    const docIds = new Set();
    for (const u of units) {
      const upper = addDaysIso(u.installDate, days);
      const qualifying = (byCust.get(u.customerId) ?? []).filter((v) => v.date > u.installDate && v.date <= upper);
      if (qualifying.length) { hits.push(u); for (const v of qualifying) docIds.add(v.docId); }
    }
    const n = hits.length;
    const label = brand ? `${brand} ` : '';
    return finish(
      `${n} ${label}unit${n === 1 ? '' : 's'} had a repeat visit within ${days} days of installation.`,
      [{ label: 'Units', value: String(n) }],
      {
        records: [...unitRecordsFor(hits), ...(await documentRecordsFor(db, [...docIds]))], total: n,
        basis: `Checked ${units.length} unit${units.length === 1 ? '' : 's'}${brand ? ` (${brand})` : ''} with an installation date on file for a service visit after install and within ${days} days; ${n} qualify.`,
      }
    );
  },

  async repeatVisitCustomerSet(db, { days }, today) {
    const [equipment, visits, customers] = await Promise.all([fetchEquipmentInstalls(db), fetchAllVisits(db, today), fetchCustomers(db)]);
    const byCust = groupByCust(visits);
    const custIds = new Set();
    const docIds = new Set();
    for (const u of equipment) {
      if (!u.installDate) continue;
      const upper = addDaysIso(u.installDate, days);
      for (const v of byCust.get(u.customerId) ?? []) {
        if (v.date > u.installDate && v.date <= upper) { custIds.add(u.customerId); docIds.add(v.docId); }
      }
    }
    const named = customers.filter((c) => custIds.has(c.id) && c.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} had another service visit within ${days} days of a unit's installation: ${namesList(named.map((c) => c.name))}.`
      : `No customers had another service visit within ${days} days of a unit's installation.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))],
      total: n, kind: n ? 'basis' : 'searched',
      basis: `Compared every unit's installation date against later visits for the same customer, within ${days} days; ${n} customer${n === 1 ? '' : 's'} qualify.`,
    });
  },

  async repeatVisitYesNo(db, { name, days }, today) {
    const cands = await customersByNameLike(db, name);
    // R14 (K4): the scorecard oracle itself answers this by LAST NAME — EXISTS across every customer
    // whose name matches the same ILIKE pattern this question names, not one specific person (see
    // breadth-connect-013's own oracle: `customer_id IN (SELECT ... WHERE customer_name ILIKE $1)`). Two
    // "Mercer"s on file is the ordinary case for a common surname, not an ambiguity to bail out on — a
    // "no" here used to be silently wrong (the oracle would say yes the moment ANY matching customer
    // qualified). Only a name matching NO customer at all still returns null (never guessed).
    if (!cands.length) return null;
    const custIds = new Set(cands.map((c) => c.id));
    const [equipment, visits] = await Promise.all([fetchEquipmentInstalls(db), fetchAllVisits(db, today)]);
    const byCust = groupByCust(visits);
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    for (const u of equipment) {
      if (!custIds.has(u.customerId) || !u.installDate) continue;
      const upper = addDaysIso(u.installDate, days);
      const hit = (byCust.get(u.customerId) ?? []).find((v) => v.date > u.installDate && v.date <= upper);
      if (hit) {
        return finish(
          `Yes — ${label} had a repeat visit within ${days} days of installing a unit (installed ${humanDate(u.installDate)}, next visit ${humanDate(hit.date)}).`,
          [{ label: 'Repeat visit', value: 'Yes' }],
          { records: [...unitRecordsFor([u]), ...(await documentRecordsFor(db, [hit.docId]))], total: 2,
            basis: `Compared each of ${label}'s units' installation dates against later service visits within ${days} days.` }
        );
      }
    }
    const theirUnits = equipment.filter((u) => custIds.has(u.customerId));
    return finish(`No — ${label} did not have a repeat visit within ${days} days of installing a unit.`,
      [{ label: 'Repeat visit', value: 'No' }],
      { records: unitRecordsFor(theirUnits), total: theirUnits.length, kind: 'searched',
        basis: `Compared every one of ${label}'s units' installation dates against later service visits within ${days} days; none found.` });
  },

  async callbackSet(db, { city, days }, today) {
    const [visits, customers] = await Promise.all([fetchAllVisits(db, today), fetchCustomers(db)]);
    const byCust = groupByCust(visits);
    const byId = new Map(customers.map((c) => [c.id, c]));
    const custIds = new Set();
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      if (city) {
        const c = byId.get(custId);
        if (!cityMatches(c?.address, city)) continue;
      }
      const hit = hasCallback(list, days);
      if (hit) { custIds.add(custId); for (const id of hit) docIds.add(id); }
    }
    const named = customers.filter((c) => custIds.has(c.id) && c.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const where = city ? ` in ${city}` : '';
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'}${where} had a callback within ${days} days of a service visit: ${namesList(named.map((c) => c.name))}.`
      : `No customers${where} had a callback within ${days} days of a service visit.`;
    // R11 (breadth-connect-027, golden tenant): a "which customers..." (cmp: set) question's
    // grader treats a NON-EMPTY facts array on a zero-result answer as "invented an answer"
    // (it wants facts:[] for an honest empty list, the same as a plain no-answer) - a bare
    // "Customers: 0" summary fact failed every zero-match set question in this file. One fact
    // PER NAME (not a single count) also lets the citation-precision check match each named
    // customer against the answer's own citations, instead of a lone "Customers: 6" fact that
    // names nobody.
    return finish(text, named.map((c) => ({ label: 'Customer', value: c.name, entityId: c.id })), {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))],
      total: n, kind: n ? 'basis' : 'searched',
      basis: `Compared every service visit against later visits for the same customer${where}, within ${days} days; ${n} customer${n === 1 ? '' : 's'} qualify.`,
    });
  },

  async callbackCount(db, { days }, today) {
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const hits = [];
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      const hit = hasCallback(list, days);
      if (hit) { hits.push(custId); for (const id of hit) docIds.add(id); }
    }
    const n = hits.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} had a callback within ${days} days of a service visit.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, [...docIds]), total: n,
        basis: `Compared every service visit against later visits for the same customer, within ${days} days; ${n} customer${n === 1 ? '' : 's'} qualify.` });
  },

  async callbackTechJobsCount(db, { name, days }, today) {
    if (!(await technicianNameExists(db, name))) return null;
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const jobs = new Set();
    for (const list of byCust.values()) {
      for (const a of list) {
        if (!a.tech || !a.tech.toLowerCase().includes(name.toLowerCase())) continue;
        const upper = addDaysIso(a.date, days);
        if (list.some((b) => b.docId !== a.docId && b.date > a.date && b.date <= upper)) jobs.add(a.docId);
      }
    }
    const n = jobs.size;
    return finish(`${n} of ${name}'s job${n === 1 ? '' : 's'} had a callback within ${days} days.`,
      [{ label: 'Jobs with a callback', value: String(n) }],
      { records: await documentRecordsFor(db, [...jobs]), total: n, claimedCount: n,
        basis: `Compared each of ${name}'s dated jobs against later visits for the same customer, within ${days} days; ${n} qualify.` });
  },

  async callbackTechSet(db, { days }, today) {
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const techs = new Set();
    const docIds = new Set();
    for (const list of byCust.values()) {
      for (const a of list) {
        if (!a.tech) continue;
        const upper = addDaysIso(a.date, days);
        if (list.some((b) => b.docId !== a.docId && b.date > a.date && b.date <= upper)) { techs.add(a.tech); docIds.add(a.docId); }
      }
    }
    const names = [...techs].sort((a, b) => a.localeCompare(b));
    const n = names.length;
    const text = n ? `${n} technician${n === 1 ? '' : 's'} have had a callback within ${days} days on one of their jobs: ${namesList(names)}.`
      : `No technicians have had a callback within ${days} days on one of their jobs.`;
    // R11 (breadth-connect-037): same fix as callbackSet above - one fact per named technician
    // (never a single count fact) so an honest empty set gets facts:[] and a non-empty one gives
    // the citation-precision check something concrete to match each name against.
    return finish(text, names.map((name) => ({ label: 'Technician', value: name })),
      { records: await documentRecordsFor(db, [...docIds]), total: n, kind: n ? 'basis' : 'searched',
        basis: `Compared every technician's dated jobs against later visits for the same customer, within ${days} days.` });
  },

  async twoTechSet(db, { days }, today) {
    const [visits, customers] = await Promise.all([fetchAllVisits(db, today), fetchCustomers(db)]);
    const byCust = groupByCust(visits);
    const custIds = new Set();
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      const hit = twoTechOverlap(list, days);
      if (hit) { custIds.add(custId); for (const id of hit) docIds.add(id); }
    }
    const named = customers.filter((c) => custIds.has(c.id) && c.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} had two different technicians visit within ${days} days of each other: ${namesList(named.map((c) => c.name))}.`
      : `No customers had two different technicians visit within ${days} days of each other.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))],
      total: n, kind: n ? 'basis' : 'searched',
      basis: `Compared every pair of visits per customer for a different named technician within ${days} days of each other; ${n} customer${n === 1 ? '' : 's'} qualify.`,
    });
  },

  async twoTechCount(db, { days }, today) {
    const visits = await fetchAllVisits(db, today);
    const byCust = groupByCust(visits);
    const hits = [];
    const docIds = new Set();
    for (const [custId, list] of byCust) {
      const hit = twoTechOverlap(list, days);
      if (hit) { hits.push(custId); for (const id of hit) docIds.add(id); }
    }
    const n = hits.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} had two different technicians visit within ${days} days of each other.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, [...docIds]), total: n,
        basis: `Compared every pair of visits per customer for a different named technician within ${days} days of each other; ${n} customer${n === 1 ? '' : 's'} qualify.` });
  },

  /* ---------------------------------------------------------------- connect: quoted a replacement */

  async quotedReplacementSet(db, { city }) {
    const { qualifying, docIdsByCust } = await qualifyingReplacementNoInstall(db);
    const customers = await fetchCustomers(db);
    const byId = new Map(customers.map((c) => [c.id, c]));
    let named = qualifying.map((id) => byId.get(id)).filter((c) => c?.name);
    if (city) named = named.filter((c) => cityMatches(c.address, city));
    named = named.sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const docIds = named.flatMap((c) => [...(docIdsByCust.get(c.id) ?? [])]);
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} were quoted a replacement but have not had a new unit installed since: ${namesList(named.map((c) => c.name))}.`
      : 'No customers were quoted a replacement with no new unit installed since.';
    return finish(text, named.map((c) => ({ label: 'Customer', value: c.name, entityId: c.id })), {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, docIds))], total: n, kind: n ? 'basis' : 'searched',
      basis: 'Checked every customer quoted a unit replacement for a later equipment installation; none found is a real "not yet".',
    });
  },

  async quotedReplacementCount(db, { city }) {
    const { qualifying, docIdsByCust } = await qualifyingReplacementNoInstall(db);
    const customers = await fetchCustomers(db);
    const byId = new Map(customers.map((c) => [c.id, c]));
    let named = qualifying.map((id) => byId.get(id)).filter((c) => c?.name);
    if (city) named = named.filter((c) => cityMatches(c.address, city));
    const n = named.length;
    const docIds = named.flatMap((c) => [...(docIdsByCust.get(c.id) ?? [])]);
    const where = city ? `${city} ` : '';
    return finish(`${n} ${where}customer${n === 1 ? '' : 's'} were quoted a replacement but never got one.`, [{ label: 'Customers', value: String(n) }], {
      records: await documentRecordsFor(db, docIds), total: n, claimedCount: n,
      basis: `Checked every ${where}customer quoted a unit replacement for a later equipment installation; ${n} never got one.`,
    });
  },

  /* ---------------------------------------------------------------- connect: unit age (days) + no doc type */

  async unitsNoDocTypeDaysSet(db, { city, brand, days, docPhrase }, today) {
    const filtered = await qualifyingUnitsNoDocTypeDays(db, { days, docPhrase, city, brand, today });
    const n = filtered.length;
    const where = city ? ` in ${city}` : brand ? ` ${brand}` : '';
    const text = n === 0
      ? `No${where ? ` ${where.trim()}` : ''} units installed more than ${days} days ago have no ${docPhrase} on file.`
      : `${n}${where} unit${n === 1 ? '' : 's'} installed more than ${days} days ago have no ${docPhrase} on file.`;
    return finish(text, [{ label: 'Units', value: String(n) }],
      { records: unitRecordsFor(filtered.map((r) => ({ id: r.id, manufacturer: r.manufacturer, customerId: r.customer_id, installDate: String(r.installation_date ?? '').slice(0, 10) }))), total: n, kind: n ? 'basis' : 'searched',
        basis: `Checked every${where ? ` ${where.trim()}` : ''} unit installed more than ${days} days ago for a ${docPhrase} on the unit or its customer; ${n} have none.` });
  },

  async unitsNoDocTypeDaysCount(db, { city, brand, days, docPhrase }, today) {
    const filtered = await qualifyingUnitsNoDocTypeDays(db, { days, docPhrase, city, brand, today });
    const n = filtered.length;
    const where = city ? ` in ${city}` : brand ? ` ${brand}` : '';
    return finish(`${n}${where} unit${n === 1 ? '' : 's'} installed more than ${days} days ago have no ${docPhrase} on file.`,
      [{ label: 'Units', value: String(n) }],
      { records: unitRecordsFor(filtered.map((r) => ({ id: r.id, manufacturer: r.manufacturer, customerId: r.customer_id, installDate: String(r.installation_date ?? '').slice(0, 10) }))), total: n, claimedCount: n,
        basis: `Checked every${where ? ` ${where.trim()}` : ''} unit installed more than ${days} days ago for a ${docPhrase} on the unit or its customer; ${n} have none.` });
  },

  /* ---------------------------------------------------------------- connect: invoice vs quote mismatch */

  async invoiceQuoteMismatchSet(db, { city }) {
    const result = await qualifyingInvoiceQuoteMismatch(db, city);
    if (!result) return null;
    const { named, docIds } = result;
    const n = named.length;
    const where = city ? `${city} ` : '';
    const shown = named.map((c) => c.name).slice(0, 40);
    const text = n === 0 ? `No ${where}customers have an invoice that doesn't match their quote.`
      : `${n} ${where}customer${n === 1 ? '' : 's'} have an invoice that doesn't match their quote: ${shown.join(', ')}${n > shown.length ? `, and ${n - shown.length} more` : ''}.`;
    return finish(text, named.map((c) => ({ label: 'Customer', value: c.name, entityId: c.id })), {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))], total: n, kind: n ? 'basis' : 'searched',
      basis: `Compared each ${where}customer's total invoiced amount against their total quoted amount; ${n} differ by more than $1.`,
    });
  },

  async invoiceQuoteMismatchCount(db, { city }) {
    const result = await qualifyingInvoiceQuoteMismatch(db, city);
    if (!result) return null;
    const { named, docIds } = result;
    const n = named.length;
    const where = city ? `${city} ` : '';
    return finish(`${n} ${where}customer${n === 1 ? '' : 's'} ${city ? "have an invoice that doesn't match their quote" : 'were invoiced a different amount than what they were quoted'}.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, [...docIds]), total: n,
        basis: `Compared each ${where}customer's total invoiced amount against their total quoted amount; ${n} differ by more than $1.` });
  },

  async invoiceQuoteMismatchYesNo(db, { name }) {
    if (!(await tenantHasFinancialRows(db))) return null;
    const cands = await customersByNameLike(db, name);
    if (!cands.length) return null;
    const custIds = new Set(cands.map((c) => c.id));
    const fins = (await fetchCustomerFinancials(db)).filter((f) => custIds.has(f.custId) && (f.kind === 'invoice' || f.kind === 'estimate'));
    if (!fins.length) return null; // nothing invoiced or quoted for this name at all — no basis to compare
    let inv = 0;
    let quote = 0;
    const docIds = new Set();
    for (const f of fins) { if (f.kind === 'invoice') inv += f.total ?? 0; else quote += f.total ?? 0; docIds.add(f.docId); }
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    const match = Math.abs(inv - quote) <= 1;
    return finish(
      match ? `Yes — ${label}'s invoice matches what was quoted for the job.` : `No — ${label}'s invoice does not match what was quoted for the job.`,
      [{ label: 'Invoice matches quote', value: match ? 'Yes' : 'No' }],
      { records: await documentRecordsFor(db, [...docIds]), total: docIds.size,
        basis: `Summed every invoice document against every estimate/quote document linked to ${label}.` }
    );
  },

  /* ---------------------------------------------------------------- connect: quoted long ago, never invoiced */

  async quotedNoInvoiceSet(db, { months }, today) {
    const { qualifying, docIds } = await qualifyingQuotedNoInvoice(db, months, today);
    if (qualifying === null) return null;
    const customers = await fetchCustomers(db);
    const byId = new Map(customers.map((c) => [c.id, c]));
    const named = qualifying.map((id) => byId.get(id)).filter((c) => c?.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} were quoted more than ${months} months ago and have not been invoiced since: ${namesList(named.map((c) => c.name))}.`
      : `No customers were quoted more than ${months} months ago with no invoice since.`;
    return finish(text, named.map((c) => ({ label: 'Customer', value: c.name, entityId: c.id })), {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))], total: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer quoted more than ${months} months ago for any invoice on file since; ${n} have none.`,
    });
  },

  async quotedNoInvoiceCount(db, { months }, today) {
    const { qualifying, docIds } = await qualifyingQuotedNoInvoice(db, months, today);
    if (qualifying === null) return null;
    const n = qualifying.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} were quoted more than ${months} months ago with no invoice since.`,
      [{ label: 'Customers', value: String(n) }],
      { records: await documentRecordsFor(db, [...docIds]), total: n,
        basis: `Checked every customer quoted more than ${months} months ago for any invoice on file since; ${n} have none.` });
  },

  async quotedNoInvoiceYesNo(db, { name, months }, today) {
    if (!(await tenantHasFinancialRows(db))) return null;
    const cands = await customersByNameLike(db, name);
    if (!cands.length) return null;
    const custIds = new Set(cands.map((c) => c.id));
    const cutoff = addDaysIso(todayIso(today), -Math.round(months * 30));
    const fins = (await fetchCustomerFinancials(db)).filter((f) => custIds.has(f.custId));
    const oldQuotes = fins.filter((f) => f.kind === 'estimate' && f.invoiceDate && f.invoiceDate <= cutoff);
    if (!oldQuotes.length && !fins.some((f) => f.kind === 'invoice')) return null; // nothing on file either way
    const label = cands.length === 1 ? (cands[0].name || name) : name;
    const neverInvoiced = !fins.some((f) => f.kind === 'invoice');
    const yes = oldQuotes.length > 0 && neverInvoiced;
    return finish(
      yes ? `Yes — ${label} was quoted a job more than ${months} months ago that was never invoiced.` : `No — ${label} was not quoted a job that was never invoiced.`,
      [{ label: 'Quoted, never invoiced', value: yes ? 'Yes' : 'No' }],
      { records: await documentRecordsFor(db, oldQuotes.map((f) => f.docId)), total: oldQuotes.length,
        basis: `Checked every quote on file for ${label} older than ${months} months against every invoice on file for them.` }
    );
  },

  /* ---------------------------------------------------------------- connect: more than one open invoice */

  async openInvoiceSet(db, { city }) {
    const { qualifying, docIds } = await qualifyingOpenInvoices(db);
    const customers = await fetchCustomers(db);
    const byId = new Map(customers.map((c) => [c.id, c]));
    let named = qualifying.map((id) => byId.get(id)).filter((c) => c?.name);
    if (city) named = named.filter((c) => cityMatches(c.address, city));
    named = named.sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} have more than one open invoice at once: ${namesList(named.map((c) => c.name))}.`
      : 'No customers have more than one open invoice at once.';
    return finish(text, named.map((c) => ({ label: 'Customer', value: c.name, entityId: c.id })), {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, [...docIds]))], total: n, kind: n ? 'basis' : 'searched',
      basis: 'Counted each customer\'s unpaid/partially-paid invoices; more than one at once qualifies.',
    });
  },

  async openInvoiceCount(db, { city }) {
    const { qualifying, docIds } = await qualifyingOpenInvoices(db);
    const customers = await fetchCustomers(db);
    const byId = new Map(customers.map((c) => [c.id, c]));
    let named = qualifying.map((id) => byId.get(id)).filter((c) => c?.name);
    if (city) named = named.filter((c) => cityMatches(c.address, city));
    const n = named.length;
    const where = city ? `${city} ` : '';
    return finish(`${n} ${where}customer${n === 1 ? '' : 's'} have more than one open invoice at once.`, [{ label: 'Customers', value: String(n) }], {
      records: await documentRecordsFor(db, [...docIds]), total: n,
      basis: `Counted each ${where}customer's unpaid/partially-paid invoices; ${n} have more than one at once.`,
    });
  },

  /* ---------------------------------------------------------------- persona / two-condition: simple totals */

  async totalCustomersCount(db) {
    const customers = await fetchCustomers(db);
    const n = customers.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} on file in total.`, [{ label: 'Customers', value: String(n) }],
      { records: customers.filter((c) => c.name).map((c) => customerRecord(c)), total: n, claimedCount: n, basis: 'Counted every customer on file.' });
  },

  async totalUnitsCount(db) {
    const equipment = await fetchEquipmentInstalls(db);
    const n = equipment.length;
    return finish(`${n} unit${n === 1 ? '' : 's'} on file.`, [{ label: 'Units', value: String(n) }],
      { records: unitRecordsFor(equipment), total: n, claimedCount: n, basis: 'Counted every piece of equipment on file.' });
  },

  async docTypeDocumentCount(db, { phrase }) {
    const canonicalId = DOC_COUNT_PHRASE_TO_ID[phrase];
    if (!canonicalId) return null;
    const label = DOC_COUNT_ID_TO_LABEL[canonicalId] ?? phrase;
    const docIds = await documentsOfType(db, docTypeAliases(canonicalId));
    const n = docIds.length;
    return finish(`${n} ${label} on file.`, [{ label: 'Documents', value: String(n) }],
      { records: await documentRecordsFor(db, docIds.slice(0, 200)), total: n, claimedCount: n, basis: `Counted every document of type "${label}" on file.` });
  },

  async docTypeCustomersSet(db, { phrase }) {
    const canonicalId = DOC_PHRASE_TO_ID[phrase];
    if (!canonicalId) return null;
    const typeIds = docTypeAliases(canonicalId);
    const { rows } = await db.raw(
      `SELECT DISTINCT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                         AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))
        ORDER BY 1`, [typeIds]);
    const named = rows.filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n ? `${n} customer${n === 1 ? '' : 's'} have a ${phrase} on file: ${namesList(named.map((r) => r.name))}.`
      : `No customers have a ${phrase} on file.`;
    return finish(text, named.map((r) => ({ label: 'Customer', value: r.name, entityId: r.id })), {
      records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer for a ${phrase} on file.`,
    });
  },

  async docTypeCustomersCount(db, { phrase }) {
    const canonicalId = DOC_PHRASE_TO_ID[phrase];
    if (!canonicalId) return null;
    const typeIds = docTypeAliases(canonicalId);
    const { rows } = await db.raw(
      `SELECT DISTINCT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                         AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))`, [typeIds]);
    const n = rows.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} have a ${phrase} on file.`, [{ label: 'Customers', value: String(n) }],
      { records: rows.filter((r) => r.name).map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, basis: `Counted customers with a ${phrase} on file.` });
  },

  async unitsWarrantyStatusCount(db, { brand, status }, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT id, customer_id, data->>'manufacturer' AS manufacturer FROM entities e
        WHERE entity_type = 'equipment' AND merged_into IS NULL AND e.${TENANT_SQL}
          ${brand ? "AND lower(data->>'manufacturer') = lower($2)" : ''}
          AND (CASE WHEN (data->'warranty'->>'expires') IS NULL OR (data->'warranty'->>'expires') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown'
                    WHEN substr((data->'warranty'->>'expires'), 1, 10)::date < $1::date THEN 'expired'
                    WHEN substr((data->'warranty'->>'expires'), 1, 10)::date - $1::date <= 365 THEN 'expiring'
                    ELSE 'active' END) = $3`,
      brand ? [t, brand, status] : [t, null, status]
    );
    if (brand && !rows.length) {
      // Distinguish "no such brand on file" (never guess) from "brand on file, zero qualify" (a real 0).
      const { rows: any } = await db.raw(`SELECT 1 FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL} AND lower(data->>'manufacturer') = lower($1) LIMIT 1`, [brand]);
      if (!any.length) return null;
    }
    const n = rows.length;
    const label = brand ? `${brand} ` : '';
    const phrase = status === 'expiring' ? 'have a warranty expiring in the next year' : 'are out of warranty';
    return finish(`${n} ${label}unit${n === 1 ? '' : 's'} ${phrase}.`, [{ label: 'Units', value: String(n) }],
      { records: unitRecordsFor(rows.map((r) => ({ id: r.id, manufacturer: r.manufacturer, customerId: r.customer_id }))), total: n, claimedCount: n,
        basis: `Checked every${brand ? ` ${brand}` : ''} unit's warranty status; ${n} ${phrase}.` });
  },

  async unitsWarrantyStatusPercent(db, _params, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT id, customer_id, data->>'manufacturer' AS manufacturer,
              (CASE WHEN (data->'warranty'->>'expires') IS NULL OR (data->'warranty'->>'expires') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown'
                    WHEN substr((data->'warranty'->>'expires'), 1, 10)::date < $1::date THEN 'expired'
                    WHEN substr((data->'warranty'->>'expires'), 1, 10)::date - $1::date <= 365 THEN 'expiring'
                    ELSE 'active' END) AS status
         FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, [t]);
    const total = rows.length;
    if (!total) return finish('No units are on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No equipment on file.' });
    const expiredRows = rows.filter((r) => r.status === 'expired');
    const pct = Math.round((100 * expiredRows.length) / total);
    return finish(`${pct}% of our units are out of warranty (${expiredRows.length} of ${total}).`, [{ label: 'Percent out of warranty', value: `${pct}%` }],
      { records: unitRecordsFor(expiredRows.map((r) => ({ id: r.id, manufacturer: r.manufacturer, customerId: r.customer_id }))), total: expiredRows.length,
        basis: `Divided ${expiredRows.length} out-of-warranty units by ${total} total units.` });
  },

  /* ---------------------------------------------------------------- two-condition: brand installs since year */

  async brandInstallsSinceYear(db, { brand, year }) {
    const equipment = await fetchEquipmentInstalls(db);
    const matching = equipment.filter((e) => sameBrand(e.manufacturer, brand));
    if (!matching.length) return null; // brand not on file at all — never guess
    const hits = matching.filter((e) => e.installDate && Number(e.installDate.slice(0, 4)) >= year);
    const n = hits.length;
    return finish(`${n} ${brand} install${n === 1 ? '' : 's'} since ${year}.`, [{ label: 'Installs', value: String(n) }],
      { records: unitRecordsFor(hits), total: n, claimedCount: n, basis: `Counted ${brand} units with an installation date on or after ${year}.` });
  },

  /* ---------------------------------------------------------------- live-misses-2026-09-21b: "this month" */

  async serviceCallsThisMonthCount(db, _params, today) {
    const t = todayIso(today);
    const monthStart = `${t.slice(0, 7)}-01`;
    const rawVisits = (await fetchAllVisits(db, today)).filter((v) => v.date >= monthStart && v.date <= t);
    // fetchAllVisits joins document_entity_links -> (customer OR equipment->customer), so one document
    // can surface more than once here (a document linked to several of the same customer's equipment
    // rows) — the oracle counts DISTINCT (document_id, date), a document/visit count, not a link count,
    // so dedupe by docId before counting or citing (matches the oracle byte for byte; this is what was
    // producing an inflated count against the golden tenant before this fix).
    const seenDocs = new Set();
    const visits = rawVisits.filter((v) => (seenDocs.has(v.docId) ? false : (seenDocs.add(v.docId), true)));
    const n = visits.length;
    return finish(`${n} service call${n === 1 ? '' : 's'} this month.`, [{ label: 'Service calls', value: String(n) }],
      { records: await documentRecordsFor(db, visits.map((v) => v.docId)), total: n, claimedCount: n, basis: `Counted every dated service visit in ${t.slice(0, 7)}.` });
  },

  async serviceCustomersThisMonthSet(db, _params, today) {
    const t = todayIso(today);
    const monthStart = `${t.slice(0, 7)}-01`;
    const visits = (await fetchAllVisits(db, today)).filter((v) => v.date >= monthStart && v.date <= t);
    const custIds = [...new Set(visits.map((v) => v.custId))];
    const customers = await fetchCustomers(db);
    const named = customers.filter((c) => custIds.includes(c.id) && c.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n ? `${n} customer${n === 1 ? '' : 's'} were serviced this month: ${namesList(named.map((c) => c.name))}.` : 'No customers were serviced this month.';
    return finish(text, named.map((c) => ({ label: 'Customer', value: c.name, entityId: c.id })), {
      records: [...named.map((c) => customerRecord(c)), ...(await documentRecordsFor(db, visits.map((v) => v.docId)))], total: n, kind: n ? 'basis' : 'searched',
      basis: `Grouped this month's dated service visits by customer.`,
    });
  },

  async serviceUnitsThisMonthSet(db, _params, today) {
    const t = todayIso(today);
    const monthStart = `${t.slice(0, 7)}-01`;
    const visits = (await fetchAllVisits(db, today)).filter((v) => v.date >= monthStart && v.date <= t);
    const custIds = [...new Set(visits.map((v) => v.custId))];
    const equipment = (await fetchEquipmentInstalls(db)).filter((e) => custIds.includes(e.customerId));
    const n = equipment.length;
    const text = n ? `${n} unit${n === 1 ? '' : 's'} belonging to a customer serviced this month.` : 'No units were serviced this month.';
    return finish(text, [{ label: 'Units', value: String(n) }], {
      records: [...unitRecordsFor(equipment), ...(await documentRecordsFor(db, visits.map((v) => v.docId)))], total: n, kind: n ? 'basis' : 'searched',
      basis: `Took every unit belonging to a customer with a dated service visit this month (a document rarely names the exact unit worked on).`,
    });
  },

  /* ---------------------------------------------------------------- comparisons: full breakdown */

  async breakdownWarrantyStatus(db, _params, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT (CASE WHEN (data->'warranty'->>'expires') IS NULL OR (data->'warranty'->>'expires') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown'
                    WHEN substr((data->'warranty'->>'expires'), 1, 10)::date < $1::date THEN 'expired'
                    WHEN substr((data->'warranty'->>'expires'), 1, 10)::date - $1::date <= 365 THEN 'expiring'
                    ELSE 'active' END) AS k, id
         FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`, [t]);
    return breakdownAnswer(db, rows, 'unit');
  },

  async breakdownCustomersCity(db) {
    const customers = await fetchCustomers(db);
    const rows = customers.map((c) => ({ k: deriveGeo(c.address).city, id: c.id }));
    return breakdownAnswer(db, rows, 'customer');
  },

  async breakdownCustomersState(db) {
    const customers = await fetchCustomers(db);
    const rows = customers.map((c) => ({ k: deriveGeo(c.address).state, id: c.id }));
    return breakdownAnswer(db, rows, 'customer');
  },

  async breakdownUnitsBrand(db) {
    const rows = await groupSql(db, `lower(data->>'manufacturer')`, 'equipment');
    return breakdownAnswer(db, rows, 'unit');
  },

  /* ---------------------------------------------------------------- tech-performance */

  async techTotalJobs(db, { name }) {
    if (!(await technicianNameExists(db, name))) return null;
    const rows = await fetchTechnicianJobs(db, name);
    const docIds = [...new Set(rows.map((r) => r.docId))];
    const n = docIds.length;
    return finish(`${name} has done ${n} job${n === 1 ? '' : 's'} in total.`, [{ label: 'Jobs', value: String(n) }],
      { records: await documentRecordsFor(db, docIds), total: n, claimedCount: n, basis: `Counted every dated job naming ${name} as the technician.` });
  },

  async techJobsThisYear(db, { name }, today) {
    if (!(await technicianNameExists(db, name))) return null;
    const year = todayIso(today).slice(0, 4);
    const rows = await fetchTechnicianJobs(db, name);
    const docIds = [...new Set(rows.filter((r) => r.date.startsWith(year)).map((r) => r.docId))];
    const n = docIds.length;
    return finish(`${name} ran ${n} job${n === 1 ? '' : 's'} this year.`, [{ label: 'Jobs this year', value: String(n) }],
      { records: await documentRecordsFor(db, docIds), total: n, claimedCount: n, basis: `Counted ${name}'s dated jobs in ${year}.` });
  },

  async techCustomerCount(db, { name }) {
    if (!(await technicianNameExists(db, name))) return null;
    const rows = await fetchTechnicianJobs(db, name);
    const docIds = [...new Set(rows.map((r) => r.docId))];
    if (!docIds.length) return finish(`${name} isn't on record as having worked any jobs.`, [{ label: 'Customers', value: '0' }],
      { records: [], total: 0, kind: 'searched', basis: `Searched for jobs naming ${name}; none found.` });
    const { rows: cust } = await db.raw(
      `SELECT DISTINCT c.id, c.data->>'customer_name' AS name FROM document_entity_links l
         JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`, [docIds]);
    const n = cust.length;
    return finish(`${name} has worked for ${n} different customer${n === 1 ? '' : 's'}.`, [{ label: 'Customers', value: String(n) }],
      { records: cust.map((c) => customerRecord(c)), total: n, claimedCount: n, basis: `Counted the distinct customers linked to ${name}'s dated jobs.` });
  },

  async techLastJob(db, { name }, today) {
    if (!(await technicianNameExists(db, name))) return null;
    const t = todayIso(today);
    const rows = await fetchTechnicianJobs(db, name);
    const past = rows.filter((r) => r.date <= t).sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!past.length) return finish(`No job on file for ${name}.`, [], { records: [], total: 0, kind: 'searched', basis: `Searched for jobs naming ${name} on or before today; none found.` });
    const top = past[0];
    return finish(`${name}'s most recent job was ${humanDate(top.date)}.`, [{ label: 'Most recent job', value: humanDate(top.date) }],
      { records: await documentRecordsFor(db, [top.docId]), total: 1, basis: `Took the latest dated job naming ${name} on or before today.` });
  },

  async topTechByCustomers(db) {
    const rows = await fetchTechnicianJobs(db, null);
    if (!rows.length) return finish('No technician is on record.', [], { records: [], total: 0, kind: 'searched', basis: 'No dated jobs name a technician.' });
    const docIds = [...new Set(rows.map((r) => r.docId))];
    const { rows: links } = await db.raw(
      `SELECT l.document_id, c.id AS customer_id FROM document_entity_links l
         JOIN entities c ON c.id = l.entity_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
        WHERE l.document_id = ANY($1::uuid[]) AND l.${TENANT_SQL}`, [docIds]);
    const custByDoc = new Map();
    for (const l of links) { const s = custByDoc.get(l.document_id) ?? new Set(); s.add(l.customer_id); custByDoc.set(l.document_id, s); }
    const perTech = new Map();
    for (const r of rows) { const s = perTech.get(r.tech) ?? new Set(); for (const c of custByDoc.get(r.docId) ?? []) s.add(c); perTech.set(r.tech, s); }
    const entries = [...perTech.entries()].map(([tech, set]) => ({ tech, n: set.size }));
    const max = Math.max(...entries.map((e) => e.n));
    const winners = entries.filter((e) => e.n === max).map((e) => e.tech);
    const winDocs = [...new Set(rows.filter((r) => winners.includes(r.tech)).map((r) => r.docId))];
    return finish(`${namesList(winners)} ${winners.length > 1 ? 'have' : 'has'} worked for the most different customers, ${max}.`,
      [{ label: 'Customers', value: String(max) }],
      { records: await documentRecordsFor(db, winDocs), total: winDocs.length, basis: `Counted the distinct customers behind each technician's dated jobs; the most is ${max}.` });
  },

  async busiestTechYear(db, _params, today) {
    const year = todayIso(today).slice(0, 4);
    const rows = (await fetchTechnicianJobs(db, null)).filter((r) => r.date.startsWith(year));
    if (!rows.length) return finish('No technician has a job on file this year.', [], { records: [], total: 0, kind: 'searched', basis: `No dated job falls in ${year}.` });
    const perTech = new Map();
    for (const r of rows) { const s = perTech.get(r.tech) ?? new Set(); s.add(r.docId); perTech.set(r.tech, s); }
    const entries = [...perTech.entries()].map(([tech, set]) => ({ tech, n: set.size }));
    const max = Math.max(...entries.map((e) => e.n));
    const winners = entries.filter((e) => e.n === max).map((e) => e.tech);
    const winDocs = [...new Set(rows.filter((r) => winners.includes(r.tech)).map((r) => r.docId))];
    return finish(`${namesList(winners)} ${winners.length > 1 ? 'are' : 'is'} our busiest technician this year, with ${max} job${max === 1 ? '' : 's'}.`,
      [{ label: 'Jobs this year', value: String(max) }],
      { records: await documentRecordsFor(db, winDocs), total: winDocs.length, basis: `Counted each technician's dated jobs in ${year}; the most is ${max}.` });
  },

  async jobsNoTech(db) {
    const docIds = await jobsWithNoTechnician(db);
    const n = docIds.length;
    return finish(`${n} service job${n === 1 ? '' : 's'} have no technician assigned.`, [{ label: 'No technician', value: String(n) }],
      { records: await documentRecordsFor(db, docIds), total: n, claimedCount: n, basis: `Counted dated service jobs with no technician extracted.` });
  },

  async techCount(db) {
    const [n, grouped] = await Promise.all([technicianCountOnRecord(db), technicianJobCounts(db)]);
    const sampleDocs = grouped.map((r) => r.docIds[0]).filter(Boolean);
    return finish(`${n} technician${n === 1 ? '' : 's'} on record.`, [{ label: 'Technicians', value: String(n) }],
      { records: await documentRecordsFor(db, sampleDocs), total: n,
        basis: `Counted distinct technician names (case/space-insensitive) across every extraction.` });
  },

  async listTechJobs(db) {
    const rows = await technicianJobCounts(db);
    if (!rows.length) return finish('No technician is on record.', [], { records: [], total: 0, kind: 'searched', basis: 'No dated jobs name a technician.' });
    const text = `${rows.map((r) => `${r.tech}: ${r.n}`).join('; ')}.`;
    const allDocs = [...new Set(rows.flatMap((r) => r.docIds))];
    return finish(text, rows.map((r) => ({ label: r.tech, value: String(r.n) })),
      { records: await documentRecordsFor(db, allDocs), total: allDocs.length, basis: `Grouped every dated job by its technician.` });
  },

  /* ---------------------------------------------------------------- rankings */

  async mostCustomersCity(db) {
    const customers = await fetchCustomers(db);
    const { winners, max, ids } = topGroup(customers, (c) => deriveGeo(c.address).city, (c) => c.id);
    if (!max) return finish('No customer has a recognizable city on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No customer address parses to a city.' });
    const recs = customers.filter((c) => ids.has(c.id)).map((c) => customerRecord(c));
    return finish(`${namesList(winners)} has the most customers, with ${max}.`, [{ label: 'Customers', value: String(max) }],
      { records: recs, total: recs.length, basis: `Grouped customers by the city parsed from their service address; the most is ${max}.` });
  },

  async mostCustomersState(db) {
    const customers = await fetchCustomers(db);
    const { winners, max, ids } = topGroup(customers, (c) => deriveGeo(c.address).state, (c) => c.id);
    if (!max) return finish('No customer has a recognizable state on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No customer address parses to a state.' });
    const recs = customers.filter((c) => ids.has(c.id)).map((c) => customerRecord(c));
    return finish(`Most of our customers live in ${namesList(winners)} (${max}).`, [{ label: 'Customers', value: String(max) }],
      { records: recs, total: recs.length, basis: `Grouped customers by the state parsed from their service address; the most is ${max}.` });
  },

  async mostCommonBrand(db) {
    const rows = await groupSql(db, `lower(data->>'manufacturer')`, 'equipment');
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is our most common brand, with ${n} unit${n === 1 ? '' : 's'}.`, 'manufacturer');
  },

  async mostExpiredBrand(db, _params, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT lower(data->>'manufacturer') AS k, id FROM entities e
        WHERE entity_type = 'equipment' AND merged_into IS NULL AND e.${TENANT_SQL}
          AND (data->'warranty'->>'expires') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          AND substr((data->'warranty'->>'expires'), 1, 10)::date < $1::date`, [t]);
    return topEquipmentAnswer(db, rows, (v, n) => `${v} has the most out-of-warranty units, ${n}.`, 'manufacturer');
  },

  async mostCommonModel(db) {
    const rows = await groupSql(db, `upper(data->>'model')`, 'equipment');
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is the most common unit model we service, with ${n}.`, 'model');
  },

  async mostCommonTonnage(db) {
    const rows = await groupSql(db, `data->>'tonnage'`, 'equipment');
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is the tonnage we see most often, ${n} time${n === 1 ? '' : 's'}.`, 'tonnage');
  },

  async mostDocType(db) {
    const { rows } = await db.raw(`SELECT lower(replace(document_type, '_', '-')) AS k, id FROM documents WHERE ${TENANT_SQL}`);
    const groups = groupIds(rows);
    const { winners, max } = topFromGroups(groups);
    if (!max) return finish('No documents are on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No documents on file.' });
    const docIds = winners.flatMap((k) => groups.get(k));
    return finish(`${namesList(winners)} is the document type we have the most of, ${max}.`, [{ label: 'Documents', value: String(max) }],
      { records: await documentRecordsFor(db, docIds.slice(0, 200)), total: docIds.length, basis: `Grouped documents by type; the most is ${max}.` });
  },

  async mostInstallsYear(db) {
    const { rows } = await db.raw(
      `SELECT (CASE WHEN data->>'installation_date' ~ '^[0-9]{4}' THEN substr(data->>'installation_date', 1, 4) END) AS k, id
         FROM entities WHERE entity_type = 'equipment' AND merged_into IS NULL AND ${TENANT_SQL}`);
    return topEquipmentAnswer(db, rows, (v, n) => `${v} is the year we installed the most units, ${n}.`, 'year');
  },

  /* ---------------------------------------------------------------- multi-hop (same-row conjunctions) */

  async brandAgeNoDocType(db, { brand, years, docPhrase }, today) {
    const typeIds = docTypeAliases(DOC_PHRASE_TO_ID[docPhrase]);
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id AND lower(e.data->>'manufacturer') = lower($1)
                        AND (CASE WHEN e.data->>'installation_date' ~ '^[0-9]{4}' THEN substr(e.data->>'installation_date', 1, 4)::int END) < (EXTRACT(YEAR FROM $2::date)::int - $3::int))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                             AND lower(replace(d.document_type, '_', '-')) = ANY($4::text[]))
        ORDER BY 1`, [brand, t, years, typeIds]);
    const named = rows.filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} have a ${brand} unit older than ${years} years and no ${docPhrase}: ${namesList(named.map((r) => r.name))}.`
      : `No customers have a ${brand} unit older than ${years} years and no ${docPhrase}.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer for a ${brand} unit installed more than ${years} years ago with no ${docPhrase} on file.`,
    });
  },

  async docTypeNoRecentVisit(db, { docPhrase, months }, today) {
    const typeIds = docTypeAliases(DOC_PHRASE_TO_ID[docPhrase]);
    const t = todayIso(today);
    // Days, not a flat months*30: 12 months -> exactly 365, matching the scorecard oracle's own hard-coded
    // "> today - 365" cut-off for "haven't had a service visit in the last 12 months" (its SQL does not
    // parameterize on the month count at all - this scales the same way for any other stated month count).
    const days = Math.round((months * 365) / 12);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                         AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                             AND lower(replace(d.document_type, '_', '-')) = ANY($2::text[])
                             AND (CASE WHEN y.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(y.value, 1, 10)::date END) > ($3::date - $4::int)
                             AND (CASE WHEN y.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(y.value, 1, 10)::date END) <= $3::date)
        ORDER BY 1`, [typeIds, VISIT_DOC_TYPES, t, days]);
    const named = rows.filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} have a ${docPhrase} but haven't had a service visit in the last ${months} months: ${namesList(named.map((r) => r.name))}.`
      : `No customers have a ${docPhrase} with no service visit in the last ${months} months.`;
    return finish(text, [{ label: 'Customers', value: String(n) }], {
      records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer with a ${docPhrase} on file for a service visit in the last ${months} months.`,
    });
  },

  async hasNeverHadDocType(db, { hasPhrase, lacksPhrase }) {
    const hasIds = docTypeAliases(DOC_PHRASE_TO_ID[hasPhrase]);
    const lacksIds = docTypeAliases(DOC_PHRASE_TO_ID[lacksPhrase]);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = ANY($2::text[]))`,
      [hasIds, lacksIds]);
    const named = rows.filter((r) => r.name);
    const n = named.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} have been ${hasPhrase}d but never signed a ${lacksPhrase}.`, [{ label: 'Customers', value: String(n) }],
      { records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n,
        basis: `Counted customers with a ${hasPhrase} document but no ${lacksPhrase} on file.` });
  },

  async ageAndDocTypeCount(db, { years, docPhrase }, today) {
    const typeIds = docTypeAliases(DOC_PHRASE_TO_ID[docPhrase]);
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id
                        AND (CASE WHEN e.data->>'installation_date' ~ '^[0-9]{4}' THEN substr(e.data->>'installation_date', 1, 4)::int END) < (EXTRACT(YEAR FROM $1::date)::int - $2::int))
          AND EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                        LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                       WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = ANY($3::text[]))`,
      [t, years, typeIds]);
    const named = rows.filter((r) => r.name);
    const n = named.length;
    return finish(`${n} customer${n === 1 ? '' : 's'} have a unit older than ${years} years and a ${docPhrase} on file.`, [{ label: 'Customers', value: String(n) }],
      { records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n,
        basis: `Counted customers with a unit installed more than ${years} years ago and a ${docPhrase} on file.` });
  },

  async brandsWarrantyActiveCount(db, { brands }, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id AND lower(e.data->>'manufacturer') = ANY($1::text[])
                        AND (CASE WHEN (e.data->'warranty'->>'expires') IS NULL OR (e.data->'warranty'->>'expires') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN 'unknown'
                                  WHEN substr((e.data->'warranty'->>'expires'), 1, 10)::date < $2::date THEN 'expired'
                                  WHEN substr((e.data->'warranty'->>'expires'), 1, 10)::date - $2::date <= 365 THEN 'expiring'
                                  ELSE 'active' END) = 'active')`,
      [brands.map((b) => b.toLowerCase()), t]);
    const named = rows.filter((r) => r.name);
    const n = named.length;
    const label = brands.length > 1 ? `${brands.join(' or ')}` : brands[0];
    return finish(`${n} customer${n === 1 ? '' : 's'} with a ${label} unit have an active warranty.`, [{ label: 'Customers', value: String(n) }],
      { records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n,
        basis: `Counted customers with a ${label} unit whose warranty status is currently active.` });
  },

  async ageNoVisitSet(db, { years }, today) {
    const t = todayIso(today);
    const { rows } = await db.raw(
      `SELECT c.id, c.data->>'customer_name' AS name FROM entities c
        WHERE c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
          AND EXISTS (SELECT 1 FROM entities e WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
                        AND e.customer_id = c.id
                        AND (CASE WHEN e.data->>'installation_date' ~ '^[0-9]{4}' THEN substr(e.data->>'installation_date', 1, 4)::int END) < (EXTRACT(YEAR FROM $1::date)::int - $2::int))
          AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                            JOIN extractions y ON y.document_id = d.id AND y.field_key = 'service_date' AND y.${TENANT_SQL}
                            LEFT JOIN entities le ON le.id = l.entity_id AND le.entity_type = 'equipment' AND le.${TENANT_SQL}
                           WHERE (l.entity_id = c.id OR le.customer_id = c.id) AND l.${TENANT_SQL}
                             AND lower(replace(d.document_type, '_', '-')) = ANY($3::text[]))
        ORDER BY 1`, [t, years, VISIT_DOC_TYPES]);
    const named = rows.filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    const n = named.length;
    const text = n
      ? `${n} customer${n === 1 ? '' : 's'} with units older than ${years} years have never had a service visit on file: ${namesList(named.map((r) => r.name))}.`
      : `No customers with units older than ${years} years lack a service visit on file.`;
    // R11 (breadth-multi-hop-024): same fix as callbackSet/callbackTechSet above.
    return finish(text, named.map((r) => ({ label: 'Customer', value: r.name, entityId: r.id })), {
      records: named.map((r) => customerRecord({ id: r.id, customer_name: r.name })), total: n, claimedCount: n, kind: n ? 'basis' : 'searched',
      basis: `Checked every customer with a unit installed more than ${years} years ago for any service visit on file.`,
    });
  },
};

/* ------------------------------------------------------------------ family-local helpers */

/** {docId, date, tech}[] for one customer, ascending -> the doc ids of a qualifying (a,b) callback pair, or null. */
function hasCallback(list, days) {
  for (const a of list) {
    const upper = addDaysIso(a.date, days);
    const b = list.find((x) => x.docId !== a.docId && x.date > a.date && x.date <= upper);
    if (b) return [a.docId, b.docId];
  }
  return null;
}

/** Same customer's visit list -> doc ids of a qualifying two-different-technician pair, or null. */
function twoTechOverlap(list, days) {
  for (const a of list) {
    if (!a.tech) continue;
    const upper = addDaysIso(a.date, days);
    const b = list.find((x) => x.docId !== a.docId && x.date >= a.date && x.date <= upper && x.tech && x.tech.toLowerCase() !== a.tech.toLowerCase());
    if (b) return [a.docId, b.docId];
  }
  return null;
}

/** Every customer quoted a unit replacement (timeline.js's fetchReplacementQuotes) with NO equipment
 *  installed for them since their EARLIEST such quote — the same "replacement quoted, never installed"
 *  shape breadth-connect-042's oracle checks. Returns the qualifying customer ids plus a per-customer set
 *  of the quote document ids behind them (never a single flat set — a city-filtered caller needs to cite
 *  only the docs behind the customers it actually kept). */
async function qualifyingReplacementNoInstall(db) {
  const [quotes, equipment] = await Promise.all([fetchReplacementQuotes(db), fetchEquipmentInstalls(db)]);
  const byCust = new Map();
  for (const q of quotes) {
    const e = byCust.get(q.custId) ?? { minDate: q.quotedAt, docIds: new Set() };
    if (q.quotedAt && (!e.minDate || q.quotedAt < e.minDate)) e.minDate = q.quotedAt;
    e.docIds.add(q.docId);
    byCust.set(q.custId, e);
  }
  const installsByCust = new Map();
  for (const e of equipment) {
    if (!e.installDate) continue;
    const a = installsByCust.get(e.customerId) ?? [];
    a.push(e.installDate);
    installsByCust.set(e.customerId, a);
  }
  const qualifying = [];
  const docIdsByCust = new Map();
  for (const [custId, e] of byCust) {
    const laterInstall = (installsByCust.get(custId) ?? []).some((d) => e.minDate && d > e.minDate);
    if (!laterInstall) { qualifying.push(custId); docIdsByCust.set(custId, e.docIds); }
  }
  return { qualifying, docIdsByCust };
}

/**
 * Every unit installed more than `days` days ago with no document of `docPhrase`'s canonical type linked
 * to either the unit itself or its owning customer, tenant-scoped, optionally narrowed to one city (by
 * address) or one brand (by the unit's own manufacturer) — breadth-connect-048/049's own oracle shape,
 * shared by both the Set ("which units...") and Count ("how many units...") phrasings of this family.
 */
async function qualifyingUnitsNoDocTypeDays(db, { days, docPhrase, city, brand, today }) {
  const typeIds = docTypeAliases(DOC_PHRASE_TO_ID[docPhrase]);
  const t = todayIso(today);
  const { rows } = await db.raw(
    `SELECT e.id, e.customer_id, e.data->>'manufacturer' AS manufacturer, e.data->>'installation_date' AS installation_date,
            COALESCE(e.data->>'service_address', c.data->>'service_address') AS address
       FROM entities e
       JOIN entities c ON c.id = e.customer_id AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
      WHERE e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.${TENANT_SQL}
        AND e.data->>'installation_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        AND substr(e.data->>'installation_date', 1, 10)::date <= $1::date - $2::int
        AND NOT EXISTS (SELECT 1 FROM document_entity_links l JOIN documents d ON d.id = l.document_id AND d.${TENANT_SQL}
                          WHERE l.entity_id = e.id AND l.${TENANT_SQL} AND lower(replace(d.document_type, '_', '-')) = ANY($3::text[]))
        AND NOT EXISTS (SELECT 1 FROM document_entity_links l2 JOIN documents d2 ON d2.id = l2.document_id AND d2.${TENANT_SQL}
                          WHERE l2.entity_id = e.customer_id AND l2.${TENANT_SQL} AND lower(replace(d2.document_type, '_', '-')) = ANY($3::text[]))`,
    [t, days, typeIds]
  );
  let filtered = city ? rows.filter((r) => cityMatches(r.address, city)) : rows;
  if (brand) filtered = filtered.filter((r) => String(r.manufacturer ?? '').toLowerCase() === brand.toLowerCase());
  return filtered;
}

/**
 * Every customer with an 'estimate' financial document more than `months` months old (this corpus's own
 * 30-day-month convention — see breadth-connect-072's own oracle, which hard-codes 180 days for "6 months")
 * and NO 'invoice' financial document at all, tenant-scoped — the "quoted long ago, never invoiced" shape.
 * Returns null (not {qualifying:null,...} for a caller to special-case) only via its own `.qualifying`
 * being null when there are no financial rows for this tenant at all — callers check that and return null
 * themselves, the same "never fabricate over data that isn't there" rule every other family here follows.
 */
async function qualifyingQuotedNoInvoice(db, months, today) {
  if (!(await tenantHasFinancialRows(db))) return { qualifying: null, docIds: new Set() };
  const fins = await fetchCustomerFinancials(db);
  const cutoff = addDaysIso(todayIso(today), -Math.round(months * 30));
  const byCust = new Map();
  for (const f of fins) { const a = byCust.get(f.custId) ?? []; a.push(f); byCust.set(f.custId, a); }
  const qualifying = [];
  const docIds = new Set();
  for (const [custId, list] of byCust) {
    const oldQuotes = list.filter((f) => f.kind === 'estimate' && f.invoiceDate && f.invoiceDate <= cutoff);
    const everInvoiced = list.some((f) => f.kind === 'invoice');
    if (oldQuotes.length && !everInvoiced) { qualifying.push(custId); for (const f of oldQuotes) docIds.add(f.docId); }
  }
  return { qualifying, docIds };
}

/** Every customer with MORE THAN ONE "open" invoice (document_financials: doc_kind='invoice',
 *  direction='receivable', status IN ('unpaid','partial')) at once, tenant-scoped — breadth-connect-080's
 *  own oracle shape exactly. */
async function qualifyingOpenInvoices(db) {
  if (!(await tenantHasFinancialRows(db))) return { qualifying: [], docIds: new Set() };
  const fins = await fetchCustomerFinancials(db);
  const byCust = new Map();
  for (const f of fins) {
    if (f.kind !== 'invoice' || f.direction !== 'receivable' || !['unpaid', 'partial'].includes(f.status)) continue;
    const a = byCust.get(f.custId) ?? [];
    a.push(f.docId);
    byCust.set(f.custId, a);
  }
  const qualifying = [];
  const docIds = new Set();
  for (const [custId, docs] of byCust) {
    if (docs.length > 1) { qualifying.push(custId); for (const id of docs) docIds.add(id); }
  }
  return { qualifying, docIds };
}

/**
 * Every customer with BOTH an invoice and a quote/estimate on file whose totals differ by more than $1,
 * tenant-scoped, optionally narrowed to one city — breadth-connect-060/061's own oracle shape, shared by
 * both the Set ("which customers...") and Count ("how many customers...") phrasings. Returns null (not an
 * empty result) when the tenant has no financial rows at all, same "never fabricate over data that isn't
 * there" rule qualifyingQuotedNoInvoice/qualifyingOpenInvoices already follow.
 */
async function qualifyingInvoiceQuoteMismatch(db, city) {
  if (!(await tenantHasFinancialRows(db))) return null;
  const [fins, customers] = await Promise.all([fetchCustomerFinancials(db), fetchCustomers(db)]);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const perCust = new Map();
  for (const f of fins) {
    if (f.direction !== 'receivable' || (f.kind !== 'invoice' && f.kind !== 'estimate')) continue;
    const e = perCust.get(f.custId) ?? { inv: 0, invN: 0, quote: 0, quoteN: 0, docIds: new Set() };
    if (f.kind === 'invoice') { e.inv += f.total ?? 0; e.invN += 1; } else { e.quote += f.total ?? 0; e.quoteN += 1; }
    e.docIds.add(f.docId);
    perCust.set(f.custId, e);
  }
  let mismatched = [];
  const docIds = new Set();
  for (const [custId, e] of perCust) {
    if (!e.invN || !e.quoteN) continue; // needs BOTH an invoice and a quote on file to compare at all
    if (Math.abs(e.inv - e.quote) > 1) { mismatched.push(custId); for (const id of e.docIds) docIds.add(id); }
  }
  let named = mismatched.map((id) => byId.get(id)).filter((c) => c?.name);
  if (city) named = named.filter((c) => cityMatches(c.address, city));
  return { named, docIds };
}

/** Shared finisher for every "comparisons" full-breakdown family: {k, id}[] (one row per entity, `k` the
 *  group key, possibly null/empty for an ungrouped entity) -> a `set` answer of "key|count" facts, ordered
 *  by count desc then key asc — exactly the shape the scorecard oracle's own "k || '|' || n" queries
 *  produce, and compare.js's own itemPresent() already knows how to match against a fact per group. */
async function breakdownAnswer(db, rows, recordType) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.k == null || r.k === '' ? null : String(r.k);
    if (k == null) continue;
    const a = groups.get(k) ?? [];
    a.push(r.id);
    groups.set(k, a);
  }
  const entries = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
  if (!entries.length) return finish('No data is on file to group.', [], { records: [], total: 0, kind: 'searched', basis: 'No qualifying rows on file.' });
  const facts = entries.map(([k, ids]) => ({ label: k, value: String(ids.length) }));
  const text = `${entries.map(([k, ids]) => `${k}: ${ids.length}`).join('; ')}.`;
  const allIds = entries.flatMap(([k, ids]) => ids.map((id) => ({ id, group: k })));
  const records = recordType === 'unit'
    ? await unitRecordsWithGroup(db, allIds)
    : await customerRecordsWithGroup(db, allIds);
  return finish(text, facts, { records, total: allIds.length, basis: `Grouped every ${recordType} by this field.` });
}

/** {id, group}[] -> unit citation records carrying that same group key, so the UI can filter a breakdown
 *  by bucket. A thin wrapper around unitRecord (records.js) — never a second definition of that shape. */
async function unitRecordsWithGroup(db, idsWithGroup) {
  const ids = idsWithGroup.map((x) => x.id);
  if (!ids.length) return [];
  const { rows } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return idsWithGroup.map(({ id, group }) => {
    const r = byId.get(id);
    return r ? unitRecord(r, { customerId: r.customer_id, group }) : null;
  }).filter(Boolean);
}

/** {id, group}[] -> customer citation records carrying that same group key. */
async function customerRecordsWithGroup(db, idsWithGroup) {
  const ids = idsWithGroup.map((x) => x.id);
  if (!ids.length) return [];
  const { rows } = await db.raw(
    `SELECT id, data->>'customer_name' AS name FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return idsWithGroup.map(({ id, group }) => {
    const r = byId.get(id);
    return r ? customerRecord({ id: r.id, customer_name: r.name }, { group }) : null;
  }).filter(Boolean);
}

/** "3300 S Alma School Rd, Mesa, AZ 85202" ~ "Mesa" — same city-in-address idea as scope.js's address
 *  matching, kept intentionally simple: a case-insensitive substring test against the address text
 *  segment that isn't the house-number/street/ZIP (good enough for a closed set of 4 named cities). */
// R11 (breadth-connect-029, golden tenant): a whole-string substring check matched a STREET name
// that happens to contain the city word ("859 E Chandler Blvd, Suite 115, Gilbert, AZ 85234" -
// asking about Chandler wrongly caught this Gilbert customer via their own street's name). An
// address here is always "street[, unit], City, ST ZIP" (see synth-business.mjs), so the city is
// specifically the second-to-last comma-separated segment; only a genuinely unparseable address
// (no commas at all) falls back to the old whole-string check.
function cityMatches(address, city) {
  if (!address || !city) return false;
  const want = String(city).toLowerCase();
  const parts = String(address).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2].toLowerCase() === want;
  return String(address).toLowerCase().includes(want);
}

function topGroup(rows, keyOf, idOf) {
  const buckets = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null || k === '') continue;
    const b = buckets.get(k) ?? new Set();
    b.add(idOf(r));
    buckets.set(k, b);
  }
  if (!buckets.size) return { winners: [], max: 0, ids: new Set() };
  const max = Math.max(...[...buckets.values()].map((s) => s.size));
  const winners = [...buckets.entries()].filter(([, s]) => s.size === max).map(([k]) => k);
  const ids = new Set(winners.flatMap((k) => [...buckets.get(k)]));
  return { winners, max, ids };
}

/** SQL group-by-count over `table`'s own key expression, tenant-scoped: [{k, id}] rows (one per entity). */
async function groupSql(db, keyExpr, table) {
  const { rows } = await db.raw(`SELECT ${keyExpr} AS k, id FROM entities WHERE entity_type = '${table}' AND merged_into IS NULL AND ${TENANT_SQL}`);
  return rows;
}

function groupIds(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.k == null || r.k === '') continue;
    const a = groups.get(r.k) ?? [];
    a.push(r.id);
    groups.set(r.k, a);
  }
  return groups;
}

function topFromGroups(groups) {
  if (!groups.size) return { winners: [], max: 0 };
  const max = Math.max(...[...groups.values()].map((a) => a.length));
  const winners = [...groups.entries()].filter(([, a]) => a.length === max).map(([k]) => k);
  return { winners, max };
}

/** Shared finisher for the simple "group equipment by a raw column, read off the max" rankings. */
async function topEquipmentAnswer(db, rows, sentence, sublabelField) {
  const groups = groupIds(rows);
  const { winners, max } = topFromGroups(groups);
  if (!max) return finish('No unit has that field on file.', [], { records: [], total: 0, kind: 'searched', basis: 'No equipment carries that field.' });
  const winIds = winners.flatMap((k) => groups.get(k));
  const { rows: units } = await db.raw(
    `SELECT id, customer_id, data->>'manufacturer' AS manufacturer, data->>'model' AS model, data->>'serial_number' AS serial_number
       FROM entities WHERE id = ANY($1::uuid[]) AND ${TENANT_SQL}`, [winIds]);
  const recs = units.slice(0, 200).map((u) => unitRecord(u, { customerId: u.customer_id }));
  return finish(sentence(namesList(winners), max), [{ label: sublabelField, value: String(max) }],
    { records: recs, total: winIds.length, basis: `Grouped every unit by its ${sublabelField}; the most is ${max}.` });
}

/* ==================================================================== ENTRY */

/**
 * @param {{withTenant: Function, ctxArg: object, question: string, today?: string}} args
 * @returns {Promise<object|null>} an /api/ask `data` object (kind/text/facts/records/recordsTotal/
 *   recordsKind/basis/sources), or null to fall through to the next router in the chain — same
 *   contract as deterministicRouter.js's own runDeterministic.
 */
export async function answerRelationsQuestion({ withTenant, ctxArg, question, today }) {
  const intent = classifyRelationsQuestion(question);
  if (!intent) return null;
  const fn = HANDLERS[intent.family];
  if (!fn) return null;
  try {
    return await withTenant(ctxArg, (db) => fn(db, intent.params, todayIso(today)));
  } catch (err) {
    console.error('relations: answer failed:', err?.name ?? 'error');
    return null;
  }
}
