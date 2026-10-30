// valuereader3: line-item reader. A question about one item row of a table ("how much was charged for X on <ID>", "the rate of X on <ID>")
// is answered from that row only: the line total is the cell that equals the product of two other cells of the same row (row arithmetic);
// other columns are read by header/cell alignment. Anything that does not reconcile or align abstains. Generic: no industry vocabulary.
import { norm, words, stem, STOP, moneyNum, CFG } from "./vr_text.js";
const CUR_WORD = /^(?:USD|CAD|EUR|GBP)$/i;
const NUMTOK = /^(?:CA\$|US\$|[$€£])?-?\d[\d.,]*$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const QWORDS = new Set("what whats is the a an of on for to in at by with and or was were did does do who how much many this that it its me my our us we you your please tell show give find from are be been has have had as per charged charge invoice bill statement order amount cost".split(" "));
export function tokensOf(s) { const t = s.trim().split(/\s+/).filter(Boolean); const out = []; for (let i = 0; i < t.length; i++) { if (CUR_WORD.test(t[i]) && i + 1 < t.length && NUMTOK.test(t[i + 1])) { out.push(t[i] + " " + t[i + 1]); i++; } else out.push(t[i]); } return out; }
const isNum = (t) => NUMTOK.test(t.replace(/^[A-Za-z]{3}\s/, "")) && /\d/.test(t);
const isMoneyFmt = (t) => /[$€£]|^[A-Za-z]{3}\s|[.,]\d{2}$/.test(t);
const isUnit = (t) => /^[a-z]{1,5}\.?$/.test(t) || /^(@|x|×)$/i.test(t);
const isCode = (t) => /^[A-Z]{1,3}-?\d{3,6}$/.test(t);
const val = (t) => moneyNum(t.replace(/^[A-Za-z]{3}\s/, ""));
// split a row line (with X removed) into numeric tokens; null when other words remain
export function rowNums(line, X) {
  const m = new RegExp("(?<![A-Za-z0-9])" + esc(X).replace(/\s+/g, "\\s+") + "(?![A-Za-z0-9])", "i").exec(line); if (!m) return null;
  const rest = (line.slice(0, m.index) + "  " + line.slice(m.index + m[0].length)); const toks = tokensOf(rest); const nums = [];
  for (const t of toks) { if (isNum(t)) nums.push(t); else if (isUnit(t) || isCode(t)) continue; else return null; }
  return nums;
}
export const tableLike = (line) => { const toks = tokensOf(line); const nums = toks.filter(isNum); if (nums.length < 3) return false; const firstNum = toks.findIndex(isNum); const words_ = toks.filter((t) => !isNum(t) && !isUnit(t) && !isCode(t)); return words_.length >= 1 && words_.length <= 6 && toks.slice(firstNum).every((t) => isNum(t) || isUnit(t)) || toks.slice(0, toks.findIndex((t) => !isNum(t) && !isUnit(t) && !isCode(t))).length === 0 && toks.slice(-3).every(isNum); };
function total(nums) {
  const v = nums.map(val); if (v.some((x) => x == null)) return null; const good = new Set();
  for (let i = 0; i < v.length; i++) for (let j = 0; j < v.length; j++) for (let k = j + 1; k < v.length; k++) { if (i === j || i === k) continue; if (Math.abs(v[j] * v[k] - v[i]) <= 0.0061) good.add(i); }
  const vs = new Set([...good].map((i) => v[i])); if (vs.size !== 1) return vs.size ? "ambiguous" : "none";
  return [...good].pop();
}
function headerFor(lines, ri, n) {
  for (let h = ri - 1; h >= Math.max(0, ri - 6); h--) { const cs = lines[h].trim().split(/\s{2,}/); if (cs.length === n && cs.every((c) => /[A-Za-z]/.test(c) && !isNum(c.split(" ").pop()) )) return cs; }
  return null;
}
const colToks = (q, X, a) => { const xs = new Set(words(X).map(stem)); const an = new Set([...a.ids, ...a.names.flatMap((n) => words(n))].map((x) => String(x).toLowerCase())); return words(q).filter((w) => !STOP.has(w) && !QWORDS.has(w) && !an.has(w) && !a.idRaw.some((r) => words(r).includes(w))).map(stem).filter((t) => !xs.has(t)); };
const TOTALQ = /\b(?:how much|charged|charge|line total|extended|extension|ext|total (?:for|of)|amount (?:for|of|charged)|cost (?:for|of)|billed)\b/i;
const NOTTOTAL = /\b(?:unit|rate|each|per|price|qty|quantity|how many|hours?|weeks?|units?|days?|fees?|hourly|weekly|daily)\b/i;
const QTYQ = /\b(?:qty|quantity|how many|hours?|weeks?|units?|days?|number)\b/i, RATEQ = /\b(?:unit|rate|each|per|price|cost|fee|hourly|weekly|daily)\b/i;

// candidate item phrases X: text after each "for"/"of" before the anchor
function itemPhrases(q, a, opts) {
  let head = null;
  if (a.idRaw.length === 1) { const i = q.indexOf(a.idRaw[0]); if (i < 0) return []; head = q.slice(0, i); }
  else if (!a.ids.length && opts.only) { const m = q.match(/^(.*?)\s+(?:on|in|from)\s+the\s+(?:invoice|bill|statement|order|record)\b/i); if (!m) return []; head = m[1]; }
  else return [];
  head = head.replace(/\s+(?:on|in|from|under)\s+(?:the\s+)?(?:(?:invoice|bill|statement|order|record)\s+)?(?:no\.?\s+|number\s+|#)?$/i, "").replace(/[?\s]+$/, "");
  const out = []; const re = /\b(?:for|of)\s+(?:the\s+)?/gi; let m; while ((m = re.exec(head))) out.push(head.slice(m.index + m[0].length).trim());
  return out.filter((x) => x.length >= 3);
}
export function lineItemRead(a, top, opts, question) {
  const Xs = itemPhrases(question, a, opts); if (!Xs.length) return null;
  const pages = (opts.only ? top : top).filter((d) => a.ids.every((i) => d.idset.has(i)) && a.names.every((n) => words(d.text).join(" ").includes(words(n).join(" "))));
  for (const X of Xs) {
    const hits = [];
    for (const d of pages) {
      const lines = d.text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
      lines.forEach((l, ri) => { const nums = rowNums(l, X); if (nums && (nums.length >= 2 || (nums.length === 1 && isMoneyFmt(nums[0])))) hits.push({ d, l, ri, lines, nums }); });
    }
    if (!hits.length) continue;
    const res = hits.map((h) => oneRow(h, X, a, question)); if (res.some((r) => r.soft)) return null; const bad = res.find((r) => r.ans == null); if (bad) return bad;
    if (new Set(res.map((r) => norm(r.ans))).size > 1) return { ans: null, why: "line-conflict" };
    const r = res[0]; return r;
  }
  return null;
}
function oneRow(h, X, a, q0) {
  const q = q0.replace(new RegExp(esc(X), "i"), " ");
  const { d, l, ri, lines, nums } = h; const fin = (ans, extra = {}) => ({ ans, label: "line item: " + X, score: 1, doc: d.file, page: d.page_no, ...extra });
  const askTotal = TOTALQ.test(q) && !NOTTOTAL.test(q);
  if (nums.length === 1) { // two-line items: "<desc>  <amount>" then "<qty> <unit> @ <rate>"
    const nx = lines[ri + 1] ?? ""; const m = nx.match(/^\s*(\d[\d.,]*)\s*([A-Za-z]{0,5})\s*@\s*(\S+(?:\s\d[\d.,]*)?)\s*$/);
    if (!m) return { ans: null, why: "line-single-unverified" };
    const qv = moneyNum(m[1]), rv = val(m[3]), av = val(nums[0]); if (qv == null || rv == null || av == null || Math.abs(qv * rv - av) > 0.0061) return { ans: null, why: "line-no-reconcile" };
    if (askTotal) return fin(nums[0], { reconcile: "pass" });
    const wq = QTYQ.test(q), wr = RATEQ.test(q); if (wq === wr) return { ans: null, why: "line-column-unclear", soft: true };
    return fin(wq ? m[1] : m[3], { reconcile: "pass" });
  }
  const t = total(nums);
  if (askTotal) { if (typeof t !== "number") return { ans: null, why: "line-no-reconcile:" + t }; return fin(nums[t], { reconcile: "pass" }); }
  // other column: header <-> cell alignment
  const cs = l.trim().split(/\s{2,}/); const hd = headerFor(lines, ri, cs.length); if (!hd) return { ans: null, why: "line-no-header", soft: true };
  const xi = cs.findIndex((c) => norm(c).includes(norm(X))); if (xi < 0) return { ans: null, why: "line-misaligned", soft: true };
  const ct = colToks(q, X, a); if (!ct.length) return { ans: null, why: "line-column-unclear", soft: true };
  const hs = hd.map((c) => new Set(words(c).map(stem)));
  const idx = hs.map((s, i) => [i, ct.every((t2) => s.has(t2))]).filter((x) => x[1]).map((x) => x[0]);
  if (idx.length !== 1 || idx[0] === xi) return { ans: null, why: "line-column-unclear", soft: true };
  const cell = cs[idx[0]]; if (!isNum(cell.split(" ").length > 1 && CUR_WORD.test(cell.split(" ")[0]) ? cell : cell.replace(/\s+[a-z]{1,5}$/, ""))) return { ans: null, why: "line-cell-type", soft: true };
  return fin(cell, { reconcile: typeof t === "number" ? "pass" : "none" });
}
