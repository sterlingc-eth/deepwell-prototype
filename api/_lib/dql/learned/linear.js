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
