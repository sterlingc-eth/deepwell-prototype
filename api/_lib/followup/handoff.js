/**
 * Follow-up hand-off to the router (Round 5 merge fix).
 *
 * resolveFollowup turns a follow-up into a standalone question. Two kinds of result need the router to treat them with care:
 *   - "merged": the DQL merge (dqlmerge.js) built a question the DQL parser fully explains. The older lanes answer some such questions while
 *     ignoring a condition the merge carried ("... in Casa Grande", "since 2015", "the next 6 months"), so DQL must be the one to answer it.
 *   - "released": a follow-up whose pronoun ("them", "those") could not be given a safe referent. Typed as it is, an older lane would answer it
 *     while ignoring the pronoun, so no lane may claim it (the question then goes on as an unclaimed one).
 * The router (router/classifyAll.js) asks here by the question text. A small bounded set, keyed by the lower-cased text, no tenant data.
 */
const MAX = 500;
const key = (q) => String(q ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s?.!]+$/, '').trim();
const merged = new Set();
const released = new Set();
function put(set, q) { const k = key(q); if (!k) return; if (set.size >= MAX) set.delete(set.values().next().value); set.add(k); }

export const markMerged = (q) => put(merged, q);
export const markReleased = (q) => put(released, q);
export const isMerged = (q) => merged.has(key(q));
export const isReleased = (q) => released.has(key(q));

/** A question with no subject noun of its own: "how many are Trane", "which are in Mesa", "as a technician". */
const FRAGMENT_RE = /^(?:(?:and|ok|okay|so|hey)\s+)*(?:(?:how many|how much|which)\s+(?:of\s+(?:them|those|these)\s+)?(?:are|is|were|was)\s+(?:the\s+)?[\w.-]+(?:\s+[\w.-]+)?|(?:as|but as|now as)\s+(?:a|an|the)\s+[\w-]+(?:\s+[\w-]+)?)$/i;

export const isFragment = (q) => FRAGMENT_RE.test(String(q ?? '').trim().replace(/[?.!\s]+$/, ''));
