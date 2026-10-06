/** Selfcheck for the plumbing fixtures + generated question set: determinism, sizes, uniqueness, and that every expectation is grounded in the page text. */
import assert from 'node:assert/strict';
import { buildDocs, truth, TODAY, long, us } from './plumbing-fixtures.mjs';
import { buildQuestions } from './plumbing-questions.mjs';

let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) { fails++; console.log(`FAIL ${name} ${detail}`); } };

const d1 = buildDocs(); const d2 = buildDocs();
assert.deepEqual(d1, d2, 'buildDocs is not deterministic');
const T = truth(); const Q = buildQuestions(T); const Q2 = buildQuestions(truth());
assert.deepEqual(Q, Q2, 'buildQuestions is not deterministic');
check('at least 40 docs', d1.length >= 40, String(d1.length));
check('at least 48 docs', d1.length >= 48, String(d1.length));
check('at least 160 questions', Q.length >= 160, String(Q.length));
check('unique filenames', new Set(d1.map((d) => d.filename)).size === d1.length);
check('unique question text', new Set(Q.map((x) => x.question.toLowerCase())).size === Q.length);

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longToIso = (s) => { const m = s.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/); if (!m) return null; const i = MON.indexOf(m[1]); return i < 0 ? null : `${m[3]}-${String(i + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; };
const all = d1.flatMap((d) => d.pages).join('\n').toLowerCase();
const onPage = (page, s) => { const t = page.toLowerCase(); if (t.includes(String(s).toLowerCase())) return true; const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : longToIso(String(s)); return !!iso && (t.includes(iso) || t.includes(us(iso)) || t.includes(long(iso).toLowerCase())); };

// every spec field is really on its page
const byFile = new Map(d1.map((d) => [d.filename, d]));
for (const d of d1) {
  if (d.decoy) check(`decoy ${d.filename} has no fields`, Object.keys(d.fields).length === 0);
  for (const [k, f] of Object.entries(d.fields)) for (const v of Array.isArray(f.value) ? f.value : [f.value]) check(`${d.filename} ${k} on page ${f.page}`, !!d.pages[f.page - 1] && onPage(d.pages[f.page - 1], v), String(v));
}
// every expectation is grounded
let musts = 0; let cites = 0;
for (const x of Q) {
  if (x.mode === 'null') { check(`null entry has no must ${x.question}`, !x.must && !x.cite); continue; }
  check(`entry has cites or is a count/empty ${x.question}`, (x.cite?.length ?? 0) > 0 || x.kind === 'count' || x.expectEmpty, x.question);
  for (const m of x.must ?? []) { musts++; if ((x.computed ?? []).includes(m)) continue; check(`must "${m}" on a page :: ${x.question}`, onPage(all, m)); }
  for (const [file, key, pg = 1] of x.cite ?? []) {
    cites++; const d = byFile.get(file);
    check(`cite file ${file}`, !!d); if (!d) continue;
    check(`cite ${file}/${key} page ${pg}`, d.fields[key]?.page === pg, `${x.question} -> ${d.fields[key]?.page}`);
  }
}
// near-duplicates never leak into current answers
for (const dv of T.devices) for (const h of dv.history) for (const x of Q.filter((e) => (e.cite ?? []).some(([f]) => f === h.file))) check(`history cert cited as current :: ${x.question}`, false);

const kinds = {}; for (const x of Q) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
const types = {}; for (const d of d1) types[d.type] = (types[d.type] ?? 0) + 1;
console.log(`TODAY ${TODAY}; docs ${d1.length}:`, JSON.stringify(types));
console.log(`questions ${Q.length}:`, JSON.stringify(kinds), `| must-strings ${musts}, citations ${cites}`);
console.log(`devices ${T.devices.length}: due30 ${T.dueWithin(30).length}, due60 ${T.dueWithin(60).length}, due90 ${T.dueWithin(90).length}, overdue ${T.overdue().length}, today ${T.dueToday().length}, failed ${T.failedNoRetest().length}`);
console.log(`heaters ${T.heaters.length}: expiring90 ${T.whExpiring(90).length}, expired ${T.whExpired().length}; permits open ${T.openPermits().length}, expired ${T.expiredPermits().length}`);
if (fails) { console.log(`${fails} check(s) FAILED`); process.exit(1); }
console.log('selfcheck OK');
