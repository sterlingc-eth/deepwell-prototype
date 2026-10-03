/**
 * Document-lookup-by-customer/address-and-type pre-router (live 100-question
 * persona sample, 2026-09-22, cluster 1): "do we have a PO on file for the
 * Norwood job", "list invoices for Fitzgerald", "did we pull a permit for
 * 322 N Greenfield Rd", "what proposal did we give Amy Isaacson", "startup
 * sheet for the Prentiss install", "Thomas Mercer invoices" — all name a
 * document TYPE plus a customer/address, with a real, deterministic yes/no
 * answer sitting in `documents` — retrieval has nothing to cite for a
 * question like this (there is no page that SAYS "3 invoices on file"), so
 * these fell through to "Nothing in your records answers that" before this
 * file existed.
 *
 * Wired into api/ask.js right after the contact-lookup pre-router and before
 * the money gate/analytics — same "pure shape detection, no model call ever"
 * contract contactLookup.js documents for itself. `runDocLookup` is the only
 * function here that touches `db`; everything else is pure and unit-tested
 * with no database (scripts/verify-doclookup.mjs).
 *
 * Deliberately conservative about what counts as a match — see
 * parseDocLookupQuestion's own doc comment for the "must not hijack an
 * analytics/retrieval question" guards this shares with contactLookup.js.
 */
import { localYmdIn } from "./util/localDate.js";
import { correctTriggerWordTypos, normalizeQuestion } from "./nlNormalize.js";
import { ENTITY_SYNONYMS, STREET_ADDRESS_RE, KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from "./analytics.js";
import { docTypeFromWord, docTypeSynonymAlternation, documentTypeLabel, DOCTYPE_TRIGGER_WORDS } from "./documentTypes.js";
import { mergeDocumentVia } from "./routes/customers.js";
// TEAM C (citations everywhere): every branch below states what it searched / read.
import { isPoMoneyQuestion } from "./lookups/vendorPo.js";
import { answerInternalMemos } from "./lookups/internalMemos.js";
import { attachCitations, customerRecord, documentRecord } from "./citations/records.js";
import { documentRecordsFor } from "./citations/enrich.js";
import { withTypoNote } from "./lookups/typoResolve.js";
import { resolveAddressCandidates, nameTokens, resolveNamedCustomers, resolveContactCandidatesDetailed, corroboratesCandidate } from "./contactLookup.js";
// Team A (2026-09-24): address/name scopes that include EVERY customer and unit at an address (apartments), the same
// document union the customer profile uses, and legacy-tolerant document-type matching.
import { resolveAddressScope, scopeFromCustomers, scopeDocumentIds, extractUnitDesignator, docTypeAliases, typeSql } from "./scope.js";
// R16 F3 (compound questions): "whats the model and serial on the unit at
// <address>" / "is Abernathy still under warranty and whos the tech that did
// it" — two sub-asks in one question, neither a document-type lookup at all.
// See parseDocLookupQuestion/runDocLookup's own dispatch below, and
// lookups/compound.js's own header comment for why this is wired in HERE
// rather than through a new api/ask.js call site.
import { parseCompoundQuestion, runCompound } from "./lookups/compound.js";
// R19 (I1, owner ask (a)/audience adoption): internal/team-only documents must never feed a
// customer-scoped document-list answer here unless the question itself is about team/internal
// material — see fastPath.js's isTeamScopedQuestion and audience/sql.js's own header.
import { documentsHaveAudience } from "./audience/probe.js";
import { audienceFilterSql, AUDIENCE_FALLBACK_FIELD_KEY } from "./audience/sql.js";
import { isTeamScopedQuestion } from "./fastPath.js";

/* ============================================================ shape detection */

// Round 6 (2026-09-25): "list invoides for delgado" (a typo of "invoices") never matched DOCTYPE_WORD_RE at all.
// nlNormalize.js's general fuzzy corrector already knows "invoides" is one substitution away from "invoices", but
// this question ALSO carries a trailing "for <name>" reference (analytics.js's own hasTrailingNameReference), which
// flags the WHOLE question as a single-record reference and makes normalizeQuestion skip correcting EVERY word in
// it, not just "delgado" — the doctype word earlier in the sentence never gets a chance either. Every individual
// word across DOCUMENT_TYPE_SYNONYMS is exactly the kind of small, closed, unconditional-of-singleRecord trigger
// vocabulary correctTriggerWordTypos (nlNormalize.js) exists for (see deterministicRouter.js's own use of it for
// the same class of bug) — applied here, before normalizeQuestion, so a customer name later in the question is
// still left completely alone.
// R15 (Team C): re-exported here for anything already importing it from this file — the
// canonical definition now lives in documentTypes.js (see that file's own doc comment for why:
// this file already imports from contactLookup.js, so defining it here too and having
// contactLookup.js import it from here would create a genuine circular import).
export { DOCTYPE_TRIGGER_WORDS };

// R23 (D1, needs-model cluster C1: field-phrasing-3 i142-i157, shape "team_scoped"):
// "any memos for Kevin Pratt this week", "what did dispatch broadcast to the crew this
// morning", "any internal-only documents in the system at all". None of these name a
// recognized document TYPE — "memo"/"notice"/"writeup" are not in DOCUMENT_TYPE_SYNONYMS
// (documentTypes.js's own doc comment explains why 'internal' only lists "shop record[s]":
// an internal memo is free-text content, not one of the structured document types this
// file resolves) — so DOCTYPE_WORD_RE never fires and these fall all the way through to
// the model today. audience/sql.js's audienceFilterSql already exists to filter internal
// documents OUT of a customer-scoped answer (its own doc comment literally cites "any
// memos for Carlos this week" as the shape it was built for), but nothing before this
// round ever asked whether an internal-audience document exists AT ALL. This golden
// corpus has zero (verified against the identical COUNT the field-phrasing-3 oracle for
// these ids uses: documents.audience='internal' + the pre-migration _audience marker),
// so every one of these currently-needs-model questions has one honest, deterministic,
// citable answer. A tenant that DOES have internal documents gets `null` here (defer to
// the model) — there is no generalized "search internal documents by keyword/date"
// builder yet, and guessing at one would risk exactly the confident-wrong result the
// precision guard exists to catch.
//
// Deliberately excludes a bare "memo(s)" that collides with a business's own proper name
// ("invoices for Memo's Auto Repair", "invoices for Memos Auto Repair") — same collision
// class fastPath.js's TEAM_SCOPED_RE narrowing (the "for THE <word>" fix) exists for. THREE
// guards, all needed: (1) never match right before a possessive apostrophe ("Memo's");
// (2) the bare memo pattern is deliberately case-SENSITIVE (no /i) — genuine usage is
// always lowercase mid-sentence ("any memos for Kevin Pratt"), while a proper noun keeps
// its capital mid-sentence ("for Memos Auto Repair"). isInternalMemoQuestion lowercases
// only the question's OWN first character first, so a sentence-initial "Any memos..." still
// matches without also laundering a mid-sentence business name's capital letter.
// (3) (post-review hardening) never match right after "for "/"for the ": guards (1) and (2)
// both still let a real, casually-typed, all-lowercase business name through — "list invoices
// for memos auto repair" (no apostrophe, no capital — an entirely ordinary way a dispatcher
// types a company name in this app, per this whole file's own casual-phrasing conventions) — and
// that falsely swallowed a genuine document-type lookup (was answering "I couldn't find a
// customer named Memos Auto Repair" before this shape existed) into a flat "no internal
// documents" decline. Every genuine memo-question phrasing in this corpus (and everywhere else
// in this file) puts "for" AFTER "memo(s)" ("any memos FOR Kevin Pratt"), never before it, so
// excluding "for (the) memo(s)" closes this collision the same way the apostrophe/case guards
// close theirs, with no known-good phrasing lost.
const INTERNAL_MEMO_PATTERNS = [
  /(?<!\bfor )(?<!\bfor the )\bmemos?\b(?!')/,
  /\binternal(?:-only)?\s+(?:notes?|documents?|writeups?|write-?ups?|paperwork)\b/i,
  /\bstaff-only\s+paperwork\b/i,
  /\bteam-wide\s+notice\b/i,
  /\bteam\s+memo\b/i,
  /\bdispatch\s+(?:send|sent|broadcast(?:ed)?|circulate[ds]?)\b/i,
  /\b(?:office|management)\s+send\b/i,
];

function isInternalMemoQuestion(q) {
  const raw = String(q ?? "");
  if (!raw) return false;
  const s = raw.charAt(0).toLowerCase() + raw.slice(1);
  return INTERNAL_MEMO_PATTERNS.some((re) => re.test(s));
}

/** Count of internal-audience documents on file, tenant-scoped, summing both the
 *  post-migration `documents.audience` column and the pre-migration `_audience`
 *  extractions marker (same two sources audienceFilterSql filters by, and the exact
 *  shape the field-phrasing-3 i142-i157 oracle uses to compute its expected zero). */
async function countInternalDocuments(db) {
  const hasAudienceColumn = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  const queries = [
    db.raw(
      `SELECT count(*)::int AS n FROM extractions WHERE ${TENANT_SQL} AND field_key = '${AUDIENCE_FALLBACK_FIELD_KEY}' AND value = 'internal'`
    ),
  ];
  if (hasAudienceColumn) {
    queries.push(db.raw(`SELECT count(*)::int AS n FROM documents WHERE ${TENANT_SQL} AND audience = 'internal'`));
  }
  const results = await Promise.all(queries);
  return results.reduce((sum, r) => sum + Number(r.rows?.[0]?.n ?? 0), 0);
}

const DOCTYPE_ALT = docTypeSynonymAlternation();
// A trailing plural "s" is optional and NOT part of the alternation itself
// (most synonym entries are already plural, e.g. "invoices" — adding an
// optional "s" after the alternation would double-match those and is
// harmless either way since docTypeFromWord lowercases+trims before lookup).
const DOCTYPE_RE_SRC = `(?:${DOCTYPE_ALT})`;

// A name (1-5 words) or a street address (starts with a number) — lazy on the
// trailing-word repetition so an optional "job"/"install" suffix right after
// it is never swallowed into the capture (see this file's own header comment
// for the backtracking argument): "the Norwood job" -> name "Norwood", suffix
// "job" consumed separately.
//
// Reviewer NO-GO (2026-09-22): a full street address routinely carries a
// city (and state/zip) after a comma — "840 S Ellsworth Rd, Tucson", "322 N
// Greenfield Rd, Mesa, AZ 85201" — and a period for an abbreviated suffix
// ("St."). Both are now allowed inside each word token (never as a bare
// separator on their own — a comma/period always sits directly against a
// real word char), and the repetition cap is raised from 4 to 7 trailing
// words so a full "street, city, state zip" span (up to 8 words total) still
// fits before the lazy quantifier gives up and backtracks.
// R15 fix (Team C): an apartment/unit-numbered address adds TWO more words
// ("... Rd, Apt 101, Mesa, AZ 85201" is 10, not 8) that the 7-cap above
// silently dropped the whole match for (a real, on-file address with an
// apartment number never matched any SHAPE at all, unlike the same street
// with no apartment — see hvac-tech-0080/hvac-tech-0009 in scripts/verify-doclookup.mjs's
// negative cases). Raised to 9 trailing words (10 total) so a full "street,
// apt N, city, state zip" span still fits.
const NAME_OR_ADDRESS_SRC = `[A-Za-z0-9][A-Za-z0-9',.-]*(?:\\s+[A-Za-z0-9',.-]+){0,9}?`;
const TRAILING_JOB_RE_SRC = `(?:\\s+(?:job|install))?`;

const SHAPES = [
  // "do we have a PO on file for the Norwood job", "does anyone have a permit for 123 Main St"
  new RegExp(
    `^(?:do|does|did)\\s+(?:we|you)\\s+have\\s+(?:an?\\s+)?${DOCTYPE_RE_SRC}s?\\s*(?:on\\s+file\\s*)?(?:for|of)\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})${TRAILING_JOB_RE_SRC}\\s*\\??$`,
    "i"
  ),
  // R24 (E3, field-phrasing-3 i041-i047: "is there a permit on file for the Amy Jarvis job") — the
  // identical "do we have X on file for Y" shape just above, but framed as "is/are there" instead
  // of "do/does/did we/you have"; YES_NO_SHAPE_RE (below, used by runDocLookup's own yes/no
  // phrasing) already anticipated this exact opener, but nothing in SHAPES itself ever matched it,
  // so parseDocLookupQuestion returned null before runDocLookup's yes/no branch was ever reached at
  // all. Never overlaps the shape above (that one requires "do/does/did", this one "is/are").
  new RegExp(
    `^(?:is|are)\\s+there\\s+(?:an?\\s+|any\\s+)?${DOCTYPE_RE_SRC}s?\\s*(?:on\\s+file\\s*)?(?:for|of)\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})${TRAILING_JOB_RE_SRC}\\s*\\??$`,
    "i"
  ),
  // "did we pull a permit for 322 N Greenfield Rd"
  new RegExp(
    `^did\\s+we\\s+pull\\s+(?:an?\\s+)?${DOCTYPE_RE_SRC}\\s*(?:on\\s+file\\s*)?(?:for|of)\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})${TRAILING_JOB_RE_SRC}\\s*\\??$`,
    "i"
  ),
  // "list invoices for Fitzgerald", "show me all the proposals for Mercer"
  new RegExp(
    `^(?:list|show\\s+me)(?:\\s+all)?\\s+(?:the\\s+)?${DOCTYPE_RE_SRC}s?\\s*(?:for|of)\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})\\s*\\??$`,
    "i"
  ),
  // "what proposal did we give Amy Isaacson", "what quote did we give Wyckoff"
  new RegExp(`^what\\s+${DOCTYPE_RE_SRC}\\s+did\\s+we\\s+give\\s+(?:to\\s+)?(${NAME_OR_ADDRESS_SRC})\\s*\\??$`, "i"),
  // half-sentence: "startup sheet for the Prentiss install", "permit for 123 Main St"
  new RegExp(
    `^${DOCTYPE_RE_SRC}s?\\s*(?:for|of)\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})${TRAILING_JOB_RE_SRC}\\s*\\??$`,
    "i"
  ),
  // R16 F3 (misc-field generalization): "whats the po number for the job at
  // 1395 e ray rd" — same doctype+address shape as above, just "for the job
  // at <address>" instead of "for the <address> job", with an optional "#"/
  // "number" right after the doctype word (a PO/permit is routinely asked for
  // by its NUMBER, not the document itself).
  new RegExp(
    `^(?:what'?s|what\\s+is)\\s+the\\s+${DOCTYPE_RE_SRC}s?\\s*(?:#|number)?\\s+for\\s+the\\s+job\\s+at\\s+(${NAME_OR_ADDRESS_SRC})\\s*\\??$`,
    "i"
  ),
  // R16 F3: "permit # for 1728 W Ocotillo Rd" — the same half-sentence shape
  // right above, but with a "#"/"number" infix BETWEEN the doctype word and
  // "for" (the existing half-sentence shape has no room for one). The infix
  // is REQUIRED here (never optional) so this never doubly matches what the
  // existing half-sentence shape already covers with no infix at all.
  new RegExp(
    `^${DOCTYPE_RE_SRC}s?\\s*(?:#|number)\\s+for\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})${TRAILING_JOB_RE_SRC}\\s*\\??$`,
    "i"
  ),
  // R16 F3: "when does the maintenance agreement expire for Calloway" — an
  // expiration-date question about a document TYPE (maintenance agreement),
  // same "do we have this on file" answer underneath (runDocLookup never
  // actually extracts/states a date — see its own doc comment — an honest
  // "N on file: ..." or "no X on file" either answers or admits it can't say
  // the date, never fabricates one).
  new RegExp(
    `^when\\s+does\\s+(?:the\\s+)?${DOCTYPE_RE_SRC}\\s+expire\\s+for\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})\\s*\\??$`,
    "i"
  ),
  // R16 F3: "hows the service contract looking on 2394 S Higley Rd" — casual
  // dispatcher shorthand for "is there a maintenance agreement/contract on
  // file", same underlying question as the "do we have X on file" shapes
  // above.
  new RegExp(
    // "service " is optional and separate from DOCTYPE_RE_SRC itself: the
    // alternation only has "service ticket(s)" starting with that word, so
    // "service contract" (a real maintenance-agreement synonym, "contract",
    // preceded by the adjective "service") would otherwise never match
    // AT this fixed position — DOCTYPE_RE_SRC has to match starting
    // immediately after "the ", not somewhere later in the phrase.
    `^how'?s\\s+the\\s+(?:service\\s+)?${DOCTYPE_RE_SRC}\\s+looking\\s+(?:on|for|at)\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})\\s*\\??$`,
    "i"
  ),
];
// Each SHAPES regex has exactly one capture group (the name/address) except
// none carry a doctype capture group of their own — the doctype word itself
// is read from the FULL MATCH via DOCTYPE_WORD_RE below, since embedding a
// second capture group per alternative would require re-numbering every
// shape whenever the doctype list changes.
const DOCTYPE_WORD_RE = new RegExp(DOCTYPE_RE_SRC, "i");

// "Thomas Mercer invoices" — bare "<name> <doctype>", no connector at all.
// Anchored to the WHOLE string so this never fires on "how many invoices
// this year" (starts with a stopword, rejected by isRealNamePhrase below).
const NAME_DOCTYPE_RE = new RegExp(`^(${NAME_OR_ADDRESS_SRC})\\s+${DOCTYPE_RE_SRC}s?\\s*\\??$`, "i");

const MONTH_NAMES = new Set([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);
const TIME_WORDS = new Set([
  "today", "yesterday", "tomorrow", "year", "month", "week", "quarter", "ytd",
]);
// "list invoices for Gilbert" / "show me all the proposals for Chandler" —
// a CITY-scoped analytics question, not a customer/address one; without this
// guard the bare "<name> for <phrase>" shapes above happily captured a city
// name as if it were a surname. Same list GEO_WORD_RE (analytics.js) itself
// classifies on, so a city this corpus recognizes for one purpose is
// recognized for both.
const KNOWN_CITY_NAMES = new Set(
  [...KNOWN_AZ_CITY_NAMES, ...KNOWN_US_CITY_NAMES].map((c) => c.toLowerCase())
);

// "pull up list all our service tickets" / "need the list all our work
// orders" — the bare NAME_DOCTYPE_RE shape (no for/of connector) has no
// leading-filler stripping of its own the way contactLookup.js's "pull up
// <name>" shape does, so a statement-form quantifier phrase left the bare
// stopword check none the wiser (its first word, "pull"/"need"/"get", was
// never itself a stopword) and got captured as if it were a customer name —
// a real hijack of the "list all our X" analytics statement form. "pull",
// "need" and "get" added here for exactly that reason.
// R24 (E3, breadth-existence-019 regression — "is there a maintenance agreement on file for
// ANYONE?"): an indefinite pronoun, never a real customer name — this question is a portfolio-wide
// existence check ("does this exist for ANY customer at all"), correctly answered elsewhere
// (analytics), not a single-customer lookup. Before this round's new "is there ... on file for the
// ... job" SHAPES entry (see SHAPES below), no shape here ever reached this phrase at all, so the
// gap was harmless; now that one does, "anyone" was never in this list (only the bare "any" was)
// and slipped through as if it were a captured customer name, producing a confidently wrong "I
// couldn't find a customer named Anyone" instead of ever falling through to the real answer.
const NAME_STOPWORD_RE =
  /^(?:the|a|an|this|that|these|those|our|their|his|her|my|your|its|which|who|what|how|why|when|does|do|did|is|are|was|were|list|show|has|have|had|in|on|at|of|for|with|without|any|anyone|anybody|everyone|everybody|someone|somebody|some|all|last|next|first|second|third|most|many|few|several|pull|need|get)$/i;

const NAME_DESCRIPTOR_RE =
  /^(?:biggest|largest|smallest|oldest|newest|highest|lowest|overdue|accepted|declined|expired|pending|unpaid|average|avg|total|totals|sum|tally|tot|num|number|count|whats|can|grand|grande)$/i;

const AGGREGATE_WORD_RE = new RegExp(
  `\\b(${[...new Set([
    ...ENTITY_SYNONYMS.customers,
    ...ENTITY_SYNONYMS.equipment,
    ...ENTITY_SYNONYMS.serviceVisits,
    ...ENTITY_SYNONYMS.warranties,
  ])]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "i"
);

// R15 fix (Team C): "Do we have a PO on file for the Holbrook job?" — Holbrook is BOTH a real
// customer surname in this corpus AND a real Arizona town (KNOWN_AZ_CITY_NAMES), so the
// single-word-city guard below rejected it as a geo scope, same as it should for a bare "for
// Gilbert"/"for Chandler". The trailing "job"/"install" this file's own SHAPES capture separately
// (TRAILING_JOB_RE_SRC) is the tell: nobody asks for a PO/permit/invoice "on file for the
// <city> job" about a whole town, only about one customer's job — so a phrase followed by that
// marker is never the geo-scope reading, whatever it also happens to spell.
const TRAILING_JOB_WORD_RE = /\b(?:job|install)\s*\??\s*$/i;

// R20 (J2, lookup fixes — R19 blind-3 F1/i048-i053): "do we have a purchase order on file for
// the Amy Isaacson ACCOUNT" is a colloquial way of naming a customer ("the <name> account"),
// never a literal question about accounts-in-general — but AGGREGATE_WORD_RE above (shared with
// the "how many accounts do we have" analytics guard) matches the word "account" for exactly that
// reason, so a captured name phrase carrying this filler word as its LAST token was rejected
// whole by isRealNameOrAddressPhrase, parseDocLookupQuestion returned null, and the question fell
// through to an unrelated analytics template that answered the same wrong portfolio-wide count for
// six different customer names in a row. The SHAPES regexes already externalize a trailing
// "job"/"install" this same way (TRAILING_JOB_RE_SRC); this generalizes it to "account"/"customer"/
// "client" and works regardless of which SHAPE matched, by stripping the filler word from the
// capture itself rather than growing every regex.
const TRAILING_FILLER_WORD_RE = /\s+(?:account|accounts|customer|client|clients)\s*$/i;

function stripTrailingFillerWord(phrase) {
  const p = String(phrase ?? "").trim();
  const stripped = p.replace(TRAILING_FILLER_WORD_RE, "").trim();
  // Never strip down to nothing — a bare "the account"/"the customer" with no name at all still
  // isn't a name/address phrase; isRealNameOrAddressPhrase's own stopword/aggregate checks reject it.
  return stripped || p;
}

function isRealNameOrAddressPhrase(phrase, { trailingJob = false } = {}) {
  const p = String(phrase ?? "").trim();
  if (!p) return false;
  // Strip a trailing possessive/contraction ("what's" -> "what") before the
  // stopword check, so a leftover question-word fragment (only ever
  // produced by a shape mismatch — see "what's on the Mercer invoice" in
  // this file's own tests) is still caught.
  const firstWord = p.split(/\s+/)[0].toLowerCase().replace(/'s$/, "");
  if (NAME_STOPWORD_RE.test(firstWord)) return false;
  // R4 loop: a superlative / status / shorthand word is never the start of a customer name ("biggest invoice", "overdue invoices", "num of invoices").
  if (process.env.DONOVAN_NAME_DESCRIPTOR_GUARD !== "0" && NAME_DESCRIPTOR_RE.test(firstWord)) return false;
  if (MONTH_NAMES.has(firstWord) && p.split(/\s+/).length <= 2) return false; // "for august", "for august 2024"
  if (TIME_WORDS.has(firstWord)) return false;
  if (AGGREGATE_WORD_RE.test(p)) return false;
  // A bare, single-word phrase that's a known city name is a geo scope, not a
  // customer/address — "for Gilbert"/"for Chandler" — never a customer named
  // after their own city, so this errs toward the far more common case —
  // UNLESS a trailing "job"/"install" marker already says this is about one
  // customer's job, not the whole town (see this function's own doc comment).
  if (!trailingJob && p.split(/\s+/).length === 1 && KNOWN_CITY_NAMES.has(firstWord)) return false;
  return true;
}

function titleCase(s) {
  return String(s ?? "")
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/**
 * Pure: question text -> {doctype, namePhrase, isAddress} or null.
 * `doctype` is a canonical id from documentTypes.js's DOCUMENT_TYPES.
 * `isAddress` is true when namePhrase looks like a street address (starts
 * with a digit) — runDocLookup then resolves it against service_address
 * instead of customer_name.
 *
 * Deliberately conservative, same "return null rather than guess" contract
 * contactLookup.js's own parser documents — a shape/vocabulary miss here
 * defers to whatever would have handled the question anyway (analytics for
 * "how many invoices this year", retrieval for "show me the invoice from
 * March" / "what's on the Mercer invoice").
 */
export function parseDocLookupQuestion(question, opts = {}) {
  const overlay = opts?.overlay;
  const raw = String(question ?? "").trim();
  if (!raw) return null;

  // R23 (D1): flag the internal-memo shape here too (see isInternalMemoQuestion's own doc
  // comment) — this function is the ONLY thing the router's classifyAll.js calls to decide
  // whether ask.js's docLookupIntent gate is truthy at all; if this pure/sync function doesn't
  // recognize the shape, runDocLookup (and its own `parsed.internalMemo` branch) never runs.
  if (isInternalMemoQuestion(raw)) return { internalMemo: true };
  if (isPoMoneyQuestion(raw.toLowerCase())) return null; // PO spend/total (optionally per vendor) belongs to the finance handler, not a doc-listing lookup

  // R16 F3: a compound question ("model and serial", "name and phone", "under
  // warranty and whos the tech") never names a document TYPE at all, so it
  // has to be tried before the cheap DOCTYPE_WORD_RE reject just below would
  // throw it away. `compound: true` tells runDocLookup to dispatch to
  // lookups/compound.js instead of the document-type resolution beneath it.
  const compound = parseCompoundQuestion(raw);
  if (compound) return { compound: true, ...compound };

  const q = normalizeQuestion(correctTriggerWordTypos(raw, DOCTYPE_TRIGGER_WORDS), { overlay }).normalized;
  if (!q || !DOCTYPE_WORD_RE.test(q)) return null; // cheap reject before trying every shape

  for (const re of SHAPES) {
    const m = q.match(re);
    if (!m) continue;
    const namePhrase = stripTrailingFillerWord(m[1].trim());
    const trailingJob = TRAILING_JOB_WORD_RE.test(m[0]);
    if (!isRealNameOrAddressPhrase(namePhrase, { trailingJob })) continue;
    const doctypeWordMatch = m[0].match(DOCTYPE_WORD_RE);
    const doctype = doctypeWordMatch ? docTypeFromWord(doctypeWordMatch[0]) : null;
    if (!doctype) continue;
    return { doctype, namePhrase, isAddress: /^\d/.test(namePhrase) };
  }

  const bare = q.match(NAME_DOCTYPE_RE);
  if (bare) {
    const namePhrase = bare[1].trim();
    if (isRealNameOrAddressPhrase(namePhrase)) {
      // The doctype word is whatever comes AFTER the captured name, never a
      // doctype-shaped word matched inside the name itself (e.g. a company
      // named "Ticket Masters") — read it from the tail of the match, not
      // from a fresh search over the whole string.
      const tail = bare[0].slice(namePhrase.length).trim().replace(/\?$/, "").replace(/s$/i, "");
      const doctype = tail ? docTypeFromWord(tail) : null;
      if (doctype) return { doctype, namePhrase, isAddress: /^\d/.test(namePhrase) };
    }
  }

  return null;
}

/* ============================================================ DB resolution */

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const MAX_DOCS = 40;

/**
 * Returns `{ candidates, declined }` — `declined` non-null means the caller must return it as-is
 * (see resolveNamedCustomers' own doc comment, contactLookup.js). The address branch never goes
 * through the name-fuzzy guard at all (a house number + street name is never edit-distance
 * matched — see resolveAddressCandidates), so it always comes back with `declined: null`.
 */
async function resolveCandidates(db, question, namePhrase, isAddress) {
  // Reviewer NO-GO (2026-09-22, live 100-question sample): this used to call
  // resolveStreetCandidates, which ILIKEs the WHOLE captured phrase —
  // correct for the street-ONLY shape it was built for ("the guy on
  // Greenfield Road"), but wrong here, where namePhrase is a FULL address
  // that routinely carries a trailing city/state/zip a whole-string ILIKE
  // requires verbatim (see resolveAddressCandidates' own doc comment for why
  // that broke "322 N Greenfield Rd, Mesa, AZ 85201" even though that exact
  // customer exists). resolveAddressCandidates resolves on the house number
  // + street name alone instead, tolerant of everything after it.
  if (isAddress) return { candidates: await resolveAddressCandidates(db, namePhrase), declined: null };
  // R21 (M1, P0 — fp-4 cluster 5): a near-miss customer name must never resolve here with full
  // confidence just because it's the only fuzzy match — see resolveNamedCustomers.
  return resolveNamedCustomers(db, question, namePhrase);
}

/** Every document id reachable for a customer — same three paths ask.js's
 *  own resolveCustomerDocumentIds uses (direct link, equipment link/
 *  extraction, or a name+address text match) — duplicated here (rather than
 *  imported from api/ask.js, a top-level endpoint file) since both
 *  docLookup.js and contactLookup.js need it and neither should depend on
 *  ask.js. */
export async function customerDocumentIds(db, row) {
  const name = row?.customer_name ?? null;
  const address = row?.service_address ?? null;
  const [linkRows, nameMatchRows] = await Promise.all([
    db.listCustomerDocumentLinks(row.id),
    name && address ? db.listNameMatchedDocuments(name, address) : Promise.resolve([]),
  ]);
  const via = mergeDocumentVia([
    ...linkRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
    ...nameMatchRows.map((r) => ({ documentId: r.document_id, via: r.via, serial: r.serial })),
  ]);
  return via.map((v) => v.documentId);
}

function formatDateLabel(rawDate) {
  // The pg driver returns timestamptz columns (created_at) as Date objects; String(Date) printed "Mon Aug 31 2026 17:00:00 GMT-0700 (...)" in answers.
  const s = rawDate instanceof Date && !Number.isNaN(rawDate.getTime()) ? localYmdIn(rawDate) : String(rawDate ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s || "an unknown date";
  const MONTH_LABELS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return s;
  return `${MONTH_LABELS[idx]} ${Number(m[3])}, ${m[1]}`;
}

/**
 * Full orchestration: shape detection -> customer/address resolution ->
 * document query -> answer. Returns null when this isn't confidently a
 * doc-lookup question (the caller then falls through to the money gate/
 * analytics/retrieval exactly as if this file didn't exist).
 *
 * Never a model call, ever — `db` is used only for plain, tenant-scoped
 * reads. The source string 'doc-lookup' is never listed in usage.js's
 * COUNTABLE_ASK_SOURCES, so nothing here ever counts against the monthly ask
 * allowance (see api/ask.js's call site).
 */
const MAX_AGGREGATE_CANDIDATES = 8;
const YES_NO_SHAPE_RE = /^\s*(?:do|does|did|is there|are there|have we|has anyone)\b/i;

export function runDocLookup(db, question, opts = {}) {
  return withTypoNote(() => runDocLookupCore(db, question, opts));
}

async function runDocLookupCore(db, question, opts = {}) {
  const parsed = parseDocLookupQuestion(question, opts);
  if (!parsed) return null;
  // R23 (D1): parseDocLookupQuestion flags this shape (see isInternalMemoQuestion's own doc
  // comment) but can't itself resolve it — answering needs a COUNT, and that pure/sync function
  // never touches `db` by design — so the actual decline is built here, in the async
  // orchestration, exactly like the `compound` dispatch right below handles its own shape.
  if (parsed.internalMemo) {
    const memoAns = await answerInternalMemos(db, question);
    if (memoAns) return memoAns;
    const n = await countInternalDocuments(db);
    if (n === 0) {
      return attachCitations(
        {
          kind: "no-answer",
          text: "No internal-only documents (memos, dispatch notices, internal notes) are on file at all — there's nothing here to answer that with.",
          facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [],
        },
        { records: [], total: 0, kind: "searched", basis: "Checked for any internal-audience document on file (documents.audience = 'internal', or the pre-migration _audience marker); none exist." }
      );
    }
    return null; // real internal documents exist on this tenant — defer to the model
  }
  // R16 F3: a compound question was already split out in parseDocLookupQuestion
  // above — dispatch to its own splitter/resolver rather than the document-
  // type machinery below, which has no `doctype` to work with here at all.
  if (parsed.compound) return runCompound(db, question, opts);
  const { doctype, namePhrase, isAddress } = parsed;
  const yesNo = YES_NO_SHAPE_RE.test(String(question ?? ""));
  const docLabel = documentTypeLabel(doctype);
  const docLabelLower = docLabel.charAt(0).toLowerCase() + docLabel.slice(1);

  // ---- resolve the scope: every customer/unit the phrase names -------------------------------------------------
  let scope;
  let subject;
  let customers;
  if (isAddress) {
    // Team A: an address with several customers/units on it (an apartment complex) is answered FOR THE ADDRESS across
    // all of them, never "which one did you mean" — unless the question names the unit ("Apt 104").
    scope = await resolveAddressScope(db, namePhrase, { unit: extractUnitDesignator(question) });
    customers = scope.customers;
    if (!customers.length && !scope.equipment.length) {
      // TEAM C: nothing matched - say what was searched (honest zero).
      return attachCitations({
        kind: "answer", text: `I couldn't find a customer at ${titleCase(namePhrase)}.`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, { records: [], total: 0, kind: "searched", basis: `Searched your customer and equipment addresses for ${titleCase(namePhrase)}; no customer matches.` });
    }
    const firstAddr = String(customers[0]?.service_address ?? scope.equipment[0]?.service_address ?? namePhrase).split(",")[0].trim();
    subject = firstAddr || titleCase(namePhrase);
    const names = [...new Set(customers.map((c) => c.customer_name).filter(Boolean))];
    if (names.length && names.length <= 3) subject += ` (${names.join(", ")})`;
  } else {
    const { candidates, declined } = await resolveCandidates(db, question, namePhrase, false);
    if (declined) return declined;
    if (candidates.length === 0) {
      return attachCitations({
        kind: "answer", text: `I couldn't find a customer named ${titleCase(namePhrase)}.`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, { records: [], total: 0, kind: "searched", basis: `Searched your customer names for ${titleCase(namePhrase)}; no customer matches.` });
    }
    if (candidates.length > MAX_AGGREGATE_CANDIDATES) {
      const names = candidates.map((r) => r.customer_name || r.customer_number || "Unnamed customer");
      return attachCitations({
        kind: "answer",
        text: `I found more than one match for "${namePhrase}": ${names.join(", ")}. Which one did you mean?`,
        facts: candidates.map((r) => ({
          label: r.customer_name || r.customer_number || "Unnamed customer",
          value: r.service_address || "—", entityId: r.id, sources: [],
        })),
        sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
        candidateCount: candidates.length,
      }, { records: candidates.map((r) => customerRecord(r)), total: candidates.length, claimedCount: candidates.length, basis: `${candidates.length} customers match "${namePhrase}"; pick one to see their ${docLabelLower}.` });
    }
    customers = candidates;
    scope = await scopeFromCustomers(db, candidates);
    subject = candidates.length === 1
      ? (candidates[0].customer_name || candidates[0].customer_number || "this customer")
      : `${candidates.length} customers matching "${namePhrase}" (${candidates.map((r) => r.customer_name).filter(Boolean).join(", ")})`;
  }

  // ---- every document reachable from the scope, then the ones of this type -----------------------------------
  const idSet = new Set(await scopeDocumentIds(db, scope));
  if (!isAddress) {
    for (const row of customers) {
      try {
        const name = row?.customer_name ?? null;
        const address = row?.service_address ?? null;
        if (name && address) for (const r of await db.listNameMatchedDocuments(name, address)) idSet.add(r.document_id);
      } catch { /* enrichment only */ }
    }
  }
  // R19 (I1, owner ask (a)/audience adoption): drop internal/team-only documents from the scope's
  // own id set BEFORE either the "none" honest-zero basis or the type query below ever sees them —
  // unless the question is itself about team/internal material (isTeamScopedQuestion).
  const teamScoped = isTeamScopedQuestion(question);
  const hasAudienceColumn = await documentsHaveAudience({ query: (sql, params) => db.raw(sql, params) });
  const audienceClause = audienceFilterSql({ docAlias: "d", hasAudienceColumn, teamScoped });
  if (idSet.size && !teamScoped) {
    const { rows: audRows } = await db.raw(
      `SELECT d.id FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT_SQL} AND (${audienceClause})`,
      [[...idSet]]
    );
    idSet.clear();
    for (const r of audRows) idSet.add(r.id);
  }
  const ids = [...idSet];
  // TEAM C: an honest "none" cites what WAS searched - every document reachable from the scope (or, with no
  // documents at all, the customers searched).
  const none = async () => {
    const data = {
      kind: "answer",
      text: yesNo ? `No — no ${docLabelLower} on file for ${subject}.` : `No ${docLabelLower} on file for ${subject}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
    if (!ids.length) {
      return attachCitations(data, {
        records: customers.map((c) => customerRecord(c)), total: customers.length, kind: "searched",
        basis: `No documents at all are linked to ${subject}, so there is no ${docLabelLower} to show.`,
      });
    }
    return attachCitations(data, {
      records: await documentRecordsFor(db, ids), total: ids.length, kind: "searched",
      basis: `Searched all ${ids.length} document${ids.length === 1 ? "" : "s"} linked to ${subject}${customers.length > 1 ? ` (across ${customers.length} customers)` : ""}; none is a ${docLabelLower}.`,
    });
  };
  if (!ids.length) return await none();

  const { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, d.created_at,
            (SELECT x.value FROM extractions x
              WHERE x.document_id = d.id AND x.field_key = 'service_date' AND x.${TENANT_SQL}
              ORDER BY x.created_at DESC LIMIT 1) AS service_date,
            (SELECT c.data->>'customer_name'
               FROM document_entity_links l
               JOIN entities en ON en.id = l.entity_id AND en.merged_into IS NULL AND en.${TENANT_SQL}
               JOIN entities c ON c.id = CASE WHEN en.entity_type = 'customer' THEN en.id ELSE en.customer_id END
                                AND c.entity_type = 'customer' AND c.merged_into IS NULL AND c.${TENANT_SQL}
              WHERE l.document_id = d.id AND l.${TENANT_SQL} ORDER BY l.created_at DESC LIMIT 1) AS customer_name
       FROM documents d
      WHERE d.id = ANY($1::uuid[]) AND ${typeSql("d.document_type")} = ANY($2::text[]) AND d.${TENANT_SQL}
      ORDER BY d.created_at DESC
      LIMIT ${MAX_DOCS}`,
    [ids, docTypeAliases(doctype)]
  );
  if (!rows.length) return await none();

  const multi = customers.length > 1;
  const plural = rows.length === 1 ? docLabelLower : `${docLabelLower}${docLabelLower.endsWith("s") ? "" : "s"}`;
  const line = (r) => `${formatDateLabel(r.service_date ?? r.created_at)} · ${r.original_filename ?? r.id}${multi && r.customer_name ? ` · ${r.customer_name}` : ""}`;
  const summaryList = rows.slice(0, 3).map(line).join("; ");
  const more = rows.length > 3 ? `, and ${rows.length - 3} more` : "";
  return attachCitations({
    kind: "answer",
    text: `${yesNo ? "Yes — " : ""}${rows.length} ${plural} on file for ${subject}: ${summaryList}${more}.`,
    facts: rows.map((r) => ({
      label: docLabel,
      value: line(r),
      sources: [{ documentId: r.id, location: {} }],
    })),
    sources: [], confidence: 1, verifiedCount: rows.length, unverifiedCount: 0, closest: [],
  }, {
    records: rows.map((r) => documentRecord(r, { label: `${docLabel} · ${r.original_filename ?? r.id}`, sublabel: `${formatDateLabel(r.service_date ?? r.created_at)}${multi && r.customer_name ? ` · ${r.customer_name}` : ""}` })),
    total: rows.length, claimedCount: rows.length,
    basis: `Looked through the ${ids.length} document${ids.length === 1 ? "" : "s"} linked to ${subject}${multi ? ` (${customers.length} customers)` : ""} for ${docLabelLower}; dates are service dates (upload date when none was extracted).`,
  });
}

/* ============================================================ item 8: honest-
 * zero context for retrieval — "Nothing on file about <topic words> for
 * <customer> at <address>." instead of the generic no-answer line, when a
 * single-record question resolves to a known customer/address but retrieval
 * itself found nothing to cite. See api/ask.js's retrieval no-answer branch.
 */
const TRAILING_NAME_FOR_ZERO_RE = /\b(?:for|at)\s+([A-Z][a-zA-Z'.-]*(?:\s+[A-Z][a-zA-Z'.-]*){0,2})\s*[?.!]*\s*$/;

/** Best-effort strip of the resolved name/address phrase and the most common
 *  single-record question scaffolding ("what's the", "is there a", "do we
 *  have", trailing "?") from the raw question, leaving roughly the topic —
 *  e.g. "compressor replacement" out of "do we have anything about a
 *  compressor replacement for Thomas Mercer". Never perfect; this is display
 *  text for an honest-zero answer, not a parsed fact. */
function topicWords(question, matchedPhrase) {
  let q = String(question ?? "").trim();
  if (matchedPhrase) {
    const idx = q.toLowerCase().lastIndexOf(String(matchedPhrase).toLowerCase());
    if (idx >= 0) q = (q.slice(0, idx) + q.slice(idx + matchedPhrase.length)).trim();
  }
  q = q
    .replace(/\?+\s*$/, "")
    .replace(/^(?:what'?s|what\s+is|do\s+we\s+have|does\s+anyone\s+have|is\s+there|was\s+there|did\s+we)\s+/i, "")
    .replace(/\b(?:the|a|an|on|for|at|about|any|anything)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return q;
}

/**
 * Tries a street address first (STREET_ADDRESS_RE, analytics.js), then a
 * trailing capitalized name — the two single-record signals cheap enough to
 * check with no ambiguity. Returns {name, address, topic} when exactly one
 * customer resolves, or null (the caller then uses the generic no-answer
 * wording). Never a model call; a handful of extra tenant-scoped reads only
 * on the already-given-up "nothing to cite" path.
 */
export async function resolveHonestZeroContext(db, question) {
  const raw = String(question ?? "");
  const addrMatch = raw.match(STREET_ADDRESS_RE);
  if (addrMatch) {
    const rows = await resolveAddressCandidates(db, addrMatch[0]);
    if (rows.length === 1) {
      return { name: rows[0].customer_name || "this customer", address: rows[0].service_address || addrMatch[0], topic: topicWords(raw, addrMatch[0]), row: rows[0] /* TEAM C: citations name what was searched */ };
    }
    if (rows.length > 0) return null; // ambiguous — don't guess which one
  }
  const nameMatch = raw.match(TRAILING_NAME_FOR_ZERO_RE);
  if (nameMatch) {
    const phrase = nameMatch[1].trim();
    if (nameTokens(phrase).length && !AGGREGATE_WORD_RE.test(phrase)) {
      const { rows, tier } = await resolveContactCandidatesDetailed(db, phrase);
      // R21 (M1, P0 — fp-4 cluster 5): never name a DIFFERENT real customer here just because
      // their name is one edit away from what was typed — see resolveNamedCustomers' own doc
      // comment (contactLookup.js). No corroboration to check against for this phrasing-only
      // fallback context, so a fuzzy-only match simply contributes no name/address at all —
      // buildHonestZeroText's own generic "that" wording still answers honestly either way.
      if (rows.length === 1 && (tier !== "fuzzy" || corroboratesCandidate(raw, rows[0]))) {
        return { name: rows[0].customer_name || phrase, address: rows[0].service_address || null, topic: topicWords(raw, phrase), row: rows[0] /* TEAM C */ };
      }
    }
  }
  return null;
}

export function buildHonestZeroText(ctx) {
  const topic = ctx.topic && ctx.topic.length ? ctx.topic : "that";
  return ctx.address
    ? `Nothing on file about ${topic} for ${ctx.name} at ${ctx.address}.`
    : `Nothing on file about ${topic} for ${ctx.name}.`;
}
