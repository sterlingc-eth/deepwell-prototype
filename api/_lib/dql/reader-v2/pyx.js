/** pyx.js - small Python-semantics helpers for the Reader V2 post-processing modules (dict.get default, str.replace-all, set algebra, crc32). */
export const pget = (o, k, d) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);
export const repAll = (s, a, b) => s.split(a).join(b);
export const isSubset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
export const intersects = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };
export const union = (...ss) => { const o = new Set(); for (const s of ss) for (const x of s) o.add(x); return o; };
export const setOf = (str) => new Set(str.split(/\s+/).filter((x) => x));
/** Damerau/OSA distance with early exit, k+1 when larger than k (lib/aggv2.py _dist) */
export function osaDist(a, b, k) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > k) return k + 1;
  const d = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) for (let j = 1; j <= lb; j++) {
    let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
    d[i][j] = v;
  }
  return Math.min(d[la][lb], k + 1);
}
/** plain Levenshtein capped like the modules' lev(a, b, mx): mx+1 when the lengths differ by more than mx, otherwise the exact distance */
export function lev(a, b, mx = 2) {
  if (Math.abs(a.length - b.length) > mx) return mx + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return prev[prev.length - 1];
}
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
/** zlib.crc32 of the UTF-8 bytes, unsigned */
export function crc32(str) {
  const b = Buffer.from(str, 'utf8'); let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
