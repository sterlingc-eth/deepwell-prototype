/**
 * Command palette fuzzy matching (round 17, U2/D2 IA build — top_12_fixes #5,
 * "no global Cmd/Ctrl+K anywhere in the app"). Deliberately tiny and
 * dependency-free: every character of `query` must appear in `text`, in
 * order, but not necessarily adjacent — the same "quick open" rule editors
 * like VS Code/Sublime use, so "hd45" still finds a serial that reads
 * "HD-4521-X". No new package, no server call: this only ever runs against
 * strings the caller already has in memory.
 *
 * Returns `null` on no match, otherwise a score where higher is better —
 * callers sort candidates by this and slice to the top few per group. The
 * score rewards a longer contiguous run (a real substring beats scattered
 * letters) and an earlier first-match position (a serial that STARTS with
 * what you typed outranks one that merely contains it near the end).
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0; // empty query matches everything, in whatever order the caller already has it
  const t = text.toLowerCase();

  let ti = 0;
  let score = 0;
  let run = 0;
  let firstIndex = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi] as string;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (firstIndex === -1) firstIndex = found;
    if (found === ti) {
      run += 1;
      score += 3 + run; // contiguous runs compound — "abc" beats "a-b-c"
    } else {
      run = 0;
      score += 1;
    }
    ti = found + 1;
  }
  score += Math.max(0, 24 - firstIndex); // an earlier hit is a better hit
  score -= Math.min(20, Math.floor(t.length / 8)); // a shorter, more precise haystack wins ties
  return score;
}

/** Best score across several fields (title + subtitle, say) — `null` only when none of them match. */
export function fuzzyScoreAny(query: string, texts: (string | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const text of texts) {
    if (!text) continue;
    const s = fuzzyScore(query, text);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}
