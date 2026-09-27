/**
 * Round 18 (H4): classification only — does a question read like a follow-up at all, and if so, which
 * of the shapes in R18_CONTRACT.md's goal line is it? Every check here is a plain regex over the
 * question text (plus the shape of the PRIOR turn, never its content) — no DB, no model.
 *
 * This is the canonical source for "does this look like a continuation" — conversation.js's exported
 * `isFollowupContinuation` (kept for api/ask.js's existing import) delegates to `looksLikeContinuation`
 * here rather than the other way around, so there is exactly one place this rule lives.
 */

// A short lead-in word/phrase that means "this continues what I just asked" on its own, regardless of
// what follows. "no,"/"nope"/"not X" cover a disambiguation-reply's usual shape ("no, the one in
// Chandler") without requiring the client to have flagged `pendingClarification` (see resolveDisambiguationReply
// in resolve.js, which still requires an actual >=2-candidate turn before it acts on this).
const LEAD_IN_RE = /^(and\b|also\b|just\b|only\b|what about\b|how about\b|same\b|no,?\s|nope,?\s|not\b)/i;

// A pronoun/anaphor with no named subject of its own. Deliberately short-circuited by a length cap
// (isFollowupContinuation below) so a genuinely fresh, long question that happens to contain "it"
// somewhere is never mistaken for a follow-up.
const ANAPHORA_RE = /\b(it|them|those|these|that one|the other|the same|him|her|their|there|the tech(nician)?)\b/i;

// "the one in Chandler" / "the first one" / "the second one" — a disambiguation-reply's usual shape.
const ORDINAL_PICK_RE = /\b(the\s+)?(first|second|third|fourth|last)\s+(one|unit|customer)\b/i;

/**
 * @param {string} question
 * @param {{pendingClarification?: boolean}|null} priorTurn
 */
export function looksLikeContinuation(question, priorTurn) {
  const q = String(question ?? '').trim();
  if (!q) return false;
  if (LEAD_IN_RE.test(q)) return true;
  if (ORDINAL_PICK_RE.test(q) && q.length <= 80) return true;
  if (q.length <= 80 && ANAPHORA_RE.test(q)) return true;
  // A turn that just asked "which one did you mean" gets a lot more latitude — almost anything short
  // coming right back is an answer to THAT question, not a new one.
  if (priorTurn?.pendingClarification && q.length <= 160) return true;
  return false;
}

const OTHER_ENTITY_RE = /\bthe other\b(\s+(one|unit|equipment|property|address|customer))?/i;
const REFINEMENT_RE = /\b(of\s+(those|these|them)|which\s+(of\s+)?(those|these)|how\s+many\s+(of\s+)?(those|these|them))\b/i;
const SWAP_RE = /^(?:same\s+(?:question|thing)(?:\s+again)?\s+for\s+|what about\s+)(.+?)[?.!]*$/i;

/** Extracts the "for X" / "what about X" target phrase, or null. Never matches "the other ..." — that
 *  is resolve.js's other-entity path, not an entity swap. */
export function detectSwapTarget(question) {
  const m = String(question ?? '').match(SWAP_RE);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest || OTHER_ENTITY_RE.test(rest)) return null;
  return rest;
}

/**
 * One of: 'other-entity' | 'swap' | 'refinement' | 'pronoun'. Only meaningful once
 * `looksLikeContinuation` is already true — this just picks WHICH rewrite strategy applies.
 */
export function classifyFollowupKind(question) {
  const q = String(question ?? '');
  if (OTHER_ENTITY_RE.test(q)) return 'other-entity';
  if (detectSwapTarget(q)) return 'swap';
  if (REFINEMENT_RE.test(q)) return 'refinement';
  return 'pronoun';
}

/** True when this reply looks like it's picking among several candidates (ordinal, "no, X", or the
 *  prior turn explicitly flagged itself as a "which one did you mean" prompt) — used together with the
 *  prior turn actually HAVING >=2 candidates before anything acts on it. Deliberately does NOT treat
 *  every short reply as a disambiguation pick with no other signal: two candidate entities can show up
 *  on an ordinary answer too (a customer with two units), and a bare short FRESH question ("who's the
 *  tech?") must not be hijacked into "which one did you mean" just because it's short. */
export function looksLikeDisambiguationReply(question, priorTurn) {
  const q = String(question ?? '').trim();
  if (!q) return false;
  if (priorTurn?.pendingClarification) return true;
  if (ORDINAL_PICK_RE.test(q)) return true;
  if (/^(no|nope)\b/i.test(q)) return true;
  return false;
}
