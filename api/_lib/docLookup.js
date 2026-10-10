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
import { denyOr } from "./lookups/nameMatch.js";
import { localYmdIn } from "./util/localDate.js";
import { extractWindow } from "./lookups/dateQualifiers.js";
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
import { resolveAddressScope, scopeFromCustomers, scopeDocumentIds, extractUnitDesignator, extractUnitDesignators, docTypeAliases, typeSql } from "./scope.js";
// R16 F3 (compound questions): "whats the model and serial on the unit at
// <address>" / "is Abernathy still under warranty and whos the tech that did
// it" — two sub-asks in one question, neither a document-type lookup at all.
// See parseDocLookupQuestion/runDocLookup's own dispatch below, and
// lookups/compound.js's own header comment for why this is wired in HERE
// rather than through a new api/ask.js call site.
import { parseCompoundQuestion, runCompound } from "./lookups/compound.js";
import { parseDocFieldAsk, extractField } from "./lookups/docFieldAsk.js";
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
  /(?<!\bfor )(?<!\bfor the )(?<!\bcredit )\bmemos?\b(?!')/,
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
const BARE_LEADIN_RE = /\b(?:amounts?|totals?|prices?|costs?|how|hows|how's|much|what|whats|what's|which|who|whos|when|many|come|comes|came|number|numbers)\b/i;
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

const SUMMARY_NOT_A_NAME_RE = /\b(?:newest|oldest|latest|earliest|newer|older|biggest|largest|smallest|most recent)\b/i;
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
  // R2 B2: a ranking word or a "date of ..." / "when ..." opener is a question about a document ("date of the newest proposal"), never a customer's name.
  if (SUMMARY_NOT_A_NAME_RE.test(p) || /^(?:dates?|when)\b/i.test(p)) return false;
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

// Defect 7: "invoice number for Amy Isaacson" / "whats Thomas Mercer's invoice number" / "invoice # for Gary Villegas" / "what invoice number was David Prentiss billed
// under" ask for the DOCUMENT's own number (extracted invoice_number / po_number / permit_number), not a phone number or the document list.
const NUMBER_FIELD_BY_DOCTYPE = { invoice: "invoice_number", "purchase-order": "po_number", permit: "permit_number" };
const NUMBER_ASK_RE = new RegExp(`\\b(${DOCTYPE_RE_SRC})s?\\s*(?:#|numbers?|nos?\\b\\.?|num\\b)(?!\\s+of\\b)`, "i");
const NAME_SRC = "[A-Za-z0-9][A-Za-z0-9'.&\\u2019-]*(?:\\s+[A-Za-z0-9'.&\\u2019-]+){0,4}?";
const NUMBER_NAME_RES = [
  new RegExp(`\\b(?:for|on|of|under|to)\\s+(?:the\\s+)?(${NAME_SRC})(?:['\\u2019]s\\s+(?:account|job|file|system|unit|place|house))?\\s*$`, "i"),
  new RegExp(`(?:^|\\s)(${NAME_SRC})['\\u2019]s\\s+(?:\\w+\\s+)?(?:${DOCTYPE_RE_SRC})s?\\s*(?:#|number|no|num)\\b`, "i"),
  new RegExp(`\\b(?:was|is|did)\\s+(?:the\\s+)?(${NAME_SRC})\\s+(?:billed|invoiced|issued|given|get|under|get\\s+billed)\\b`, "i"),
];
const NUMBER_FILLER_RE = /^(?:(?:what|whats|what's|whos|who's|which|is|are|was|the|a|an|give|me|tell|get|pull|up|find|need|want|show|can|you|i|do|we|have|our|their|his|her)\s+)+/i;
function parseDocNumberAsk(raw) {
  const text = String(raw ?? "").trim().replace(/[?!.]+$/, "");
  const m = NUMBER_ASK_RE.exec(text);
  if (!m) return null;
  const doctype = docTypeFromWord(m[1]);
  if (!doctype || !NUMBER_FIELD_BY_DOCTYPE[doctype]) return null;
  for (const re of NUMBER_NAME_RES) {
    const nm = re.exec(text);
    if (!nm) continue;
    let namePhrase = nm[1].trim();
    for (let i = 0; i < 4; i++) { const next = namePhrase.replace(NUMBER_FILLER_RE, "").trim(); if (next === namePhrase) break; namePhrase = next; }
    namePhrase = stripTrailingFillerWord(namePhrase.replace(/['\u2019]s(?:\s+(?:account|job|file|system|unit|place|house))?$/i, "").trim());
    if (!namePhrase || !isRealNameOrAddressPhrase(namePhrase) || BARE_LEADIN_RE.test(namePhrase) || new RegExp(`^${DOCTYPE_RE_SRC}s?$`, "i").test(namePhrase)) continue;
    return { doctype, namePhrase, isAddress: /^\d/.test(namePhrase), numberField: NUMBER_FIELD_BY_DOCTYPE[doctype] };
  }
  return null;
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

// R3 nameyear loop: "invoices for Linda Fitzgerald in 2009" -> name "Linda Fitzgerald" + year 2009 (the year used to ride along inside the name).
// Kill switch DONOVAN_NAME_YEAR=0. An address (digit-led) is never split.
const NAME_YEAR_TAIL_RE = /^(.+?)\s+(?:in|during|for|from|of)\s+(?:the\s+)?(?:year\s+)?((?:19|20)\d\d)$/i;
function splitNameYear(phrase) {
  if (process.env.DONOVAN_NAME_YEAR === "0") return { name: phrase, year: null };
  const m = NAME_YEAR_TAIL_RE.exec(String(phrase ?? "").trim());
  if (!m || /^\d/.test(m[1])) return { name: phrase, year: null };
  return { name: m[1].trim(), year: m[2] };
}

// R3 namewindow loop: any other trailing absolute date window after a name ("invoices for Linda Fitzgerald from 2009 to 2011", "... since 2009", "... before 2010",
// "... in september 2010", "... 2009-2011", "... in Q3 2010") is split off the name and applied as a from/to range instead of riding along inside it.
// Only absolute windows the shared date reader understands, and only when the WHOLE tail is the window. Kill switch DONOVAN_NAME_WINDOW=0. Digit-led names (addresses) never split.
const NW_START_RE = /^(?:in|during|for|from|of|since|after|before|until|till|between|on|through|last|previous|prior|this|current|over)\b|^(?:19|20)\d\d\b|^q[1-4]\b|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
function windowFromTail(tail) {
  let t = String(tail).toLowerCase().replace(/[?.!,\s]+$/, "").replace(/\b((?:19|20)\d\d)\s*[-\u2013]\s*((?:19|20)\d\d)\b/, "from $1 to $2");
  // R3 relname: relative period after a name ("last year", "this month", "last quarter"): resolved against today at run time. Kill switch DONOVAN_NAME_REL=0.
  const rm = process.env.DONOVAN_NAME_REL === "0" ? null : /^(?:in\s+|during\s+|for\s+|from\s+|over\s+|of\s+)?(?:the\s+)?(last|previous|prior|this|current)\s+(year|month|quarter)$/.exec(t);
  if (rm) return { rel: `${/^(?:this|current)$/.test(rm[1]) ? "this" : "last"} ${rm[2]}`, from: "", to: "", text: `in ${rm[0].replace(/^(?:in|during|for|from|over|of)\s+/, "").replace(/^the\s+/, "")}` };
  const qm = /^(?:in\s+|during\s+|for\s+|of\s+)?(?:the\s+)?q([1-4])\s+((?:19|20)\d\d)$/.exec(t);
  if (qm) { const a = (Number(qm[1]) - 1) * 3 + 1, y = qm[2], e = a + 2; const ld = new Date(Date.UTC(Number(y), e, 0)).getUTCDate(); return { from: `${y}-${String(a).padStart(2, "0")}-01`, to: `${y}-${String(e).padStart(2, "0")}-${ld}`, text: `in Q${qm[1]} ${y}` }; }
  const w = extractWindow(t);
  if (!w || w.rest !== "" || !/^\d{4}-\d{2}-\d{2}$/.test(w.from) || !/^\d{4}-\d{2}-\d{2}$/.test(w.to)) return null;
  const text = w.open ? w.label : w.range ? `from ${w.label}` : /^[A-Z][a-z]+ \d{4}$/.test(w.label) || /^\d{4}$/.test(w.label) ? `in ${w.label}` : `on ${w.label}`;
  return { from: w.from, to: w.to, text };
}
function resolveRelWin(rel, today0) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(today0 ?? "")) ? today0 : new Date().toISOString().slice(0, 10);
  const [dir, unit] = rel.split(" "), off = dir === "last" ? -1 : 0;
  const y0 = Number(today.slice(0, 4)), m0 = Number(today.slice(5, 7)) - 1, p2 = (n) => String(n).padStart(2, "0");
  const MN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (unit === "year") { const y = y0 + off; return { from: `${y}-01-01`, to: `${y}-12-31`, text: `in ${y}` }; }
  if (unit === "month") { const d = new Date(Date.UTC(y0, m0 + off, 1)); const y = d.getUTCFullYear(), m = d.getUTCMonth(); return { from: `${y}-${p2(m + 1)}-01`, to: `${y}-${p2(m + 1)}-${lastDay(y, m)}`, text: `in ${MN[m]} ${y}` }; }
  const d = new Date(Date.UTC(y0, m0 + off * 3, 1)); const y = d.getUTCFullYear(), qn = Math.floor(d.getUTCMonth() / 3), a = qn * 3, e = a + 2;
  return { from: `${y}-${p2(a + 1)}-01`, to: `${y}-${p2(e + 1)}-${lastDay(y, e)}`, text: `in Q${qn + 1} ${y}` };
}
function splitNameWindow(phrase) {
  if (process.env.DONOVAN_NAME_WINDOW === "0") return null;
  const words = String(phrase ?? "").trim().split(/\s+/);
  if (words.length < 2 || /^\d/.test(words[0])) return null;
  for (let i = 1; i < words.length; i++) {
    const tail = words.slice(i).join(" ");
    if (!NW_START_RE.test(tail)) continue;
    const win = windowFromTail(tail);
    if (win) return { name: words.slice(0, i).join(" "), win };
  }
  return null;
}

// Defect 17: "<doc type> at/for <street address> [apt N [and apt M]]" said in any order ("show the invoice for Apt 105 & Apt 106 at 3300 S Alma School Rd") is the one canonical
// "<doc type>s for <address> apt N and apt M" shape the address lookup already answers. Only fires when a unit designator AND a street suffix are present.
const STREET_ADDR_RE = /\b(\d{1,6}\s+(?:[nsew]\s+)?(?:[a-z0-9.'-]+\s+){0,3}?(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|way|pl|place|pkwy|parkway|trl|trail|hwy|highway))\b\.?/i;
function reshapeUnitAddressQuestion(q) {
  const units = extractUnitDesignators(q);
  if (!units.length) return q;
  const addr = STREET_ADDR_RE.exec(q);
  const dt = DOCTYPE_WORD_RE.exec(q);
  if (!addr || !dt) return q;
  const word = dt[0].toLowerCase();
  const plural = /s$/.test(word) ? word : `${word}s`;
  return `${plural} for ${addr[1].trim()}`;
}

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

  // Defect 19/21: one printed field of one kind of document (permit city/status, PO vendor/parts, warranty registered/term, startup tech, invoice date, agreement period,
  // nameplate, document count, "does X have a permit"). Answered from the document's own text.
  const fieldAsk = parseDocFieldAsk(raw);
  if (fieldAsk && (fieldAsk.docNumber || !fieldAsk.namePhrase || (isRealNameOrAddressPhrase(fieldAsk.namePhrase) && !BARE_LEADIN_RE.test(fieldAsk.namePhrase)))) {
    return { ...fieldAsk, doctype: fieldAsk.docField.doctype };
  }

  const numberAsk = parseDocNumberAsk(raw);
  if (numberAsk) return numberAsk;

  let q = normalizeQuestion(correctTriggerWordTypos(raw, DOCTYPE_TRIGGER_WORDS), { overlay }).normalized;
  if (!q || !DOCTYPE_WORD_RE.test(q)) return null; // cheap reject before trying every shape
  const reshaped = reshapeUnitAddressQuestion(q);

  for (const re of SHAPES) {
    let m = q.match(re);
    if (!m && reshaped !== q) { m = reshaped.match(re); if (m) q = reshaped; }
    if (!m) continue;
    let { name: namePhrase, year } = splitNameYear(stripTrailingFillerWord(m[1].trim()));
    let win = null;
    if (!year) { const nw = splitNameWindow(stripTrailingFillerWord(m[1].trim())); if (nw) { namePhrase = nw.name; win = nw.win; } }
    const trailingJob = TRAILING_JOB_WORD_RE.test(m[0]);
    if (!isRealNameOrAddressPhrase(namePhrase, { trailingJob })) continue;
    const doctypeWordMatch = m[0].match(DOCTYPE_WORD_RE);
    const doctype = doctypeWordMatch ? docTypeFromWord(doctypeWordMatch[0]) : null;
    if (!doctype) continue;
    return { doctype, namePhrase, isAddress: /^\d/.test(namePhrase), ...(year ? { year } : {}), ...(win ? { win } : {}) };
  }

  const bare = q.match(NAME_DOCTYPE_RE);
  if (bare) {
    const namePhrase = bare[1].trim();
    // Defect 1: "amount of the Copper Sky Dental invoice" / "invoice total for the Grace Community invoice" is a how-much question carrying a lead-in,
    // not a bare "<name> invoices" lookup: never capture the lead-in words as part of a customer name.
    if (isRealNameOrAddressPhrase(namePhrase) && !BARE_LEADIN_RE.test(namePhrase)) {
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

/* ============================================================ Defect 5: memos by document type */

const MEMO_HEADER_RE = /^\s*(?:(?:internal|staff|team|shop)\s+)?memo(?:randum)?\s*$/im;
const MEMO_QUALIFIER_RE = /\b(?:today|yesterday|tonight|this\s+(?:morning|week|month|year|afternoon)|last\s+(?:week|month|year)|next\s+(?:week|month)|week|recent(?:ly)?|latest|newest|oldest|first|went\s+out|sent|send|broadcast(?:ed)?|circulate[ds]?|announce\w*|everyone|everybody|all\s+(?:staff|techs?|hands)|entire\s+team|whole\s+team|crew|techs?|technicians?|dispatch|management|office|(?:19|20)\d\d)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const AUDIENCE_TERM_RE = /\b(?:internal|staff|team|shop)[-\s]only\b/i;

/** Every document whose first page is headed MEMO / INTERNAL MEMO: [{id, filename, created_at, text}]. Tenant-scoped read, never a model call. */
async function listMemoDocuments(db) {
  const { rows } = await db.raw(
    `SELECT d.id, d.original_filename, d.created_at, p.page_no, p.text
       FROM document_pages p JOIN documents d ON d.id = p.document_id AND d.${TENANT_SQL}
      WHERE p.${TENANT_SQL} AND p.tsv @@ websearch_to_tsquery('english', 'memo')
      ORDER BY d.created_at DESC, p.page_no
      LIMIT 500`
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.id) || !MEMO_HEADER_RE.test(String(r.text ?? ""))) continue;
    seen.add(r.id);
    out.push({ id: r.id, filename: r.original_filename, created_at: r.created_at, text: String(r.text ?? "") });
  }
  return out;
}

function memoFields(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => MEMO_HEADER_RE.test(l));
  const rest = at >= 0 ? lines.slice(at + 1) : lines;
  const get = (k) => (rest.find((l) => new RegExp(`^${k}\\s*:`, "i").test(l)) ?? "").replace(new RegExp(`^${k}\\s*:\\s*`, "i"), "");
  const body = rest.filter((l) => !/^(?:date|to|from|re|subject)\s*:/i.test(l)).join(" ");
  return { date: get("date"), to: get("to"), re: get("re") || get("subject"), body };
}

const memoNoun = (n) => (n === 1 ? "internal memo" : "internal memos");

async function answerMemoQuestion(db, question, opts) {
  const raw = String(question ?? "");
  let memos;
  try { memos = await listMemoDocuments(db); } catch { return null; } // best-effort: no page index -> the audience-based answer below
  if (!memos.length) return null; // none headed MEMO: the audience-based honest decline below stays correct
  const records = async (list) => await documentRecordsFor(db, list.map((m) => m.id));
  const qualified = MEMO_QUALIFIER_RE.test(raw) || AUDIENCE_TERM_RE.test(raw);
  const counting = /\b(?:how\s+many|count|number\s+of|total)\b/i.test(raw);
  // A named customer (full name on file): the memo(s) that mention them. A time / audience / sender qualifier is never silently dropped.
  let namePhrase = null;
  const nm = raw.match(/\b(about|for|on|regarding|re|mentioning|mentions?|concerning|with)\s+(?:the\s+)?([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3}?)(?:\s+(?:memo|account|job|file|say|says|said|read|mention|mentions)\b.*|\s*[?.!]*)$/i);
  if (nm) namePhrase = nm[2].trim().replace(/['\u2019]s$/i, "");
  // "any memos for <name>" / "is there a memo for <name>" asks whether a memo was ADDRESSED to them (these memos go "To: All Techs"): that is not the same as a
  // memo that merely mentions their name, so it is answered as "none addressed to them", pointing at the mention lookup (see the plain statement below).
  const addressedTo = !!nm && /^for$/i.test(nm[1]) && /^\s*(?:any|is\s+there|are\s+there|do\s+we\s+have|have\s+we|has\s+anyone)\b/i.test(raw);
  if (namePhrase && isRealNameOrAddressPhrase(namePhrase) && !qualified && !addressedTo) {
    const { candidates } = await resolveCandidates(db, question, namePhrase, false);
    if (candidates.length > 0 && candidates.length <= 3) {
      const mine = [];
      for (const m of memos) {
        const textLower = m.text.toLowerCase().replace(/\u2019/g, "'");
        const hit = candidates.some((c) => c.customer_name && textLower.includes(String(c.customer_name).toLowerCase()));
        if (hit) mine.push(m);
      }
      const who = candidates.map((c) => c.customer_name).filter(Boolean).join(" / ") || namePhrase;
      if (!mine.length) {
        return attachCitations({
          kind: "answer", text: `No internal memo mentions ${who}. There ${memos.length === 1 ? "is" : "are"} ${memos.length} ${memoNoun(memos.length)} on file in all.`,
          facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
        }, { records: await records(memos.slice(0, 20)), total: memos.length, kind: "searched", basis: `Read all ${memos.length} documents headed MEMO for ${who}'s name; none mention them.` });
      }
      const f = mine.map((m) => ({ m, f: memoFields(m.text) }));
      const one = (x) => `${x.f.re ? `"${x.f.re}"` : "memo"}${x.f.date ? `, ${x.f.date}` : ""}${x.f.to ? `, to ${x.f.to}` : ""}: ${x.f.body}`;
      const text = counting
        ? `${f.length} internal memo${f.length === 1 ? "" : "s"} ${f.length === 1 ? "mentions" : "mention"} ${who}: ${f.slice(0, 4).map(one).join(" | ")}`
        : f.length === 1
        ? `The internal memo about ${who} (${one(f[0])})`
        : `${f.length} internal memos mention ${who}: ${f.slice(0, 4).map(one).join(" | ")}`;
      return attachCitations({
        kind: "answer", text,
        facts: f.map((x) => ({ label: `Memo${x.f.date ? ` ${x.f.date}` : ""}`, value: `${x.f.re ? `${x.f.re} — ` : ""}${x.f.body}`, sources: [{ documentId: x.m.id, location: {} }] })),
        sources: [], confidence: 1, verifiedCount: f.length, unverifiedCount: 0, closest: [],
      }, { records: await records(mine), total: mine.length, claimedCount: mine.length, basis: `Read the ${mine.length === 1 ? "memo" : `${mine.length} memos`} (documents headed MEMO) that name ${who}.` });
    }
    // an unresolved name falls through to the plain statement below
  }
  if (counting && !qualified) {
    const list = memos.slice(0, 8);
    return attachCitations({
      kind: "answer",
      text: `${memos.length} ${memoNoun(memos.length)} ${memos.length === 1 ? "is" : "are"} on file (documents headed INTERNAL MEMO).`,
      facts: [{ label: "Internal memos on file", value: String(memos.length), status: "info", sources: list.map((m) => ({ documentId: m.id, location: {} })) }],
      sources: [], confidence: 1, verifiedCount: memos.length, unverifiedCount: 0, closest: [],
    }, { records: await records(list), total: memos.length, claimedCount: memos.length, basis: `Counted every document whose page is headed MEMO (${memos.length}); the audience setting itself marks none of them team-only because they name a customer.` });
  }
  if (namePhrase && addressedTo && isRealNameOrAddressPhrase(namePhrase) && !qualified) {
    return attachCitations({
      kind: "no-answer",
      text: `I couldn't find a memo addressed to ${titleCase(namePhrase)}: the memos on file (${memos.length}) are headed INTERNAL MEMO and go to the whole team. To see one that mentions a customer by name, ask "what does the internal memo about (customer name) say".`,
      facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: await records(memos.slice(0, 10)), total: memos.length, kind: "searched", basis: `Looked at the ${memos.length} documents headed MEMO; matching by who a memo is addressed to is not something I can do.` });
  }
  // Everything else (who it was sent to, when it went out, "internal-only" as an audience flag): say plainly what could not be applied.
  return attachCitations({
    kind: "no-answer",
    text: `I couldn't find a memo matching that. There ${memos.length === 1 ? "is" : "are"} ${memos.length} ${memoNoun(memos.length)} on file (documents headed INTERNAL MEMO), but I can't filter them by who they went to, when they went out, or an internal-only flag. Try "how many internal memos do we have" or "what does the internal memo about (customer name) say".`,
    facts: [], sources: [], confidence: 0, verifiedCount: 0, unverifiedCount: 0, closest: [],
  }, { records: await records(memos.slice(0, 10)), total: memos.length, kind: "searched", basis: `Found ${memos.length} documents headed MEMO; none could be matched to the extra condition in the question.` });
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
    // Defect 5 (limit test 2026-10-03): memos name a customer, so the audience classifier files them as customer paperwork BY DESIGN and the
    // audience count below is 0 - but INTERNAL MEMO documents are on file, and "no internal-only documents on file at all" was false. Answer by
    // document type (a page headed MEMO) instead; whatever part of the question cannot be applied (who it went to, when) is said plainly.
    const memoAnswer = await answerMemoQuestion(db, question, opts);
    if (memoAnswer) return memoAnswer;
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
  if (parsed.docNumber) return runDocNumberField(db, parsed);
  const { doctype, namePhrase, isAddress, year } = parsed;
  let win = parsed.win;
  if (win?.rel) win = resolveRelWin(win.rel, opts?.today);
  const yesNo = YES_NO_SHAPE_RE.test(String(question ?? ""));
  const docLabel = documentTypeLabel(doctype ?? "invoice");
  const docLabelLower = docLabel.charAt(0).toLowerCase() + docLabel.slice(1);

  // ---- resolve the scope: every customer/unit the phrase names -------------------------------------------------
  let scope;
  let subject;
  let customers;
  if (isAddress) {
    // Team A: an address with several customers/units on it (an apartment complex) is answered FOR THE ADDRESS across
    // all of them, never "which one did you mean" — unless the question names the unit ("Apt 104").
    const unitList = extractUnitDesignators(question);
    scope = await resolveAddressScope(db, namePhrase, { unit: unitList.length > 1 ? unitList : extractUnitDesignator(question) });
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
    if (candidates.length === 0 && /\b(?:open|unpaid|overdue|paid|outstanding|pending|owing|due)$/i.test(String(namePhrase).trim())) return null; // E2 A7: a status word is never part of a name ("henderson open invoices"): let the money lane read the status
    if (candidates.length === 0 && /^(?:wheres|whats|hows|whos|where|what|how|who|which|when|show|find|pull|can|could|please|do|does|is|are)\b|\b(?:my|our|view|see)\b/i.test(String(namePhrase).trim())) {
      // R41U E4 (owner rule 3): question words / my / our / view are never part of a name: ask one short question instead of "no customer named Wheres My".
      return attachCitations({
        kind: "answer", text: "Which customer or invoice do you mean? Tell me a customer's name, or an amount like \"the invoice for 3470\".",
        facts: [], sources: [], confidence: 0.5, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, { records: [], total: 0, kind: "searched", basis: "The question had no customer name in it, so nothing was searched." });
    }
    if (candidates.length === 0 && /\b(?:documents?|docs?|paperwork|files?|records?)\b/i.test(question)) {
      // R3 B2: a technician's name is not a missing customer: the technician count lane answers (and says the documents are the ones that list her as technician)
      try {
        const { loadTechnicianVocab, parseTechnician, runTechnician } = await import("./lookups/technician.js");
        const vocab = await loadTechnicianVocab(db);
        const tp = parseTechnician(question, vocab, {});
        if (tp?.docNoun) { const ans = await runTechnician(db, tp); if (ans) return ans; }
      } catch { /* keep the decline */ }
    }
    if (candidates.length === 0) {
      return denyOr(db, namePhrase, attachCitations({
        kind: "answer", text: `I couldn't find a customer named ${titleCase(namePhrase)}.`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, { records: [], total: 0, kind: "searched", basis: `Searched your customer names for ${titleCase(namePhrase)}; no customer matches.` }));
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

  // Defect 21: "how many documents are on file for X" - every document linked to the customer, by type.
  if (parsed.docField?.field === "count") {
    const { rows: byType } = await db.raw(
      `SELECT ${typeSql("d.document_type")} AS t, count(*)::int AS n FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.${TENANT_SQL} GROUP BY 1 ORDER BY 2 DESC, 1`, [ids]);
    const total = byType.reduce((a, r) => a + r.n, 0);
    const parts = byType.map((r) => `${r.n} ${documentTypeLabel(r.t).toLowerCase()}${r.n === 1 ? "" : "s"}`);
    return attachCitations({
      kind: "answer",
      text: `${subject} has ${total} document${total === 1 ? "" : "s"} on file: ${parts.join(", ")}.`,
      facts: [{ label: "Documents on file", value: String(total), sources: [] }],
      sources: [], confidence: 1, verifiedCount: total, unverifiedCount: 0, closest: [],
    }, { records: await documentRecordsFor(db, ids), total, claimedCount: total, basis: `Counted every document linked to ${subject}${customers.length > 1 ? ` (across ${customers.length} customers)` : ""}, grouped by document type.` });
  }

  let { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, d.created_at,
            (SELECT x.value FROM extractions x
              WHERE x.document_id = d.id AND x.field_key = 'service_date' AND x.${TENANT_SQL}
              ORDER BY x.created_at DESC LIMIT 1) AS service_date,
            (SELECT f.invoice_date::text FROM document_financials f WHERE f.document_id = d.id AND f.${TENANT_SQL} ORDER BY f.created_at DESC LIMIT 1) AS fin_date,
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
  if (year) {
    // R3 nameyear: keep only documents dated in that year (service date, else the invoice date); undated ones are not claimed for any year.
    const inYear = (r) => /(?:^|\D)(\d{4})-\d{2}-\d{2}/.test(String(r.service_date ?? "")) ? String(r.service_date).match(/(\d{4})-\d{2}-\d{2}/)[1] === year
      : /\d{4}/.test(String(r.service_date ?? "")) ? new RegExp(`\\b${year}\\b`).test(String(r.service_date)) : String(r.fin_date ?? "").slice(0, 4) === year;
    const before = rows.length;
    rows = rows.filter(inYear);
    subject = `${subject} in ${year}`;
    if (!rows.length) {
      return attachCitations({
        kind: "answer",
        text: `${yesNo ? "No — no" : "No"} ${docLabelLower} on file for ${subject}.`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, {
        records: await documentRecordsFor(db, ids), total: ids.length, kind: "searched",
        basis: `Searched all ${ids.length} document${ids.length === 1 ? "" : "s"} linked to ${subject.replace(` in ${year}`, "")}; ${before ? `none of its ${docLabelLower} is dated ${year}` : `none is a ${docLabelLower}`}.`,
      });
    }
  }
  if (win) {
    // R3 namewindow: keep only documents whose own date (service date, else invoice date) falls in the window; undated ones are not claimed.
    const iso = (v) => { const t = String(v ?? ""); const a = /(\d{4})-(\d{2})-(\d{2})/.exec(t); if (a) return a[0]; const u = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t); return u ? `${u[3]}-${u[1].padStart(2, "0")}-${u[2].padStart(2, "0")}` : null; };
    const before = rows.length;
    rows = rows.filter((r) => { const d = iso(r.service_date) ?? iso(r.fin_date); return d && d >= win.from && d <= win.to; });
    const base = subject;
    subject = `${subject} ${win.text}`;
    if (!rows.length) {
      return attachCitations({
        kind: "answer",
        text: `${yesNo ? "No — no" : "No"} ${docLabelLower} on file for ${subject}.`,
        facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      }, {
        records: await documentRecordsFor(db, ids), total: ids.length, kind: "searched",
        basis: `Searched all ${ids.length} document${ids.length === 1 ? "" : "s"} linked to ${base}; ${before ? `none of its ${docLabelLower} is dated ${win.text}` : `none is a ${docLabelLower}`}.`,
      });
    }
  }
  if (!rows.length) return await none();

  // Defect 19/21: the question asked for one printed field of this kind of document - read it from the document text.
  if (parsed.docField) {
    const out = await answerDocField(db, parsed.docField, rows, { subject, docLabelLower, docLabel, multi: customers.length > 1 });
    if (out) return out;
  }

  // Defect 7: the question asked for the document's NUMBER - state it (never the phone, never just the file list).
  if (parsed.numberField) {
    const { rows: nums } = await db.raw(
      `SELECT x.document_id, COALESCE(NULLIF(x.corrected_value, ''), x.value) AS value FROM extractions x
        WHERE x.document_id = ANY($1::uuid[]) AND x.field_key = $2 AND x.${TENANT_SQL} AND COALESCE(NULLIF(x.corrected_value, ''), x.value) <> ''`,
      [rows.map((r) => r.id), parsed.numberField]
    );
    const byDoc = new Map();
    for (const n of nums) if (!byDoc.has(n.document_id)) byDoc.set(n.document_id, String(n.value).trim());
    const withNum = rows.filter((r) => byDoc.has(r.id));
    if (withNum.length) {
      const noun = docLabelLower;
      const one = (r) => `${byDoc.get(r.id)}${r.service_date || r.created_at ? ` (${formatDateLabel(r.service_date ?? r.created_at)})` : ""}`;
      const text = withNum.length === 1
        ? `${subject}'s ${noun} number is ${byDoc.get(withNum[0].id)}.`
        : `${subject} has ${withNum.length} ${noun}s on file: ${withNum.slice(0, 6).map(one).join("; ")}${withNum.length > 6 ? `, and ${withNum.length - 6} more` : ""}.`;
      return attachCitations({
        kind: "answer", text,
        facts: withNum.map((r) => ({ label: `${docLabel} number`, value: byDoc.get(r.id), sources: [{ documentId: r.id, location: { field: parsed.numberField } }] })),
        sources: [], confidence: 1, verifiedCount: withNum.length, unverifiedCount: 0, closest: [],
      }, {
        records: withNum.map((r) => documentRecord(r, { label: `${docLabel} · ${byDoc.get(r.id)}`, sublabel: formatDateLabel(r.service_date ?? r.created_at) })),
        total: withNum.length, claimedCount: withNum.length,
        basis: `Read the ${parsed.numberField.replace(/_/g, " ")} printed on the ${withNum.length === 1 ? noun : `${withNum.length} ${noun}s`} linked to ${subject}.`,
      });
    }
  }

  // Defect 17: a named unit that matched no door is said plainly, never silently dropped.
  const missingUnits = isAddress ? (scope.unitsMissing ?? []) : [];
  const unitNote = missingUnits.length
    ? ` Nothing on file names ${missingUnits.map((u) => `Apt ${u.toUpperCase()}`).join(" or ")}${scope.unitNarrowed ? ", so only the other unit(s) you named are shown" : ", so this covers every unit at the address"}.`
    : "";
  // R42: a unit the address scope could not narrow ("unit 3A at 853 E Broadway") is a condition on the documents' own unit_number field when the organization stores one; apply it, never the whole building
  if (missingUnits.length && !scope.unitNarrowed && rows.length && process.env.DONOVAN_DOC_UNIT_FILTER !== "off") {
    try {
      const { rows: un } = await db.raw(
        `SELECT x.document_id, upper(regexp_replace(trim(COALESCE(NULLIF(x.corrected_value, ''), x.value)), '^(apt\\.?|unit|suite|ste|#)\\s*', '', 'i')) AS value FROM extractions x
          WHERE x.document_id = ANY($1::uuid[]) AND x.field_key = 'unit_number' AND x.${TENANT_SQL}`, [rows.map((r) => r.id)]);
      if (un.length) {
        const want = new Set(missingUnits.map((u) => String(u).toUpperCase().trim()));
        const keep = new Set(un.filter((u) => want.has(u.value)).map((u) => u.document_id));
        const rest = rows.filter((r) => keep.has(r.id));
        if (!rest.length) {
          return attachCitations({ kind: "answer", text: `No ${docLabelLower} on file for ${missingUnits.map((u) => `unit ${u.toUpperCase()}`).join(" or ")} at ${subject}; ${rows.length === 1 ? "the one" : `the ${rows.length}`} ${docLabelLower}${rows.length === 1 ? "" : "s"} on file for the address ${rows.length === 1 ? "names" : "name"} other units.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] }, { records: [], total: 0, claimedCount: 0, basis: `Checked the unit number printed on each ${docLabelLower} at ${subject}; none is for ${missingUnits.join(", ")}.` });
        }
        rows = rest;
      }
    } catch { /* unit filter unreadable: the whole-address answer below stands, with its note */ }
  }
  const multi = customers.length > 1;
  const plural = rows.length === 1 ? docLabelLower : `${docLabelLower}${docLabelLower.endsWith("s") ? "" : "s"}`;
  const line = (r) => `${formatDateLabel(r.service_date ?? r.created_at)} · ${r.original_filename ?? r.id}${multi && r.customer_name ? ` · ${r.customer_name}` : ""}`;
  const summaryList = rows.slice(0, 3).map(line).join("; ");
  const more = rows.length > 3 ? `, and ${rows.length - 3} more` : "";
  return attachCitations({
    kind: "answer",
    text: `${yesNo ? "Yes — " : ""}${rows.length} ${plural} on file for ${subject}: ${summaryList}${more}.${unitNote}`,
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

async function pageTextFor(db, docIds) {
  const { rows } = await db.raw(
    `SELECT p.document_id, string_agg(p.text, E'\n' ORDER BY p.page_no) AS text FROM document_pages p
      WHERE p.document_id = ANY($1::uuid[]) AND p.${TENANT_SQL} GROUP BY p.document_id`, [docIds]);
  return new Map(rows.map((r) => [r.document_id, String(r.text ?? "")]));
}

const permitOf = (s) => (/^Permit\b/.test(s) ? s : `${s}'s permit`);
const FIELD_SENTENCE = {
  "permit.city": (s, v) => `${s}'s permit was issued by the City of ${v}.`,
  "permit.status": (s, v) => `${s}'s permit status is ${v}.`,
  "permit.issued": (s, v) => `${permitOf(s)} shows ${v} as its date.`,
  "permit.expires": (s, v) => `${permitOf(s)} expires ${v}.`,
  "permit.inspection": (s, v) => `${permitOf(s)} lists its inspection as ${v}.`,
  "permit.fee": (s, v) => `${permitOf(s)} lists a fee of ${v}.`,
  "permit.contractor": (s, v) => `The contractor on ${permitOf(s)} is ${v}.`,
  "permit.scope": (s, v) => `The scope of work on ${permitOf(s)} is ${v}.`,
  "purchase-order.vendor": (s, v) => `${s} is from ${v}.`,
  "purchase-order.parts": (s, v) => `${s} lists these parts: ${v}.`,
  "warranty-registration.registered": (s, v) => `${s}'s warranty was registered on ${v}.`,
  "warranty-registration.term": (s, v) => `The warranty term on ${s}'s registration is ${v}.`,
  "startup-sheet.technician": (s, v) => `${v} did the startup for ${s}.`,
  "invoice.date": (s, v) => `${s} was invoiced on ${v}.`,
  "maintenance-agreement.period": (s, v) => `${s}'s maintenance agreement period is ${v}.`,
  "maintenance-agreement.units": (s, v) => `${s}'s maintenance agreement covers ${v}.`,
  "maintenance-agreement.coverage": (s, v) => `${s}'s maintenance agreement covers: ${v}.`,
  "dispatch-note.note": (s, v) => `The dispatch note for ${s} says: ${v}.`,
  "correspondence.exists": (s, v) => v,
  "permit.exists": (s, v) => v,
  "maintenance-agreement.exists": (s, v) => v,
  "nameplate-photo.plate": (s, v) => `Nameplate for ${s}: ${v}.`,
};

/** What a field is called when the document does not print it ("... prints no issue date"), for the plain not-printed answer. */
const FIELD_NOUN = { "permit.issued": "issue date", "permit.expires": "expiration date", "permit.inspection": "inspection date", "permit.fee": "fee", "permit.contractor": "contractor", "permit.scope": "scope of work" };

/** Answer one printed field from each matching document's text; null when no document states it (the caller then lists the documents). */
async function answerDocField(db, docField, rows, { subject, docLabel, docLabelLower, multi }) {
  const key = `${docField.doctype}.${docField.field}`;
  const sentence = FIELD_SENTENCE[key];
  if (!sentence || !rows.length) return null;
  const texts = await pageTextFor(db, rows.map((r) => r.id));
  const got = [];
  for (const r of rows) {
    const res = extractField(docField.doctype, docField.field, texts.get(r.id) ?? "");
    if (res) got.push({ r, res });
  }
  if (!got.length) {
    return attachCitations({
      kind: "answer",
      text: FIELD_NOUN[key]
        ? `${subject} has ${rows.length} ${docLabelLower}${rows.length === 1 ? "" : "s"} on file, but ${rows.length === 1 ? "it prints" : "none prints"} no ${FIELD_NOUN[key]}.`
        : `${subject} has ${rows.length} ${docLabelLower}${rows.length === 1 ? "" : "s"} on file, but none prints that detail.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: rows.map((r) => documentRecord(r, { label: `${docLabel} · ${r.original_filename ?? r.id}`, sublabel: "" })), total: rows.length, kind: "searched", basis: `Read the ${rows.length} ${docLabelLower}${rows.length === 1 ? "" : "s"} linked to ${subject}; the requested line is not printed on ${rows.length === 1 ? "it" : "them"}.` });
  }
  const distinct = [...new Set(got.map((g) => g.res.value))];
  let text;
  if (docField.field === "exists" && multi && got.some((g) => g.r.customer_name)) text = `Yes — ${got.length} ${docLabelLower}${got.length === 1 ? "" : "s"} on file for ${subject}: ${got.slice(0, 8).map((g) => `${g.r.customer_name ?? "customer"} (${g.res.value})`).join("; ")}.`;
  else if (docField.field === "exists") text = `Yes — ${subject} has ${got.length === 1 ? "a" : got.length} ${docLabelLower}${got.length === 1 ? "" : "s"} on file: ${distinct.join("; ")}.`;
  else if (got.length === 1 || distinct.length === 1) text = sentence(subject, got[0].res.value);
  else text = `${subject} has ${got.length} ${docLabelLower}s on file with different values: ${got.slice(0, 6).map((g) => `${g.res.value}${multi && g.r.customer_name ? ` (${g.r.customer_name})` : ""}`).join("; ")}.`;
  const extras = [...new Set(got.map((g) => g.res.extra).filter(Boolean))];
  if (extras.length === 1) text += ` ${extras[0]}`;
  return attachCitations({
    kind: "answer", text,
    facts: got.map((g) => ({ label: `${docLabel} ${docField.field}`, value: g.res.value, sources: [{ documentId: g.r.id, location: {} }] })),
    sources: [], confidence: 1, verifiedCount: got.length, unverifiedCount: 0, closest: [],
  }, {
    records: got.map((g) => documentRecord(g.r, { label: `${docLabel} · ${g.r.original_filename ?? g.r.id}`, sublabel: "" })),
    total: got.length, claimedCount: got.length,
    basis: docField.field === "exists" ? `Looked through the documents linked to ${subject}; found ${got.length} ${docLabelLower}${got.length === 1 ? "" : "s"}.` : `Read the printed ${docField.field} on the ${got.length === 1 ? docLabelLower : `${got.length} ${docLabelLower}s`} linked to ${subject}.`,
  });
}

/** "status of permit BP-2026-10023" / "which vendor was PO-9081 from": find the one document carrying that number and read the field. */
async function runDocNumberField(db, parsed) {
  const { doctype, field } = parsed.docField;
  const num = parsed.docNumber;
  const label = documentTypeLabel(doctype);
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  const { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, d.created_at, string_agg(p.text, E'\n' ORDER BY p.page_no) AS text
       FROM documents d JOIN document_pages p ON p.document_id = d.id AND p.${TENANT_SQL}
      WHERE d.${TENANT_SQL} AND ${typeSql("d.document_type")} = ANY($1::text[]) AND position(lower($2::text) in lower(p.text)) > 0
      GROUP BY d.id, d.document_type, d.original_filename, d.created_at ORDER BY d.created_at DESC LIMIT 5`,
    [docTypeAliases(doctype), num]
  );
  if (!rows.length) {
    return attachCitations({
      kind: "answer", text: `I couldn't find ${lower} ${num} on file.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: [], total: 0, kind: "searched", basis: `Searched the text of every ${lower} on file for ${num}; none carries it.` });
  }
  const sentence = FIELD_SENTENCE[`${doctype}.${field}`];
  const got = rows.map((r) => ({ r, res: extractField(doctype, field, r.text) })).filter((g) => g.res);
  if (!sentence || !got.length) {
    return attachCitations({
      kind: "answer", text: `${label} ${num} is on file, but it doesn't print that detail.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    }, { records: rows.map((r) => documentRecord(r, { label: `${label} · ${r.original_filename ?? r.id}`, sublabel: "" })), total: rows.length, kind: "searched", basis: `Read ${lower} ${num}; the requested line is not printed on it.` });
  }
  const g = got[0];
  const subj = `${label} ${num}`;
  let text = (field === "city" ? `${subj} was issued by the City of ${g.res.value}.` : field === "status" ? `${subj} status: ${g.res.value}.` : sentence(subj, g.res.value));
  if (g.res.extra) text += ` ${g.res.extra}`;
  return attachCitations({
    kind: "answer", text,
    facts: [{ label: `${label} ${field}`, value: g.res.value, sources: [{ documentId: g.r.id, location: {} }] }],
    sources: [], confidence: 1, verifiedCount: 1, unverifiedCount: 0, closest: [],
  }, { records: [documentRecord(g.r, { label: `${label} · ${g.r.original_filename ?? g.r.id}`, sublabel: "" })], total: 1, claimedCount: 1, basis: `Read the printed ${field} on ${lower} ${num}.` });
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
