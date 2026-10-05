/**
 * CSV / TSV reader (parity with xlsx): decoded text -> rows -> the SAME chunker (sheetChunk.js), so a CSV page looks exactly
 * like a sheet page: header repeated in every chunk, every row labelled with its row number.
 *   - delimiter sniffed from the first records among , ; TAB | (a .tsv prefers TAB);
 *   - quoted cells, doubled quotes, newlines inside quotes, CRLF / LF / CR, BOM (decodeText strips it);
 *   - row numbers count every record (blank lines included) so they match what a spreadsheet shows when the file is opened;
 *   - the same row / column / cell / total-character caps as xlsx; a cell longer than MAX_CELL_CHARS is cut and the page says so.
 */
import { MAX_ROWS_PER_SHEET, MAX_COLS_PER_ROW, MAX_CELLS, MAX_TOTAL_CHARS, MAX_PAGES_PER_FILE } from "./limits.js";
import { OfficeError } from "./errors.js";
import { cleanCell, guessKind, sheetToPages } from "./sheetChunk.js";

const TOO_MANY = (what, limit) => new OfficeError(413, "csv-too-big",
  `This file has more ${what} than DeepWell reads (limit ${limit.toLocaleString("en-US")}). Split it into smaller files and upload again.`);

const DELIMS = [",", ";", "\t", "|"];

/** Per-record delimiter counts (outside quotes) of up to `maxRecords` non-empty records in the first 64 KB. */
function sniffDelimiter(text, ext) {
  const sample = text.slice(0, 65536);
  let best = ",";
  let bestScore = 0;
  for (const d of DELIMS) {
    const counts = [];
    let inQ = false;
    let n = 0;
    let any = false;
    for (let i = 0; i < sample.length && counts.length < 20; i++) {
      const ch = sample[i];
      if (ch === '"') { inQ = !inQ; any = true; }
      else if (!inQ && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && sample[i + 1] === "\n") i++;
        if (any || n) counts.push(n);
        n = 0; any = false;
      } else if (!inQ && ch === d) { n++; any = true; }
      else any = true;
    }
    if (!counts.length) continue;
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0, modeN = 0;
    for (const [c, k] of freq) if (c >= 1 && (k > modeN || (k === modeN && c > mode))) { mode = c; modeN = k; }
    if (!mode) continue;
    const share = modeN / counts.length;
    if (share < 0.6) continue;
    const score = mode * share * (ext === "tsv" && d === "\t" ? 100 : 1);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * @param {string} text decoded file text
 * @param {{name?:string, ext?:string, clock?:{check():void}}} [opts]
 * @returns {{pages:{page_no:number,text:string}[], notes:string[]}}
 */
export function readCsv(text, { name = "Sheet1", ext = "", clock } = {}) {
  const notes = [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = sniffDelimiter(text, ext);
  const n = text.length;
  const rows = [];
  let rowNo = 0;
  let cells = []; // [{c,t,k}]
  let col = 0;
  let totalCells = 0;
  let chars = 0;
  let unbalanced = false;
  let tick = 0;

  const endField = (raw) => {
    const c = col++;
    if (col > MAX_COLS_PER_ROW) throw TOO_MANY("columns", MAX_COLS_PER_ROW);
    if (raw === "") return;
    const t = cleanCell(raw).text;
    if (t === "") return;
    if (++totalCells > MAX_CELLS) throw TOO_MANY("cells", MAX_CELLS);
    chars += t.length;
    if (chars > MAX_TOTAL_CHARS) throw TOO_MANY("text", MAX_TOTAL_CHARS);
    cells.push({ c, t, k: guessKind(t) });
  };
  const endRow = () => {
    rowNo++;
    if (cells.length) {
      if (rows.length >= MAX_ROWS_PER_SHEET) throw TOO_MANY("rows", MAX_ROWS_PER_SHEET);
      rows.push({ n: rowNo, cells });
    }
    cells = [];
    col = 0;
  };

  let i = 0;
  let atRecordStart = true;
  while (i < n) {
    if ((++tick & 4095) === 0) clock?.check();
    let raw;
    if (text.charCodeAt(i) === 34) {
      let j = i + 1;
      let buf = "";
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { buf += text.slice(j); i = n; unbalanced = true; break; }
        buf += text.slice(j, q);
        if (text.charCodeAt(q + 1) === 34) { buf += '"'; j = q + 2; continue; }
        i = q + 1;
        break;
      }
      // anything between the closing quote and the delimiter is kept as written
      let k = i;
      while (k < n) { const ch = text[k]; if (ch === delim || ch === "\n" || ch === "\r") break; k++; }
      raw = buf + text.slice(i, k);
      i = k;
      if (buf.length > MAX_TOTAL_CHARS) throw TOO_MANY("text", MAX_TOTAL_CHARS);
    } else {
      let k = i;
      while (k < n) { const ch = text[k]; if (ch === delim || ch === "\n" || ch === "\r") break; k++; }
      raw = text.slice(i, k);
      i = k;
    }
    endField(raw);
    atRecordStart = false;
    if (i >= n) break;
    const ch = text[i];
    if (ch === delim) { i++; if (i >= n) { endField(""); } continue; }
    // newline
    if (ch === "\r" && text[i + 1] === "\n") i++;
    i++;
    endRow();
    atRecordStart = true;
  }
  if (!atRecordStart || cells.length) endRow();
  if (unbalanced) notes.push("A quoted cell was never closed; the rest of the file was read as that one cell.");

  const base = String(name).replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") || "Sheet1";
  const chunks = sheetToPages({ name: base, hidden: false, rows }, { clock, budget: { chars: 0, pages: 0 } });
  if (chunks.length > MAX_PAGES_PER_FILE) throw TOO_MANY("pages of text", MAX_PAGES_PER_FILE);
  return { pages: chunks.map((t, k) => ({ page_no: k + 1, text: t })), notes };
}
