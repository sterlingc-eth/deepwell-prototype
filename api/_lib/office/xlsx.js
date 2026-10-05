/**
 * .xlsx reader. Reads CACHED values only: a formula cell shows the value Excel last saved (nothing is evaluated, no
 * external link / data connection / DDE / macro is followed or run). Hidden and very hidden sheets ARE read and marked.
 *
 * MERGED CELLS (the rule): the value lives in the top-left cell. A merge spanning several COLUMNS of one row is not
 * repeated across the row (no horizontal duplicates). A merge spanning several ROWS is a group label: its value is also
 * attached to the FIRST column of every covered row that has content, so each row carries its group ("Region: North")
 * when read on its own. Rows with no content are not created. Fill work is counted against the cell cap.
 *
 * Rendering (labels, row numbers, header detection, chunking) is in sheetChunk.js, shared with CSV.
 */
import {
  MAX_SHEETS, MAX_ROWS_PER_SHEET, MAX_CELLS, MAX_COLS_PER_ROW, MAX_TOTAL_CHARS, MAX_PAGES_PER_FILE, MAX_ZIP_ENTRY_INFLATED,
} from "./limits.js";
import { OfficeError } from "./errors.js";
import { parseXml, xmlBytesToString } from "./xml.js";
import { readRels, resolveTarget, mustRead } from "./pkg.js";
import { formatForId, formatNumeric, generalNumber, parseFormat } from "./numfmt.js";
import { cleanCell, sheetToPages } from "./sheetChunk.js";

const TOO_MANY = (what, limit) => new OfficeError(413, "xlsx-too-big",
  `This workbook has more ${what} than DeepWell reads (limit ${limit.toLocaleString("en-US")}). Split it into smaller files (or remove unused ${what}) and upload again.`);

const MAX_ROW_NUMBER = 1048576;

/** "AB12" -> {c: 27, r: 12}; null when it is not a cell reference. Plain char loop. */
export function parseRef(ref) {
  if (typeof ref !== "string") return null;
  let i = 0;
  let c = 0;
  while (i < ref.length) {
    const ch = ref.charCodeAt(i);
    if (ch >= 65 && ch <= 90) c = c * 26 + (ch - 64);
    else if (ch >= 97 && ch <= 122) c = c * 26 + (ch - 96);
    else break;
    i++;
    if (i > 3) return null;
  }
  if (!c || i === ref.length) return null;
  let r = 0;
  for (; i < ref.length; i++) {
    const d = ref.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return null;
    r = r * 10 + d;
    if (r > MAX_ROW_NUMBER) return null;
  }
  return r ? { c: c - 1, r } : null;
}

function readSharedStrings(zip, path, clock, budget) {
  const out = [];
  if (!path || !zip.has(path)) return out;
  let cur = null;
  let inT = false;
  let phDepth = 0;
  parseXml(xmlBytesToString(zip.read(path)), {
    clock,
    onOpen(name) {
      if (name === "si") cur = "";
      else if (name === "rPh") phDepth++;
      else if (name === "t") inT = true;
    },
    onClose(name) {
      if (name === "t") inT = false;
      else if (name === "rPh") phDepth--;
      else if (name === "si") {
        if (out.length >= MAX_CELLS) throw TOO_MANY("distinct text values", MAX_CELLS);
        budget.add(cur.length);
        out.push(cur); cur = null;
      }
    },
    onText(t) { if (inT && cur !== null && phDepth === 0) { cur += t; if (cur.length > MAX_ZIP_ENTRY_INFLATED) throw TOO_MANY("text", MAX_TOTAL_CHARS); } },
  });
  return out;
}

function readStyles(zip, path, clock) {
  const custom = new Map();
  const xfs = [];
  if (!path || !zip.has(path)) return { custom, xfs };
  let inCellXfs = false;
  parseXml(xmlBytesToString(zip.read(path)), {
    clock,
    onOpen(name, a) {
      if (name === "numFmt" && a.numFmtId !== undefined && a.formatCode !== undefined) custom.set(Number(a.numFmtId), a.formatCode);
      else if (name === "cellXfs") inCellXfs = true;
      else if (name === "xf" && inCellXfs) xfs.push(Number(a.numFmtId ?? 0) || 0);
    },
    onClose(name) { if (name === "cellXfs") inCellXfs = false; },
  });
  return { custom, xfs };
}

function makeBudget() {
  let chars = 0;
  return { add(n) { chars += n; if (chars > MAX_TOTAL_CHARS) throw TOO_MANY("text", MAX_TOTAL_CHARS); }, get chars() { return chars; } };
}

/**
 * @param {{read(name:string, cap?:number):Buffer, has(name:string):boolean, names:string[]}} zip
 * @returns {{pages: {page_no:number, text:string}[], notes: string[]}}
 */
export function readXlsx(zip, { clock }) {
  const notes = [];
  const budget = makeBudget();
  // --- workbook: sheet list, date system
  const rels = readRels(zip, "xl/_rels/workbook.xml.rels", clock);
  const relById = new Map(rels.map((r) => [r.id, r]));
  const sheets = [];
  let date1904 = false;
  parseXml(xmlBytesToString(mustRead(zip, "xl/workbook.xml", 8 * 1024 * 1024)), {
    clock,
    onOpen(name, a) {
      if (name === "workbookPr") date1904 = a.date1904 === "1" || a.date1904 === "true";
      else if (name === "sheet") {
        if (sheets.length >= MAX_SHEETS) throw TOO_MANY("sheets", MAX_SHEETS);
        sheets.push({ name: String(a.name ?? `Sheet${sheets.length + 1}`).slice(0, 128), state: a.state ?? "visible", rid: a.id });
      }
    },
  });
  const typeEnd = (r, t) => r.type.endsWith("/" + t);
  const sstRel = rels.find((r) => typeEnd(r, "sharedStrings") && !r.external);
  const styRel = rels.find((r) => typeEnd(r, "styles") && !r.external);
  const sst = readSharedStrings(zip, sstRel ? resolveTarget("xl/", sstRel.target) : "xl/sharedStrings.xml", clock, budget);
  const { custom, xfs } = readStyles(zip, styRel ? resolveTarget("xl/", styRel.target) : "xl/styles.xml", clock);
  const xfFmt = new Map();
  const fmtOf = (s) => {
    let f = xfFmt.get(s);
    if (!f) { f = formatForId(xfs[s] ?? 0, custom); xfFmt.set(s, f); }
    return f;
  };
  const sstClean = new Array(sst.length);

  const pages = [];
  const renderBudget = { chars: 0, pages: 0 };
  let totalCells = 0;
  let sawFormula = false;
  const hiddenNames = [];
  for (const sh of sheets) {
    const rel = relById.get(sh.rid);
    if (!rel || rel.external) continue; // a sheet whose target is not inside the package is never followed
    if (!/\/worksheet$/.test(rel.type)) continue; // chart sheets / dialog sheets / macro sheets hold no cells we read
    const path = resolveTarget("xl/", rel.target);
    if (!path || !zip.has(path)) throw new OfficeError(422, "bad-package", "This workbook points at a sheet that is not in the file, so it is damaged. Re-save it from Excel and upload again.");
    const hidden = sh.state === "hidden" || sh.state === "veryHidden";
    if (hidden) hiddenNames.push(sh.name);

    const rowMap = new Map();
    const merges = [];
    let rowNo = 0;
    let curRow = null;
    let nextCol = 0;
    let cell = null;
    let inV = false, inIs = false, inT = false, inF = false, phDepth = 0;
    let vbuf = "", isbuf = "";
    parseXml(xmlBytesToString(zip.read(path)), {
      clock,
      onOpen(name, a) {
        if (name === "row") {
          const r = a.r !== undefined ? Number(a.r) : rowNo + 1;
          if (!Number.isInteger(r) || r < 1 || r > MAX_ROW_NUMBER) throw new OfficeError(422, "bad-xlsx", "This workbook has an invalid row number, so it is damaged. Re-save it from Excel and upload again.");
          rowNo = r;
          curRow = rowMap.get(r);
          if (!curRow) {
            if (rowMap.size >= MAX_ROWS_PER_SHEET) throw TOO_MANY("rows in one sheet", MAX_ROWS_PER_SHEET);
            curRow = { n: r, cells: new Map() };
            rowMap.set(r, curRow);
          }
          nextCol = 0;
        } else if (name === "c") {
          const ref = a.r !== undefined ? parseRef(a.r) : null;
          const col = ref ? ref.c : nextCol;
          if (col >= MAX_COLS_PER_ROW) throw TOO_MANY("columns", MAX_COLS_PER_ROW);
          nextCol = col + 1;
          cell = { col, t: a.t ?? "n", s: a.s !== undefined ? Number(a.s) : 0 };
          vbuf = ""; isbuf = "";
        } else if (name === "v") inV = true;
        else if (name === "is") inIs = true;
        else if (name === "rPh") phDepth++;
        else if (name === "t" && inIs) inT = true;
        else if (name === "f") { inF = true; sawFormula = true; }
        else if (name === "mergeCell" && a.ref) {
          const [x, y] = String(a.ref).split(":");
          const p1 = parseRef(x), p2 = parseRef(y ?? x);
          if (p1 && p2 && p2.r > p1.r) merges.push({ r1: p1.r, r2: p2.r, c: Math.min(p1.c, p2.c) });
        }
      },
      onClose(name) {
        if (name === "v") inV = false;
        else if (name === "is") inIs = false;
        else if (name === "t") inT = false;
        else if (name === "rPh") phDepth--;
        else if (name === "f") inF = false;
        else if (name === "c" && cell && curRow) {
          const out = renderCell(cell, vbuf, isbuf);
          cell = null;
          if (out) {
            if (++totalCells > MAX_CELLS) throw TOO_MANY("cells", MAX_CELLS);
            budget.add(out.t.length);
            curRow.cells.set(out.c, out);
          }
        } else if (name === "row") curRow = null;
      },
      onText(t) {
        if (inV) { vbuf += t; if (vbuf.length > MAX_ZIP_ENTRY_INFLATED) throw TOO_MANY("text", MAX_TOTAL_CHARS); }
        else if (inT && phDepth === 0 && inIs) { isbuf += t; if (isbuf.length > MAX_ZIP_ENTRY_INFLATED) throw TOO_MANY("text", MAX_TOTAL_CHARS); }
        else if (inF) { /* formula text is never read */ }
      },
    });

    function renderCell(c, v, is) {
      let text = "";
      let kind = "text";
      switch (c.t) {
        case "s": {
          const idx = Number(v);
          if (!Number.isInteger(idx) || idx < 0 || idx >= sst.length) return null;
          const cached = sstClean[idx] ?? (sstClean[idx] = cleanCell(sst[idx]));
          text = cached.text;
          break;
        }
        case "inlineStr": text = cleanCell(is).text; break;
        case "str": text = cleanCell(v).text; break;
        case "b": text = v.trim() === "1" || v.trim().toLowerCase() === "true" ? "TRUE" : "FALSE"; kind = "bool"; break;
        case "e": text = cleanCell(v).text; kind = "err"; break;
        case "d": text = cleanCell(v).text; kind = "date"; break;
        default: {
          const raw = v.trim();
          if (raw === "") return null;
          const num = Number(raw);
          if (!Number.isFinite(num)) { text = cleanCell(raw).text; break; }
          const r = formatNumeric(num, fmtOf(c.s), date1904);
          text = r.text; kind = r.kind;
        }
      }
      if (text === "") return null;
      return { c: c.col, t: text, k: kind };
    }

    // merged group labels (see header)
    if (merges.length) {
      const sorted = [...rowMap.values()].sort((a, b) => a.n - b.n);
      let work = 0;
      for (const m of merges) {
        const top = rowMap.get(m.r1)?.cells.get(m.c);
        if (!top) continue;
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].n <= m.r1) lo = mid + 1; else hi = mid; }
        for (let i = lo; i < sorted.length && sorted[i].n <= m.r2; i++) {
          if ((++work & 1023) === 0) clock.check();
          if (!sorted[i].cells.has(m.c) && sorted[i].cells.size > 0) {
            if (++totalCells > MAX_CELLS) throw TOO_MANY("cells", MAX_CELLS);
            budget.add(top.t.length);
            sorted[i].cells.set(m.c, { c: m.c, t: top.t, k: top.k });
          }
        }
      }
    }

    const rows = [...rowMap.values()].sort((a, b) => a.n - b.n)
      .map((r) => ({ n: r.n, cells: [...r.cells.values()].sort((a, b) => a.c - b.c) }));
    const chunks = sheetToPages({ name: sh.name, hidden, rows }, { clock, budget: renderBudget });
    for (const text of chunks) {
      if (pages.length >= MAX_PAGES_PER_FILE) throw TOO_MANY("pages of text", MAX_PAGES_PER_FILE);
      pages.push({ page_no: pages.length + 1, text });
    }
  }
  if (hiddenNames.length) notes.push(`Hidden sheet(s) were read and marked: ${hiddenNames.join(", ")}.`);
  if (sawFormula) notes.push("Formula cells show the value Excel last saved; nothing is recalculated.");
  if (zip.names.some((n) => n.startsWith("xl/externalLinks/"))) notes.push("Links to other workbooks were not followed.");
  void generalNumber; void parseFormat;
  return { pages, notes };
}
