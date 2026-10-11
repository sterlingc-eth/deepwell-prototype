/**
 * learned/features.js - the model's view of a question, identical in the trainer's data (scripts/gen-dql-training.mjs) and at runtime.
 *
 * The deterministic parser leaves a Work string: `orig` (the tokenised, typo-repaired question) and `rest` (the same string with every word a
 * detector EXPLAINED blanked out). Each word is therefore one of
 *   E  explained by a detector (a slot value or an operator word)
 *   F  left standing but on the parser's own filler list
 *   L  left standing and NOT filler (the coverage rule's "unexplained" words)
 * The view turns that into model tokens: E words that are not operator words (names, numbers, dates, cities ...) become a slot placeholder so no
 * organization's own names are learned; operator words (the model.opwords list, chosen by the trainer) stay as themselves.
 */

export const PLACE = { num: '<n>', slot: '<s>' };

/** -> [{w, k: 'E'|'F'|'L'}] */
export function classifyWords(orig, rest, left) {
  const out = [];
  const leftBag = new Map();
  for (const w of left ?? []) leftBag.set(w, (leftBag.get(w) ?? 0) + 1);
  const re = /\S+/g;
  for (let m; (m = re.exec(orig));) {
    const w = m[0];
    const seg = rest.slice(m.index, m.index + w.length);
    const explained = seg.trim() === '';
    if (explained) { out.push({ w, k: 'E' }); continue; }
    const c = leftBag.get(w) ?? 0;
    if (c > 0) { leftBag.set(w, c - 1); out.push({ w, k: 'L' }); } else out.push({ w, k: 'F' });
  }
  return out;
}

export function viewTokens(words, opwords) {
  return words.map((t) => {
    if (t.k !== 'E') return t.w;
    if (/\d/.test(t.w)) return PLACE.num;
    return opwords.has(t.w) ? t.w : PLACE.slot;
  });
}

/* ---------------------------------------------------------------------------------------------- feature sets (mirror of scripts/train-dql-planner.py) */

export function headFeats(v) {
  const seq = ['^', ...v, '$'];
  const f = new Set();
  for (const t of seq) f.add(`w:${t}`);
  for (let i = 0; i < seq.length - 1; i++) f.add(`b:${seq[i]} ${seq[i + 1]}`);
  for (let i = 0; i < seq.length - 2; i++) f.add(`t:${seq[i]} ${seq[i + 1]} ${seq[i + 2]}`);
  return f;
}

export function chargrams(w, prefix = 'c:') {
  const s = ` ${w} `; const out = new Set();
  for (const n of [3, 4, 5]) for (let i = 0; i + n <= s.length; i++) out.add(prefix + s.slice(i, i + n));
  return out;
}

export function tokFeats(v, i) {
  const w = v[i]; const p1 = i > 0 ? v[i - 1] : '^'; const p2 = i > 1 ? v[i - 2] : '^'; const n1 = i + 1 < v.length ? v[i + 1] : '$'; const n2 = i + 2 < v.length ? v[i + 2] : '$';
  const f = new Set([`w:${w}`, `p:${p1}`, `n:${n1}`, `p2:${p2}`, `n2:${n2}`, `pw:${p1} ${w}`, `wn:${w} ${n1}`, `pwn:${p1} ${w} ${n1}`]);
  for (const c of chargrams(w)) f.add(c);
  return f;
}

export function gateFeats(v, words) {
  const f = headFeats(v);
  const L = []; words.forEach((t, i) => { if (t.k === 'L') L.push(i); });
  f.add(`nL:${Math.min(L.length, 4)}`);
  for (const i of L) {
    const w = v[i]; const p1 = i > 0 ? v[i - 1] : '^'; const n1 = i + 1 < v.length ? v[i + 1] : '$';
    f.add(`L:${w}`); f.add(`Lp:${p1} ${w}`); f.add(`Ln:${w} ${n1}`);
    for (const c of chargrams(w, 'Lc:')) f.add(c);
  }
  return f;
}
