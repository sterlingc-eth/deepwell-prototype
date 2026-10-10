/**
 * Round 18 (H4) multi-turn follow-up engine — barrel export. api/ask.js does not import this directly
 * (see conversation.js, which re-exports the pieces it already imported, so the existing wiring at
 * api/ask.js:789-797 picks up every improvement here with no change of its own — see this round's
 * report for the ONE optional additive line that would also surface `needsClarification`/`clarifyText`).
 */
export { resolveFollowup, composeFollowupFilters } from './resolve.js';
export { looksLikeContinuation, classifyFollowupKind, looksLikeDisambiguationReply, detectSwapTarget } from './classify.js';
export { subjectFromText, subjectFromEntities, brandMentionIn } from './subject.js';
export { slotFollowup, slotRewrite } from './slots.js';
