/**
 * Donovan claim-check (R11, build spec item 3) — pure normalization helpers shared by split.js and
 * check.js. No DB, no model, no I/O: every function here is a plain string/number transform so it is
 * directly unit-testable and safe to call from a hot request path.
 */

/** "$1,250.00" | "1,250" | "1250.00" | "1250" all normalize to the string "1250" (or "1250.00" trimmed
 *  of trailing zeros is NOT collapsed — money is compared as a numeric VALUE, not a formatted string,
 *  so trailing-zero differences never cause a false mismatch). Returns null when `tok` has no digits. */
export function normalizeAmount(tok) {
  const s = String(tok ?? "").trim();
  const cleaned = s.replace(/^[$#]/, "").replace(/,/g, "");
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Two amount-like tokens are equal when their normalized numeric VALUES match exactly (no rounding —
 *  a claim stating $1,250 when the source says $1,250.37 is NOT the same amount). */
export function amountsEqual(a, b) {
  const na = normalizeAmount(a);
  const nb = normalizeAmount(b);
  return na != null && nb != null && na === nb;
}

/** Bounded Levenshtein edit distance, capped at `max` (returns max+1 the moment it is exceeded — this
 *  is only ever used for a small bounded threshold check, never to report a real distance). */
export function boundedLevenshtein(a, b, max) {
  const s = String(a ?? "");
  const t = String(b ?? "");
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    let rowMin = cur[0];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // early out: no way back under the cap
    prev = cur;
  }
  return prev[t.length];
}

/**
 * Fuzzy-but-bounded name match (build spec: "names with typos"). Exact (case/space-insensitive) match
 * always passes; otherwise a single-token typo is tolerated (edit distance 1 for names <= 8 letters, 2
 * for longer ones) — generous enough for a transposed/dropped letter, never enough to match a
 * different name. `a` is the claimed name, `b` a candidate word or phrase pulled from the source text.
 */
export function namesMatch(a, b) {
  const na = String(a ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const nb = String(b ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!na || !nb) return false;
  if (na === nb) return true;
  const max = na.length <= 8 ? 1 : 2;
  return boundedLevenshtein(na, nb, max) <= max;
}

/** Digit-bearing tokens (numbers, money, ids) — same shape verify.js already uses, kept here so
 *  split.js/check.js have one shared definition. */
export function digitTokens(s) {
  return (String(s ?? "").toLowerCase().match(/[a-z0-9$#][a-z0-9$#.,:/-]*/g) ?? [])
    .map((tok) => tok.replace(/[.,:/-]+$/, ""))
    .filter((tok) => /\d/.test(tok));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Does an exact/normalized-amount token appear as a whole token inside `haystack` (already lowercased)? */
export function amountTokenIn(haystack, needle) {
  const target = normalizeAmount(needle);
  if (target == null) return false;
  const candidates = [...haystack.matchAll(/[$#]?[\d][\d,]*(?:\.\d+)?/g)].map((m) => m[0]);
  return candidates.some((c) => normalizeAmount(c) === target);
}

/** Does the bare word/id token appear, word-bounded, inside `haystack` (already lowercased)? */
export function wordTokenIn(haystack, needle) {
  const v = String(needle ?? "").toLowerCase();
  if (!v) return false;
  const re = new RegExp(`(?<![a-z0-9])${escapeRe(v)}(?![a-z0-9])`);
  return re.test(haystack);
}

/** Fuzzy word-ish presence: does some word in `haystack` bounded-match `needle`? Capped scan (only
 *  checks distinct words) so this stays cheap even on a full page of text. */
export function fuzzyWordIn(haystack, needle) {
  const words = new Set((String(haystack ?? "").toLowerCase().match(/[a-z']{3,}/g) ?? []));
  for (const w of words) if (namesMatch(needle, w)) return true;
  return false;
}

/**
 * Does `haystack` support a (possibly multi-word) name claim? Splits `fullName` into its own words and
 * fuzzy-matches EACH one (>= 3 letters; a bare initial is not checkable on its own and is skipped)
 * against `haystack`'s words independently — "Jonathan Smith" supports against "...Jonathon Smith..."
 * even though the two PHRASES differ, because each individual word does. Every checkable word must
 * match: a name is either the one on file or it is not, so partial credit ("Smith" matched but a
 * completely different first name") does not count as support.
 */
export function nameSupportedIn(haystack, fullName) {
  const hay = String(haystack ?? "").toLowerCase();
  if (hay.includes(String(fullName ?? "").toLowerCase().trim())) return true;
  const parts = String(fullName ?? "").toLowerCase().match(/[a-z']{3,}/g) ?? [];
  if (!parts.length) return false;
  return parts.every((p) => wordTokenIn(hay, p) || fuzzyWordIn(hay, p));
}
