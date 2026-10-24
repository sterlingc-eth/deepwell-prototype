/**
 * Tables lane (2026-10-24): a free, anchored-stream reader for LINE-ITEM TABLES (invoice / receipt / work-order lines,
 * rent rolls, pay-application schedules of values). No model, no OCR engine of its own, no dependency.
 *
 * WHY: "which invoices had 3 capacitors", "what did we pay for the filter driers", "rent roll total for unit 105" need the
 * ROWS, not only the document total. Rows are where a reader silently goes wrong (a column shifted, a digit dropped, a row
 * lost), so this reader's rule is: a row becomes a fact ONLY if the arithmetic printed on the page agrees with it.
 *
 * HOW (anchored stream):
 *   1. Lines: from `page.lines` (cells with x positions, built from the PDF text layer's word runs: see pdfText.js
 *      `layoutLines`) when present - mode "x" - else from the page text, splitting a line into cells on 2+ spaces (the text
 *      reader and the OCR transcription both put 3 spaces between columns) - mode "order".
 *   2. Header row: a line of header words (description / qty / unit price / amount; scheduled value / this period; sq ft /
 *      monthly rent ...) followed by lines that carry numbers. Its cells are the column anchors.
 *   3. Rows: each following line with a label and numbers is assigned to the header columns - by x position (right edge,
 *      nearest anchor; blanks allowed) in mode "x", by order (the count must equal the header's numeric columns) in mode "order".
 *   4. Totals block: Subtotal / Shipping / Discount / Tax / Total lines (or a TOTAL row carrying a sum per column).
 *   5. Arithmetic, nothing else decides: qty x unit = amount (1 cent), previous + this period = completed, scheduled -
 *      completed = balance; sum of the rows = the printed subtotal (2 cents), or rows + tax + shipping - discount = the
 *      printed total; rows + extras = grand total. A row that fails is quarantined. When the table does not add up and one
 *      failing row explains the gap, only that row is quarantined; otherwise the whole table is (never stored as facts).
 *   Every row carries its page and the exact line it was read from (`quote`).
 *
 * Pure: pages in, {tables, rows (verified), quarantined, totals} out. Never throws. Behind TABLE_ROWS_READER=1 where the
 * app uses it (switches.js isTableRowsReaderEnabled), default OFF.
 */

const NUM_RE = /^\(?-?\$?\s?\d[\d,]*(?:\.\d+)?\)?-?$/;
const UNIT_SUFFIX = /^(\d[\d,]*(?:\.\d+)?)\s*(?:ea|each|hrs?|hours?|pcs?|lf|sf|ft|gal|sq\s*ft)\.?$/i;

/** Header vocabulary. role: label | qty | unit | amount | num (other numeric column). */
const HEADER_WORDS = [
  [/^(description|desc\.?|item|items|service|services|part|parts|part\s*\/\s*description|labor description|description of work|work performed|particulars|product|products|details|material|materials|tenant|tenant name|name|unit|suite|unit\s*#|space|no\.?|#|sku|part\s*#|code)$/i, 'label'],
  [/^(qty\.?|quantity|qnty|ct\.?|hours|hrs\.?|units|count|qty\s*\/\s*hrs?)$/i, 'qty'],
  [/^(unit\s*price|price|rate|unit\s*cost|each|unit\s*rate|cost\s*each|ea\.?|price\s*each)$/i, 'unit'],
  [/^(amount|total|line\s*total|ext\.?|extended|ext\.?\s*(?:price|cost|amount)|extended\s*(?:price|cost|amount)|extension|charge|line\s*amount)$/i, 'amount'],
  [/^(scheduled\s*value|previous(?:\s*application)?|previous\s*billed|this\s*period|completed|total\s*completed|completed\s*(?:&|and)\s*stored|stored|balance|balance\s*to\s*finish|retainage|%|%\s*complete|sq\.?\s*ft\.?|sqft|area|monthly\s*rent|rent|past\s*due|balance\s*due|tax|taxable|uom|due)$/i, 'num'],
];
const headerRole = (t) => { const s = String(t).trim(); for (const [re, role] of HEADER_WORDS) if (re.test(s)) return role; return null; };

/** Totals-block labels. kind: subtotal | tax | ship | discount | total | other (stops the table, not part of the equation). */
function totalsKind(label) {
  const s = String(label ?? '').trim().replace(/[:.]+$/, '').toLowerCase();
  if (!s) return null;
  if (/^(sub[\s-]?total|[a-z]+ sub[\s-]?total|(?:parts|labou?r|materials?|equipment|services?|items?|merchandise|goods)\s+total)$/.test(s)) return 'subtotal';
  if (/^(sales\s+)?tax\b|^(vat|gst|tpt|use\s+tax)\b/.test(s)) return 'tax';
  if (/^(shipping|freight|delivery|handling|trip\s+charge|fuel\s+surcharge)\b/.test(s)) return 'ship';
  if (/^(discount|less\s+discount|promo|promotion|coupon)\b/.test(s)) return 'discount';
  if (/^(total|total\s+due|grand\s+total|amount\s+due|total\s+amount|invoice\s+total|total\s+amount\s+due|totals?|please\s+pay|pay\s+this\s+amount|amount\s+payable|total\s+payable|net\s+due|total\s+invoice)$/.test(s)) return 'total';
  if (/^(balance(\s+due)?|amount\s+paid|deposit|deposit\s+received|payment|payments|paid|less\s+payments?|previous\s+balance|retainage|credit)\b/.test(s)) return 'other';
  return null;
}

const isNumCell = (t) => { const s = String(t).trim(); return NUM_RE.test(s) || UNIT_SUFFIX.test(s); };
const isMoneyText = (t) => { const s = String(t).trim(); return /\$/.test(s) || /\.\d{2}\)?-?$/.test(s); };
function toNumber(t) {
  let s = String(t).trim(); let neg = false;
  const um = UNIT_SUFFIX.exec(s); if (um) s = um[1];
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (/^-/.test(s)) { neg = true; s = s.slice(1); }
  s = s.replace(/[$\s]/g, '');
  if (/,/.test(s) && !/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s)) return null; // "1,2,3" and the like are not an amount
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
const cents = (n) => Math.round(n * 100);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ------------------------------------------------------------------ lines and cells */
function cellsFromText(text) {
  const out = [];
  const re = /\S+(?: \S+)*/g; let m;
  const s = String(text).replace(/\t/g, '   ');
  while ((m = re.exec(s))) out.push({ t: m[0], x: m.index, x2: m.index + m[0].length });
  return out;
}

function toLines(pages) {
  const lines = [];
  for (const p of pages ?? []) {
    if (Array.isArray(p?.lines) && p.lines.length) {
      for (const l of p.lines) lines.push({ page: p.page_no ?? 1, text: l.text, cells: l.cells, mode: 'x', cw: l.cw ?? 5 });
      lines.push({ page: p.page_no ?? 1, text: '', cells: [], mode: 'x', cw: 5, pageEnd: true });
    } else {
      for (const raw of String(p?.text ?? '').split(/\r?\n/)) {
        const text = raw.replace(/\s+$/, '');
        lines.push({ page: p.page_no ?? 1, text, cells: text.trim() ? cellsFromText(text) : [], mode: 'order', cw: 1 });
      }
      lines.push({ page: p.page_no ?? 1, text: '', cells: [], mode: 'order', cw: 1, pageEnd: true });
    }
  }
  return lines;
}

/** A header cell that holds several header words ("Qty Unit Price Amount" with single spaces) is split on the vocabulary. */
function splitHeaderCell(c) {
  if (headerRole(c.t)) return [c];
  const words = c.t.split(/\s+/);
  if (words.length < 2) return [c];
  const out = []; let i = 0;
  while (i < words.length) {
    let hit = null;
    for (let j = Math.min(words.length, i + 4); j > i; j--) { const ph = words.slice(i, j).join(' '); if (headerRole(ph)) { hit = [ph, j]; break; } }
    if (!hit) return [c];
    out.push({ t: hit[0], x: c.x + Math.round((c.x2 - c.x) * (i / words.length)), x2: c.x + Math.round((c.x2 - c.x) * (hit[1] / words.length)) });
    i = hit[1];
  }
  return out;
}

function headerOf(line) {
  if (!line.cells.length) return null;
  let cells = line.cells.flatMap(splitHeaderCell);
  if (cells.length < 2 || cells.some((c) => isNumCell(c.t) || /\d{2,}/.test(c.t))) return null;
  const known = cells.filter((c) => headerRole(c.t));
  if (known.length < Math.min(2, cells.length) || known.length < cells.length / 2) return null;
  const cols = cells.map((c) => ({ name: c.t.trim(), role: headerRole(c.t) ?? 'label', x: c.x, x2: c.x2 }));
  // an exact "Unit" header is a label column (rent roll "Unit"), "Unit Price" a price: headerRole already separates them
  if (!cols.some((c) => c.role !== 'label')) return null;
  return cols;
}

/** Is `line` a candidate row for header `cols`? Returns its cells (trailing numbers split off a merged cell) or null. */
function rowCells(line, cols) {
  const cells = [];
  for (const c of line.cells) {
    // "1 501.44" (quantity and rate with a single space): a cell made only of numbers is several cells
    const toks = c.t.split(/\s+/);
    if (toks.length > 1 && !isNumCell(c.t) && toks.every((t) => isNumCell(t))) {
      const w = (c.x2 - c.x) / c.t.length; let off = c.x;
      for (const t of toks) { cells.push({ t, x: off, x2: off + t.length * w }); off += (t.length + 1) * w; }
    } else cells.push({ ...c });
  }
  if (!cells.length) return null;
  const numCols = cols.filter((c) => c.role !== 'label').length;
  let numeric = cells.filter((c) => isNumCell(c.t)).length;
  const last = cells[cells.length - 1];
  if (numeric < numCols && last && !isNumCell(last.t)) {
    // numbers merged into the label cell ("Pad 36 x 36 composite 3 $41.00 $123.00"): split exactly the missing count off its end
    const toks = last.t.split(/\s+/); let k = 0;
    while (k < toks.length - 1 && isNumCell(toks[toks.length - 1 - k])) k++;
    const need = numCols - numeric;
    if (k >= need && toks.length - need >= 1) {
      const body = toks.slice(0, toks.length - need).join(' ');
      const tail = toks.slice(toks.length - need);
      const w = (last.x2 - last.x) / last.t.length; let off = last.x + body.length * w;
      cells.pop(); cells.push({ t: body, x: last.x, x2: last.x + body.length * w });
      for (const t of tail) { off += w; cells.push({ t, x: off, x2: off + t.length * w }); off += t.length * w; }
      numeric = numCols;
    }
  }
  const lastCell = cells[cells.length - 1];
  if (!lastCell || !isNumCell(lastCell.t) || numeric < 1 || !cells.some((c) => !isNumCell(c.t))) return null;
  return cells;
}

/* ------------------------------------------------------------------ row assignment */
function assignRow(cells, cols, mode, anchors) {
  const numColIdx = cols.map((c, i) => (c.role !== 'label' ? i : -1)).filter((i) => i >= 0);
  const labelColIdx = cols.map((c, i) => (c.role === 'label' ? i : -1)).filter((i) => i >= 0);
  const textCells = cells.filter((c) => !isNumCell(c.t));
  const numCells = cells.filter((c) => isNumCell(c.t));
  // numbers that sit inside the label area (a unit number "101" before the tenant name) belong to the label
  const labelParts = [];
  const nums = [];
  for (const c of cells) {
    if (!isNumCell(c.t)) { labelParts.push(c); continue; }
    nums.push(c);
  }
  // leading numeric cells beyond the numeric-column count are label text ("101   Sample Cactus Cafe   1,200 ...")
  while (nums.length > numColIdx.length) {
    const first = nums[0];
    if (textCells.length && cells.indexOf(first) < cells.indexOf(textCells[0])) { labelParts.push(nums.shift()); } else break;
  }
  if (nums.length > numColIdx.length) return { error: 'extra_cells' };
  labelParts.sort((a, b) => a.x - b.x);
  const values = new Array(numColIdx.length).fill(null);
  const raw = new Array(numColIdx.length).fill(null);
  if (nums.length === numColIdx.length) {
    nums.forEach((c, i) => { values[i] = c; });
  } else {
    if (mode !== 'x') return { error: 'blank_cell' }; // order alone cannot say WHICH column is blank
    // x mode: each number goes to the nearest anchor by right edge, one per column, in order
    let prev = -1;
    for (const c of nums) {
      let best = -1, bd = Infinity, second = Infinity;
      numColIdx.forEach((ci, k) => { const a = anchors[ci]; const d = Math.abs(c.x2 - a.r); if (d < bd) { second = bd; bd = d; best = k; } else if (d < second) second = d; });
      if (best <= prev || values[best] || bd > (anchors[numColIdx[best]].tol) || second < bd * 1.6) return { error: 'ambiguous_columns' };
      values[best] = c; prev = best;
    }
  }
  for (let i = 0; i < values.length; i++) raw[i] = values[i] ? values[i].t : null;
  // x mode with full row: still confirm each number is near its column (a shifted column is quarantined, not trusted)
  if (mode === 'x') {
    for (let i = 0; i < values.length; i++) { const c = values[i]; if (!c) continue; const a = anchors[numColIdx[i]]; if (Math.abs(c.x2 - a.r) > a.tol) return { error: 'off_column' }; }
  }
  return { label: labelParts.map((c) => c.t).join(' ').replace(/\s+/g, ' ').trim(), raw, numColIdx };
}

/* ------------------------------------------------------------------ the reader */
const within = (a, b, c = 2) => Math.abs(cents(a) - cents(b)) <= c;
// TABLES1 verify patch: a whole-number quantity times a 2-decimal price is EXACT in cents, so such a row gets NO rounding allowance
// (the 1-cent allowance let a misread last digit, 12.25 x 1 = 12.26, through as a verified row).
const decimalsOf = (n) => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const rowIsExact = (r) => r.qty == null || r.unit_price == null || (Number.isInteger(r.qty) && decimalsOf(r.unit_price) <= 2);

/**
 * @param {{page_no:number,text?:string,lines?:object[]}[]} pages
 * @returns {{tables:object[], rows:object[], quarantined:object[], totals:object, documentVerified:boolean, reason:string|null}}
 */
export function readTables(pages) {
  const out = { tables: [], rows: [], quarantined: [], totals: {}, documentVerified: false, reason: null };
  try {
    const lines = toLines(pages);
    // ---- segment into tables
    const tables = []; let cur = null; let pendingStray = null;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line.cells.length) { if (line.pageEnd) pendingStray = null; continue; }
      const hdr = headerOf(line);
      if (hdr) {
        // a header needs numbers right below it (skip 1-2 blank lines), else it is just words in a heading
        let ok = false;
        for (let j = li + 1, seen = 0; j < lines.length && seen < 3; j++) { if (!lines[j].cells.length) { seen++; continue; } ok = !!rowCells(lines[j], hdr); break; }
        if (ok) {
          const prev = tables[tables.length - 1];
          const same = prev && prev.block.length === 0 && prev.cols.length === hdr.length && prev.cols.every((c, i) => norm(c.name) === norm(hdr[i].name));
          if (same) { cur = prev; cur.repeat = (cur.repeat ?? 0) + 1; }
          else { cur = { cols: hdr, mode: line.mode, cw: line.cw, headerLine: line, items: [], block: [], page: line.page, cellsPages: new Set([line.page]) }; tables.push(cur); }
          pendingStray = null; continue;
        }
      }
      if (!cur) continue;
      const first = line.cells[0];
      // totals-block line: label (first cell or the cell before the last number) + amount
      const lastCell = line.cells[line.cells.length - 1];
      const labelCell = line.cells.length >= 2 && isNumCell(lastCell.t) ? line.cells.filter((c) => !isNumCell(c.t)).pop() : (line.cells.length === 1 ? first : null);
      const tk = labelCell ? totalsKind(labelCell.t) : null;
      const nNums = line.cells.filter((c) => isNumCell(c.t)).length;
      if (tk && (nNums <= 1 || tk === 'total')) {
        const nums = line.cells.filter((c) => isNumCell(c.t));
        // a totals line with a number glued to its label ("Sales Tax (8.6%)   $94.14") is a cell pair; "Total $5.00" one cell
        let numTok = nums;
        if (!nums.length && line.cells.length === 1) { const m = /^(.*?)\s+(\(?-?\$?\d[\d,]*\.\d{2}\)?-?)$/.exec(first.t); if (m) numTok = [{ t: m[2], x: first.x2, x2: first.x2 }]; }
        if (numTok.length) { cur.block.push({ kind: tk, label: labelCell.t, nums: numTok, line, tail: !!cur.block.length }); pendingStray = null; continue; }
      }
      const cells = rowCells(line, cur.cols);
      if (cells && !cur.block.length) {
        if (pendingStray) { const prevRow = cur.items[cur.items.length - 1]; if (prevRow) prevRow.wrapSuspect = true; }
        pendingStray = null; cur.items.push({ line, cells }); continue;
      }
      if (cells && cur.block.length) {
        if (nNums <= 1 && line.cells.length === 2) { cur.block.push({ kind: 'other', label: line.cells[0].t, nums: [line.cells[1]], line, unknown: true }); continue; }
        cur.rowsAfterTotals = true; cur.items.push({ line, cells, afterTotals: true }); continue;
      }
      if (!cur.block.length && cur.items.length) pendingStray = line;
    }

    // ---- read rows per table
    const allVerified = [];
    for (const t of tables) {
      // A header the OCR garbled ("Unit Price pean   i __ Amount") loses numeric columns. In order mode only, when the rows
      // all carry 3 trailing numbers, read them as qty / unit price / amount - and let qty x unit = amount PROVE that guess
      // (a table whose rows do not all satisfy it is quarantined, see `inferred` below).
      t.inferred = false;
      if (t.mode === 'order' && t.cols.some((c) => !headerRole(c.name))) {
        const counts = {};
        for (const it of t.items) { let n = 0; for (let k = it.cells.length - 1; k >= 0 && isNumCell(it.cells[k].t); k--) n++; counts[n] = (counts[n] ?? 0) + 1; }
        const mode = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
        const numCols = t.cols.filter((c) => c.role !== 'label').length;
        if (mode === 3 && numCols !== 3 && t.cols.some((c) => c.role === 'amount') && (counts[3] ?? 0) >= 0.8 * t.items.length) {
          t.cols = [{ name: t.cols[0].name, role: 'label', x: 0, x2: 0 }, { name: '(qty)', role: 'qty', x: 0, x2: 0 }, { name: '(unit price)', role: 'unit', x: 0, x2: 0 }, { name: '(amount)', role: 'amount', x: 0, x2: 0 }];
          t.inferred = true;
        }
      }
      const numIdx = t.cols.map((c, i) => (c.role !== 'label' ? i : -1)).filter((i) => i >= 0);
      const anchors = {};
      if (t.mode === 'x') {
        // cluster the data cells' right edges under each header: the anchor is the median of the cells that fall nearest it
        const tolBase = Math.max(2.5 * t.cw, 12);
        for (const ci of numIdx) anchors[ci] = { r: t.cols[ci].x2, tol: tolBase };
        for (let pass = 0; pass < 2; pass++) {
          for (const ci of numIdx) {
            const hits = [];
            for (const it of t.items) for (const c of it.cells) if (isNumCell(c.t) && Math.abs(c.x2 - anchors[ci].r) <= tolBase * 1.5 && numIdx.every((o) => o === ci || Math.abs(c.x2 - anchors[o].r) > Math.abs(c.x2 - anchors[ci].r) - 0.01)) hits.push(c.x2);
            if (hits.length >= 2) { hits.sort((a, b) => a - b); anchors[ci] = { r: hits[hits.length >> 1], tol: tolBase }; }
          }
        }
      }
      const rows = []; const bad = [];
      for (const it of t.items) {
        if (it.afterTotals) { bad.push({ page: it.line.page, quote: it.line.text.trim(), reason: 'row_after_totals' }); continue; }
        const a = assignRow(it.cells, t.cols, t.mode, anchors);
        if (a.error) { bad.push({ page: it.line.page, quote: it.line.text.trim(), reason: a.error }); continue; }
        if (!a.label) { bad.push({ page: it.line.page, quote: it.line.text.trim(), reason: 'no_label' }); continue; }
        const vals = a.raw.map((r) => (r == null ? null : toNumber(r)));
        if (vals.some((v, i) => a.raw[i] != null && v == null)) { bad.push({ page: it.line.page, quote: it.line.text.trim(), reason: 'unreadable_number' }); continue; }
        if (it.wrapSuspect) { bad.push({ page: it.line.page, quote: it.line.text.trim(), reason: 'wrapped_description_suspect' }); continue; }
        const row = { page: it.line.page, label: a.label, values: vals, names: numIdx.map((i) => t.cols[i].name), roles: numIdx.map((i) => t.cols[i].role), quote: it.line.text.trim() };
        const at = (role) => { const k = row.roles.indexOf(role); return k >= 0 ? vals[k] : undefined; };
        row.qty = at('qty'); row.unit_price = at('unit'); row.amount = at('amount');
        // an amount printed with 3+ decimals ("1.250") is a European thousands separator or a misread, never cents
        const amountRaw = a.raw[row.roles.indexOf('amount')];
        if (amountRaw != null && /\.\d{3,}\)?-?$/.test(String(amountRaw).trim())) { bad.push({ page: it.line.page, quote: it.line.text.trim(), reason: 'amount_not_2dp' }); continue; }
        rows.push(row);
      }
      // ---- row-level arithmetic
      const nameIdx = (re) => row0Names(t, numIdx).findIndex((n) => re.test(n));
      for (const r of rows) {
        r.checks = []; r.fail = null;
        if (r.qty != null && r.unit_price != null && r.amount != null) {
          if (Math.abs(Math.round(r.qty * r.unit_price * 100) - cents(r.amount)) <= (rowIsExact(r) ? 0 : 1)) r.checks.push('qty*unit=amount'); else r.fail = 'qty_x_unit_not_amount';
        } else if (r.amount === undefined && r.qty === undefined) {
          // schedule-of-values style: previous + this period = completed; scheduled - completed = balance
          const ix = { sv: nameIdx(/^scheduled/), prev: nameIdx(/^previous/), cur: nameIdx(/^this period/), done: nameIdx(/^(completed|total completed)/), bal: nameIdx(/^balance/) };
          if (ix.prev >= 0 && ix.cur >= 0 && ix.done >= 0) { const v = r.values; if (v[ix.prev] == null || v[ix.cur] == null || v[ix.done] == null) r.fail = 'blank_cell'; else if (Math.abs(cents(v[ix.prev]) + cents(v[ix.cur]) - cents(v[ix.done])) <= 1) r.checks.push('previous+this=completed'); else r.fail = 'previous_plus_this_not_completed'; }
          if (!r.fail && ix.sv >= 0 && ix.done >= 0 && ix.bal >= 0) { const v = r.values; if (v[ix.sv] == null || v[ix.bal] == null || v[ix.done] == null) r.fail = 'blank_cell'; else if (Math.abs(cents(v[ix.sv]) - cents(v[ix.done]) - cents(v[ix.bal])) <= 1) r.checks.push('scheduled-completed=balance'); else r.fail = 'scheduled_minus_completed_not_balance'; }
        }
        if (r.values.some((v) => v == null) && !r.fail) r.fail = 'blank_cell';
      }
      t.rows = rows; t.bad = bad; t.numIdx = numIdx;
    }

    // ---- merge repeated-header tables are already one; reconcile each table
    const extras = { tax: 0, ship: 0, discount: 0 }; const seenExtra = { tax: [], ship: [], discount: [] };
    let grand = null; const subtotalsUsed = [];
    for (const t of tables) {
      for (const b of t.block) {
        const v = b.nums.length === 1 ? toNumber(b.nums[0].t) : null;
        b.value = v;
        if (b.kind === 'tax' || b.kind === 'ship') { if (v != null) { extras[b.kind] += v; seenExtra[b.kind].push(b); } }
        else if (b.kind === 'discount') { if (v != null) { extras.discount += v < 0 ? v : -v; seenExtra.discount.push(b); } }
        else if (b.kind === 'total' && b.nums.length === 1) grand = { value: v, page: b.line.page, quote: b.line.text.trim(), b };
      }
    }
    const goodTables = [];
    for (const t of tables) {
      const info = { page: t.page, header: t.cols.map((c) => c.name), mode: t.mode, status: 'quarantined', reason: null, checks: [], rows: [] };
      out.tables.push(info);
      const rows = t.rows;
      if (!rows.length) { info.reason = 'no_readable_rows'; for (const b of t.bad) out.quarantined.push({ ...b, table: out.tables.length - 1 }); continue; }
      const colTotal = t.block.find((b) => b.kind === 'total' && b.nums.length >= 2);
      const amountRows = rows.filter((r) => r.amount !== undefined);
      let verifiedRows = rows.filter((r) => !r.fail);
      const failedRows = rows.filter((r) => r.fail);
      let reason = null;
      if (t.rowsAfterTotals) reason = 'rows_after_totals';
      else if (t.inferred && !rows.every((r) => r.checks.includes('qty*unit=amount'))) reason = 'inferred_columns_not_proven';
      else if (colTotal) {
        // per-column totals row (rent roll / pay application): every numeric column must add up to its printed total
        if (colTotal.nums.length !== t.numIdx.length) reason = 'totals_row_columns_unclear';
        else if (failedRows.length || t.bad.length) reason = failedRows.length ? failedRows[0].fail : t.bad[0].reason;
        else {
          const sums = t.numIdx.map((_, k) => rows.reduce((s, r) => s + cents(r.values[k]), 0));
          const printed = colTotal.nums.map((c) => toNumber(c.t));
          const badCol = sums.findIndex((s, k) => printed[k] == null || Math.abs(s - cents(printed[k])) > 2);
          if (badCol >= 0) reason = `column_sum_mismatch:${t.cols[t.numIdx[badCol]].name}`;
          else info.checks.push('column sums = printed TOTAL row');
        }
        info.sums = t.numIdx.map((_, k) => rows.reduce((s, r) => s + r.values[k], 0));
      } else if (amountRows.length === rows.length) {
        const sum = rows.reduce((s, r) => s + cents(r.amount), 0);
        const tolSum = rows.every(rowIsExact) ? 0 : 2; info.tolSum = tolSum;
        const sub = t.block.find((b) => b.kind === 'subtotal' && b.value != null);
        info.sum = sum / 100;
        const gotSub = sub ? Math.abs(sum - cents(sub.value)) <= tolSum : null;
        const wholeDoc = tables.length === 1;
        let reconciled = false;
        if (sub) {
          if (gotSub) { reconciled = true; info.checks.push('rows = printed subtotal'); }
          else if (failedRows.length === 1) {
            // one failing row explains the gap: quarantine just that row
            const f = failedRows[0]; const alt = f.qty != null && f.unit_price != null ? Math.round(f.qty * f.unit_price * 100) : null;
            if (alt != null && Math.abs(sum - cents(f.amount) + alt - cents(sub.value)) <= tolSum) { reconciled = true; info.checks.push('rows = printed subtotal (one row quarantined)'); }
          }
          if (!reconciled) reason = 'rows_not_subtotal';
        } else if (wholeDoc && grand && grand.value != null) {
          const ext = Math.round((extras.tax + extras.ship + extras.discount) * 100);
          if (Math.abs(sum + ext - cents(grand.value)) <= tolSum) { reconciled = true; info.checks.push('rows + extras = printed total'); }
          else if (failedRows.length === 1) {
            const f = failedRows[0]; const alt = f.qty != null && f.unit_price != null ? Math.round(f.qty * f.unit_price * 100) : null;
            if (alt != null && Math.abs(sum - cents(f.amount) + alt + ext - cents(grand.value)) <= tolSum) { reconciled = true; info.checks.push('rows + extras = printed total (one row quarantined)'); }
          }
          if (!reconciled) reason = 'rows_plus_extras_not_total';
        } else reason = 'no_printed_total_to_check';
        if (reconciled && t.bad.length) { reason = 'unread_rows:' + t.bad[0].reason; reconciled = false; } // a row we could not read: the sums cannot be trusted
        if (reconciled) { verifiedRows = rows.filter((r) => !r.fail); }
      } else reason = 'no_amount_column';
      if (reason) { info.reason = reason; for (const r of rows) out.quarantined.push({ page: r.page, quote: r.quote, reason, table: out.tables.length - 1 }); for (const b of t.bad) out.quarantined.push({ ...b, table: out.tables.length - 1 }); continue; }
      info.status = 'verified';
      for (const r of failedRows) out.quarantined.push({ page: r.page, quote: r.quote, reason: r.fail, table: out.tables.length - 1 });
      for (const r of verifiedRows) { r.table = out.tables.length - 1; r.checks.push(...info.checks); }
      info.rows = verifiedRows; goodTables.push({ t, info, verifiedRows });
      out.rows.push(...verifiedRows);
    }

    // ---- document totals (a total is a fact only if subtotal + extras = total)
    const sub = tables.flatMap((t) => t.block).filter((b) => b.kind === 'subtotal' && b.value != null);
    const totals = {};
    const pick = (b) => (b ? { value: b.value, page: b.line.page, quote: b.line.text.trim() } : undefined);
    if (goodTables.length && goodTables.length === tables.length && grand && grand.value != null && !tables.some((t) => t.block.some((b) => b.kind === 'total' && b.nums.length >= 2))) {
      const sumSections = goodTables.reduce((s, g) => s + cents(g.info.sum ?? 0), 0);
      const ext = Math.round((extras.tax + extras.ship + extras.discount) * 100);
      if (Math.abs(sumSections + ext - cents(grand.value)) <= Math.max(0, ...goodTables.map((g) => g.info.tolSum ?? 2))) {
        totals.total = { value: grand.value, page: grand.page, quote: grand.quote };
        if (seenExtra.tax.length === 1) totals.tax = pick(seenExtra.tax[0]);
        if (seenExtra.ship.length === 1) totals.shipping = pick(seenExtra.ship[0]);
        if (seenExtra.discount.length === 1) totals.discount = pick(seenExtra.discount[0]);
        if (sub.length === 1) totals.subtotal = pick(sub[0]);
        out.documentVerified = true;
      } else {
        out.reason = 'total_does_not_match_rows';
        out.totalsRejected = { printed: grand.value, rowsPlusExtras: (sumSections + ext) / 100, page: grand.page };
      }
    } else if (goodTables.length && goodTables.length === tables.length) {
      out.documentVerified = tables.every((t) => t.block.some((b) => b.kind === 'total' && b.nums.length >= 2));
      const ct = tables[0].block.find((b) => b.kind === 'total' && b.nums.length >= 2);
      if (ct) totals.columns = { values: ct.nums.map((c) => toNumber(c.t)), page: ct.line.page, quote: ct.line.text.trim() };
    }
    out.totals = totals;
    out.extras = { tax: Math.round(extras.tax * 100) / 100, shipping: Math.round(extras.ship * 100) / 100, discount: Math.round(extras.discount * 100) / 100 };
    if (!out.rows.length) out.reason ??= tables.length ? (out.tables.find((x) => x.reason)?.reason ?? 'no_verified_rows') : 'no_table';
    return out;
  } catch (err) {
    return { tables: [], rows: [], quarantined: [], totals: {}, documentVerified: false, reason: `error:${String(err?.message ?? err).slice(0, 60)}` };
  }
}
function row0Names(t, numIdx) { return numIdx.map((i) => String(t.cols[i].name).toLowerCase()); }

/** Pure. The `line_items` for the financials pipeline (financials/normalize.js re-checks every amount is on the page and the
 *  arithmetic): invoice-shaped tables only (a label and an amount, with or without qty / unit price). Verified rows only. */
export function lineItemsForFinancials(read) {
  if (!read?.rows?.length) return [];
  return read.rows.filter((r) => r.amount !== undefined && r.label).map((r) => ({
    description: r.label, qty: r.qty ?? null, unit_price: r.unit_price ?? null, amount: r.amount, page_no: r.page, verbatim: r.quote,
  }));
}
