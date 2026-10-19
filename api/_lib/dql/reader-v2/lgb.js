/** lgb.js - LightGBM prediction from the exported JSON trees (data/lgb_*.json). Same arithmetic as LightGBM's own predictor: doubles, tree order, sigmoid. */
const K_ZERO = 1e-35;
function predictTree(t, x) {
  if (t.nl <= 1) return t.lv[0];
  let node = 0;
  while (node >= 0) {
    const dt = t.dt[node]; let v = x[t.sf[node]];
    const missingType = (dt >> 2) & 3; const defaultLeft = (dt & 2) !== 0;
    if (Number.isNaN(v) && missingType !== 2) v = 0;
    let goLeft;
    if ((missingType === 1 && Math.abs(v) <= K_ZERO) || (missingType === 2 && Number.isNaN(v))) goLeft = defaultLeft;
    else goLeft = v <= t.th[node];
    node = goLeft ? t.lc[node] : t.rc[node];
  }
  return t.lv[~node];
}
export class Booster {
  constructor(j) { this.trees = j.trees; this.nf = j.nf; this.sigmoid = /sigmoid/.test(j.objective || ''); }
  /** x: array of numbers; shorter is padded with -1, longer is cut (models.Booster.predict) */
  score(x) {
    let v = x;
    if (v.length > this.nf) v = v.slice(0, this.nf);
    else if (v.length < this.nf) { v = v.slice(); while (v.length < this.nf) v.push(-1); }
    let s = 0; for (const t of this.trees) s += predictTree(t, v);
    return this.sigmoid ? 1 / (1 + Math.exp(-s)) : s;
  }
  predict(X) { return X.map((r) => this.score(r)); }
}
