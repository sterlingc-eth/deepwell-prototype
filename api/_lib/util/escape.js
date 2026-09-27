/**
 * Shared string-escaping helpers.
 *
 * Consolidated (R18 P3 house cleaning) from the many byte-identical local
 * copies that had accumulated across api/_lib/** over 18 rounds:
 * agent/shape.js, agent/verify.js, claims/normalize.js, compose.js,
 * scorecard/compare.js, learning/recipes.js and agent/tools.js/scope.js's
 * LIKE-pattern variant. Behavior-preserving: same character classes, same
 * replacement, one definition. (api/_lib/search/knowledge.js and
 * documentTypes.js keep their own copies — those files are owned elsewhere
 * this round.)
 */

/** Escape a string for literal use inside a `new RegExp(...)` pattern. */
export function escapeRegex(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a string for literal use inside a SQL LIKE/ILIKE pattern (`\`, `%`, `_`). */
export function escapeLikePattern(s) {
  return String(s ?? '').replace(/[\\%_]/g, '\\$&');
}
