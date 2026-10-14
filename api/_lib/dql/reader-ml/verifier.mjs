// Donovan answer VERIFIER for the learned reader (dql/reader-ml). Pure functions, no dependencies, no I/O.
//
// The reader's model gives, per head, a probability for each class. This module judges the WHOLE answer: it tempers the per-head probabilities, searches the
// best joint combination of the nine heads (a width-30 beam, no head may be <OTHER>), turns the combination's confidence signals into features and lets a small
// gradient-boosted tree ensemble (data/verifier.json, 300 trees, fitted offline by scripts/learned-reader/fit_verifier.py) say how likely the combination
// is exactly right. The reader answers only when that score reaches the threshold; otherwise the question goes to the full assistant as before.
//
// Input per question: tk = nine {ix, pv, ent} (the five most probable class ids and their probabilities, and the entropy of the whole distribution), in HEADS order
// (model.js predictTop5 returns exactly this). Output: {answer, labels (a class id per head, the combination that was judged), score}.
export const HEADS = ['op', 'ent', 'dt', 'meas', 'time', 'grp', 'filt', 'args', 'rest'];
const OTHER = 0; // class id 0 of every head is <OTHER>, "the reader does not know"

function top5(p) { // the five largest entries of a probability vector, plus its entropy
  const ix = [-1, -1, -1, -1, -1], pv = [-1, -1, -1, -1, -1]; let ent = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i]; if (v > 1e-12) ent -= v * Math.log(v);
    if (v > pv[4]) { let k = 4; while (k > 0 && pv[k - 1] < v) { pv[k] = pv[k - 1]; ix[k] = ix[k - 1]; k--; } pv[k] = v; ix[k] = i; }
  }
  return { ix, pv, ent };
}
export function features(probs, cfg) { return featuresFromTop5(probs.map(top5), cfg); }
export function featuresFromTop5(tk, cfg) {
  const T = cfg.temperatures, H = 9, Q = [];
  for (let j = 0; j < H; j++) {
    const { pv } = tk[j]; const tail = Math.min(1, Math.max(1e-9, 1 - pv.reduce((a, b) => a + b, 0)));
    const x = [...pv, tail].map((v) => Math.pow(Math.max(v, 1e-12), 1 / T[HEADS[j]])); const s = x.reduce((a, b) => a + b, 0); Q.push(x.slice(0, 5).map((v) => v / s));
  }
  let beam = [{ s: 0, c: [] }]; // beam over the heads on tempered log-probabilities
  for (let j = 0; j < H; j++) {
    const nb = []; for (const b of beam) for (let k = 0; k < 5; k++) nb.push({ s: b.s + Math.log(Math.max(Q[j][k], 1e-12)), c: [...b.c, k] });
    nb.sort((a, b) => b.s - a.s); beam = nb.slice(0, cfg.beam_width);
  }
  const lab = beam.map((b) => b.c.map((k, j) => tk[j].ix[k])); const valid = lab.map((l) => l.every((v) => v !== OTHER));
  const sc = beam.map((b, i) => (valid[i] ? b.s : -1e9)); const mx = Math.max(...sc); const e = sc.map((s, i) => (valid[i] ? Math.exp(s - mx) : 0)); const z = e.reduce((a, b) => a + b, 0) + 1e-30;
  const top = sc.indexOf(mx), ok = valid.some(Boolean); const sorted = [...sc].sort((a, b) => b - a); const gap = sorted[1] > -1e8 ? sorted[0] - sorted[1] : 20;
  const raw = tk.map((t) => t.pv[0]), margin = tk.map((t) => t.pv[0] - t.pv[1]), ent = tk.map((t) => t.ent), q = Q.map((x) => x[0]);
  const logjoint = Math.log(Math.max(raw.reduce((a, b) => a * b, 1), 1e-12)), nOther = tk.filter((t) => t.ix[0] === OTHER).length;
  const f = [...raw, ...margin, ...ent, ...q, logjoint, nOther, Math.log(Math.max(ok ? e[top] / z : 0, 1e-12)), gap, valid.filter(Boolean).length];
  return { f, labels: ok ? lab[top] : null, ok };
}
function evalTree(node, f) {
  while (node.split_index !== undefined) { const v = f[node.split_feature]; const left = node.decision_type === '<=' ? v <= node.threshold : v == node.threshold; node = left ? node.left_child : node.right_child; }
  return node.leaf_value;
}
export function score(probs, cfg) { return scoreFromTop5(probs.map(top5), cfg); }
/** the verifier's verdict for one question; `threshold` overrides cfg.threshold */
export function scoreFromTop5(tk, cfg, threshold = cfg.threshold) {
  const { f, labels, ok } = featuresFromTop5(tk, cfg); if (!ok) return { answer: false, labels: null, score: 0 };
  let raw = 0; for (const t of cfg.tree_dump.tree_info) raw += evalTree(t.tree_structure, f);
  const s = 1 / (1 + Math.exp(-raw)); return { answer: s >= threshold, labels, score: s };
}
/** a threshold from a spec: a number in (0, 1] or one of the names in cfg.thresholds (cp995, cp99, emp995, emp99); anything else is the shipped cfg.threshold */
export function pickThreshold(cfg, spec) {
  const s = spec == null ? '' : String(spec).trim();
  if (s && cfg.thresholds && Number.isFinite(cfg.thresholds[s])) return cfg.thresholds[s];
  const x = Number(s); return s && Number.isFinite(x) && x > 0 && x <= 1 ? x : cfg.threshold;
}
