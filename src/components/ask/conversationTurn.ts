/**
 * Round 18 P2 — multi-turn client wiring, the one place AskScreen and AskTab both build the
 * ConversationTurn the deterministic follow-up engine actually understands (api/_lib/conversation.js's
 * validateConversationContext / api/_lib/followup/index.js). A single call site so the two client
 * surfaces can never drift on this shape.
 *
 * `src/core/types.ts`'s own ConversationTurn is kept deliberately minimal (question + askedAt) — this
 * round doesn't give this engineer that file to edit — so the two extra fields the server accepts
 * (resolvedEntities, pendingClarification) are declared here instead, as ThreadTurn. A ThreadTurn is
 * always assignable wherever a ConversationTurn is expected (TS arrays are covariant), so
 * `{ turns: threadTurns }` passes straight through AskOptions.conversationContext with no cast.
 */
import type { Answer, ConversationTurn } from '../../core/types';

export interface ThreadTurn extends ConversationTurn {
  /** The customer/unit rows this turn's own answer resolved — api/_lib/conversation.js's
   *  sanitizeEntities accepts exactly this shape (type/id/label/sublabel), filtered to the two types
   *  the follow-up engine resolves against ("the other unit", "same question for X", a disambiguation
   *  reply). Never trusted server-side for tenant scoping — every id is re-checked against this
   *  tenant's own rows downstream; it's a hint for composing the next question, nothing more. */
  resolvedEntities?: { type: 'customer' | 'unit'; id: string; label: string; sublabel?: string }[];
  /** True when THIS turn's own answer was itself a "which one/unit did you mean" disambiguation prompt
   *  — the next reply is then read as picking one of resolvedEntities' candidates rather than as a
   *  fresh question (api/_lib/followup/resolve.js's disambiguation-reply path). */
  pendingClarification?: boolean;
}

/** Matches api/_lib/conversation.js's own sanitizeEntities cap — never let a huge/hostile response
 *  balloon what gets cached in the client-side thread either. */
const MAX_RESOLVED_ENTITIES = 20;

// Every current disambiguation answer (contactLookup.js/docLookup.js/financials/answers.js's ambiguous-
// name-match answers, and api/_lib/followup/resolve.js's own clarifyText) uses this exact phrasing —
// "which one did you mean", "which unit do you mean" — so it's a stable, cross-cutting UX marker, not
// exam question text. The server's own `candidateCount` field (the more structural signal) doesn't
// reach the client today — src/services/answerService.claude.ts's normalizeAnswer rebuilds the Answer
// object field-by-field and doesn't forward it; see this round's report for the one-line addition that
// would let this check use that instead of text.
const CLARIFICATION_RE = /which\s+\w+\s+(?:do|did)\s+you\s+mean/i;

/** True when `answer` is itself a disambiguation prompt ("Which one did you mean?"). */
export function answerAsksWhichOne(answer: Pick<Answer, 'text'>): boolean {
  return CLARIFICATION_RE.test(answer.text);
}

/** The customer/unit rows behind `answer`, as the next question's own resolvedEntities — Answer.records
 *  (the citation contract) filtered to the two types the follow-up engine resolves against, deduped by
 *  id, capped. `undefined` (never an empty array) when there's nothing to carry, so spreading it into a
 *  ThreadTurn never adds a stray empty field. */
export function resolvedEntitiesFrom(answer: Pick<Answer, 'records'>): ThreadTurn['resolvedEntities'] {
  const seen = new Set<string>();
  const out: NonNullable<ThreadTurn['resolvedEntities']> = [];
  for (const r of answer.records ?? []) {
    if (r.type !== 'customer' && r.type !== 'unit') continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ type: r.type, id: r.id, label: r.label, ...(r.sublabel ? { sublabel: r.sublabel } : {}) });
    if (out.length >= MAX_RESOLVED_ENTITIES) break;
  }
  return out.length ? out : undefined;
}

/** Builds the ThreadTurn to append once `question` has been answered — the one function both
 *  AskScreen's `submit` and AskTab's `submit` call after a successful ask(). */
export function turnFrom(question: string, answer: Answer): ThreadTurn {
  const resolvedEntities = resolvedEntitiesFrom(answer);
  return {
    question,
    askedAt: new Date().toISOString(),
    ...(resolvedEntities ? { resolvedEntities } : {}),
    ...(answerAsksWhichOne(answer) ? { pendingClarification: true } : {}),
  };
}
