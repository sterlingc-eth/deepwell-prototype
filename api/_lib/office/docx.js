/**
 * .docx reader: text in reading order from the main document part (plus headers, footers, footnotes, endnotes), split into
 * document_pages rows of ~WORD_PAGE_CHARS at paragraph / table-row boundaries.
 *
 * What is read: paragraphs, headings, list items ("- " per list level), tables (a row = its cells joined by " | ";
 * a merged cell appears once, a vertical-merge continuation is empty, a nested table is folded into its cell as
 * "[a | b; c | d]"), hyperlink TEXT (targets are never read or followed), tabs, line breaks, tracked changes (inserted text
 * kept, deleted text dropped), content controls (placeholder text dropped), text boxes (read once: inside
 * mc:AlternateContent only the Choice branch, never the Fallback copy), footnotes/endnotes, each distinct header/footer
 * once. NOT read: field instructions (HYPERLINK/DDE/INCLUDETEXT live there), embedded objects, OLE, linked images, comments,
 * revisions metadata, anything external. Hidden text (w:vanish) is NOT read (a reader sees what a person sees; hidden sheets
 * in Excel, by contrast, ARE read and marked).
 *
 * Pages: blocks are packed up to WORD_PAGE_CHARS; a table row is never cut; a paragraph longer than a page is split at a
 * line/sentence/space. An explicit page break or a section break ends the page when it is at least half full (so a page
 * break after a short cover line does not create a nearly empty billable page). A heading is never left alone at the end of
 * a page. Every page starts with "Section: <nearest heading>" (or "Part k of n" when the document has no heading yet).
 */
import { WORD_PAGE_CHARS, MAX_TOTAL_CHARS, MAX_PAGES_PER_FILE, MAX_ZIP_ENTRY_INFLATED } from "./limits.js";
import { OfficeError } from "./errors.js";
import { parseXml, xmlBytesToString } from "./xml.js";
import { readRels, resolveTarget, relsPathFor, dirOf, mustRead } from "./pkg.js";

const TOO_BIG = new OfficeError(413, "docx-too-big",
  "This document has more text than DeepWell reads from one file. Split it into smaller documents and upload again.");
const MAX_PART_BYTES = MAX_ZIP_ENTRY_INFLATED;

/** style id -> heading level from word/styles.xml (names like "heading 1", "Title", or an outline level). */
function readStyles(zip, path, clock) {
  const map = new Map();
  if (!path || !zip.has(path)) return map;
  let id = null;
  parseXml(xmlBytesToString(zip.read(path, MAX_PART_BYTES)), {
    clock,
    onOpen(name, a) {
      if (name === "style") id = a.styleId ?? null;
      else if (name === "name" && id) {
        const n = String(a.val ?? "").toLowerCase();
        const m = /^heading\s*(\d)$/.exec(n);
        if (m) map.set(id, Number(m[1]));
        else if (n === "title" || n === "subtitle") map.set(id, 1);
      } else if (name === "outlineLvl" && id && a.val !== undefined && !map.has(id)) {
        const l = Number(a.val);
        if (l >= 0 && l <= 8) map.set(id, l + 1);
      }
    },
    onClose(name) { if (name === "style") id = null; },
  });
  return map;
}

/** Strip trailing spaces/tabs with ONE backwards scan (a regex /[ \t]+$/ is quadratic on a long run of tabs followed by text). */
function trimEndBlanks(str) {
  let end = str.length;
  while (end > 0) { const c = str.charCodeAt(end - 1); if (c === 32 || c === 9) end--; else break; }
  return end === str.length ? str : str.slice(0, end);
}

const PB = "\u0001PB\u0001"; // in-paragraph page-break marker (never appears in real text: control char)

/**
 * Parse one WordprocessingML part into blocks {kind:'p'|'row'|'note', text, level, heading?, brk?}.
 * `brk` = an explicit page/section break comes BEFORE this block. mode 'notes' reads footnotes/endnotes parts.
 */
function parsePart(xml, styles, clock, charBudget, mode) {
  const blocks = [];
  const containers = [{ blocks, kind: "root" }];
  const top = () => containers[containers.length - 1];
  let para = null;
  const paraStack = [];
  let pendingBreak = false;
  let del = 0, rt = 0, instr = 0, fb = 0, inT = 0;
  let hiddenRun = false; // a run formatted as hidden text (w:vanish) is not read: what a person sees, like deleted tracked text
  let inPPr = false, inTcPr = false, inTrPr = false;
  const sdts = [];
  const tbls = [];

  const push = (b, c = top()) => {
    charBudget(b.text.length);
    if (pendingBreak && c.kind === "root") { b.brk = true; pendingBreak = false; }
    c.blocks.push(b);
  };

  parseXml(xml, {
    clock,
    onOpen(name, a) {
      if (name === "Fallback") { fb++; return; }
      if (fb > 0) return;
      switch (name) {
        case "p":
          if (para) paraStack.push(para);
          para = { text: "", level: 0, list: 0, after: [], pb: false, sec: false };
          return;
        case "pPr": inPPr = true; return;
        case "pStyle": if (para && inPPr) { const l = styles.get(a.val); if (l) para.level = l; } return;
        case "outlineLvl": if (para && inPPr && !para.level) { const l = Number(a.val); if (l >= 0 && l <= 8) para.level = l + 1; } return;
        case "numPr": if (para && inPPr) para.list = Math.max(para.list, 1); return;
        case "numId": if (para && inPPr && a.val === "0") para.list = 0; return;
        case "ilvl": if (para && inPPr) para.list = Math.max(para.list, 1) + (Number(a.val) || 0); return;
        case "pageBreakBefore": if (para && inPPr && a.val !== "0" && a.val !== "false") para.pb = true; return;
        case "sectPr": if (para && inPPr) para.sec = true; return;
        case "type": if (para && inPPr && para.sec && a.val === "continuous") para.sec = false; return;
        case "del": case "moveFrom":
          if (inTrPr && tbls.length && name === "del") { const t = tbls[tbls.length - 1]; if (t.row) t.row.deleted = true; }
          del++; return;
        case "r": hiddenRun = false; return;
        case "vanish": if (a.val !== "0" && a.val !== "false" && !inPPr) hiddenRun = true; return;
        case "rt": rt++; return;
        case "instrText": case "delInstrText": instr++; return;
        case "t": inT++; return;
        case "showingPlcHdr": if (sdts.length) sdts[sdts.length - 1].placeholder = true; return;
        case "sdt": sdts.push({ placeholder: false, para, textLen: para ? para.text.length : 0, container: top(), blocksLen: top().blocks.length }); return;
        case "tab": case "ptab": if (para && !inPPr && !del) para.text += "\t"; return;
        case "br": if (para && !del) { if (a.type === "page") para.text += PB; else if (a.type !== "column") para.text += "\n"; } return;
        case "cr": if (para && !del) para.text += "\n"; return;
        case "noBreakHyphen": if (para && !del) para.text += "-"; return;
        case "tbl": tbls.push({ rows: [], row: null }); return;
        case "tr": if (tbls.length) tbls[tbls.length - 1].row = { cells: [], deleted: false }; return;
        case "trPr": inTrPr = true; return;
        case "tc": containers.push({ blocks: [], kind: "cell", vmerge: false }); return;
        case "tcPr": inTcPr = true; return;
        case "vMerge": { const c = top(); if (c.kind === "cell" && inTcPr && a.val !== "restart") c.vmerge = true; return; }
        case "txbxContent": containers.push({ blocks: [], kind: "textbox" }); return;
        case "footnote": case "endnote":
          if (mode === "notes") containers.push({ blocks: [], kind: "note", id: a.id, skip: a.type === "separator" || a.type === "continuationSeparator" || a.type === "continuationNotice" || Number(a.id) <= 0 });
          return;
        default: return;
      }
    },
    onClose(name) {
      if (name === "Fallback") { fb = Math.max(0, fb - 1); return; }
      if (fb > 0) return;
      switch (name) {
        case "pPr": inPPr = false; return;
        case "tcPr": inTcPr = false; return;
        case "trPr": inTrPr = false; return;
        case "t": inT = Math.max(0, inT - 1); return;
        case "del": case "moveFrom": del = Math.max(0, del - 1); return;
        case "rt": rt = Math.max(0, rt - 1); return;
        case "instrText": case "delInstrText": instr = Math.max(0, instr - 1); return;
        case "p": {
          if (!para) return;
          const p = para;
          para = paraStack.pop() ?? null;
          const c = top();
          if (p.pb) pendingBreak = true;
          const segs = p.text.split(PB);
          for (let i = 0; i < segs.length; i++) {
            if (i > 0) pendingBreak = true;
            const text = trimEndBlanks(segs[i]).trim();
            if (!text) continue;
            const pre = p.list && i === 0 ? "  ".repeat(Math.min(p.list - 1, 6)) + "- " : "";
            const b = { kind: "p", text: pre + text, level: i === 0 ? p.level : 0 };
            if (b.level && c.kind === "root") b.heading = text.slice(0, 400).replace(/\s+/g, " ").slice(0, 80);
            push(b, c);
          }
          for (const x of p.after) push(x, c);
          if (p.sec) pendingBreak = true;
          return;
        }
        case "txbxContent": {
          const c = containers.pop();
          if (!c || c.kind !== "textbox") return;
          const text = c.blocks.map((b) => b.text).join("\n").trim();
          if (!text) return;
          const b = { kind: "p", text: "[Text box] " + text, level: 0 };
          if (para) para.after.push(b); else push(b);
          return;
        }
        case "tc": {
          const c = containers.pop();
          const t = tbls[tbls.length - 1];
          if (!c || c.kind !== "cell" || !t?.row) return;
          t.row.cells.push(c.vmerge ? "" : c.blocks.map((b) => b.text.replace(/\n+/g, " ")).join(" / ").trim());
          return;
        }
        case "tr": {
          const t = tbls[tbls.length - 1];
          if (t?.row) { if (!t.row.deleted) t.rows.push(t.row.cells); t.row = null; }
          return;
        }
        case "tbl": {
          const t = tbls.pop();
          if (!t) return;
          const lines = [];
          let rn = 0;
          for (const r of t.rows) {
            if ((++rn & 255) === 0) clock?.check();
            for (const l of rowLines(r)) lines.push(l);
          }
          if (!lines.length) return;
          const c = top();
          if (c.kind === "cell") push({ kind: "p", text: "[" + lines.join("; ") + "]", level: 0 }, c);
          else for (const l of lines) push({ kind: "row", text: l, level: 0 }, c);
          return;
        }
        case "sdt": {
          const s = sdts.pop();
          if (!s || !s.placeholder) return;
          if (s.container.blocks.length > s.blocksLen) s.container.blocks.length = s.blocksLen;
          if (s.para && para === s.para) para.text = para.text.slice(0, s.textLen);
          return;
        }
        case "footnote": case "endnote": {
          if (mode !== "notes") return;
          const c = containers.pop();
          if (!c || c.kind !== "note" || c.skip) return;
          const text = c.blocks.map((b) => b.text).join(" ").trim();
          if (text) push({ kind: "note", text: `${name === "footnote" ? "Footnote" : "Endnote"} ${c.id}: ${text}`, level: 0 }, top());
          return;
        }
        default: return;
      }
    },
    onText(t) {
      if (inT && para && !del && !rt && !instr && !fb && !hiddenRun) para.text += t;
    },
  });
  return blocks;
}

/**
 * One table row -> its text line(s). Runs of empty cells collapse to one, trailing empty cells are dropped (one backwards
 * scan: no repeated slice), and a row longer than two pages is cut at cell boundaries (a single huge cell at a space)
 * into pieces of about one page; each continuation piece starts with the row's first cell so it still says where it is.
 */
function rowLines(cells) {
  const out = [];
  let prevEmpty = false;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === "") { if (prevEmpty) continue; prevEmpty = true; } else prevEmpty = false;
    out.push(c);
  }
  let e = out.length;
  while (e > 0 && out[e - 1] === "") e--;
  out.length = e;
  if (!e) return [];
  const whole = out.join(" | ");
  if (whole.length <= WORD_PAGE_CHARS * 2) return [whole];
  const first = (out.find((x) => x) ?? "").slice(0, 40);
  const lines = [];
  let cur = "";
  const flush = () => { if (cur) lines.push(lines.length ? `${first} (row continues) | ${cur}` : cur); cur = ""; };
  for (const cell of out) {
    for (const piece of cell.length > WORD_PAGE_CHARS ? splitLong(cell, WORD_PAGE_CHARS) : [cell]) {
      if (cur && cur.length + piece.length + 3 > WORD_PAGE_CHARS) flush();
      cur += (cur ? " | " : "") + piece;
    }
  }
  flush();
  return lines;
}

/** Cut an over-long paragraph into pieces of at most `max`, at a newline, sentence end or space when one is near. */
function splitLong(text, max) {
  // Refuse before splitting what could never fit under the page cap (and keep the work linear).
  if (text.length > MAX_PAGES_PER_FILE * max) throw TOO_BIG;
  const out = [];
  let pos = 0;
  while (text.length - pos > max) {
    const end = pos + max;
    // Look for a break only inside the last half of the window (bounded scan, never the whole text).
    let cut = -1;
    for (let k = end; k > pos + max * 0.5; k--) {
      const c = text.charCodeAt(k - 1);
      if (c === 10) { cut = k; break; }
      if (c === 32 && cut < 0) cut = k;
      if (c === 32 && text.charCodeAt(k - 2) === 46) { cut = k; break; }
    }
    if (cut < 0) cut = end;
    out.push(text.slice(pos, cut).trim());
    pos = cut;
  }
  const rest = text.slice(pos).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Pack blocks into pages (see header). Returns [{heading:string|null, text:string}]. */
function paginate(units, clock) {
  const pages = [];
  let cur = [];
  let len = 0;
  let running = null;
  let startHeading = null;
  const flush = () => {
    if (!cur.length) return;
    let carry = null;
    if (cur.length > 1 && cur[cur.length - 1].level > 0 && cur[cur.length - 1].heading) carry = cur.pop();
    const firstH = cur.find((b) => b.heading)?.heading ?? null;
    pages.push({ heading: startHeading ?? firstH, text: cur.map((b) => b.text).join("\n") });
    cur = [];
    len = 0;
    if (carry) { cur.push(carry); len = carry.text.length + 1; }
    startHeading = running && !carry ? running : (carry?.heading ?? running);
  };
  let un = 0;
  for (const b of units) {
    if ((++un & 255) === 0) clock?.check();
    if (b.brk && len >= WORD_PAGE_CHARS * 0.5) flush();
    if (cur.length && len + b.text.length + 1 > WORD_PAGE_CHARS) flush();
    if (!cur.length) startHeading = b.heading ?? running;
    if (b.heading) running = b.heading;
    cur.push(b);
    len += b.text.length + 1;
    if (pages.length > MAX_PAGES_PER_FILE) throw TOO_BIG;
  }
  flush();
  return pages;
}

/**
 * @param {{read(name:string, cap?:number):Buffer, has(name:string):boolean, names:string[]}} zip
 * @returns {{pages:{page_no:number,text:string}[], notes:string[]}}
 */
export function readDocx(zip, { clock }) {
  const notes = [];
  let chars = 0;
  const charBudget = (n) => { chars += n + 1; if (chars > MAX_TOTAL_CHARS) throw TOO_BIG; };

  const rootRels = readRels(zip, "_rels/.rels", clock);
  const mainRel = rootRels.find((r) => /\/officeDocument$/.test(r.type) && !r.external);
  const mainPath = (mainRel && resolveTarget("", mainRel.target)) || "word/document.xml";
  if (!zip.has(mainPath)) mustRead(zip, "word/document.xml");
  const main = zip.has(mainPath) ? mainPath : "word/document.xml";
  const rels = readRels(zip, relsPathFor(main), clock);
  const dir = dirOf(main);
  const target = (suffix) => rels.filter((r) => !r.external && r.type.endsWith("/" + suffix))
    .map((r) => resolveTarget(dir, r.target)).filter((p, i, a) => p && zip.has(p) && a.indexOf(p) === i);
  const stylePath = target("styles")[0] ?? "word/styles.xml";
  const styles = readStyles(zip, stylePath, clock);

  const body = parsePart(xmlBytesToString(zip.read(main, MAX_PART_BYTES)), styles, clock, charBudget, "body");

  const seen = new Set();
  const meta = (label, paths, mode = "body") => {
    const out = [];
    for (const p of paths) {
      const blocks = parsePart(xmlBytesToString(zip.read(p, MAX_PART_BYTES)), styles, clock, charBudget, mode);
      if (mode === "notes") { for (const b of blocks) if (!seen.has(b.text)) { seen.add(b.text); out.push({ ...b, level: 0 }); } continue; }
      const text = blocks.map((b) => b.text).join(" / ").trim();
      if (text && !seen.has(label + text)) { seen.add(label + text); out.push({ kind: "meta", text: `${label}: ${text}`, level: 0 }); }
    }
    return out;
  };
  const headers = meta("Header", target("header"));
  const footers = meta("Footer", target("footer"));
  const fnotes = meta("", target("footnotes"), "notes");
  const enotes = meta("", target("endnotes"), "notes");

  const units = [];
  let bn = 0;
  for (const b of [...headers, ...body, ...fnotes, ...enotes, ...footers]) {
    if ((++bn & 255) === 0) clock.check();
    if (b.kind === "row" || b.text.length <= WORD_PAGE_CHARS) { units.push(b); continue; }
    const parts = splitLong(b.text, WORD_PAGE_CHARS);
    parts.forEach((t, i) => units.push({ ...b, text: t, brk: i === 0 ? b.brk : false, heading: i === 0 ? b.heading : undefined, level: i === 0 ? b.level : 0 }));
  }
  const raw = paginate(units, clock);
  const pages = raw.map((p, i) => ({
    page_no: i + 1,
    text: `${p.heading ? `Section: ${p.heading}` : `Part ${i + 1} of ${raw.length}`}\n${p.text}`,
  }));
  if (zip.names.some((n) => /^word\/(embeddings|activeX)\//i.test(n))) notes.push("Embedded objects were not opened; only the document's own text was read.");
  if (zip.names.some((n) => /^word\/media\//i.test(n))) notes.push("Pictures inside the document are not read (text only).");
  return { pages, notes };
}
