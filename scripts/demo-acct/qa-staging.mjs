#!/usr/bin/env node
/**
 * The starter-question quality gate on STAGING (the real app, with Claude available): asks every Wave 1 starter question
 * in its demo company and grades it with the same grader as the local run (lib/grader.mjs). A question passes only with
 * the right answer AND a citation of the right document and page; the not-in-records question passes only when Donovan
 * says it does not know.
 *
 *   node scripts/demo-acct/qa-staging.mjs --docs "<wave1 folder>" --base-url https://staging.deepwelltechnology.com [--only hvac]
 *
 * Uses the same DEEPWELL_DEMO_KEY_<INDUSTRY> keys as seed-demo.mjs (they need the "ask" scope), so run it BEFORE D2
 * (D2 revokes them). Writes <docs>/qa-staging-report.json and .md. Never prints a key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { grade } from './lib/grader.mjs';

const WAVE1 = ['realestate', 'propmgmt', 'hvac', 'plumbing', 'electrical', 'contractors'];
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DOCS = opt('--docs');
const BASE = (opt('--base-url') ?? '').replace(/\/+$/, '');
const ONLY = opt('--only')?.split(',') ?? null;
if (!DOCS || !/^https:\/\//.test(BASE)) { console.error('Usage: --docs <folder> --base-url https://...'); process.exit(2); }

function docIds(slug) {
  const f = path.join(DOCS, slug, '.import-progress.jsonl');
  const map = new Map();
  if (!fs.existsSync(f)) return map;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    try { const r = JSON.parse(line); if (r.t === 'file' && r.documentId) map.set(path.basename(r.path), r.documentId); } catch { /* skip */ }
  }
  return map;
}

const report = { at: new Date().toISOString(), base: BASE, industries: {} };
const md = [`# Demo starter questions - staging QA (${report.at})`, '', `Server: ${BASE}`, ''];
for (const slug of WAVE1) {
  if (ONLY && !ONLY.includes(slug)) continue;
  const key = process.env[`DEEPWELL_DEMO_KEY_${slug.toUpperCase()}`];
  if (!key) { console.log(`${slug}: no key set - skipped`); continue; }
  const { meta, questions } = JSON.parse(fs.readFileSync(path.join(DOCS, slug, 'questions.json'), 'utf8'));
  const ids = docIds(slug);
  const names = new Map([...ids].map(([f, id]) => [id, f]));
  const rows = [];
  for (const q of questions) {
    const t0 = Date.now();
    let data = null; let err = null;
    try {
      const res = await fetch(`${BASE}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ question: q.q }) });
      const body = await res.json().catch(() => null);
      data = body?.success ? body.data : null;
      if (!data) err = String(body?.error ?? res.status);
    } catch (e) { err = e.message; }
    const g = err ? { pass: false, why: `error: ${err}` } : grade(q, data, (f) => ids.get(f), (id) => names.get(id) ?? id);
    rows.push({ id: q.id, q: q.q, pass: g.pass, why: g.why, ms: Date.now() - t0, answer: String(data?.text ?? '').slice(0, 300) });
    console.log(`${g.pass ? 'PASS' : 'FAIL'} ${q.id} ${q.q}${g.pass ? '' : `  -> ${g.why}`}`);
  }
  const passed = rows.filter((r) => r.pass).length;
  report.industries[slug] = { label: meta.label, passed, total: rows.length, rows };
  md.push(`## ${meta.label}: ${passed}/${rows.length}`, '', '| # | Question | Result | Why |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.q} | ${r.pass ? 'pass' : 'FAIL'} | ${r.why.replace(/\|/g, '/')} |`), '');
}
fs.writeFileSync(path.join(DOCS, 'qa-staging-report.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(DOCS, 'qa-staging-report.md'), md.join('\n'));
const all = Object.values(report.industries);
console.log(`\nTotal: ${all.reduce((a, b) => a + b.passed, 0)}/${all.reduce((a, b) => a + b.total, 0)} - report in ${path.join(DOCS, 'qa-staging-report.md')}`);
