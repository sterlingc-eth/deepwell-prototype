/** learned/linear.js - the pure-JS scorer for the exported linear heads (same arithmetic as the trainer's score_exported). No dependencies. */

export function prepare(head) {
  if (head._m) return head;
  head._m = new Map(Object.entries(head.feats));
  return head;
}

/** -> raw class scores (Float64Array) for a feature set. */
export function scores(head, featSet) {
  prepare(head);
  const K = head.classes.length;
  const sc = Float64Array.from(head.b);
  let n = 0;
  const hits = [];
  for (const f of featSet) { const e = head._m.get(f); if (e) { hits.push(e); n++; } }
  if (!n) return sc;
  const inv = 1 / Math.sqrt(n);
  for (const e of hits) for (let j = 0; j < e.length; j += 2) sc[e[j]] += e[j + 1] * inv;
  void K;
  return sc;
}

/** -> {k, label, prob, p[]} with the head's temperature applied. */
export function classify(head, featSet) {
  const sc = scores(head, featSet);
  const T = head.T ?? 1;
  let mx = -Infinity; for (const v of sc) if (v > mx) mx = v;
  const p = new Float64Array(sc.length); let z = 0;
  for (let i = 0; i < sc.length; i++) { p[i] = Math.exp((sc[i] - mx) / T); z += p[i]; }
  let k = 0;
  for (let i = 0; i < p.length; i++) { p[i] /= z; if (p[i] > p[k]) k = i; }
  return { k, label: head.classes[k], prob: p[k], p };
}

/** Binary gate: Platt-scaled probability of the second class. */
export function gateProb(head, featSet) {
  const sc = scores(head, featSet);
  const raw = sc[1] - sc[0];
  const [a, b] = head.platt ?? [1, 0];
  return 1 / (1 + Math.exp(-(a * raw + b)));
}

/* ---------------------------------------------------------------------------------------------- round 2: hashed heads (feats keyed by crc32 bucket id; score = bias + sum(w) / sqrt(number of ids generated)) */
export function prepare2(head) {
  if (head._m2) return head;
  head._m2 = new Map(); for (const [k, e] of Object.entries(head.feats)) head._m2.set(Number(k), e);
  return head;
}
export function scores2(head, ids) {
  prepare2(head);
  const sc = Float64Array.from(head.b);
  const inv = 1 / Math.sqrt(Math.max(ids.size, 1));
  for (const id of ids) { const e = head._m2.get(id); if (e) for (let j = 0; j < e.length; j += 2) sc[e[j]] += e[j + 1] * inv; }
  return sc;
}
export function classify2(head, ids) {
  const sc = scores2(head, ids);
  const T = head.T ?? 1;
  let mx = -Infinity; for (const v of sc) if (v > mx) mx = v;
  const p = new Float64Array(sc.length); let z = 0;
  for (let i = 0; i < sc.length; i++) { p[i] = Math.exp((sc[i] - mx) / T); z += p[i]; }
  let k = 0;
  for (let i = 0; i < p.length; i++) { p[i] /= z; if (p[i] > p[k]) k = i; }
  return { k, label: head.classes[k], prob: p[k], p };
}

/** the verify gate: bias + sum of the hashed weights / sqrt(number of features), Platt-scaled to a probability */
export function verifyProb(head, ids) {
  if (!head._m) head._m = new Map(Object.entries(head.feats).map(([k, w]) => [Number(k), w]));
  let z = head.b;
  const inv = 1 / Math.sqrt(Math.max(ids.size, 1));
  for (const id of ids) { const w = head._m.get(id); if (w !== undefined) z += w * inv; }
  const [a, b] = head.platt ?? [1, 0];
  return 1 / (1 + Math.exp(-(a * z + b)));
}
