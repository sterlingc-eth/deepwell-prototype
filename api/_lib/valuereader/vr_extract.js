// Typed-entity candidate extraction: label:value pairs, spreadsheet-text rows (header<->cell alignment),
// pdf-text tables (header words <-> trailing cells), and entities near free-text labels. Generic.
import { norm, stem, words, MONEY_RE, DATE_RE, valueType, parseDate, CFG } from "./vr_text.js";
import { ingestPairs } from "./vr_ingest.js";

const TRAIL_PREP = new Set("of on is was for at by to in the a an and as with from".split(" "));
const FUNC_W = new Set(["on", "of", "for", "the", "a", "an", "to", "in", "at", "by", "per"]);
const labToks = (label) => { const t = words(label).map(stem); if (!CFG.labStop) return t; const f = t.filter((x) => !FUNC_W.has(x)); return f.length ? f : t; };
const CAPW = /\b(name|street|address|city|state|zip|tin|ssn|ein|phone|payer|payer's|recipient|recipient's|signature|date|number|account|copy)\b/gi;
const captionLike = (v) => { if (/^[A-Z]+'S\s+[A-Za-z ,.-]{2,40}$/.test(v.toUpperCase()) && /^[A-Z]+'S\b/.test(v)) return true; const w = new Set((v.match(CAPW) ?? []).map((x) => x.toLowerCase())); return w.size >= 2 && v.split(/\s+/).length <= 9 && !/\d{3,}/.test(v); };
const mk = (label, value, src, line) => {
  label = String(label).replace(/\s+/g, " ").trim(); value = String(value).replace(/\s+/g, " ").trim().replace(/[;,]+$/, "");
  if (!label || !value || value.length > 160) return null;
  if (CFG.capVal && captionLike(value)) return null;   // a form-box caption read as a value
  const r = { label, lab: labToks(label), value, type: valueType(value), src, line };
  const rg = value.match(RANGE); if (rg && parseDate(rg[1].trim()) && parseDate(rg[2].trim())) r.extra = [{ ...r, label: label + " start", lab: words(label + " start").map(stem), value: rg[1].trim(), type: "date", extra: undefined }, { ...r, label: label + " end", lab: words(label + " end").map(stem), value: rg[2].trim(), type: "date", extra: undefined }];
  return r;
};
const RANGE = /^(.*?\d{4}|.*?\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:-|\u2013|\u2014|to|through|thru)\s*(.*?\d{4}|.*?\d{1,2}\/\d{1,2}\/\d{2,4})$/i;
const splitCell = (c) => { const m = c.match(/^(.{1,80}?): (.+)$/); return m ? [m[1], m[2]] : null; };

const isTypedKey = (k) => /^[$\d(-][\d,.)%-]*$/.test(k) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(k);
function parseSheetBlock(lines, out, restHasId) {
  // lines: header + Row lines of one sheet block
  let header = null; const rows = [];
  for (const L of lines) {
    let m;
    if ((m = L.match(/^Header \(row \d+\): (.*)$/))) header = m[1].split(" | ").map((s) => s.trim());
    else if ((m = L.match(/^Row \d+ \| (.*)$/))) rows.push(m[1].split(" | ").map(splitCell).map((p, i, a) => p).filter(Boolean));
  }
  if (!rows.length) return { ctx: header ? header.join(" ") : "" };
  let ctx = header ? header.join(" ") : "";
  const maxc = Math.max(...rows.map((r) => r.length));
  const hset = new Set((header ?? []).map(norm));
  const mangled = header && (rows.some((r) => r.some(([k]) => !hset.has(norm(k)))) || header.length < maxc);
  let keys = null, start = 0;
  if (mangled && rows.length >= 3) {
    const first = rows[0];
    const typed = first.some(([, v]) => ["money", "date", "int", "number", "id"].includes(valueType(v)));
    const laterTyped = rows.slice(1).filter((r) => r.some(([, v]) => ["money", "int", "number"].includes(valueType(v)))).length >= rows.length / 2;
    if (!typed && laterTyped) { keys = first.map(([, v]) => v); start = 1; ctx += " " + first.map(([k]) => k).join(" "); }
  }
  for (let ri = start; ri < rows.length; ri++) {
    const r = rows[ri]; const pairs = [];
    r.forEach(([k, v], i) => { const p = mk(keys ? keys[i] ?? k : k, v, "row"); if (p) { pairs.push(p); if (p.extra) pairs.push(...p.extra); } });
    out.push({ kind: "row", text: r.map(([k, v]) => `${k}: ${v}`).join(" | "), pairs, ctxFromSheet: true });
    if (CFG.sheetPA && restHasId && r.length >= 3 && !r.some(([, v]) => valueType(v) === "id")) { const key = (keys ? keys[0] : null, r[0][1]); if (key && /[A-Za-z]/.test(key) && !isTypedKey(key)) out.push({ kind: "row", text: r.map(([k, v]) => `${k}: ${v}`).join(" | "), pairs, ctxFromSheet: true, pageAnchored: true, pdfTable: true, noCtx: true, rowKey: key }); }
  }
  return { ctx };
}

const isTypedTok = (t) => /^\$?-?\d[\d,]*(\.\d+)?%?$/.test(t) || /^[A-Z]$/.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t) || /^[A-Z]{1,6}-?[A-Z0-9]*\d[\w-]*$/.test(t);
function groupHeader(h) {
  const parts = h.split(/\s{2,}|\t/).filter(Boolean); if (parts.length > 1) return parts;
  const toks = h.trim().split(/\s+/), g = [];
  for (const t of toks) { if (g.length && /^[a-z]/.test(t)) g[g.length - 1] += " " + t; else g.push(t); }
  return g;
}
function pdfTables(lines, out) {
  for (let i = 0; i < lines.length - 1; i++) {
    const h = lines[i];
    if (/\d/.test(h) || !/^[A-Z]/.test(h) || h.split(/\s+/).length < 3 || h.split(/\s+/).length > 10) continue;
    const groups = groupHeader(h); if (groups.length < 3) continue;
    let n = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const toks = lines[j].trim().split(/\s+/); let k = 0;
      while (k < toks.length - 1 && isTypedTok(toks[toks.length - 1 - k])) k++;
      if (k < 2 || k !== groups.length - 1) break;
      const cells = toks.slice(toks.length - k); const desc = toks.slice(0, toks.length - k).join(" ");
      if (!desc) break;
      const pairs = [mk(groups[0], desc, "pdfrow")]; cells.forEach((c, x) => pairs.push(mk(groups[x + 1], c, "pdfrow")));
      out.push({ kind: "row", text: lines[j], pairs: pairs.filter(Boolean), pdfTable: true }); n++;
    }
    if (n) i += n;
  }
}

function nearPairs(line, out) {
  const ents = [];
  for (const re of [MONEY_RE, DATE_RE]) { re.lastIndex = 0; let m; while ((m = re.exec(line))) ents.push({ s: m.index, e: m.index + m[0].length, v: m[0] }); }
  ents.sort((a, b) => a.s - b.s);
  ents.forEach((en, i) => {
    const prevEnd = i ? ents[i - 1].e : 0;
    let pre = line.slice(prevEnd, en.s); const cut = Math.max(pre.lastIndexOf("."), pre.lastIndexOf(";"), pre.lastIndexOf(":"), pre.lastIndexOf(","));
    if (cut >= 0 && pre.length - cut > 1) pre = pre.slice(cut + 1);
    let w = pre.trim().split(/\s+/).filter(Boolean).slice(CFG.near8 ? -8 : -5); while (w.length && TRAIL_PREP.has(w[w.length - 1].toLowerCase())) w.pop();
    if (w.length) { const p = mk(w.join(" "), en.v, "near", line); if (p) out.push(p); }
    const nextS = i + 1 < ents.length ? ents[i + 1].s : line.length;
    let post = line.slice(en.e, nextS).replace(/^[\s,;]+/, ""); post = post.split(/[.;,:]/)[0];
    const pw = post.trim().split(/\s+/).filter(Boolean).slice(0, 3); while (pw.length && TRAIL_PREP.has(pw[pw.length - 1].toLowerCase())) pw.pop();
    if (pw.length && !/^(received|on|by|via|and|per|due|is|was)$/i.test(pw[0])) { const p = mk(pw.join(" "), en.v, "near", line); if (p) out.push(p); }
  });
}


// ---- valuereader2 layout helpers (generic) ----
const INJ_RE = /(?:ignore|disregard|forget|override)[^.\n]{0,50}(?:previous|prior|above|all|earlier)[^.\n]{0,30}(?:instruction|prompt|rule|direction)s?|system override|(?:note|message|memo) to (?:the |any )?(?:ai|assistant|model|bot|llm)|(?:ai|assistant) (?:note|reading this)|reply only (?:with |'|")|answer every question (?:\w+ ){0,3}with|you are now|new instructions?:/i;
export const isInjectionLine = (l) => INJ_RE.test(l);
const CAPS_LAB = /^[A-Z][A-Z0-9 #\/&.'()-]{1,40}$/;
const TYPED_VAL = new Set(["money", "date", "id", "phone", "email", "percent", "int", "number"]);
const cellLabelLike = (c) => /^[A-Za-z#][A-Za-z0-9 .\/#&()'%:-]{0,40}$/.test(c) && c.split(/\s+/).length <= 6 && !TYPED_VAL.has(valueType(c)) && !/[.]$/.test(c.replace(/\.{2,}$/, "")) || /^[A-Za-z#][A-Za-z0-9 \/#&()'%-]{0,40}\.$/.test(c) && c.split(/\s+/).length <= 3;
function cellPairs(line, out) {
  const tabbed = /\t/.test(line);
  const cells = line.trim().split(tabbed ? /\t+/ : /\s{2,}/).map((c) => c.trim()).filter(Boolean);
  let shifted = false;
  if (cells.length % 2 && cells.length >= 3 && CAPS_LAB.test(cells[0]) && !/:$/.test(cells[0])) { cells.shift(); shifted = CFG.oddShift; } // "TITLE    Label: value" on one line
  else if (CFG.oddShift && cells.length % 2 && cells.length >= 3 && !tabbed && !/:\s*$/.test(cells[0])) { cells.shift(); shifted = true; } // left-column text beside "Label    value" cells (the stacked left block is read by stackedPairs)
  if (cells.length < (shifted ? 2 : 3) || cells.length % 2) return false;
  const pairs = []; let anyTyped = false;
  for (let i = 0; i < cells.length; i += 2) {
    const l = cells[i], v = cells[i + 1];
    if (!cellLabelLike(l)) return false;
    const typed = TYPED_VAL.has(valueType(v)) || (/\d/.test(v) && v.length <= 40); if (typed) anyTyped = true;
    if (v.length > 80 || /:\s/.test(v)) return false;
    pairs.push([l, v]);
  }
  if (!tabbed && !anyTyped) return false; // a header row ("Description  Qty  Rate  Amount") has no typed value
  for (const [l, v] of pairs) { const p = mk(l.replace(/:$/, ""), v, "kv", line); if (p) { out.push(p); if (p.extra) out.push(...p.extra); } }
  return true;
}

function stackedPairs(rest, out, capsOnly) {
  for (let i = 0; i + 1 < rest.length; i++) {
    const l = rest[i].trim(), v = rest[i + 1].trim(); if (CFG.stackMulti && (/\S\s{3,}\S/.test(v) || /\S\s{3,}\S/.test(l))) continue;
    if (!capsOnly && /^[A-Za-z#][A-Za-z0-9 .\/#&()'%-]{1,30}:$/.test(l) && v.length <= 80 && !CAPS_LAB.test(v) && !/^[A-Za-z#][A-Za-z0-9 .\/#&()'%-]{1,48}?:\s/.test(v)) { const p = mk(l.replace(/:$/, ""), v, "kv", l + " " + v); if (p) { out.push(p); if (p.extra) out.push(...p.extra); } continue; }
    if (!CAPS_LAB.test(l) || !/[A-Z]{2}/.test(l) || l.split(/\s+/).length > 5) continue;
    if (CAPS_LAB.test(v) || /^[A-Za-z#][A-Za-z0-9 .\/#&()'%-]{1,48}?:\s/.test(v) || v.length > 80) continue;
    const p = mk(l.charAt(0) + l.slice(1).toLowerCase(), v, "kv", l + " " + v); if (p) { out.push(p); if (p.extra) out.push(...p.extra); }
  }
}

// right-hand block: "Label" is the last chunk of its line and the next line has a chunk at the same x holding the value (two-column headers)
function rightStack(rest, out) {
  const chunks = (l) => { const o = []; const re = /\S+(?: {1,2}\S+)*/g; let m; while ((m = re.exec(l))) o.push({ x: m.index, t: m[0] }); return o; };
  for (let i = 0; i + 1 < rest.length; i++) {
    const a = chunks(rest[i]), b = chunks(rest[i + 1]); if (a.length < 2) continue; const lab = a[a.length - 1];
    if (!/^[A-Z][A-Za-z ./#%()-]{1,24}$/.test(lab.t) || lab.t.split(/\s+/).length > 3) continue;
    const v = b.find((c) => Math.abs(c.x - lab.x) <= 2); if (!v) continue;
    if (TYPED_VAL.has(valueType(v.t)) || /^[A-Z][A-Za-z ./#%()-]{1,24}$/.test(v.t) && b.indexOf(v) === b.length - 1 && b.length >= 2 && false) continue;
    if (!/^[A-Z]/.test(v.t) || v.t.length > 60) continue;
    const p = mk(lab.t, v.t, "kv", rest[i].trim() + " " + v.t); if (p) out.push(p);
  }
}
const LABEL_HDR = (c) => /^[A-Z][A-Za-z ./#%()-]{0,24}$/.test(c) && !/\d/.test(c);
const isNumCell = (c) => /^[€£$]?\s?-?\d[\d,.]*\d?\s?(?:%|[A-Za-z]{0,4})?$/.test(c) || TYPED_VAL.has(valueType(c));
function pdfTablesCells(lines, out) {
  for (let i = 0; i < lines.length - 1; i++) {
    const hc = lines[i].trim().split(/\s{2,}/); if (hc.length < 3 || hc.length > 8 || !hc.every(LABEL_HDR)) continue;
    let n = 0, j = i + 1; if (/^[-=_ ]{5,}$/.test(lines[j] ?? "")) j++;
    for (; j < lines.length; j++) {
      const cs = lines[j].trim().split(/\s{2,}/);
      if (cs.length !== hc.length || !isNumCell(cs[cs.length - 1]) || cs.slice(1).some((c) => !isNumCell(c))) {
        if (n && cs.length < 2 && j + 1 < lines.length && lines[j + 1].trim().split(/\s{2,}/).length === hc.length) continue; // one secondary line under a row
        break;
      }
      const pairs = cs.map((c, k) => mk(hc[k], c, "pdfrow")).filter(Boolean);
      out.push({ kind: "row", text: lines[j], pairs, pdfTable: true, pageAnchored: true, rowKey: cs[0] }); n++;
    }
    if (n) i = j - 1;
  }
}

const KV_RE = /^([A-Za-z#][A-Za-z0-9 .\/#&()'%-]{1,48}?)(?::\s+|\s{2,}|\t+)(\S.*)$/;
export function extractUnits(page) {
  const text = page.text ?? ""; let lines = text.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  if (CFG.inj) lines = lines.filter((l) => !isInjectionLine(l));
  if (CFG.cells) lines = lines.map((l) => l.replace(/\s*(?:\.\s?){3,}\s*/g, "  "));
  const units = [];
  // sheet blocks
  const sheetLines = lines.filter((l) => /^(Header \(row \d+\):|Row \d+ \|)/.test(l));
  let ctx = "";
  if (sheetLines.length) { const r = parseSheetBlock(sheetLines, units, lines.some((l) => !/^(Header \(row \d+\):|Row \d+ \|)/.test(l) && /\b[A-Z]{1,6}-\d{3,9}\b/.test(l))); ctx = r.ctx; }
  const rest = lines.filter((l) => !/^(Header \(row \d+\):|Row \d+ \|)/.test(l));
  const docPairs = [];
  if (CFG.cells) stackedPairs(rest, docPairs);
  if (CFG.rightStack) rightStack(rest, docPairs);
  if (CFG.leftCol) { const left = rest.map((l) => { if (/\t/.test(l)) return ""; if (/^\s{6,}/.test(l)) return ""; return l.trim().split(/\s{3,}/)[0]; }); if (left.some((l, i) => l !== rest[i])) stackedPairs(left, docPairs, true); } // left block of a two-column header
  for (const L0 of rest) {
    const L = CFG.cells ? L0.trim() : L0;
    if (CFG.cells && cellPairs(L0, docPairs)) { if (!CFG.noNearCell) nearPairs(L, docPairs); continue; }
    const segs2 = L.split(" | ");
    if (segs2.length === 2 && segs2[0].trim().split(/\s+/).length <= 5 && !/[:.,]$/.test(segs2[0])) { const p = mk(segs2[0], segs2[1], "kv", L); if (p) { docPairs.push(p); if (p.extra) docPairs.push(...p.extra); } continue; }
    for (const seg of L.split(" | ")) {
      const m = seg.match(KV_RE);
      if (m && m[1].split(/\s+/).length <= 6 && !/[.,]$/.test(m[1]) && !/^\d+$/.test(m[1])) { let v2 = m[2]; if (CFG.kvMulti && /\S\s{2,}\S/.test(v2.trim())) { const cs = v2.trim().split(/\s{2,}/); if (cs.some((c) => /:|\d/.test(c))) v2 = cs[0]; else continue; } const p = mk(m[1], v2, "kv", L); if (p) { docPairs.push(p); if (p.extra) docPairs.push(...p.extra); } }
    }
    nearPairs(L, docPairs);
  }
  if (CFG.ing) ingestPairs(rest, docPairs, mk, text);
  if (CFG.tbl) pdfTablesCells(rest, units);
  pdfTables(rest, units);
  units.push({ kind: "doc", text, pairs: docPairs });
  const title = (rest[0] ?? "") + " " + (rest[1] ?? "");
  for (const u of units) { u.page = page; u.title = norm(title + " " + (page.file ?? "") + " " + (u.noCtx ? "" : ctx)); u.ctx = u.noCtx ? "" : norm(ctx); }
  return units;
}
