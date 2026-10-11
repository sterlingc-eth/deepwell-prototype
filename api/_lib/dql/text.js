/**
 * dql/text.js - pure text helpers for the DQL parser: tokens, conservative typo repair, phrase scanning.
 *
 * Tokens keep their position so every slot detector can mark exactly the words it explained (the coverage rule in parse.js
 * needs to know which words nothing explained). Nothing here knows about any business or any field.
 */

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase().replace(/[’‘`]/g, "'")
    .replace(/(\d),(\d{3})/g, '$1$2')               // 5,000 -> 5000
    .replace(/\$\s+(\d)/g, '$$$1')                  // "$ 500" -> "$500"
    .replace(/(\$?)\b(\d+(?:\.\d+)?)\s*k\b/g, (_, d, n) => `$${String(Math.round(Number(n) * 1000))}`) // 5k -> $5000 (a k is always money: 2k must not be read as the year 2000)
    .replace(/\b(\d+)\s*(?:st|nd|rd|th)\b/g, '$1')
    .replace(/%/g, ' percent ');
  const out = [];
  const re = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}(?:-\d{2})?|(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]*|\$?\d+(?:\.\d+)?|[a-z]+(?:[-'][a-z0-9]+)*/g;
  let m;
  while ((m = re.exec(s))) {
    let w = m[0];
    let poss = false;
    if (/'s$/.test(w)) { w = w.slice(0, -2); poss = true; } else if (/s'$/.test(w)) { w = w.slice(0, -1); poss = true; }
    w = w.replace(/'/g, '');
    if (!w) continue;
    out.push({ w, i: out.length, poss, used: null });
  }
  return out;
}

export const words = (toks) => toks.map((t) => t.w);

/** Damerau-Levenshtein limited to `max` (returns max+1 when farther). */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Repair one misspelled word against a vocabulary. Conservative: only words of >= 4 letters that are NOT already known, only when exactly one
 * vocabulary word is the closest (distance 1; distance 2 for words of >= 8 letters), and never into a different word that is itself a plain
 * word the question could have meant (the caller passes `known`: anything in it is left alone).
 */
export function repairWord(w, vocabByLen, known) {
  if (w.length < 4 || known.has(w) || /\d/.test(w)) return null;
  const max = w.length >= 8 ? 2 : 1;
  let best = null; let bestD = max + 1; let tie = false;
  for (let len = w.length - max; len <= w.length + max; len++) {
    for (const v of vocabByLen.get(len) ?? []) {
      const d = editDistance(w, v, max);
      if (d < bestD) { best = v; bestD = d; tie = false; } else if (d === bestD && v !== best) tie = true;
    }
  }
  return best && !tie && bestD <= max ? best : null;
}

export function indexByLen(vocab) {
  const m = new Map();
  for (const v of vocab) { const l = v.length; if (!m.has(l)) m.set(l, []); m.get(l).push(v); }
  return m;
}

/** Find the first run of tokens equal to `phrase` (array of words) among tokens not yet used; returns start index or -1. */
export function findRun(toks, phrase, from = 0) {
  outer: for (let i = from; i + phrase.length <= toks.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      const t = toks[i + j];
      if (t.used || t.w !== phrase[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function markRun(toks, start, len, tag) {
  for (let k = start; k < start + len; k++) toks[k].used = tag;
}

/** A word's plural/singular variants (very small, regular rules only). */
export function variants(w) {
  const out = new Set([w]);
  if (w.endsWith('ies') && w.length > 4) out.add(`${w.slice(0, -3)}y`);
  if (w.endsWith('es') && w.length > 4) out.add(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 3) out.add(w.slice(0, -1));
  if (w.endsWith('y') && w.length > 3) out.add(`${w.slice(0, -1)}ies`);
  if (!w.endsWith('s')) { out.add(`${w}s`); out.add(`${w}es`); }
  return out;
}
