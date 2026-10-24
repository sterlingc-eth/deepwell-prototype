// Tables lane: the judge for the line-item reader (api/_lib/modelAvoidance/tableRows.js) against hand-known gold rows.
// Used by scripts/verify-real-docs.mjs (gate section 6) and scripts/real-docs/build-tables-pages.mjs. Synthetic "Sample" documents only.
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function similar(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  const m = a.length, n = b.length; if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return 1 - prev[n] / Math.max(m, n);
}
const eqVals = (a, b) => a.length === b.length && a.every((v, i) => b[i] != null && v != null && Math.abs(v - b[i]) < 0.005);

/** A read row is CORRECT when page, every value and the label (>= 0.8 alike) match a gold row; any other verified row is WRONG. */
export function judgeRows(readRows, goldRows) {
  const used = new Set(); const wrong = []; let correct = 0, misreadLabel = 0;
  for (const r of readRows) {
    let hit = -1, best = 0;
    goldRows.forEach((g, i) => { if (used.has(i) || g.page !== r.page || !eqVals(r.values, g.values)) return; const s = similar(r.label, g.label); if (s > best) { best = s; hit = i; } });
    if (hit >= 0 && best >= 0.8) { used.add(hit); correct++; if (best < 1) misreadLabel++; }
    else wrong.push({ page: r.page, label: r.label, values: r.values, quote: r.quote });
  }
  return { correct, wrong, missed: goldRows.filter((_, i) => !used.has(i)), misreadLabel };
}

/** Totals: a total the reader states must equal gold (value) - a stated total that differs is wrong. */
export function judgeTotals(read, goldTotals, lastPage) {
  const wrong = []; let correct = 0;
  for (const k of ['subtotal', 'tax', 'total']) {
    const r = read.totals?.[k]; if (!r) continue;
    const g = goldTotals?.[k];
    if (g == null || Math.abs(r.value - g) > 0.005 || (k === 'total' && r.page !== lastPage)) wrong.push({ key: k, read: r.value, page: r.page, gold: g });
    else correct++;
  }
  const cg = goldTotals?.columns, cr = read.totals?.columns;
  if (cr) { if (cg && eqVals(cr.values, cg)) correct++; else wrong.push({ key: 'columns', read: cr.values, gold: cg }); }
  return { correct, wrong };
}

/** Run the reader over docs ({pages, gold_rows, gold_totals}); `mode` 'x' keeps page.lines (x positions), 'order' uses text only. */
export function evalSuite(docs, { mode = 'order', readTables } = {}) {
  const sum = { docs: docs.length, goldRows: 0, rowsCaptured: 0, wrongRows: [], misreadLabels: 0, wrongTotals: [], docsFullyRead: 0, docsNeedPerson: 0, docsNoTable: 0, quarantinedRows: 0, byKind: {}, perDoc: [] };
  for (const d of docs) {
    const pages = (d.pages ?? []).map((p) => (mode === 'x' ? p : { page_no: p.page_no, text: p.text }));
    const read = readTables(pages);
    const j = judgeRows(read.rows, d.gold_rows ?? []);
    const lastPage = Math.max(...(d.gold_rows ?? [{ page: 1 }]).map((g) => g.page));
    const t = judgeTotals(read, d.gold_totals, lastPage);
    sum.goldRows += (d.gold_rows ?? []).length; sum.rowsCaptured += j.correct; sum.misreadLabels += j.misreadLabel;
    for (const w of j.wrong) sum.wrongRows.push({ doc: d.filename, ...w });
    for (const w of t.wrong) sum.wrongTotals.push({ doc: d.filename, ...w });
    sum.quarantinedRows += read.quarantined.length;
    const full = j.correct === (d.gold_rows ?? []).length && !j.wrong.length;
    if (full) sum.docsFullyRead++; else sum.docsNeedPerson++;
    if (!read.tables.length) sum.docsNoTable++;
    const bk = (sum.byKind[d.kind] ??= { docs: 0, gold: 0, captured: 0, wrong: 0 });
    bk.docs++; bk.gold += (d.gold_rows ?? []).length; bk.captured += j.correct; bk.wrong += j.wrong.length;
    sum.perDoc.push({ doc: d.filename, gold: (d.gold_rows ?? []).length, captured: j.correct, wrong: j.wrong.length, reason: read.reason ?? read.tables.find((x) => x.reason)?.reason ?? null });
  }
  return sum;
}

export function loadTablesPages(root) {
  const p = path.join(root, 'test-docs/real-docs/tables/pages-tables.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).docs : null;
}
