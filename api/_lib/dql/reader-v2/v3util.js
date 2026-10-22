/** v3util.js - small helpers shared by the v003 release rules (ports of the identical private helpers repeated in the lib/*.py modules). */
/** optimal-string-alignment (Damerau) distance, the `_dl(a, b)` of fieldrole1.py / fieldtypo1.py / fieldpara1.py / entstrict1.py */
export function osaFull(a, b) {
  const la = a.length, lb = b.length; const d = [];
  for (let i = 0; i <= la; i++) { d.push(new Array(lb + 1).fill(0)); d[i][0] = i; }
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[la][lb];
}
/** `_dl(a, b, k)` of litconsume1 / aggsem1 / aggfilter3 / aggverify1 / doctypealias1: k+1 when larger than k */
export function osaK(a, b, k) {
  if (Math.abs(a.length - b.length) > k) return k + 1;
  return Math.min(osaFull(a, b), k + 1);
}
/** plain Levenshtein (no transposition) */
export function levFull(a, b) {
  const lb = b.length; let p = []; for (let j = 0; j <= lb; j++) p.push(j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= lb; j++) c.push(Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    p = c;
  }
  return p[lb];
}
/** first balanced parenthesis group of an answer, lower-cased ('' when none) - the `note(t)` of the aggregate rules */
export function note(t) {
  const i = t.indexOf('(');
  if (i < 0) return '';
  let d = 0;
  for (let j = i; j < t.length; j++) {
    if (t[j] === '(') d++;
    else if (t[j] === ')') { d--; if (d === 0) return t.slice(i + 1, j).toLowerCase(); }
  }
  return t.slice(i + 1).toLowerCase();
}
export const toks = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
/** ' '.join(s.lower().split()) */
export const wsNorm = (s) => (s || '').toLowerCase().split(/\s+/).filter((x) => x).join(' ');
export const isDigitStr = (s) => /^[0-9]+$/.test(s);
export const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
/** standard on/off switch holder: configure(d) from the bundle's switches */
export function sw(def) {
  let C = { ...def };
  return { configure: (d) => { C = { ...def, ...(d && typeof d === 'object' ? d : {}) }; }, cfg: () => C, enabled: () => !!C.on };
}
