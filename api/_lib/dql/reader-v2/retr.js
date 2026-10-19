/** retr.js - port of lib/retr_v2.py (retrieval v2: layout-aware lines, OCR-noise repair, contextual headers). Index-side and query-side parts only. */
import { reEscape } from './pyc.js';
const DEF = { on: false, hdr: true, layout: true, ocr: true, train_noise: 0.3, rich_lines: 14 };
let CFG = { ...DEF };
export const configure = (d) => { CFG = { ...DEF, ...(d || {}) }; };
export const cfg = () => CFG;
export const enabled = () => !!CFG.on;
const MAP = { '\ufb01': 'fi', '\ufb02': 'fl', '\ufb00': 'ff', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st', '\u017f': 's', '\u2019': "'", '\u2018': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u00ad': '', '\u200b': '', '\u200c': '', '\ufeff': '', '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ' };
const MRE = new RegExp(Object.keys(MAP).map(reEscape).join('|'), 'g');
export const lig = (x) => x.replace(MRE, (m) => MAP[m]);
const SUBS = [['0', 'o'], ['1', 'l'], ['1', 'i'], ['5', 's'], ['8', 'b'], ['rn', 'm'], ['m', 'rn'], ['cl', 'd'], ['d', 'cl'], ['vv', 'w'], ['c', 'e'], ['l', 'i'], ['i', 'l']];
/** the variants of a word in a fixed (sorted) order: the Python reference iterates a hash set, so ties are broken by sorted order in both implementations (see the report) */
export function variants(w) {
  const out = new Set();
  for (const [a, b] of SUBS) { let i = w.indexOf(a); while (i >= 0) { out.add(w.slice(0, i) + b + w.slice(i + a.length)); i = w.indexOf(a, i + 1); } }
  out.delete(w); return [...out].sort();
}
export function buildFix(df) {
  const fix = new Map();
  for (const [w, n] of df) {
    if (n > 2 || w.length < 4 || /^\d+$/.test(w) || !/[a-z]/.test(w)) continue;
    let best = null; let bn = Math.max(3, 3 * n);
    for (const v of variants(w)) { const k = df.get(v) || 0; if (k >= bn && (best === null || k > bn)) { best = v; bn = k; } }
    if (best) fix.set(w, best);
  }
  return fix;
}
export function qfix(ix, ws) {
  const fx = ix.rv2_df; if (!fx || fx.size === 0) return ws;
  const out = [];
  for (const w of ws) {
    if ((fx.get(w) || 0) || w.length < 4 || /^\d+$/.test(w)) { out.push(w); continue; }
    let best = null; let bn = 2;
    for (const v of variants(w)) { const k = fx.get(v) || 0; if (k > bn) { best = v; bn = k; } }
    out.push(best || w);
  }
  return out;
}
const LABEL = /^(client|customer|document no|date|total|signed|status|agent|tenant|invoice|bill to)\b/i;
const KV = /^[A-Za-z][A-Za-z #./]{1,30}:\s/;
const NUMH = /^(?:section|article|schedule|exhibit|part)\s+[\dIVXA-Z]+\b|^\d+(?:\.\d+)*[.)]\s+\S/i;
export const isTableRow = (s) => (s.split('|').length - 1) >= 2 || s.includes('\t') || /\S {3,}\S/.test(s);
const pyIsUpper = (s) => /\p{Lu}/u.test(s) && s === s.toUpperCase() && !/\p{Ll}/u.test(s) && s.toLowerCase() !== s; // str.isupper(): cased chars all upper, at least one cased
const pyIsAlpha = (c) => /^\p{L}$/u.test(c);
function isHeading(s) {
  if (!s || s.length > 70 || /[.?!,;]$/.test(s) || s.includes('$') || s.includes(' - page ') || LABEL.test(s) || isTableRow(s)) return false;
  const w = s.split(/\s+/).filter((x) => x !== '');
  if (w.length > 9) return false;
  if (NUMH.test(s)) return true;
  if (s.endsWith(':') && w.length <= 6) return true;
  let letters = 0; for (const ch of s) if (pyIsAlpha(ch)) letters++;
  return letters >= 4 && pyIsUpper(s) && !/\d{3,}/.test(s);
}
function cells(s) {
  const parts = s.includes('|') ? s.split('|') : (s.includes('\t') ? s.split('\t') : s.split(/ {3,}/));
  return parts.map((x) => x.trim()).filter((x) => x);
}
const pyRStrip = (s) => s.replace(/\s+$/, '');
export function logicalLines(text) {
  text = text.replace(/([A-Za-z]{2,})[-\u00ad]\n[ \t]*([a-z]{2,})/g, '$1$2');
  const rl = text.split('\n'); const rawl = rl.map((x) => pyRStrip(lig(x))); const raw = rawl.map((x) => x.trim()); const chg = rl.map((a) => lig(a) !== a);
  const out = []; let stack = []; let tbl = null; let buf = null; let bch = false;
  const sec = () => stack.slice(-2).join(' > ');
  const flush = () => { if (buf !== null) out.push({ txt: buf, sec: sec(), tbl: '', changed: bch }); buf = null; bch = false; };
  for (let i = 0; i < raw.length; i++) {
    const ln = raw[i];
    if (!ln || ln.includes(' - page ')) { flush(); tbl = null; continue; }
    if (isTableRow(rawl[i].trim())) {
      flush(); const cl = cells((ln.includes('|') || ln.includes('\t')) ? ln : ln.replace(/ {3,}/g, ' | '));
      if (tbl === null) { tbl = cl; out.push({ txt: ln, sec: sec(), tbl: '', changed: chg[i], hdr: true }); }
      else out.push({ txt: ln, sec: sec(), tbl: tbl.join(' '), changed: chg[i] });
      continue;
    }
    tbl = null;
    if (isHeading(ln)) {
      flush(); const h = ln.replace(/:+$/, '').trim(); const subh = /^\d+\.\d/.test(h);
      const top = pyIsUpper(h) || /^(?:section|article|schedule|exhibit|part)\b/i.test(h) || /^\d+[.)]\s/.test(h);
      stack = (stack.length === 0 || (top && !subh)) ? [h] : [...stack.slice(0, 1), h];
      out.push({ txt: ln, sec: sec(), tbl: '', changed: chg[i], head: true }); continue;
    }
    if (buf !== null && !'.!?:;'.includes(buf[buf.length - 1]) && buf.length >= 35 && /^\p{Ll}/u.test(ln[0] || '') && !LABEL.test(ln) && !KV.test(ln)) { buf = buf + ' ' + ln; bch = true; continue; }
    flush(); buf = ln; bch = chg[i];
  }
  flush(); return out;
}
/** build: lines {did: [[page, text, Set(words)]]}, ctx Map("did|page|text" -> header), N, rawdf Map; df_out (Map) is updated with the final word-set df */
export function build(c, dids, words, stem, docTypes, dfOut) {
  const layout = CFG.layout !== false, hdr = CFG.hdr !== false, ocr = CFG.ocr !== false, richN = parseInt(CFG.rich_lines ?? 14, 10);
  const pre = new Map(); const rawdf = new Map();
  for (const did of dids) {
    const L = [];
    for (const p of c.pages.get(did) || []) {
      const ll = layout ? logicalLines(p.text) : p.text.split('\n').map((x) => ({ txt: x.trim(), sec: '', tbl: '', changed: false }));
      for (const e of ll) {
        const ln = e.txt.trim();
        if (ln.length > 22 && words(ln).length >= 4 && !LABEL.test(ln) && !ln.includes(' - page ') && !e.head) { L.push([p.page_no, ln, e]); for (const w of new Set(words(ln))) rawdf.set(w, (rawdf.get(w) || 0) + 1); }
      }
    }
    pre.set(did, L);
  }
  const fix = ocr ? buildFix(rawdf) : new Map();
  const lines = new Map(); const ctx = new Map(); let N = 0;
  for (const did of dids) {
    const d = c.docs.get(did); const dt = docTypes[did] || d.document_type || ''; const title = String(d.title || d.name || '').trim();
    const L = pre.get(did);
    const secs = new Set(L.filter(([, , e]) => e.sec).map(([, , e]) => e.sec));
    const rich = L.some(([, , e]) => e.changed || e.tbl) || secs.size >= 3 || L.length >= richN;
    const out = [];
    for (const [pg, ln, e] of L) {
      const toks = words(ln); const w = new Set(toks.map(stem));
      for (const t of toks) if (fix.has(t)) w.add(stem(fix.get(t)));
      if (rich) {
        const extra = e.sec + ' ' + e.tbl + (hdr ? ' ' + dt.replace(/[_-]+/g, ' ') + ' ' + title : '');
        for (const x of words(extra)) w.add(stem(x));
        ctx.set(`${did}\u0001${pg}\u0001${ln}`, [dt.replace(/[_-]+/g, ' '), title, e.sec, e.tbl].filter((x) => x).join(' | '));
      }
      out.push([pg, ln, w]); for (const x of w) dfOut.set(x, (dfOut.get(x) || 0) + 1); N += 1;
    }
    lines.set(did, out);
  }
  return { lines, ctx, N, rawdf };
}
