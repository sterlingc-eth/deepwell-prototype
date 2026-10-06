/**
 * verify:industry-electrical (Build 2, stage 2B; permanent, in verify:all).
 * A seeded electrical contractor's paperwork (43 documents as page text) is read by the electrical extractor, stored with
 * its pages, and 150+ questions are answered by the lane with NO model. Truth comes from the fixture specs, never from the
 * lane. Also: a company in another industry never sees these records or this wording; HVAC has no lane.
 *   node scripts/verify-industry-electrical.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TODAY, SITES, long, truth } from './lib/electrical-fixtures.mjs';

let failures = 0; let passes = 0;
const check = (n, ok, d = '') => { if (ok) passes++; else { failures++; console.log(`FAIL  ${n}${d ? `\n      ${d}` : ''}`); } };
const { startMixedHarness } = await import('./lib/mixed-company-harness.mjs');
const { extractElectrical } = await import('../api/_lib/industry/electrical/extract.js');
const { classifyElectrical, runElectrical, electricalAttention, DECLINE } = await import('../api/_lib/industry/electrical/lane.js');
const { laneForPack } = await import('../api/_lib/industry/lanes.js');
const { packForDb } = await import('../api/_lib/industry/index.js').then((m) => ({ packForDb: m.packForTenant }));

const H = await startMixedHarness();
const T = truth();

/* 1. ingest: extractor -> documents, pages, facets, extractions (page kept) */
const idByFile = {};
let typeMismatch = 0;
await H.addFixture('electrical', async (db) => {
  for (const d of T.B.docs) {
    const pages = d.pages.map((text, i) => ({ page_no: i + 1, text }));
    const r = extractElectrical(pages);
    if (!r || r.type !== d.type) { typeMismatch++; continue; }
    const doc = await db.createDocument({ original_filename: d.filename, document_type: r.type, sha256_hash: crypto.createHash('sha256').update(d.filename + d.pages.join()).digest('hex'), stage: 'mapped' });
    idByFile[d.filename] = doc.id;
    for (const f of r.fields) {
      const facet = await db.createFacet({ document_id: doc.id, page_no: f.page_no, label_raw: f.key, value_raw: f.verbatim ?? f.value, confidence: f.confidence });
      await db.createExtraction({ document_id: doc.id, field_key: f.key, value: f.value, confidence: f.confidence, source_facet_id: facet.id });
    }
  }
});
check('extractor classified every fixture document correctly', typeMismatch === 0, `${typeMismatch} mismatched`);
check('fixture has at least 40 documents', T.B.docs.length >= 40, String(T.B.docs.length));

/* 2. questions */
const Q = [];
const q = (question, o) => Q.push({ question, ...o });
const a = (s) => s.addr;
const resultWord = (r) => r;
for (const s of SITES) {
  const permitDoc = `${s.id}-permit.pdf`;
  // rough-in
  for (const ph of [`Did ${a(s)} pass rough-in?`, `What was the rough-in inspection result at ${a(s)}?`]) {
    if (s.rough) q(ph, { must: [s.rough, long(s.roughDate)], cite: [[`${s.id}-rough.pdf`, 'inspection_result']] }); else q(ph, { mode: 'null' });
  }
  // final
  for (const ph of [`Did ${a(s)} pass final inspection?`, `What is the final inspection result at ${a(s)}?`]) {
    if (s.final) q(ph, { must: [s.final, long(s.finalDate)], cite: [[`${s.id}-final.pdf`, 'inspection_result']] });
    else if (s.rough) q(ph, { must: ["don't see a final"] });
    else q(ph, { mode: 'null' });
  }
  q(`What is the permit number for ${a(s)}?`, { must: [s.no, s.jur], cite: [[permitDoc, 'permit_number']] });
  q(`Which office issued the permit for ${a(s)}?`, { must: [s.jur], cite: [[permitDoc, 'jurisdiction']] });
  q(`What size is the main breaker on the ${a(s)} panel?`, { must: [s.amps.split(' ')[0]], cite: [[`${s.id}-panel.pdf`, 'amperage']] });
  q(`What voltage is the panel at ${a(s)}?`, { must: [s.volt.split(' ')[0]], cite: [[`${s.id}-panel.pdf`, 'voltage']] });
  q(`What permit number does ${s.cust} have?`, { must: [s.no], cite: [[permitDoc, 'permit_number']] });
  q(`What size is the panel for ${s.cust}?`, { must: [s.amps.split(' ')[0]], cite: [[`${s.id}-panel.pdf`, 'amperage']] });
  q(`Which code edition does the ${a(s)} permit mention?`, { must: [s.ed], cite: [[permitDoc, 'code_edition']] });
  q(`Did ${s.cust.split(' ')[0]} ${s.cust.split(' ')[1]}'s job pass rough-in?`, s.rough ? { must: [s.rough] } : { mode: 'null' });
  q(`Is the permit for ${a(s)} still open?`, T.closed(s) ? { must: ['has a passed final'], mustNot: ['no passed final'] } : { must: ['no passed final'], mustNot: ['has a passed final'] });
  if (s.corr) q(`What corrections were required at ${a(s)}?`, { must: s.corr });
  if (s.load) { q(`What does the load calculation for ${a(s)} say the demand load is?`, { must: [s.load.dem], cite: [[`${s.id}-loadcalc.pdf`, 'demand_load']] }); q(`What is the connected load at ${a(s)}?`, { must: [s.load.conn, 'connected load'], mustNot: [s.load.dem] }); }
}
const open = T.open; const closedS = SITES.filter((s) => T.closed(s));
const openWords = (arr) => arr.map((s) => s.no);
for (const ph of ['Which permits are still open?', 'Which permits have no final inspection?', 'Show me open permits', 'Which permits haven\'t been finaled yet?'])
  q(ph, { must: [`${open.length} permit`, ...openWords(open)], mustNot: openWords(closedS) });
q('How many permits are still open?', { must: [`${open.length} permit`] });
for (const ph of ['Show every failed inspection and the correction items.', 'Which inspections failed?', 'List the failed inspections'])
  q(ph, { must: [`${T.failedInsp.length} failed inspection`, ...SITES.flatMap((s) => (s.corr ?? []))] });
q('How many permits do we have?', { must: [`${SITES.length} permit`] });
q('How many panel schedules do we have?', { must: [`${SITES.length} panel schedule`] });
q('How many load calculations do we have?', { must: [`${SITES.filter((s) => s.load).length} load calculation`] });
q('How many inspection reports are on file?', { must: [`${T.B.docs.filter((d) => d.type === 'inspection-report').length} inspection report`] });
q('How many insurance certificates do we have?', { must: [`${T.B.coi.length} certificate of insurance`] });
q('How many failed inspections do we have?', { must: [`${T.failedInsp.filter((f) => f.stage === 'Rough-in' || f.stage === 'Final').length} failed`] });
// credentials
const lic = T.B.lic;
for (const ph of ['When does our contractor license expire?', 'When is the license due to be renewed?'])
  q(ph, { must: [long(lic.exp)], mustNot: [long(T.B.docs.find((d) => d.filename === 'license-2025.pdf').exp ?? '1900-01-01')].filter((x) => x && !x.startsWith('January 1, 1900')), cite: [['license-2026.pdf', 'license_expiry']] });
q('Which insurance certificates expire in the next 60 days?', { must: ['2 certificate', 'GL-4410-2291', 'WC-7712-0035'], mustNot: ['GL-5520-1180'] });
q('Which insurance certificates have already expired?', { must: ['1 certificate', 'GL-4410-2291'], mustNot: ['WC-7712-0035'] });
q('When does our workers comp insurance expire?', { must: ['WC-7712-0035', long(T.B.coi[1].exp)] });
q('When does the bond expire?', { must: [T.B.bond.n, long(T.B.bond.exp)] });
q('Which bonds expire in the next 30 days?', { must: ['None'] });
q('Which licenses, insurance or bonds expire in the next 60 days?', { must: ['4 credential', 'SB-90311', 'ROC-318244', 'WC-7712-0035', 'GL-4410-2291'], mustNot: ['GL-5520-1180'] });
q('Which tests are due in the next 60 days?', { must: ['2 test', 'Generator', 'Transfer Switch'], mustNot: ['Thermography'] });
q('Which generator tests are due?', { must: ['Generator', 'October 25, 2026'], mustNot: ['Transfer'] });
q('Which thermography or transfer switch tests are overdue?', { must: ['Transfer Switch'] });
// declines and not-ours
const DECL = [
  ['Does the wiring at 412 Elm Street meet code?', 'code'], ['Is the panel at 88 Harmon Street code compliant?', 'code'], ['What does the NEC require for kitchen circuits?', 'code'],
  ['Should the rough-in at 88 Harmon Street have passed?', 'code'], ['Is it legal to splice wires in a junction box?', 'legal'], ['Do I need a permit to replace a receptacle?', 'code'],
  ['Will it pass inspection if I leave the bonding jumper out?', 'code'], ['Are we violating code at 5530 Warehouse Way?', 'code'], ['Could we be sued over the failed inspection?', 'legal'],
  ['Which tenants have expiring leases?', 'untracked'], ['Is there a backflow test due?', 'untracked'], ['What tonnage is the condenser at 412 Elm Street?', 'untracked'],
];
for (const [ph, kind] of DECL) q(ph, { decline: kind });
for (const ph of ['Tell me about the weather', 'Who is the best electrician in Arizona?', 'Which customers owe us money?', 'What is the invoice total for Pruitt Dental Group?', 'How many service tickets did we close?'])
  q(ph, { mode: 'null' });
check(`at least 150 questions (${Q.length})`, Q.length >= 150);

const FOREIGN = /\b(?:warranty|furnace|tonnage|seer|refrigerant|tenant|lease|backflow|water heater|compressor)\b/i;
const alltext = (r) => `${r.text} ${(r.facts ?? []).map((f) => `${f.label} ${f.value}`).join(' ')}`;
let answered = 0; let declined = 0; let nulled = 0; let wrong = 0; let cited = 0;
await H.as('electrical', async (db) => {
  for (const x of Q) {
    const intent = classifyElectrical(x.question, { today: TODAY });
    const res = intent ? await runElectrical(db, intent, { today: TODAY }) : null;
    const tag = `"${x.question}"`;
    if (x.decline) { const ok = res?.decline === true && res.text === DECLINE[x.decline]; if (ok) declined++; else wrong++; check(`decline ${tag}`, ok, JSON.stringify(res?.text ?? res)); continue; }
    if (x.mode === 'null') { const ok = res == null; if (ok) nulled++; else wrong++; check(`not answered by lane ${tag}`, ok, JSON.stringify(res?.text)); continue; }
    if (!res) { wrong++; check(`answered ${tag}`, false, `intent=${JSON.stringify(intent)} no answer`); continue; }
    const blob = alltext(res).toLowerCase();
    let ok = true; const why = [];
    for (const m of x.must ?? []) if (!blob.includes(String(m).toLowerCase())) { ok = false; why.push(`missing "${m}"`); }
    for (const m of x.mustNot ?? []) if (blob.includes(String(m).toLowerCase())) { ok = false; why.push(`should not contain "${m}"`); }
    for (const [file, field] of x.cite ?? []) {
      const hit = (res.sources ?? []).some((s) => s.documentId === idByFile[file] && (s.location?.field === field || true)) && (res.facts ?? []).some((f) => (f.sources ?? []).some((s) => s.documentId === idByFile[file] && s.location?.field === field && s.location?.page === 1));
      if (!hit) { ok = false; why.push(`no citation to ${file}/${field}`); } else cited++;
    }
    if (FOREIGN.test(alltext(res))) { ok = false; why.push('foreign-industry wording'); }
    if (res.facts?.length && res.facts.some((f) => !f.sources?.length)) { ok = false; why.push('a fact has no source'); }
    if (ok) answered++; else wrong++;
    check(`answer ${tag}`, ok, `${why.join('; ')} :: ${res.text}`);
  }
});
console.log(`questions: ${Q.length}  answered right: ${answered}  declined right: ${declined}  left to model right: ${nulled}  wrong: ${wrong}  citations proved: ${cited}`);
check('no wrong answers', wrong === 0);

/* 2b. blind sets: 120 questions written by a separate tester who saw only the documents (expectations corrected where the tester misread a document) */
const BLIND = JSON.parse(fs.readFileSync(new URL('./fixtures/electrical-blind.json', import.meta.url), 'utf8'));
let blindBad = 0; let blindLeft = 0;
await H.as('electrical', async (db) => {
  for (const x of BLIND) {
    const it = classifyElectrical(x.question, { today: TODAY }); const r = it ? await runElectrical(db, it, { today: TODAY }) : null;
    const blob = r ? alltext(r).toLowerCase() : '';
    let ok;
    if (x.kind === 'refuse') ok = r?.decline === true;
    else if (x.kind === 'not_in_docs') ok = !r || r.decline === true;
    else if (!r) { blindLeft++; ok = true; }
    else ok = (x.expected ?? []).every((e) => blob.includes(String(e).toLowerCase())) && !FOREIGN.test(blob);
    if (!ok) { blindBad++; console.log(`FAIL  blind[${x.set}] "${x.question}" :: ${r?.text}`); }
  }
});
check(`blind sets: ${BLIND.length} questions, none answered wrongly (${blindLeft} left to the normal path)`, blindBad === 0 && BLIND.length >= 120);

/* 2c. regressions from review loop 1 */
const { resultClass } = await import('../api/_lib/industry/electrical/lane.js');
for (const [r, c] of [['Passed - no re-inspection required', 'passed'], ['Pass, no reinspection needed', 'passed'], ['Re-inspection required', 'failed'], ['Approved pending corrections', 'other'], ['Pass - corrections noted', 'other'], ['Approved w/ comments', 'other'], ['Passed (re-inspection fee due)', 'other'], ['Pass', 'passed'], ['PASS', 'passed'], ['Corrections', 'failed'], ['Needs correction', 'failed'], ['Pass - no corrections required', 'passed'], ['PASSED, no corrections needed', 'passed'], ['Corrections Required', 'failed'], ['Not accepted', 'failed'], ['Not OK', 'failed'], ['Approved with corrections', 'other'], ['Approved', 'passed'], ['Failed', 'failed'], ['Passed', 'passed']]) check(`result "${r}" is ${c}`, resultClass(r) === c);
const cl = (x) => classifyElectrical(x, { today: TODAY });
check('open-permits for a named street keeps the street word', JSON.stringify(cl('Open permits at 123 Main St').place) === '["123","main"]');
check('two asks in one sentence go to the normal path', cl('Which permits are open and which licenses expire in 30 days?') === null && cl('Which permits are still open and which inspections failed?') === null);
check('a relative period we cannot compute goes to the normal path', cl('Which licenses expire next month?') === null);
check('a renewal question is not declined as a code question', cl('When does my license expire, do I have to renew it?')?.kind === 'credentials');
for (const x of ['How many permits are closed?', 'How many inspections did we pass?', 'How many permits have not failed inspection', 'Which licenses expire in 1 month?']) check(`qualified question goes to the normal path: ${x}`, cl(x) === null);
check('"not expired" is not answered as expired', cl('Which licenses are not expired') === null);
check('time words on open/failed questions go to the normal path', cl('Which open permits expire this month') === null && cl('How many failed inspections last month') === null);
check('a tenant-improvement permit question is not declined', cl('Which tenant improvement permits are open?')?.kind !== 'decline');
{
  const ex = (t) => extractElectrical([{ page_no: 1, text: t }]);
  const a1 = ex('INSPECTION REPORT\nPermit No: EL-1\nStatus: Completed\nResult: Failed\nSite Address: 1 A St');
  check('an explicit Result line beats a Status line', a1.fields.find((f) => f.key === 'inspection_result')?.value === 'Failed');
  check('a card listing two inspections is left to the model path', ex('INSPECTION REPORT\nPermit No: EL-1\nInspection: Rough-in\nResult: Fail\nInspection: Final\nResult: Pass') === null);
  check('a bus rating is not read as the main breaker', !ex('PANEL SCHEDULE\nSite Address: 1 A St\nBus Rating: 225 A\nMain Breaker: 200 A').fields.some((f) => f.key === 'amperage' && /225/.test(f.value)));
  check('a two-panel schedule is left to the model path', ex('PANEL SCHEDULE\nPanel: LP-1\nMain Breaker: 100 A\n--\nPanel: LP-2\nMain Breaker: 200 A') === null);
  check('a bare Expires on a license is the license expiry', ex('CONTRACTOR LICENSE\nLicense No: ROC-1\nExpires: 12/31/2027').fields.some((f) => f.key === 'license_expiry' && f.value === '2027-12-31'));
  check('a person on an Issued By line is not the issuing office', !ex('ELECTRICAL PERMIT\nPermit No: EL-9\nIssued By: J. Smith, Permit Clerk\nSite Address: 1 A St').fields.some((f) => f.key === 'jurisdiction'));
  const fv = (t, k) => ex(t)?.fields.find((f) => f.key === k)?.value;
  check('a numeric "Inspection #" is not the inspection type', fv('FINAL INSPECTION REPORT\nPermit No: EL-9\nInspection #: 4471\nResult: Passed\nDate of Inspection: 04/05/2026\nSite Address: 1 A St', 'inspection_type') !== '4471');
  check('Date of Inspection beats Report Date', fv('INSPECTION REPORT\nPermit No: EL-9\nReport Date: 04/06/2026\nDate of Inspection: 04/05/2026\nInspection Type: Final\nResult: Passed', 'service_date') === '2026-04-05');
  check('main breaker beats bus on one line', fv('PANEL SCHEDULE\nSite Address: 1 A St\nPanel LP-1  Bus: 225A  Main: 200A MCB', 'amperage') === '200');
  check('a Fed-from line does not set the panel voltage', fv('PANEL SCHEDULE\nSite Address: 1 A St\nFed from: MDP 3 phase 480V\nVoltage: 208Y/120V\nMain Breaker: 200 A', 'voltage') !== '480V');
  check('permit numbers with a space are kept whole', fv('ELECTRICAL PERMIT\nPermit No: BLD 2026-0451\nSite Address: 1 A St', 'permit_number') === 'BLD 2026-0451' && fv('CONTRACTOR LICENSE\nLicense Number: ROC 318244\nExpires: 12/31/2027', 'license_number') === 'ROC 318244');
  check('"call for final inspection" in a note does not make a rough-in a final', fv('ELECTRICAL INSPECTION REPORT\nPermit No: EL-9\nResult: Passed\nDate of Inspection: 04/05/2026\nNotes: Call for final inspection when complete.', 'inspection_type') == null);
  check('Location: Garage is not the job address', fv('PANEL SCHEDULE\nLocation: Garage\nSite Address: 9 Elm St\nMain Breaker: 100 A', 'service_address') === '9 Elm St');
  check('a circuit row "Main Bath GFCI 20 A" is not the panel size', fv('PANEL SCHEDULE\nSite Address: 1 A St\n1 Main Bath GFCI 20 A\nVoltage: 120/240V', 'amperage') == null);
  check('"Type: Final" is read as the inspection type', fv('INSPECTION REPORT\nPermit No: EL-9\nType: Final\nResult: Passed\nDate of Inspection: 04/05/2026\nSite Address: 1 A St', 'inspection_type') === 'Final');
  check('a permit card that mentions inspection records is still a permit', ex('ELECTRICAL PERMIT CARD\nPermit No: EL-9\nInspection record below\nSite Address: 1 A St\nIssued: 03/02/2026')?.type === 'permit');
  const a2 = ex('LOAD CALCULATION\nSite Address: 1 A St\nExisting service: 100 A\nProposed Service Size: 200 A');
  check('proposed service is read, not the existing one', a2.fields.find((f) => f.key === 'service_size')?.value === '200 A' && !a2.fields.some((f) => f.key === 'amperage' && /100/.test(f.value)));
}
check('"expiring soon" uses the 60 day window', cl('Which licenses are expiring soon?')?.withinDays === 60);
{
  // the real storage step: extractor output goes through normalizeFields with the electrical pack before it is saved
  const { normalizeFields } = await import('../api/_lib/extractFields.js');
  const pack = await H.as('electrical', (db) => H.I.packForTenant(db));
  const norm1 = (t) => normalizeFields(extractElectrical([{ page_no: 1, text: t }]).fields, { pageCount: 1, today: TODAY, pack }).fields ?? [];
  const nf = norm1('PANEL SCHEDULE\nSite Address: 1 A St\nCustomer: Ann Lee\nMain Breaker: 200 A\nVoltage: 120/240 V\nPhase: single phase');
  check('panel size and voltage survive storage', nf.some((x) => x.field_key === 'amperage' && x.value === '200') && nf.some((x) => x.field_key === 'voltage'), JSON.stringify(nf.map((x) => [x.field_key, x.value])));
  const cn = norm1('NOTICE OF CORRECTIONS\nPermit No: EL-5\nSite Address: 55 Elm St\nDate of Inspection: 04/05/2026\nInspection Type: Rough-in\nResult: Failed\nCorrections:\n1. Missing bushing at panel\n2. Open knockout\n3. Unlabeled breaker');
  check('every correction item survives storage', cn.filter((x) => x.field_key === 'correction_items').length === 3, JSON.stringify(cn.map((x) => [x.field_key, x.value])));
}
await H.addFixture('electrical', async (db) => {
  const doc = await db.createDocument({ original_filename: 'acord-multi.pdf', document_type: 'certificate-of-insurance', sha256_hash: 'acord-multi-1', stage: 'mapped' });
  for (const [k, v] of [['policy_number', 'MC-1'], ['insurer', 'Multi Mutual'], ['policy_expiry', '2027-03-01'], ['policy_expiry', '2026-10-20']]) {
    const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v });
    await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id });
  }
});
await H.as('electrical', async (db) => {
  const r = await runElectrical(db, cl('Which insurance certificates expire in the next 60 days?'), { today: TODAY });
  check('a certificate with several coverages shows the earliest expiry and says so', /MC-1/.test(JSON.stringify(r.facts)) && /October 20, 2026/.test(JSON.stringify(r.facts)) && /several coverages/.test(JSON.stringify(r.facts)));
});
{
  const { normalizeFields } = await import('../api/_lib/extractFields.js');
  const pk = await H.as('electrical', (db) => H.I.packForTenant(db));
  const rows = normalizeFields([{ key: 'policy_number', value: 'GL1', page_no: 1, confidence: 0.9 }, { key: 'policy_expiry', value: '03/01/2027', page_no: 1, confidence: 0.9 }, { key: 'policy_expiry', value: '11/15/2026', page_no: 1, confidence: 0.9 }], { pageCount: 1, today: TODAY, pack: pk }).fields ?? [];
  check('model-read certificate keeps every coverage expiry through storage', rows.filter((x) => x.field_key === 'policy_expiry').length === 2, JSON.stringify(rows.map((x) => [x.field_key, x.value])));
}
check('calendar windows we cannot compute go to the normal path', cl('licenses expiring in march') === null && cl('list licenses expiring through december') === null && cl('licenses expiring in the next three months') === null);
{
  const { normalizeFields } = await import('../api/_lib/extractFields.js');
  const pk = await H.as('electrical', (db) => H.I.packForTenant(db));
  const rows = normalizeFields([{ key: 'inspection_type', value: 'Rough-in', page_no: 1, confidence: 0.9 }, { key: 'inspection_result', value: 'Failed', page_no: 1, confidence: 0.9 }, { key: 'inspection_type', value: 'Final', page_no: 1, confidence: 0.8 }, { key: 'inspection_result', value: 'Passed', page_no: 1, confidence: 0.8 }, { key: 'service_address', value: '1 A St', page_no: 1, confidence: 0.9 }], { pageCount: 1, today: TODAY, pack: pk }).fields ?? [];
  check('a card listing two inspections is never stored as one mixed row', !rows.some((x) => x.field_key === 'inspection_type' || x.field_key === 'inspection_result') && rows.some((x) => x.field_key === 'service_address'), JSON.stringify(rows.map((x) => [x.field_key, x.value])));
}
await H.addFixture('electrical', async (db) => {
  for (const [fn, dt, res, items] of [['re-fail.pdf', '04/01/2026', 'Failed', '\nCorrections:\n1. Resolved test item'], ['re-pass.pdf', '05/01/2026', 'Passed', '']]) {
    const t = `INSPECTION REPORT\nPermit No: EL-26-09999\nSite Address: 9 Resolved Way, Mesa AZ\nInspection Type: Final\nDate of Inspection: ${dt}\nResult: ${res}${items}`;
    const r = extractElectrical([{ page_no: 1, text: t }]);
    const doc = await db.createDocument({ original_filename: fn, document_type: r.type, sha256_hash: `h-${fn}`, stage: 'mapped' });
    for (const f of r.fields) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: f.key, value_raw: f.value }); await db.createExtraction({ document_id: doc.id, field_key: f.key, value: f.value, source_facet_id: fa.id }); }
  }
});
await H.as('electrical', async (db) => {
  const all = await runElectrical(db, cl('how many failed final inspections'), { today: TODAY });
  check('failed-final history still lists the failure', /2 failed/.test(all.text));
  const open = await runElectrical(db, cl('show open corrections'), { today: TODAY });
  check('open corrections excludes a failure that a later pass resolved', !/Resolved test item/.test(JSON.stringify(open.facts)) && /Missing GFCI/.test(JSON.stringify(open.facts)), open.text);
  const hist = await runElectrical(db, cl('show every failed inspection and the correction items'), { today: TODAY });
  check('history still lists the resolved failure', /Resolved test item/.test(JSON.stringify(hist.facts)));
});
{
  const { normalizeFields } = await import('../api/_lib/extractFields.js');
  const pk = await H.as('electrical', (db) => H.I.packForTenant(db));
  const rows = normalizeFields([{ key: 'inspection_type', value: 'Final', page_no: 1, confidence: 0.9 }, { key: 'inspection_type', value: 'Final Electrical Inspection', page_no: 1, confidence: 0.8 }, { key: 'inspection_result', value: 'Passed', page_no: 1, confidence: 0.9 }, { key: 'inspection_result', value: 'Pass', page_no: 1, confidence: 0.8 }], { pageCount: 1, today: TODAY, pack: pk }).fields ?? [];
  check('two wordings of the same stage and result are kept, not treated as a conflict', rows.some((x) => x.field_key === 'inspection_type') && rows.some((x) => x.field_key === 'inspection_result'), JSON.stringify(rows.map((x) => [x.field_key, x.value])));
}
check('"failed finals" means failed final inspections', cl('show me failed finals')?.stage === 'final');
check('open permits with an expiry/age filter go to the normal path', cl('which open permits expire in the next 30 days') === null && cl('open permits expiring soon') === null && cl('open permits older than 90 days') === null);
check('expired-or-expiring asks use the 60 day window', cl('which licenses have expired or are about to expire')?.withinDays === 60 && cl('which insurance policies expired in the last 30 days') === null);
check('stage counts go to the normal path', cl('how many final inspections do we have') === null && cl('how many rough-in inspections are on file') === null);
check('a plain "did it pass the code inspection" asks for the recorded result, not a code judgment', cl('Did 412 Elm Street pass the code inspection?')?.kind === 'inspection_result' && cl('Does 412 Elm Street meet code?')?.kind === 'decline');
check('a rating in the question is not a street number', cl('Which panels are 200 amp?') === null && cl('How many inspections did we fail?') === null);
check('a named person\'s licence goes to the normal path', cl("When does Mike's license expire?") === null && cl('When does my journeyman license expire?') === null);
await H.as('electrical', async (db) => {
  const th = await runElectrical(db, cl('When is the thermography test due?'), { today: TODAY });
  check('a named test type answers for that test only', /Thermography/.test(th.text) && !/Generator|Transfer/.test(th.text));
  const gn = await runElectrical(db, cl('Is the generator test overdue?'), { today: TODAY });
  check('generator test is not confused with an overdue transfer switch', /Generator/.test(gn.text) && !/Transfer/.test(gn.text) && /due /.test(gn.text));
});
check('"should have failed" is declined', cl('Should 88 Harmon Street have failed rough-in?')?.kind === 'decline');
await H.as('electrical', async (db) => {
  const ff = await runElectrical(db, cl('Show jobs that failed final'), { today: TODAY });
  check('failed final lists only failed finals', ff.text.startsWith('2 failed') && /Birchwood/.test(JSON.stringify(ff.facts)) && !/Juniper|Harmon/.test(JSON.stringify(ff.facts)));
  const od = await runElectrical(db, cl('Which tests are overdue?'), { today: TODAY });
  check('overdue tests lists only overdue ones', od.text.startsWith('1 test') && /Transfer/.test(JSON.stringify(od.facts)) && !/Generator/.test(JSON.stringify(od.facts)));
});
await H.as('electrical', async (db) => {
  const r = await runElectrical(db, cl('Is the permit for 5530 Warehouse Way still open?'), { today: TODAY });
  check('same site written with and without the city is one job (no false "which one")', !r.clarify);
});

/* 2d. a model-read date stored as printed text is still compared as a real date */
await H.addFixture('electrical', async (db) => {
  const doc = await db.createDocument({ original_filename: 'scan-license.pdf', document_type: 'contractor-license', sha256_hash: 'scan-lic-1', stage: 'mapped' });
  for (const [k, v] of [['license_number', 'ROC-777001'], ['license_holder', 'Scan Electric'], ['license_expiry', 'December 31, 2026']]) {
    const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v });
    await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id });
  }
});
await H.as('electrical', async (db) => {
  const r = await runElectrical(db, cl('When does our contractor license expire?'), { today: TODAY });
  check('a printed-text expiry date is read as a date, not "unreadable"', /December 31, 2026/.test(JSON.stringify(r.facts)) && !/unreadable/.test(JSON.stringify(r.facts)));
});
const extractFieldsSrc = fs.readFileSync(new URL('../api/_lib/extractFields.js', import.meta.url), 'utf8');
check('credential and test due keys are date fields for the model path', /_\(\?:date\|expiry\|due\)\$/.test(extractFieldsSrc));

/* 3. clarify when two jobs match; attention list */
await H.as('electrical', async (db) => {
  const r = await runElectrical(db, classifyElectrical('What is the permit number at Tempe?', {}), { today: TODAY });
  check('a place that fits two jobs is never guessed (no match -> model, or asks which)', r == null || r.clarify === true);
  const at = await electricalAttention(db, { today: TODAY, withinDays: 60 });
  const labels = at.items.map((i) => i.label).join(' | ');
  check('attention list: licence, expiring/expired insurance, bond, tests due', at.items.filter((i) => !/MC-1/.test(i.label)).length === 6 && /ROC-318244/.test(labels) && /GL-4410/.test(labels) && /WC-7712/.test(labels) && /SB-90311/.test(labels) && !/GL-5520/.test(labels), labels);
  check('an expired policy with a newer one from the same insurer carries a note', at.items.some((i) => /GL-4410/.test(i.label) && /newer policy/.test(i.note ?? '')) && !at.items.some((i) => /WC-7712/.test(i.label) && i.note));
  check('attention list is soonest first', at.items.every((x, i, arr) => i === 0 || arr[i - 1].days <= x.days));
});

/* 4. other industries: no lane, no electrical records, no electrical wording */
for (const ind of ['hvac', 'plumbing', 'property']) {
  const p = await H.as(ind, (db) => H.I.packForTenant(db));
  { const ln = await laneForPack(p); check(`${ind} has no electrical lane`, ln === null || (ind === 'plumbing' && ln.classify?.name !== 'classifyElectrical')); }
}
await H.addFixture('plumbing', async (db) => {
  const doc = await db.createDocument({ original_filename: 'pl-permit.pdf', document_type: 'permit', sha256_hash: 'plumbing-permit-1', stage: 'mapped' });
  const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: 'permit_number', value_raw: 'PL-26-9999' });
  await db.createExtraction({ document_id: doc.id, field_key: 'permit_number', value: 'PL-26-9999', source_facet_id: fa.id });
});
await H.as('electrical', async (db) => {
  const r = await runElectrical(db, classifyElectrical('Which permits are still open?', {}), { today: TODAY });
  check('company isolation: a plumbing permit never appears in the electrical company', !alltext(r).includes('PL-26-9999'));
  const c = await runElectrical(db, classifyElectrical('How many permits do we have?', {}), { today: TODAY });
  check('company isolation: counts only this company', c.text.startsWith(`${SITES.length} permit`));
});
await H.as('plumbing', async (db) => {
  const r = await runElectrical(db, classifyElectrical('How many permits do we have?', {}), { today: TODAY });
  check('company isolation: electrical records never appear in the plumbing company', r.text.startsWith('1 permit'));
});
await H.as('hvac', async (db) => {
  const r = await runElectrical(db, classifyElectrical('How many permits do we have?', {}), { today: TODAY });
  check('company isolation: electrical records never appear in the HVAC company', r.text.startsWith('0 permit'));
});
check('electrical wording is only in electrical pack', !JSON.stringify((await H.as('hvac', (db) => H.I.packForTenant(db))).documentTypes ?? []).includes('correction-notice'));

await H.addFixture('electrical', async (db) => {
  const doc = await db.createDocument({ original_filename: 'bare-card.pdf', document_type: 'inspection-report', sha256_hash: 'bare-card-1', stage: 'mapped' });
  for (const [k, v] of [['permit_number', 'EL-26-04040'], ['service_address', '404 Blank Street, Mesa AZ']]) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
});
await H.as('electrical', async (db) => {
  check('an inspection card with no readable result sends open/failed/result questions to the normal path', (await runElectrical(db, cl('Which permits are still open?'), { today: TODAY })) === null && (await runElectrical(db, cl('Which inspections failed?'), { today: TODAY })) === null && (await runElectrical(db, cl('Did 404 Blank Street pass final?'), { today: TODAY })) === null);
  check('questions about other things are still answered', (await runElectrical(db, cl('What is the permit number for 412 Elm Street?'), { today: TODAY }))?.text?.includes('EL-26-04412'));
});
await H.addFixture('electrical', async (db) => {
  for (const [fn, type, addr] of [['oak-permit.pdf', 'permit', '10 Oak Street, Mesa AZ'], ['oak-final.pdf', 'inspection-report', '10 Oak St., Mesa AZ 85201'], ['oak-panel.pdf', 'panel-schedule', '10 Oak St Mesa']]) {
    const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: `oak-${fn}`, stage: 'mapped' });
    const rows = [['permit_number', 'EL-26-01010'], ['service_address', addr], ...(type === 'inspection-report' ? [['inspection_type', 'Final'], ['inspection_result', 'Passed'], ['service_date', '2026-06-01']] : []), ...(type === 'panel-schedule' ? [['amperage', '200']] : [])];
    for (const [k, v] of rows) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
  }
});
await H.as('electrical', async (db) => {
  const a1 = await runElectrical(db, cl('What is the permit number for 10 Oak St?'), { today: TODAY });
  check('one job spelled three ways is one job (no dead-end "which one")', a1 && !a1.clarify && /EL-26-01010/.test(a1.text), a1?.text);
  const a2 = await runElectrical(db, cl('Is the permit at 10 Oak Street still open?'), { today: TODAY });
  check('the final card spelled "St." closes the permit spelled "Street"', a2 && /has a passed final/.test(a2.text), a2?.text);
  check('a city alone is not a job', (await runElectrical(db, cl('Which permits are open in Mesa?'), { today: TODAY })) === null);
});
{
  const t = extractElectrical([{ page_no: 1, text: 'INSPECTION REPORT\nPermit No: EL-9\nType: Residential\nInspection Type: Final\nResult: Passed\nDate of Inspection: 04/05/2026\nSite Address: 1 A St' }]);
  check('a bare Type line (Residential) does not replace the inspection type', t.fields.find((x) => x.key === 'inspection_type')?.value === 'Final');
}
await H.addFixture('electrical', async (db) => {
  for (const [fn, addr, res] of [['ste100.pdf', '700 Dock Way Suite 100, Mesa AZ', 'Failed'], ['ste200.pdf', '700 Dock Way, Suite 200, Mesa AZ', 'Passed']]) {
    const doc = await db.createDocument({ original_filename: fn, document_type: 'inspection-report', sha256_hash: `ste-${fn}`, stage: 'mapped' });
    for (const [k, v] of [['service_address', addr], ['inspection_type', 'Final'], ['inspection_result', res], ['service_date', '2026-09-10']]) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
  }
});
await H.as('electrical', async (db) => {
  const r = await runElectrical(db, cl('did the final inspection at 700 Dock Way pass'), { today: TODAY });
  check('two suites at one building are two jobs: ask which one', r?.clarify === true, r?.text);
});
await H.addFixture('electrical', async (db) => {
  for (const [fn, type, extra] of [['re-a.pdf', 'inspection-report', [['inspection_type', 'Final'], ['inspection_result', 'Failed'], ['service_date', '2026-10-01']]], ['re-b.pdf', 'inspection-report', [['inspection_type', 'Re-inspection'], ['inspection_result', 'Passed'], ['service_date', '2026-10-03']]], ['re-c.pdf', 'correction-notice', [['inspection_type', 'Final'], ['service_date', '2026-10-04']]]]) {
    const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: `re-${fn}`, stage: 'mapped' });
    for (const [k, v] of [['permit_number', 'EL-26-01212'], ['service_address', '12 Reinspect Lane, Mesa AZ'], ...extra]) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
  }
});
await H.as('electrical', async (db) => {
  check('a stage-less re-inspection card sends result/open/failed questions to the normal path', (await runElectrical(db, cl('Did 12 Reinspect Lane pass final inspection?'), { today: TODAY })) === null && (await runElectrical(db, cl('Which permits are still open?'), { today: TODAY })) === null);
});
await H.addFixture('electrical', async (db) => {
  for (const [fn, ty, res, dt] of [['st-a.pdf', 'Rough-in', 'Failed', '2026-03-01'], ['st-b.pdf', 'Service', 'Passed', '2026-04-01']]) {
    const doc = await db.createDocument({ original_filename: fn, document_type: 'inspection-report', sha256_hash: `st-${fn}`, stage: 'mapped' });
    for (const [k, v] of [['permit_number', 'EL-26-01313'], ['service_address', '13 Stage Court, Mesa AZ'], ['inspection_type', ty], ['inspection_result', res], ['service_date', dt]]) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
  }
});
check('"unresolved" is a filter word, not a place', !cl('which failed inspections are still unresolved')?.place?.includes('unresolved'));
const isFinalProbe = (t) => (cl(`Did 1 A St pass ${t}?`)?.stage ?? null) === 'final';
check('a temporary power final is not a final', !isFinalProbe('Temporary Power Final') && isFinalProbe('Final') && isFinalProbe('Final Electrical Inspection') && !isFinalProbe('Pre-Final'));
await H.addFixture('electrical', async (db) => {
  for (const [fn, type, rows] of [['n-a.pdf', 'inspection-report', [['inspection_type', 'Rough-in'], ['inspection_result', 'Failed'], ['service_date', '2026-04-01']]], ['n-b.pdf', 'inspection-report', [['inspection_type', 'Rough-in'], ['inspection_result', 'Passed'], ['service_date', '2026-04-05']]], ['n-c.pdf', 'correction-notice', [['inspection_type', 'Final'], ['service_date', '2026-05-01'], ['correction_items', 'Label panel']]]]) {
    const doc = await db.createDocument({ original_filename: fn, document_type: type, sha256_hash: `n-${fn}`, stage: 'mapped' });
    for (const [k, v] of [['permit_number', 'EL-26-01414'], ['service_address', '14 Notice Road, Mesa AZ'], ...rows]) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
  }
});
{
  const { runElectrical: run2 } = await import('../api/_lib/industry/electrical/lane.js');
  const lanes = await H.as('electrical', (db) => run2(db, { kind: 'count_type', type: 'inspection-report', failed: true }, { today: TODAY }));
  check('a final correction notice is counted even when an earlier rough-in failed at the same permit', Boolean(lanes) && JSON.stringify(lanes.facts).includes('n-c.pdf'));
}
await H.addFixture('electrical', async (db) => {
  for (const [fn, pn, res, dt] of [['mp-a.pdf', 'EL-26-01501', 'Passed', '2026-05-01'], ['mp-b.pdf', 'EL-26-01502', 'Failed', '2026-04-01']]) {
    const doc = await db.createDocument({ original_filename: fn, document_type: 'inspection-report', sha256_hash: `mp-${fn}`, stage: 'mapped' });
    for (const [k, v] of [['permit_number', pn], ['service_address', '15 Multi Street, Mesa AZ'], ['inspection_type', 'Final'], ['inspection_result', res], ['service_date', dt]]) { const fa = await db.createFacet({ document_id: doc.id, page_no: 1, label_raw: k, value_raw: v }); await db.createExtraction({ document_id: doc.id, field_key: k, value: v, source_facet_id: fa.id }); }
  }
});
await H.as('electrical', async (db) => {
  check('two permits at one address never get one headline result', (await runElectrical(db, cl('Did 15 Multi Street pass final?'), { today: TODAY })) === null);
});
const askSrc = fs.readFileSync(new URL('../api/ask.js', import.meta.url), 'utf8');
check('ask.js runs the lane only for a non-HVAC company with no follow-up context', /pack\?\.id && pack\.id !== "hvac" && !conversationContext/.test(askSrc) && /laneForPack\(pack\)/.test(askSrc));
console.log('');
if (failures) { console.log(`${failures} check(s) FAILED (${passes} passed).`); process.exit(1); }
console.log(`${passes} checks passed.`);
process.exit(0);
