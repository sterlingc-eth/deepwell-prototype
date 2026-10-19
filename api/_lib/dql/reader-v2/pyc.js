/**
 * pyc.js - small Python-compatibility helpers for the Reader V2 port (dates, number formatting, string predicates).
 * The Python pipeline is the reference; these keep the JS port's behaviour identical on the points where the two languages differ.
 */
// ---- dates (UTC midnight JS Dates; Python datetime.date semantics) ----
export class PyValueError extends Error {}
export const isDate = (x) => x instanceof Date;
export function D(y, m, d) {
  const dt = new Date(0); dt.setUTCFullYear(y, m - 1, d); dt.setUTCHours(0, 0, 0, 0);
  if (y < 1 || y > 9999 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new PyValueError('day is out of range for month');
  return dt;
}
export const dY = (d) => d.getUTCFullYear();
export const dM = (d) => d.getUTCMonth() + 1;
export const dD = (d) => d.getUTCDate();
export const weekday = (d) => (d.getUTCDay() + 6) % 7;
export const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
export const dcmp = (a, b) => a.getTime() - b.getTime();
export const p2 = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${String(dY(d)).padStart(4, '0')}-${p2(dM(d))}-${p2(dD(d))}`;
export function fromIso(s) { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s); if (!m) throw new PyValueError('Invalid isoformat string'); return D(+m[1], +m[2], +m[3]); }
export function replace(d, o) { return D(o.year ?? dY(d), o.month ?? dM(d), o.day ?? dD(d)); }
export const eom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const fdiv = (a, b) => Math.floor(a / b);
export const pmod = (a, b) => ((a % b) + b) % b;
// ---- formatting ----
export function commas(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
/** f'{x:,.Nf}' */
export function fmtNum(x, nd = 2) {
  const s = Math.abs(x).toFixed(nd); const [i, f] = s.split('.');
  return (x < 0 || Object.is(x, -0) ? '-' : '') + commas(i) + (f ? '.' + f : '');
}
export const fmtMoney = (x) => '$' + fmtNum(x, 2);
// ---- strings ----
export const isAlnum = (c) => /^[\p{L}\p{N}]$/u.test(c);
export const isAlpha = (c) => /^\p{L}$/u.test(c);
export const isDigits = (s) => /^\p{Nd}+$/u.test(s);
export const isSpace = (c) => /^\s$/.test(c);
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s); // str.capitalize()
export const strip = (s, chars) => { if (chars == null) return s.replace(/^\s+|\s+$/g, ''); let a = 0, b = s.length; while (a < b && chars.includes(s[a])) a++; while (b > a && chars.includes(s[b - 1])) b--; return s.slice(a, b); };
export const rstrip = (s, chars) => { let b = s.length; while (b > 0 && chars.includes(s[b - 1])) b--; return s.slice(0, b); };
export function mergeSpans(taken, a, b) { return taken.some(([x, y]) => !(b <= x || a >= y)); }
/** re.escape for the characters that matter in a JS RegExp */
export const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
// ---- numbers ----
/** Python round() (half to even) for floats */
export function pyRound(x, nd = 0) {
  const f = 10 ** nd; const y = x * f; const r = Math.round(y);
  if (Math.abs(y % 1) === 0.5) return (2 * Math.round(y / 2)) / f;
  return r / f;
}
/** stable sort by key(s) ascending (Python sorted(key=...)) - Array.prototype.sort is stable in Node >= 12 */
export const sortedBy = (arr, keyf, reverse = false) => {
  const a = arr.map((v, i) => [v, i]);
  const cmp = (x, y) => { const kx = keyf(x[0]), ky = keyf(y[0]); return pyCmp(kx, ky); };
  a.sort((x, y) => (reverse ? -cmp(x, y) || x[1] - y[1] : cmp(x, y) || x[1] - y[1]));
  return a.map((z) => z[0]);
};
/** Python ordering of numbers, strings, booleans and (nested) arrays of those */
export function pyCmp(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { const c = pyCmp(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0; // JS compares UTF-16 units; ASCII data is identical
  const x = typeof a === 'boolean' ? +a : a; const y = typeof b === 'boolean' ? +b : b;
  return x < y ? -1 : x > y ? 1 : 0;
}
