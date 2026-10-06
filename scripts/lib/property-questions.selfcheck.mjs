/** Selfcheck: property-questions.mjs expectations are consistent with the fixture specs (doc.truth) and the rendered page text.
 *  node scripts/lib/property-questions.selfcheck.mjs   (exit 1 on any FAIL; WARN lines are known fixture gaps) */
import { TODAY, addDays, long, money, truth } from './property-fixtures.mjs';
import { buildQuestions } from './property-questions.mjs';

const T = truth(); const qs = buildQuestions(T);
const fails = []; const warns = [];
const byFile = new Map(T.docs.map((d) => [d.filename, d]));
const text = (d) => d.pages.map((p) => p.text).join('\n').toLowerCase();
const norm = (s) => s.toLowerCase();

// 1. shape + cites + must strings present in cited docs (computed / null / modelOk-without-cite exempt)
const seen = new Set();
for (const e of qs) {
  const tag = `[${e.kind}] ${e.question}`;
  if (!e.question || !e.kind) fails.push(`shape: ${tag}`);
  if (seen.has(e.question)) fails.push(`duplicate question: ${tag}`); seen.add(e.question);
  if (e.mode !== 'null' && !Array.isArray(e.must)) fails.push(`must missing: ${tag}`);
  if (e.mode === 'null' && e.must?.length && !e.modelOk) fails.push(`null question with must: ${tag}`);
  const corpus = [];
  for (const [file, key, page = 1] of e.cite ?? []) {
    const d = byFile.get(file);
    if (!d) { fails.push(`cite file not found ${file}: ${tag}`); continue; }
    const f = d.truth.fields[key];
    if (!f) { fails.push(`cite ${file}#${key} not in truth fields: ${tag}`); continue; }
    if (f.page !== page) fails.push(`cite page ${file}#${key} says ${page}, truth ${f.page}: ${tag}`);
    corpus.push(text(d));
    const vals = Array.isArray(f.value) ? f.value : [f.value];
    for (const v of vals) { if (/^\d{4}-\d\d-\d\d$/.test(v)) corpus.push(norm(long(v))); else if (typeof v === 'number') corpus.push(norm(money(v))); else { const sv = String(v); corpus.push(norm(sv)); for (const m of sv.match(/\d{4}-\d\d-\d\d/g) ?? []) corpus.push(norm(long(m))); } }
  }
  if (e.cite?.length && e.mode !== 'null') {
    const hay = corpus.join('\n'); const comp = new Set((e.computed ?? []).map(norm));
    for (const m of e.must ?? []) {
      if (comp.has(norm(m))) continue;
      if (!hay.includes(norm(m))) fails.push(`must "${m}" not in cited docs: ${tag}`);
    }
  }
  for (const m of e.mustNot ?? []) if ((e.must ?? []).some((x) => norm(x) === norm(m))) fails.push(`must and mustNot overlap "${m}": ${tag}`);
}

// 2. independent recomputation from doc.truth.fields (the specs as rendered), compared with the questions' expectations
const F = (d, k) => d.truth.fields[k]?.value;
const ofType = (t) => T.docs.filter((d) => d.truth.type === t && !d.truth.wrongType);
const SHORT = { 'Rios Plumbing': 'Rios Plumbing LLC', 'Sun Valley Landscaping': 'Sun Valley Landscaping Inc', 'Apex Pest Control': 'Apex Pest Control Services', 'Summit Elevator': 'Summit Elevator Co', 'Bright Path Janitorial': 'Bright Path Janitorial LLC', 'Coolwave HVAC': 'Coolwave HVAC Services LLC', 'Ironclad Roofing': 'Ironclad Roofing Inc' };
const find = (q) => qs.find((e) => e.question === q);
const expect = (q, ...must) => { const e = find(q); if (!e) { fails.push(`missing question ${q}`); return; } for (const m of must) if (!e.must.includes(m)) fails.push(`expected "${m}" in must of: ${q} (has ${JSON.stringify(e.must)})`); };

// current COI per vendor from the readable documents (latest coi_expires; D1)
const cur = new Map();
for (const d of ofType('certificate-of-insurance')) {
  const e = F(d, 'coi_expires'); const v = F(d, 'vendor'); if (!e || !v) continue;
  if (!cur.has(v) || e > cur.get(v).e) cur.set(v, { e, f: d.filename });
}
for (const [s, full] of Object.entries(SHORT)) {
  const k = cur.get(full); if (!k) { fails.push(`no current COI for ${full}`); continue; }
  expect(`When does ${s}'s insurance expire?`, long(k.e));
}
const inW = (x, n) => x >= TODAY && x <= addDays(TODAY, n);
for (const n of [7, 30, 90, 180]) expect(`Which vendor COIs expire in the next ${n} days?`, ...[...cur].filter(([, k]) => inW(k.e, n)).map(([v]) => Object.keys(SHORT).find((s) => SHORT[s] === v)));
// warn when truth().cois (specs only) disagrees with the documents
const t1 = new Set(T.coisExpired().map((c) => c.vendor)); const t2 = new Set([...cur].filter(([, k]) => k.e < TODAY).map(([v]) => v));
if ([...t1].sort().join() !== [...t2].sort().join()) warns.push(`truth().coisExpired() = [${[...t1]}] but documents give [${[...t2]}] (coi-dmy-2digit.pdf renews Ironclad; truth().cois is built from COIS only)`);
if ([...t1].sort().join() !== [...t2].sort().join()) fails.push('truth().coisExpired() must equal the documents (the Ironclad renewal is part of COIS)');
if (find('Which vendors have expired insurance?').alt) fails.push('expired-COI question must not carry an alt patch: truth().cois is complete');

for (const d of ofType('vendor-contract')) { const v = F(d, 'vendor'); const s = Object.keys(SHORT).find((k) => SHORT[k] === v); const ce = F(d, 'contract_end'); if (ce) expect(`What is the monthly fee for ${s}?`, money(F(d, 'monthly_amount'))); }
for (const d of ofType('invoice')) { const no = F(d, 'invoice_number'); const cost = F(d, 'cost'); if (!no || cost == null || d.truth.mustBeNull) continue; const e = qs.find((x) => x.question.includes(`invoice ${no}?`) && x.question.startsWith('What is the total')); if (e && !e.must.includes(money(cost))) fails.push(`invoice ${no} total ${money(cost)} vs ${e.must}`); }
for (const d of ofType('work-order')) { const no = F(d, 'work_order_number'); const st = F(d, 'status'); const e = qs.find((x) => x.question === `What is the status of ${no}?`); if (!e) continue; const ok = e.must.includes(st) || (e.alt ?? []).some((a) => a.includes(st)); if (!ok) fails.push(`WO ${no} status ${st} vs ${e.must}`); }
for (const d of ofType('lease-agreement')) { const t = F(d, 'tenant_name'); const le = F(d, 'lease_end_date'); if (!t || !le || d.filename === 'lease-7a.pdf') continue; const f = t.split(' and ')[0].split(' ')[0]; const e = qs.find((x) => x.question.includes(`${f}`) && /lease end|When does/.test(x.question) && x.cite?.some((c) => c[0] === d.filename)); if (e && !e.must.includes(long(le))) fails.push(`lease ${d.filename} end ${long(le)} vs ${e.must}`); }
// counts by document type (D7)
const nType = (t) => T.docs.filter((d) => d.truth.type === t).length;
expect('How many vendor contracts do we have?', String(nType('vendor-contract')));
expect('How many rent rolls do we have?', String(nType('rent-roll')));

// 3. extras restated in the questions file (Ironclad renewal, extra leases) vs the documents
const ir = byFile.get('coi-dmy-2digit.pdf'); if (long(F(ir, 'coi_expires')) !== 'February 3, 2027') fails.push(`Ironclad renewal expiry is ${F(ir, 'coi_expires')}`);
const dmy = byFile.get('lease-dmy.pdf'); if (F(dmy, 'lease_end_date') !== addDays(TODAY, 350) || F(dmy, 'rent_amount') !== 1710) fails.push('lease-dmy extras mismatch');
const rc = byFile.get('lease-rent-conflict.pdf'); if (F(rc, 'lease_end_date') !== addDays(TODAY, 335)) fails.push('lease-rent-conflict end mismatch');

const kinds = {}; for (const e of qs) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`questions: ${qs.length}`, kinds);
console.log(`null/modelOk: ${qs.filter((e) => e.mode === 'null').length} null, ${qs.filter((e) => e.modelOk).length} modelOk; with cites: ${qs.filter((e) => e.cite?.length).length}`);
for (const w of warns) console.log('WARN', w);
for (const f of fails.slice(0, 60)) console.log('FAIL', f);
console.log(fails.length ? `${fails.length} FAIL` : 'selfcheck OK');
process.exit(fails.length ? 1 : 0);
