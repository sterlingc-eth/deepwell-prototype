/**
 * Conversational follow-up context (TEAM T2, 2026-09-25) — the shape shared
 * between the client's minimal AskScreen thread UI (src/screens/AskScreen.tsx),
 * wherever the server threads it into searchKnowledge/mapReduceAnswer, and
 * Team T1's Sonnet research agent, so "and last year?" / "just the Trane
 * ones" / "who was the tech?" compose with the PRIOR turn instead of being
 * asked cold. This module owns the shape and the deterministic (no model
 * call) composition; it does not itself call searchKnowledge or the agent.
 *
 * ---------------------------------------------------------------- SHAPES
 *
 * ConversationTurn (one prior question-and-answer, as the client remembers it):
 *   {
 *     question: string,
 *     resolvedFilters?: { customerIds?, unitIds?, docTypes?, dateFrom?, dateTo?, technician? },
 *     resolvedEntities?: [{ type: 'customer'|'unit', id: string, label?: string }],
 *     askedAt?: string,   // ISO timestamp, informational only
 *   }
 * ConversationContext (what the client sends alongside a follow-up question):
 *   { turns: ConversationTurn[] }   // most-recent last; capped at MAX_CONTEXT_TURNS
 *
 * The client is the ONLY place a ConversationContext is assembled — nothing
 * here reads or writes any server-side session. "New question" in the
 * thread UI simply means the client sends no conversationContext at all.
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
 * elevated scope.
 */
import { resolveAnyTimeRange } from './analytics.js';
import { extractDocTypeMentions } from './search/knowledge.js';

export const MAX_CONTEXT_TURNS = 4;
const MAX_QUESTION_CHARS = 500;
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
    .map((e) => ({ type: e.type, id: e.id, ...(typeof e.label === 'string' ? { label: e.label.slice(0, 200) } : {}) }));
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
      ...(typeof t.askedAt === 'string' ? { askedAt: t.askedAt.slice(0, 40) } : {}),
    }));
  return { turns };
}

export function lastTurn(context) {
  const turns = context?.turns ?? [];
  return turns.length ? turns[turns.length - 1] : null;
}

/* ============================================================== composition */

const CONTINUATION_RE = /^(and\b|what about\b|just\b|only\b|how about\b|also\b)/i;
const ANAPHORA_RE = /\b(it|them|those|that one|him|her|the tech(nician)?|the same)\b/i;

/**
 * Heuristic (deterministic, no model call): does `question` read like a
 * follow-up to the previous turn rather than a fresh, self-contained
 * question? Short + starts with a connective, or leans on a pronoun with no
 * named subject of its own. Exported so the client thread UI and T1's agent
 * can both use the SAME rule for "does this need the prior turn at all".
 */
export function isFollowupContinuation(question) {
  const q = String(question ?? '').trim();
  if (!q) return false;
  if (CONTINUATION_RE.test(q)) return true;
  return q.length <= 60 && ANAPHORA_RE.test(q);
}

/**
 * Merges a follow-up's own signals onto the previous turn's resolvedFilters.
 * Only ever OVERRIDES a dimension the new question explicitly restates (a new
 * date phrase, a doc-type word); everything else — most importantly WHICH
 * customer/unit — carries over unchanged, since a short follow-up almost
 * never renames its subject. Pure; never throws.
 */
export function composeFollowupFilters(prevFilters = {}, question) {
  const merged = { ...(prevFilters ?? {}) };
  const range = resolveAnyTimeRange(question, new Date().toISOString().slice(0, 10));
  if (range?.from) { merged.dateFrom = range.from; merged.dateTo = range.to ?? range.from; }
  const docTypes = extractDocTypeMentions(question);
  if (docTypes.length) merged.docTypes = docTypes;
  return merged;
}

/**
 * The one call site T1's agent / the ask pipeline needs: given a validated
 * ConversationContext and the new question, returns the query text to
 * actually search with (folding in the prior question for a bare
 * continuation, so "and last year?" doesn't get searched on its own three
 * words) and the composed filters.
 * @returns {{query: string, filters: object, isFollowup: boolean}}
 */
export function composeFollowup(context, question) {
  const prev = lastTurn(context);
  if (!prev) return { query: question, filters: {}, isFollowup: false };
  const isFollowup = isFollowupContinuation(question);
  const query = isFollowup ? `${question} — following up on: "${prev.question}"` : question;
  const filters = composeFollowupFilters(prev.resolvedFilters, question);
  return { query, filters, isFollowup };
}
