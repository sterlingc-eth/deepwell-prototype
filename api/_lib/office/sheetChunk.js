/**
 * Shared by .xlsx and CSV/TSV: turn one sheet's rows into "pages" (document_pages rows) that a person and a search can
 * use. THE RENDERING RULES (documented once, here):
 *   - one page-group per sheet; chunks of ~SHEET_CHUNK_CHARS; an empty sheet gives 0 pages;
 *   - every chunk starts with:  Sheet "<name>" rows a-b of n[ (hidden sheet)]
 *       a-b = the first and last ROW NUMBERS (as in the spreadsheet) shown in this chunk, n = the last used row number;
 *   - the header row (found even under a title block) is repeated at the top of EVERY chunk:  Header (row 3): A | B | C
 *   - every data row is rendered with its labels and row number:
 *       Row 12 | Customer: Acme Heating | Invoice: 1043 | Date: 2026-03-04 | Total: $1,250.00
 *     empty cells are skipped; a row is never cut across chunks;
 *   - rows ABOVE the header (a title block, a report date) are shown once, plainly, in the first chunk;
 *   - no header found (e.g. a single column, or no row that looks like labels): cells are labelled "Column A", "Column B".
 * The header is "the first of the first 40 non-empty rows that has at least 2 cells (and at least 60% of the widest of those
 * rows), whose cells are almost all text (not numbers/dates), and whose labels are distinct", so a one-cell title row or a
 * numeric row above it is skipped and a table whose first rows are a title block still gets its real header.
 */
import { SHEET_CHUNK_CHARS, MAX_CELL_CHARS, MAX_TOTAL_CHARS, MAX_PAGES_PER_FILE } from "./limits.js";
import { OfficeError } from "./errors.js";

const MAX_LABEL = 80; // a header label is repeated in front of EVERY cell of every row: bound it so a 30,000-char label cannot multiply
const TOO_MUCH = new OfficeError(413, "sheet-too-big",
  "This sheet produces more text than DeepWell reads from one file once every row is written out with its column labels. Split it into smaller files and upload again.");

export function colLetter(c) {
  let s = "";
  let n = c + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Flatten a cell's text to one line and bound it. Returns {text, cut}. */
export function cleanCell(raw) {
  let s = String(raw);
  let cut = false;
  if (s.length > MAX_CELL_CHARS) { s = s.slice(0, MAX_CELL_CHARS); cut = true; }
  let out = "";
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13) {
      if (!out.endsWith(" / ") && out.length) out += " / ";
      lastSpace = true;
    } else if (c === 9 || c === 32 || c === 0xa0) {
      if (!lastSpace) out += " ";
      lastSpace = true;
    } else if (c < 32 || c === 127) {
      // control characters carry no text
    } else { out += s[i]; lastSpace = false; }
  }
  out = out.trim();
  if (out.endsWith(" /")) out = out.slice(0, -2).trim();
  if (cut) out += " ...[cell cut at 32,767 characters]";
  return { text: out, cut };
}

const NUM_RE = /^[-+(]?[$€£]?[-+]?\d[\d,]*(\.\d+)?%?\)?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4})$/;
/** Kind of a CSV cell, guessed from its text (xlsx supplies real kinds). */
export function guessKind(text) {
  if (NUM_RE.test(text)) return "num";
  if (DATE_RE.test(text)) return "date";
  return "text";
}

function pickHeader(rows) {
  const cand = rows.slice(0, 40);
  let width = 0;
  for (const r of cand) width = Math.max(width, r.cells.length);
  if (width < 2) return -1;
  const need = Math.max(2, Math.ceil(width * 0.6));
  for (let i = 0; i < cand.length; i++) {
    const cells = cand[i].cells;
    if (cells.length < need || i === rows.length - 1) continue;
    let textual = 0;
    const seen = new Set();
    let distinct = true;
    for (const c of cells) {
      if (c.k === "text") textual++;
      const key = c.t.toLowerCase();
      if (seen.has(key)) distinct = false;
      seen.add(key);
    }
    if (textual / cells.length >= 0.8 && distinct) return i;
  }
  return -1;
}

/**
 * @param {{name:string, hidden?:boolean, rows:Array<{n:number, cells:Array<{c:number,t:string,k:string}>}>}} sheet
 *   rows ascending by n, cells ascending by c, empty cells already removed, text already cleaned.
 * @param {{chunkChars?:number, clock?:{check():void}, budget?:{chars:number, pages:number}}} [opts]
 *   budget: ONE object shared by every sheet of a file; the RENDERED text and page count are added to it as each page is
 *   built and the read stops with a clean 413 at MAX_TOTAL_CHARS / MAX_PAGES_PER_FILE (never after the whole sheet).
 *   A row (or one huge cell) longer than a chunk is split into several lines, each with its row number and label.
 * @returns {string[]} one string per page (empty sheet -> [])
 */
export function sheetToPages(sheet, { chunkChars = SHEET_CHUNK_CHARS, clock, budget = { chars: 0, pages: 0 } } = {}) {
  const rows = sheet.rows.filter((r) => r.cells.length > 0);
  if (!rows.length) return [];
  const total = rows[rows.length - 1].n;
  const hIdx = pickHeader(rows);
  const labels = [];
  if (hIdx >= 0) {
    for (const c of rows[hIdx].cells) labels[c.c] = c.t.length > MAX_LABEL ? c.t.slice(0, MAX_LABEL) + "..." : c.t;
  }
  const labelFor = (c) => labels[c] || `Column ${colLetter(c)}`;
  const clip = (t, n) => (t.length > n ? t.slice(0, n) + " ..." : t);
  const headerLine = hIdx >= 0
    ? clip(`Header (row ${rows[hIdx].n}): ${rows[hIdx].cells.map((c) => labels[c.c]).join(" | ")}`, 3000)
    : "";
  const title = [];
  for (let i = 0; i < (hIdx >= 0 ? hIdx : 0); i++) {
    title.push(clip(`Row ${rows[i].n} | ${rows[i].cells.map((c) => c.t).join(" | ")}`, 3000));
  }
  const body = hIdx >= 0 ? rows.slice(hIdx + 1) : rows;
  // One row -> one line, or several lines when the row is longer than a chunk (cells grouped; a cell longer than a chunk cut
  // into pieces). Every piece keeps "Row n | " and the cell's label, so it still reads on its own.
  const maxLine = Math.max(500, chunkChars - 400);
  const renderRow = (r) => {
    const parts = [];
    for (const c of r.cells) {
      const lab = labelFor(c.c);
      const room = Math.max(100, maxLine - lab.length - 30);
      if (c.t.length <= room) parts.push(`${lab}: ${c.t}`);
      else for (let i = 0; i < c.t.length; i += room) parts.push(`${lab}${i ? " (continued)" : ""}: ${c.t.slice(i, i + room)}`);
    }
    const lines = [];
    let cur = "";
    for (const part of parts) {
      if (cur && cur.length + part.length + 3 > maxLine) { lines.push(`Row ${r.n} | ${cur}`); cur = ""; }
      cur += (cur ? " | " : "") + part;
    }
    if (cur) lines.push(`Row ${r.n} | ${cur}`);
    return lines;
  };
  const sheetName = String(sheet.name).replace(/"/g, "'");
  const mkTop = (a, b) => `Sheet "${sheetName}" rows ${a}-${b} of ${total}${sheet.hidden ? " (hidden sheet)" : ""}`;

  const pages = [];
  let cur = []; // body row lines of the chunk being built
  let curFirst = 0;
  let curLast = 0;
  let size = 0;
  let first = true;
  const flush = () => {
    if (!cur.length && !(first && (title.length || headerLine))) return;
    const lines = [];
    const a = first && title.length ? rows[0].n : curFirst;
    const b = cur.length ? curLast : rows[Math.max(0, hIdx)].n;
    lines.push(mkTop(a, Math.max(a, b)));
    if (first) lines.push(...title);
    if (headerLine) lines.push(headerLine);
    lines.push(...cur);
    const pageText = lines.join("\n");
    budget.chars += pageText.length;
    if (++budget.pages > MAX_PAGES_PER_FILE || budget.chars > MAX_TOTAL_CHARS) throw TOO_MUCH;
    pages.push(pageText);
    first = false;
    cur = [];
    size = 0;
  };
  const baseCost = () => 90 + headerLine.length + (first ? title.reduce((s, l) => s + l.length + 1, 0) : 0);
  let k = 0;
  for (const r of body) {
    if ((++k & 255) === 0) clock?.check();
    for (const line of renderRow(r)) {
      if (cur.length && baseCost() + size + line.length + 1 > chunkChars) flush();
      if (!cur.length) curFirst = r.n;
      cur.push(line);
      curLast = r.n;
      size += line.length + 1;
    }
  }
  flush();
  return pages;
}
