// ingest1 / ingest_ocr.js - text stage of the ingest layer (pure JS, no deps): several OCR passes (word boxes) -> one reader-ready page text.
// 1) score passes by dictionary / number-format confidence, pick the best, add confident non-overlapping words from the others, vote on overlapping typed tokens
// 2) rebuild lines + a character grid (layout preserved so captions sit above their values and table columns line up)
// 3) type-checked character-confusion repair (amounts, dates, ids, phones) and arithmetic reconcile of single-digit misreads
// 4) optional table-block detection (header + aligned numeric columns) -> keyed rows
// Input pass: { psm, scale, words: [{ l, t, w, h, c, s }] } (pixel boxes, conf 0-100).  Generic: no industry or vendor vocabulary beyond common form words.
const VOCAB = new Set(("account statement invoice bill total amount due date number no phone tel fax email address city state zip customer client vendor supplier ship shipping order purchase quantity qty unit price rate description item items subtotal tax sales balance previous payment payments received credit credits charges new current period service services terms net days permit license issued expires expiration fee paid receipt inspector inspection status approved pending conditions signature authorized holder site ticket delivery delivered driver received print signature name street page copy original paid check cash card visa total thank you for your business bank deposit deposits withdrawals withdrawal opening closing summary reference week ending employee hours hour pay gross approved by notes break time job day mon tue wed thu fri sat sun monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec work technician parts labor install repair cleaning treatment inspection report prepared contact approver requested via vendor ship bill sold please remit enclosed detach return portion statement agreement term month months monthly deposit late notice termination governing law provider signed form priority routine urgent opened completed hours site address id cust customer salesperson freight due upon receipt memo letter regards sincerely dear hello hi thanks note regarding following confirm confirmed scheduled appointment estimate quote valid until correction replaces earlier").split(/\s+/));
const CONF = { 0: "O", O: "0", o: "0", l: "1", I: "1", i: "1", "|": "1", S: "5", B: "8", Z: "2", G: "6", s: "5", z: "2", b: "6" };
const D2L = { "0": "O", "1": "l", "5": "S", "8": "B", "2": "Z", "6": "G" };
const DIGIT_CONF = { 0: [8, 6, 9], 1: [7], 2: [7], 3: [8, 5], 5: [6, 3], 6: [5, 8, 0], 7: [1, 2], 8: [0, 3, 6, 9], 9: [0, 8, 4, 7], 4: [9] };
export const MONEY_STRICT = /^-?[$€£]?\d{1,3}(?:,\d{3})*\.\d{2}$|^-?[$€£]?\d+\.\d{2}$|^-?\d{1,3}(?:\.\d{3})*,\d{2}\s?€?$/;
const isDigit = (c) => c >= "0" && c <= "9";
const nDigits = (s) => { let n = 0; for (const c of s) if (isDigit(c)) n++; return n; };
const alphaOnly = (s) => s.replace(/[^A-Za-z]/g, "");
// ---------------------------------------------------------------- typed validators
export function validDate(s) {
  let m, y, mo, d;
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))) { const a = +m[1], b = +m[2]; y = +m[3]; return (a >= 1 && a <= 12 && b >= 1 && b <= 31) || (b >= 1 && b <= 12 && a >= 1 && a <= 31); }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { mo = +m[2]; d = +m[3]; return mo >= 1 && mo <= 12 && d >= 1 && d <= 31; }
  return false;
}
// map confusable letters to digits inside a token that is meant to be numeric; returns null when the result is not a valid typed value
export function repairToken(tok) {
  if (!/\d/.test(tok) && !/^[$€£]?[OolIiS|BZG]{1,3}[.,][OolIiS|BZG0-9]{2}$/.test(tok)) return null;
  const lead = (tok.match(/^[(\[]+/) || [""])[0], trail = (tok.match(/[)\],;:]+$/) || [""])[0]; let core = tok.slice(lead.length, tok.length - trail.length);
  const cur = (core.match(/^[$€£]/) || [""])[0]; if (cur) core = core.slice(1);
  // plain numeric-ish charset only
  if (!/^[\dOolIiS|BZGsz.,\-\/ ]+$/.test(core)) return null;
  const map = (c) => (isDigit(c) || /[.,\-\/ ]/.test(c) ? c : CONF[c] ?? c);
  const mapped = [...core].map(map).join("");
  const full = cur + mapped;
  // money, with stray separators fixed ("2.520.00" -> "2,520.00", "1.800 00" -> "1,800.00")
  let t = full.replace(/\s+(?=\d{2}$)/, ".");
  t = t.replace(/^([$€£]?-?\d{1,3})\.(\d{3})\.(\d{2})$/, "$1,$2.$3");
  if (MONEY_STRICT.test(t) && (cur || /\./.test(t))) return lead + t + trail;
  // date
  if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$|^\d{4}-\d{2}-\d{2}$/.test(mapped) && validDate(mapped)) return lead + mapped + trail;
  // phone-like 555-0143 / (602) handled at line level
  if (/^\d{3}-\d{4}$/.test(mapped)) return lead + mapped + trail;
  if (/^\d+$/.test(mapped) && nDigits(core) >= Math.ceil(core.length / 2) && mapped.length >= 3) return lead + mapped + trail;   // mostly-digit integer
  return null;
}
// ids: PREFIX-digits where the digits were read as letters
export function repairId(tok) {
  const m = tok.match(/^([A-Z]{1,5})([-–_#]?)([\dOolIiS|BZG]{3,9})([.,;:]?)$/); if (!m) return null;
  const digs = [...m[3]].filter(isDigit).length; if (digs < 2 || digs < m[3].length - 3) return null;
  const mapped = [...m[3]].map((c) => (isDigit(c) ? c : CONF[c] ?? c)).join(""); if (!/^\d+$/.test(mapped)) return null;
  return m[1] + m[2] + mapped + m[4];
}
export function repairLine(line) {
  return line.replace(/\S+/g, (tok) => {
    if (/^[A-Za-z]{4,}$/.test(tok)) return tok;
    const r = repairToken(tok); if (r) return r;
    const i = repairId(tok); return i ?? tok;
  });
}
// ---------------------------------------------------------------- scoring
export function wordScore(w) {
  const t = w.s.replace(/^[^\w$]+|[^\w%]+$/g, ""); if (!t) return 0; const c = w.c / 100;
  if (MONEY_STRICT.test(t) || validDate(t) || /^[A-Z]{1,5}-\d{3,8}$/.test(t) || /^\(?\d{3}\)?[-. ]?\d{3}-?\d{4}$/.test(t)) return 3 * c * c;
  const a = alphaOnly(t).toLowerCase();
  if (a.length >= 3 && a.length === t.length && VOCAB.has(a)) return 2.2 * c;
  if (a.length >= 4 && a.length === t.length) { const v = (a.match(/[aeiouy]/g) || []).length / a.length; return v > 0.2 && v < 0.65 ? 0.9 * c : 0.1 * c; }
  if (/^\d+$/.test(t) && t.length <= 8) return 0.8 * c;
  return 0.15 * c;
}
export const passScore = (p) => p.words.reduce((s, w) => s + wordScore(w), 0);
// ---------------------------------------------------------------- merge passes
const iou = (a, b) => { const x1 = Math.max(a.l, b.l), y1 = Math.max(a.t, b.t), x2 = Math.min(a.l + a.w, b.l + b.w), y2 = Math.min(a.t + a.h, b.t + b.h); const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return i / (a.w * a.h + b.w * b.h - i || 1); };
const typed = (s) => MONEY_STRICT.test(s) || validDate(s) || /^[A-Z]{1,5}-\d{3,8}$/.test(s) || /\d{3,}/.test(s);
export function mergePasses(passes, opt = {}) {
  const P = passes.map((p) => ({ ...p, words: p.words.map((w) => { const k = 1 / (p.scale || 1); return { ...w, l: w.l * k, t: w.t * k, w: w.w * k, h: w.h * k, s: w.s.trim() }; }).filter((w) => w.s) }));
  P.forEach((p) => { p.score = passScore(p); }); P.sort((a, b) => b.score - a.score); const best = P[0]; if (!best) return { words: [], best: null, scores: [] };
  const out = best.words.map((w) => ({ ...w, votes: [{ s: w.s, c: w.c }] }));
  for (const p of P.slice(1)) for (const w of p.words) {
    let hit = null, bi = 0.3; for (const o of out) { const v = iou(o, w); if (v > bi) { bi = v; hit = o; } }
    if (hit) { hit.votes.push({ s: w.s, c: w.c }); continue; }
    if (w.c >= (opt.addConf ?? 60) && wordScore(w) >= 0.8) out.push({ ...w, votes: [{ s: w.s, c: w.c }], added: true });
  }
  // vote typed tokens: repaired strings, weighted by conf; the winner's own reading keeps a tie
  for (const o of out) {
    if (o.votes.length < 2 || !/\d/.test(o.s)) continue; const tally = new Map();
    o.votes.forEach((v, i) => { const r = repairToken(v.s) ?? repairId(v.s) ?? v.s; tally.set(r, (tally.get(r) || 0) + v.c / 100 + (i === 0 ? 0.05 : 0)); });
    let top = null, tv = -1; for (const [k, v] of tally) if (v > tv) { tv = v; top = k; } if (top) o.s = top;
  }
  return { words: out, best, scores: P.map((p) => ({ psm: p.psm, variant: p.variant, score: +p.score.toFixed(1) })) };
}
// ---------------------------------------------------------------- lines + character grid
export function toLines(words) {
  if (!words.length) return [];
  const hs = words.map((w) => w.h).sort((a, b) => a - b), mh = hs[hs.length >> 1] || 10; const ws = [...words].sort((a, b) => a.t + a.h / 2 - (b.t + b.h / 2));
  const lines = []; for (const w of ws) { const cy = w.t + w.h / 2; const L = lines.find((l) => Math.abs(l.cy - cy) < Math.max(mh * 0.55, 4)); if (L) { L.w.push(w); L.cy = (L.cy * (L.w.length - 1) + cy) / L.w.length; } else lines.push({ cy, w: [w] }); }
  lines.sort((a, b) => a.cy - b.cy); lines.forEach((l) => l.w.sort((a, b) => a.l - b.l)); return lines;
}
export function gridText(words, opt = {}) {
  const lines = toLines(words); if (!lines.length) return "";
  const cw = words.map((w) => w.w / Math.max(w.s.length, 1)).filter((x) => x > 0).sort((a, b) => a - b); const charW = cw[cw.length >> 1] || 8; const x0 = Math.min(...words.map((w) => w.l));
  return lines.map((L) => { let s = ""; for (const w of L.w) { const col = Math.round((w.l - x0) / charW); if (s.length >= col) s += s && !s.endsWith(" ") ? " " : ""; else s += " ".repeat(col - s.length); s += w.s; } return s.replace(/\s+$/, ""); }).join("\n");
}
// ---------------------------------------------------------------- arithmetic reconcile
const cents = (t) => { const s = t.replace(/[$€£\s]/g, ""); if (!MONEY_STRICT.test(t.trim()) && !/^-?\d[\d,]*\.\d{2}$/.test(s)) return null; const n = Math.round(parseFloat(s.replace(/,/g, "")) * 100); return Number.isFinite(n) ? n : null; };
function related(v, others, i) {   // v equals another token, a sum of 2..5 others, or is a term of a sum equal to another token
  const vals = others.filter((_, j) => j !== i).map((x) => x.v);
  if (vals.includes(v)) return true; const n = Math.min(vals.length, 22); const a = vals.slice(0, n);
  const sums = new Map(); sums.set(0, 1);   // subset sums up to size 5 via bounded enumeration
  const hit = (target, k, start, cur) => { if (k === 0) return cur === target; for (let j = start; j < a.length; j++) { if (cur + a[j] > target) continue; if (hit(target, k - 1, j + 1, cur + a[j])) return true; } return false; };
  for (let k = 2; k <= 5; k++) if (hit(v, k, 0, 0)) return true;
  for (const w of a) { const rest = w - v; if (rest > 0) for (let k = 1; k <= 4; k++) if (hit(rest, k, 0, 0)) return true; }
  return false;
}
export function reconcile(text) {
  const toks = []; const lines = text.split("\n");
  lines.forEach((ln, li) => { const re = /\S+/g; let m; while ((m = re.exec(ln))) { const v = cents(m[0].replace(/^[(\[]|[)\],;:]$/g, "")); if (v != null && v >= 0 && /\./.test(m[0])) toks.push({ li, idx: m.index, len: m[0].length, raw: m[0], v }); } });
  if (toks.length < 4 || toks.length > 40) return { text, fixes: [] };
  const fixes = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; if (related(t.v, toks, i)) continue;
    const digs = [...t.raw].map((c, p) => [c, p]).filter(([c]) => isDigit(c)); const cand = [];
    for (const [c, p] of digs) for (const r of DIGIT_CONF[+c] || []) { const raw2 = t.raw.slice(0, p) + r + t.raw.slice(p + 1); const v2 = cents(raw2.replace(/^[(\[]|[)\],;:]$/g, "")); if (v2 != null && related(v2, toks, i)) cand.push([raw2, v2]); }
    const uniq = [...new Map(cand.map((c) => [c[1], c])).values()];
    if (uniq.length === 1) { fixes.push({ li: t.li, idx: t.idx, from: t.raw, to: uniq[0][0] }); t.v = uniq[0][1]; t.raw = uniq[0][0]; }
  }
  const L = [...lines]; for (const f of fixes.sort((a, b) => b.idx - a.idx)) L[f.li] = L[f.li].slice(0, f.idx) + f.to + L[f.li].slice(f.idx + f.from.length);
  return { text: L.join("\n"), fixes };
}
// ---------------------------------------------------------------- stamps / handwriting flags (word level)
export function dropNoise(words) {
  const hs = words.map((w) => w.h).sort((a, b) => a - b), mh = hs[hs.length >> 1] || 10;
  return words.filter((w) => !(w.c < 25 && w.s.length <= 2) && !(w.h > mh * 3.2) && !(/^[^A-Za-z0-9$]+$/.test(w.s) && w.c < 60));
}
// ---------------------------------------------------------------- table blocks
export function tableRows(text) {
  const L = text.split("\n"), out = []; let i = 0;
  const cells = (s) => s.trim().split(/ {2,}/);
  while (i < L.length) {
    const c = cells(L[i]); const alpha = c.length >= 3 && c.every((x) => /[A-Za-z]/.test(x) && !/^\$?[\d,.]+$/.test(x));
    if (alpha) { let j = i + 1; const body = []; while (j < L.length) { const b = cells(L[j]); if (b.length >= 3 && b.slice(1).some((x) => /^\$?-?[\d,.]+%?$/.test(x))) { body.push(b); j++; } else break; }
      if (body.length >= 2) { for (const b of body) out.push(`Table row | ${c[0]}: ${b[0]} | ` + c.slice(1).map((h, k) => `${h}: ${b[k + 1] ?? ""}`).join(" | ")); i = j; continue; } }
    i++;
  }
  return out;
}
// ---------------------------------------------------------------- entry
export function passesToPage(passes, opt = {}) {
  const m = mergePasses(passes, opt); const words = dropNoise(m.words); let text = gridText(words); text = text.split("\n").map(repairLine).join("\n");
  const rc = opt.reconcile === false ? { text, fixes: [] } : reconcile(text);
  // typed tokens that at least 3 independent OCR passes read identically (and none read with low confidence): the page's own cross-check for values with no arithmetic to test
  const ver = []; for (const w of words) { if (!w.votes || w.votes.length < 3 || !/\d/.test(w.s)) continue; const rs = w.votes.map((v) => repairToken(v.s) ?? repairId(v.s) ?? v.s); if (rs.every((r) => r === rs[0]) && w.votes.every((v) => v.c >= 60) && rc.text.includes(w.s)) ver.push(w.s); }
  return { ver, text: rc.text, fixes: rc.fixes, scores: m.scores, nWords: words.length, tableRows: opt.tables ? tableRows(rc.text) : [] };
}
// text-layer repair (native PDF / docx / txt whose characters were corrupted upstream): same type-checked repair + reconcile, no boxes
export function repairText(text, opt = {}) {
  const t = text.split("\n").map(repairLine).join("\n"); return opt.reconcile === false ? t : reconcile(t).text;
}
