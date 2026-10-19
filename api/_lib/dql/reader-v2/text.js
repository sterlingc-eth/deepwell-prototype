/** text.js - word helpers shared by the Reader V2 modules (lib/reader.py basics). */
import { isAlnum, reEscape } from './pyc.js';
export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const STOP = new Set(("up out a an the of for on in at to is are was were be what whats what's which who whos who's how when where do does did we our us you your me my i it its this that these those and or by with from about please pls can could tell give need want show get see find any all every thanks asap quick question hey sorry bother file there have has had under into than then also just like").split(' '));
export const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) || [];
export function stem(w) {
  for (const [suf, rep] of [['ies', 'y'], ['sses', 'ss'], ['ses', 's'], ['s', '']]) if (w.endsWith(suf) && w.length > suf.length + 2) return w.slice(0, w.length - suf.length) + rep;
  return w;
}
export const hum = (s) => s.replace(/[_-]+/g, ' ');
export const DOCNO_SRC = '\\b[A-Za-z]{1,6}(?:-\\d{2,7})+\\b';
export const docnoAll = (s) => [...s.matchAll(new RegExp(DOCNO_SRC, 'g'))];
export const docnoFirst = (s) => new RegExp(DOCNO_SRC).exec(s);
/** reader.has: any whole-word match */
export const has = (ql, ...ws) => ws.some((w) => new RegExp('\\b' + w + '\\b').test(ql));
export function parseDates(q) {
  const out = [];
  for (const m of q.matchAll(/\b(\d{4})-(\d\d)-(\d\d)\b/g)) out.push([[m.index, m.index + m[0].length], `${m[1]}-${m[2]}-${m[3]}`]);
  for (const m of q.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.push([[m.index, m.index + m[0].length], `${String(+m[3]).padStart(4, '0')}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`]);
  for (const m of q.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/g)) {
    const lw = m[1].toLowerCase(); let mo = null;
    for (let i = 0; i < 12; i++) { const k = MONTHS[i]; if (k.startsWith(lw.slice(0, 3)) && k.startsWith(lw.slice(0, Math.max(3, m[1].length)).slice(0, m[1].length))) { mo = i + 1; break; } }
    if (mo) out.push([[m.index, m.index + m[0].length], `${String(+m[3]).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`]);
  }
  return out;
}
export const alnumAt = (s, i) => i >= 0 && i < s.length && isAlnum(s[i]);
export { reEscape };
