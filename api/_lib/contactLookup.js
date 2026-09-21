/**
 * Contact-lookup-by-name fast path (live miss cluster 1, 2026-09-21
 * 270-question sample): "what's the phone number on file for donna
 * thornton", "what's the email for sandra wyckoff", "what's the ph# on file
 * for brian chavez" all returned "Nothing in your records answers that" —
 * retrieval had nothing to cite because the value was never printed on a
 * document page at all, it's a plain column on the customer's own entity row
 * (data->>'phone' / data->>'email' / data->>'service_address').
 *
 * api/_lib/fastPath.js already has customer_phone/customer_email intents,
 * but classifyIntent (fastPath.js) requires either a real extracted subject
 * (extractSubject's NAME_HINT_RE et al., which all require a CAPITALIZED
 * name) or an HVAC domain anchor (condenser/furnace/...). A dispatcher typing
 * a lowercase name with no HVAC-specific word satisfies neither, so
 * classifyFastPath returns null there and the question falls through to
 * retrieval, which has no page to cite. This file is a separate, narrower
 * fast path for exactly that shape — case-INSENSITIVE on the name on
 * purpose, since that's precisely the gap above.
 *
 * Wired into api/ask.js BEFORE the analytics gate and before retrieval (see
 * that file's own comment at the call site). No model call, ever: the
 * answer is built straight from a customers row — see usage.js's
 * isCountableAskSource, which never lists 'contact-lookup' as countable.
 *
 * Pure functions (parseContactLookupQuestion, fuzzyNameMatches,
 * buildContactAnswer) are unit-tested with no database — see
 * scripts/verify-analytics.mjs's contact-lookup section. resolveContact/
 * runContactLookup are the only functions here that touch `db`.
 */

/* ============================================================ shape detection */

// Field trigger words, checked in this order (most specific first isn't
// actually required here — the three groups share no words — but keeping a
// fixed order makes the classifier's `field` choice deterministic when a
// question somehow contains more than one, e.g. "phone or email").
// "ph#" ends in a non-word character, so it can't share the OTHER
// alternatives' trailing `\b` (a word boundary requires one side to be a
// word character — "#" followed by a space has no boundary there at all) —
// given its own alternative with no trailing boundary requirement instead.
const FIELD_RE = {
  phone: /\bphone(?:\s*number)?\b|\bph\s?#/i,
  email: /\be-?mail\b/i,
  address: /\b(?:service\s+)?address\b/i,
};
const FIELD_ORDER = ["phone", "email", "address"];

// The name phrase must be the LAST thing in the question, right after
// "for"/"of"/"on file for" — every word slot here is letters (plus
// apostrophe/period/hyphen) only, so a street address ("...for 1234 Main
// St") or an analytics question with no trailing name ("...have a phone")
// never satisfies this and the whole match fails, deferring to fastPath/
// retrieval/analytics exactly as before. Capped at 3 words (a first + middle
// + last name), matching the brief's "1-3 capitalized-or-not words".
const CONNECTOR_NAME_RE =
  /\b(?:on file for|for|of)\s+([a-zA-Z][a-zA-Z'.-]*(?:\s+[a-zA-Z][a-zA-Z'.-]*){0,2})\s*\??\s*$/i;

// The same field words FIELD_RE recognizes, as one alternation string, for
// the possessive shape below ("<name>'s phone number" / "<name> address") —
// built from FIELD_RE's own source text so the two can never drift apart.
const FIELD_WORDS_ALT = "phone(?:\\s*number)?|ph\\s?#|e-?mail|(?:service\\s+)?address";

// Reviewer NO-GO (2026-09-21): "whats thomas mercer's phone number" / "donna
// thornton's email" / "brian chavez address?" put the NAME before the field
// instead of after a "for/of" connector. Filler ("whats"/"what's"/"what is")
// is stripped first, then two shapes are tried against what's left, name
// tokens WITHOUT an apostrophe so the possessive "'s" itself is never
// swallowed into the name capture:
//   A. "<name>'s <field>"  — the possessive case
//   B. "<name> <field>"    — no possessive at all
// Anchored to the WHOLE remaining string ($) so this never fires on a
// question that merely happens to contain a name and a field word somewhere
// (e.g. an analytics question naming several other words in between).
const LEADING_FILLER_RE = /^(?:what'?s|whats|what\s+is)\s+/i;
const POSSESSIVE_NAME_FIELD_RE = new RegExp(
  `^([A-Za-z][A-Za-z.-]*(?:\\s+[A-Za-z][A-Za-z.-]*){0,2})'s\\s+(${FIELD_WORDS_ALT})\\s*\\??\\s*$`,
  "i"
);
const BARE_NAME_FIELD_RE = new RegExp(
  `^([A-Za-z][A-Za-z'.-]*(?:\\s+[A-Za-z][A-Za-z'.-]*){0,2})\\s+(${FIELD_WORDS_ALT})\\s*\\??\\s*$`,
  "i"
);

// A real person/company name is never introduced by an article, possessive
// pronoun, or a question/quantifier word — "for the newsletter", "for the
// file", "for our customers", "which customers ... email", "the shop['s]
// phone", "the Trane unit['s] address" are aggregate/incidental phrasings
// this shape must not mistake for a name (see the "never hijack an
// analytics question" requirement). Rejecting a captured phrase that STARTS
// with one of these closes that off without narrowing the name pattern
// itself.
const NAME_STOPWORD_RE =
  /^(?:the|a|an|this|that|these|those|our|their|his|her|my|your|its|which|who|what|how|does|do|did|is|are|list|show|has|have)$/i;

function firstWordIsStopword(namePhrase) {
  return NAME_STOPWORD_RE.test(namePhrase.split(/\s+/)[0]);
}

/**
 * Pure: question text -> {field, namePhrase} or null.
 *   field: 'phone' | 'email' | 'address'
 *   namePhrase: the 1-3 word name as typed (any case)
 *
 * Deliberately conservative: no field keyword, or no name-shaped tail/head
 * next to it, and this returns null rather than guessing — the caller
 * (runContactLookup) then defers to whatever would have handled the
 * question anyway.
 */
export function parseContactLookupQuestion(question) {
  const q = String(question ?? "").trim();
  if (!q) return null;

  // Shape 1: "<field> ... for/of <name>" (the original, more specific shape
  // — tried first since a "for/of"-connector match is a stronger signal
  // than the bare name-before-field shapes below).
  let field = null;
  for (const f of FIELD_ORDER) {
    if (FIELD_RE[f].test(q)) {
      field = f;
      break;
    }
  }
  if (field) {
    const m = q.match(CONNECTOR_NAME_RE);
    if (m) {
      const namePhrase = m[1].trim();
      if (namePhrase && !firstWordIsStopword(namePhrase)) return { field, namePhrase };
    }
  }

  // Shape 2: "<name>['s] <field>" — the name comes first. Filler ("whats"/
  // "what's"/"what is") is stripped, then the possessive form is tried
  // before the bare form (see POSSESSIVE_NAME_FIELD_RE's own doc comment).
  const stripped = q.replace(LEADING_FILLER_RE, "").trim();
  for (const re of [POSSESSIVE_NAME_FIELD_RE, BARE_NAME_FIELD_RE]) {
    const m = stripped.match(re);
    if (!m) continue;
    const namePhrase = m[1].trim();
    const matchedField = fieldFromText(m[2]);
    if (namePhrase && matchedField && !firstWordIsStopword(namePhrase)) {
      return { field: matchedField, namePhrase };
    }
  }

  return null;
}

/** Which canonical field a small matched fragment ("phone number", "ph#",
 *  "email", "address", "service address") represents — reuses FIELD_RE
 *  itself so this can never disagree with the shape-1 field detection
 *  above. */
function fieldFromText(text) {
  const t = String(text ?? "");
  for (const f of FIELD_ORDER) {
    if (FIELD_RE[f].test(t)) return f;
  }
  return null;
}

/* ============================================================ name matching */

export function nameTokens(namePhrase) {
  return String(namePhrase ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** True when `a`/`b` are the same word, one substitution/transposition apart
 *  (equal length), or one insertion/deletion apart (length differs by 1) —
 *  Damerau-Levenshtein distance <= 1. Duplicated from nlNormalize.js's own
 *  (unexported) withinEditDistance1 rather than adding a cross-file
 *  dependency for six lines of pure string math. */
function withinEditDistance1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diffCount = 0;
    let i1 = -1;
    let i2 = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffCount++;
        if (diffCount === 1) i1 = i;
        else if (diffCount === 2) i2 = i;
        else return false;
      }
    }
    if (diffCount <= 1) return true;
    return i2 === i1 + 1 && a[i1] === b[i2] && a[i2] === b[i1];
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let usedSkip = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (usedSkip) return false;
    usedSkip = true;
    j++;
  }
  return true;
}

/**
 * Pure: does this tenant customer's own name match the searched name tokens?
 * Surname (last token) within Damerau-Levenshtein <= 1 of the customer's own
 * last token, AND (the search named no first name at all — a surname-only
 * search — OR its first token equals the customer's own first token,
 * case-insensitively). Never matches on surname alone when a first name was
 * given and disagrees — that's exactly what keeps "brian chavez" from also
 * matching a "Brian Chavez" false-positive's near-namesake "Brian Chaves"
 * while still failing closed against an unrelated "Diane Chavez".
 */
export function fuzzyNameMatches(customerName, searchTokens) {
  const custTokens = nameTokens(customerName);
  if (!custTokens.length || !searchTokens?.length) return false;
  const custSurname = custTokens[custTokens.length - 1];
  const searchSurname = searchTokens[searchTokens.length - 1];
  if (!withinEditDistance1(custSurname, searchSurname)) return false;
  if (searchTokens.length === 1) return true; // surname-only search
  return custTokens[0] === searchTokens[0];
}

/* ============================================================ answer building */

const FIELD_WORD = { phone: "phone", email: "email", address: "service address" };
const CUSTOMER_FIELD_KEY = { phone: "phone", email: "email", address: "service_address" };

/** {label, value, entityId, sources} for every contact field this customer
 *  row actually has on file — same "entityId links a fact to the customer,
 *  sources: []" shape analytics.js's own customer-row facts already use (see
 *  e.g. shapeCustomerRow/queryTopCustomers in routes/analytics.js) — the
 *  FactGrid component links a fact with an entityId to that customer's
 *  profile regardless of which endpoint produced it. */
function contactFacts(row) {
  const facts = [];
  if (row.phone) facts.push({ label: "Phone", value: row.phone, entityId: row.id, sources: [] });
  if (row.email) facts.push({ label: "Email", value: row.email, entityId: row.id, sources: [] });
  if (row.service_address) facts.push({ label: "Address", value: row.service_address, entityId: row.id, sources: [] });
  return facts;
}

/** Pure: build the final answer for exactly one resolved customer row. A
 *  missing REQUESTED field is answered honestly ("No phone on file for
 *  Donna Thornton.") with no facts, rather than a confident-looking blank —
 *  the same "never guess" rule fastPath.js's own field lookups follow.
 *  Otherwise the answer names every contact field actually on file (not just
 *  the one asked about), same as a customer-profile card would show. */
export function buildContactAnswer(field, row) {
  const name = row.customer_name || row.customer_number || "This customer";
  const requestedValue = row[CUSTOMER_FIELD_KEY[field]];

  if (!requestedValue) {
    return {
      kind: "answer",
      text: `No ${FIELD_WORD[field]} on file for ${name}.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
    };
  }

  const facts = contactFacts(row);
  const summary = [row.phone, row.email, row.service_address].filter(Boolean).join(" · ");
  return {
    kind: "answer",
    text: `${name} — ${summary}`,
    facts, sources: [], confidence: 1,
    verifiedCount: facts.length, unverifiedCount: 0, closest: [],
  };
}

/** Pure: more than one customer matched the searched name — name them and
 *  ask which, rather than guessing one (same rule fastPath.js's own
 *  pickUnique/"ambiguity never guessed through" follows). Each candidate is
 *  its own linkable fact so the client can offer them as choices. */
export function buildAmbiguousContactAnswer(namePhrase, rows) {
  const names = rows.map((r) => r.customer_name || r.customer_number || "Unnamed customer");
  return {
    kind: "answer",
    text: `I found more than one match for "${namePhrase}": ${names.join(", ")}. Which one did you mean?`,
    facts: rows.map((r) => ({
      label: r.customer_name || r.customer_number || "Unnamed customer",
      value: r.service_address || "—",
      entityId: r.id, sources: [],
    })),
    sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
  };
}

/* ============================================================ DB resolution
 * The only two functions in this file that touch `db` (a recordsStore.js
 * store, called from inside a withTenant transaction — same calling
 * convention as fastPathQuery.js). Tenant-scoped throughout via the same
 * predicate ask.js/analytics.js each already duplicate for their own
 * db.raw() escape-hatch queries (see recordsStore.js's own TENANT constant).
 */
const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const CUSTOMER_ROW_COLUMNS =
  "id, customer_number, data->>'customer_name' AS customer_name, " +
  "data->>'service_address' AS service_address, data->>'phone' AS phone, data->>'email' AS email";

// A fuzzy fallback scan reads every customer name on the tenant (there is no
// SQL index for "last token within edit distance 1 of this"), so it's capped
// the same way ask.js's own meta-router list queries are bounded, rather
// than left unbounded.
const FUZZY_SCAN_LIMIT = 3000;

/**
 * Resolve a name phrase against this tenant's own customers: an exact-ish
 * ILIKE match on the full name first (cheap, and correct for the common
 * case); if that finds nothing, a fuzzy fallback scan matching the surname
 * (last token) within Damerau-Levenshtein <= 1 — see fuzzyNameMatches. Never
 * reaches across tenants: every query here carries the same TENANT_SQL
 * predicate every other tenant-scoped read in this codebase does.
 */
export async function resolveContactCandidates(db, namePhrase) {
  const searchTokens = nameTokens(namePhrase);
  if (!searchTokens.length) return [];

  const { rows: exact } = await db.raw(
    `SELECT ${CUSTOMER_ROW_COLUMNS}
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'customer_name' ILIKE $1
      LIMIT 10`,
    [namePhrase]
  );
  if (exact.length) return exact;

  const { rows: all } = await db.raw(
    `SELECT ${CUSTOMER_ROW_COLUMNS}
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND ${TENANT_SQL}
        AND data->>'customer_name' IS NOT NULL AND data->>'customer_name' <> ''
      LIMIT ${FUZZY_SCAN_LIMIT}`,
    []
  );
  return all.filter((r) => fuzzyNameMatches(r.customer_name, searchTokens));
}

/**
 * Full orchestration for one question: shape detection -> DB resolution ->
 * answer building. Returns null (never throws for a shape/resolution miss)
 * whenever this isn't confidently a contact lookup, or the name resolves to
 * zero customers — the caller (api/ask.js) then falls through to
 * fastPath/analytics/retrieval exactly as if this file didn't exist, per the
 * "never hijack" requirement: an address-based question ("who is at 1234
 * Main St") or an analytics question ("how many customers have a phone")
 * never even produces a namePhrase (see CONNECTOR_NAME_RE's own doc
 * comment), and a namePhrase that matches no customer is reported as a miss,
 * not guessed at.
 */
export async function runContactLookup(db, question) {
  const parsed = parseContactLookupQuestion(question);
  if (!parsed) return null;

  const candidates = await resolveContactCandidates(db, parsed.namePhrase);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return buildAmbiguousContactAnswer(parsed.namePhrase, candidates);
  return buildContactAnswer(parsed.field, candidates[0]);
}
