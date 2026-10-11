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

/** cluster id of a view token in the coarse table (round 2); the table is absent in a round-1 model, then no cluster feature is produced */
const kcw = (cl, t) => (t === '^' || t === '$' || t === PLACE.slot || t === PLACE.num ? t : cl.has(t) ? `a${cl.get(t)}` : '?');
export function tokFeats(v, i, cl) {
  const w = v[i]; const p1 = i > 0 ? v[i - 1] : '^'; const p2 = i > 1 ? v[i - 2] : '^'; const n1 = i + 1 < v.length ? v[i + 1] : '$'; const n2 = i + 2 < v.length ? v[i + 2] : '$';
  const f = new Set([`w:${w}`, `p:${p1}`, `n:${n1}`, `p2:${p2}`, `n2:${n2}`, `pw:${p1} ${w}`, `wn:${w} ${n1}`, `pwn:${p1} ${w} ${n1}`]);
  for (const c of chargrams(w)) f.add(c);
  if (cl) { f.add(`kw:${kcw(cl, w)}`); f.add(`kp:${kcw(cl, p1)} ${kcw(cl, w)}`); f.add(`kn:${kcw(cl, w)} ${kcw(cl, n1)}`); }
  return f;
}

export function gateFeats(v, words, cl) {
  const f = headFeats(v);
  const L = []; words.forEach((t, i) => { if (t.k === 'L') L.push(i); });
  f.add(`nL:${Math.min(L.length, 4)}`);
  for (const i of L) {
    const w = v[i]; const p1 = i > 0 ? v[i - 1] : '^'; const n1 = i + 1 < v.length ? v[i + 1] : '$';
    f.add(`L:${w}`); f.add(`Lp:${p1} ${w}`); f.add(`Ln:${w} ${n1}`);
    if (cl) { f.add(`Lk:${kcw(cl, w)}`); f.add(`Lkp:${kcw(cl, p1)} ${kcw(cl, w)}`); f.add(`Lkn:${kcw(cl, w)} ${kcw(cl, n1)}`); }
    for (const c of chargrams(w, 'Lc:')) f.add(c);
  }
  return f;
}

/* ---------------------------------------------------------------------------------------------- round 2: hashed head features (scripts/train-dql-planner-v2.py head_feats2)
 * Word 1-3-grams of the slot-masked view, slot-masked skip-grams, char 2-5-grams of each word, and 1-3-grams / skip-grams over WORD CLUSTERS (a small
 * word -> cluster table computed from the training corpus: PPMI + SVD word vectors, k-means). Each feature string is hashed with crc32 to a 22-bit bucket. */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const ENC = new TextEncoder();
export function crc32(s) {
  let c = -1; const b = ENC.encode(s);
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
export const HASH_MASK = (1 << 22) - 1;
const SPECIAL = new Set(['^', '$', PLACE.slot, PLACE.num]);

/** clusters = [Map word->id (coarse), Map word->id (fine)] */
export function headFeats2(v, clusters) {
  const seq = ['^', ...v, '$'];
  const f = new Set();
  for (const t of seq) f.add(`w:${t}`);
  for (let i = 0; i < seq.length - 1; i++) f.add(`b:${seq[i]} ${seq[i + 1]}`);
  for (let i = 0; i < seq.length - 2; i++) f.add(`t:${seq[i]} ${seq[i + 1]} ${seq[i + 2]}`);
  for (let i = 0; i < seq.length - 2; i++) f.add(`sk:${seq[i]}_${seq[i + 2]}`);
  for (let i = 0; i < seq.length - 3; i++) f.add(`sk3:${seq[i]}_${seq[i + 3]}`);
  for (const t of v) {
    if (t.length >= 3 && t[0] !== '<') {
      const s = ` ${t} `;
      for (let n = 2; n <= 5; n++) for (let i = 0; i + n <= s.length; i++) f.add(`hc:${s.slice(i, i + n)}`);
    }
  }
  for (let lv = 0; lv < 2; lv++) {
    const tag = lv === 0 ? 'ka' : 'kb'; const map = clusters?.[lv];
    const c = seq.map((t) => { if (SPECIAL.has(t)) return t; const id = map?.get(t); return id !== undefined ? `${lv === 0 ? 'a' : 'b'}${id}` : '?'; });
    for (const t of c) f.add(`${tag}1:${t}`);
    for (let i = 0; i < c.length - 1; i++) f.add(`${tag}2:${c[i]} ${c[i + 1]}`);
    if (lv === 0) {
      for (let i = 0; i < c.length - 2; i++) f.add(`ka3:${c[i]} ${c[i + 1]} ${c[i + 2]}`);
      for (let i = 0; i < c.length - 2; i++) f.add(`kas:${c[i]}_${c[i + 2]}`);
    }
  }
  f.add(`len:${Math.min(v.length, 14)}`);
  return f;
}

/** the hashed bucket ids of a round-2 feature set (unique) */
export function hashIds(featSet) { const ids = new Set(); for (const s of featSet) ids.add(crc32(s) & HASH_MASK); return ids; }

/** the verify gate's features (scripts/train-dql-planner-v2.py verify_feats): the view, each unexplained word in context and by cluster, and the plan's own reading (dh = planmap.dqlHeads(plan)) */
export function verifyFeats(v, words, dh, cl) {
  const f = headFeats(v);
  const L = []; words.forEach((t, i) => { if (t.k === 'L') L.push(i); });
  f.add(`nL:${Math.min(L.length, 4)}`);
  for (const i of L) {
    const w = v[i]; const p1 = i > 0 ? v[i - 1] : '^'; const n1 = i + 1 < v.length ? v[i + 1] : '$';
    f.add(`L:${w}`); f.add(`Lp:${p1} ${w}`); f.add(`Ln:${w} ${n1}`);
    f.add(`Lk:${kcw(cl, w)}`); f.add(`Lkp:${kcw(cl, p1)} ${kcw(cl, w)}`); f.add(`Lkn:${kcw(cl, w)} ${kcw(cl, n1)}`);
    for (const c of chargrams(w, 'Lc:')) f.add(c);
    for (const h of ['op', 'entity', 'doc']) f.add(`PL:${h}:${dh[h]}:${kcw(cl, w)}`);
  }
  for (const h of ['op', 'measure', 'entity', 'doc', 'group']) f.add(`P:${h}:${dh[h]}`);
  f.add(`P:${dh.op}|${dh.entity}|${dh.doc}`);
  for (let i = 0; i < v.length - 1; i++) f.add(`PB:${dh.op}:${v[i]} ${v[i + 1]}`);
  return f;
}
