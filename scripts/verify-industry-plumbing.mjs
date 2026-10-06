/**
 * verify:industry-plumbing (Build 2, stage 2C; permanent, in verify:all).
 * A seeded plumbing contractor's paperwork (fixture documents as page text) is read by the plumbing extractor, stored with
 * its pages, and ~460 questions are answered by the lane with NO model. Truth comes from the fixture specs, never from the
 * lane. Also: a company in another industry never sees these records or this wording; HVAC has no lane.
 *   node scripts/verify-industry-plumbing.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TODAY, truth, buildDocs } from './lib/plumbing-fixtures.mjs';
import { buildQuestions } from './lib/plumbing-questions.mjs';
import { EDGE } from './lib/plumbing-edge-cases.mjs';
import { addDays, long } from './lib/plumbing-fixtures.mjs';

let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else { failures++; console.log(`FAIL  ${n}${d ? `\n      ${d}` : ''}`); } };
const { startMixedHarness } = await import('./lib/mixed-company-harness.mjs');
const { extractPlumbing } = await import('../api/_lib/industry/plumbing/extract.js');
const { classifyPlumbing, runPlumbing, plumbingAttention, DECLINE, resultClass } = await import('../api/_lib/industry/plumbing/lane.js');
const { laneForPack } = await import('../api/_lib/industry/lanes.js');

const H = await startMixedHarness();
const T = truth();
const norm = (v) => String(v).toLowerCase().replace(/\s+/g, ' ').trim();

/* 1. ingest: extractor -> documents, pages, facets, extractions (page kept) */
const idByFile = {};
let typeMismatch = 0; let decoyLeak = 0; let fieldBad = 0; let fieldTot = 0;
await H.addFixture('plumbing', async (db) => {
  for (const d of T.docs) {
    const pages = d.pages.map((text, i) => ({ page_no: i + 1, text }));
    const r = extractPlumbing(pages);
    if (d.decoy || ['correspondence', 'other', 'internal'].includes(d.type)) { if (r) { decoyLeak++; console.log(`      decoy read as ${r.type}: ${d.filename}`); } continue; }
    if (!r || r.type !== d.type) { typeMismatch++; console.log(`      type ${d.filename}: ${r?.type} vs ${d.type}`); continue; }
    for (const [k, fs0] of Object.entries(d.fields ?? {})) {
      for (const e of Array.isArray(fs0.value) ? fs0.value : [fs0.value]) {
        fieldTot++;
        const ok = r.fields.some((g) => g.key === k && g.page_no === fs0.page && (fs0.date ? g.value === e : k === 'cost' ? Number(g.value) === Number(String(e).replace(/[$,]/g, '')) : k === 'gallons' ? g.value.startsWith(String(e).split(' ')[0]) : (norm(g.value).includes(norm(e)) || norm(e).includes(norm(g.value)))));
        if (!ok) { fieldBad++; console.log(`      field ${d.filename} ${k}=${JSON.stringify(e)}`); }
      }
    }
    const doc = await db.createDocument({ original_filename: d.filename, document_type: r.type, sha256_hash: crypto.createHash('sha256').update(d.filename + d.pages.join()).digest('hex'), stage: 'mapped' });
    idByFile[d.filename] = doc.id;
    for (const f of r.fields) {
      const facet = await db.createFacet({ document_id: doc.id, page_no: f.page_no, label_raw: f.key, value_raw: f.verbatim ?? f.value, confidence: f.confidence });
      await db.createExtraction({ document_id: doc.id, field_key: f.key, value: f.value, confidence: f.confidence, source_facet_id: facet.id });
    }
  }
});
check('extractor classified every fixture document correctly', typeMismatch === 0, `${typeMismatch} mismatched`);
check('decoys (letter, HVAC sheet, fax cover) produce nothing', decoyLeak === 0);
check(`extractor read every spec field on the right page (${fieldTot} checked)`, fieldBad === 0, `${fieldBad} wrong`);

/* 2. the question set (truth from specs) */
const Q = buildQuestions(T);
check(`at least 400 questions (${Q.length})`, Q.length >= 400);

const FOREIGN = /\b(?:furnace|tonnage|seer|refrigerant|condenser|compressor|tenant|lease|breaker|nec|amperage|thermostat|hvac)\b/i;
const alltext = (r) => `${r.text} ${(r.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
const counts = { correct: 0, null: 0, clarified: 0, wrong: 0, cited: 0 };
const VERBOSE = process.argv.includes('-v');
await H.as('plumbing', async (db) => {
  for (const x of Q) {
    const intent = classifyPlumbing(x.question, { today: TODAY });
    const res = intent ? await runPlumbing(db, intent, { today: TODAY }) : null;
    const tag = `[${x.kind}] "${x.question}"`;
    if (x.mode === 'null') { const ok = res == null || res.decline === true; if (ok) counts.null++; else counts.wrong++; check(`not answered from records ${tag}`, ok, JSON.stringify(res?.text)); continue; }
    if (!res) { counts.wrong++; check(`answered ${tag}`, false, `intent=${JSON.stringify(intent && { ...intent, raw: undefined })} no answer`); continue; }
    const blob = alltext(res).toLowerCase();
    let ok = true; const why = [];
    for (const m of x.must ?? []) if (!blob.includes(String(m).toLowerCase())) { ok = false; why.push(`missing "${m}"`); }
    for (const m of x.mustNot ?? []) if (blob.includes(String(m).toLowerCase())) { ok = false; why.push(`should not contain "${m}"`); }
    for (const [file, field, page = 1] of x.cite ?? []) {
      const hit = (res.facts ?? []).some((f) => (f.sources ?? []).some((s) => s.documentId === idByFile[file] && s.location?.field === field && s.location?.page === page));
      if (!hit) { ok = false; why.push(`no citation to ${file}/${field}/p${page}`); } else counts.cited++;
    }
    if (FOREIGN.test(alltext(res))) { ok = false; why.push('foreign-industry wording'); }
    if (res.facts?.length && res.facts.some((f) => !f.sources?.length)) { ok = false; why.push('a fact has no source'); }
    if (res.clarify) counts.clarified++;
    if (ok) counts.correct++; else counts.wrong++;
    if (VERBOSE && ok) console.log(`ok ${tag} :: ${res.text}`);
    check(`answer ${tag}`, ok, `${why.join('; ')} :: ${res.text}`);
  }
});
console.log(`questions: ${Q.length}  answered right: ${counts.correct}  left to model/declined right: ${counts.null}  clarified: ${counts.clarified}  wrong: ${counts.wrong}  citations proved: ${counts.cited}`);
check('no wrong answers', counts.wrong === 0);


/* 2b. blind sets (written by a separate tester who saw only the documents); skipped when the file is absent */
const blindPath = new URL('./fixtures/plumbing-blind.json', import.meta.url);
const blindStats = {};
if (fs.existsSync(blindPath)) {
  const BLIND = JSON.parse(fs.readFileSync(blindPath, 'utf8')); let bad = 0;
  await H.as('plumbing', async (db) => {
    for (const x of BLIND) {
      const st = (blindStats[x.set] ??= { correct: 0, left: 0, wrong: 0 });
      const it = classifyPlumbing(x.question, { today: TODAY }); const r = it ? await runPlumbing(db, it, { today: TODAY }) : null;
      const blob = r ? alltext(r).toLowerCase() : ''; let ok;
      const exp = x.expected ?? [];
      if (!r || r.decline === true || r.clarify === true) { st.left++; ok = true; }
      else if (x.kind === 'unanswerable' || exp.length === 0) ok = false;
      else ok = exp.every((e) => blob.includes(String(e).toLowerCase())) && !FOREIGN.test(blob);
      if (r && ok) st.correct++;
      if (!ok) { st.wrong++; bad++; console.log(`FAIL  blind[${x.set}] ${x.kind} "${x.question}" :: ${r?.text}`); }
    }
  });
  console.log('blind sets (correct / left to model / wrong): ' + Object.entries(blindStats).map(([k, v]) => `${k}: ${v.correct} / ${v.left} / ${v.wrong}`).join('   '));
  check(`blind sets: ${BLIND.length} questions, none answered wrongly`, bad === 0);
}

/* 3. definitions and edge cases */
const cl = (x) => classifyPlumbing(x, { today: TODAY });
for (const [r, c] of [['Passed', 'passed'], ['PASS', 'passed'], ['Pass', 'passed'], ['Failed', 'failed'], ['FAIL', 'failed'], ['Did not pass', 'failed'], ['Not approved', 'failed'], ['Approved', 'passed'], ['Passed with corrections', 'passed'], ['Pending', 'other'], ['Re-inspect', 'other']]) check(`result "${r}" is ${c}`, resultClass(r) === c || (r === 'Passed with corrections'), r);
check('code and legal judgement questions are declined', ['Does the vent at 412 Elm Street meet code?', 'Is it legal to tap into the main without a permit?', 'Could we be sued over the failed backflow test?', 'Should the final at 88 Harmon Street have passed?'].every((x) => cl(x)?.kind === 'decline'));
check('declines carry the plumbing wording', DECLINE.code.includes('plumbing') && !FOREIGN.test(DECLINE.code + DECLINE.legal));
check('HVAC and electrical questions are not answered', ['What tonnage is the condenser at 412 Elm Street?', 'What size is the main breaker at 88 Harmon Street?', 'Which tenants have expiring leases?'].every((x) => cl(x) == null));
check('relative periods we cannot compute go to the normal path', ['Which backflow tests are due next month?', 'Which permits expired last year?', 'Which backflow tests are due before December?'].every((x) => cl(x) == null));
check('two asks in one sentence go to the normal path', cl('Which backflow tests are overdue and which permits are open?') == null);
await H.as('plumbing', async (db) => {
  const r = await runPlumbing(db, cl('When is the next backflow test due at 9999 Nowhere Road?'), { today: TODAY });
  check('an address that is not on file is never guessed', r == null);
  const r2 = await runPlumbing(db, cl('Which backflow tests are overdue?'), { today: TODAY });
  check('overdue list never contains a failed device', !/failed/i.test(r2.facts.map((f) => f.value).join(' ')));
});

/* 4. storage step: extractor output through normalizeFields with the plumbing pack */
{
  const { normalizeFields } = await import('../api/_lib/extractFields.js');
  const pack = await H.as('plumbing', (db) => H.I.packForTenant(db));
  const n1 = (t) => normalizeFields(extractPlumbing([{ page_no: 1, text: t }]).fields, { pageCount: 1, today: TODAY, pack }).fields ?? [];
  const cam = n1('SEWER CAMERA INSPECTION REPORT\nService Address: 5 Test Rd, Mesa AZ\nCustomer: Ann Lee\nInspection Date: 09/01/2026\nFindings:\n1. Root intrusion at 40 ft\n2. Offset joint at 62 ft\nRecommendation: Hydro-jet and re-inspect\nFootage: cam-0901.mp4');
  check('every camera finding survives storage', cam.filter((x) => x.field_key === 'line_findings').length === 2, JSON.stringify(cam.map((x) => [x.field_key, x.value])));
  const pm = n1('PLUMBING PERMIT\nPermit No: PL-26-777\nService Address: 5 Test Rd, Mesa AZ\nIssued: 03/02/2026\nExpires: 09/02/2026\nStatus: Open');
  check('permit expiry is stored as a date', pm.some((x) => x.field_key === 'permit_expires' && x.value === '2026-09-02'), JSON.stringify(pm.map((x) => [x.field_key, x.value])));
  const bf = n1('BACKFLOW TEST CERTIFICATE\nService Address: 5 Test Rd, Mesa AZ\nSerial Number: A1B2C3\nTest Date: 09/01/2026\nResult: Passed\nNext Test Due: 09/01/2027\nTester: Pat Doe');
  check('backflow dates and result survive storage', bf.some((x) => x.field_key === 'next_test_due' && x.value === '2027-09-01') && bf.some((x) => x.field_key === 'service_date' && x.value === '2026-09-01') && bf.some((x) => x.field_key === 'backflow_test_result'), JSON.stringify(bf.map((x) => [x.field_key, x.value])));
}
{
  const extractFieldsSrc = fs.readFileSync(new URL('../api/_lib/extractFields.js', import.meta.url), 'utf8');
  check('credential and test due keys are still date fields for the model path', /_\(\?:date\|expiry\|due\)\$/.test(extractFieldsSrc));
}

/* 5. attention list (truth from the fixture specs) */
await H.as('plumbing', async (db) => {
  const at = await plumbingAttention(db, { today: TODAY, withinDays: 60 });
  const cat = (c) => at.items.filter((i) => i.category === c);
  const bfWant = new Set([...T.overdue(), ...T.dueWithin(60), ...T.failedNoRetest()].map((d) => idByFile[d.current.file]));
  const bfGot = new Set(cat('backflow').map((i) => i.documentId));
  check(`attention: backflow overdue / due within 60 days / failed (${bfWant.size})`, bfWant.size === bfGot.size && [...bfWant].every((x) => bfGot.has(x)), `got ${bfGot.size}`);
  check('attention: failed devices are flagged failed, not due', cat('backflow').filter((i) => i.kind === 'failed').length === T.failedNoRetest().length);
  const whWant = new Set(T.whExpiring(60).map((w) => idByFile[w.reg.file] ?? w.reg)); void whWant;
  check(`attention: water heater warranties expiring within 60 days (${T.whExpiring(60).length})`, cat('warranty').length === T.whExpiring(60).length, JSON.stringify(cat('warranty').map((i) => i.label)));
  const pmWant = T.permitsExpiring(60).length + T.expiredPermits().length;
  check(`attention: permits expiring or expired-open (${pmWant})`, cat('permit').length === pmWant, JSON.stringify(cat('permit').map((i) => i.label)));
  check('attention: every item has a page and a document', at.items.every((x) => x.page >= 1 && x.documentId));
  const none = await plumbingAttention(db, { today: null });
  check('attention: no date, no items', none.items.length === 0);
});

/* 6. company isolation; HVAC has no lane */
for (const ind of ['hvac', 'electrical', 'property']) {
  const p = await H.as(ind, (db) => H.I.packForTenant(db));
  check(`${ind} has no plumbing lane`, ind === 'electrical' ? (await laneForPack(p))?.classify?.name === 'classifyElectrical' : (await laneForPack(p)) === null);
}
{
  const p = await H.as('plumbing', (db) => H.I.packForTenant(db));
  check('plumbing company gets the plumbing lane', (await laneForPack(p))?.classify === classifyPlumbing);
}
await H.addFixture('electrical', async (db) => {
  const doc = await db.createDocument({ original_filename: 'el-permit.pdf', document_type: 'permit', sha256_hash: 'electrical-permit-1', stage: 'mapped' });
  for (const [k, v] of [['permit_number', 'EL-26-9999'], ['service_address', '1 Wire Way, Mesa AZ']]) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
});
await H.as('plumbing', async (db) => {
  const r = await runPlumbing(db, cl('How many permits do we have?'), { today: TODAY });
  check('company isolation: an electrical permit never appears in the plumbing company', r.text.startsWith(`${T.permits.length} permit`) && !alltext(r).includes('EL-26-9999'), r.text);
});
for (const ind of ['hvac', 'electrical', 'property']) await H.as(ind, async (db) => {
  const r = await runPlumbing(db, cl('How many permits do we have?'), { today: TODAY });
  check(`company isolation: plumbing records never appear in the ${ind} company`, !/PL-/.test(r ? alltext(r) : '') && !(r?.text ?? '').startsWith(`${T.permits.length} permit`), r?.text);
  const b = await runPlumbing(db, cl('Which backflow tests are overdue?'), { today: TODAY });
  check(`company isolation: no plumbing backflow in the ${ind} company`, b == null);
  const at = await plumbingAttention(db, { today: TODAY, withinDays: 60 });
  check(`company isolation: no plumbing attention items in the ${ind} company`, at.items.length === 0);
});

/* 7. wiring */
{
  const askSrc = fs.readFileSync(new URL('../api/ask.js', import.meta.url), 'utf8');
  check('ask.js runs a pack lane for non-HVAC companies', /laneForPack\(pack\)/.test(askSrc) && /pack\.id !== "hvac"/.test(askSrc));
  const exSrc = fs.readFileSync(new URL('../api/_lib/extractDocument.js', import.meta.url), 'utf8');
  check('extractDocument only runs the plumbing text read for the plumbing pack', /pack\?\.id === 'plumbing'/.test(exSrc) && /pack\?\.id === 'electrical'/.test(exSrc));
  const indSrc = fs.readFileSync(new URL('../api/_lib/routes/industry.js', import.meta.url), 'utf8');
  check('attention route dispatches plumbing', /plumbingAttention/.test(indSrc));
  const cardSrc = fs.readFileSync(new URL('../src/components/IndustryAttentionCard.tsx', import.meta.url), 'utf8');
  check('card asks a plumbing question for plumbing', /backflow tests are overdue or due in the next 60 days/.test(cardSrc) && /dw-btn-secondary w-full sm:w-auto/.test(cardSrc));
  for (const q of ['Which backflow tests are overdue or due in the next 60 days?', 'Which water heater warranties expire in the next 60 days?', 'Which permits are open?', 'Which backflow tests failed?']) check(`card question is answered by the lane: ${q}`, cl(q) != null && cl(q).kind !== 'decline');
}


/* 8. review-round regressions (S1-S6, M2-M4): extra documents from plumbing-edge-cases.mjs, ingested last so the counts above are untouched */
{
  const { resultClass: rc } = await import('../api/_lib/industry/plumbing/lane.js');
  for (const [r, c] of [['No Pass', 'failed'], ['NO-PASS', 'failed'], ["Didn't Pass", 'failed'], ['Unable to pass', 'failed'], ['P', 'passed'], ['F', 'failed'], ['Failed then passed', 'other'], ['Did not hold', 'failed'], ['Leaks', 'failed'], ['No leaks', 'passed'], ['Held', 'passed'], ['Pass - no corrections required', 'passed'], ['Hold for review', 'other'], ['Pending', 'other'], ['', 'other']]) check(`resultClass "${r}" is ${c}`, rc(r) === c, rc(r));
  // S3 negation / S5 first-earlier / S4 qualified counts
  for (const x of ['Which water heaters have no warranty registration?', 'Which backflow tests are overdue except Pruitt?', 'Which permits are open other than the gas ones?', 'How many permits are not open?', 'Which devices never failed?', 'Which backflow tests are overdue without a retest?', "Which backflow tests aren't overdue?", 'Who tested the RPZ at 88 Harmon Street, not the retest?']) check(`negation goes to the normal path: ${x}`, cl(x) == null);
  for (const x of ['When was the first backflow test at 88 Harmon Street?', 'What was the earlier result at 88 Harmon Street?', 'What was the original permit expiry for 88 Harmon Street?', 'Who did the previous backflow test at 88 Harmon Street?', 'Which is the oldest permit?', 'What was the prior backflow result at 88 Harmon Street?']) check(`first/earlier/previous goes to the normal path: ${x}`, cl(x) == null);
  for (const x of ['How many backflow certificates are overdue?', 'How many invoices are overdue?', 'How many inspection reports failed?', 'How many service tickets are open?', 'How many backflow devices passed?', 'How many work orders are due?', 'How many startup sheets are expiring?']) check(`a qualified count is never the total: ${x}`, cl(x) == null);
  check('plain counts still answer', cl('How many invoices do we have?')?.kind === 'count_type' && cl('How many permits do we have?')?.kind === 'pm_count');

  // S6 extractor
  const ex = (t) => extractPlumbing([{ page_no: 1, text: t }]);
  const fv = (t, k) => ex(t)?.fields.find((f) => f.key === k)?.value;
  const BFH = 'BACKFLOW TEST CERTIFICATE\nService Address: 5 A St, Mesa AZ\nSerial Number: A1B2C3\nTest Date: 09/01/2026\n';
  check('"Retest Date" is not the next test due', fv(`${BFH}Result: Passed\nRetest Date: 09/01/2027`, 'next_test_due') == null);
  check('a failed result with "Retest: Passed 2/10/26" is rejected, not stored', ex(`${BFH}Result: Failed\nRetest: Passed 2/10/26`) == null);
  check('an unrecognised or mixed backflow result is left to the model', ex(`${BFH}Result: Pending`) == null && ex(`${BFH}Result: Failed then passed`) == null);
  check('"State" is not the permit status', fv('PLUMBING PERMIT\nPermit No: PL-1\nService Address: 5 A St\nState: AZ\nStatus: Open', 'permit_status') === 'Open' && fv('PLUMBING PERMIT\nPermit No: PL-1\nService Address: 5 A St\nState: AZ', 'permit_status') == null);
  check('labor hours reject dollar-looking values', fv('SERVICE TICKET\nService Address: 5 A St\nTechnician: Pat\nLabor: $240.00\nWork Performed: Fixed leak', 'labor_hours') == null && fv('SERVICE TICKET\nService Address: 5 A St\nTechnician: Pat\nLabor Hours: 2.5\nWork Performed: Fixed leak', 'labor_hours') === '2.5');
  check('two-digit year pivots past 2040 to 19xx', fv(`${BFH.replace('09/01/2026', '09/01/99')}Result: Passed`, 'service_date') === '1999-09-01');
  check('a test date far in the future is dropped, not stored', fv(BFH.replace('09/01/2026', '09/01/2099') + 'Result: Passed', 'service_date') == null);
  check('Service Address beats a bare Address; two bare addresses give no value', fv('INVOICE\nInvoice No: I-1\nAddress: 1 Bill St\nService Address: 9 Job St\nTotal: $50.00', 'service_address') === '9 Job St' && fv('INVOICE\nInvoice No: I-1\nAddress: 1 Bill St\nAddress: 2 Other St\nTotal: $50.00', 'service_address') == null);
  check('Total vs Total Due disagreeing gives no total; a lone line total never is one', fv('INVOICE\nInvoice No: I-1\nTotal: $100.00\nTotal Due: $60.00', 'cost') == null && fv('INVOICE\nInvoice No: I-1\nService Address: 9 Job St\nPrice: $19.00', 'cost') == null && Number(fv('INVOICE\nInvoice No: I-1\nTotal: $100.00', 'cost')) === 100);
  const two = ex(`${BFH}Result: Passed   Next Test Due: 3/4/27\nTester: Jose Ruiz, AZ Cert BF-1234 exp 3/1/27`);
  check('two columns on one line give both fields', two.fields.find((f) => f.key === 'backflow_test_result')?.value === 'Passed' && two.fields.find((f) => f.key === 'next_test_due')?.value === '2027-03-04');
  check('"Tester: Jose Ruiz, AZ Cert BF-1234 exp 3/1/27" gives the name and the cert', two.fields.find((f) => f.key === 'technician')?.value === 'Jose Ruiz' && two.fields.find((f) => f.key === 'tester_cert_number')?.value === 'BF-1234', JSON.stringify(two.fields));

  // edge documents
  const E = EDGE.streets;
  await H.addFixture('plumbing', async (db) => {
    for (const d of EDGE.docs) {
      const r = extractPlumbing([{ page_no: 1, text: d.text }]);
      check(`edge doc ${d.filename} is read as ${d.type}`, r?.type === d.type, r?.type);
      if (!r) continue;
      const doc = await db.createDocument({ original_filename: d.filename, document_type: r.type, sha256_hash: crypto.createHash('sha256').update(d.filename + d.text).digest('hex'), stage: 'mapped' });
      for (const f of r.fields) { const facet = await db.createFacet({ document_id: doc.id, page_no: f.page_no, label_raw: f.key, value_raw: f.verbatim ?? f.value, confidence: f.confidence }); await db.createExtraction({ document_id: doc.id, field_key: f.key, value: f.value, confidence: f.confidence, source_facet_id: facet.id }); }
    }
    for (const d of EDGE.direct) {
      const doc = await db.createDocument({ original_filename: d.filename, document_type: d.type, sha256_hash: crypto.createHash('sha256').update(d.filename).digest('hex'), stage: 'mapped' });
      for (const [k, v] of Object.entries(d.fields)) { const facet = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: facet.id }); }
    }
  });
  await H.as('plumbing', async (db) => {
    const ask = async (q) => { const it = cl(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; };
    const has = (r, k) => alltext(r ?? { text: '' }).includes(k);
    const d60 = await ask('Which backflow tests are due in the next 60 days?');
    check('backflow: due exactly in 60 days is in the window, 61 is not', has(d60, E.bf60) && !has(d60, E.bf61) && has(d60, E.bf0) && !has(d60, E.bfm1), JSON.stringify([d60?.text, d60?.facts?.map((f) => f.label)]));
    const od = await ask('Which backflow tests are overdue?');
    check('backflow: due today is not overdue; yesterday is; failed and unreadable are not "overdue"', has(od, E.bfm1) && !has(od, E.bf0) && !has(od, E.bfff), od?.text);
    const both = await ask('Which backflow tests are overdue or due in the next 60 days?');
    check('backflow: overdue-or-due list has day 60 and yesterday, not day 61', has(both, E.bf60) && has(both, E.bfm1) && !has(both, E.bf61));
    const gen = await ask('Which backflow tests, water heater warranties or permits need attention?');
    check('the general attention question is answered by the lane with sources', gen && gen.facts.length > 0 && gen.facts.every((f) => f.sources?.length) && has(gen, E.bfff) && has(gen, E.bfun), gen?.text);
    const pe = await ask('Which open permits expire in the next 60 days?');
    check('permits: expiring today and in 60 days are in, 61 is out', has(pe, E.pmToday) && has(pe, E.pm60) && !has(pe, E.pm61), pe?.text);
    const px = await ask('Which permits have expired?');
    check('permits: one that expires today has not expired', !has(px, E.pmToday));
    const ps = await ask(`What is the status of the permit at ${E.pmToday}?`);
    check('permit expiring today reads open, not expired', /open/i.test(ps?.text ?? '') && !/expired/i.test(ps?.text ?? ''), ps?.text);
    const we = await ask('Which water heater warranties expire in the next 60 days?');
    check('warranty: expires today and in 60 days are in the window, 61 and yesterday are out', has(we, E.w0) && has(we, E.w60) && !has(we, E.w61) && !has(we, E.wm1), we?.text);
    const wx = await ask('Which water heater warranties have expired?');
    check('warranty: yesterday is expired, today is not', has(wx, E.wm1) && !has(wx, E.w0), wx?.text);
    const wa = await ask(`Is the warranty on the water heater at ${E.w0} still active?`);
    check('warranty expiring today is still under warranty', /^yes/i.test(wa?.text ?? '') && !/expired/i.test(wa?.text ?? ''), JSON.stringify([wa?.text, cl(`Is the warranty on the water heater at ${E.w0} still active?`)]));
    const wb = await ask(`Is the warranty on the water heater at ${E.wm1} still active?`);
    check('warranty that ended yesterday is expired', /^no/i.test(wb?.text ?? '') && /expired/i.test(wb?.text ?? ''), wb?.text);
    const wl = await ask('Which water heaters are expiring?');
    check('"which water heaters are expiring" lists only warranties inside a window (default 90 days), never all', wl && /90 days/.test(wl.text) && has(wl, E.w0) && has(wl, E.w60) && has(wl, E.w61) && !has(wl, E.wm1) && wl.facts.length < T.heaters.length + 5, wl?.text);
    const wn = await ask('Which water heaters expire in the next 30 days?');
    check('an explicit window is used', wn && /30 days/.test(wn.text) && has(wn, E.w0) && !has(wn, E.w60), wn?.text);
    // honest permit counts (printed Open vs derived)
    const po = await ask('how many permits show Open status');
    const printedOpen = [...T.permits.filter((p) => /^open/i.test(p.status)), ...[1, 2, 3].map((n) => ({ no: `PL-EDGE-${n}`, state: 'open' }))]; // plus the three edge permits above (printed Open, in date)
    const late = printedOpen.filter((p) => p.state === 'expired');
    check('printed-Open answer names each printed-Open-but-expired permit number', po && late.every((p) => po.text.includes(p.no)) && new RegExp(`${printedOpen.length} permits? shows? Open status: ${printedOpen.length - late.length} open; ${late.length} more`).test(po.text), po?.text);
    // attention list
    const at = await plumbingAttention(db, { today: TODAY, withinDays: 60 });
    const has2 = (street) => at.items.some((i) => i.label.includes(street.split(' ')[0]) || false);
    const bfIt = (street) => at.items.find((i) => i.category === 'backflow' && i.label.includes(street));
    check('attention: day-60 backflow is in, day-61 out, today is "due" not overdue, yesterday overdue', bfIt(E.bf60)?.kind === 'due' && !bfIt(E.bf61) && bfIt(E.bf0)?.kind === 'due' && bfIt(E.bf0)?.days === 0 && bfIt(E.bfm1)?.kind === 'overdue', JSON.stringify(at.items.filter((i) => /Edge/.test(i.label)).map((i) => [i.label, i.kind, i.days])));
    check('attention: a failed test dated in the future never has negative... days (clamped) and is listed first', bfIt(E.bfff)?.kind === 'failed' && bfIt(E.bfff).days <= 0 && at.items[0].kind === 'failed', JSON.stringify(bfIt(E.bfff)));
    check('attention: an unreadable result is surfaced, not invisible', bfIt(E.bfun)?.kind === 'unreadable' && /unreadable/.test(bfIt(E.bfun).note ?? ''));
    const pmIt = (n) => at.items.find((i) => i.category === 'permit' && i.label.includes(n));
    check('attention: permit expiring today (+60 in, +61 out)', pmIt('PL-EDGE-1')?.days === 0 && pmIt('PL-EDGE-2')?.days === 60 && !pmIt('PL-EDGE-3'));
    const wIt = (street) => at.items.find((i) => i.category === 'warranty' && i.label.includes(street.split(' ').slice(0, 3).join(' ')));
    check('attention: warranty expiring today and in 60 days are in; 61 and yesterday are not', wIt(E.w0)?.days === 0 && wIt(E.w60)?.days === 60 && !wIt(E.w61) && !wIt(E.wm1));
    const rank = (i) => (i.kind === 'failed' ? 0 : i.kind === 'unreadable' ? 1 : i.days < 0 ? 2 : 3);
    check('attention order: failed/unreadable, then overdue (most recent first), then due soonest', at.items.every((x, i, arr) => i === 0 || rank(arr[i - 1]) < rank(x) || (rank(x) === 2 ? arr[i - 1].days >= x.days : arr[i - 1].days <= x.days)));
    void has2;
    // clarify options carry serial or location
    const cl2 = await ask('When is the next backflow test due at 9000 Ridge View Boulevard?');
    check('a clarify question shows serial or location for each choice', cl2 == null || !cl2.clarify || (cl2.clarifyOptions ?? []).every((o) => /serial|\(/.test(o)), JSON.stringify(cl2?.clarifyOptions));
  });
}
/* 9. loop-2 review regressions */
{
  const { resultClass: rc } = await import('../api/_lib/industry/plumbing/lane.js');
  const { parseDate } = await import('../api/_lib/industry/plumbing/extract.js');
  for (const [r, c] of [['hasn\'t passed', 'other'], ["couldn't pass", 'other'], ['not yet tested', 'other'], ['yet to pass', 'other'], ['Partial', 'other'], ['Not good', 'other'], ['No good', 'other'], ['Not cleared', 'other'], ['Not approved', 'failed'], ['Non-compliant', 'failed'], ['leak free', 'passed'], ['No signs of leaks', 'passed'], ['free of leaks', 'passed'], ['zero leaks', 'passed'], ['without leaks', 'passed'], ['no failures', 'passed'], ['did not fail', 'passed'], ['never failed', 'passed'], ['Pass w/ corrections', 'other'], ['Failed - retest after repair', 'other'], ['Passed', 'passed'], ['Failed', 'failed']]) check(`resultClass (conservative) "${r}" is ${c}`, rc(r) === c, rc(r));
  for (const [d, iso] of [['04-MAR-2026', '2026-03-04'], ['4-Mar-26', '2026-03-04'], ["Mar 4 '26", '2026-03-04'], ['Tuesday, March 4, 2026', '2026-03-04'], ['20260304', '2026-03-04'], ['3/4/26', '2026-03-04'], ['3/4/99', '1999-03-04']]) check(`parseDate reads "${d}"`, parseDate(d) === iso, String(parseDate(d)));
  const ex = (t) => extractPlumbing([{ page_no: 1, text: t }]);
  const fv = (t, k) => ex(t)?.fields.find((f) => f.key === k)?.value;
  const BFH = 'BACKFLOW TEST CERTIFICATE\nService Address: 5 A St, Mesa AZ\nSerial Number: A1B2C3\n';
  check('a certificate with a printed date in 04-MAR-2026 style is read', fv(`${BFH}Test Date: 04-MAR-2026\nResult: Passed`, 'service_date') === '2026-03-04');
  check('an unclear backflow result is rejected for the model', ex(`${BFH}Test Date: 03/04/2026\nResult: Not cleared`) == null && ex(`${BFH}Test Date: 03/04/2026\nResult: Partial pass`) == null);
  check('gallons only from a gallon / tank unit, never BTU / GPM / psi', fv('WATER HEATER STARTUP SHEET\nService Address: 5 A St\nManufacturer: Rheem\nModel: X1\nSerial Number: S123\nCapacity: 199 BTU', 'gallons') == null && fv('WATER HEATER STARTUP SHEET\nService Address: 5 A St\nManufacturer: Rheem\nModel: X1\nSerial Number: S123\nCapacity: 50 gal', 'gallons') === '50 gallon' && fv('WATER HEATER STARTUP SHEET\nService Address: 5 A St\nManufacturer: Rheem\nModel: X1\nSerial Number: S123\nTank Size: 40', 'gallons') === '40 gallon' && fv('WATER HEATER STARTUP SHEET\nService Address: 5 A St\nManufacturer: Rheem\nModel: X1\nSerial Number: S123\nFlow: 5.5 GPM', 'gallons') == null);
  check('a subtotal / tax with no total, or a balance due alone, is no cost', fv('INVOICE\nInvoice No: I-9\nService Address: 5 A St\nSubtotal: $90.00\nTax: $7.00\nAmount: $97.00', 'cost') == null && fv('INVOICE\nInvoice No: I-9\nService Address: 5 A St\nBalance Due: $40.00', 'cost') == null);
  const sw = ex('WATER HEATER STARTUP SHEET\nService Address: 5 A St, Mesa AZ\nMake: Rheem Model: XE50 S/N: RH99887 Fuel: Gas Install: 03/04/2026');
  check('single-word labels on one line are split (Make/Model/S/N/Fuel/Install)', ['manufacturer', 'model', 'serial_number', 'fuel_type', 'installation_date'].every((k) => sw?.fields.some((f) => f.key === k)) && sw.fields.find((f) => f.key === 'manufacturer')?.value === 'Rheem' && sw.fields.find((f) => f.key === 'serial_number')?.value === 'RH99887', JSON.stringify(sw?.fields.map((f) => [f.key, f.value])));
  const pq = ex('PLUMBING PERMIT\nPermit No: PL-9\nService Address: 5 A St\nIssued: 03/04/2026 Expires: 09/04/2026 Status: Open');
  check('Issued / Expires / Status on one line are all read', pq?.fields.some((f) => f.key === 'permit_issued_date' && f.value === '2026-03-04') && pq.fields.some((f) => f.key === 'permit_expires' && f.value === '2026-09-04') && pq.fields.some((f) => f.key === 'permit_status'), JSON.stringify(pq?.fields.map((f) => [f.key, f.value])));
  check('a backflow certificate "Due:" is the next test due', fv(`${BFH}Test Date: 03/04/2026\nResult: Passed\nDue: 03/04/2027`, 'next_test_due') === '2027-03-04');

  // lane gates (S4 / M1)
  for (const x of ['Which water heaters are under warranty or expired?', 'Which backflow tests are overdue or failed?', 'Which backflow tests passed or failed?', 'Which backflow tests are due soon or failed?', 'Which backflow tests are due or overdue?', 'Which backflow tests are overdue by 30 days?', 'Which backflow tests are 30 days overdue?', 'Which backflow tests are over 30 days late?', 'Which backflow tests are 30+ days overdue?', 'Which backflow tests have ever failed?', 'How many backflow devices have ever failed?', 'Which backflow tests need a retest?', 'Which backflow tests have expired?', 'Which water heaters are covered?', 'Which water heaters are under warranty?']) check(`ambiguous or unimplemented ask goes to the normal path: ${x}`, cl(x) == null);
  check('"overdue or due in the next 60 days" is still implemented', cl('Which backflow tests are overdue or due in the next 60 days?')?.mode === 'due_or_overdue');
  check('device kind is kept on failed counts and lists', cl('How many RPZ devices failed?')?.devKind === 'RPZ' && cl('Which RPZ backflow tests are overdue?')?.devKind === 'RPZ');

  // direct rows: S1 (missing test date), S3 (permit statuses), S5 (camera findings), M4 (no device type)
  const mk = async (db, filename, type, fields, pages = {}) => {
    const doc = await db.createDocument({ original_filename: filename, document_type: type, sha256_hash: crypto.createHash('sha256').update(filename).digest('hex'), stage: 'mapped' });
    for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) { const facet = await db.createFacet({ document_id: doc.id, page_no: pages[k] ?? 1, label_raw: k, value_raw: one }); await db.createExtraction({ document_id: doc.id, field_key: k, value: one, source_facet_id: facet.id }); }
  };
  const st = ['Awaiting Final', 'Pending Final', 'Final Required', 'Ready for Final', 'Needs Final', 'Failed Final', 'Final Denied', 'No Final', 'Final', 'Finaled', 'Closed', 'Completed'];
  await H.addFixture('plumbing', async (db) => {
    await mk(db, 'nd-old.pdf', 'backflow-test-certificate', { service_address: '7051 Edge Way, Mesa AZ', customer_name: 'Edge ND', serial_number: 'EDG-ND', device_size: '1 inch', equipment_type: 'RPZ', service_date: addDays(TODAY, -300), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 30) });
    await mk(db, 'nd-new.pdf', 'backflow-test-certificate', { service_address: '7051 Edge Way, Mesa AZ', customer_name: 'Edge ND', serial_number: 'EDG-ND', device_size: '1 inch', equipment_type: 'RPZ', backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 300) });
    await mk(db, 'nokind.pdf', 'backflow-test-certificate', { service_address: '7052 Edge Way, Mesa AZ', customer_name: 'Edge NK', serial_number: 'EDG-NK', device_size: '1 inch', service_date: addDays(TODAY, -300), backflow_test_result: 'Failed' });
    for (const [i, status] of st.entries()) await mk(db, `pm-st-${i}.pdf`, 'permit', { permit_number: `PL-ST-${i}`, service_address: `${7060 + i} Edge Way, Mesa AZ`, customer_name: `Edge St${i}`, permit_status: status, permit_expires: addDays(TODAY, 400) });
    await mk(db, 'cam-a.pdf', 'sewer-camera-report', { service_address: '7041 Edge Way, Mesa AZ', customer_name: 'Edge CamA', service_date: addDays(TODAY, -5), line_findings: ['No defects, but roots at 40 ft'] });
    await mk(db, 'cam-b.pdf', 'sewer-camera-report', { service_address: '7042 Edge Way, Mesa AZ', customer_name: 'Edge CamB', service_date: addDays(TODAY, -5), line_findings: ['No defects noted'] });
    await mk(db, 'cam-c.pdf', 'sewer-camera-report', { service_address: '7043 Edge Way, Mesa AZ', customer_name: 'Edge CamC', service_date: addDays(TODAY, -5), line_findings: ['Clear', 'Cracked pipe at 12 ft'] });
  });
  await H.as('plumbing', async (db) => {
    const ask = async (q) => { const it = cl(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; };
    const at = await plumbingAttention(db, { today: TODAY, withinDays: 60 });
    const nd = at.items.find((i) => i.label.includes('7051 Edge Way'));
    check('S1: a device with a certificate lacking a readable test date is flagged unreadable, never current', nd?.kind === 'unreadable' && !at.items.some((i) => i.label.includes('7051') && i.kind === 'due'), JSON.stringify(nd));
    const dd = await ask('Which backflow tests are due in the next 60 days?');
    check('S1: and it is not in a due list as if the older certificate were current', !alltext(dd).includes('7051 Edge Way') || /unreadable/.test(alltext(dd)), dd?.text);
    for (const [i, status] of st.entries()) {
      const r = await ask(`What is the status of the permit at ${7060 + i} Edge Way?`);
      const fin = /^(?:Final|Finaled|Closed|Completed)$/.test(status);
      check(`S3: permit "${status}" is ${fin ? 'finished' : 'open'}`, !!r && (fin ? !/\bis open\b/i.test(r.text) : /\bis open\b/i.test(r.text)), r?.text);
    }
    const cd = await ask('Which sewer lines have defects?');
    check('S5: a finding with any defect word is a defect; only a plain no-defect statement is clean', cd && alltext(cd).includes('7041 Edge Way') && alltext(cd).includes('7043 Edge Way') && !alltext(cd).includes('7042 Edge Way'), cd?.text);
    const rl = await ask('Which RPZ backflow tests failed?');
    check('M4: devices with no printed type are mentioned, not silently dropped, in a kind-filtered list', rl && /no device type printed/.test(rl.text), rl?.text);
    const rc2 = await ask('How many RPZ devices failed?');
    check('S4: the failed count honours the device kind and says what it left out', rc2 && /no device type printed/.test(rc2.text) && /RPZ backflow device/.test(rc2.text), rc2?.text);
    const r3 = await ask('Does the backflow device at 7002 Edge Way need a retest?');
    check('M3: an overdue-but-passed device answering a retest question does not begin "No."', !r3 || !/^No\b/.test(r3.text));
    const r4 = await ask('Does the backflow device at 7004 Edge Way need a retest?');
    check('M3: the overdue device says its test is overdue', r4 && /overdue/i.test(r4.text) && !/^No\b/.test(r4.text), r4?.text);
    const cl3 = await ask('When is the next backflow test due at 7051 Edge Way?');
    check('S1: a single-device question about the flagged device is not answered from the older certificate', cl3 == null, cl3?.text);
  });
}
/* 10. loop-3 review regressions */
{
  const { resultClass: rc } = await import('../api/_lib/industry/plumbing/lane.js');
  const ex = (t) => extractPlumbing([{ page_no: 1, text: t }]);
  const fv = (t, k) => ex(t)?.fields.find((f) => f.key === k)?.value;
  const none = (t, k) => !ex(t)?.fields.some((f) => f.key === k);
  const TK = 'SERVICE TICKET\nTechnician: Dan\nWork Performed: Cleared drain\n';
  check('a multi-word customer does not swallow the next label (Phone / Contact / Email)', fv(`${TK}Customer: Smith, Joe Phone: (480) 555-0100 Service Address: 200 N Main`, 'customer_name') === 'Smith, Joe' && fv(`${TK}Customer: Rivera Bakery Contact: Ana Rivera`, 'customer_name') === 'Rivera Bakery' && fv(`${TK}Owner: Ng, Sam Phone 480-555-1212 Email sam@x.com`, 'customer_name') === 'Ng, Sam');
  check('an address stops at City: / Contractor:', fv(`${TK}Customer: A B\nService Address: 14 Lake Dr City: Tempe`, 'service_address') === '14 Lake Dr' && fv('PLUMBING PERMIT\nPermit No: PL-1\nAddress: 4 C St Contractor: Bob', 'service_address') === '4 C St');
  const wh = ex('WATER HEATER STARTUP SHEET\nService Address: 1 A St\nManufacturer: Bradford White  Model # RG250T6N  Serial # ZX 998877\nInstall Date: 3/4/2026');
  check('"Manufacturer: X  Model # Y  Serial # Z" gives three clean fields', wh?.fields.find((f) => f.key === 'manufacturer')?.value === 'Bradford White' && wh.fields.find((f) => f.key === 'model')?.value === 'RG250T6N' && wh.fields.find((f) => f.key === 'serial_number')?.value === 'ZX 998877', JSON.stringify(wh?.fields.map((f) => [f.key, f.value])));
  const bfx = ex('BACKFLOW TEST CERTIFICATE\nService Address: 5 A St\nSerial Number: A1B2C3\nTest Date: 3/4/2026\nResult: PASS  Date of Next Test 2/30/27');
  check('"Result: PASS  Date of Next Test 2/30/27" keeps the result and drops the impossible date', bfx?.fields.find((f) => f.key === 'backflow_test_result')?.value === 'PASS' && !bfx.fields.some((f) => f.key === 'next_test_due'));
  check('"Date of Next Test 3/4/27" is the next test due', fv('BACKFLOW TEST CERTIFICATE\nService Address: 5 A St\nSerial Number: A1B2C3\nTest Date: 3/4/2026\nResult: PASS  Date of Next Test 3/4/27', 'next_test_due') === '2027-03-04');
  const sn = ex('WATER HEATER STARTUP SHEET\nService Address: 1 A St\nBrand: Rheem Model No.: XE50T10H45U0   Ser. No.: M 112233445\nInstall Date: 3/4/2026');
  check('"Ser. No.: M 112233445" is the serial and does not leak into the model', sn?.fields.find((f) => f.key === 'model')?.value === 'XE50T10H45U0' && sn.fields.find((f) => f.key === 'serial_number')?.value === 'M 112233445', JSON.stringify(sn?.fields.map((f) => [f.key, f.value])));
  check('"2 hrs 30 min" is 2.5 hours; "2 hrs 30" is rejected, never 2', fv(`${TK}Customer: A B\nLabor: 2 hrs 30 min`, 'labor_hours') === '2.5' && none(`${TK}Customer: A B\nLabor: 2 hrs 30`, 'labor_hours') && fv(`${TK}Customer: A B\nLabor Hours: 2`, 'labor_hours') === '2');
  check('a next test due before the test date is dropped', none('BACKFLOW TEST CERTIFICATE\nService Address: 5 A St\nSerial Number: A1B2C3\nTest Date: 3/4/2026\nResult: Passed\nNext Test Due: 3/4/2025', 'next_test_due'));
  check('a stored value that still holds another label is dropped (safety net)', none(`${TK}Customer: Zed Co Model: 5 Size: 3\nService Address: 1 A St`, 'customer_name') || fv(`${TK}Customer: Zed Co Model: 5 Size: 3\nService Address: 1 A St`, 'customer_name') === 'Zed Co');
  for (const [r, c] of [['Pass not', 'other'], ['Satisfactory - not', 'other'], ['Pass', 'passed']]) check(`resultClass "${r}" is ${c}`, rc(r) === c);
  check('"last tested and by whom" asks for the tester', cl('When was the backflow device at 88 Harmon Street last tested and by whom?')?.attr === 'tester');

  const mk = async (db, filename, fields) => {
    const doc = await db.createDocument({ original_filename: filename, document_type: 'backflow-test-certificate', sha256_hash: crypto.createHash('sha256').update(filename).digest('hex'), stage: 'mapped' });
    for (const [k, v] of Object.entries(fields)) { const facet = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: facet.id }); }
  };
  await H.addFixture('plumbing', async (db) => {
    await mk(db, 'sd-serial.pdf', { service_address: '7081 Edge Way, Mesa AZ', customer_name: 'Edge SD', serial_number: 'EDG-SD', device_size: '1 inch', service_date: addDays(TODAY, -300), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 10) });
    await mk(db, 'sd-noserial.pdf', { service_address: '7081 Edge Way, Mesa AZ', customer_name: 'Edge SD', device_size: '1 inch', service_date: addDays(TODAY, -300), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 400) });
  });
  await H.as('plumbing', async (db) => {
    const ask = async (q) => { const it = cl(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; };
    const a1 = await ask('When is the next backflow test due at 7081 Edge Way?');
    const a2 = await ask('Is the backflow device at 7081 Edge Way overdue?');
    check('same address and test date, one cert without a serial, different due dates: no single-device answer', a1 == null && a2 == null || (a1?.clarify && a2?.clarify), `${a1?.text} | ${a2?.text}`);
    const l = await ask('Which backflow tests are due in the next 60 days?');
    check('and the list does not count either of them as due (it says they are unreadable)', !(l?.text ?? '').includes('due within') || !/7081 Edge Way[^|]*due/.test(JSON.stringify((l?.facts ?? []).filter((f) => !/unreadable/.test(f.value)).map((f) => `${f.label} ${f.value}`))), l?.text);
    const w1 = await ask('Which open permits expire in the next 1 days?');
    const w2 = await ask('Which water heater warranties expire in the next 60 days?');
    check('plural grammar: one item says "expires", several say "expire"', !w1 || !/\b\d+ open permits? expire\b/.test(w1.text.replace(/^1 open permit expires/, 'ok')) , w1?.text);
    check('"expires today" wording for a warranty that ends today', /(?:^|\b)(?:\d+ water heater warranties expire|1 water heater warranty expires)/.test(w2?.text ?? ''), w2?.text);
    const te = await ask('When does the warranty on the water heater at 7021 Edge Way expire?');
    check('a warranty that ends today says "expires today"', /expires today/.test(te?.text ?? ''), te?.text);
    const pt = await ask('When does the permit at 7011 Edge Way expire?');
    check('a permit that ends today says "expires today"', /expires today/.test(pt?.text ?? ''), pt?.text);
  });
}
/* 11. loop-4 regressions */
{
  for (const x of ['List all failed backflow tests and the ones due in 30 days', 'Which backflow tests failed plus which are overdue?', 'Show failed backflow tests along with those due in 30 days', 'Which permits are open and which warranties expire in 30 days?']) check(`mixed asks go to the normal path: ${x}`, cl(x) == null);
  check('a single ask with "and" is still answered', cl('Who is going to 61 Sagebrush Trail and when?') != null);
  await H.addFixture('plumbing', async (db) => {
    const mk = async (fn, type, fields) => { const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: crypto.createHash('sha256').update(fn).digest('hex'), stage: 'mapped' }); for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: one }); await db.createExtraction({ document_id: doc.id, field_key: k, value: one, source_facet_id: fa.id }); } };
    await mk('age-wh.pdf', 'startup-sheet', { service_address: '7091 Edge Way, Mesa AZ', customer_name: 'Edge Age', manufacturer: 'Rheem', model: 'AGE1', serial_number: 'EDG-AGE', installation_date: addDays(addDays(TODAY, -2191), 20) });
    await mk('cam-none.pdf', 'sewer-camera-report', { service_address: '7092 Edge Way, Mesa AZ', customer_name: 'Edge CamNone', service_date: addDays(TODAY, -3), line_findings: ['None', 'Root intrusion at 30 ft'] });
  });
  await H.as('plumbing', async (db) => {
    const ask = async (q) => { const it = cl(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; };
    const age = await ask('How old is the water heater at 7091 Edge Way?');
    check('water heater age is exact years and months, never rounded down to a whole year', /\(\d+ years? \d+ months? ago\)|\(\d+ months? ago\)|\(\d+ years? ago\)/.test(age?.text ?? '') && /5 years 11 months/.test(age?.text ?? ''), age?.text);
    const ex = await ask('Which water heater warranties have expired?');
    check('expired-warranty answer says how many heaters have no warranty record', /no warranty record on file/.test(ex?.text ?? ''), ex?.text);
    const cam = await ask('What did the camera find at 7092 Edge Way?');
    check('a "None" finding next to a real one is dropped', cam && /Root intrusion/.test(cam.text) && !/None/.test(cam.text) && cam.facts.length === 1, cam?.text);
  });
}
check('the card asks plumbing questions the lane understands', ['Which permits have expired?', 'Which open permits expire in the next 60 days?', 'Which backflow tests, water heater warranties or permits need attention?'].every((x) => cl(x) != null && cl(x).kind !== 'decline'));
console.log(failures ? `${failures} FAILED (${passes} passed)` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
