/**
 * Conversational follow-up context (TEAM T2, 2026-09-25; multi-turn engine, Round 18 H4) — the shape
 * shared between the client's minimal AskScreen thread UI (src/screens/AskScreen.tsx), wherever the
 * server threads it into searchKnowledge/mapReduceAnswer, and Team T1's Sonnet research agent, so
 * "and last year?" / "just the Trane ones" / "who was the tech?" / "no, the one in Chandler" compose
 * with the PRIOR turn instead of being asked cold. This module owns the shape/validation; the actual
 * deterministic (no model call) resolution now lives in api/_lib/followup/** (see that folder's
 * resolve.js) — this file re-exports the same three function names api/ask.js already imports
 * (isFollowupContinuation, composeFollowup, composeFollowupFilters) so every improvement there reaches
 * production with NO other file's import changed. It does not itself call searchKnowledge or the agent.
 *
 * ---------------------------------------------------------------- SHAPES
 *
 * ConversationTurn (one prior question-and-answer, as the client remembers it):
 *   {
 *     question: string,
 *     resolvedFilters?: { customerIds?, unitIds?, docTypes?, dateFrom?, dateTo?, technician? },
 *     resolvedEntities?: [{ type: 'customer'|'unit', id: string, label?: string, sublabel?: string }],
 *     pendingClarification?: boolean,  // true when THIS turn's own answer was itself a "which one did
 *                                      // you mean" prompt (see contactLookup.js/docLookup.js/fastPath.js's
 *                                      // own disambiguation answers) — resolvedEntities then carries the
 *                                      // candidates it named, and the very next reply is read as picking
 *                                      // one of them (api/_lib/followup/resolve.js's disambiguation-reply
 *                                      // path) rather than as a fresh question.
 *     askedAt?: string,   // ISO timestamp, informational only
 *   }
 * ConversationContext (what the client sends alongside a follow-up question):
 *   { turns: ConversationTurn[] }   // most-recent last; capped at MAX_CONTEXT_TURNS
 *
 * `resolvedEntities`/`resolvedFilters`/`pendingClarification` are the client's own accounting of what
 * the PREVIOUS answer resolved — the natural source is that answer's own citation contract
 * (api/_lib/citations/records.js's `data.records`: {type, id, label, sublabel, ...}) filtered to
 * type 'customer'/'unit'. The client is the ONLY place a ConversationContext is assembled — nothing
 * here reads or writes any server-side session. "New question" in the thread UI simply means the
 * client sends no conversationContext at all.
 *
 * ------------------------------------------------------------- TRUST BOUNDARY
 *
 * A ConversationContext is client-supplied and validated, never trusted for
 * tenant scoping or security — every id it carries is re-checked against
 * this tenant's own rows by whatever calls searchKnowledge/searchPassages
 * downstream (RLS + the normal filter-resolution queries), exactly as if the
 * ids had come from the query text itself. It is a HINT for composing the
 * next question, nothing more; a malformed or hostile context degrades to
 * "no context" (an ordinary first question), never an error and never an
 * elevated scope. api/_lib/followup/resolve.js's own header comment spells out
 * exactly how this holds even when a resolvedEntities id/label was injected
 * by a hostile client rather than echoed back honestly.
 */
import { resolveFollowup, composeFollowupFilters as composeFollowupFiltersImpl, looksLikeContinuation } from './followup/index.js';

export const MAX_CONTEXT_TURNS = 4;
const MAX_QUESTION_CHARS = 500;
const MAX_SUBLABEL_CHARS = 200;
const FILTER_ARRAY_KEYS = ['customerIds', 'unitIds', 'docTypes'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

function sanitizeFilters(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const key of FILTER_ARRAY_KEYS) {
    const v = raw[key];
    if (!Array.isArray(v)) continue;
    let cleaned = v.filter((x) => typeof x === 'string' && x.length < 200).slice(0, 200);
    if (key === 'customerIds' || key === 'unitIds') cleaned = cleaned.filter((x) => UUID_RE.test(x));
    if (cleaned.length) out[key] = cleaned;
  }
  if (typeof raw.dateFrom === 'string' && ISO_DATE_RE.test(raw.dateFrom)) out.dateFrom = raw.dateFrom;
  if (typeof raw.dateTo === 'string' && ISO_DATE_RE.test(raw.dateTo)) out.dateTo = raw.dateTo;
  if (typeof raw.technician === 'string' && raw.technician.trim() && raw.technician.length < 200) out.technician = raw.technician.trim();
  return Object.keys(out).length ? out : undefined;
}

function sanitizeEntities(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((e) => e && (e.type === 'customer' || e.type === 'unit') && typeof e.id === 'string' && UUID_RE.test(e.id))
    .slice(0, 20)
    .map((e) => ({
      type: e.type,
      id: e.id,
      ...(typeof e.label === 'string' ? { label: e.label.slice(0, 200) } : {}),
      // sublabel (e.g. a customer's service address, a unit's model/serial) is what the follow-up
      // engine matches a disambiguation reply ("the one in Chandler") or "the other unit" against —
      // see api/_lib/followup/resolve.js. Text only, never trusted as an id.
      ...(typeof e.sublabel === 'string' && e.sublabel.trim() ? { sublabel: e.sublabel.slice(0, MAX_SUBLABEL_CHARS) } : {}),
    }));
  return out.length ? out : undefined;
}

/**
 * Sanitizes whatever the client sent. Never throws; a malformed shape simply
 * comes back as `{ turns: [] }` (equivalent to a fresh "New question").
 * @returns {{turns: object[]}}
 */
export function validateConversationContext(raw) {
  const turnsIn = Array.isArray(raw?.turns) ? raw.turns : [];
  const turns = turnsIn
    .filter((t) => t && typeof t.question === 'string' && t.question.trim())
    .slice(-MAX_CONTEXT_TURNS)
    .map((t) => ({
      question: t.question.trim().slice(0, MAX_QUESTION_CHARS),
      ...(sanitizeFilters(t.resolvedFilters) ? { resolvedFilters: sanitizeFilters(t.resolvedFilters) } : {}),
      ...(sanitizeEntities(t.resolvedEntities) ? { resolvedEntities: sanitizeEntities(t.resolvedEntities) } : {}),
      ...(t.pendingClarification === true ? { pendingClarification: true } : {}),
      ...(typeof t.askedAt === 'string' ? { askedAt: t.askedAt.slice(0, 40) } : {}),
    }));
  return { turns };
}

export function lastTurn(context) {
  const turns = context?.turns ?? [];
  return turns.length ? turns[turns.length - 1] : null;
}

/* ============================================================== composition
 *
 * Round 18 (H4): the actual heuristics/rewriting used to live here (a bare
 * lead-in/anaphora regex plus "question — following up on: prior question"
 * concatenation). They now live in api/_lib/followup/** (classify.js +
 * resolve.js) — real pronoun/ellipsis substitution, list/count refinement,
 * "the other unit", "same question for X", and disambiguation-reply
 * resolution, all still deterministic and still returning the same shapes
 * these three functions have always returned, so api/ask.js's existing
 * import of THIS file (`./_lib/conversation.js`) needs no change at all.
 */

/**
 * Heuristic (deterministic, no model call): does `question` read like a
 * follow-up to the previous turn rather than a fresh, self-contained
 * question? Exported so the client thread UI and T1's agent can both use the
 * SAME rule for "does this need the prior turn at all". `priorTurn` is
 * optional (api/ask.js's own call site doesn't pass it) — passing it lets a
 * turn whose OWN answer was a "which one did you mean" prompt
 * (`pendingClarification: true`) recognize a wider range of short replies as
 * continuations; see api/_lib/followup/classify.js's own doc comment.
 */
export function isFollowupContinuation(question, priorTurn) {
  return looksLikeContinuation(question, priorTurn ?? null);
}

/**
 * Merges a follow-up's own signals onto the previous turn's resolvedFilters.
 * Only ever OVERRIDES a dimension the new question explicitly restates (a new
 * date phrase, a doc-type word); everything else — most importantly WHICH
 * customer/unit — carries over unchanged, since a short follow-up almost
 * never renames its subject. Pure; never throws.
 */
export function composeFollowupFilters(prevFilters = {}, question) {
  return composeFollowupFiltersImpl(prevFilters, question);
}

/**
 * The one call site T1's agent / the ask pipeline needs: given a validated
 * ConversationContext and the new question, returns the query text to
 * actually search with — a real self-contained rewrite for a pronoun/ellipsis
 * continuation ("and their phone?" -> "and the customer at 214 Mercer St's
 * phone?"), a list/count refinement ("how many of those are Trane" -> "how
 * many of Bracken's units are Trane"), an entity swap ("same question for
 * Bracken"), or a disambiguation-reply/"the other unit" pick — and the
 * composed filters.
 *
 * Deliberately kept to the exact three-key shape this function has always
 * returned (existing callers, e.g. scripts/verify-knowledge.mjs, compare it
 * verbatim) even though api/_lib/followup/resolve.js's `resolveFollowup` now
 * computes a richer result internally (`kind`, `needsClarification`,
 * `clarifyText`, `resolvedEntityId`). A caller that wants those additive
 * fields — e.g. api/ask.js, to return a clarifying question directly instead
 * of searching on an unresolved "it" — should import `resolveFollowup` from
 * `./followup/index.js` directly rather than through this wrapper; see this
 * round's report for the exact one-line change that would be.
 * @returns {{query: string, filters: object, isFollowup: boolean}}
 */
export function composeFollowup(context, question) {
  const r = resolveFollowup(context, question);
  return { query: r.query, filters: r.filters, isFollowup: r.isFollowup };
}

/**
 * A turn that stands on its own inside a chat: a full question (>= 4 words, starts like a question or a command) that refers to nothing said before
 * (no it/that/them/those/this/these/he/she/his/her/their/there/same/also/too, no "and what about / how about / what about / and the", not "and ..."
 * or "or ..." leading). Used ONLY to let the industry lane answer the question exactly as it would fresh; a real follow-up keeps skipping the lane.
 */
const REF_RE = /\b(?:it|its|that|those|them|they|their|theirs|this(?!\s+(?:week|month|year|quarter|season))|these|he|him|his|she|her|hers|(?<!\bare\s)(?<!\bis\s)there|same|also|too|again|former|latter|above|previous|earlier|prior|other ones?|the others?)\b|\b(?:and|but|or)\s+(?:what|how)\s+about\b|\b(?:what|how)\s+about\b|\b(?:and|but|or|so|then|now)\s+(?:the|for|in|at|with|how|what|which|who|when|where)\b/i;
const START_RE = /^\s*(?:what|which|who|whom|whose|when|where|how|why|list|show|give|tell|find|are|is|do|does|did|can|could|has|have|any|count)\b/i;
const RECORD_NOUN_RE = /\b(?:permits?|inspections?|invoices?|work ?orders?|tests?|devices?|heaters?|units?|leases?|documents?|licen[sc]es?|certificates?|coi|cois|bonds?|panels?|tickets?|vendors?|tenants?|customers?|jobs?|sites?|warrant(?:y|ies)|contracts?|properties|buildings?|policies|reports?|records?|files?|quotes?|proposals?|equipment|systems?|backflows?|reviews?)\b/;
export function isSelfContainedTurn(question) {
  const q = String(question ?? '').trim();
  if (!q) return false;
  if (q.split(/\s+/).length < 4) return false;
  if (!START_RE.test(q)) return false;
  if (REF_RE.test(q)) return false;
  // "How many are RPZ?" / "Which are expiring?" / "Which ones are overdue?": an attribute asked about the previous answer's rows, with no record noun of its own
  if (/^\s*(?:how many|which|what)\s+ones?\b/i.test(q)) return false;
  const m = /^\s*(?:how many|which|what)\s+(?:are|is|were|was)\s+(.+)$/i.exec(q);
  if (m) { const rest = m[1].toLowerCase().replace(/[?.!,]/g, '').split(/\s+/).filter((w) => !/^(?:the|a|an|our|my|any|all|only|just|of|we|you|there|currently|right|now)$/.test(w)); if (rest.length <= 4 && !RECORD_NOUN_RE.test(rest.join(' '))) return false; }
  return true;
}
