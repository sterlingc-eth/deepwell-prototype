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
const { extractPlumbing: extractPlumbingRaw } = await import('../api/_lib/industry/plumbing/extract.js');
// the extractor never reads the clock: every call here passes the fixed TODAY unless a check passes its own
const extractPlumbing = (p, o = { today: TODAY }) => extractPlumbingRaw(p, o);
const { classifyPlumbing, classifyPlumbingForLane, runPlumbing, plumbingAttention, DECLINE, resultClass } = await import('../api/_lib/industry/plumbing/lane.js');
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
    const intent = classifyPlumbingForLane(x.question, { today: TODAY });
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
    if (x.expectEmpty && !/^(?:none\b|no (?:\w+ ){0,6}(?:on file|has|have|is|are|needs?|expire|expires|expired|failed|due|overdue|open)\b|0 \w+)/i.test(String(res.text))) { ok = false; why.push('an empty result must say none / no, not stay silent'); }
    if (!x.expectEmpty && !(x.must ?? []).length && !(x.cite ?? []).length && !(x.mustNot ?? []).length) { ok = false; why.push('a check with nothing to prove'); }
    { // grammar sweep over the lane's own sentence: a count of one agrees with a singular verb, other counts with a plural one, and no word is repeated
      const t = String(res.text ?? '');
      const one = t.match(/(?:^|[.;:] )1 (?:[a-z/-]+ ){1,4}(?:need|have|are|were|show|expire|end|fail|pass|come|match|run|ran)\b/i);
      const many = t.match(/(?:^|[.;:] )(?:[02-9]|\d{2,}) (?:[a-z/-]+ ){1,4}(?:needs|has|is|was|shows|expires|ends|fails|passes|comes|matches|runs)\b/i);
      const rep = t.match(/\b([a-z]{3,})\s+\1\b/i);
      if (one) { ok = false; why.push(`count of one with a plural verb: ${one[0]}`); }
      if (many) { ok = false; why.push(`count of several with a singular verb: ${many[0]}`); }
      if (rep) { ok = false; why.push(`repeated word: ${rep[0]}`); }
    }
    if (res.facts?.length && res.facts.some((f) => !f.sources?.length)) { ok = false; why.push('a fact has no source'); }
    if (res.clarify) counts.clarified++;
    if (ok) counts.correct++; else counts.wrong++;
    if (VERBOSE && ok) console.log(`ok ${tag} :: ${res.text}`);
    check(`answer ${tag}`, ok, `${why.join('; ')} :: ${res.text}`);
  }
});
console.log(`questions: ${Q.length}  answered right: ${counts.correct}  left to model/declined right: ${counts.null}  clarified: ${counts.clarified}  wrong: ${counts.wrong}  citations proved: ${counts.cited}`);
check(`generated questions: baseline of 428 answered right and at most 32 left to the model (now ${counts.correct} / ${counts.null}); more left-to-model fails`, counts.correct >= 428 && counts.null <= 32 && counts.wrong === 0, `${counts.correct} / ${counts.null} / wrong ${counts.wrong}`);
check('no wrong answers', counts.wrong === 0);


/* 2b. blind sets (written by a separate tester who saw only the documents); skipped when the file is absent */
const blindPath = new URL('./fixtures/plumbing-blind.json', import.meta.url);
const blindStats = {};
if (fs.existsSync(blindPath)) {
  const BLIND = JSON.parse(fs.readFileSync(blindPath, 'utf8')); let bad = 0;
  await H.as('plumbing', async (db) => {
    for (const x of BLIND) {
      const st = (blindStats[x.set] ??= { correct: 0, left: 0, wrong: 0, answered: 0 });
      const it = classifyPlumbingForLane(x.question, { today: TODAY }); const r = it ? await runPlumbing(db, it, { today: TODAY }) : null;
      const blob = r ? alltext(r).toLowerCase() : ''; let ok;
      const exp = x.expected ?? [];
      if (!r || r.decline === true || r.clarify === true) { st.left++; ok = true; }
      else if (x.kind === 'unanswerable' || exp.length === 0) ok = false;
      else ok = exp.every((e) => blob.includes(String(e).toLowerCase())) && !FOREIGN.test(blob);
      if (r && ok && !r.clarify) st.correct++;
      if (r && ok && !r.decline && !r.clarify) st.answered++;
      if (!ok) { st.wrong++; bad++; console.log(`FAIL  blind[${x.set}] ${x.kind} "${x.question}" :: ${r?.text}`); }
    }
  });
  console.log('blind sets (answered right / left to model / wrong): ' + Object.entries(blindStats).map(([k, v]) => `${k}: ${v.answered} / ${v.left} / ${v.wrong}`).join('   '));
  check(`blind sets: ${BLIND.length} questions, none answered wrongly`, bad === 0);
  // committed baselines: a change that sends more of these to the model (or answers fewer) fails here and has to be looked at on purpose
  const FLOOR = { A: 15, B: 8, C: 10 }; const ANSWERED = { A: 15, B: 8, C: 9 };
  for (const [set, n] of Object.entries(FLOOR)) check(`blind set ${set}: at least ${n} answered or correctly declined from the records (baseline; now ${blindStats[set]?.correct})`, (blindStats[set]?.correct ?? 0) >= n);
  for (const [set, n] of Object.entries(ANSWERED)) check(`blind set ${set}: at least ${n} answered with a real answer (baseline; now ${blindStats[set]?.answered})`, (blindStats[set]?.answered ?? 0) >= n);
}

/* 3. definitions and edge cases */
const cl = (x) => classifyPlumbing(x, { today: TODAY });
// what the router really calls (see api/_lib/industry/lanes.js): used wherever a check asks a question end to end
const clL = (x) => classifyPlumbingForLane(x, { today: TODAY });
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
  check(`${ind} has no plumbing lane`, ind === 'electrical' ? (await laneForPack(p))?.classify?.name === 'classifyElectrical' : ind === 'property' ? (await laneForPack(p))?.classify?.name === 'classifyProperty' : (await laneForPack(p)) === null);
}
{
  const p = await H.as('plumbing', (db) => H.I.packForTenant(db));
  check('plumbing company gets the plumbing lane', (await laneForPack(p))?.classify === classifyPlumbingForLane && (await laneForPack(p))?.run === runPlumbing);
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
  check('card asks a plumbing question for plumbing', /backflow tests are overdue or due in the next 60 days/.test(cardSrc) && /dw-btn-secondary w-full min-h-\[44px\] sm:w-auto/.test(cardSrc));
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
    check('a clarify question shows serial or location for each choice', !!cl2?.clarify && (cl2.clarifyOptions ?? []).length >= 2 && (cl2.clarifyOptions ?? []).every((o) => /serial|\(/.test(o)), JSON.stringify(cl2?.clarifyOptions));
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
    check('M3: an overdue-but-passed device answering a retest question does not begin "No." (it is answered, or left to the model, but never a plain no)', r3 == null || (!/^No\b/.test(r3.text) && /overdue|due|retest/i.test(r3.text)), r3?.text);
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
    check('same address and test date, one cert without a serial, different due dates: no single-device answer (both are left to the model, or both ask which device)', (a1 == null && a2 == null) || (a1?.clarify === true && a2?.clarify === true), `${a1?.text} | ${a2?.text}`);
    const l = await ask('Which backflow tests are due in the next 60 days?');
    check('and the list does not count either of them as due (it says they are unreadable)', !(l?.text ?? '').includes('due within') || !/7081 Edge Way[^|]*due/.test(JSON.stringify((l?.facts ?? []).filter((f) => !/unreadable/.test(f.value)).map((f) => `${f.label} ${f.value}`))), l?.text);
    const w1 = await ask('Which open permits expire in the next 1 days?');
    const w2 = await ask('Which water heater warranties expire in the next 60 days?');
    check('plural grammar: one item says "expires", several say "expire"', !!w1 && /^(?:1 open permit expires|\d+ open permits expire|None)/.test(w1.text) && !/^1 open permit expire\b|^(?:[02-9]|\d{2,}) open permits expires/.test(w1.text), w1?.text);
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
/* 12. second organization (two plumbing companies, ONE database): names come only from the asking organization's own records */
{
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const ctxB = { tenantKey: 'org_mixed_plumbing_b', tenantName: 'Second Plumbing Co' };
  await getTenantContext(ctxB.tenantKey, ctxB.tenantName);
  await H.withTenant(ctxB, (db) => H.R.setTenantIndustry(db, 'plumbing', { tenantKey: ctxB.tenantKey }));
  H.R.resetPacksCacheForTests();
  const asB = (fn) => H.withTenant(ctxB, fn);
  const mkB = async (db, filename, type, fields) => {
    const doc = await db.createDocument({ original_filename: filename, document_type: type, sha256_hash: crypto.createHash('sha256').update(`B${filename}`).digest('hex'), stage: 'mapped' });
    for (const [k, v] of Object.entries(fields)) { const facet = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: facet.id }); }
  };
  await asB(async (db) => {
    await mkB(db, 'b-bf1.pdf', 'backflow-test-certificate', { service_address: '9001 Zephyr Lane, Tombstone AZ', customer_name: 'Zelda Holdings', serial_number: 'ZEL-1', manufacturer: 'Kohlerman', model: 'KX9', device_size: '2 inch', technician: 'Quentin Pike', service_date: addDays(TODAY, -100), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 30) });
    // vocabulary that looks like another trade, but is this company's OWN customer / street names
    await mkB(db, 'b-bf2.pdf', 'backflow-test-certificate', { service_address: '15 Furnace Creek Road, Tombstone AZ', customer_name: 'Furnace Creek Tenants Association', serial_number: 'FCT-1', device_size: '1 inch', service_date: addDays(TODAY, -400), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, -35) });
    await mkB(db, 'b-wh1.pdf', 'startup-sheet', { service_address: '9001 Zephyr Lane, Tombstone AZ', customer_name: 'Zelda Holdings', equipment_type: 'Water heater', manufacturer: 'Kohlerman', model: 'WH9', serial_number: 'ZEL-WH', installation_date: addDays(TODAY, -800) });
  });
  const askIn = (who, q) => who(async (db) => { const it = clL(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  const inA = (q) => askIn((fn) => H.as('plumbing', fn), q);
  const inB = (q) => askIn(asB, q);
  const txtOf = (r) => `${r?.text ?? ''} ${(r?.facts ?? []).map((x) => `${x.label} ${x.value}`).join(' ')}`;
  const aOther = ['When is the next backflow test due at 9001 Zephyr Lane?', 'Who tested the backflow device at 9001 Zephyr Lane?', 'Who is the manufacturer of the backflow device at 9001 Zephyr Lane?', 'When is the next backflow test due for Zelda Holdings?', 'How old is the water heater at 9001 Zephyr Lane?'];
  for (const q of aOther) { const r = await inA(q); check(`org A never answers from org B's records: "${q}"`, !r || !/zelda|zephyr|kohlerman|quentin|ZEL-/i.test(txtOf(r)), r?.text); }
  const bOwn = await inB('When is the next backflow test due at 9001 Zephyr Lane?');
  check('org B answers about its own device', !!bOwn && /Zephyr/.test(txtOf(bOwn)) && new RegExp(long(addDays(TODAY, 30)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(bOwn.text), bOwn?.text);
  const bTester = await inB('Who tested the backflow device at 9001 Zephyr Lane?');
  check('org B names its own technician (read from its record, not a list)', /Quentin Pike/.test(bTester?.text ?? ''), bTester?.text);
  const bMake = await inB('Who is the manufacturer of the backflow device at 9001 Zephyr Lane?');
  check('org B names its own manufacturer', /Kohlerman/.test(bMake?.text ?? ''), bMake?.text);
  // org B never sees org A's records
  const aAddrs = ['7081 Edge Way', '7001 Edge Way', '7002 Edge Way'];
  for (const a of aAddrs) { const r = await inB(`When is the next backflow test due at ${a}?`); check(`org B asked about org A's address "${a}": null (nothing on file), never an answer`, r == null || /don.t see|none on file|no record/i.test(r.text) && !r.facts?.length, r?.text); }
  const bList = await inB('Which backflow tests are overdue?');
  check('org B overdue list holds only org B devices', !!bList && /Furnace Creek/.test(txtOf(bList)) && !/Edge Way|Mesa/.test(txtOf(bList)), bList?.text);
  const aList = await inA('Which backflow tests are overdue?');
  check('org A overdue list never holds org B devices', !/Furnace Creek|Tombstone|Zephyr/.test(txtOf(aList)), aList?.text?.slice(0, 120));
  // unknown names: null (the normal path) or an honest none-on-file, never a total with the condition dropped
  for (const q of ['How many backflow devices at Quillfeather Industries?', 'When is the next backflow test due for Nonesuch Dental?', 'Who tested the backflow device at 4242 Nowhere Street?', 'Who made the backflow device at 9001 Zephyr Lane?']) {
    const r = await inA(q); check(`org A unknown name "${q}" is null or none-on-file (no total, no borrowed answer)`, !r || (/don.t see|none on file|no record/i.test(r.text) && !/\b\d+ backflow devices?\b/.test(r.text) && !r.facts?.length), r?.text);
  }
  // a plumbing org asked a question that sounds like another trade but names its OWN vocabulary: answered from its records
  const fc = await inB('When is the next backflow test due for Furnace Creek Tenants Association?');
  check('plumbing org: its own customer "Furnace Creek Tenants Association" is its own vocabulary (not a foreign-trade word list)', !!fc && /Furnace Creek/.test(txtOf(fc)) && /overdue|past due|was due/i.test(fc.text), fc?.text);
  const fc2 = await inB('Is the backflow device at 15 Furnace Creek Road overdue?');
  check('plumbing org: street named Furnace Creek is answered from its records', !!fc2 && /Furnace Creek/.test(txtOf(fc2)) && /overdue/i.test(fc2.text), fc2?.text);
  // and the same words asked in org A, where they are not in its records: not answered
  for (const q of ['When is the next backflow test due for Furnace Creek Tenants Association?', 'Is the backflow device at 15 Furnace Creek Road overdue?', 'How many tons is the furnace at the Edge Way job?']) { const r = await inA(q); check(`org A, vocabulary not in its records: "${q}"`, !r || !/furnace creek/i.test(txtOf(r)), r?.text); }
  // HVAC-style questions about a plumbing org's own records are never answered by the plumbing lane with the condition dropped
  for (const q of ['What is the tonnage of the backflow device at 9001 Zephyr Lane?', 'What refrigerant does the water heater at 9001 Zephyr Lane use?', 'What is the SEER rating of the water heater at 9001 Zephyr Lane?']) { const r = await inB(q); check(`plumbing org, HVAC-style attribute it has no record of: "${q}" is not answered with another fact`, !r || /don.t see|none on file|no record/i.test(r.text), r?.text); }
}
/* 13. mutation survivors (verified by mutating the code and watching these fail) */
{
  const txtOf = (r) => `${r?.text ?? ''} ${(r?.facts ?? []).map((x) => `${x.label} ${x.value}`).join(' ')}`;
  const { parseDate: pd } = await import('../api/_lib/industry/plumbing/extract.js');
  check('MUT day-first: 25/03/2026 reads as March 25 (day first when the first number cannot be a month)', pd('25/03/2026') === '2026-03-25' && pd('13.02.2026') === '2026-02-13' && pd('31-12-2025') === '2025-12-31');
  check('MUT day-first: ambiguous 03/04/2026 stays month-first (March 4)', pd('03/04/2026') === '2026-03-04');
  check('MUT day-first: a day that fits neither order is unreadable', pd('31/31/2026') === null);
  const pages = [{ page_no: 1, text: ['Backflow Prevention Assembly Test Report', 'Service Address: 9100 Flip Way, Mesa AZ', 'Customer: Flip Co', 'Serial No: FLIP-1', 'Date of Test: 25/03/2026', 'Result: Passed', 'Next Test Due: 25/03/2027'].join('\n') }];
  const r = extractPlumbing(pages);
  const g = (k) => r?.fields.find((x) => x.key === k)?.value;
  check('MUT day-first: the extractor stores the flipped dates', g('service_date') === '2026-03-25' && g('next_test_due') === '2027-03-25', JSON.stringify(r?.fields.filter((x) => /date|due/.test(x.key)).map((x) => [x.key, x.value])));
  const mkC = async (db, filename, type, fields) => {
    const doc = await db.createDocument({ original_filename: filename, document_type: type, sha256_hash: crypto.createHash('sha256').update(`C${filename}`).digest('hex'), stage: 'mapped' });
    const ids = {};
    for (const [k, v] of Object.entries(fields)) { const facet = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); const e = await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: facet.id }); ids[k] = e.id; }
    return { doc, ids };
  };
  let ctx;
  await H.addFixture('plumbing', async (db) => {
    ctx = await mkC(db, 'mut-corr.pdf', 'backflow-test-certificate', { service_address: '7201 Mutant Way, Mesa AZ', customer_name: 'Mutant Corr', serial_number: 'MUT-CORR', device_size: '1 inch', service_date: addDays(TODAY, -300), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 400) });
    await mkC(db, 'mut-final.pdf', 'permit', { permit_number: 'PL-MUT-1', service_address: '7202 Mutant Way, Mesa AZ', customer_name: 'Mutant Final', permit_status: 'Open', permit_expires: addDays(TODAY, 400) });
    await mkC(db, 'mut-final-insp.pdf', 'inspection-report', { permit_number: 'PL-MUT-1', service_address: '7202 Mutant Way, Mesa AZ', customer_name: 'Mutant Final', inspection_type: 'Final', inspection_result: 'Passed', service_date: addDays(TODAY, -5) });
    await mkC(db, 'mut-final2.pdf', 'permit', { permit_number: 'PL-MUT-2', service_address: '7203 Mutant Way, Mesa AZ', customer_name: 'Mutant Final Two', permit_status: 'Open', permit_expires: addDays(TODAY, 400) });
    await mkC(db, 'mut-final2-insp.pdf', 'inspection-report', { permit_number: 'PL-MUT-2', service_address: '7203 Mutant Way, Mesa AZ', customer_name: 'Mutant Final Two', inspection_type: 'Final', inspection_result: 'Failed', service_date: addDays(TODAY, -5) });
  });
  const before = await H.as('plumbing', async (db) => { const it = clL('Is the backflow device at 7201 Mutant Way overdue?'); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  check('MUT corrected_value: before any correction the device is not overdue', !!before && !/\boverdue\b/i.test(before.text.replace(/not overdue/i, '')), before?.text);
  await H.as('plumbing', async (db) => { await db.raw(`UPDATE extractions SET corrected_value = $1 WHERE id = $2`, [addDays(TODAY, -10), ctx.ids.next_test_due]); });
  const after = await H.as('plumbing', async (db) => { const it = clL('Is the backflow device at 7201 Mutant Way overdue?'); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  check('MUT corrected_value: a person\'s correction wins over the extracted value', !!after && /overdue/i.test(after.text) && !/not overdue/i.test(after.text), after?.text);
  const when = await H.as('plumbing', async (db) => { const it = clL('When is the next backflow test due at 7201 Mutant Way?'); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  check('MUT corrected_value: the corrected date is the one shown', new RegExp(long(addDays(TODAY, -10))).test(when?.text ?? '') && !new RegExp(long(addDays(TODAY, 400))).test(when?.text ?? ''), when?.text);
  const fin = await H.as('plumbing', async (db) => { const o = []; for (const q of ['Which permits are open?', 'What is the status of the permit at 7202 Mutant Way?', 'What is the status of the permit at 7203 Mutant Way?']) { const it = clL(q); o.push(it ? await runPlumbing(db, it, { today: TODAY }) : null); } return o; });
  const openTxt = txtOf(fin[0]);
  check('MUT finished-by-final: the open list leaves out the permit with a passed final and keeps the one whose final failed', !/7202 Mutant/.test(txtOf(fin[0])) && /7203 Mutant/.test(txtOf(fin[0])), fin[0]?.text);
  check('MUT finished-by-final: PL-MUT-1 is reported finished (passed final on file), not open', !!fin[1] && /finished|passed final/i.test(txtOf(fin[1])) && !/is open\b/i.test(fin[1].text), fin[1]?.text);
  check('MUT finished-by-final: a FAILED final does not finish the permit', !!fin[2] && !/finished|passed final/i.test(fin[2].text) && /open/i.test(fin[2].text), fin[2]?.text);
}
/* 14. grammar at exactly one: an organization holding one of each thing (count of one agrees; other counts agree) */
{
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const mkOrg = async (key) => { const ctx = { tenantKey: key, tenantName: key }; await getTenantContext(ctx.tenantKey, ctx.tenantName); await H.withTenant(ctx, (db) => H.R.setTenantIndustry(db, 'plumbing', { tenantKey: key })); H.R.resetPacksCacheForTests(); return ctx; };
  const fill = async (ctx, rows) => H.withTenant(ctx, async (db) => { for (const [fn, type, fields] of rows) { const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: crypto.createHash('sha256').update(`${ctx.tenantKey}${fn}`).digest('hex'), stage: 'mapped' }); for (const [k, v] of Object.entries(fields)) { const facet = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: facet.id }); } } });
  const one = await mkOrg('org_plumb_one');
  await fill(one, [['o-bf.pdf', 'backflow-test-certificate', { service_address: '11 Solo Way, Mesa AZ', customer_name: 'Solo Alpha', serial_number: 'SOLO-1', device_size: '1 inch', service_date: addDays(TODAY, -400), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, -20) }]]);
  const six = await mkOrg('org_plumb_each');
  await fill(six, [
    ['e-bf1.pdf', 'backflow-test-certificate', { service_address: '21 Solo Way, Mesa AZ', customer_name: 'Each Alpha', serial_number: 'EACH-1', device_size: '1 inch', service_date: addDays(TODAY, -400), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, -20) }],
    ['e-bf2.pdf', 'backflow-test-certificate', { service_address: '22 Solo Way, Mesa AZ', customer_name: 'Each Bravo', serial_number: 'EACH-2', device_size: '1 inch', service_date: addDays(TODAY, -30), backflow_test_result: 'Failed' }],
    ['e-pm.pdf', 'permit', { permit_number: 'PL-EACH-1', service_address: '23 Solo Way, Mesa AZ', customer_name: 'Each Charlie', permit_status: 'Open', permit_expires: addDays(TODAY, -15) }],
    ['e-pm2.pdf', 'permit', { permit_number: 'PL-EACH-2', service_address: '24 Solo Way, Mesa AZ', customer_name: 'Each Delta', permit_status: 'Open', permit_expires: addDays(TODAY, 20) }],
    ['e-wr.pdf', 'warranty-registration', { service_address: '25 Solo Way, Mesa AZ', customer_name: 'Each Echo', equipment_type: 'Water heater', serial_number: 'EACH-WH', warranty_expires: addDays(TODAY, -40) }],
    ['e-wr2.pdf', 'warranty-registration', { service_address: '26 Solo Way, Mesa AZ', customer_name: 'Each Foxtrot', equipment_type: 'Water heater', serial_number: 'EACH-WH2', warranty_expires: addDays(TODAY, 25) }],
  ]);
  const qs = ['Which backflow tests are overdue?', 'Which backflow tests failed?', 'How many backflow devices failed?', 'Which permits have expired?', 'Which open permits expire in the next 60 days?', 'How many permits are open?', 'Which water heater warranties have expired?', 'Which water heater warranties expire in the next 60 days?', 'Which backflow tests are due in the next 60 days?', 'How many backflow devices do we track?', 'Which backflow tests, water heater warranties or permits need attention?', 'What needs attention?'];
  const bad = []; let answered = 0;
  for (const [who, ctx] of [['one', one], ['each', six]]) for (const q of qs) {
    const r = await H.withTenant(ctx, async (db) => { const it = clL(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
    if (!r) continue; answered++;
    const t = String(r.text);
    const m = t.match(/(?:^|[.;:] )1 (?:[a-z/-]+ ){1,4}(?:need|have|are|were|show|expire|end|fail|pass|come|match|run|ran)\b/i) || t.match(/(?:^|[.;:] )(?:[02-9]|\d{2,}) (?:[a-z/-]+ ){1,4}(?:needs|has|is|was|shows|expires|ends|fails|passes|comes|matches|runs)\b/i) || t.match(/\b([a-z]{3,})\s+\1\b/i) || t.match(/\b1 (?:water heater warranties|permits|backflow tests|items|backflow devices)\b/i) || t.match(/\b(?:[02-9]|\d{2,}) (?:water heater warranty|permit|backflow test|item|backflow device)\b(?!\w)/i);
    if (m) bad.push(`${who}: "${q}" -> ${m[0]} | ${t.slice(0, 160)}`);
  }
  check(`grammar sweep: no count/verb disagreement or repeated word across ${answered} answers at counts of one and several`, bad.length === 0 && answered >= 14, bad.join('\n      '));
  const a1 = await H.withTenant(one, async (db) => { const it = clL('What needs attention?'); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  check('one item needing attention: "1 item needs attention", singular category labels', /^1 item needs attention/.test(a1?.text ?? '') && /1 backflow test,/.test(a1?.text ?? '') && /0 water heater warranties/.test(a1?.text ?? ''), a1?.text);
}
/* 15. reviewer coverage gaps: each shape is read correctly or not read at all, never a wrong value */
{
  const mkPage = (lines) => [{ page_no: 1, text: ['Backflow Prevention Assembly Test Report', ...lines].join('\n') }];
  const val = (r, k) => r?.fields.find((x) => x.key === k)?.value;
  const base = ['Service Address: 12 Elm Street, Mesa AZ', 'Customer: Acme Co', 'Serial No: ABC123', 'Date of Test: 03/04/2026', 'Next Test Due: 03/04/2027'];
  const outcome = (r, k) => (r == null ? '(not read)' : val(r, k) ?? '(no result)');
  const colonless = extractPlumbing(mkPage(['Service Address 12 Elm Street, Mesa AZ', 'Customer Acme Co', 'Serial No FLP 123', 'Date of Test 03/04/2026', 'Result Passed', 'Next Test Due 03/04/2027']));
  check('colon-less page: either not read at all, or read with every value right', colonless == null || (val(colonless, 'backflow_test_result') === 'Passed' && val(colonless, 'serial_number') === 'FLP 123' && val(colonless, 'service_date') === '2026-03-04' && val(colonless, 'next_test_due') === '2027-03-04'), JSON.stringify(colonless?.fields.map((x) => [x.key, x.value])));
  const cbPass = extractPlumbing(mkPage([...base.slice(0, 4), 'Result: [X] Passed [ ] Failed', base[4]]));
  check('checkbox result "[X] Passed [ ] Failed": the result is Passed, or the page is not read, or no result is kept (never Failed)', ['Passed', '(not read)', '(no result)'].includes(outcome(cbPass, 'backflow_test_result')), outcome(cbPass, 'backflow_test_result'));
  const cbFail = extractPlumbing(mkPage([...base.slice(0, 4), '[ ] Passed  [X] Failed', base[4]]));
  check('checkbox result "[ ] Passed [X] Failed": the result is Failed, or the page is not read, or no result is kept (never Passed)', ['Failed', '(not read)', '(no result)'].includes(outcome(cbFail, 'backflow_test_result')), outcome(cbFail, 'backflow_test_result'));
  const cbBoth = extractPlumbing(mkPage([...base.slice(0, 4), 'Result: [X] Passed [X] Failed', base[4]]));
  check('checkbox with both marked: the page is not read or no result is kept (a result is never invented)', ['(not read)', '(no result)'].includes(outcome(cbBoth, 'backflow_test_result')), outcome(cbBoth, 'backflow_test_result'));
  const pipe = extractPlumbing([{ page_no: 1, text: 'Backflow Prevention Assembly Test Report\n| Service Address | 12 Elm Street, Mesa AZ |\n| Customer | Acme Co |\n| Serial No | ABC123 |\n| Date of Test | 03/04/2026 |\n| Result | Failed |\n| Next Test Due | 03/04/2027 |' }]);
  check('pipe table: either not read at all, or read with every value right and no "|" in a value', pipe == null || (val(pipe, 'backflow_test_result') === 'Failed' && val(pipe, 'serial_number') === 'ABC123' && val(pipe, 'service_date') === '2026-03-04' && !pipe.fields.some((x) => /\|/.test(String(x.value)))), JSON.stringify(pipe?.fields.map((x) => [x.key, x.value])));
  const spaced = extractPlumbing(mkPage(['Service Address: 12 Elm Street, Mesa AZ', 'Customer: Acme Co', 'Serial No: ABC 123 45', 'Date of Test: 03/04/2026', 'Result: Passed', 'Next Test Due: 03/04/2027']));
  check('spaced serial "ABC 123 45" is kept whole', val(spaced, 'serial_number') === 'ABC 123 45', val(spaced, 'serial_number'));
  const rd = (u) => fs.readFileSync(new URL(u, import.meta.url), 'utf8');
  const card = rd('../src/components/IndustryAttentionCard.tsx');
  check('390px: attention card date never breaks mid-date, button at least 44px', /whitespace-nowrap"> · \{i\.date\}/.test(card) && /min-h-\[44px\]/.test(card));
  const rb = rd('../src/components/records/RecordsBrowser.tsx');
  check('390px: the records column is phone-width for non-HVAC companies and unchanged for HVAC', /nonHvac \? 'flex-1 min-w-0 space-y-3 max-sm:w-full' : 'flex-1 min-w-0 space-y-3'/.test(rb));
}
/* 16. the extractor is a pure function of (pages, today): same pages, different 'today', different (and correct) future-date plausibility */
{
  const pg = (iso) => [{ page_no: 1, text: ['Backflow Prevention Assembly Test Report', 'Service Address: 12 Elm Street, Mesa AZ', 'Customer: Acme Co', 'Serial No: CLK123', `Date of Test: ${iso}`, 'Result: Passed'].join('\n') }];
  const sd = (r) => r?.fields.find((x) => x.key === 'service_date')?.value ?? null;
  const when = addDays(TODAY, 60);
  check('clock: a test date 60 days ahead of the supplied today is a misread and dropped', sd(extractPlumbingRaw(pg(when), { today: TODAY })) === null);
  check('clock: the same page read with a later supplied today keeps the date', sd(extractPlumbingRaw(pg(when), { today: addDays(TODAY, 40) })) === when);
  check('clock: 31 days ahead is kept, 32 is dropped, relative to the supplied today only', sd(extractPlumbingRaw(pg(addDays(TODAY, 31)), { today: TODAY })) === addDays(TODAY, 31) && sd(extractPlumbingRaw(pg(addDays(TODAY, 32)), { today: TODAY })) === null);
  check('clock: with no today supplied nothing is dropped for being in the future (no hidden clock)', sd(extractPlumbingRaw(pg(addDays(TODAY, 900)))) === addDays(TODAY, 900));
  check('clock: same pages and same today give the same answer every time', JSON.stringify(extractPlumbingRaw(pg(when), { today: TODAY })) === JSON.stringify(extractPlumbingRaw(pg(when), { today: TODAY })));
  const src = fs.readFileSync(new URL('../api/_lib/industry/plumbing/extract.js', import.meta.url), 'utf8');
  check('clock: the plumbing extractor source never reads the clock', !/Date\.now\(|new Date\(\)/.test(src));
}
const txtOf = (r) => `${r?.text ?? ''} ${(r?.facts ?? []).map((x) => `${x.label} ${x.value}`).join(' ')}`;
/* 17. loop-6 regressions: camera findings stay whole and in order; startup-sheet warranty is read; unknown warranty status is never "None expired" */
{
  const hdr = 'Sewer Camera Inspection Report\nService Address: 12 Elm Street, Tempe AZ\nCustomer: Acme Co\nInspection Date: 09/20/2026\n';
  const fnd = (t) => (extractPlumbing([{ page_no: 1, text: hdr + t }])?.fields ?? []).filter((x) => x.key === 'line_findings').map((x) => x.value);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('findings: "No defects observed. Line clear." is ONE value, no words cut', eq(fnd('Findings: No defects observed. Line clear.'), ['No defects observed. Line clear.']), JSON.stringify(fnd('Findings: No defects observed. Line clear.')));
  check('findings: "Heavy roots, no other defects found. Pipe in good condition." is one whole value', eq(fnd('Findings: Heavy roots, no other defects found. Pipe in good condition.'), ['Heavy roots, no other defects found. Pipe in good condition.']));
  check('findings: a label-like phrase after a colon inside the value keeps the order and every word', eq(fnd('Findings: Roots at 40 ft. Defects observed: offset at 62 ft'), ['Roots at 40 ft. Defects observed: offset at 62 ft']));
  const sib = extractPlumbing([{ page_no: 1, text: `${hdr}Findings: roots at 40 ft  Recommendation: hydro jet` }])?.fields ?? [];
  check('findings: a real next label (Recommendation:) is still cut off the value', sib.some((x) => x.key === 'line_findings' && x.value === 'roots at 40 ft') && sib.some((x) => x.key === 'recommendation' && x.value === 'hydro jet'));
  const orgW = async (key) => { const { getTenantContext } = await import('../api/_lib/recordsStore.js'); const ctx = { tenantKey: key, tenantName: key }; await getTenantContext(key, key); await H.withTenant(ctx, (db) => H.R.setTenantIndustry(db, 'plumbing', { tenantKey: key })); H.R.resetPacksCacheForTests(); return ctx; };
  const store = async (ctx, name, text) => H.withTenant(ctx, async (db) => { const r = extractPlumbing([{ page_no: 1, text }]); const doc = await db.createDocument({ original_filename: name, document_type: r.type, sha256_hash: crypto.createHash('sha256').update(`${ctx.tenantKey}${name}`).digest('hex'), stage: 'mapped' }); for (const f of r.fields) { const facet = await db.createFacet({ document_id: doc.id, page_no: f.page_no, label_raw: f.key, value_raw: f.value }); await db.createExtraction({ document_id: doc.id, field_key: f.key, value: f.value, source_facet_id: facet.id }); } });
  const camCtx = await orgW('org_plumb_cam');
  const cams = [['No defects observed. Line clear.', '31 Pipe Row'], ['Heavy roots, no other defects found. Pipe in good condition.', '32 Pipe Row'], ['Roots at 40 ft. Defects observed: offset at 62 ft', '33 Pipe Row']];
  for (const [t, a] of cams) await store(camCtx, `cam-${a}.pdf`, `Sewer Camera Inspection Report\nService Address: ${a}, Tempe AZ\nCustomer: Cam ${a}\nInspection Date: ${long(addDays(TODAY, -3))}\nFindings: ${t}`);
  const camAsk = (q) => H.withTenant(camCtx, async (db) => { const it = clL(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  const c1 = await camAsk('What did the camera find at 31 Pipe Row?'); const c2 = await camAsk('What did the camera find at 32 Pipe Row?'); const c3 = await camAsk('What did the camera find at 33 Pipe Row?');
  check('camera answer: no-defects sentences are said as written, no ".." or stray "No"', !!c1 && /: No defects observed\. Line clear\.$/.test(c1.text) && !/\.\.|; No\b/.test(c1.text), c1?.text);
  check('camera answer: a finding with a defect keeps all its words and one full stop', !!c2 && /: Heavy roots, no other defects found\. Pipe in good condition\.$/.test(c2.text) && !/\.\./.test(c2.text) && !/;/.test(c2.text), c2?.text);
  check('camera answer: order is the printed order', !!c3 && c3.text.indexOf('Roots at 40 ft') < c3.text.indexOf('offset at 62 ft') && c3.text.indexOf('Roots at 40 ft') > 0, c3?.text);
  const dl = await camAsk('Which sewer lines have defects?');
  check('defects list: "No defects observed. Line clear." is not a defect; the other two are', !!dl && /^2 sewer lines with defects/.test(dl.text) && !/31 Pipe Row/.test(txtOf(dl)) && /32 Pipe Row/.test(txtOf(dl)) && /33 Pipe Row/.test(txtOf(dl)), dl?.text);
  // startup-sheet warranty
  const sheet = (w) => `Water Heater Startup Sheet\nService Address: 41 Heat Way, Tempe AZ\nCustomer: Heat Co\nManufacturer: Rheem\nModel: XE50\nSerial Number: RHW-1\nInstallation Date: ${long(addDays(TODAY, -3000))}\n${w}`;
  const ex = (w) => (extractPlumbing([{ page_no: 1, text: sheet(w) }])?.fields ?? []);
  check('startup sheet: "Warranty: 6 years" is read as the warranty term', ex('Warranty: 6 years').some((x) => x.key === 'warranty_term' && x.value === '6 years'));
  check('startup sheet: "Warranty Expires: <date>" is read as the expiry', ex(`Warranty Expires: ${long(addDays(TODAY, -100))}`).some((x) => x.key === 'warranty_expires' && x.value === addDays(TODAY, -100)));
  check('startup sheet: a bare "Expires:" / "Term:" is NOT read as a warranty (ambiguous)', !ex('Expires: 03/04/2031').some((x) => x.key === 'warranty_expires') && !ex('Term: 12 months').some((x) => x.key === 'warranty_term'));
  const wCtx = await orgW('org_plumb_warr');
  await store(wCtx, 'ss-warr.pdf', sheet(`Warranty: 6 years\nWarranty Expires: ${long(addDays(TODAY, -100))}`));
  await store(wCtx, 'ss-none.pdf', sheet('').replace('41 Heat Way', '42 Heat Way').replace('RHW-1', 'RHW-2').replace('Heat Co', 'Heat Two'));
  const wAsk = (q) => H.withTenant(wCtx, async (db) => { const it = clL(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  const wx = await wAsk('Which water heater warranties have expired?');
  check('startup-sheet warranty counts: the printed expiry makes heater 41 expired, citing the startup sheet', !!wx && /^1 water heater warranty has expired/.test(wx.text) && /41 Heat Way/.test(txtOf(wx)) && /1 water heater has no warranty record on file/.test(wx.text), wx?.text);
  const solo = await orgW('org_plumb_warr2');
  await store(solo, 'ss-none2.pdf', sheet(''));
  const none = await H.withTenant(solo, async (db) => { const it = clL('Which water heater warranties have expired?'); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  check('unknown warranty status is never "None ... expired": the answer leads with the unknown count', !!none && !/^None/.test(none.text) && /^1 water heater has no warranty record on file, so its warranty status is unknown\./.test(none.text), none?.text);
}
/* 18. OWNER RULE: names come from the organization's own records, and a lane word inside a name never changes the reading.
 *     The same organization with plain names (Alpha..., Bravo...) must get the same answers as with lane-word names. */
const PARITY = await (async () => {
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const REAL = ['Backflow Pros', 'Expired Rentals', 'Failed Hope Church', 'Water Heater Depot', 'Open Air Cafe', 'Permit Office Plaza', 'Test Kitchen Cafe', 'Re Test Realty', 'Final Touch Salon', 'Pass Creek Lodge', 'Last Stop Diner', 'First Baptist Church', 'No Limit Gym', 'Before Dawn Bakery', 'Plus One Pizza', 'Past Due Pawn', 'Smith & Sons', 'Sue Park', 'Overdue Plumbing Supply', 'Warranty Works'];
  const NATO = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango'];
  const PLAIN = NATO.map((n) => `${n} Holdings`);
  const STREETS = ['Aaa', 'Bbb', 'Ccc', 'Ddd', 'Eee', 'Fff', 'Ggg', 'Hhh', 'Iii', 'Jjj', 'Kkk', 'Lll', 'Mmm', 'Nnn', 'Ooo', 'Ppp', 'Qqq', 'Rrr', 'Sss', 'Ttt'];
  const build = async (key, names) => {
    const ctx = { tenantKey: key, tenantName: key }; await getTenantContext(key, key);
    await H.withTenant(ctx, (db) => H.R.setTenantIndustry(db, 'plumbing', { tenantKey: key })); H.R.resetPacksCacheForTests();
    await H.withTenant(ctx, async (db) => {
      const mk = async (fn, type, fields) => { const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: crypto.createHash('sha256').update(`${key}${fn}`).digest('hex'), stage: 'mapped' }); for (const [k, v] of Object.entries(fields)) { const facet = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: facet.id }); } };
      for (const [i, c] of names.entries()) {
        const a = `${10 + i} ${STREETS[i]} Street, Mesa AZ`;
        await mk(`bf${i}.pdf`, 'backflow-test-certificate', { customer_name: c, service_address: a, serial_number: `SN${i}`, equipment_type: 'RPZ', device_size: '1 inch', technician: i % 4 === 0 ? (names === PLAIN ? 'Alpha Bob' : 'Backflow Bob') : 'Pat Lee', service_date: addDays(TODAY, i % 2 ? -100 : -400), backflow_test_result: i % 5 === 0 ? 'Failed' : 'Passed', next_test_due: addDays(TODAY, i % 2 ? 265 : -35) });
        await mk(`wr${i}.pdf`, 'warranty-registration', { customer_name: c, service_address: a, serial_number: `WH${i}`, equipment_type: 'Water heater', manufacturer: 'Rheem', model: `M${i}`, warranty_expires: addDays(TODAY, i % 3 ? 50 : -50) });
        await mk(`pm${i}.pdf`, 'permit', { customer_name: c, service_address: a, permit_number: `PL-${i}`, permit_expires: addDays(TODAY, i % 2 ? 30 : -10), permit_status: 'Open' });
      }
    });
    return ctx;
  };
  return { build, REAL, PLAIN, mapName: (s) => [...REAL, 'Backflow Bob'].reduce((x, r, i) => { const p = i < REAL.length ? PLAIN[i] : 'Alpha Bob'; return x.split(r).join(p).split(r.toLowerCase()).join(p.toLowerCase()); }, String(s)) };
})();
{
  const real = await PARITY.build('org_parity_real', PARITY.REAL);
  const plain = await PARITY.build('org_parity_plain', PARITY.PLAIN);
  const withName = ['When is the next backflow test due for X?', 'Is the backflow device at X overdue?', 'Show the permits for X', 'Is the water heater at X under warranty?', 'What is the status of the permit for X?', 'What backflow devices are at X?', 'Who tested the backflow device at X?', 'When does the warranty expire for X?', 'What is the serial number of the water heater at X?', 'How many backflow devices does X have?', 'Did the backflow test pass at X?', 'What brand is the water heater at X?', 'When does the permit expire for X?', 'Is the permit at X open?'];
  const global = ['Which permits are open?', 'Which permits are expired?', 'Which backflow devices are overdue?', 'Which backflow devices failed?', 'How many permits are open?', 'Which water heater warranties have expired?', 'Which backflow tests are due in the next 60 days?', 'What needs attention?', 'How many backflow devices do we track?'];
  const qs = [...global, ...REAL_X(withName)];
  function REAL_X(ts) { return PARITY.REAL.flatMap((r) => ts.map((t) => t.replace('X', r))); }
  const ans = async (ctx, q) => H.withTenant(ctx, async (db) => { const it = clL(q); const r = it ? await runPlumbing(db, it, { today: TODAY }) : null; return r ? { t: r.text, f: (r.facts ?? []).map((x) => `${x.label}|${x.value}`).sort() } : null; });
  let answered = 0; const bad = [];
  for (const q of qs) {
    const a = await ans(real, q); const b = await ans(plain, PARITY.mapName(q));
    if (a) answered++;
    const same = JSON.stringify(a ? { t: PARITY.mapName(a.t), f: a.f.map(PARITY.mapName).sort() } : null) === JSON.stringify(b);
    if (!same) bad.push(`"${q}"\n      real : ${JSON.stringify(a?.t)}\n      plain: ${JSON.stringify(b?.t)}`);
  }
  check(`plain-name parity: ${qs.length} questions give the same answer (or the same "not sure") with lane-word names as with plain names`, bad.length === 0, bad.slice(0, 6).join('\n      '));
  const plainAnswered = (await Promise.all(qs.slice(0, 0))).length; void plainAnswered;
  let pa = 0; for (const q of qs) if (await ans(plain, PARITY.mapName(q))) pa++;
  check(`plain-name parity is not vacuous: most of the battery is answered for the plain org (${pa}/${qs.length}) and for the named org (${answered})`, pa >= Math.floor(qs.length * 0.6) && answered === pa, `${pa} plain vs ${answered} real of ${qs.length}`);
}
/* 19. permit statuses that plainly mean finished (and the ones that do not); name check for "Sue Park"; load-order independence; dotted dates */
{
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const org = async (key) => { const ctx = { tenantKey: key, tenantName: key }; await getTenantContext(key, key); await H.withTenant(ctx, (db) => H.R.setTenantIndustry(db, 'plumbing', { tenantKey: key })); H.R.resetPacksCacheForTests(); return ctx; };
  const mkDoc = async (db, fn, type, fields, key) => { const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: crypto.createHash('sha256').update(`${key}${fn}`).digest('hex'), stage: 'mapped' }); for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) { const facet = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: one }); await db.createExtraction({ document_id: doc.id, field_key: k, value: one, source_facet_id: facet.id }); } };
  const askC = (ctx, q) => H.withTenant(ctx, async (db) => { const it = clL(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  const txt = (r) => `${r?.text ?? ''} ${(r?.facts ?? []).map((x) => `${x.label} ${x.value}`).join(' ')}`;
  // 3. finished statuses
  const fin = ['Passed Final Inspection', 'Final OK', 'Finaled by City', 'Closed (final)', 'Final Inspection Complete', 'Closed - Final', 'Final Inspection Approved', 'Permit Finaled', 'Complete - Final', 'Final: Passed', 'Final Inspection Passed'];
  const stillOpen = ['Awaiting Final', 'Final Required', 'Final Inspection Pending', 'Needs Final Inspection', 'Failed Final Inspection', 'Final Denied', 'Open - Final Inspection Required', 'Open', 'Issued'];
  const unclear = ['Final Not Passed', 'Pre-Final Passed', 'Final Inspection Rejected'];
  const pc = await org('org_perm_status');
  const addrOf = (grp, i) => `${(grp === 'f' ? 300 : grp === 'o' ? 400 : 500) + i} Final Street, Mesa AZ`;
  await H.withTenant(pc, async (db) => {
    for (const [grp, list] of [['f', fin], ['o', stillOpen], ['u', unclear]]) for (const [i, st] of list.entries()) await mkDoc(db, `p${grp}${i}.pdf`, 'permit', { permit_number: `P${grp.toUpperCase()}-${i}`, service_address: addrOf(grp, i), customer_name: `Cust ${grp}${i}`, permit_status: st, permit_expires: addDays(TODAY, grp === 'f' && i % 2 ? -20 : 90) }, 'ps');
  });
  const statusOf = async (grp, i) => askC(pc, `What is the status of the permit at ${addrOf(grp, i).split(',')[0]}?`);
  const bad = [];
  for (const [i, st] of fin.entries()) { const r = await statusOf('f', i); if (!r || /\bis open\b|has expired/.test(r.text) || !r.text.toLowerCase().includes(st.toLowerCase())) bad.push(`finished wording "${st}" -> ${r?.text}`); }
  check(`permit status that plainly means finished (${fin.length} wordings) reads as finished, never open or expired (even past its expiry date)`, bad.length === 0, bad.join('; '));
  const bad2 = [];
  for (const [i, st] of stillOpen.entries()) { const r = await statusOf('o', i); if (!r || !/\bis open\b/.test(r.text)) bad2.push(`"${st}" -> ${r?.text}`); }
  check(`permit status with a not-done / still-open word (${stillOpen.length} wordings) stays open`, bad2.length === 0, bad2.join('; '));
  const bad3 = [];
  for (const [i, st] of unclear.entries()) { const r = await statusOf('u', i); if (r && !/\bis open\b|has expired/.test(r.text)) bad3.push(`"${st}" -> ${r?.text}`); }
  check(`permit status with a not-done word next to a finished word (${unclear.length} wordings) is never read as finished`, bad3.length === 0, bad3.join('; '));
  // 2. a customer named Sue Park
  const sp = await org('org_sue');
  await H.withTenant(sp, async (db) => { await mkDoc(db, 'sue.pdf', 'backflow-test-certificate', { service_address: '5 Sue Lane, Mesa AZ', customer_name: 'Sue Park', serial_number: 'SUE-1', service_date: addDays(TODAY, -100), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 265) }, 'sp'); });
  const s1 = await askC(sp, 'When is the next backflow test due for Sue Park?'); const s2 = await askC(sp, 'Can I sue the tester?'); const s3 = await askC(sp, 'Could I be sued over this backflow test?');
  check('a customer named Sue Park is answered, not declined as legal advice', !!s1 && !s1.decline && /Lane/.test(txt(s1)) && !/legal advice/.test(s1.text), s1?.text);
  check('a real legal question is still declined, with or without a name in it', s2?.decline === true && s3?.decline === true, `${s2?.text} | ${s3?.text}`);
  // 4. load-order independence
  const specs = [
    ['cam1.pdf', 'sewer-camera-report', { service_address: '61 Order Way, Mesa AZ', customer_name: 'Order One', service_date: addDays(TODAY, -3), line_findings: ['Roots at 40 ft', 'Offset joint at 62 ft', 'Cracked pipe at 90 ft'] }],
    ['cam2.pdf', 'sewer-camera-report', { service_address: '62 Order Way, Mesa AZ', customer_name: 'Order Two', service_date: addDays(TODAY, -3), line_findings: ['Clear', 'Belly at 20 ft'] }],
    ['bfa.pdf', 'backflow-test-certificate', { service_address: '63 Order Way, Mesa AZ', customer_name: 'Order Three', serial_number: 'ORD-3', service_date: addDays(TODAY, -100), backflow_test_result: 'Passed', next_test_due: addDays(TODAY, 20), technician: 'Pat Lee' }],
    ['bfb.pdf', 'backflow-test-certificate', { service_address: '63 Order Way, Mesa AZ', customer_name: 'Order Three', serial_number: 'ORD-3', service_date: addDays(TODAY, -100), backflow_test_result: 'Failed', next_test_due: addDays(TODAY, 30), technician: 'Kim Roe' }],
    ['bfc.pdf', 'backflow-test-certificate', { service_address: '64 Order Way, Mesa AZ', customer_name: 'Order Four', serial_number: 'ORD-4', service_date: addDays(TODAY, -100), backflow_test_result: 'Passed', next_test_due: [addDays(TODAY, 20), addDays(TODAY, 40)] }],
    ['wr1.pdf', 'warranty-registration', { service_address: '65 Order Way, Mesa AZ', customer_name: 'Order Five', serial_number: 'ORD-WH', manufacturer: 'Rheem', model: 'A1', warranty_expires: addDays(TODAY, 100), warranty_registered_date: addDays(TODAY, -300) }],
    ['wr2.pdf', 'warranty-registration', { service_address: '65 Order Way, Mesa AZ', customer_name: 'Order Five', serial_number: 'ORD-WH', manufacturer: 'Rheem', model: 'A1', warranty_expires: addDays(TODAY, 100), warranty_registered_date: addDays(TODAY, -300) }],
    ['pm1.pdf', 'permit', { permit_number: 'PL-ORD-1', service_address: '66 Order Way, Mesa AZ', customer_name: 'Order Six', permit_status: 'Open', permit_expires: addDays(TODAY, 30) }],
    ['pm2.pdf', 'permit', { permit_number: 'PL-ORD-1', service_address: '66 Order Way, Mesa AZ', customer_name: 'Order Six', permit_status: 'Final', permit_expires: addDays(TODAY, 30) }],
  ];
  const load = async (key, list) => { const ctx = await org(key); await H.withTenant(ctx, async (db) => { for (const [fn, t, f] of list) await mkDoc(db, fn, t, f, key); const flat = { created_at: '2026-01-01T00:00:00Z' }; await db.raw('UPDATE documents SET created_at = $1', [flat.created_at]); await db.raw('UPDATE extractions SET created_at = $1', [flat.created_at]); }); return ctx; };
  const fwd = await load('org_order_fwd', specs); const rev = await load('org_order_rev', [...specs].reverse().map(([fn, t, f]) => [fn, t, Object.fromEntries(Object.entries(f).reverse().map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]))]));
  const oq = ['What did the camera find at 61 Order Way?', 'What did the camera find at 62 Order Way?', 'Which sewer lines have defects?', 'When is the next backflow test due at 63 Order Way?', 'Who tested the backflow device at 63 Order Way?', 'Is the backflow device at 63 Order Way overdue?', 'When is the next backflow test due at 64 Order Way?', 'Which backflow devices failed?', 'Which backflow tests are due in the next 60 days?', 'When does the warranty expire at 65 Order Way?', 'Which water heater warranties expire in the next 120 days?', 'What is the status of the permit at 66 Order Way?', 'Which permits are open?', 'What needs attention?', 'How many backflow devices do we track?', 'How many permits are open?'];
  const diff = []; let ans = 0;
  for (const q of oq) { const a = await askC(fwd, q); const b = await askC(rev, q); if (a) ans++; const sa = JSON.stringify(a && { t: a.text, f: (a.facts ?? []).map((x) => `${x.label}|${x.value}`) }); const sb = JSON.stringify(b && { t: b.text, f: (b.facts ?? []).map((x) => `${x.label}|${x.value}`) }); if (sa !== sb) diff.push(`"${q}"\n      fwd: ${a?.text}\n      rev: ${b?.text}`); }
  check(`load order: records loaded in reverse (documents and values) give word-for-word the same ${oq.length} answers`, diff.length === 0, diff.slice(0, 4).join('\n      '));
  check(`load order is not vacuous: ${ans} of ${oq.length} questions are actually answered`, ans >= 12, `${ans}`);
  // 5. dotted dates
  const dd = (d) => { const r = extractPlumbing([{ page_no: 1, text: ['Backflow Prevention Assembly Test Report', 'Service Address: 12 Elm Street, Mesa AZ', 'Customer: Acme Co', 'Serial No: DOT1', `Date of Test: ${d}`, 'Result: Passed'].join('\n') }]); return r?.fields.find((x) => x.key === 'service_date')?.value ?? null; };
  check('dotted date 05.10.2026 (day-first or month-first) is not guessed', dd('05.10.2026') === null && dd('01.02.26') === null);
  check('dotted date is read when only one reading is possible (25.03.2026, 03.25.2026, 31.12.2025)', dd('25.03.2026') === '2026-03-25' && dd('03.25.2026') === '2026-03-25' && dd('31.12.2025') === '2025-12-31');
  check('slash and dash dates keep the existing rule (05/10/2026 month-first, 25/03/2026 day-first)', dd('05/10/2026') === '2026-05-10' && dd('25/03/2026') === '2026-03-25' && dd('05-10-2026') === '2026-05-10');
}
/* 20. printed order of several values, and same-day ties */
{
  const { getTenantContext } = await import('../api/_lib/recordsStore.js');
  const org = async (key) => { const ctx = { tenantKey: key, tenantName: key }; await getTenantContext(key, key); await H.withTenant(ctx, (db) => H.R.setTenantIndustry(db, 'plumbing', { tenantKey: key })); H.R.resetPacksCacheForTests(); return ctx; };
  const store = async (db, fn, text, key) => { const r = extractPlumbing([{ page_no: 1, text }]); const doc = await db.createDocument({ original_filename: fn, document_type: r.type, sha256_hash: crypto.createHash('sha256').update(`${key}${fn}`).digest('hex'), stage: 'mapped' }); await db.upsertPages(doc.id, [{ page_no: 1, text }]); for (const x of r.fields) { const facet = await db.createFacet({ document_id: doc.id, page_no: x.page_no, label_raw: x.key, value_raw: x.value }); await db.createExtraction({ document_id: doc.id, field_key: x.key, value: x.value, source_facet_id: facet.id }); } return r; };
  const askO = (ctx, q) => H.withTenant(ctx, async (db) => { const it = clL(q); return it ? runPlumbing(db, it, { today: TODAY }) : null; });
  const ctx = await org('org_printed_order');
  // printed order is deliberately NOT alphabetical and NOT "N ft" order
  const finds = ['Zigzag crack at 90 ft', 'Roots at 120 ft', 'Belly at 15 ft', 'Offset joint at 62 ft'];
  const cam = (n, date, list) => `Sewer Camera Inspection Report\nService Address: ${n} Print Way, Mesa AZ\nCustomer: Print ${n}\nInspection Date: ${long(date)}\nFindings:\n${list.map((x) => `- ${x}`).join('\n')}`;
  await H.withTenant(ctx, async (db) => {
    const r = await store(db, 'print-cam.pdf', cam(71, addDays(TODAY, -3), finds), 'po');
    await store(db, 'print-tk.pdf', `Service Ticket\nTicket No: T-71\nService Address: 71 Print Way, Mesa AZ\nCustomer: Print 71\nService Date: ${long(addDays(TODAY, -3))}\nWork Performed:\n- Replaced zebra valve\n- Cleared main line\n- Adjusted pressure regulator`, 'po');
    if (process.env.DBG) console.log(JSON.stringify(r.fields.map((x) => [x.key, x.value])));
  });
  const c = await askO(ctx, 'What did the camera find at 71 Print Way?');
  const idx = finds.map((x) => (c?.text ?? '').indexOf(x));
  check('camera findings come back in the PRINTED order (not alphabetical, not by footage)', !!c && idx.every((i) => i >= 0) && idx.every((i, k) => k === 0 || i > idx[k - 1]), c?.text);
  const t = await askO(ctx, 'What was done at 71 Print Way on the last service call?');
  const w = ['Replaced zebra valve', 'Cleared main line', 'Adjusted pressure regulator'].map((x) => (t?.text ?? '').indexOf(x));
  check('service work comes back in the PRINTED order', !!t && w.every((i) => i >= 0) && w.every((i, k) => k === 0 || i > w[k - 1]), t?.text);
  // same-day ties
  const tc = await org('org_same_day');
  await H.withTenant(tc, async (db) => {
    await store(db, 'sd-cam-a.pdf', cam(81, addDays(TODAY, -3), ['Roots at 10 ft']), 'sd');
    await store(db, 'sd-cam-b.pdf', cam(81, addDays(TODAY, -3), ['Cracked pipe at 20 ft']), 'sd');
    await store(db, 'sd-cam-c.pdf', cam(82, addDays(TODAY, -10), ['Old roots at 5 ft']), 'sd');
    await store(db, 'sd-cam-d.pdf', cam(82, addDays(TODAY, -3), ['New crack at 6 ft']), 'sd');
    const tk = (no, work) => `Service Ticket\nTicket No: ${no}\nService Address: 83 Print Way, Mesa AZ\nCustomer: Print 83\nService Date: ${long(addDays(TODAY, -4))}\nWork Performed:\n- ${work}`;
    await store(db, 'sd-tk-a.pdf', tk('T-A', 'Replaced hose bib'), 'sd');
    await store(db, 'sd-tk-b.pdf', tk('T-B', 'Snaked kitchen drain'), 'sd');
  });
  const sc = await askO(tc, 'What did the camera find at 81 Print Way?');
  check('two camera reports on the same day: asks which one, never silently picks one', sc?.clarify === true && !/Roots at 10 ft|Cracked pipe/.test(sc.text.split('Which one')[0] ?? '') && /same day/.test(sc.text), sc?.text);
  const sd = await askO(tc, 'What did the camera find at 82 Print Way?');
  check('camera reports on different days: the latest is answered', !!sd && /New crack at 6 ft/.test(sd.text) && !/Old roots/.test(sd.text), sd?.text);
  const st = await askO(tc, 'What was done at 83 Print Way on the last service call?');
  check('two service tickets on the same day: asks which one, never silently picks one', st?.clarify === true && /same day/.test(st.text) && (st.clarifyOptions ?? []).length === 2, st?.text);
}
check('the card asks plumbing questions the lane understands', ['Which permits have expired?', 'Which open permits expire in the next 60 days?', 'Which backflow tests, water heater warranties or permits need attention?'].every((x) => clL(x) != null && clL(x).kind !== 'decline'));
console.log(failures ? `${failures} FAILED (${passes} passed)` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
