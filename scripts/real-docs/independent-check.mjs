// Independent check (separate from the gate): compares the reader's output on 30 randomly drawn documents with answers written
// by hand from the page text (test-docs/real-docs/INDEPENDENT_GOLD_30.json), not derived from the reader. SELF-CHECKED: the
// same agent wrote the reader and these answers. Usage: node scripts/real-docs/independent-check.mjs [--tree <repo root>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPipeline, runDoc } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const i = process.argv.indexOf('--tree');
const TREE = path.resolve(i > 0 ? process.argv[i + 1] : ROOT);
const P = await loadPipeline(TREE);
const pages = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/real-docs/pages.json'), 'utf8')).docs;
const gold = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/real-docs/INDEPENDENT_GOLD_30.json'), 'utf8')).docs;

const date = (v) => P.ef.normalizeDate(String(v), { order: 'mdy' }) ?? String(v);
const name = (v) => String(v).toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
function same(key, a, b) {
  if (/(_date|_expires)$/.test(key)) return date(a) === date(b);
  if (key === 'cost') return Math.round(Number(String(a).replace(/[$,]/g, '')) * 100) === Math.round(Number(String(b).replace(/[$,]/g, '')) * 100);
  if (key === 'agreement_term') {
    const ds = (s) => [...String(s).matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2,8} \d{4}/g)].map((m) => date(m[0])).sort().join('|');
    const len = (s) => (/(\d+)\s*(month|year)/i.exec(String(s)) ?? []).slice(1, 3).join(' ').toLowerCase();
    return ds(a) === ds(b) && (!len(b) || len(a) === len(b));
  }
  return name(a) === name(b);
}

let correct = 0, wrong = 0, missed = 0;
const lines = [];
for (const g of gold) {
  const d = pages.find((x) => x.filename === g.filename);
  const r = runDoc(P, d);
  const got = (k) => r.fields.filter((f) => f.field_key === k).map((f) => String(f.value));
  for (const [k, v] of Object.entries(g.facts ?? {})) {
    const vals = got(k);
    if (!vals.length) { missed++; lines.push(`  missed  ${g.filename}  ${k} = ${v}`); continue; }
    if (vals.some((x) => same(k, x, v))) correct++;
    else { wrong++; lines.push(`  WRONG   ${g.filename}  ${k}: expected ${v}, read ${vals.join(' | ')}`); }
  }
  for (const k of ['customer_name', 'vendor']) {
    if (g.facts?.[k] || !g.partyAnyOf) continue;
    for (const x of got(k)) {
      if (g.partyAnyOf.some((p) => same(k, x, p))) correct++;
      else { wrong++; lines.push(`  WRONG   ${g.filename}  ${k}: read "${x}", the paper's parties are ${g.partyAnyOf.join(' / ')}`); }
    }
  }
  for (const f of g.forbidden ?? []) if (got(f.key).some((x) => same(f.key, x, f.value))) { wrong++; lines.push(`  WRONG   ${g.filename}  ${f.key} = ${f.value} (must not be read)`); }
}
console.log(`independent check (self-checked, ${gold.length} random documents, answers written by hand from the page): correct ${correct}, wrong ${wrong}, missed ${missed}`);
for (const l of lines) console.log(l);
process.exit(wrong ? 1 : 0);
