/**
 * difflib.js - port of the parts of Python's difflib used by the reader (SequenceMatcher ratio, get_close_matches), no junk handling (autojunk only matters for sequences of 200+ items).
 * Same longest-match tie-breaking as CPython: earliest start in a, then earliest in b.
 */
function longestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const nj = new Map();
    const js = b2j.get(a[i]);
    if (js) {
      for (const j of js) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        nj.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
    }
    j2len = nj;
  }
  return [besti, bestj, bestsize];
}
function chars(s) { return Array.from(s); }
function b2jOf(b) {
  const m = new Map();
  for (let j = 0; j < b.length; j++) { const l = m.get(b[j]); if (l) l.push(j); else m.set(b[j], [j]); }
  return m;
}
function matched(a, b, b2j) {
  const q = [[0, a.length, 0, b.length]]; let total = 0;
  while (q.length) {
    const [alo, ahi, blo, bhi] = q.pop();
    const [i, j, k] = longestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      total += k;
      if (alo < i && blo < j) q.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) q.push([i + k, ahi, j + k, bhi]);
    }
  }
  return total;
}
/** SequenceMatcher(None, a, b).ratio() */
export function ratio(a0, b0) {
  const a = chars(a0), b = chars(b0);
  const t = a.length + b.length;
  if (!t) return 1.0;
  return (2.0 * matched(a, b, b2jOf(b))) / t;
}
/** difflib.get_close_matches(word, possibilities, n, cutoff): SequenceMatcher with seq2 = word, seq1 = each possibility */
export function getCloseMatches(word, possibilities, n = 3, cutoff = 0.6) {
  const w = chars(word), b2j = b2jOf(w); const res = [];
  for (const x of possibilities) {
    const a = chars(x); const t = a.length + w.length;
    // real_quick_ratio / quick_ratio are upper bounds of ratio(), so the final ratio alone decides
    const r = t ? (2.0 * matched(a, w, b2j)) / t : 1.0;
    if (r >= cutoff) res.push([r, x]);
  }
  res.sort((p, q) => (q[0] - p[0]) || (q[1] < p[1] ? -1 : q[1] > p[1] ? 1 : 0)); // heapq.nlargest on (score, string)
  return res.slice(0, n).map((z) => z[1]);
}
