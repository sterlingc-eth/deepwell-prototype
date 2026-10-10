/**
 * Round 18 (H4): the actual multi-turn resolver — turns a follow-up question plus a validated
 * ConversationContext (see conversation.js) into a SELF-CONTAINED question the existing deterministic
 * handlers (fastPath.js, contactLookup.js, docLookup.js, the analytics planner) can answer exactly as
 * if it had been typed that way, never a special "typed intent" object those files would need new code
 * to understand — the whole point is zero engine-code changes elsewhere (R18_CONTRACT.md's H4 line).
 *
 * Pure. No DB, no model, no network. Tenant safety is architectural, not a check this file performs:
 * a resolvedEntities id is NEVER used to fetch a record directly — only its label/sublabel TEXT is
 * ever folded into the rewritten question, and every deterministic handler downstream re-resolves that
 * text against ITS OWN tenant-scoped rows (RLS), exactly as it would a typo'd address a user typed
 * themselves. A hostile/foreign id can at most make this file compose a sentence mentioning a name or
 * address that doesn't exist for this tenant — which resolves to "no match" downstream, never someone
 * else's data (see scripts/verify-followups-r18.mjs's cross-tenant-injection cases for the proof).
 *
 * Exposes exactly one integration entry point: resolveFollowup(context, question).
 */
import { extractSubject } from '../fastPath.js';
import { resolveAnyTimeRange } from '../analytics.js';
import { extractDocTypeMentions } from '../search/knowledge.js';
import { KNOWN_AZ_CITY_NAMES } from '../analytics.js';
import { looksLikeContinuation, classifyFollowupKind, detectSwapTarget, looksLikeDisambiguationReply } from './classify.js';
import { slotFollowup } from './slots.js';
import { subjectFromText, subjectFromEntities, pronounReplacement, substitutePronouns, stripTrailingPunct, brandMentionIn, inferNoun, anchorAlreadyPresent, pronounNeedsBrandFromEarlierTurn } from './subject.js';

/** Runs a pronoun substitution and guarantees the anchor's own raw text (address/name/customer
 *  number) ends up somewhere in the result — appending `repl.place` when the substitution didn't
 *  already leave it in (e.g. a "their"/"his"/"her" -> "the customer's" possessive swap). */
function rewriteWithAnchor(question, subject) {
  const repl = pronounReplacement(subject);
  if (!repl) return { query: question, changed: false };
  const sub = substitutePronouns(question, repl);
  const base = sub.changed ? sub.question : question;
  const needsPlace = !sub.changed || !anchorAlreadyPresent(base, subject);
  const query = needsPlace ? `${stripTrailingPunct(base)} ${repl.place}` : base;
  return { query, changed: true };
}

const MAX_QUERY_CHARS = 700; // defense in depth; api/ask.js's own MAX_QUESTION re-check is the hard cap

/** Never look further back than the (already MAX_CONTEXT_TURNS-capped) context itself. */
function findAnchor(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const fromEntities = subjectFromEntities(t.resolvedEntities);
    // R21 (M3, C9): `listScope` is what a MULTI-entity prior turn (a city-scoped customer count, a
    // brand-filtered equipment list — neither reduces to a single name/address) carries forward; it
    // must count as a real anchor exactly like address/name/candidateUnits do below, or an 8-of-10
    // dialogue shape ("how many customers in Tempe" -> "how many of those have a Carrier unit")
    // silently loses the whole prior turn (see subjectFromEntities' own doc comment).
    if (fromEntities.hasAny && (fromEntities.address || fromEntities.name || fromEntities.candidateUnits?.length || fromEntities.listScope)) {
      return { subject: fromEntities, turn: t };
    }
    const fromText = subjectFromText(t.question);
    if (fromText.hasAny) return { subject: fromText, turn: t };
    // This turn named no subject of its own. Keep walking back ONLY if it was itself a continuation
    // (so a chain like "…214 Mercer" -> "and their phone?" -> "when were we last out there?" still
    // reaches all the way back to the address) — a turn that was a genuinely fresh, self-contained
    // question with nothing this file could extract is a topic boundary: stop, never reach past it.
    if (!looksLikeContinuation(t.question, turns[i - 1] ?? null)) return null;
  }
  return null;
}

/** Merges a follow-up's own date/doc-type signals onto the anchor turn's resolvedFilters — unchanged
 *  behavior from the original T2 composeFollowupFilters, just relocated (conversation.js re-exports it). */
export function composeFollowupFilters(prevFilters = {}, question) {
  const merged = { ...(prevFilters ?? {}) };
  const range = resolveAnyTimeRange(question, new Date().toISOString().slice(0, 10));
  if (range?.from) { merged.dateFrom = range.from; merged.dateTo = range.to ?? range.from; }
  const docTypes = extractDocTypeMentions(question);
  if (docTypes.length) merged.docTypes = docTypes;
  return merged;
}

function clip(q) {
  const s = String(q ?? '');
  return s.length > MAX_QUERY_CHARS ? s.slice(0, MAX_QUERY_CHARS) : s;
}

function passthrough(question, filters = {}) {
  return { query: clip(question), filters, isFollowup: false, kind: 'fresh', needsClarification: false };
}

// ------------------------------------------------------------ disambiguation-reply ("no, the one in Chandler")

function cityIn(text) {
  const q = String(text ?? '').toLowerCase();
  return KNOWN_AZ_CITY_NAMES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(q)) ?? null;
}

const ORDINAL_WORD = { first: 0, second: 1, third: 2, fourth: 3 };

/** Picks exactly one candidate out of a prior turn's resolvedEntities from a short reply — ordinal
 *  ("the second one"), a city/street match against each candidate's sublabel, or the candidate's own
 *  label named back verbatim. Returns null (never a guess) when zero or more than one match. */
function pickDisambiguationCandidate(question, candidates) {
  const q = String(question ?? '').trim();
  const qLower = q.toLowerCase();

  const ordinalMatch = qLower.match(/\b(first|second|third|fourth|last)\b/);
  if (ordinalMatch) {
    const word = ordinalMatch[1];
    const pick = word === 'last' ? candidates[candidates.length - 1] : candidates[ORDINAL_WORD[word]];
    if (pick) return pick;
  }

  const city = cityIn(q);
  if (city) {
    const matches = candidates.filter((c) => c.sublabel && new RegExp(`\\b${city}\\b`, 'i').test(c.sublabel));
    if (matches.length === 1) return matches[0];
  }

  const byLabel = candidates.filter((c) => c.label && qLower.includes(String(c.label).toLowerCase()));
  if (byLabel.length === 1) return byLabel[0];

  const probe = extractSubject(q);
  if (probe.address) {
    const houseNumber = probe.address.match(/^\d+/)?.[0];
    const matches = candidates.filter(
      (c) => c.sublabel && houseNumber && String(c.sublabel).includes(houseNumber) &&
        String(c.sublabel).toLowerCase().includes(probe.address.toLowerCase())
    );
    if (matches.length === 1) return matches[0];
  }

  return null;
}

function resolveDisambiguationReply(question, priorTurn) {
  const candidates = [...(priorTurn.resolvedEntities ?? [])].filter((e) => e.type === 'customer' || e.type === 'unit');
  if (candidates.length < 2) return null;
  const pick = pickDisambiguationCandidate(question, candidates);
  if (!pick) {
    const names = candidates.slice(0, 6).map((c) => c.sublabel ? `${c.label} (${c.sublabel})` : c.label).join(', ');
    return {
      query: clip(question), filters: {}, isFollowup: true, kind: 'disambiguation-reply',
      needsClarification: true, clarifyText: `Which one did you mean — ${names}?`,
    };
  }
  const phrase = pick.sublabel ? `${pick.label} (${pick.sublabel})` : pick.label;
  const query = `${stripTrailingPunct(priorTurn.question)} — specifically ${phrase}`;
  return { query: clip(query), filters: {}, isFollowup: true, kind: 'disambiguation-reply', needsClarification: false, resolvedEntityId: pick.id };
}

// ------------------------------------------------------------------------------- "the other unit"

function resolveOtherEntity(question, priorTurn, anchor) {
  const units = anchor?.subject?.candidateUnits?.length ? anchor.subject.candidateUnits
    : (priorTurn.resolvedEntities ?? []).filter((e) => e.type === 'unit');
  if (units.length < 2) return null;
  const focusedId = priorTurn.resolvedFilters?.unitIds?.[0] ?? null;
  const remaining = focusedId ? units.filter((u) => u.id !== focusedId) : units.slice(1);
  if (remaining.length !== 1) return null; // still ambiguous (0, or 2+ untouched units) — never guess
  const other = remaining[0];
  const phrase = other.sublabel ? `${other.label} (${other.sublabel})` : other.label;
  const query = `${stripTrailingPunct(priorTurn.question)} — specifically the other unit, ${phrase}`;
  return { query: clip(query), filters: {}, isFollowup: true, kind: 'other-entity', needsClarification: false, resolvedEntityId: other.id };
}

// -------------------------------------------------------------------------------------- entity swap

function buildSwapQuestion(priorTurn, target) {
  const probe = extractSubject(`for ${target}`);
  const newSubjectText = probe.address || probe.name || target;
  const priorSubj = subjectFromText(priorTurn.question);
  if (priorSubj.address && priorTurn.question.includes(priorSubj.address)) return priorTurn.question.replace(priorSubj.address, newSubjectText);
  if (priorSubj.name && priorTurn.question.includes(priorSubj.name)) return priorTurn.question.replace(priorSubj.name, newSubjectText);
  if (priorSubj.customerNumber && priorTurn.question.includes(priorSubj.customerNumber)) return priorTurn.question.replace(priorSubj.customerNumber, newSubjectText);
  const newSubject = { address: probe.address, name: probe.name || (!probe.address ? target : null), noun: inferNoun(priorTurn.question) };
  const rewritten = rewriteWithAnchor(priorTurn.question, newSubject);
  if (rewritten.changed) return rewritten.query;
  return `${stripTrailingPunct(priorTurn.question)} for ${target}`;
}

function resolveSwap(question, priorTurn) {
  const target = detectSwapTarget(question);
  if (!target) return null;
  const probe = extractSubject(`for ${target}`);
  if (!probe.hasAny) return null; // "what about tomorrow" etc. — not a real entity swap, fall through
  const query = buildSwapQuestion(priorTurn, target);
  return { query: clip(query), filters: {}, isFollowup: true, kind: 'swap', needsClarification: false };
}

// ------------------------------------------------------------------------------------- refinement

// A bare "those/these/them/that one" with no real anchor subject (a tenant-wide aggregate like "how
// many pieces of equipment do we have" names no customer/address to carry forward) still needs SOME
// substitution — the analytics planner deliberately refuses a bare pronoun fragment with nothing
// concrete to filter on (see api/_lib/analytics/detPlan.js's FOLLOW_UP_FRAGMENT_RE/generic-entity
// bail), so "those" becomes a generic noun phrase ("the units") rather than being left as a dangling
// pronoun the planner has no vocabulary for.
const GENERIC_PRONOUN_RE = /\b(those|these|them|that one)\b/i;
function genericSubstitution(question, noun, brandLabel = null) {
  if (!GENERIC_PRONOUN_RE.test(question)) return question;
  const phrase = brandLabel ? `${brandLabel} ${noun}` : noun;
  return question.replace(GENERIC_PRONOUN_RE, `the ${phrase}`);
}

/**
 * R20 (J2, dialogue d005 — "how many carrier units do we have on the books" / "and how many of
 * those are past their warranty?"): a bare tenant-wide aggregate turn names no customer/address
 * (findAnchor returns null for it — nothing pronounReplacement could stand in for), so the brand
 * it DID name ("carrier") was only ever recovered from the CURRENT question's own text
 * (brandMentionIn(question)) — never carried forward from the turn "those" is actually referring
 * back to. Every downstream caller (api/ask.js's own composeFollowup call site) reads only this
 * function's rewritten `query` text, never its `filters` object (see api/ask.js:794-795 — the
 * deterministic analytics planner parses free text, not a filters map), so an inherited brand has
 * to land IN THE REWRITTEN QUESTION TEXT itself, not just in `filters.manufacturer`, to actually
 * narrow the next turn's count the way "those" implies.
 *
 * R20 (J4, dialogue d036 — "how many goodman units are on our books" / "do we have more of those
 * than lennox"): a bare `brandMentionIn(question)` reports "some brand is mentioned somewhere in this
 * text", which used to false-positive on a two-brand COMPARISON — "lennox" here is the comparison
 * TARGET this question names itself, never what "those" (Goodman, from the turn above) refers to —
 * and silently dropped the Goodman half entirely. pronounNeedsBrandFromEarlierTurn (subject.js) is the
 * position-aware version: it still blocks inheritance for an ordinary "of those Trane units" (the
 * question really does name its own brand for the pronoun), but recognizes a brand-vs-pronoun "than"
 * split as still needing the earlier turn's brand for the pronoun's own half.
 */
function inheritedBrandFrom(question, priorTurn) {
  if (!pronounNeedsBrandFromEarlierTurn(question)) return null;
  return priorTurn ? brandMentionIn(priorTurn.question) : null;
}

function resolveRefinement(question, anchor, priorTurn) {
  const inherited = inheritedBrandFrom(question, priorTurn);
  const brand = brandMentionIn(question) || inherited;
  const docTypes = extractDocTypeMentions(question);
  // An anchor with only a bare candidate-unit LIST (no single resolved name/address — e.g. the prior
  // turn was itself a tenant-wide count, not about one customer) has nothing pronounReplacement can
  // stand in for; rewriteWithAnchor then leaves the pronoun untouched (`changed: false`), and the
  // generic noun substitution below is the right fallback rather than shipping a dangling "those".
  const rewritten = anchor ? rewriteWithAnchor(question, anchor.subject) : { query: question, changed: false };
  const noun = anchor?.subject?.noun || inferNoun(question);
  let q = rewritten.changed ? rewritten.query : genericSubstitution(question, noun, inherited?.label);
  // The anchor DID rewrite the pronoun (a named customer/address carried forward) but an inherited
  // brand still isn't anywhere in the resulting text ("those" replaced by the customer's own
  // possessive, never a noun phrase genericSubstitution could have folded the brand into) — append it
  // rather than silently drop it.
  if (inherited && !new RegExp(`\\b${inherited.key}\\b`, 'i').test(q)) {
    q = `${stripTrailingPunct(q)} (${inherited.label} only)`;
  }
  const filters = {};
  if (brand) filters.manufacturer = brand.key;
  if (docTypes.length) filters.docTypes = docTypes;
  return { query: clip(q), filters, isFollowup: true, kind: 'refinement', needsClarification: false };
}

// --------------------------------------------------------------------------------- pronoun / ellipsis

function resolvePronoun(question, anchor, priorTurn) {
  if (!anchor) return passthrough(question, composeFollowupFilters(priorTurn?.resolvedFilters, question));
  const rewritten = rewriteWithAnchor(question, anchor.subject);
  if (!rewritten.changed) return passthrough(question, composeFollowupFilters(priorTurn?.resolvedFilters, question));
  return { query: clip(rewritten.query), filters: composeFollowupFilters(priorTurn?.resolvedFilters, question), isFollowup: true, kind: 'pronoun', needsClarification: false };
}

// ------------------------------------------------------------------------------------- entry point

/**
 * @param {{turns: object[]}} context validated ConversationContext (conversation.js's validateConversationContext)
 * @param {string} question the next question, as typed
 * @returns {{query: string, filters: object, isFollowup: boolean, kind: string, needsClarification: boolean,
 *            clarifyText?: string, resolvedEntityId?: string}}
 */
export function resolveFollowup(context, question) {
  const turns = context?.turns ?? [];
  const q = String(question ?? '');
  if (!turns.length) return passthrough(q);
  const priorTurn = turns[turns.length - 1];

  // Disambiguation reply takes priority whenever the prior turn actually offered >=2 candidates —
  // regardless of which lead-in phrase this reply used, since a "which one did you mean" prompt is
  // itself the strongest possible continuation signal.
  const priorCandidates = (priorTurn.resolvedEntities ?? []).filter((e) => e.type === 'customer' || e.type === 'unit');
  if (priorCandidates.length >= 2 && looksLikeDisambiguationReply(q, priorTurn)) {
    const resolved = resolveDisambiguationReply(q, priorTurn);
    if (resolved) return resolved;
  }

  // R2 (B1): an elliptical follow-up that names ONE new slot value (period, person, city, brand, document type,
  // dollar threshold), asks a different measure of the same scope, or asks another field of the same document
  // is composed into a self-contained question from the prior question's own text (slots.js).
  const slotted = slotFollowup(turns, q);
  if (slotted) return { query: clip(slotted.query), filters: {}, isFollowup: true, kind: 'slot', needsClarification: false };

  if (!looksLikeContinuation(q, priorTurn)) return passthrough(q);

  const kind = classifyFollowupKind(q);
  const anchor = findAnchor(turns);

  if (kind === 'other-entity') {
    const resolved = resolveOtherEntity(q, priorTurn, anchor);
    if (resolved) return resolved;
    return {
      query: clip(q), filters: {}, isFollowup: true, kind: 'other-entity', needsClarification: true,
      clarifyText: 'Which unit do you mean — could you give the model, serial, or a location detail?',
    };
  }

  if (kind === 'swap') {
    const resolved = resolveSwap(q, priorTurn);
    if (resolved) return resolved;
    // Not actually a resolvable swap ("what about tomorrow?") — fall through to ordinary pronoun handling.
  }

  const curSubj = subjectFromText(q);
  // R21 (M3): a STRONG subject (a real address/name/customer-number/identifier) really does make the
  // question self-contained — never staple the anchor on top of it. A bare `cityOnly` hit is weaker:
  // "how many of those are in Mesa" names a place but is still built entirely around a dangling
  // "those" that needs the anchor's own noun/brand — treating cityOnly alone as "already
  // self-contained" (the old behavior) silently dropped the anchor's scope on exactly this shape.
  const hasStrongSubject = Boolean(curSubj.address || curSubj.name || curSubj.customerNumber || curSubj.identifier);
  if (hasStrongSubject) {
    // The question already names its OWN subject — never staple the anchor's on top of it. Filters
    // (date range / doc type) still merge; the ENTITY never does.
    return { query: clip(q), filters: composeFollowupFilters(priorTurn.resolvedFilters, q), isFollowup: true, kind: 'own-subject', needsClarification: false };
  }

  if (kind === 'refinement') return resolveRefinement(q, anchor, priorTurn);
  return resolvePronoun(q, anchor, priorTurn);
}
