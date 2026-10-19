/** labelclause.js - port of lib/labelclause.py (label_clause_v1): append the document's label-word clause sentences to ix.lines once (lazy). */
import { words, stem } from './text.js';

let CFG = { on: false };
export const configure = (d) => { CFG = { on: false, ...(d || {}) }; };
export const enabled = () => !!CFG.on;
const LABEL = /^(client|customer|document no|date|total|signed|status|agent|tenant|invoice|bill to)\b/i;
export function isClauseSentence(ln, nwords) {
  if (!ln.endsWith('.') || nwords < 5) return false;
  if (ln.slice(0, 40).includes(':') || ln.includes('|') || ln.includes('\t') || /\S {3,}\S/.test(ln)) return false;
  if (/\$\s*\d/.test(ln) && /^(total|date|signed|status|invoice no|document no)\b/i.test(ln)) return false;
  return true;
}
export function ensure(ix, did) {
  if (!enabled()) return 0;
  if (!ix._lc_done) ix._lc_done = new Set();
  if (ix._lc_done.has(did)) return 0;
  ix._lc_done.add(did);
  if (!ix.xset) ix.xset = new Set();
  const c = ix.c; if (!c) return 0;
  const have = new Set((ix.lines.get(did) || []).map((z) => z[1])); let n = 0;
  const pages = c.pages.get(did); if (!pages) return 0;
  for (const p of pages) {
    for (let ln of p.text.split('\n')) {
      ln = ln.trim();
      if (ln.length > 22 && LABEL.test(ln) && !ln.includes(' - page ') && !have.has(ln) && isClauseSentence(ln, words(ln).length)) {
        if (!ix.lines.has(did)) ix.lines.set(did, []);
        ix.lines.get(did).push([p.page_no, ln, new Set(words(ln).map(stem))]); ix.xset.add(did + '\u0001' + ln); have.add(ln); n++;
      }
    }
  }
  return n;
}
