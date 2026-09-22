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
import { normalizeQuestion } from "./nlNormalize.js";
import { ENTITY_SYNONYMS, STREET_ADDRESS_RE, KNOWN_AZ_CITY_NAMES, KNOWN_US_CITY_NAMES } from "./analytics.js";
import { docTypeFromWord, docTypeSynonymAlternation, documentTypeLabel } from "./documentTypes.js";
import { mergeDocumentVia } from "./routes/customers.js";
import { resolveContactCandidates, resolveStreetCandidates, nameTokens } from "./contactLookup.js";

/* ============================================================ shape detection */

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
const NAME_OR_ADDRESS_SRC = `[A-Za-z0-9][A-Za-z0-9',.-]*(?:\\s+[A-Za-z0-9',.-]+){0,7}?`;
const TRAILING_JOB_RE_SRC = `(?:\\s+(?:job|install))?`;

const SHAPES = [
  // "do we have a PO on file for the Norwood job", "does anyone have a permit for 123 Main St"
  new RegExp(
    `^(?:do|does|did)\\s+(?:we|you)\\s+have\\s+(?:an?\\s+)?${DOCTYPE_RE_SRC}s?\\s*(?:on\\s+file\\s*)?(?:for|of)\\s+(?:the\\s+)?(${NAME_OR_ADDRESS_SRC})${TRAILING_JOB_RE_SRC}\\s*\\??$`,
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
const NAME_STOPWORD_RE =
  /^(?:the|a|an|this|that|these|those|our|their|his|her|my|your|its|which|who|what|how|why|when|does|do|did|is|are|was|were|list|show|has|have|had|in|on|at|of|for|with|without|any|some|all|last|next|first|second|third|most|many|few|several|pull|need|get)$/i;

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

function isRealNameOrAddressPhrase(phrase) {
  const p = String(phrase ?? "").trim();
  if (!p) return false;
  // Strip a trailing possessive/contraction ("what's" -> "what") before the
  // stopword check, so a leftover question-word fragment (only ever
  // produced by a shape mismatch — see "what's on the Mercer invoice" in
  // this file's own tests) is still caught.
  const firstWord = p.split(/\s+/)[0].toLowerCase().replace(/'s$/, "");
  if (NAME_STOPWORD_RE.test(firstWord)) return false;
  if (MONTH_NAMES.has(firstWord) && p.split(/\s+/).length <= 2) return false; // "for august", "for august 2024"
  if (TIME_WORDS.has(firstWord)) return false;
  if (AGGREGATE_WORD_RE.test(p)) return false;
  // A bare, single-word phrase that's a known city name is a geo scope, not a
  // customer/address — "for Gilbert"/"for Chandler" — never a customer named
  // after their own city, so this errs toward the far more common case.
  if (p.split(/\s+/).length === 1 && KNOWN_CITY_NAMES.has(firstWord)) return false;
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
  const q = normalizeQuestion(raw, { overlay }).normalized;
  if (!q || !DOCTYPE_WORD_RE.test(q)) return null; // cheap reject before trying every shape

  for (const re of SHAPES) {
    const m = q.match(re);
    if (!m) continue;
    const namePhrase = m[1].trim();
    if (!isRealNameOrAddressPhrase(namePhrase)) continue;
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
const MAX_DOCS = 10;

async function resolveCandidates(db, namePhrase, isAddress) {
  return isAddress ? resolveStreetCandidates(db, namePhrase) : resolveContactCandidates(db, namePhrase);
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
  const s = String(rawDate ?? "").trim();
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
export async function runDocLookup(db, question, opts = {}) {
  const parsed = parseDocLookupQuestion(question, opts);
  if (!parsed) return null;
  const { doctype, namePhrase, isAddress } = parsed;

  const candidates = await resolveCandidates(db, namePhrase, isAddress);
  if (candidates.length === 0) {
    const label = titleCase(namePhrase);
    return {
      kind: "answer",
      text: isAddress ? `I couldn't find a customer at ${label}.` : `I couldn't find a customer named ${label}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }
  if (candidates.length > 1) {
    const names = candidates.map((r) => r.customer_name || r.customer_number || "Unnamed customer");
    return {
      kind: "answer",
      text: `I found more than one match for "${namePhrase}": ${names.join(", ")}. Which one did you mean?`,
      facts: candidates.map((r) => ({
        label: r.customer_name || r.customer_number || "Unnamed customer",
        value: r.service_address || "—", entityId: r.id, sources: [],
      })),
      sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      candidateCount: candidates.length,
    };
  }

  const row = candidates[0];
  const name = row.customer_name || row.customer_number || "this customer";
  const ids = await customerDocumentIds(db, row);
  const docLabel = documentTypeLabel(doctype);
  const docLabelLower = docLabel.charAt(0).toLowerCase() + docLabel.slice(1);

  if (!ids.length) {
    return {
      kind: "answer", text: `No ${docLabelLower} on file for ${name}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  const { rows } = await db.raw(
    `SELECT d.id, d.document_type, d.original_filename, d.created_at,
            (SELECT x.value FROM extractions x
              WHERE x.document_id = d.id AND x.field_key = 'service_date' AND x.${TENANT_SQL}
              ORDER BY x.created_at DESC LIMIT 1) AS service_date
       FROM documents d
      WHERE d.id = ANY($1::uuid[]) AND d.document_type = $2 AND d.${TENANT_SQL}
      ORDER BY d.created_at DESC
      LIMIT ${MAX_DOCS}`,
    [ids, doctype]
  );

  if (!rows.length) {
    return {
      kind: "answer", text: `No ${docLabelLower} on file for ${name}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  const plural = rows.length === 1 ? docLabelLower : `${docLabelLower}${docLabelLower.endsWith("s") ? "" : "s"}`;
  const summaryList = rows
    .slice(0, 3)
    .map((r) => `${formatDateLabel(r.service_date ?? r.created_at)} · ${r.original_filename ?? r.id}`)
    .join("; ");
  const more = rows.length > 3 ? `, and ${rows.length - 3} more` : "";
  return {
    kind: "answer",
    text: `${rows.length} ${plural} on file for ${name}: ${summaryList}${more}.`,
    facts: rows.map((r) => ({
      label: docLabel,
      value: `${formatDateLabel(r.service_date ?? r.created_at)} · ${r.original_filename ?? r.id}`,
      sources: [{ documentId: r.id, location: {} }],
    })),
    sources: [], confidence: 1, verifiedCount: rows.length, unverifiedCount: 0, closest: [],
  };
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
    const rows = await resolveStreetCandidates(db, addrMatch[0]);
    if (rows.length === 1) {
      return { name: rows[0].customer_name || "this customer", address: rows[0].service_address || addrMatch[0], topic: topicWords(raw, addrMatch[0]) };
    }
    if (rows.length > 0) return null; // ambiguous — don't guess which one
  }
  const nameMatch = raw.match(TRAILING_NAME_FOR_ZERO_RE);
  if (nameMatch) {
    const phrase = nameMatch[1].trim();
    if (nameTokens(phrase).length && !AGGREGATE_WORD_RE.test(phrase)) {
      const rows = await resolveContactCandidates(db, phrase);
      if (rows.length === 1) {
        return { name: rows[0].customer_name || phrase, address: rows[0].service_address || null, topic: topicWords(raw, phrase) };
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
