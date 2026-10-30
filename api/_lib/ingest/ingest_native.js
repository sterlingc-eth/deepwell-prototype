// ingest1 / ingest_native.js - native .xlsx / .docx reader (jszip only, which the app already depends on). Handles merged cells (label merged across, value in next cell),
// multi-level merged headers (group header over sub-headers), title rows, label/value blocks, vertical merges in docx tables, number-format-aware cell text (dates as shown, money with $ and 2 decimals).
import JSZip from "jszip";
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, "&");
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? unesc(m[1]) : null; };
const colNum = (ref) => { const m = ref.match(/^([A-Z]+)(\d+)$/); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return [n - 1, +m[2] - 1]; };
const MN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function fmtDate(serial, f) {
  const ms = Math.round((serial - 25569) * 86400000); const d = new Date(ms); const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate(); const p2 = (n) => String(n).padStart(2, "0");
  let out = f.replace(/\[[^\]]*\]/g, "").replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/gi, (t) => { const k = t.toLowerCase(); return { yyyy: String(Y), yy: String(Y).slice(2), mmmm: "\u0001" + MN[M], mmm: "\u0001" + MN[M].slice(0, 3), mm: p2(M + 1), m: String(M + 1), dd: p2(D), d: String(D) }[k]; });
  return out.replace(/\u0001/g, "").replace(/\\/g, "");
}
const isDateFmt = (f) => /[ymd]/i.test(f.replace(/\[[^\]]*\]|"[^"]*"|\\./g, "")) && !/[#0]/.test(f.replace(/\[[^\]]*\]|"[^"]*"|\\./g, ""));
function fmtNum(v, f) {
  const n = parseFloat(v); if (!Number.isFinite(n)) return String(v);
  const dec = (f.match(/\.(0+)/) || [, ""])[1].length; const pct = /%/.test(f); const val = pct ? n * 100 : n; let s;
  if (/0/.test(f) || /#/.test(f)) { s = Math.abs(val).toFixed(dec); if (/#,##|,#/.test(f)) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ","); if (/\$/.test(f)) s = "$" + s; if (val < 0) s = "-" + s; if (pct) s += "%"; return s; }
  return String(Math.round(n * 1e9) / 1e9);
}
const BUILTIN = { 9: "0%", 10: "0.00%", 14: "mm/dd/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 22: "m/d/yyyy h:mm", 2: "0.00", 4: "#,##0.00", 3: "#,##0", 1: "0" };
export async function readXlsx(buf) {
  const z = await JSZip.loadAsync(buf); const rd = async (p) => (z.file(p) ? await z.file(p).async("string") : "");
  const wb = await rd("xl/workbook.xml"), rels = await rd("xl/_rels/workbook.xml.rels"); const sstXml = await rd("xl/sharedStrings.xml"), stylesXml = await rd("xl/styles.xml");
  const sst = [...sstXml.matchAll(/<si[ >][\s\S]*?<\/si>|<si\/>/g)].map((m) => unesc([...m[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
  const numFmts = {}; for (const m of stylesXml.matchAll(/<numFmt [^>]*>/g)) numFmts[attr(m[0], "numFmtId")] = attr(m[0], "formatCode");
  const xfs = (stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [""])[0]; const xfFmt = [...xfs.matchAll(/<xf [^>]*?(?:\/>|>)/g)].map((m) => { const id = attr(m[0], "numFmtId"); return numFmts[id] ?? BUILTIN[id] ?? "General"; });
  const relMap = {}; for (const m of rels.matchAll(/<Relationship [^>]*>/g)) relMap[attr(m[0], "Id")] = attr(m[0], "Target");
  const sheets = [...wb.matchAll(/<sheet [^>]*>/g)].map((m) => ({ name: attr(m[0], "name"), rid: attr(m[0], "r:id") })); const out = [];
  for (const sh of sheets) {
    let tgt = relMap[sh.rid] || ""; tgt = tgt.replace(/^\//, ""); const xml = await rd(tgt.startsWith("xl/") ? tgt : "xl/" + tgt); if (!xml) continue;
    const grid = new Map(); let maxR = 0, maxC = 0;
    for (const m of xml.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr("<c " + m[1], "r"); if (!ref) continue; const [c, r] = colNum(ref); const t = attr("<c " + m[1], "t"), s = +(attr("<c " + m[1], "s") || 0); const body = m[2] || "";
      let v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; let text = null;
      if (t === "s") text = sst[+v]; else if (t === "inlineStr") text = unesc([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")); else if (t === "str" || t === "e") text = unesc(v ?? ""); else if (t === "b") text = v === "1" ? "TRUE" : "FALSE";
      else if (v != null && v !== "") { const f = xfFmt[s] || "General"; text = isDateFmt(f) ? fmtDate(parseFloat(v), f) : fmtNum(v, f); }
      if (text != null && String(text).trim() !== "") { grid.set(r + "," + c, String(text).trim()); maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
    }
    const merges = [...xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map((m) => { const [c1, r1] = colNum(m[1]), [c2, r2] = colNum(m[2]); return { c1, r1, c2, r2 }; });
    out.push({ name: sh.name, grid, maxR, maxC, merges });
  }
  return out;
}
// sheet -> reader text
export function sheetText(sh) {
  const { grid, maxR, maxC, merges } = sh; const anchor = new Map(); for (const m of merges) anchor.set(m.r1 + "," + m.c1, m);
  const inMerge = (r, c) => merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
  const rows = []; for (let r = 0; r <= maxR; r++) { const cells = []; for (let c = 0; c <= maxC; c++) { const v = grid.get(r + "," + c); if (v != null) { const mg = anchor.get(r + "," + c); cells.push({ c, v, span: mg ? mg.c2 - mg.c1 + 1 : 1, rs: mg ? mg.r2 - mg.r1 + 1 : 1 }); } } rows.push(cells); }
  const lines = []; const used = new Set();
  const num = (v) => /^[$€£(-]?[\d,.]+%?\)?$/.test(v);
  // find table: a header row (>=3 text cells incl. possible group row above) followed by >=2 rows with >=3 cells
  let hdr = -1, groupRow = -1; const nonNum = (R0) => R0.length > 0 && !R0.some((x) => num(x.v));
  // two-level merged header: a group row (some merged span > 1) directly above a non-numeric sub-header row, followed by data rows
  for (let r = 0; r < rows.length - 3; r++) { const G = rows[r], S = rows[r + 1]; if (G.length >= 2 && G.some((x) => x.span > 1) && nonNum(G) && nonNum(S) && S.length >= 3 && rows[r + 2].length >= 3 && !(G.length <= 2 && G.some((x) => x.span >= maxC))) { groupRow = r; hdr = r + 1; break; } }
  if (hdr < 0) {
    for (let r = 0; r < rows.length - 2; r++) { const R0 = rows[r]; if (R0.length < 3 || R0.some((x) => num(x.v))) continue; if (rows[r + 1].length >= 3 && rows[r + 2].length >= 3) { hdr = r; break; } }
    if (hdr > 0) { const G = rows[hdr - 1]; if (G.length >= 1 && G.some((x) => x.span > 1) && !G.some((x) => num(x.v)) && !(G.length <= 2 && G.some((x) => x.span >= maxC))) groupRow = hdr - 1; }
  }
  const headers = []; if (hdr >= 0) { const H = rows[hdr]; const gl = []; if (groupRow >= 0) for (const g of rows[groupRow]) for (let c = g.c; c < g.c + g.span; c++) gl[c] = g.v; const sub = []; for (const h of H) sub[h.c] = h.v;
    for (let c = 0; c <= maxC; c++) { const g_ = gl[c], s_ = sub[c]; if (g_ && s_ && g_ !== s_) headers[c] = g_ + " " + s_; else if (s_ || g_) headers[c] = s_ || g_; } }
  // end of table: first row after body with <=2 cells following >=2 body rows
  let end = rows.length; if (hdr >= 0) { for (let r = hdr + 1; r < rows.length; r++) { if (rows[r].length === 0) { end = r; break; } } }
  // sheet-level id (e.g. "Rate card no.: RC-7740" above the table) is carried into every table row so a row is anchored by its own text
  let ctxId = null; if (false) for (let r = 0; r < rows.length && !ctxId; r++) { if (hdr >= 0 && r >= hdr && r < end) continue; const R = rows[r]; for (let i = 1; i < R.length; i++) if (/^[A-Z]{1,6}-\d{3,9}$/.test(R[i].v) && /[A-Za-z]/.test(R[i - 1].v)) { ctxId = `${R[i - 1].v.replace(/[:\s]+$/, "")}: ${R[i].v}`; break; } }
  for (let r = 0; r < rows.length; r++) {
    const R = rows[r]; if (!R.length) continue;
    if (hdr >= 0 && r === groupRow) continue;
    if (hdr >= 0 && r === hdr) { lines.push("Header (row " + (r + 1) + "): " + (ctxId ? ctxId.split(": ")[0] + " | " : "") + headers.filter(Boolean).join(" | ")); continue; }
    if (hdr >= 0 && r > hdr && r < end) { lines.push(`Row ${r + 1} | ` + (ctxId && !R.some((x) => x.v === ctxId.split(": ")[1]) ? ctxId + " | " : "") + R.map((x) => `${headers[x.c] ?? "Column " + (x.c + 1)}: ${x.v}`).join(" | ")); continue; }
    // title / label-value rows: pairs (text cell followed by the next cell) -> "label: value"
    const parts = []; let i = 0;
    while (i < R.length) { const a = R[i], b = R[i + 1]; if (b && !num(a.v) && /[A-Za-z]/.test(a.v) && (num(b.v) || a.span > 1 || R.length <= 4 || /[A-Za-z0-9]/.test(b.v) && R.length % 2 === 0)) { parts.push(`${a.v.replace(/[:\s]+$/, "")}: ${b.v}`); i += 2; } else { parts.push(a.v); i++; } }
    lines.push(parts.join("   "));
  }
  return `Sheet "${sh.name}"\n` + lines.join("\n") + "\n";
}
export async function xlsxPages(buf) { const sheets = await readXlsx(buf); return sheets.map((s, i) => ({ page_no: i + 1, text: sheetText(s) })).filter((p) => p.text.trim().split("\n").length > 1); }
// ---------------------------------------------------------------- docx
const txtOf = (xml) => unesc(xml.replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<(?!\/?w:t[ >])[^>]+>/g, "").replace(/<\/?w:t[^>]*>/g, "")).replace(/\n+$/, "").trim();
export async function docxText(buf) {
  const z = await JSZip.loadAsync(buf); const xml = await z.file("word/document.xml").async("string"); const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [, xml])[1]; const lines = [];
  const re = /<w:p[ >][\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g; let m;
  while ((m = re.exec(body))) {
    if (m[0].startsWith("<w:tbl>")) {
      const rows = []; const carry = {};
      for (const tr of m[0].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) { const cells = []; let col = 0;
        for (const tc of tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)) { const span = +((tc[0].match(/<w:gridSpan w:val="(\d+)"/) || [, 1])[1]); const vm = tc[0].match(/<w:vMerge( w:val="(\w+)")?\/>/); let t = txtOf(tc[0]).replace(/\n/g, " ");
          if (vm && !vm[2]) t = carry[col] ?? t; else if (vm) carry[col] = t; else delete carry[col]; cells.push({ col, span, t }); col += span; } rows.push(cells); }
      const maxc = Math.max(...rows.map((r) => r.reduce((a, c) => a + c.span, 0)));
      const grp = rows.length > 2 && rows[0].some((c) => c.span > 1) && rows[0].length < rows[1].length;
      if (grp) { const gl = []; for (const c of rows[0]) for (let k = c.col; k < c.col + c.span; k++) gl[k] = c.t; const H = rows[1].map((c) => ({ col: c.col, h: (gl[c.col] && gl[c.col] !== c.t && c.col > 0 ? gl[c.col] + " " : "") + c.t }));
        lines.push(rows[0].map((c) => c.t).join("   ")); lines.push("Header: " + H.map((x) => x.h).join(" | ")); rows.slice(2).forEach((r, i) => lines.push(`Row ${i + 1} | ` + r.map((c) => `${(H.find((x) => x.col === c.col) || {}).h ?? "Column"}: ${c.t}`).join(" | "))); }
      else for (const r of rows) { const cs = r.map((c) => c.t); lines.push(r.length === 2 && cs[0] && !/^[\d$]/.test(cs[0]) ? `${cs[0].replace(/[:\s]+$/, "")}: ${cs[1]}` : cs.join("\t")); }
    } else { const t = txtOf(m[0]); if (t) lines.push(t); }
  }
  return lines.join("\n") + "\n";
}
