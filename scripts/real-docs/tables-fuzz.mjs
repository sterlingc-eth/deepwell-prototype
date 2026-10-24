// Tables lane: mutation test for the line-item reader. Corrupts the clean synthetic documents one way at a time (a digit,
// two cells swapped, a row dropped / duplicated, a total changed, a letter for a digit) and counts VERIFIED rows that are not
// in the gold (= wrong row facts, target 0). node scripts/real-docs/tables-fuzz.mjs [N per kind]
import { loadTablesPages, judgeRows } from './tables-eval.mjs';
import { readTables } from '../../api/_lib/modelAvoidance/tableRows.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const N = Number(process.argv[2] ?? 150);
const docs = loadTablesPages(ROOT).filter((d) => d.variant === 'clean-pdf');
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const isRowLine = (t, d) => d.gold_rows.some((g) => t.includes(g.label.split(' ')[0]) ) && /\d/.test(t);
const mut = {
  digit(lines) { const idx = lines.map((l, i) => (/\d/.test(l) && /\$|\d,\d|\.\d\d/.test(l) ? i : -1)).filter((i) => i >= 0); const i = pick(idx); const pos = [...lines[i].matchAll(/\d/g)].map((m) => m.index); const p = pick(pos); const c = lines[i][p]; const nc = String((Number(c) + 1 + Math.floor(rnd() * 8)) % 10); lines[i] = lines[i].slice(0, p) + nc + lines[i].slice(p + 1); },
  swapcells(lines) { const idx = lines.map((l, i) => (l.split(/ {2,}/).length >= 4 ? i : -1)).filter((i) => i >= 0); const i = pick(idx); const c = lines[i].split(/ {2,}/); const a = c.length - 1, b = c.length - 2; [c[a], c[b]] = [c[b], c[a]]; lines[i] = c.join('   '); },
  droprow(lines, d) { const idx = lines.map((l, i) => (d.gold_rows.some((g) => l.startsWith(g.label.slice(0, 8))) ? i : -1)).filter((i) => i >= 0); lines.splice(pick(idx), 1); },
  duprow(lines, d) { const idx = lines.map((l, i) => (d.gold_rows.some((g) => l.startsWith(g.label.slice(0, 8))) ? i : -1)).filter((i) => i >= 0); const i = pick(idx); lines.splice(i, 0, lines[i]); },
  total(lines) { const idx = lines.map((l, i) => (/^(Sub)?total|Total Due|TOTAL/i.test(l.trim()) && /\d/.test(l) ? i : -1)).filter((i) => i >= 0); if (!idx.length) return; const i = pick(idx); const ms = [...lines[i].matchAll(/\d/g)]; const m = pick(ms); const c = lines[i][m.index]; lines[i] = lines[i].slice(0, m.index) + String((Number(c) + 3) % 10) + lines[i].slice(m.index + 1); },
  letter(lines) { const idx = lines.map((l, i) => (/\$\d/.test(l) ? i : -1)).filter((i) => i >= 0); const i = pick(idx); lines[i] = lines[i].replace(/\$(\d)/, (m, g) => 'S' + g); },
  dropdigit(lines) { const idx = lines.map((l, i) => (/\$\d{2,}/.test(l) ? i : -1)).filter((i) => i >= 0); const i = pick(idx); lines[i] = lines[i].replace(/\$(\d)(\d)/, '$$$2'); },
  mergecells(lines) { const idx = lines.map((l, i) => (l.split(/ {2,}/).length >= 4 ? i : -1)).filter((i) => i >= 0); const i = pick(idx); lines[i] = lines[i].replace(/ {3}(\S+)$/, ' $1'); },
};
const total = { runs: 0, verifiedRows: 0, wrong: [], quarantineOnly: 0 };
const per = {};
for (const [name, fn] of Object.entries(mut)) {
  per[name] = { runs: 0, wrong: 0, verified: 0 };
  for (let k = 0; k < N; k++) {
    const d = pick(docs);
    const pages = d.pages.map((p) => ({ page_no: p.page_no, text: p.text }));
    const pi = Math.floor(rnd() * pages.length);
    const lines = pages[pi].text.split('\n');
    try { fn(lines, d); } catch { continue; }
    pages[pi] = { ...pages[pi], text: lines.join('\n') };
    const r = readTables(pages);
    const j = judgeRows(r.rows, d.gold_rows);
    // a duplicated row that is read twice is a wrong fact too (judgeRows matches each gold row once)
    total.runs++; per[name].runs++; total.verifiedRows += r.rows.length; per[name].verified += r.rows.length;
    for (const w of j.wrong) { per[name].wrong++; total.wrong.push({ mutation: name, doc: d.filename, ...w }); }
  }
}
console.log(JSON.stringify({ mutations: total.runs, verifiedRowsRead: total.verifiedRows, wrongRowFacts: total.wrong.length, perMutation: per }, null, 1));
for (const w of total.wrong.slice(0, 12)) console.log('WRONG', JSON.stringify(w));
process.exit(total.wrong.length ? 1 : 0);
