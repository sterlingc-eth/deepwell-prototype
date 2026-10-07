/**
 * verify:industry-property (Build 2, stage 2D; permanent, in verify:all).
 * A seeded property management company's paperwork (fixture documents as page text) is read by the property extractor, stored
 * with its pages, and the question sets are answered by the lane with NO model. Truth comes from the fixture specs, never from
 * the lane. Every question lands in one class: correct / needs-model / clarified / wrong (wrong must be 0).
 * Also: records and wording never cross between companies of different industries; HVAC has no lane.
 *   node scripts/verify-industry-property.mjs [-v]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TODAY, addDays, truth, buildDocs } from './lib/property-fixtures.mjs';

let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else { failures++; console.log(`FAIL  ${n}${d ? `\n      ${d}` : ''}`); } };
const { startMixedHarness } = await import('./lib/mixed-company-harness.mjs');
const { extractProperty } = await import('../api/_lib/industry/property/extract.js');
const { classifyProperty, runProperty, propertyAttention, DECLINE } = await import('../api/_lib/industry/property/lane.js');
const { laneForPack } = await import('../api/_lib/industry/lanes.js');

const H = await startMixedHarness();
const T = truth();
const DOCS = buildDocs();
const VERBOSE = process.argv.includes('-v');

/* 1. ingest: extractor -> documents, pages, facets, extractions (page kept) */
const idByFile = {};
let typeMismatch = 0; let nullLeak = 0; let missed = 0; let typedOnly = 0;
const store = async (db, d, r) => {
  const doc = await db.createDocument({ original_filename: d.filename, document_type: r.type, sha256_hash: crypto.createHash('sha256').update(d.filename + d.pages.map((p) => p.text).join()).digest('hex'), stage: 'mapped' });
  idByFile[d.filename] = doc.id;
  for (const f of r.fields) {
    const facet = await db.createFacet({ document_id: doc.id, page_no: f.page_no, label_raw: f.key, value_raw: f.verbatim ?? f.value, confidence: f.confidence });
    await db.createExtraction({ document_id: doc.id, field_key: f.key, value: f.value, confidence: f.confidence, source_facet_id: facet.id });
  }
};
await H.addFixture('property', async (db) => {
  for (const d of DOCS) {
    const r = extractProperty(d.pages, { today: TODAY });
    if (d.truth.wrongType || d.truth.mustBeNull) { if (r) { nullLeak++; console.log(`      should read as nothing: ${d.filename} -> ${r.type}`); } continue; }
    if (!r) {
      if (d.truth.mustRead) { missed++; console.log(`      must read: ${d.filename}`); continue; }
      // left to the model path (messy / partial documents): stored under their real type with the values a model read would give
      // (the fixture truth), so document counts and lists see them like any other document
      const fields = [];
      for (const [k, v] of Object.entries(d.truth.fields ?? {})) for (const e of Array.isArray(v.value) ? v.value : [v.value]) fields.push({ key: k, value: String(e), page_no: v.page, confidence: 0.8 });
      await store(db, d, { type: d.truth.type, fields }); typedOnly++;
      continue;
    }
    if (r.type !== d.truth.type) { typeMismatch++; console.log(`      type ${d.filename}: ${r.type} vs ${d.truth.type}`); continue; }
    await store(db, d, r);
  }
});
check('extractor classified every readable fixture document correctly', typeMismatch === 0 && missed === 0, `${typeMismatch} mismatched, ${missed} missed`);
check('wrong-type documents (letters, forms, notices) produce nothing', nullLeak === 0);
check(`documents stored (${Object.keys(idByFile).length}, ${typedOnly} typed only)`, Object.keys(idByFile).length >= 50);

/* 2. the question sets: truth from specs */
const alltextFn = null; void alltextFn;
const alltext = (r) => `${r.text} ${(r.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
const FOREIGN = /\b(?:backflow|tonnage|refrigerant|seer|furnace|condenser|compressor|breaker|amperage|thermostat|rpz|water heater|permit)\b/i;
const has = (blob, s) => blob.includes(String(s).toLowerCase());
/** the lane's own wording: the answer with every quoted document value taken out (a work order line item may name any trade's part) */
const laneWords = (r) => { let t = alltext(r); for (const f of r.facts ?? []) for (const part of String(f.value ?? '').split(/ · |; /)) if (part.length > 3) t = t.split(part).join(' '); return t; };
const cls = { correct: 0, 'needs-model': 0, clarified: 0, wrong: 0, cited: 0 };
const byKind = {};
const unexpectedNull = []; // answerable (not marked modelOk, not a null-mode question) but the lane returned nothing
const grade = (blob, x) => {
  const ok = (must, mustNot) => (must ?? []).every((m) => has(blob, m)) && !(mustNot ?? []).some((m) => has(blob, m));
  // an answered question that asserts nothing (no must, no alt, no mustNot) proves nothing: it fails instead of passing
  if (!(x.must ?? []).length && !(x.alt ?? []).some((set) => set.length) && !(x.mustNot ?? []).length) return false;
  if (ok(x.must, x.mustNot)) return true;
  return (x.alt ?? []).some((set) => ok(set, x.mustNot));
};
let Q = [];
const qPath = new URL('./lib/property-questions.mjs', import.meta.url);
if (fs.existsSync(qPath)) Q = (await import(qPath.href)).buildQuestions(T);
else Q = [
  { kind: 'coi', question: 'Which vendor COIs expire in the next 30 days?', must: ['Summit Elevator', 'Rios Plumbing'] },
  { kind: 'coi', question: 'Is Rios Plumbing insured?', must: ['October 26, 2026'] },
  { kind: 'lease', question: 'Which leases expire in the next 60 days?', must: ['12C'] },
  { kind: 'lease', question: 'Who lives in unit 4B?', must: ['Jordan Ellis'] },
  { kind: 'vacancy', question: 'Which units are vacant?', must: ['2A', '4A'] },
  { kind: 'invoice', question: 'Which invoices are overdue?', must: ['SV-0912'] },
  { kind: 'general', question: 'What is the weather in Mesa?', mode: 'null' },
];
check(`question set loaded (${Q.length}${fs.existsSync(qPath) ? '' : ', interim list'})`, Q.length >= (fs.existsSync(qPath) ? 150 : 5));
await H.as('property', async (db) => {
  for (const x of Q) {
    const st = (byKind[x.kind] ??= { correct: 0, left: 0, wrong: 0 });
    const intent = classifyProperty(x.question, { today: TODAY });
    const res = intent ? await runProperty(db, intent, { today: TODAY }) : null;
    const tag = `[${x.kind}] "${x.question}"`;
    const declined = res?.decline === true;
    if (x.mode === 'null') {
      const ok = res == null || declined || res.clarify === true;
      if (ok) { cls[res?.clarify ? 'clarified' : 'needs-model']++; st.left++; } else { cls.wrong++; st.wrong++; }
      check(`not answered from records ${tag}`, ok, JSON.stringify(res?.text));
      continue;
    }
    if (!res || declined) { cls['needs-model']++; st.left++; if (!x.modelOk) unexpectedNull.push(`${x.kind}: ${x.question}`); continue; } // left to the model path: never wrong
    if (res.clarify) { cls.clarified++; st.left++; continue; }
    const blob = alltext(res).toLowerCase();
    let ok = grade(blob, x); const why = [];
    if (!ok) why.push(`expected ${JSON.stringify(x.must)} not ${JSON.stringify(x.mustNot ?? [])}`);
    for (const [file, field, page = 1] of x.cite ?? []) {
      const pageText = (pg) => DOCS.find((d) => d.filename === file)?.pages.find((p) => p.page_no === pg)?.text ?? '';
      // a rent roll row can sit on a later page than page 1: accept the page that really prints that unit's row
      const printsUnit = (f, pg) => { const u = (f.label.match(/[Uu]nit (\S+)/)?.[1] ?? '').replace(/[^A-Za-z0-9]/g, ''); return !!u && new RegExp(`(?:^|\\n)\\s*${u}\\b`).test(pageText(pg)); };
      const hit = (res.facts ?? []).some((f) => (f.sources ?? []).some((s) => s.documentId === idByFile[file] && s.location?.field === field && (s.location?.page === page || (field === 'rent_roll_row' && printsUnit(f, s.location?.page)))));
      if (!hit) { ok = false; why.push(`no citation to ${file}/${field}/p${page}`); } else cls.cited++;
    }
    if (FOREIGN.test(laneWords(res))) { ok = false; why.push('foreign-industry wording'); }
    if (/(?:^|[.;] )1 (?:[a-z-]+ ){1,3}(?:need|have|renew|are|were|show|expire|end)\b/i.test(laneWords(res))) { ok = false; why.push(`count of one with a plural verb: ${laneWords(res).match(/1 (?:[a-z-]+ ){1,3}(?:need|have|renew|are|were|show|expire|end)\b/i)?.[0]}`); }
    if (/\b([a-z]{3,})\s+\1\b/i.test(laneWords(res))) { ok = false; why.push(`repeated word in the lane's own wording: ${laneWords(res).match(/\b([a-z]{3,})\s+\1\b/i)[0]}`); }
    if (res.facts?.length && res.facts.some((f) => !f.sources?.length)) { ok = false; why.push('a fact has no source'); }
    // modelOk only ever allows a null / needs-model answer (handled above); a wrong answer on a modelOk question is wrong
    if (ok) { cls.correct++; st.correct++; } else { cls.wrong++; st.wrong++; }
    if (VERBOSE && ok) console.log(`ok ${tag} :: ${res.text}`);
    check(`answer ${tag}`, ok, `${why.join('; ')} :: ${res.text}`);
  }
});
console.log(`questions: ${Q.length}  correct: ${cls.correct}  needs-model: ${cls['needs-model']}  clarified: ${cls.clarified}  wrong: ${cls.wrong}  citations proved: ${cls.cited}`);
console.log('by kind (correct / left to model or clarified / wrong): ' + Object.entries(byKind).map(([k, v]) => `${k} ${v.correct}/${v.left}/${v.wrong}`).join('  '));
check('no wrong answers', cls.wrong === 0);
{ // questions the lane left to the model although the set does not allow that (not modelOk): counted per kind and held to a committed baseline
  const per = {}; for (const u of unexpectedNull) per[u.split(':')[0]] = (per[u.split(':')[0]] ?? 0) + 1;
  console.log(`unexpected needs-model (not marked modelOk): ${unexpectedNull.length}  ${Object.entries(per).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  if (VERBOSE) for (const u of unexpectedNull) console.log(`  needs-model: ${u}`);
  const BASELINE_UNEXPECTED_NEEDS_MODEL = 126;
  check(`unexpected needs-model answers do not grow past the committed baseline (${BASELINE_UNEXPECTED_NEEDS_MODEL})`, unexpectedNull.length <= BASELINE_UNEXPECTED_NEEDS_MODEL, `${unexpectedNull.length}: ${unexpectedNull.slice(0, 8).join(' | ')}`);
}
check('the lane answers most of the answerable questions itself', Q.length >= 100 && cls.correct >= 0.5 * Q.filter((x) => x.mode !== 'null').length, `${cls.correct} correct`);

/** Items that name a different vendor / work order / invoice than the expected ones: an answer with extra wrong items fails when the entry says exclusive. */
const universe = () => [...new Set([...Object.values(T.vendors ?? {}).map((v) => String(v).replace(/\s+(?:LLC|Inc\.?|Co\.?|Corp\.?)$/i, '')), ...(T.docs.flatMap((d) => Object.values(d.truth.fields ?? {}).flatMap((v) => (Array.isArray(v.value) ? v.value : [v.value]).map(String))).filter((v) => /^(?:WO|INV|SV|IR|BP)-?\d+/i.test(v)))])];
function extraItems(blob, exp, x) {
  if (!x?.exclusive) return [];
  const want = exp.map((e) => String(e).toLowerCase());
  return universe().filter((u) => { const l = String(u).toLowerCase(); return has(blob, l) && !want.some((w) => w.includes(l) || l.includes(w)); });
}

/* 2b. blind set (written by a separate tester who saw only the documents); skipped when the file is absent */
const blindPath = new URL('./fixtures/property-blind.json', import.meta.url);
if (fs.existsSync(blindPath)) {
  const BLIND = JSON.parse(fs.readFileSync(blindPath, 'utf8')); let bad = 0; const stats = {};
  await H.as('property', async (db) => {
    for (const x of BLIND) {
      const st = (stats[x.set] ??= { correct: 0, left: 0, wrong: 0 });
      const it = classifyProperty(x.question, { today: TODAY }); const r = it ? await runProperty(db, it, { today: TODAY }) : null;
      const blob = r ? alltext(r).toLowerCase() : ''; let ok;
      const exp = x.expected ?? [];
      if (!r || r.decline === true || r.clarify === true) { st.left++; ok = true; }
      else if (x.kind === 'unanswerable' || exp.length === 0) ok = false;
      else ok = exp.every((e) => has(blob, e)) && !(x.mustNot ?? []).some((m) => has(blob, m)) && !extraItems(blob, exp, x).length && !FOREIGN.test(laneWords(r));
      if (r && ok) st.correct++;
      if (!ok) { st.wrong++; bad++; console.log(`FAIL  blind[${x.set}] ${x.kind} "${x.question}" :: ${r?.text}`); }
    }
  });
  console.log('blind sets (correct / left to model / wrong): ' + Object.entries(stats).map(([k, v]) => `${k}: ${v.correct} / ${v.left} / ${v.wrong}`).join('   '));
  check(`blind set: ${BLIND.length} questions, none answered wrongly`, bad === 0);
}

/* 3. definitions and gates */
const cl = (x) => classifyProperty(x, { today: TODAY });
check('legal and compliance judgement questions are declined', ['Can we evict the tenant in 3?', 'Is it legal to keep the security deposit?', 'Does Rios Plumbing meet our insurance requirements?', 'Should we renew the Apex contract?'].every((x) => cl(x)?.kind === 'decline'), JSON.stringify(['Can we evict the tenant in 3?', 'Is it legal to keep the security deposit?', 'Does Rios Plumbing meet our insurance requirements?', 'Should we renew the Apex contract?'].map((x) => cl(x)?.kind)));
check('declines carry property wording and no other trade', !FOREIGN.test(DECLINE.legal + DECLINE.compliance) && /document/.test(DECLINE.legal));
check('other trades are not answered', ['What tonnage is the condenser at 1200 Mesa Drive?', 'Which backflow tests are overdue?', 'Which water heater warranties expire soon?', 'Which permits are open?', 'What size is the main breaker?'].every((x) => cl(x) == null));
check('negation, first / earlier and mixed asks go to the normal path', ['Which vendors are not insured?', 'Which leases do not expire this year?', 'What was the first COI for Rios Plumbing?', 'Which COIs are expired and which leases end soon?', 'Which invoices are overdue and which work orders are open?', 'Who lived in 4B before Jordan Ellis?', 'Which leases ended earlier than the renewal?'].every((x) => cl(x) == null), JSON.stringify(['Which vendors are not insured?', 'Which leases do not expire this year?', 'What was the first COI for Rios Plumbing?', 'Which COIs are expired and which leases end soon?', 'Which invoices are overdue and which work orders are open?', 'Who lived in 4B before Jordan Ellis?', 'Which leases ended earlier than the renewal?'].map((x) => cl(x)?.kind)));
check('relative periods we cannot compute go to the normal path', ['Which leases expire next month?', 'Which COIs expired last year?', 'Which contracts end before December?', 'Which leases end this quarter?'].every((x) => cl(x) == null));
check('"has none" idioms still read ("no COI on file")', cl('Which vendors have no COI on file?')?.kind === 'coi_missing');
await H.as('property', async (db) => {
  const run = async (x) => { const i = cl(x); return i ? runProperty(db, i, { today: TODAY }) : null; };
  check('an unknown vendor is never guessed', (await run('Is Zeta Plumbing insured?')) == null);
  check('an unknown unit is never guessed', (await run('Who lives in unit 99Z?')) == null);
  check('an address that is not on file is never guessed', (await run('Which work orders are open at 9999 Nowhere Road?')) == null);
  check('two units in one question go to the normal path', (await run('What is the rent for unit 4B and unit 12C?')) == null);
  const exp = await run('Which vendor COIs expire in the next 30 days?');
  check('"today" is not expired: a certificate expiring today is listed as expiring', /Apex Pest Control/.test(exp?.text ?? '') && !/Apex[^;]*expired/.test(exp?.text ?? ''), exp?.text);
  const ex2 = await run('Which vendor COIs are expired?');
  check('an older certificate never makes a vendor expired when a newer one is on file', !/Apex|Rios/.test(ex2?.text ?? ''), ex2?.text);
  const ins = await run('Is Rios Plumbing insured?');
  check('current certificate = latest expiry (history is never quoted)', /October 26, 2026/.test(ins?.text ?? '') && !/2025/.test(ins?.text ?? ''), ins?.text);
  const wo = await run('Which work orders are open?');
  check('the same work order printed twice (Completed / Closed) counts once and is not open', !/WO-20418/.test(wo?.text ?? ''), wo?.text);
  const inv = await run('Which invoices are unpaid?');
  check('the same invoice resent counts once', (inv?.text.match(/INV-5001/g) ?? []).length === 1, String(inv?.text));
  const tot = await run('How much have we spent at Saguaro Ridge?');
  check('an invoice with no due date is never computed as overdue', !/IR-221/.test((await run('Which invoices are overdue?'))?.text ?? ''));
  void tot;
});

/* 4. storage step: extractor output through normalizeFields with the property pack */
{
  const { normalizeFields } = await import('../api/_lib/extractFields.js');
  const pack = await H.as('property', (db) => H.I.packForTenant(db));
  const doc = (name) => DOCS.find((d) => d.filename === name);
  const stored = (name) => { const d = doc(name); const r = extractProperty(d.pages, { today: TODAY }); return normalizeFields(r.fields, { pageCount: d.pages.length, today: TODAY, pack }).fields ?? []; };
  const rr = stored('rentroll-saguaro.pdf');
  check('every rent roll row survives storage (8 units)', rr.filter((x) => x.field_key === 'rent_roll_row').length === 8, String(rr.filter((x) => x.field_key === 'rent_roll_row').length));
  const coi = stored('coi-cool-2026.pdf');
  check('every coverage type survives storage', coi.filter((x) => x.field_key === 'coverage_type').length === 3, JSON.stringify(coi.filter((x) => x.field_key === 'coverage_type').map((x) => x.value)));
  check('COI expiry is stored as a date', coi.some((x) => x.field_key === 'coi_expires' && /^\d{4}-\d{2}-\d{2}$/.test(x.value)));
  const ins = stored('insp-fire-saguaro.pdf');
  check('every deficiency survives storage', ins.filter((x) => x.field_key === 'deficiency').length === 2 && ins.some((x) => x.field_key === 'reinspection_due' && x.value === '2026-10-16'), JSON.stringify(ins.map((x) => [x.field_key, x.value])));
  const ct = stored('contract-sun.pdf');
  check('contract dates are dates and the monthly amount is money', ct.some((x) => x.field_key === 'contract_end' && /^\d{4}-\d{2}-\d{2}$/.test(x.value)) && ct.some((x) => x.field_key === 'monthly_amount' && Number(x.value) === 1200), JSON.stringify(ct.map((x) => [x.field_key, x.value])));
  const iv = stored('inv-apex-771.pdf');
  check('invoice due date and total survive storage', iv.some((x) => x.field_key === 'invoice_due' && x.value === '2026-11-02') && iv.some((x) => x.field_key === 'cost' && Number(x.value) === 425), JSON.stringify(iv.map((x) => [x.field_key, x.value])));
  const ls = stored('lease-4b.pdf');
  check('lease dates, rent and deposit survive storage', ['lease_start_date', 'lease_end_date', 'rent_amount', 'security_deposit'].every((k) => ls.some((x) => x.field_key === k)), JSON.stringify(ls.map((x) => [x.field_key, x.value])));
  const src = fs.readFileSync(new URL('../api/_lib/extractFields.js', import.meta.url), 'utf8');
  check('lane date keys are date fields in the model path too', /coi_expires|contract_end|reinspection_due/.test(src) && /invoice_due|lease_end_date/.test(src));
}

/* 5. attention list (truth from the fixture specs) */
await H.as('property', async (db) => {
  const at = await propertyAttention(db, { today: TODAY, withinDays: 60 });
  const cat = (c) => at.items.filter((i) => i.category === c);
  check('attention: every item has a page and a document', at.items.length > 0 && at.items.every((x) => x.page >= 1 && x.documentId && x.label && x.category && x.kind));
  check('attention: certificates expiring in 60 days include Rios (20) and Summit (5) and Apex (today)', ['Rios', 'Summit', 'Apex'].every((v) => cat('coi').some((i) => i.label.includes(v))), JSON.stringify(cat('coi').map((i) => i.label)));
  check('attention: a vendor with a newer certificate is not listed (Ironclad renewed)', !cat('coi').some((i) => /Ironclad/.test(i.label)), JSON.stringify(cat('coi').map((i) => i.label)));
  const leaseWant = T.leasesExpiringWithin(60).length; void leaseWant;
  check('attention: leases ending within 60 days are listed (12C)', cat('lease').some((i) => /12C/.test(i.label) && i.days === 25), JSON.stringify(cat('lease').map((i) => [i.label, i.days])));
  check('attention: a superseded (renewed) lease is not listed (7A expired lease)', !cat('lease').some((i) => /7A/.test(i.label)));
  check('attention: Sun Valley contract (65 days) is outside 60 days; Apex contract ended 35 days ago is listed ended', !cat('contract').some((i) => /Sun Valley/.test(i.label)) && cat('contract').some((i) => /Apex/.test(i.label) && i.days < 0), JSON.stringify(cat('contract').map((i) => [i.label, i.days])));
  check('attention: reinspections due or overdue (Saguaro fire, Willow fire overdue, Copper annual)', cat('inspection').length === 3 && cat('inspection').some((i) => i.days < 0), JSON.stringify(cat('inspection').map((i) => [i.label, i.days])));
  check('attention: overdue unpaid invoices only (Sun Valley), never a paid or no-due-date one', cat('invoice').length === 1 && /SV-0912/.test(cat('invoice')[0].label), JSON.stringify(cat('invoice').map((i) => i.label)));
  const firstLate = at.items.findIndex((i) => i.days >= 0); const lastEarly = at.items.map((i) => i.days < 0).lastIndexOf(true);
  check('attention: overdue and expired come first', at.items.some((i) => i.days < 0) && at.items.some((i) => i.days >= 0) && firstLate > 0 && lastEarly < firstLate, JSON.stringify(at.items.map((i) => i.days)));
  const narrow = await propertyAttention(db, { today: TODAY, withinDays: 10 });
  check('attention: a shorter window shows fewer upcoming items', narrow.items.filter((i) => i.days >= 0).every((i) => i.days <= 10) && narrow.items.length < at.items.length);
  const none = await propertyAttention(db, { today: null });
  check('attention: no date, no items', none.items.length === 0);
  const lane = await runProperty(db, cl('What needs attention?'), { today: TODAY });
  check('the attention question answers the same items as the card', lane && lane.facts.length === at.items.length && /need attention/.test(lane.text), lane?.text);
  const due = await runProperty(db, cl("What's due soon?"), { today: TODAY });
  check('"what is due soon" is the attention list', due && due.facts.length === at.items.length);
});

/* 6. company isolation; HVAC has no lane */
for (const ind of ['hvac', 'electrical', 'plumbing']) {
  const p = await H.as(ind, (db) => H.I.packForTenant(db));
  const lane = await laneForPack(p);
  check(`${ind} company never gets the property lane`, ind === 'hvac' ? lane === null : lane?.classify !== classifyProperty && lane?.run !== runProperty);
}
{
  const p = await H.as('property', (db) => H.I.packForTenant(db));
  const lane = await laneForPack(p);
  check('property company gets the property lane', lane?.classify === classifyProperty && lane?.run === runProperty);
}
const BATTERY = ['Which vendor COIs are expired?', 'Which COIs expire in the next 60 days?', 'Which leases expire in the next 90 days?', 'Which units are vacant?', 'Which work orders are open?', 'Which invoices are unpaid?', 'Which inspections failed?', 'Which vendor contracts end in the next 90 days?', 'What needs attention?', 'How many work orders do we have on file?'];
const snapshot = async () => H.as('property', async (db) => { const out = []; for (const x of BATTERY) { const i = cl(x); const r = i ? await runProperty(db, i, { today: TODAY }) : null; out.push(r ? `${r.text}|${r.facts.map((f) => f.value).join(',')}` : 'null'); } const n = (await db.raw('SELECT count(*)::int AS n FROM documents', [])).rows[0].n; return { out, n }; });
const before = await snapshot();
// foreign records written into the other companies, using names and numbers that overlap property ones
const addOther = async (company, rows) => H.addFixture(company, async (db) => {
  for (const [fn, type, fields] of rows) {
    const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: `iso-${company}-${fn}`, stage: 'mapped' });
    for (const [k, v] of fields) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
  }
});
await addOther('hvac', [['hv-wo.pdf', 'work_order', [['service_address', '1200 Mesa Drive'], ['work_order_number', 'WO-99001'], ['status', 'Open'], ['opened_date', '2026-10-01'], ['vendor', 'Rios Plumbing LLC'], ['unit_number', '4B']]], ['hv-inv.pdf', 'invoice', [['invoice_number', 'INV-5001'], ['vendor', 'Rios Plumbing LLC'], ['cost', '999.00'], ['status', 'Unpaid'], ['invoice_due', '2026-09-01']]]]);
await addOther('electrical', [['el-coi.pdf', 'certificate_of_insurance', [['vendor', 'Zeta Electric LLC'], ['coi_expires', '2026-10-10']]], ['el-lease.pdf', 'lease_agreement', [['unit_number', '4B'], ['tenant_name', 'Elec Tenant'], ['lease_end_date', '2026-10-20']]]]);
await addOther('plumbing', [['pl-coi.pdf', 'certificate_of_insurance', [['vendor', 'Quick Drain LLC'], ['coi_expires', '2026-10-08']]], ['pl-inv.pdf', 'invoice', [['invoice_number', 'PL-1'], ['vendor', 'Quick Drain LLC'], ['cost', '50.00'], ['status', 'Unpaid'], ['invoice_due', '2026-09-01']]]]);
const after = await snapshot();
check('company isolation: records added to HVAC, electrical and plumbing companies never change a property answer', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(before.out.filter((x, i) => x !== after.out[i])));
for (const ind of ['hvac', 'electrical', 'plumbing']) await H.as(ind, async (db) => {
  const n = (await db.raw("SELECT count(*)::int AS n FROM documents WHERE original_filename IN ('coi-rios-2026.pdf','lease-4b.pdf','rentroll-saguaro.pdf')", [])).rows[0].n;
  check(`company isolation: property documents are not visible in the ${ind} company`, n === 0);
  const at = await propertyAttention(db, { today: TODAY, withinDays: 60 });
  const own = at.items.map((i) => i.label).join(' ');
  check(`company isolation: property attention in the ${ind} company never shows property records`, !/Saguaro|Summit Elevator|Sun Valley|Apex|Coolwave|Ironclad|Bright Path|SV-0912|IR-221/.test(own), own);
  const r = await runProperty(db, cl('Which units are vacant?'), { today: TODAY });
  check(`company isolation: no property units appear in the ${ind} company`, !/Saguaro|Palo Verde|Copper Canyon|Willow/.test(r ? alltext(r) : ''), r?.text);
  const c = await runProperty(db, cl('Which invoices are unpaid?'), { today: TODAY });
  check(`company isolation: property invoices are not in the ${ind} company`, !/SV-0912|IR-221|BP-3320/.test(c ? alltext(c) : ''), c?.text);
});
await H.as('property', async (db) => {
  const all = (await Promise.all(BATTERY.map(async (x) => { const i = cl(x); const r = i ? await runProperty(db, i, { today: TODAY }) : null; return r ? alltext(r) : ''; }))).join(' ');
  check('the property company never sees other industries\' wording or records', !FOREIGN.test(all) && !/Zeta Electric|Quick Drain|Elec Tenant|WO-99001|\$999\.00/.test(all), all.slice(0, 200));
  const n = (await db.raw('SELECT count(*)::int AS n FROM documents', [])).rows[0].n;
  check('company isolation: the property company holds only its own documents', n === before.n);
});

/* 7. wiring */
{
  const askSrc = fs.readFileSync(new URL('../api/ask.js', import.meta.url), 'utf8');
  check('ask.js runs a pack lane for non-HVAC companies', /laneForPack\(pack\)/.test(askSrc) && /pack\.id !== "hvac"/.test(askSrc));
  const lanesSrc = fs.readFileSync(new URL('../api/_lib/industry/lanes.js', import.meta.url), 'utf8');
  check('lanes.js registers property and still not HVAC', /pack\?\.id === 'property'/.test(lanesSrc) && !/pack\?\.id === 'hvac'/.test(lanesSrc));
  const indSrc = fs.readFileSync(new URL('../api/_lib/routes/industry.js', import.meta.url), 'utf8');
  check('attention route dispatches property', /propertyAttention/.test(indSrc) && /pack\.id !== "property"/.test(indSrc));
  const cardSrc = fs.readFileSync(new URL('../src/components/IndustryAttentionCard.tsx', import.meta.url), 'utf8');
  check('card covers property, with 44px touch targets and a full-width phone button', /property:/.test(cardSrc) && /min-h-\[44px\]/.test(cardSrc) && /w-full/.test(cardSrc) && /'property'/.test(cardSrc));
  const askQs = ['Which vendor insurance certificates need attention?', 'Which leases need attention?', 'Which vendor contracts need attention?', 'Which inspections need a reinspection?', 'Which invoices are overdue?', 'What needs attention?', 'Which vendor insurance certificates expire in the next 60 days?', 'When does the lease for unit 4B end?', 'Which work orders are still open?'];
  for (const q of askQs) { const i = cl(q); check(`card / example question is answered by the lane: ${q}`, i != null && i.kind !== 'decline'); }
  const docTypes = fs.readFileSync(new URL('../src/domains/property/documentTypes.ts', import.meta.url), 'utf8');
  check('client lists vendor-contract and rent-roll with plain-English labels', /id: 'vendor-contract'/.test(docTypes) && /id: 'rent-roll'/.test(docTypes) && /coi_expires: 'Insurance certificate expires'/.test(docTypes) && /contract_end: 'Contract end'/.test(docTypes));
  const hv = fs.readFileSync(new URL('../src/domains/hvac/documentTypes.ts', import.meta.url), 'utf8');
  check('record screens use property labels only for property companies (HVAC table unchanged)', /setFieldLabelIndustry/.test(hv) && /labelIndustry === 'property'/.test(hv));
  const rd = (u) => fs.readFileSync(new URL(u, import.meta.url), 'utf8');
  const dash = rd('../src/screens/DashboardScreen.tsx');
  check('property dashboard hides warranty / equipment sections and uses the neutral empty state', /warrantyFree = industryId === 'property'/.test(dash) && (dash.match(/!warrantyFree/g) ?? []).length >= 4 && /Your needs-attention list will show up here once you've added a few documents\./.test(dash) && /Your warranty alerts will show up here/.test(dash));
  const hv2 = rd('../src/domains/hvac/documentTypes.ts');
  check('property field labels never fall back to the HVAC table (plain words instead)', /PROPERTY_FIELD_LABELS\[fieldKey\] \?\?[^\n]*: prettyKey\(fieldKey\)\)/.test(hv2) && !/FIELD_LABELS\[fieldKey\] \?\? prettyKey/.test(hv2));
  check('record type labels are industry-aware with a plain-words fallback (mobile and records browser)', /documentTypeLabel/.test(rd('../src/mobile/docUtils.ts')) && /documentTypeLabel/.test(rd('../src/components/records/RecordsBrowser.tsx')) && /isPropertyLabelIndustry\(\)\) return PROPERTY_LABELS\.get\(id\) \?\? plainTypeWords\(id\)/.test(rd('../src/domains/documentTypeLabel.ts')));
  const dtp = rd('../src/domains/property/documentTypes.ts');
  check('property wording: certificate / rent roll unit / vendor technician, no HVAC "Warranty registration" or "Service ticket" labels', /coi_expires: 'Insurance certificate expires'/.test(dtp) && /rent_roll_row: 'Rent roll unit'/.test(dtp) && /technician: "Vendor's technician"/.test(dtp) && !/label: 'Warranty registration'|label: 'Service ticket'/.test(dtp));
  const onb = rd('../src/screens/OnboardingScreen.tsx');
  check('industry picker: one-line legend, the one-trade note sits under Continue, cards at least 44px', /Pick the one you do most\.\s*<\/legend>/.test(onb) && onb.includes('A company uses one trade. You can change it any time in Settings, and nothing you file is lost.') && !onb.includes('If you pick wrong') && onb.indexOf('A company uses one trade.') > onb.indexOf('Continue\n') && /min-h-\[44px\]/.test(onb));
  check('mixed attention lists keep the generic ask', /return 'What needs attention\?'/.test(cardSrc));
  const rb = rd('../src/components/records/RecordsBrowser.tsx');
  check('records browser: filters panel closed by default on a phone, 44px controls, property hides the warranty view', /max-width: 639px/.test(rb) && /!min-h-\[44px\] sm:!min-h-\[40px\]/.test(rb) && /\(noWarranties \|\| nonHvac\) && v\.filters\.warrantyBucket/.test(rb) && /max-sm:min-h-\[44px\]/.test(rb));
  check('dashboard: all-clear is suppressed when the industry card lists items; card has no extra bottom padding under its button (the page already clears the floating button)', /hideAllClear=\{industryAttentionCount > 0\}/.test(dash) && /hideAllClear/.test(rd('../src/components/insights/InsightsCard.tsx')) && !/pb-20/.test(cardSrc) && /dw-card p-4 space-y-2/.test(cardSrc));
  const help = fs.existsSync(new URL('../docs/help/30-property-paperwork.md', import.meta.url));
  check('help article for property paperwork exists', help);
}

/* 8. regressions found by QA loop 1 (synthetic paperwork through a stub db; truth written by hand, never taken from the lane) */
{
  const D = (n) => addDays(TODAY, n);
  const fakeDb = (docs) => ({ raw: async () => ({ rows: docs.flatMap((d, i) => Object.entries(d.f).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((value) => ({ id: `d${i}`, filename: `f${i}.pdf`, type: d.type.replace(/-/g, '_'), created_at: i, key: k, value: String(value), page: 1 })))) }) });
  const ask = async (docs, qn) => { const i = classifyProperty(qn, { today: TODAY }); return i ? runProperty(fakeDb(docs), i, { today: TODAY }) : null; };
  const lease = (unit, tenant, start, end, rent, dep, extra = {}) => ({ type: 'lease-agreement', f: { unit_number: unit, tenant_name: tenant, lease_start_date: start, ...(end ? { lease_end_date: end } : {}), rent_amount: rent, security_deposit: dep, ...extra } });
  const coi = (vendor, exp, covs = ['General Liability']) => ({ type: 'certificate-of-insurance', f: { vendor, coi_expires: exp, coverage_type: covs } });
  const inv = (vendor) => ({ type: 'invoice', f: { vendor, invoice_number: `I-${vendor.length}`, cost: '100', status: 'Unpaid', invoice_due: D(10) } });
  const txt = (r) => r?.text ?? '';
  // 1. a lease that has not started yet is not the current lease
  const L1 = [lease('4B', 'Ann Old', D(-360), D(4), 1000, 900), lease('4B', 'Bea New', D(5), D(369), 1100, 1300)];
  { const wl = txt(await ask(L1, 'Who lives in unit 4B?')); check('future lease: who lives in 4B is the tenant whose lease has started; the other tenant appears only as a new lease that starts later', /^Ann Old is the tenant/.test(wl) && /a new lease for Bea New starts/.test(wl) && !/Bea New is the tenant/.test(wl), wl); }
  check('future lease: rent and deposit are the current lease\'s', /1,000\.00/.test(txt(await ask(L1, 'What is the rent for unit 4B?'))) && /900\.00/.test(txt(await ask(L1, 'What is the security deposit for unit 4B?'))) && !/1,100|1,300/.test(txt(await ask(L1, 'What is the rent for unit 4B?')) + txt(await ask(L1, 'What is the security deposit for unit 4B?'))));
  const st = await ask(L1, "When does Bea New's lease start?");
  check('future lease: "when does X\'s lease start" uses the future tense and cites the lease', /starts/.test(txt(st)) && !/started/.test(txt(st)) && st.facts?.every((x) => x.sources?.length));
  const ex30 = await ask(L1, 'Which leases expire in the next 30 days?');
  check('a back-to-back lease for a DIFFERENT tenant is not a renewal: the ending lease is still listed, the new tenant is never listed, no "renewal" wording', /Ann Old/.test(txt(ex30)) && !/Bea New/.test(txt(ex30)) && !/renewal/.test(txt(ex30)), txt(ex30));
  { const nl = txt(await ask(L1, 'When does the lease for unit 4B end?')); check('different-tenant follow-on lease is worded as a new lease', /ends/.test(nl) && /a new lease for Bea New starts/.test(nl) && !/renewal/.test(nl), nl); }
  const L1gap = [lease('4B', 'Ann Old', D(-360), D(4), 1000, 900), lease('4B', 'Bea New', D(30), D(394), 1100, 1300)];
  const gapEx = await ask(L1gap, 'Which leases expire in the next 30 days?');
  check('future lease that is NOT back-to-back (a gap): the current lease that is ending is still listed', /Ann Old/.test(txt(gapEx)) && !/Bea New/.test(txt(gapEx)), txt(gapEx));
  check('future lease: a unit with only a future lease answers nothing about who lives there', (await ask([lease('7Q', 'Cy Next', D(10), D(380), 900, 900)], 'Who lives in unit 7Q?')) == null);
  // 2. negated certificate questions
  const C2 = [coi('Rios Plumbing LLC', D(100), ['General Liability', 'Workers Compensation']), coi('Summit Elevator Co', D(-10), ['General Liability', 'Workers Compensation']), inv('Zeta Pest Control')];
  for (const qn of ['Which vendors do not have workers comp on their certificate?', 'Which vendors do not have general liability on their COI?']) check(`negated coverage question is never read as "no certificate on file": ${qn}`, (await ask(C2, qn)) == null);
  for (const qn of ['Which vendors do not have a current COI?', 'Which vendors have no current certificate of insurance?']) { const r = await ask(C2, qn); check(`"no current COI" includes the expired one and the missing one: ${qn}`, /Summit/.test(txt(r)) && /Zeta/.test(txt(r)) && !/Rios/.test(txt(r)), txt(r)); }
  check('"no COI on file" still lists only vendors with no certificate at all', !/Summit|Rios/.test(txt(await ask(C2, 'Which vendors have no COI on file?'))) && /Zeta/.test(txt(await ask(C2, 'Which vendors have no COI on file?'))));
  // 3. vendor name variants
  const C3 = [coi('Apex Pest Control Services', D(-5)), coi('Apex Pest Control', D(100)), coi('Bravo Plumbing, LLC.', D(-3)), coi('Bravo Plumbing, L.L.C.', D(200))];
  const e3 = await ask(C3, 'Which vendor COIs are expired?');
  check('vendor variants (Services, LLC., L.L.C.) are one vendor: the older expired certificate never makes them expired', e3 && !/Apex|Bravo/.test(txt(e3)), txt(e3));
  check('vendor variants: the current certificate is the latest across spellings', /Apex/.test(txt(await ask(C3, 'Is Apex Pest Control insured?'))) && new RegExp(String(Number(D(100).slice(0, 4)))).test(txt(await ask(C3, 'Is Apex Pest Control insured?'))));
  const C3b = [coi("Charlie's Lawn Care", D(-3)), coi('Charlies Lawn Care', D(200)), coi('Rios Plumbing LLC', D(100))];
  check('names that may be one vendor (Charlie\'s / Charlies) are never declared expired or uninsured', (await ask(C3b, 'Which vendor COIs are expired?')) == null && (await ask(C3b, "Is Charlie's Lawn Care insured?")) == null && (await ask([...C3b, inv('Charlies Lawn Care')], 'Which vendors have no current COI?')) == null);
  // 4. two leases for one unit with the same start date and different rent
  check('two same-start leases with different rent: conflict, no answer', (await ask([lease('6A', 'Dan Fox', D(-100), D(200), 1000, 500), lease('6A', 'Dan Fox', D(-100), D(200), 1200, 500)], 'What is the rent for unit 6A?')) == null);
  check('two copies of the same lease are not a conflict', /1,000\.00/.test(txt(await ask([lease('6A', 'Dan Fox', D(-100), D(200), 1000, 500), lease('6A', 'Dan Fox', D(-100), D(200), 1000, 500)], 'What is the rent for unit 6A?'))));
  // 5. lease against a rent roll that disagrees
  const roll = (rows) => ({ type: 'rent-roll', f: { rent_roll_row: rows } });
  const L5 = [lease('8C', 'Cal Dean', D(-100), D(200), 1000, 500), roll(['unit=8C; tenant=Vacant; status=Vacant; rent=1000', 'unit=2A; tenant=Vacant; status=Vacant; rent=900'])];
  check('lease names a tenant, rent roll says Vacant: who lives, rent and the vacant list all defer', (await ask(L5, 'Who lives in unit 8C?')) == null && (await ask(L5, 'What is the rent for unit 8C?')) == null && (await ask(L5, 'Which units are vacant?')) == null);
  const L5b = [lease('9D', 'Dee Ray', D(-100), D(200), 1000, 500), roll(['unit=9D; tenant=Dee Ray; status=Occupied; rent=1000; lease_end=' + D(150)])];
  check('lease and rent roll disagree about the end date: the rent answer defers too', (await ask(L5b, 'What is the rent for unit 9D?')) == null && (await ask(L5b, 'When does the lease for unit 9D end?')) == null);
  // 6. "Lease End Date: Month-to-Month"
  const pg = [{ page_no: 1, text: 'RESIDENTIAL LEASE AGREEMENT\nTenant Name: Ivy Moore\nUnit: 3C\nProperty: 100 Main St, Mesa AZ\nLease Start Date: 01/01/2024\nLease End Date: Month-to-Month\nMonthly Rent: $1,200.00\n' }];
  const ml = extractProperty(pg, { today: TODAY });
  check('extractor: "Lease End Date: Month-to-Month" is a status with no end date', ml?.type === 'lease-agreement' && ml.fields.some((x) => x.key === 'status' && /month-to-month/i.test(x.value)) && !ml.fields.some((x) => x.key === 'lease_end_date'), JSON.stringify(ml?.fields));
  const MT = [{ type: 'lease-agreement', f: Object.fromEntries((ml?.fields ?? []).map((x) => [x.key, x.value])) }];
  const me = await ask(MT, 'When does the lease for unit 3C end?');
  check('lane: a month-to-month lease has no end date and says so', /month-to-month/i.test(txt(me)) && /no end date/.test(txt(me)) && /^Yes/.test(txt(await ask(MT, 'Is the lease for unit 3C month to month?'))), txt(me));
  // ---- loop 2
  const insp = (unit, date, result, type = 'Annual', extra = {}) => ({ type: 'inspection-report', f: { unit_number: unit, service_date: date, inspection_result: result, inspection_type: type, ...extra } });
  const I1 = [insp('10A', D(-35), 'Failed'), insp('10A', D(-16), 'Passed'), insp('11B', D(-30), 'Passed'), insp('11B', D(-5), 'Failed')];
  const f1 = await ask(I1, 'Which units failed inspection?');
  check('failed inspections use the LATEST inspection per unit (failed then passed is not failed; passed then failed is)', f1 && /11B/.test(txt(f1)) && !/10A/.test(txt(f1)), txt(f1));
  const f2 = await ask(I1, 'How many inspections failed?');
  check('failed count uses the latest inspection per unit too', /^1 inspection/.test(txt(f2)), txt(f2));
  const I2 = [insp('12C', D(-5), 'Failed', 'Fire', { reinspection_due: D(10) }), insp('12C', D(-1), 'Passed', 'Reinspection'), insp('13D', D(-5), 'Failed', 'Fire', { reinspection_due: D(10) })];
  const r2 = await ask(I2, 'Which inspections need a reinspection?');
  check('a later reinspection clears the need for one', r2 && /13D/.test(txt(r2)) && !/12C/.test(txt(r2)), txt(r2));
  check('"inspection" is not repeated in lane wording', !/\binspection inspection\b/i.test(txt(await ask([insp('14A', D(-3), 'Failed', 'Annual inspection')], 'Which units failed inspection?'))));
  check('negated expired / double-negative COI lists are never read as "no COI on file"', (await ask(C2, "Which vendors don't have expired COIs?")) == null && (await ask(C2, 'Which vendors have no COI that is not expired?')) == null);
  const cp = DOCS.find((d) => d.filename === 'coi-rios-2026.pdf').pages;
  const addLine = (t) => cp.map((p, i) => (i === 0 ? { ...p, text: `${p.text}\n${t}` } : p));
  check('a certificate printing "Policy cancelled effective ..." is never read as a current certificate', extractProperty(cp, { today: TODAY }) != null && extractProperty(addLine('Policy cancelled effective 09/01/2026'), { today: TODAY }) == null && extractProperty(addLine('Notice of non-renewal received'), { today: TODAY }) == null);
  check('the standard "should any of the above policies be cancelled" notice is not a cancellation', extractProperty(addLine('SHOULD ANY OF THE ABOVE DESCRIBED POLICIES BE CANCELLED BEFORE THE EXPIRATION DATE THEREOF, NOTICE WILL BE DELIVERED IN ACCORDANCE WITH THE POLICY PROVISIONS.'), { today: TODAY }) != null);
  const spread = await ask([{ type: 'certificate-of-insurance', f: { vendor: 'Rios Plumbing LLC', coi_expires: D(30), policy_expiry: [D(30), D(200)], coverage_type: ['General Liability', 'Workers Compensation'] } }], 'Is Rios Plumbing insured?');
  check('policies expiring on different dates: every date is stated', txt(spread).includes(`${new Date(D(200) + 'T00:00:00Z').getUTCFullYear()}`) && /different dates/.test(txt(spread)) && /earliest/.test(txt(spread)), txt(spread));
  const invs = (n) => Array.from({ length: n }, (_, i) => ({ type: 'invoice', f: { vendor: `Vend ${i} Co`, invoice_number: `X-${100 + i}`, cost: String(100 + i), status: 'Unpaid', invoice_due: D(-(i + 1)) } }));
  const ov = await ask(invs(12), 'Which invoices are overdue?');
  check('overdue invoices are ordered by due date (oldest first) and capped with "and N more"', ov && txt(ov).indexOf('X-111') < txt(ov).indexOf('X-110') && /and 2 more/.test(txt(ov)) && !/X-100/.test(txt(ov)), txt(ov));
  const wo = (no, prop, status) => ({ type: 'work-order', f: { work_order_number: no, property_name: prop, status, opened_date: D(-10), service_date: D(-5), unit_number: '1A' } });
  const w1 = await ask([wo('WO-5551', 'Alpha Apartments', 'Open'), wo('WO-5551', 'Beta Villas', 'Completed')], 'What is the status of WO-5551?');
  check('one work order number at two properties with different statuses asks which property', w1?.clarify === true, txt(w1));
  const w2 = await ask([wo('WO-5551', 'Alpha Apartments', 'Open'), wo('WO-5551', 'Beta Villas', 'Open')], 'What is the status of WO-5551?');
  check('one work order number at two properties with the same status says so for both', /Open/.test(txt(w2)) && /Alpha/.test(txt(w2)) && /Beta/.test(txt(w2)) && /each property/.test(txt(w2)), txt(w2));
  const invPage = (bal, paid) => [{ page_no: 1, text: `INVOICE\nInvoice No: INV-9001\nVendor: Rios Plumbing LLC\nInvoice Date: 09/01/2026\nDue Date: 09/20/2026\nWork: Repair\nTotal: $300.00\nAmount Paid: ${paid}\nBalance Due: ${bal}\n` }];
  const stOf = (pg) => extractProperty(pg, { today: TODAY })?.fields.find((x) => x.key === 'status')?.value;
  check('invoice status is read from the money lines when they agree (paid in full / nothing paid) and left alone when partial', stOf(invPage('$0.00', '$300.00')) === 'Paid' && stOf(invPage('$300.00', '$0.00')) === 'Unpaid' && stOf(invPage('$100.00', '$200.00')) == null);
  const unk = await ask([{ type: 'invoice', f: { vendor: 'Rios Plumbing LLC', invoice_number: 'Z-1', cost: '50', status: 'Hmm', invoice_due: D(-5) } }], 'What needs attention?');
  check('attention: an invoice whose status could not be read is not listed but is counted in the answer', /could not be read/.test(txt(unk)) && /^None/.test(txt(unk)), txt(unk));
  // ---- loop 3
  const only = (type, f) => [{ type, f }];
  const noRoll = await ask(only('lease-agreement', { unit_number: '1A', tenant_name: 'Al Bo', lease_start_date: D(-30), lease_end_date: D(300), rent_amount: '900' }), 'Which units are vacant?');
  check('no rent roll on file: vacancy is never answered "none" / 0', /rent roll/i.test(txt(noRoll)) && !/^None|^0 /.test(txt(noRoll)), txt(noRoll));
  const cntNo = await ask(only('lease-agreement', { unit_number: '1A', tenant_name: 'Al Bo', lease_start_date: D(-30), lease_end_date: D(300), rent_amount: '900' }), 'How many units are vacant?');
  check('no rent roll on file: the vacant count is not 0 either', !/^0\b|^None/.test(txt(cntNo)), txt(cntNo));
  const rollA = { type: 'rent-roll', f: { property_name: 'Alpha Apartments', rent_roll_row: ['unit=1A; tenant=Al Bo; status=Occupied; rent=900'] } };
  const leaseB = { type: 'lease-agreement', f: { property_name: 'Beta Villas', unit_number: '2B', tenant_name: 'Cy Di', lease_start_date: D(-30), lease_end_date: D(300), rent_amount: '800' } };
  check('a rent roll covering one property never says "none vacant" for a property it does not cover', (await ask([rollA, leaseB], 'Which units are vacant?')) == null);
  for (const [qn, re] of [['Which inspections failed?', /inspection/], ['Which vendor contracts need attention?', /contract/], ['Which work orders are open?', /work order/], ['Which invoices are overdue?', /invoice/], ['Which vendor COIs are expired?', /certificate/]]) {
    const r = await ask(only('lease-agreement', { unit_number: '1A', tenant_name: 'Al Bo', lease_start_date: D(-30), lease_end_date: D(300) }), qn);
    check(`empty corpus: "${qn}" says nothing of that kind is on file, not "none"`, re.test(txt(r)) && /are on file yet/.test(txt(r)) && !/^None/.test(txt(r)), txt(r));
  }
  const ivp = (extra) => [{ page_no: 1, text: `INVOICE\nInvoice No: INV-9100\nVendor: Rios Plumbing LLC\nInvoice Date: 09/01/2026\nDue Date: 09/20/2026\nWork: Repair\n${extra}\n` }];
  const costOf = (pg) => extractProperty(pg, { today: TODAY })?.fields.find((x) => x.key === 'cost')?.value;
  check('invoice with a previous balance: "Total Due" is not read as the cost', costOf(ivp('Previous Balance: $500.00\nCurrent Charges: $300.00\nTotal Due: $800.00')) === '300.00' && costOf(ivp('Previous Balance: $500.00\nTotal Due: $800.00')) == null && costOf(ivp('Total Due: $800.00 ($300.00 current)')) === '300.00' && costOf(ivp('Past Due: $500.00\nTotal Due: $800.00')) == null && costOf(ivp('Total: $300.00')) === '300.00');
  const iv2 = [{ page_no: 1, text: 'INVOICE\nInvoice No: INV-9100\nVendor: Rios Plumbing LLC\nInvoice Date: 09/01/2026\nPrevious Balance: $500.00' }, { page_no: 2, text: 'Total Due: $800.00' }];
  check('invoice with a previous balance on another page: still no cost', costOf(iv2) == null);
  const vend = (name, exp) => ({ type: 'certificate-of-insurance', f: { vendor: name, coi_expires: exp, coverage_type: ['General Liability'] } });
  for (const [name, qn] of [['Shared Vendor LLC', 'Shared Vendor LLC coi'], ['Zulu Inc', 'zulu inc coi expiration'], ['Bravo Plumbing & Heating LLC', "When does Bravo Plumbing & Heating's coi expire?"], ['Shared Vendor LLC', 'Is Shared Vendor LLC insured?']]) {
    const r = await ask([vend(name, D(90)), vend('Other Vendor Co', D(10))], qn);
    check(`a vendor named with its legal suffix / ampersand / possessive is answered: ${qn}`, r && !r.clarify && new RegExp(String(Number(D(90).slice(0, 4)))).test(txt(r)) && txt(r).includes(name.replace(/ (LLC|Inc)$/, '')), txt(r));
  }
  const hdr = (line) => [{ page_no: 1, text: `WORK ORDER\nWork Order #: WO-7001\n${line}\nProperty: Alpha Apartments, 100 Main St, Mesa AZ\nOpened: 09/01/2026\nScheduled: 09/05/2026\nStatus: Open\nWork Performed: Fix sink\nVendor: Rios Plumbing LLC\n` }];
  const unitOf = (pg) => extractProperty(pg, { today: TODAY })?.fields.find((x) => x.key === 'unit_number')?.value;
  check('bare unit lines (no colon) are read as the unit', ['Unit #4-B', 'Unit 4B', 'Apt 4B', 'Apt. 4B', 'Unit No. 4B'].every((l) => String(unitOf(hdr(l))).replace(/[^A-Za-z0-9]/g, '') === '4B') && String(unitOf(hdr('Suite 210'))) === '210' && String(unitOf(hdr('Unit # 12'))) === '12', JSON.stringify(['Unit #4-B', 'Suite 210', 'Unit # 12'].map((l) => unitOf(hdr(l)))));
  check('two different bare unit lines in the header: no unit is guessed', unitOf(hdr('Unit 4B\nUnit 5C')) == null);
  const ivn = extractProperty([{ page_no: 1, text: 'INVOICE\nInvoice #: 78\nVendor: Rios Plumbing LLC\nInvoice Date: 09/01/2026\nTotal: $120.00\n' }], { today: TODAY });
  check('a two-digit invoice number is read', ivn?.fields.some((x) => x.key === 'invoice_number' && x.value === '78'), JSON.stringify(ivn?.fields.map((x) => [x.key, x.value])));
  // ---- loop 4
  check('a certificate with a bare cancelled / void / superseded / terminated status or a cancellation date is never read', ['Status: CANCELLED', 'VOID', 'SUPERSEDED', 'Date of cancellation: 09/01/2026', 'Cancelled effective 09/01/2026', 'Policy Status: Terminated', 'Status: Rescinded', 'Revoked'].every((l) => extractProperty(addLine(l), { today: TODAY }) == null));
  const lp = (extra) => [{ page_no: 1, text: `RESIDENTIAL LEASE AGREEMENT\nTenant Name: Ivy Moore\nUnit: 3C\nProperty: 100 Main St, Mesa AZ\nLease Start Date: 01/01/2024\n${extra}\nMonthly Rent: $1,200.00\n` }];
  const stOf2 = (pg) => extractProperty(pg, { today: TODAY })?.fields.find((x) => x.key === 'status')?.value;
  check('extractor: terminated / notice to vacate / move-out date leases carry a status, even with a date', /terminated/i.test(stOf2(lp('Lease End Date: 12/31/2026\nLease Status: Terminated 08/01/2026'))) && /terminated/i.test(stOf2(lp('Lease End Date: 12/31/2026\nTerminated 08/01/2026'))) && /notice to vacate/i.test(stOf2(lp('Lease End Date: 12/31/2026\nNotice to Vacate given 09/01/2026'))) && /notice to vacate/i.test(stOf2(lp('Lease End Date: 12/31/2026\nMove-out date: 10/15/2026'))));
  const termL = [lease('5C', 'Pat Kim', D(-400), D(200), 1200, 800, { status: 'Terminated' })];
  check('terminated lease: who lives / rent / deposit / expiring never present the tenant as current', (await ask(termL, 'Who lives in unit 5C?')) == null && (await ask(termL, 'What is the rent for unit 5C?')) == null && (await ask(termL, 'What is the security deposit for unit 5C?')) == null && !/Pat Kim/.test(txt(await ask(termL, 'Which leases expire in the next 365 days?'))));
  check('extractor: "Term: Month-to-Month" / "Tenancy: month to month" / bare MTM line with no end date is month-to-month, but not when a fixed end date is printed', ['Term: Month-to-Month', 'Tenancy: month to month', 'MTM', 'Month to Month', 'Lease Type: MTM'].every((l) => /month-to-month/i.test(stOf2(lp(l)) ?? '')) && stOf2(lp('Lease End Date: 12/31/2026\nTerm: Month-to-Month')) == null);
  const nothing = await ask([], 'What needs attention?');
  check('attention question on a company with no documents says nothing is on file yet', /on file yet/.test(txt(nothing)) && !/^None/.test(txt(nothing)), txt(nothing));
  const REN = [lease('4B', 'Ann Old', D(-300), D(20), 1000, 900), lease('4B', 'Ann Old', D(21), D(385), 1050, 900)];
  const re1 = await ask(REN, 'When does the lease for unit 4B end?');
  check('signed renewal: "when does the lease end" says so', /ends/.test(txt(re1)) && /renewal starting/.test(txt(re1)), txt(re1));
  const re2 = await ask(REN, 'Which leases expire in the next 30 days?'); const re3 = await ask(REN, 'How many leases expire in the next 30 days?');
  check('signed renewal: not listed or counted as expiring, and the answer says why', /^None/.test(txt(re2)) && /renewal/.test(txt(re2)) && /^0 leases/.test(txt(re3)), `${txt(re2)} || ${txt(re3)}`);
  const at = await H.as('property', async () => propertyAttention(fakeDb(REN), { today: TODAY, withinDays: 60 }));
  check('signed renewal: not an attention item', at.items.length === 0, JSON.stringify(at.items));
  const END = [lease('5C', 'Pat Kim', D(-400), D(-6), 1200, 800)];
  const en1 = await ask(END, 'What is the rent for Pat Kim?'); const en2 = await ask(END, 'What is the security deposit for unit 5C?');
  check('ended lease: rent and deposit say the lease ended, not "current"', /ended/.test(txt(en1)) && /1,200\.00/.test(txt(en1)) && /ended/.test(txt(en2)) && /800\.00/.test(txt(en2)) && !/^Rent for/.test(txt(en1)), `${txt(en1)} || ${txt(en2)}`);
  const unr = await propertyAttention(fakeDb([{ type: 'invoice', f: { vendor: 'Rios Plumbing LLC', invoice_number: 'Z-1', cost: '50', status: 'Hmm', invoice_due: D(-5) } }]), { today: TODAY, withinDays: 60 });
  check('attention route exposes the unreadable-status invoice count as a plain JSON number field', unr.unreadableInvoices === 1 && Array.isArray(unr.items) && unr.items.length === 0 && JSON.parse(JSON.stringify(unr)).unreadableInvoices === 1);
  const mp = ['MP-1', 'MP-2'].map((n) => ({ type: 'invoice', f: { vendor: 'Multi Page Roofing LLC', invoice_number: n, cost: '100', status: 'Unpaid', invoice_due: D(10) } }));
  const mpa = await ask(mp, 'Which invoices are unpaid from Multi Page Roofing?');
  check('a vendor-scoped invoice list does not repeat the vendor name on every line', (txt(mpa).match(/Multi Page Roofing/g) ?? []).length === 1 && /MP-1/.test(txt(mpa)), txt(mpa));
  // ---- loop 5
  const rrP = (rows) => [{ page_no: 1, text: `RENT ROLL\nSaguaro Ridge Apartments\nUnit | Tenant | Rent | Lease End | Status\n${rows.join('\n')}\n` }];
  const rrOut = (rows) => extractProperty(rrP(rows), { today: TODAY });
  const rrBad = rrOut(['3A | Ann Lee | $1,000.00 | 12/31/2026 | Occupied', '3E | | $1,010.00 | | Vacant | extra', '3H | | $1,040.00 | | Vacant | x | y']);
  const unreadN = Number(rrBad?.fields.find((x) => x.key === 'rent_roll_unread')?.value ?? 0);
  const readUnits = (rrBad?.fields ?? []).filter((x) => x.key === 'rent_roll_row').map((x) => x.value);
  check('rent roll rows with extra cells are read with their Vacant status or counted unread, never dropped silently', ['3E', '3H'].every((u) => readUnits.some((r) => r.startsWith(`unit=${u};`) && /Vacant/i.test(r)) ) || unreadN >= 2, JSON.stringify([unreadN, readUnits]));
  const rrDocs = [{ type: 'rent-roll', f: { property_name: 'Saguaro Ridge Apartments', rent_roll_row: ['unit=3A; tenant=Ann Lee; rent=1000.00', 'unit=3J; status=Vacant; rent=1030.00'], rent_roll_unread: '2' } }];
  const vcount = await ask(rrDocs, 'How many units are vacant?'); const vnone = await ask([{ type: 'rent-roll', f: { property_name: 'Saguaro Ridge Apartments', rent_roll_row: ['unit=3A; tenant=Ann Lee; rent=1000.00'], rent_roll_unread: '2' } }], 'Which units are vacant?');
  check('vacancy count / "none" is never answered while rent roll rows were unread', vcount == null && vnone == null, `${txt(vcount)} || ${txt(vnone)}`);
  const ok1 = ['Status: Active', 'CERTIFICATE HOLDER', 'CANCELLATION', 'Cancellation: 30 days notice to certificate holder', 'Cancellation Notice: 30 days written notice', 'Void where prohibited by law', 'Void if altered', 'Terminated: no', 'Terminated drivers excluded', 'Cancelled drivers: none'];
  check('boilerplate that merely contains cancel / void / terminate never drops a certificate', ok1.every((l) => extractProperty(addLine(l), { today: TODAY }) != null), ok1.filter((l) => extractProperty(addLine(l), { today: TODAY }) == null).join(' | '));
  const ok3 = ['Terminated early: no', 'Termination Date: N/A', 'Notice given: none', 'Notice to vacate: N/A', 'Lease Type: MTM not permitted', 'Term: month-to-month after the initial term ends'];
  check('lease lines that merely contain terminated / notice / month-to-month do not set a status', ok3.every((l) => stOf2(lp(`Lease End Date: 12/31/2026\n${l}`)) == null) && stOf2(lp('Lease Type: Fixed Term\nMonth-to-month')) == null && stOf2([{ page_no: 1, text: 'RESIDENTIAL LEASE AGREEMENT\nTenant Name: Ivy Moore\nUnit: 3C\nProperty: 100 Main St, Mesa AZ\nLease Start Date: 01/01/2024\nLease Type: Fixed Term\nMonth-to-month\nMonthly Rent: $1,200.00\n' }]) == null, ok3.map((l) => stOf2(lp(`Lease End Date: 12/31/2026\n${l}`))).join(','));
  const shortNames = ['Li Xu', 'Ed Wu', 'Bo Ng'].map((n) => extractProperty([{ page_no: 1, text: `RESIDENTIAL LEASE AGREEMENT\nTenant Name: ${n}\nUnit: 3C\nProperty: 100 Main St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End Date: 12/31/2026\nMonthly Rent: $1,200.00\n` }], { today: TODAY })?.fields.find((x) => x.key === 'tenant_name')?.value);
  check('short tenant names (Li Xu, Ed Wu, Bo Ng) are read', shortNames.join('|') === 'Li Xu|Ed Wu|Bo Ng', shortNames.join('|'));
  const lx = await ask([lease('9A', 'Li Xu', D(-100), D(200), 1200, 600), { type: 'rent-roll', f: { rent_roll_row: ['unit=9A; tenant=Li Xu; rent=1200.00'] } }], 'What is the rent for unit 9A?');
  check('short names match between the lease and the rent roll (no false conflict)', /1,200\.00/.test(txt(lx)), txt(lx));
  const SG = (u, t, st, en) => ({ type: 'lease-agreement', f: { property_name: 'Saguaro Ridge Apartments', unit_number: u, tenant_name: t, lease_start_date: st, lease_end_date: en, rent_amount: '1000' } });
  const PV = (u, t, st, en) => ({ type: 'lease-agreement', f: { property_name: 'Palo Verde Villas', unit_number: u, tenant_name: t, lease_start_date: st, lease_end_date: en, rent_amount: '800' } });
  const rn = await ask([SG('2A', 'Ex Pire', D(-300), D(10)), SG('2A', 'Ex Pire', D(11), D(375)), PV('2A', 'Pv Pete', D(-300), D(12)), PV('2A', 'Pv Pete', D(13), D(377))], 'Which leases expire in the next 30 days?');
  check('renewal notes name the property when a unit label exists at two properties', /2A at Saguaro/.test(txt(rn)) && /2A at Palo Verde/.test(txt(rn)), txt(rn));
  const cr = (n, tot) => ({ type: 'invoice', f: { vendor: 'Credit Co LLC', invoice_number: n, cost: tot, status: 'Unpaid', invoice_due: D(-5) } });
  const crT = await ask([cr('A-1', '500'), cr('A-2', '-100')], 'How much have we spent with Credit Co?');
  const crU = await ask([cr('A-1', '500'), cr('A-2', '-100')], 'How much do we owe on unpaid invoices?');
  check('a credit memo (negative invoice) makes the lane decline the total (null -> model), while the same question without it is answered', crT == null && crU == null && /500\.00/.test(txt(await ask([cr('A-1', '500')], 'How much have we spent with Credit Co?'))), `${txt(crT)} || ${txt(crU)}`);
  const negEx = (t) => extractProperty([{ page_no: 1, text: `INVOICE\nInvoice No: INV-9200\nVendor: Rios Plumbing LLC\nInvoice Date: 09/01/2026\n${t}\n` }], { today: TODAY })?.fields.find((x) => x.key === 'cost')?.value;
  check('extractor never reads a credit memo total as a positive amount', ['Invoice Total: $-100.00', 'Total: ($100.00)', 'Total: -$100.00', 'CREDIT MEMO\nTotal: $100.00'].every((t) => { const v = negEx(t); return v == null || Number(v) < 0; }), ['Invoice Total: $-100.00', 'Total: ($100.00)', 'CREDIT MEMO\nTotal: $100.00'].map(negEx).join(','));
  const ct = (auto) => [{ type: 'vendor-contract', f: { vendor: 'Sun Landscaping LLC', contract_start: D(-300), contract_end: D(65), auto_renew: auto, monthly_amount: '500' } }];
  const ce = await ask(ct('yes'), 'When does the Sun Landscaping contract end?'); const cn = await ask(ct('no'), 'When does the Sun Landscaping contract end?');
  check('an auto-renewing contract end date says "current term ends ... it auto-renews"; a non-renewing one is unchanged', /current term ends/.test(txt(ce)) && /auto-renews/.test(txt(ce)) && /ends/.test(txt(cn)) && !/auto-renews|current term/.test(txt(cn)), `${txt(ce)} || ${txt(cn)}`);
  check('a renewal notice deadline question goes to the normal path', (await ask(ct('yes'), 'What is the renewal notice deadline for the Sun Landscaping contract?')) == null);
  // ---- loop 6
  { // every question the attention card can ask is answered by the lane on the fixtures (strictly: not null, not a decline, not a clarify)
    const cardTxt = fs.readFileSync(new URL('../src/components/IndustryAttentionCard.tsx', import.meta.url), 'utf8');
    const seg = cardTxt.slice(cardTxt.indexOf('property: (_first'), cardTxt.indexOf('// one category on the card')) + cardTxt.slice(cardTxt.indexOf('const PROPERTY_ASK'), cardTxt.indexOf('export function IndustryAttentionCard'));
    const asks = [...new Set([...seg.matchAll(/'((?:Which|What|How)[^']*\?)'/g)].map((m) => m[1]))];
    check(`the attention card asks ${asks.length} distinct questions`, asks.length >= 6, asks.join(' | '));
    await H.as('property', async (db) => { for (const a of asks) { const i = cl(a); const r = i ? await runProperty(db, i, { today: TODAY }) : null; check(`card ask is answered by the lane: ${a}`, !!r && !r.decline && !r.clarify, txt(r)); } });
    const cattn = await H.as('property', async (db) => { const r = await runProperty(db, cl('Which vendor insurance certificates need attention?'), { today: TODAY }); return r; });
    check('"certificates need attention" covers the expired AND the expiring ones', /Apex/.test(txt(cattn)) && /Rios/.test(txt(cattn)) && /Summit/.test(txt(cattn)) && !/Ironclad/.test(txt(cattn)), txt(cattn));
  }
  const hoaQ = await H.as('property', async (db) => { const i = cl('How many inspection reports are on file for HOA compliance?'); return i ? runProperty(db, i, { today: TODAY }) : null; });
  check('a pure count about HOA compliance inspection reports is answered, not declined', hoaQ && !hoaQ.decline && /^\d+ inspection report/.test(txt(hoaQ)), txt(hoaQ));
  check('real compliance judgement questions are still declined', ['Is Rios Plumbing in compliance with our insurance requirements?', 'Does the Apex contract meet the code?'].every((x) => cl(x)?.kind === 'decline'));
  const g1 = await ask([insp('15A', D(-5), 'Failed', 'Fire', { reinspection_due: D(10) })], 'Which inspections need a reinspection?');
  const g2 = await ask(ct('yes'), 'Which contracts renew automatically?');
  const g3 = await ask([insp('15A', D(-5), 'Failed', 'Fire', { reinspection_due: D(10) }), insp('15B', D(-4), 'Failed', 'Fire', { reinspection_due: D(11) })], 'Which inspections need a reinspection?');
  check('count of one agrees with its verb ("1 inspection needs", "1 vendor contract renews") and two agree plural', /^1 inspection needs a reinspection/.test(txt(g1)) && /^1 vendor contract renews automatically/.test(txt(g2)) && /^2 inspections need a reinspection/.test(txt(g3)), `${txt(g1)} || ${txt(g2)} || ${txt(g3)}`);
  check('dotted dates: 02.03.2027 is unreadable, 25.03.2027 is day-first, 03.25.2027 is month-first', (() => { const e = (d) => extractProperty([{ page_no: 1, text: `VENDOR CONTRACT\nVendor: Sun Landscaping LLC\nContract Start: 01/01/2026\nContract End: ${d}\nMonthly Fee: $500.00\nScope: Lawn care\n` }], { today: TODAY })?.fields.find((x) => x.key === 'contract_end')?.value; return e('02.03.2027') == null && e('25.03.2027') === '2027-03-25' && e('03.25.2027') === '2027-03-25'; })());
  const vcNo = await ask(only('lease-agreement', { unit_number: '1A', tenant_name: 'Al Bo', lease_start_date: D(-30), lease_end_date: D(300) }), 'How many units are vacant?');
  check('vacancy count with no rent roll: plain wording', txt(vcNo) === "There are no rent rolls on file yet, so I can't count vacant units.", txt(vcNo));
  const okCo = extractProperty([{ page_no: 1, text: 'INVOICE\nInvoice No: INV-9300\nInvoice From: Ok Co\nInvoice Date: 09/01/2026\nTotal: $120.00\n' }], { today: TODAY });
  check('a short company name after "Invoice From:" is read', okCo?.fields.some((x) => x.key === 'vendor' && x.value === 'Ok Co'), JSON.stringify(okCo?.fields.map((x) => [x.key, x.value])));
  check('card heading: every trade says "Needs attention"', />Needs attention<\/h2>/.test(fs.readFileSync(new URL('../src/components/IndustryAttentionCard.tsx', import.meta.url), 'utf8')));
  // ---- loop 7
  { // card items == Ask-answer items, per category, on ended + upcoming fixtures
    const F7 = [
      lease('1A', 'Ended Recently', D(-385), D(-20), 1000, 900), lease('2B', 'Ending Soon', D(-335), D(30), 1000, 900), lease('3C', 'Far Away', D(-100), D(200), 1000, 900), lease('4D', 'Long Ago', D(-700), D(-300), 1000, 900),
      coi('Old Cert Co', D(-15)), coi('Soon Cert Co', D(25)), coi('Fine Cert Co', D(300)),
      { type: 'vendor-contract', f: { vendor: 'Ended Contract Co', contract_start: D(-300), contract_end: D(-10), auto_renew: 'No', monthly_amount: '500' } },
      { type: 'vendor-contract', f: { vendor: 'Ending Contract Co', contract_start: D(-300), contract_end: D(20), auto_renew: 'No', monthly_amount: '500' } },
      { type: 'vendor-contract', f: { vendor: 'Later Contract Co', contract_start: D(-300), contract_end: D(250), auto_renew: 'No', monthly_amount: '500' } },
      insp('5E', D(-30), 'Fail', 'Annual', { reinspection_due: D(15) }),
      inv('Late Pay Co'),
    ];
    F7[F7.length - 1].f.invoice_due = D(-5);
    const at7 = await propertyAttention(fakeDb(F7), { today: TODAY, withinDays: 60 });
    const asks7 = { coi: 'Which vendor insurance certificates need attention?', lease: 'Which leases need attention?', contract: 'Which vendor contracts need attention?', inspection: 'Which inspections need a reinspection?', invoice: 'Which invoices are overdue?' };
    for (const [cat, q] of Object.entries(asks7)) {
      const cardIds = at7.items.filter((x) => x.category === cat).map((x) => x.documentId).sort();
      const r7 = await ask(F7, q);
      const ansIds = [...new Set((r7?.facts ?? []).map((f) => f.sources?.[0]?.documentId))].sort();
      check(`card items == Ask answer items (${cat}): ${cardIds.length} item(s)`, cardIds.length > 0 && JSON.stringify(cardIds) === JSON.stringify(ansIds), `${JSON.stringify(cardIds)} vs ${JSON.stringify(ansIds)} :: ${txt(r7)}`);
    }
    check('ended leases are listed under "Already ended" and upcoming ones as ending; 200-day and 300-day-old ones are not', /ending: .*Ending Soon/.test(txt(await ask(F7, 'Which leases need attention?'))) && /Already ended: .*Ended Recently/.test(txt(await ask(F7, 'Which leases need attention?'))) && !/Far Away|Long Ago/.test(txt(await ask(F7, 'Which leases need attention?'))));
    check('contracts: ended and ending listed, later one not', /Ending Contract Co/.test(txt(await ask(F7, 'Which vendor contracts need attention?'))) && /Already ended: .*Ended Contract Co/.test(txt(await ask(F7, 'Which vendor contracts need attention?'))) && !/Later Contract/.test(txt(await ask(F7, 'Which vendor contracts need attention?'))));
    const sum7 = txt(await ask(F7, 'What needs attention?'));
    check('what needs attention: nouns pluralised, zero-count categories omitted', /\b2 vendor certificates of insurance\b/.test(sum7) && /\b2 leases\b/.test(sum7) && /\b2 vendor contracts\b/.test(sum7) && /\b1 reinspection\b/.test(sum7) && /\b1 overdue invoice\b/.test(sum7) && !/\b0 /.test(sum7), sum7);
    const sum7b = txt(await ask([lease('2B', 'Ending Soon', D(-335), D(30), 1000, 900)], 'What needs attention?'));
    check('what needs attention: one item reads "1 item needs attention: 1 lease" with no zero categories', /^1 item needs attention \(within 60 days\): 1 lease\.$/.test(sum7b), sum7b);
  }
  { const gi = txt(await ask([insp('5E', D(-30), 'Fail', 'Inspection', {})], 'Which inspections failed?'));
    check('generic inspection kind is not doubled', !/inspection inspection/i.test(gi) && /inspection/i.test(gi), gi);
    const gi2 = txt(await ask([insp('5E', D(-30), 'Fail', 'Inspection', { reinspection_due: D(15) })], 'Which inspections need a reinspection?'));
    check('generic inspection kind is not doubled (reinspection)', !/inspection inspection/i.test(gi2), gi2); }
  { const pipe = extractProperty([{ page_no: 1, text: 'CERTIFICATE OF LIABILITY INSURANCE\nInsured: Bravo Pools Inc | Policy Expiration: 12/31/2026 | Policy No: GL-1\nGeneral Liability\n' }], { today: TODAY });
    const f = (r, k) => r?.fields.find((x) => x.key === k)?.value;
    check('pipe one-line layout: vendor has no pipe and the expiry is read', f(pipe, 'vendor') === 'Bravo Pools Inc' && f(pipe, 'coi_expires') === '2026-12-31', JSON.stringify(pipe?.fields.map((x) => [x.key, x.value])));
    const two = (end) => extractProperty([{ page_no: 1, text: `RESIDENTIAL LEASE AGREEMENT\nTenant Name: Ivy Moore\nUnit: 3C\nProperty: 100 Main St, Mesa AZ\n${end}\nMonthly Rent: $1,200.00\n` }], { today: TODAY });
    check('two-column lease line: both start and end read, single and wide spacing', ['Lease Start Date: 11/01/2025 Lease End Date: 10/31/2026', 'Lease Start Date: 11/01/2025    Lease End Date: 10/31/2026'].every((t) => { const r = two(t); return f(r, 'lease_start_date') === '2025-11-01' && f(r, 'lease_end_date') === '2026-10-31'; }));
    check('a lease whose printed end date cannot be read is rejected, not accepted without an end', two('Lease Start Date: 11/01/2025\nLease End Date: smudged') === null && two('Lease Start Date: 11/01/2025    Lease End Date: ??') === null);
    check('a lease with no end label at all is still accepted (end unknown)', two('Lease Start Date: 11/01/2025') != null); }
  { const rb = fs.readFileSync(new URL('../src/components/records/RecordsBrowser.tsx', import.meta.url), 'utf8');
    check('records browser: phone layout only for known non-HVAC industries; HVAC keeps the base classes', /const nonHvac = !!industryId && industryId !== 'hvac'/.test(rb) && /: 'dw-btn-secondary !min-h-\[40px\]'/.test(rb) && /: 'flex items-start gap-4'\}/.test(rb) && /nonHvac \? 'w-full sm:w-64' : 'w-64'/.test(rb) && /: 'dw-pill-muted'/.test(rb) && !/className="[^"]*max-sm:/.test(rb) && /if \(!nonHvac \|\| collapsedOnce\.current\) return/.test(rb) && /useState\(true\)/.test(rb)); }

  // ---- owner rule: answer only from THIS organization's own records; no fixed industry word lists; never drop a condition
  {
    const orgA = [
      lease('1A', 'Ann Lee', D(-300), D(30), 1000, 900, { service_address: '10 Oak St, Mesa AZ', property_name: 'Oak Court Apartments' }),
      lease('2B', 'Bob Ray', D(-300), D(300), 1100, 900, { service_address: '10 Oak St, Mesa AZ', property_name: 'Oak Court Apartments' }),
      coi('Sun Landscaping LLC', D(20)), coi('Acme Plumbing Inc', D(-20)),
      { type: 'vendor-contract', f: { vendor: 'Sun Landscaping LLC', contract_end: D(40), auto_renew: 'No', monthly_amount: '500', contract_scope: 'Landscaping' } },
      { type: 'invoice', f: { vendor: 'Acme Plumbing Inc', invoice_number: 'I-100', cost: '300', status: 'Unpaid', invoice_due: D(-5), invoice_date: D(-35) } },
      { type: 'work-order', f: { work_order_number: '5001', service_date: D(-3), work_performed: 'Fix sink', status: 'Open', priority: 'High', vendor: 'Acme Plumbing Inc', unit_number: '1A', service_address: '10 Oak St, Mesa AZ' } },
      insp('1A', D(-30), 'Fail', 'Fire', { reinspection_due: D(10) }),
    ];
    const orgB = [ // different vendors, city, tenants, property, inspection kind
      lease('9Z', 'Carl Doe', D(-300), D(30), 2000, 900, { service_address: '77 Pine Rd, Tucson AZ', property_name: 'Pine Villas' }),
      coi('Delta Pest Control Inc', D(20)), coi('Zed Roofing LLC', D(-10)),
      { type: 'invoice', f: { vendor: 'Delta Pest Control Inc', invoice_number: 'B-7', cost: '800', status: 'Unpaid', invoice_due: D(-5), invoice_date: D(-35) } },
      insp('9Z', D(-30), 'Fail', 'Pool', { reinspection_due: D(10) }),
    ];
    const none = async (docs, qn) => { const r = await ask(docs, qn); return r == null || /^None\b|not on file|none on file|no .* on file/i.test(txt(r)) ? 'ok' : txt(r); };
    // org B's names asked of org A: never answered from B, never a total with the condition dropped
    for (const qn of ['How many leases are in Tucson?', 'How many leases for tenant Carl Doe?', 'Who is the tenant of unit 9Z?', 'How many invoices from Delta Pest Control?', 'What is the total of invoices from Delta Pest Control?', 'What is the pest control company\'s COI?', 'What do we owe Zed Roofing?', 'How many invoices are overdue for Pine Villas?', 'Which pool inspections failed?', 'How many open work orders at Pine Villas?', 'Which leases at Pine Villas end in the next 60 days?', 'How many invoices for roofing?']) {
      const a = await none(orgA, qn); check(`org A is asked about org B's name -> none on file / null: ${qn}`, a === 'ok', a);
    }
    // ...and the same questions work in org B (the names are theirs)
    check("org B answers about its own vendor and city-free questions from its own records", /800\.00/.test(txt(await ask(orgB, 'What is the total of invoices from Delta Pest Control?'))) && /Delta Pest Control/.test(txt(await ask(orgB, 'Which vendor COIs are expiring in the next 60 days?'))) && !/Acme|Sun Landscaping|Oak Court/.test(txt(await ask(orgB, 'Which vendor COIs are expired?'))));
    check('trade lookup works only through the org\'s own vendor names: "the pest control company" is a vendor in B, nothing in A', /Delta Pest Control/.test(txt(await ask(orgB, "What is the pest control company's COI?"))) || (await ask(orgB, "What is the pest control company's COI?")) == null);
    // an inspection kind is the org's own: B has "Pool", A has "Fire"
    check('inspection kind comes from the org\'s own records (fire in A answered, pool in A not; pool in B answered)', /1 inspection failed/.test(txt(await ask(orgA, 'How many fire inspections failed?'))) && (await ask(orgA, 'How many pool inspections failed?')) == null && /1 inspection failed/.test(txt(await ask(orgB, 'How many pool inspections failed?'))) && (await ask(orgB, 'How many fire inspections failed?')) == null);
    // no fixed word list: words the org never uses are not special-cased; an org that does use them (as a vendor name) gets answers
    for (const qn of ['How many tonnage jobs are on file?', 'How many permits are on file?', 'How many water heater work orders are open?', 'How many urgent work orders are open?', 'How many unassigned work orders are open?', 'How many signed leases do we have?', 'What is the total of invoices from Backflow Pros?', 'How many safety inspections failed?']) {
      const a = await none(orgA, qn); check(`a word org A never uses is not guessed or dropped: ${qn}`, a === 'ok', a);
    }
    const orgC = [{ type: 'invoice', f: { vendor: 'Backflow Pros LLC', invoice_number: 'C-1', cost: '450', status: 'Unpaid', invoice_due: D(-5), invoice_date: D(-35) } }];
    check('the same word in an org whose own vendor uses it IS understood (no hard-coded list either way)', /450\.00/.test(txt(await ask(orgC, 'What is the total of invoices from Backflow Pros?'))), txt(await ask(orgC, 'What is the total of invoices from Backflow Pros?')));
    const src7 = fs.readFileSync(new URL('../api/_lib/industry/property/lane.js', import.meta.url), 'utf8');
    check('lane.js carries no fixed trade / industry word list in routing', !/const FOREIGN\b/.test(src7) && !/\b(?:pest control|janitor|landscap|elevator|roofing|plumbing|tonnage|refrigerant|furnace|backflow)\b/.test(src7.replace(/^import .*$/gm, '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')));
  }

  // ---- loop 8
  { const ex = (text, today = TODAY) => extractProperty([{ page_no: 1, text }], { today });
    const fv = (r, k) => r?.fields.find((x) => x.key === k)?.value;
    const LH = 'RESIDENTIAL LEASE AGREEMENT\nTenant Name: Ivy Moore\nUnit: 3C\nProperty: 100 Main St, Mesa AZ\n';
    const pl = ex(`${LH}Lease Start Date: 01/01/2026 | Lease End Date: 10/25/2026\nMonthly Rent: $1,200.00\n`);
    check('pipe form with spaces: both lease dates read', fv(pl, 'lease_start_date') === '2026-01-01' && fv(pl, 'lease_end_date') === '2026-10-25', JSON.stringify(pl?.fields));
    const tl = ex(`${LH}Lease Start Date:\t01/01/2026\tLease End Date:\t10/25/2026\nMonthly Rent:\t$1,200.00\n`);
    check('tab-separated lease: both dates read', fv(tl, 'lease_end_date') === '2026-10-25' && fv(tl, 'lease_start_date') === '2026-01-01');
    const WH = 'WORK ORDER\nWork Order #: 5001\nService Date: 09/01/2026\nWork Performed: Fix sink\nStatus: Open\nPriority: High\nVendor: Acme Plumbing Inc\n';
    check('work order: a name under "Property Address" is the property name; a street address stays an address', fv(ex(`${WH}Property Address: Cactus Flats Villas\nUnit: 4B\n`), 'property_name') === 'Cactus Flats Villas' && fv(ex(`${WH}Property Address: Cactus Flats Villas    Apt #: 12\n`), 'property_name') === 'Cactus Flats Villas' && fv(ex(`${WH}Property Address: Cactus Flats Villas    Apt #: 12\n`), 'unit_number') === '12' && fv(ex(`${WH}Property Address: 12 Oak St, Mesa AZ\nUnit: 4B\n`), 'service_address') === '12 Oak St, Mesa AZ' && !fv(ex(`${WH}Property Address: 12 Oak St, Mesa AZ\nUnit: 4B\n`), 'property_name'));
    check('COI: pipe and two-column layouts read the vendor and the expiry', ['Insured: Bravo Pools Inc | Policy Expiration: 12/31/2026', 'Insured: Bravo Pools Inc    Policy Expiration: 12/31/2026', 'Insured:\tBravo Pools Inc\tPolicy Expiration:\t12/31/2026'].every((t) => { const r = ex(`CERTIFICATE OF LIABILITY INSURANCE\n${t}\nGeneral Liability\n`); return fv(r, 'vendor') === 'Bravo Pools Inc' && fv(r, 'coi_expires') === '2026-12-31'; }));
    check('tab-separated invoice is read', fv(ex('INVOICE\nInvoice No:\tINV-9300\nInvoice From:\tAcme Plumbing Inc\nInvoice Date:\t09/01/2026\nDue Date:\t09/30/2026\nStatus:\tUnpaid\nTotal:\t$120.00\n'), 'cost') === '120.00');
    check('contract "Term End Date" is the contract end', fv(ex('VENDOR SERVICE AGREEMENT\nVendor: Sun Landscaping LLC\nContract Start Date: 01/01/2026\nTerm End Date: 12/31/2026\nMonthly Fee: $500.00\nAuto-Renew: No\nScope: Landscaping\n'), 'contract_end') === '2026-12-31');
    // the extractor never reads the clock: the same page with two different todays differs only where the caller's today says so
    const soon = 'INSPECTION REPORT\nUnit: 5E\nInspection Date: 11/20/2026\nInspection Type: Annual\nResult: Pass\nProperty: 100 Main St, Mesa AZ\n';
    const a1 = JSON.stringify(ex(soon, '2026-10-06')); const a2 = JSON.stringify(ex(soon, '2026-12-01')); const a3 = JSON.stringify(extractProperty([{ page_no: 1, text: soon }]));
    check('extractor: caller today drives the future-date drop (45 days ahead -> unread; later today -> read; no today -> read)', a1 === 'null' && a2 !== 'null' && a3 !== 'null', `${a1.slice(0, 20)} / ${a2.slice(0, 20)} / ${a3.slice(0, 20)}`);
    check('extractor: no today -> same result as a far-future today would give for a non-future page', JSON.stringify(ex(`${LH}Lease Start Date: 01/01/2026\nLease End Date: 10/25/2026\nMonthly Rent: $1,200.00\n`, '2020-01-01')) === JSON.stringify(extractProperty([{ page_no: 1, text: `${LH}Lease Start Date: 01/01/2026\nLease End Date: 10/25/2026\nMonthly Rent: $1,200.00\n` }])));
    const exSrc = fs.readFileSync(new URL('../api/_lib/industry/property/extract.js', import.meta.url), 'utf8');
    check('extract.js never reads the real clock', !/new Date\(\)|Date\.now\(|todayIso/.test(exSrc.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')));
    check('extractDocument passes the real today to the property extractor', /extractProperty\(pages, \{ today:/.test(fs.readFileSync(new URL('../api/_lib/extractDocument.js', import.meta.url), 'utf8')));
  }
  { const L8 = [lease('1A', 'Has End', D(-300), D(30), 1000, 900), lease('2B', 'No End', D(-300), null, 1000, 900), lease('3C', 'Later', D(-100), D(200), 1000, 900)];
    const e8 = await ask(L8, 'Which leases end in the next 60 days?');
    check('expiring list notes a lease with a missing/unreadable end date', /Has End|1A/.test(txt(e8)) && /1 lease \(2B\) has a missing or unreadable end date/.test(txt(e8)) && /2B/.test(txt(e8)), txt(e8));
    const c8 = await ask([lease('2B', 'No End', D(-300), null, 1000, 900)], 'How many leases expire in the next 60 days?');
    check('a count of 0 expiring leases never hides a lease with no readable end date', /^0 leases/.test(txt(c8)) && /missing or unreadable end date/.test(txt(c8)), txt(c8));
    const at8 = await ask(L8, 'What needs attention?'); const ap8 = await propertyAttention(fakeDb(L8), { today: TODAY, withinDays: 60 });
    check('attention answer and route report the lease with no end date', /missing or unreadable end date/.test(txt(at8)) && ap8.leasesWithoutEnd === 1, txt(at8));
    const WP = [{ type: 'work-order', f: { work_order_number: '1', status: 'Open', service_date: D(-3), property_name: 'Cactus Flats Villas', unit_number: '4B' } }, { type: 'work-order', f: { work_order_number: '2', status: 'Open', service_date: D(-3), unit_number: '9' } }];
    const w8 = await ask(WP, 'How many open work orders at Cactus Flats Villas?');
    check('work orders with no property are noted, never silently dropped from a property count', w8 == null || (/^1 work order/.test(txt(w8)) && /no property/.test(txt(w8))), txt(w8));
    // unread documents: typed with no fields, or not classified at all
    const ctDb = { raw: async () => ({ rows: [{ id: 'a', filename: 'a.pdf', type: 'lease_agreement', created_at: 1, key: 'tenant_name', value: 'Ann Lee', page: 1 }, { id: 'b', filename: 'b.pdf', type: 'lease_agreement', created_at: 2, key: null, value: null, page: null }, { id: 'c', filename: 'c.pdf', type: null, created_at: 3, key: null, value: null, page: null }] }) };
    const cc = await runProperty(ctDb, classifyProperty('How many leases do we have?', { today: TODAY }), { today: TODAY });
    check('count answers say how many other documents could not be read', cc && /could not be read/.test(txt(cc)) && /c\.pdf/.test(txt(cc)) && /b\.pdf/.test(txt(cc)), txt(cc));
    const od = await ask([{ type: 'invoice', f: { vendor: 'Late Co', invoice_number: 'L-1', cost: '100', status: 'Unpaid', invoice_due: D(-5) } }, { type: 'certificate-of-insurance', f: { vendor: 'Old Co', coi_expires: D(-10), coverage_type: 'General Liability' } }, lease('2B', 'Ends Soon', D(-300), D(20), 1000, 900)], 'Is anything overdue?');
    check('"anything overdue" lists only overdue items, not the whole attention list', /overdue/.test(txt(od)) && /Late Co|1 overdue invoice/.test(txt(od)) && !/Ends Soon/.test(txt(od)) && !/vendor certificate/.test(txt(od).split('(')[0]), txt(od));
  }

  // ---- loop 9
  { const wo9 = (n, v, st, sd, u) => ({ type: 'work-order', f: { work_order_number: n, service_date: D(sd), work_performed: 'Fix', status: st, priority: 'High', vendor: v, unit_number: u, service_address: '10 Oak St, Mesa AZ' } });
    const N9 = [
      wo9('7001', 'Open Door Locks', 'Open', -3, '1A'), wo9('7002', 'Late Night Locksmith', 'Completed', -20, '1A'), wo9('7003', 'Total Heating', 'Completed', -8, '2B'), wo9('7004', 'Expired Roofing', 'Open', -30, '2B'),
      coi('Expired Roofing', D(100)), coi('Paid in Full Plumbing', D(-5)), coi('Vacant Land LLC', D(30)),
      { type: 'invoice', f: { vendor: 'Paid in Full Plumbing', invoice_number: 'P-1', cost: '200', status: 'Unpaid', invoice_due: D(-5), invoice_date: D(-40) } },
      { type: 'invoice', f: { vendor: 'Open Door Locks', invoice_number: 'O-1', cost: '90', status: 'Paid', invoice_due: D(-5), invoice_date: D(-40) } },
      { type: 'vendor-contract', f: { vendor: 'Late Night Locksmith', contract_end: D(30), auto_renew: 'No', monthly_amount: '100' } },
      lease('1A', 'Rental Roll', D(-300), D(30), 1000, 900, { service_address: '10 Oak St, Mesa AZ' }),
    ];
    const t9 = async (q) => txt(await ask(N9, q));
    const a1 = await t9('How many open work orders for Total Heating?');
    check('name with a status word: "open work orders for Total Heating" is Total Heating\'s, never Open Door Locks\'', /^0 work orders open assigned to Total Heating/.test(a1) && !/7001|Open Door/.test(a1), a1);
    const a2 = await t9('Work orders for Late Night Locksmith');
    check('name with a status word: "Late Night Locksmith" does not force overdue mode', /on file assigned to Late Night Locksmith/.test(a2) && /7002/.test(a2) && !/overdue/.test(a2), a2);
    const a3 = await t9('Which work orders did Open Door Locks do?');
    check('name with a status word: "Open Door Locks" is a vendor, not the open status', /on file assigned to Open Door Locks: 7001/.test(a3) && !/7004/.test(a3), a3);
    check('plain status questions are unchanged by those names', /^2 work orders open\./.test(await t9('How many work orders are open?')) && /7001/.test(await t9('Which work orders are overdue?')) && /7004/.test(await t9('Which work orders are overdue?')) && !/7002|7003/.test(await t9('Which work orders are overdue?')));
    const a4 = await t9('Is Expired Roofing insured?');
    check('name with "expired": "Is Expired Roofing insured?" reads its current certificate', /^Yes\. Expired Roofing's certificate of insurance is current/.test(a4), a4);
    check('"Which vendor COIs are expired?" lists only the real expired one', /Paid in Full Plumbing/.test(await t9('Which vendor COIs are expired?')) && !/Expired Roofing/.test(await t9('Which vendor COIs are expired?')));
    const a5 = await t9('What is the total of invoices from Open Door Locks?');
    check('name with "open": invoice total is that vendor\'s ($90.00), not an open-invoice list', /\$90\.00 across 1 invoice from Open Door Locks/.test(a5), a5);
    const a6 = await t9("When does Late Night Locksmith's contract end?");
    check('name with "late": its contract end is read', /Late Night Locksmith contract ends/.test(a6), a6);
    const a7 = await t9('What is the rent for Rental Roll?');
    check('tenant named like a rent roll: rent is that tenant\'s unit', /Rent for unit 1A .* \$1,000\.00/.test(a7), a7);
    // a name in the question that the records do not have never leaves a condition dropped
    for (const q of ['How many open work orders for Open Windows Inc?', 'Work orders for Late Night Bakery']) { const r = await ask(N9, q); check(`unknown look-alike name is not answered from a similar one: ${q}`, r == null, txt(r)); }
  }
  { const gx = (lines) => extractProperty([{ page_no: 1, text: `CERTIFICATE OF LIABILITY INSURANCE\nInsured: Bravo Pools Inc\n${lines}` }], { today: TODAY });
    const pf = (r, k) => r?.fields.filter((x) => x.key === k).map((x) => x.value);
    const w1 = gx('Workers Compensation Policy Expiration: 03/01/2026\n');
    check('COI: "Policy Expiration" is never stored as a policy number', !(pf(w1, 'policy_number') ?? []).some((v) => /expiration/i.test(v)) && pf(w1, 'coi_expires')?.[0] === '2026-03-01', JSON.stringify(w1?.fields));
    const w2 = gx('General Liability Policy Number: GL-77\nGeneral Liability Policy Expiration: 05/01/2027\nWorkers Compensation Policy Number: WC-9\nWorkers Compensation Policy Expiration: 03/01/2027\n');
    check('COI with two labelled policies: policy number is the general liability one (GL-77), never WC-9 or a label word', JSON.stringify(pf(w2, 'policy_number')) === JSON.stringify(['GL-77']), JSON.stringify(w2?.fields));
    const w3 = gx('Workers Comp Policy: WC-9\nGeneral Liability Policy: GL-77\nPolicy Expiration: 05/01/2027\n');
    check('COI: GL policy is chosen when both are labelled', JSON.stringify(pf(w3, 'policy_number')) === JSON.stringify(['GL-77']), JSON.stringify(w3?.fields));
    const w4 = gx('Policy No: Expiration\nPolicy Expiration: 05/01/2027\nGeneral Liability\n');
    check('COI: a label word after "Policy No:" is never a policy number', !(pf(w4, 'policy_number') ?? []).length, JSON.stringify(w4?.fields)); }
  { const W9 = [{ type: 'work-order', f: { work_order_number: '1', status: 'Open', service_date: D(-9), property_name: 'Cactus Flats Villas', unit_number: '4B', vendor: 'Fixit Co' } }, { type: 'work-order', f: { work_order_number: '2', status: 'Open', service_date: D(5), unit_number: '9' } }, { type: 'work-order', f: { work_order_number: '3', status: 'Completed', service_date: D(-9), unit_number: '9' } }];
    const ap9 = await propertyAttention(fakeDb(W9), { today: TODAY, withinDays: 60 });
    const wi = ap9.items.filter((x) => x.category === 'workorder');
    check('attention includes overdue open work orders only (not future, not completed), with a source', wi.length === 1 && /Work order 1/.test(wi[0].label) && wi[0].kind === 'overdue' && wi[0].documentId && wi[0].page >= 1, JSON.stringify(ap9.items));
    const ov9 = await ask(W9, 'Which work orders are overdue?'); const od9 = await ask(W9, 'Is anything overdue?');
    const ids = (r) => [...new Set((r?.facts ?? []).map((f) => f.sources?.[0]?.documentId))].sort().join();
    check('card items == Ask answer items for work orders; "anything overdue" lists the overdue work order too', ids(ov9) === wi.map((x) => x.documentId).sort().join() && ids(od9) === ids(ov9) && /overdue work order/.test(txt(od9)), `${ids(ov9)} / ${ids(od9)} :: ${txt(od9)}`);
    check('card Ask for the work-order category is answered by the lane', /workorder: 'Which work orders are overdue\?'/.test(fs.readFileSync(new URL('../src/components/IndustryAttentionCard.tsx', import.meta.url), 'utf8')) && (await ask(W9, 'Which work orders are overdue?')) != null); }

  // ---- loop 10
  { const IH = 'INVOICE\nInvoice No: INV-500\nInvoice From: Acme Plumbing Inc\nInvoice Date: 09/01/2026\nDue Date: 09/20/2026\n';
    const exI = (extra) => extractProperty([{ page_no: 1, text: `${IH}Invoice Total: $1,000.00\n${extra}\nPayment Status: Unpaid\n` }], { today: TODAY });
    const costOf = (r) => r?.fields.find((x) => x.key === 'cost')?.value;
    check('control: an invoice with no adjustment lines keeps its total', costOf(exI('')) === '1000.00');
    for (const extra of ['Credit: -$250.00', 'Credit: $250.00', 'Credit: ($250.00)', 'Credit Applied: $250.00', 'Credit Memo Applied: 250.00', 'Discount: $100.00', 'Early pay discount: $20.00', 'Less Payment: $400.00', 'Payments Applied: $400.00', 'Amount Paid: $400.00', 'Adjustment: -$50.00', 'Adjustment: $50.00', 'Adjustment: (50.00)', 'Retainage: $100.00', 'Retainage Held: 10%']) {
      const r = exI(extra); check(`invoice with "${extra}" never stores the printed total as the cost`, costOf(r) == null, JSON.stringify(r?.fields));
    }
    check('zero-amount adjustment lines and "Payment Terms: Net 30" do not block the total', costOf(exI('Credit: $0.00\nDiscount: $0.00\nPayment Terms: Net 30')) === '1000.00');
    check('a fully paid invoice (balance 0) keeps its total', costOf(extractProperty([{ page_no: 1, text: `${IH}Invoice Total: $1,000.00\nAmount Paid: $1,000.00\nBalance Due: $0.00\n` }], { today: TODAY })) === '1000.00');
    const unk = await ask([{ type: 'invoice', f: { vendor: 'Acme Plumbing Inc', invoice_number: 'INV-500', status: 'Unpaid', invoice_due: D(-5), invoice_date: D(-30) } }], 'What do we owe Acme Plumbing?');
    check('an unpaid invoice with no readable cost is never given a dollar amount', unk == null || !/\$\s*\d/.test(txt(unk)), txt(unk)); }

  // ---- loop 11
  { const IH = 'INVOICE\nVendor: Zed Plumbing LLC\nInvoice Number: INV-1001\nInvoice Date: 2026-09-10\nDue Date: 2026-10-10\nProperty: Saguaro Ridge Apartments, 1200 Mesa Drive, Mesa AZ\nUnit: 4B\nDescription: Replaced water heater\n';
    const cost11 = (extra, tot = 'Total: $1,000.00') => { const r = extractProperty([{ page_no: 1, text: `${IH}${extra}\n${tot}` }], { today: TODAY }); return r ? (r.fields.find((x) => x.key === 'cost')?.value ?? 'nocost') : 'UNREAD'; };
    const dropped = ['Less Deposit Applied: $200.00', 'Less payment received ($300.00)', 'Partial payment: $300 / Amount Due: $900', 'Prior payment: $300', 'Deposit credit: $100', 'Courtesy credit -$100.00', 'Refund issued: $100', 'Prepaid: $100', 'Retention: $60', 'Total Credits $50', 'Total discount $50', 'Credit: USD 100.00', 'Credit: 100 dollars', 'Discount of $50 applied', '10% discount applied', 'Discount (10%) $120.00', 'Total $1,300 less $100 credit', 'Less 10% retainage', 'Net due: $900', 'Price adjustment: -$25.00', 'Credit: -$250.00', 'Credit: ($250.00)', 'Credit Memo Applied: 250.00', 'Early pay discount: $20.00', 'Amount Paid: $400.00', 'Retainage Held: 10%'];
    const bad = dropped.filter((x) => !['UNREAD', 'nocost'].includes(cost11(x)));
    check(`structural rule: every adjustment-wording line with an amount or percent drops the cost (${dropped.length} forms)`, bad.length === 0, bad.join(' | '));
    const kept = ['Credit Limit: $5,000.00', 'Payment Terms: Net 30', 'Credit card fee: 3%', 'Late fee waived: $25.00', 'Retainage 0%', 'Amount paid $0.00', 'Terms: 2% 10 Net 30', 'Amount Due: $1,000.00', 'Payment Status: Unpaid', 'No credit memo has been issued', 'Note: any credit note must be requested within 30 days', 'Credit memo policy: see reverse', 'Questions? Contact billing about a credit memo'];
    const badK = kept.filter((x) => cost11(x) !== '1000.00');
    check(`controls keep a positive cost (${kept.length} forms), a credit memo mentioned in body text never changes the sign`, badK.length === 0, badK.map((x) => `${x} -> ${cost11(x)}`).join(' | '));
    const cmT = extractProperty([{ page_no: 1, text: 'CREDIT MEMO\nVendor: Zed Plumbing LLC\nInvoice Number: CM-1\nInvoice Date: 2026-09-10\nTotal: $100.00' }], { today: TODAY });
    check('a document titled CREDIT MEMO never reads as a positive charge', cmT == null || Number(cmT.fields.find((x) => x.key === 'cost')?.value ?? -1) < 0);
    // untyped / other documents: invoice answers carry the caveat
    const mixDb = { raw: async () => ({ rows: [{ id: 'a', filename: 'a.pdf', type: 'invoice', created_at: 1, key: 'vendor', value: 'Zed Plumbing LLC', page: 1 }, { id: 'a', filename: 'a.pdf', type: 'invoice', created_at: 1, key: 'cost', value: '100', page: 1 }, { id: 'a', filename: 'a.pdf', type: 'invoice', created_at: 1, key: 'status', value: 'Unpaid', page: 1 }, { id: 'a', filename: 'a.pdf', type: 'invoice', created_at: 1, key: 'invoice_due', value: D(-3), page: 1 }, { id: 'a', filename: 'a.pdf', type: 'invoice', created_at: 1, key: 'invoice_number', value: 'Z-1', page: 1 }, { id: 'b', filename: 'scan-0042.pdf', type: 'other', created_at: 2, key: null, value: null, page: null }, { id: 'c', filename: 'scan-0043.pdf', type: null, created_at: 3, key: null, value: null, page: null }] }) };
    for (const q of ['What is the total of all unpaid invoices?', 'Which invoices are overdue?', 'How many invoices do we have on file?']) { const r = await runProperty(mixDb, classifyProperty(q, { today: TODAY }), { today: TODAY }); check(`invoice answer carries the "not typed, may include invoices" caveat: ${q}`, r && /only counts invoices that were read/.test(txt(r)) && /2 other documents/.test(txt(r)) && /scan-0042\.pdf/.test(txt(r)), txt(r)); }
    const noMix = await ask([{ type: 'invoice', f: { vendor: 'Zed Plumbing LLC', invoice_number: 'Z-1', cost: '100', status: 'Unpaid', invoice_due: D(-3) } }], 'What is the total of all unpaid invoices?');
    check('no caveat when every document is typed', noMix && !/not typed/.test(txt(noMix)), txt(noMix));
  }
  { const r4 = (t) => extractProperty([{ page_no: 1, text: `INSPECTION REPORT\nUnit: 5E\nProperty: 100 Main St, Mesa AZ\nInspection Date: 09/01/2026\nInspection Type: Fire\n${t}\n` }], { today: TODAY });
    check('a printed Reinspection Result means the first result is not read as failed / overdue on its own', r4('Result: Failed\nReinspection Date: 10/01/2026\nReinspection Result: Passed') === null && r4('Result: Failed\nReinspection Date: 10/01/2026') != null);
    const vc = (t) => extractProperty([{ page_no: 1, text: `VENDOR SERVICE AGREEMENT\nVendor: Sun Landscaping LLC\nContract Start Date: 01/01/2026\nContract End Date: 12/31/2026\nMonthly Fee: $500.00\n${t}\n` }], { today: TODAY })?.fields.find((x) => x.key === 'auto_renew')?.value;
    check('evergreen / "continues until terminated" contracts are read as auto-renewing', vc('This is an evergreen agreement.') === 'yes' && vc('This agreement continues until terminated by either party.') === 'yes' && vc('Auto-Renew: No') === 'no');
    const AR = [{ type: 'vendor-contract', f: { vendor: 'Sun Landscaping LLC', contract_end: D(30), auto_renew: 'Yes', monthly_amount: '500' } }];
    const ar1 = txt(await ask(AR, 'Which vendor contracts end in the next 60 days?')); const ar2 = txt(await ask(AR, 'Which vendor contracts need attention?'));
    check('ending / attention lists carry the auto-renew caveat in the answer text', /auto-renews, so it continues unless cancelled/.test(ar1) && /auto-renews, so it continues unless cancelled/.test(ar2), `${ar1} || ${ar2}`);
    const WU = [{ type: 'work-order', f: { work_order_number: '1', status: 'Pending review??', service_date: D(-9), property_name: 'Cactus Flats Villas', unit_number: '4B', vendor: 'Fixit Co' } }];
    const wuA = await propertyAttention(fakeDb(WU), { today: TODAY, withinDays: 60 }); const wuT = txt(await ask([...WU, lease('2B', 'Ending Soon', D(-300), D(20), 1000, 900)], 'What needs attention?'));
    check('work orders with an unreadable status and a past date are noted in attention, not listed as overdue', wuA.unreadableWorkOrders === 1 && wuA.items.every((x) => x.category !== 'workorder') && /1 work order has an unreadable status/.test(wuT), `${wuA.unreadableWorkOrders} :: ${wuT}`); }

  // a second property company: same vendor, unit and invoice names, different rents / dates -- nothing mixes
  {
    const { getTenantContext } = await import('../api/_lib/recordsStore.js');
    const ctx2 = { tenantKey: 'org_mixed_property_two', tenantName: 'Mixed property two Co' };
    await getTenantContext(ctx2.tenantKey, ctx2.tenantName);
    await H.withTenant(ctx2, (db) => H.R.setTenantIndustry(db, 'property', { tenantKey: ctx2.tenantKey }));
    H.R.resetPacksCacheForTests(); H.I.resetPackForTenantCacheForTests();
    const put = async (db, fn, type, fields) => { const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: `two-${fn}`, stage: 'mapped' }); for (const [k, v] of fields) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); } };
    await H.withTenant(ctx2, async (db) => {
      await put(db, 'two-lease.pdf', 'lease_agreement', [['unit_number', '4B'], ['tenant_name', 'Zed Quill'], ['lease_start_date', D(-20)], ['lease_end_date', D(40)], ['rent_amount', '999'], ['security_deposit', '500']]);
      await put(db, 'two-coi.pdf', 'certificate_of_insurance', [['vendor', 'Rios Plumbing LLC'], ['coi_expires', D(3)], ['coverage_type', 'General Liability']]);
      await put(db, 'two-inv.pdf', 'invoice', [['invoice_number', 'INV-5001'], ['vendor', 'Rios Plumbing LLC'], ['cost', '77.00'], ['status', 'Unpaid'], ['invoice_due', D(-3)]]);
    });
    const run2 = (c, qn) => (c === 2 ? H.withTenant(ctx2, async (db) => { const i = cl(qn); return i ? runProperty(db, i, { today: TODAY }) : null; }) : H.as('property', async (db) => { const i = cl(qn); return i ? runProperty(db, i, { today: TODAY }) : null; }));
    const r2 = await run2(2, 'What is the rent for unit 4B?'); const r1 = await run2(1, 'What is the rent for unit 4B?');
    check('second property company: rent for 4B is its own (999) and the first company still says 1,450', /999\.00/.test(txt(r2)) && !/1,450/.test(txt(r2)) && /1,450\.00/.test(txt(r1)) && !/999/.test(txt(r1)), `${txt(r2)} || ${txt(r1)}`);
    const c2 = await run2(2, 'Is Rios Plumbing insured?'); const c1 = await run2(1, 'Is Rios Plumbing insured?');
    check('second property company: the same vendor has its own certificate date in each company', /in 3 days/.test(txt(c2)) && /October 26, 2026/.test(txt(c1)) && !/in 3 days/.test(txt(c1)), `${txt(c2)} || ${txt(c1)}`);
    const v2 = await run2(2, 'Which invoices are overdue?'); const v1 = await run2(1, 'Which invoices are overdue?');
    check('second property company: invoices never cross', /77\.00/.test(txt(v2)) && !/SV-0912/.test(txt(v2)) && !/77\.00/.test(txt(v1)));
    const a2 = await H.withTenant(ctx2, (db) => propertyAttention(db, { today: TODAY, withinDays: 60 })); const a1 = await H.as('property', (db) => propertyAttention(db, { today: TODAY, withinDays: 60 }));
    const l2 = a2.items.map((i) => i.label).join(' '); const l1 = a1.items.map((i) => i.label).join(' ');
    check('second property company: attention lists only its own records', /Rios/.test(l2) && /Zed Quill|4B/.test(l2) && !/Saguaro|Summit|Sun Valley|SV-0912/.test(l2) && !/Zed Quill|\$77\.00/.test(l1), `${l2} || ${l1}`);
    const pg = [{ page_no: 1, text: 'RESIDENTIAL LEASE AGREEMENT\nTenant Name: Zed Quill\nUnit: 4B\nProperty: 1 Other St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End Date: 12/31/2026\nMonthly Rent: $999.00\n' }];
    const e1 = extractProperty(pg, { today: TODAY }); const e2 = extractProperty(pg, { today: TODAY });
    check('extractor is stateless: the same page reads the same way before and after another company is loaded, with its own values', JSON.stringify(e1) === JSON.stringify(e2) && e1.fields.some((x) => x.key === 'rent_amount' && x.value === '999.00') && !JSON.stringify(e1).includes('1450'));
  }
}

/* review round: the real handler */
{
  const { makeAsk } = await import('./lib/ask-handler.mjs');
  const ask = await makeAsk(H, 'property');
  const prior = { turns: [{ question: 'How many invoices do we have?' }] };
  const fresh = await ask('Which leases end soon?'); const chat = await ask('Which leases end soon?', prior);
  check('chat: a self-contained question as the second question is answered by the lane exactly like fresh, no model', fresh.modelCalls === 0 && chat.modelCalls === 0 && /leases ending/.test(chat.text) && chat.text === fresh.text, `${fresh.text} | ${chat.text}`);
  const fol = await ask('and which of those end soon?', prior);
  check('chat: a real follow-up still skips the lane', !/leases ending within/.test(fol.text));
  const t = await ask('Who lives in unit 12C and when does the lease end?');
  check('4c: "who lives in 12C and when does the lease end" is answered (tenant and lease end), not a false zero', /Priya Natarajan/.test(t.text) && /October 31, 2026/.test(t.text) && t.modelCalls === 0 && !/No documents on file mention|0 customers/.test(t.text), t.text);
  const v = await ask('who is the vendor?', { turns: [{ question: 'Which vendor certificates expire?' }] });
  check('4c: a bare "who is the vendor?" follow-up is never a false "no documents mention vendor" or a dangling ": ."', !/No documents on file mention|customers? ha(?:s|ve) a document on file mentioning|: \.$/.test(v.text), v.text);
}

/* review round: pathological input is bounded (one 60,000-char line, MBs of text) and normal documents read the same */
{
  const norm = (r) => JSON.stringify(r?.fields?.map((x) => [x.key, x.value]) ?? null);
  const base = [{ page_no: 1, text: 'RESIDENTIAL LEASE AGREEMENT\nTenant Name: Zed Quill\nUnit: 4B\nProperty: 1 Other St, Mesa AZ\nLease Start Date: 01/01/2026\nLease End Date: 12/31/2026' }];
  const t0 = Date.now();
  for (const line of ['Note: ' + 'x '.repeat(29997), 'Result: Passed Next Test Due: 3/4/27 '.repeat(1800).slice(0, 60000), 'Phone: 480 '.repeat(5400).slice(0, 60000), 'a | b '.repeat(10000)]) { extractProperty([{ page_no: 1, text: base[0].text + '\n' + line }]); }
  const ms = Date.now() - t0;
  check('extractor: three 60,000-character lines finish in under 200 ms (was 2-9 s)', ms < 200, `${ms} ms`);
  const withBig = extractProperty([{ page_no: 1, text: base[0].text + '\n' + 'lorem ipsum dolor '.repeat(3400).slice(0, 60000) }]);
  check('extractor: a document with a 60,000-character line still reads its normal fields identically', norm(withBig) === norm(extractProperty(base)) && withBig != null);
  const t1 = Date.now(); extractProperty([{ page_no: 1, text: ('Tenant Name: Zed Quill' + '\n').repeat(60000) }]); const ms2 = Date.now() - t1;
  check('extractor: several MB of text is bounded (under 1.5 s)', ms2 < 1500, `${ms2} ms`);

/* round 3 (reviewer): lane teaching, no HVAC wording, code/legal, partial rent rolls */
{
  const { makeAsk } = await import('./lib/ask-handler.mjs');
  const ask = await makeAsk(H, 'property', { today: '2026-10-06' });
  const HV = /\bcustomers?\b|pieces of equipment|units match|service visits|no customer, unit, or document|couldn't find a customer|Financials update|not on file for that address|\bequipment type isn't recorded/i;
  const nl = await ask('Which units have no lease?'); const vac = await ask('Which units are vacant?');
  check('P3: property "Which units have no lease?" is answered by the vacancy lane (same units as "vacant"), not "No pieces of equipment match that"', nl.modelCalls === 0 && /vacant units on the rent roll/.test(nl.text) && !HV.test(nl.text) && nl.text === vac.text, nl.text);
  const hn = await ask('How many units have no lease?');
  check('P3: "How many units have no lease?" (a count the unread rent-roll rows forbid) is never "You have 0 pieces of equipment"', !HV.test(hn.text) && /\d+ vacant units? on the rent roll|can't answer that from your property management records/.test(hn.text), hn.text);
  const wo = await ask('Which work orders still need to be done?'); const wo2 = await ask('Which work orders are open?');
  check('P3: "Which work orders still need to be done?" is the open work order list, not "10 documents"', /work orders? open/.test(wo.text) && wo.text === wo2.text && !/\d+ documents/.test(wo.text), wo.text);
  const nv = await ask('Which work orders have no vendor assigned?'); const nv2 = await ask('How many work orders have no vendor?');
  check('P3: "have no vendor assigned" lists the work orders with no vendor, not "10 documents"', /^\d+ work orders? with no vendor assigned/.test(nv.text) && !/\d+ documents/.test(nv.text) && /^\d+ work orders? with no vendor assigned\.$/.test(nv2.text) && nv.text.startsWith(nv2.text.replace(/\.$/, ':')), `${nv.text} | ${nv2.text}`);
  const fi = await ask('Show failed inspections that need a reinspection'); const fi2 = await ask('Show failed inspections');
  check('P3: "Show failed inspections ..." is answered from the inspections, not "No documents on file mention inspection"', /inspections? need a reinspection/.test(fi.text) && /inspections? failed/.test(fi2.text) && !/No documents on file mention/.test(fi.text + fi2.text), `${fi.text} | ${fi2.text}`);
  for (const q of ['Which units had a move out inspection?', 'Who are our customers?', 'Which warranties are expiring?']) {
    const r = await ask(q);
    check(`P3: property "${q}" carries no HVAC wording and names what property can answer`, !HV.test(r.text) && /work orders, vendor contracts and insurance certificates, leases, the rent roll, inspections and invoices/.test(r.text) && r.modelCalls === 0, r.text);
  }
  const cap = await ask('What can you do?');
  check('P3: "What can you do?" gives a short property capability line', /work orders, vendor contracts and insurance certificates, leases, the rent roll, inspections and invoices/.test(cap.text), cap.text);
  const cd = await ask('Is the wiring up to code?'); const lg = await ask('Is it legal to evict a tenant?');
  check('P4: "Is the wiring up to code?" gets the compliance decline (no model); "Is it legal to evict a tenant?" the legal decline, not "No earlier question to go on"', /can't judge whether/.test(cd.text) && cd.modelCalls === 0 && /can't give legal advice/.test(lg.text), `${cd.text} | ${lg.text}`);
  const ed = await ask('Which invoices are overdue?');
  check('P3: property invoice answers carry no equipment-type note', !/equipment type isn't recorded/.test(ed.text), ed.text);
  // P7: a 5,000-row rent roll is cut by the 400,000-character cap and says so (rent_roll_unread), exactly like unreadable rows
  const rows = []; for (let i = 1; i <= 5000; i++) rows.push(`${1000 + i} | Tenant Number ${i} Longname Holdings | 2025-01-01 | 2026-12-31 | $${1200 + (i % 50)}.00 | Occupied`);
  const bigText = 'RENT ROLL\nProperty: Big Tower\nAs of: 2026-10-01\nUnit | Tenant | Lease Start | Lease End | Rent | Status\n' + rows.join('\n');
  const big = extractProperty([{ page_no: 1, text: bigText }], { today: '2026-10-06' });
  check('P7: a 5,000-row rent roll (> 400,000 characters) is flagged as having rows not read', bigText.length > 400000 && big?.type === 'rent-roll' && big.fields.some((x) => x.key === 'rent_roll_unread' && /unknown number/.test(x.value)), JSON.stringify(big?.fields.filter((x) => x.key === 'rent_roll_unread')));
  const small = extractProperty([{ page_no: 1, text: 'RENT ROLL\nProperty: Small\nAs of: 2026-10-01\nUnit | Tenant | Lease Start | Lease End | Rent | Status\n' + rows.slice(0, 50).join('\n') }], { today: '2026-10-06' });
  check('P7: a normal rent roll carries no unread flag', small?.type === 'rent-roll' && !small.fields.some((x) => x.key === 'rent_roll_unread'));
  const lease = extractProperty([{ page_no: 1, text: 'LEASE AGREEMENT\nTenant: Zed Quill\nUnit: 4B\nLease Start: 01/01/2026\nLease End: 12/31/2026\nMonthly Rent: $1,200\n' + 'lorem ipsum dolor '.repeat(3400).slice(0, 60000) }], { today: '2026-10-06' });
  check('P7: any other document whose text was cut is reported partial (never silently kept as complete)', !lease || lease.partial === true);
}
}
{ // loop 3 regressions run in their own process (package.json is shared and not edited by the property team)
  const { spawnSync } = await import('node:child_process');
  for (const file of ['property-loop3-regressions.run.mjs', 'property-loop4-regressions.run.mjs', 'property-loop5-regressions.run.mjs', 'property-loop6-regressions.run.mjs']) {
    const r = spawnSync(process.execPath, [`scripts/lib/${file}`], { encoding: 'utf8' });
    console.log(String(r.stdout).trim().split('\n').pop());
    check(`${file} passes`, r.status === 0, String(r.stdout).slice(-600));
  }
}
console.log(failures ? `${failures} FAILED (${passes} passed)` : `${passes} checks passed.`);
await H.stop?.();
process.exit(failures ? 1 : 0);
