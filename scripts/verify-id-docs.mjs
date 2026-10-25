// ID-document round: driver licence / CDL, DOT medical examiner's certificate, new-hire sheet. SYNTHETIC look-alike text only
// (invented names and numbers): the real documents are never copied here.  Run: node scripts/verify-id-docs.mjs [tree]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPipeline, runDoc } from './real-docs/pipeline.mjs';
const P = await loadPipeline(process.argv[2] || '.');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]); } };
const doc = (text, filename = 'scan.pdf') => ({ filename, pages: [{ page_no: 1, text }] });
const val = (r, k) => r.fields.find((f) => f.field_key === k)?.value;

const CARD = ['DRIVER LICENSE', 'STATE OF EXAMPLEVILLE', 'DLN', 'D12345678', 'CLASS', 'A', 'DOB 01/02/1980', 'ISS 03/15/2022', '4b EXP 03/15/2030', 'Name', 'Tester, Alex Q'].join('\n');
const CARD_INLINE = ['COMMERCIAL DRIVER LICENSE', 'DLN: D12345678   CLASS: B', 'ISS 03/15/2022   EXP 03/15/2030'].join('\n');
const MEC = ["Medical Examiner's Certificate", "Driver's Name", 'Jordan Tester', "Driver's License Number", 'X1234567', 'State of Issuance', 'ZZ',
  "Medical Examiner's Name", 'Pat Sampleton, MD', 'Date of Examination 05/05/2024', "Medical Examiner's Certificate Expiration Date 05/05/2026"].join('\n');
const MEC_REDACTED = ["Medical Examiner's Certificate", "Driver's License Number", '██████████', 'State of Issuance', 'ZZ', "Medical Examiner's Name", 'Pat Sampleton, MD',
  "Medical Examiner's Certificate Expiration Date", '05/05/2026'].join('\n');
const HR = ['New Hire Checklist', 'Employee Name', 'Casey Example', 'Position', 'Field Technician', 'Start Date 06/03/2025', 'Rate of Pay $27.50/hr', 'Supervisor', 'Dana Sample'].join('\n');
const TRADE = ['Plumbing License', 'State Board of Examples', 'License No: JP-860244   Expires: 2027-08-30', 'Holder: Chloe Sampleton'].join('\n');
const INVOICE = ['INVOICE', 'Invoice #: INV-1001', 'Customer: Test Customer LLC', 'Date of Service: 03/04/2025', 'Class A service', 'Total Due: $120.00'].join('\n');

t('card: type', () => assert.equal(runDoc(P, doc(CARD)).type, 'license-certification'));
t('card: number', () => assert.equal(val(runDoc(P, doc(CARD)), 'license_number'), 'D12345678'));
t('card: class (value on next line)', () => assert.equal(val(runDoc(P, doc(CARD)), 'license_class'), 'A'));
t('card: issue + expiry', () => { const r = runDoc(P, doc(CARD)); assert.equal(val(r, 'start_date'), '2022-03-15'); assert.equal(val(r, 'end_date'), '2030-03-15'); });
t('card: holder (name on next line)', () => assert.match(String(val(runDoc(P, doc(CARD)), 'holder_name')), /Alex Q Tester/));
t('card inline: number, class, dates', () => { const r = runDoc(P, doc(CARD_INLINE)); assert.equal(r.type, 'license-certification'); assert.equal(val(r, 'license_number'), 'D12345678'); assert.equal(val(r, 'license_class'), 'B'); assert.equal(val(r, 'end_date'), '2030-03-15'); });
t('mec: type', () => assert.equal(runDoc(P, doc(MEC)).type, 'license-certification'));
t('mec: holder, number', () => { const r = runDoc(P, doc(MEC)); assert.equal(val(r, 'holder_name'), 'Jordan Tester'); assert.equal(val(r, 'license_number'), 'X1234567'); });
t('mec: long label expiry (no colon, same line)', () => assert.equal(val(runDoc(P, doc(MEC)), 'end_date'), '2026-05-05'));
t('mec: exam date + examiner', () => { const r = runDoc(P, doc(MEC)); assert.equal(val(r, 'start_date'), '2024-05-05'); assert.equal(val(r, 'issued_by'), 'Pat Sampleton, MD'); });
t('mec redacted: number absent (no field), expiry on next line read', () => { const r = runDoc(P, doc(MEC_REDACTED)); assert.equal(val(r, 'license_number'), undefined); assert.equal(val(r, 'end_date'), '2026-05-05'); assert.equal(r.type, 'license-certification'); });
t('hr: type + fields', () => {
  const r = runDoc(P, doc(HR)); assert.equal(r.type, 'hr-letter');
  assert.equal(val(r, 'employee_name'), 'Casey Example'); assert.equal(val(r, 'position'), 'Field Technician');
  assert.equal(val(r, 'start_date'), '2025-06-03'); assert.equal(val(r, 'pay_rate'), '$27.50/hr'); assert.equal(val(r, 'manager'), 'Dana Sample');
});
t('hr: start date is not a service date', () => assert.equal(val(runDoc(P, doc(HR)), 'service_date'), undefined));
t('trade licence still reads inline', () => { const r = runDoc(P, doc(TRADE)); assert.equal(r.type, 'license-certification'); assert.equal(val(r, 'license_number'), 'JP-860244'); assert.equal(val(r, 'end_date'), '2027-08-30'); });
t('two different expiry dates: none captured', () => assert.equal(val(runDoc(P, doc(CARD + '\nMedical card EXP 01/01/2027')), 'end_date'), undefined));
t('invoice untouched: type, no id keys', () => { const r = runDoc(P, doc(INVOICE)); assert.equal(r.type, 'invoice'); assert.equal(val(r, 'license_class'), undefined); assert.equal(val(r, 'holder_name'), undefined); });
t('filename anchors', () => { assert.equal(P.dt.inferTypeFromFilename('CDL scan.pdf'), 'license-certification'); assert.equal(P.dt.inferTypeFromFilename('New Hire Onboarding.pdf'), 'hr-letter'); assert.equal(P.dt.inferTypeFromFilename('Medical Examiner Certificate.pdf'), 'license-certification'); });
t('classifyFromText anchors', () => {
  assert.equal(P.te.classifyFromText([{ page_no: 1, text: MEC }])?.type, 'license-certification');
  assert.equal(P.te.classifyFromText([{ page_no: 1, text: 'Employee Onboarding Checklist\nName' }])?.type, 'hr-letter');
  assert.equal(P.te.classifyFromText([{ page_no: 1, text: 'NOTICE\nPlease see the class schedule' }]), null);
});

// ---- Donovan reader-v2 (switch DONOVAN_READER_V2_IDDOCS, default OFF): synthetic company, invented people
{
  const rv = await import(new URL('../api/_lib/dql/reader-v2/index.js', import.meta.url).href);
  const R = await rv.loadReaderV2();
  const ID = await import(new URL('../api/_lib/dql/reader-v2/iddocs.js', import.meta.url).href);
  const mk = (id, type, text, fields) => ({ doc: { id, document_type: type, created_at: '2026-01-05T00:00:00.000Z' }, page: { document_id: id, page_no: 1, text }, ex: Object.entries(fields).map(([k, v]) => ({ document_id: id, entity_id: null, field_key: k, value: v })) });
  const parts = [
    mk('d1', 'license-certification', "DRIVER LICENSE\nDLN\nD12345678\nCLASS\nA", { holder_name: 'Alex Tester', license_number: 'D12345678', license_class: 'A', end_date: '2030-03-15' }),
    mk('d2', 'license-certification', "Medical Examiner's Certificate\nDriver's Name\nAlex Tester", { holder_name: 'Alex Tester', end_date: '2026-05-05', start_date: '2024-05-05', issued_by: 'Pat Sampleton, MD' }),
    mk('d3', 'hr-letter', 'New Hire Checklist\nEmployee Name\nCasey Example', { employee_name: 'Casey Example', start_date: '2025-06-03', pay_rate: '$27.50/hr', manager: 'Dana Sample', position: 'Field Technician' }),
    mk('d4', 'invoice', 'INVOICE\nInvoice #: INV-1001\nTotal Due: $120.00', { invoice_number: 'INV-1001', cost: '120.00' }),
  ];
  const rec = { tenantName: 'organization', exportedAt: '2026-10-25T00:00:00.000Z', documents: parts.map((x) => x.doc), pages: parts.map((x) => x.page), extractions: parts.flatMap((x) => x.ex), entities: [], document_entity_links: [], financials: [], financial_lines: [] };
  const ix = rv.buildIndex(rec, 'idtest');
  const ask = async (q) => (await R.answer(ix, q));
  const qs = [['When does Alex Tester\'s license expire?', /March 15, 2030/], ['When does Alex Tester\'s medical card expire?', /May 5, 2026/], ["What is Alex Tester's license number?", /on file[^.]*ending in 5678/], ["What class is Alex Tester's CDL?", /class A/],
    ['Who is the medical examiner for Alex Tester?', /Pat Sampleton/]];
  const run = async (on) => {
    if (on) process.env.DONOVAN_READER_V2_IDDOCS = '1'; else delete process.env.DONOVAN_READER_V2_IDDOCS;
    ID.configureIdDocs(); const out = [];
    for (const [q] of qs) out.push(await ask(q));
    const other = [await ask("When does Jamie Nobody's license expire?"), await ask('What is the total due on invoice INV-1001?')];
    return { out, other };
  };
  const off = await run(false);
  t('reader OFF: iddocs never answers', () => off.out.forEach((r) => assert.notEqual(r.reason, 'iddocs')));
  const on = await run(true);
  t('reader ON: a licence number is never shown in full', () => assert.doesNotMatch(on.out[2].text, /D12345678/));
  qs.forEach(([q, re], i) => t('reader ON: ' + q, () => { assert.equal(on.out[i].reason, 'iddocs'); assert.match(on.out[i].text, re); }));
  t('reader ON: an unknown person is not answered from someone else\'s paper', () => assert.notEqual(on.other[0].reason, 'iddocs'));
  t('reader ON: other questions unchanged', () => assert.equal(on.other[1].text, off.other[1].text));
  delete process.env.DONOVAN_READER_V2_IDDOCS; ID.configureIdDocs();
}
// ---- people lane (api/_lib/people/peopleLane.js): the pure answer core, synthetic papers only
{
  const { answerPeople, readQuestion } = await import('../api/_lib/people/peopleLane.js');
  const mk = (id, type, text, fields = {}) => ({ id, type, fields, pages: [{ page_no: 1, text }] });
  const CDLP = mk('c1', 'license-certification', 'COMMERCIAL DRIVER LICENSE\nDLN: D99887766   CLASS: A\nISS 03/15/2022   EXP 03/15/2030', { holder_name: 'Maria Lopez Santos', license_number: 'D99887766', license_class: 'A', start_date: '2022-03-15', end_date: '2030-03-15' });
  const MECP = mk('m1', 'license-certification', "Medical Examiner's Certificate\nForm MCSA-5876", { holder_name: 'Maria L Santos', start_date: '2025-01-10', end_date: '2025-07-10', issued_by: 'Dr. Pat Doe' });
  const NH = mk('h1', 'hr-letter', 'Acme Co - New Hire Information Sheet\nFULL NAME   PHONE\n Lee Kim   (602) 555-0100\nPOSITION   DEPARTMENT   START DATE\n Installer   Field   09/01/2026\nREPORTS TO / MANAGER   HOURLY RATE   SHIRT SIZE\n Sam Ortiz   $31.00   M');
  const SAM = mk('h2', 'hr-letter', 'Acme Co - New Hire Information Sheet\nFULL NAME   PHONE\n Sam Ortiz   (602) 555-0111\nPOSITION   DEPARTMENT   START DATE\n Lead   Field   01/05/2024\nREPORTS TO / MANAGER   HOURLY RATE   SHIRT SIZE\n Dana Cruz   $40.00   L');
  const D = [CDLP, MECP, NH, SAM];
  const A = (q, o = {}) => answerPeople(D, q, { today: '2026-10-25', canHr: true, ...o });
  t('people: CDL expiry by first + last name', () => assert.match(A("When does Maria Lopez's CDL expire?").text, /March 15, 2030/));
  t('people: initial-tolerant ("M. Santos"), lowercase', () => assert.match(A("when does m. santos cdl expire").text, /March 15, 2030/));
  t('people: medical card picks the medical paper, not the CDL', () => assert.match(A("When does Maria Santos' medical card expire?").text, /July 10, 2025/));
  t('people: medical card past expiry is NOT current', () => assert.match(A("Is Maria Santos's medical card current?").text, /^No\./));
  t('people: CDL is current', () => assert.match(A("Is Maria Lopez's CDL current?").text, /^Yes\./));
  t('people: start date comes from the new-hire sheet, never a licence issue date', () => { assert.match(A("What is Lee Kim's start date?").text, /September 1, 2026/); assert.equal(A("What is Maria Santos's start date?"), null); });
  t('people: manager / position / pay', () => { assert.match(A("Who is Lee Kim's manager?").text, /Sam Ortiz/); assert.match(A("What position is Lee Kim in?").text, /Installer/); assert.match(A("What is Lee Kim's hourly rate?").text, /\$31\.00/); });
  t('people: first name alone, unique -> answered; shared surname part -> not guessed', () => { assert.match(A("Who is Lee's manager?").text, /Sam Ortiz/); assert.equal(A("when does Smith's CDL expire?"), null); });
  t('people: a person who is not on file is not answered from someone else', () => assert.equal(A("When does Maria Garcia's CDL expire?"), null));
  t('people: licence number -> on file + last 4 only', () => { const r = A("What is Maria Lopez's CDL number?"); assert.match(r.text, /ending in 7766/); assert.doesNotMatch(r.text, /D99887766/); });
  t('people: SSN / birth date / bank / VIN asks are never read out', () => ['What is Lee Kim\'s SSN?', "What is Maria Lopez's date of birth?", "What is Lee Kim's routing number?", "What is the VIN on Maria Lopez's registration?"].forEach((q) => assert.equal(A(q), null)));
  t('people: HR papers only for a caller who may open People and HR', () => { assert.equal(A("Who is Lee Kim's manager?", { canHr: false }), null); assert.match(A("When does Maria Lopez's CDL expire?", { canHr: false }).text, /2030/); });
  t('people: two facts in one question -> not ours', () => assert.equal(readQuestion("When does Maria's CDL expire and what class is it?") && A("When does Maria Lopez's CDL expire and what class is it?"), null));
  t('people: renewed card -> the latest expiry', () => { const OLD = mk('m0', 'license-certification', "Medical Examiner's Certificate\nForm MCSA-5876", { holder_name: 'Maria L Santos', start_date: '2024-01-10', end_date: '2024-07-10' }); const r = answerPeople([...D, OLD], "When does Maria Santos' medical card expire?", { today: '2026-10-25', canHr: true }); assert.match(r.text, /July 10, 2025/); });
}

// ---- verifier round (planted false types / wrong values), invented text only
const typeOf = (txt) => runDoc(P, doc(txt)).type;
t('memo mentioning a licence is not an ID paper', () => assert.notEqual(typeOf("Fleet Safety Memo\nAll drivers must hold a valid driver's license at all times.\nEffective 01/01/2026, reviewed 06/30/2026"), 'license-certification'));
t('memo mentioning the examiner certificate is not an ID paper', () => assert.notEqual(typeOf("Fleet Safety Memo\nEvery CDL driver must carry a Medical Examiner's Certificate (MCSA-5876)\nReviewed 06/30/2026"), 'license-certification'));
t('clinic bill is not an ID paper', () => assert.notEqual(typeOf("Desert Clinic\nPatient visit 03/04/2025\nMedical Examiner's Certificate issued $85.00\nTotal Due: $85.00"), 'license-certification'));
const EXAM_NO = ["Medical Examiner's Certificate", "Driver's Name", 'Jordan Tester', "Medical Examiner's License or Certificate No.", 'ME-445566', "Medical Examiner's Name", 'Pat Sampleton, MD', "Medical Examiner's Certificate Expiration Date 05/05/2026"].join('\n');
t("examiner's number is never the driver's number", () => assert.equal(val(runDoc(P, doc(EXAM_NO)), 'license_number'), undefined));
t('blank holder name does not take a city', () => assert.equal(val(runDoc(P, doc(["Medical Examiner's Certificate", "Driver's Name", 'Mesa, AZ', "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', "Medical Examiner's Certificate Expiration Date 05/05/2026"].join('\n'))), 'holder_name'), undefined));
t('"Name of Business ..." is not a holder', () => assert.equal(val(runDoc(P, doc(['Plumbing License', 'Name of Business Mesa Cool Air', 'License No: JP-860244   Expires: 2027-08-30'].join('\n'))), 'holder_name'), undefined));
t('I-9 heading is not an employee name', () => assert.notEqual(val(runDoc(P, doc(['Employment Eligibility Verification', 'Section 1. Employee Information and Attestation', 'Last Name   First Name'].join('\n'), 'i9.pdf')), 'employee_name'), 'Information and Attestation'));
t('OMB expiry on its own line is not the holder expiry', () => assert.equal(val(runDoc(P, doc(["Medical Examiner's Certificate", "Driver's Name", 'Jordan Tester', 'OMB No. 2126-0006', 'Expiration Date: 12/31/2027', "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024'].join('\n'))), 'end_date'), undefined));
const { answerPeople } = await import(new URL('../api/_lib/people/peopleLane.js', import.meta.url).href);
const mk = (text, filename) => { const r = runDoc(P, doc(text, filename)); const f = {}; for (const x of r.fields) f[x.field_key] = x.value; return { id: filename, type: r.type, filename, fields: f, pages: [{ page_no: 1, text }] }; };
const CDL = mk(CARD_INLINE + '\nName: Alex Tester', 'cdl.pdf');
const HIRE = mk(HR.replace('Casey Example', 'Alex Tester'), 'hire.pdf');
const ask = (docs, q) => answerPeople(docs, q, { today: '2026-10-25', canHr: true });
for (const q of ['When does the lease start?', 'When does the service agreement start?', 'When does our contractor license expire?', 'When does our plumbing license expire?', "When does Alex Tester's medical card expire?", "when does marta tester's license expire"]) t('no wrong answer: ' + q, () => assert.equal(ask([CDL, HIRE], q), null));
t('good: licence expiry for the named holder', () => assert.match(ask([CDL, HIRE], "When does Alex Tester's CDL expire?")?.text ?? '', /2030|March/));
t('good: start date for the named hire', () => assert.match(ask([CDL, HIRE], "What is Alex Tester's start date?")?.text ?? '', /2025|June/));
const CDL2 = mk(CARD_INLINE.replace('2030', '2031') + '\nName: Alex Tester', 'cdl2.pdf');
const MEC2 = mk(MEC.replace('Jordan Tester', 'Alex Tester'), 'mec.pdf');
const MEC3 = mk(MEC.replace('Jordan Tester', 'Alex Tester').replace('05/05/2026', '06/06/2027'), 'mec3.pdf');
t('medical card wording reads the examiner paper only', () => assert.match(ask([CDL, MEC2], "When does Alex Tester's medical card expire?")?.text ?? '', /2026|May/));
t('two papers disagree on a start date: abstain', () => { const H2 = mk(HR.replace('Casey Example', 'Alex Tester').replace('06/03/2025', '07/07/2025'), 'hire2.pdf'); assert.equal(ask([HIRE, H2], "What is Alex Tester's start date?"), null); });
t('two medical papers: the later expiry is used', () => assert.match(ask([MEC2, MEC3], "When does Alex Tester's medical card expire?")?.text ?? '', /2027|June/));

// ---- round 3 (people / ID lane): structure, not word lists. Invented text only.
{
  const PS = await import(new URL('../api/_lib/modelAvoidance/peopleShape.js', import.meta.url).href);
  const PL = await import(new URL('../api/_lib/people/peopleLane.js', import.meta.url).href);
  // 1. name-value shape: a holder / employee value must look like a person's name
  for (const bad of ['see attached', 'Mesa AZ', 'Mesa, AZ', 'MESA AZ', 'Phoenix, Arizona', 'must be on file', 'must be printed in ink', 'Must Be Printed In Ink', 'bonus program', 'Orientation Agenda', 'Pending Background Results', 'Awaiting Clearance', 'Sidewinder Equipment Rental', 'Name Withheld At Request', 'N/A', 'Information and Attestation', 'to be determined', 'Fountain Hills', 'Sun City West', 'Q', 'Alex', 'A B C D E', 'Alex Tester 123', 'same as above'])
    t('name shape rejects: ' + bad, () => assert.equal(PS.nameShape(bad).ok, false));
  for (const good of ['Casey Example', 'Alex Q Tester', 'Ulises A. Larkspur', 'ZELDA D PENHALLOW', 'PENHALLOW, ZELDA D', "Mary-Jane O'Brien", 'MONDRAGon, LEONA A', 'Konkwo-Reyes, Bettina J', 'Ana de la Cruz', 'Alex Tester Jr'])
    t('name shape accepts: ' + good, () => assert.equal(PS.nameShape(good).ok, true));
  t('name shape: a fragment of the page title is not a name', () => assert.equal(PS.nameShape('Safety Rules', { titleLines: ['Employee Safety Rules'] }).ok, false));
  t('name shape: examiner credentials and title are kept', () => { assert.equal(PS.nameShape('Pat Sampleton, MD', { kind: 'examiner' }).value, 'Pat Sampleton, MD'); assert.equal(PS.nameShape('Dr. Pat Doe', { kind: 'examiner' }).ok, true); assert.equal(PS.nameShape('Dr. Pat Doe').value, 'Pat Doe'); });
  // 2. form-control block: OMB / form number / revision / Expires, wrapped over 1-4 lines, never a date
  const MECB = (ctl, tail = []) => ["Medical Examiner's Certificate", ...ctl, "Driver's Name", 'Jordan Tester', "Driver's License Number", 'X1234567', 'Date of Examination 05/05/2024', ...tail].join('\n');
  for (const [name, ctl] of [['1 line', ['OMB No. 2126-0006 Expires 12/31/2027']], ['2 lines', ['OMB No. 2126-0006', 'Expiration Date: 12/31/2027']], ['3 lines', ['OMB No.', '2126-0006', 'Expires: 12/31/2027']], ['4 lines', ['OMB No.', '2126-0006', 'Expires:', '12/31/2027']], ['label split', ['OMB No. 2126-0006', 'Expiration', 'Date:', '12/31/2027']], ['rev line', ['Form MCSA-5876 (Rev. 6-2015)', 'Expiration Date', '12/31/2027']], ['approved', ['FORM APPROVED', 'OMB NO. 2126-0006', 'EXPIRES: 12/31/2027']]])
    for (const [pos, build] of [['top', (c) => MECB([], []).replace("Medical Examiner's Certificate", c.concat(["Medical Examiner's Certificate"]).join('\n'))], ['after title', (c) => MECB(c)], ['bottom', (c) => MECB([], c)]])
      t(`control block (${name}, ${pos}) is never a date`, () => { const r = runDoc(P, doc(build(ctl))); for (const f of r.fields) assert.notEqual(String(f.value).slice(0, 10), '2027-12-31', f.field_key); });
  t('control block next to a real expiry: the real one is read', () => assert.equal(val(runDoc(P, doc(MECB(['OMB No.', '2126-0006', 'Expires:', '12/31/2027'], ["Medical Examiner's Certificate Expiration Date 05/05/2026"]))), 'end_date'), '2026-05-05'));
  t('formControlMask: wrapped block is masked, a holder expiry is not', () => { const m = PS.formControlMask(['OMB No.', '2126-0006', 'Expires:', '12/31/2027', "Medical Examiner's Certificate Expiration Date 05/05/2026"]); assert.deepEqual(m, [true, true, true, true, false]); });
  // 3. HR guard: an employee is never a customer, a start date is never a service date
  const HRI = ['New Hire Information Sheet', 'Employee Name: Casey Example', 'Phone: (480) 555-0100', 'Email: casey@example.test', 'Start Date: 06/03/2025', 'Position: Installer', 'Customer Name   Casey Example', 'Date of Service: 06/03/2025'].join('\n');
  t('hr inline sheet: no customer_* / service_*; start date is the HR start date', () => { const r = runDoc(P, doc(HRI)); assert.equal(r.type, 'hr-letter'); assert.deepEqual(r.fields.map((f) => f.field_key).filter((k) => /^(?:customer_|service_)/.test(k)), []); assert.equal(val(r, 'start_date'), '2025-06-03'); assert.equal(val(r, 'employee_name'), 'Casey Example'); });
  t('licence paper: no customer_* / service_*', () => { const r = runDoc(P, doc(TRADE + '\nCustomer: Chloe Sampleton\nDate of Service: 03/04/2025')); assert.deepEqual(r.fields.map((f) => f.field_key).filter((k) => /^(?:customer_|service_)/.test(k)), []); });
  t('dropPeopleIdFacts: HR and licence lose customer_* / service_*, an invoice does not, a person-entered value stays', () => {
    const rows = [{ field_key: 'customer_name', value: 'A B' }, { field_key: 'service_date', value: '2025-01-01' }, { field_key: 'employee_name', value: 'A B' }, { field_key: 'customer_phone', value: '1', corrected_value: '2' }];
    assert.deepEqual(PS.dropPeopleIdFacts('hr-letter', rows).fields.map((f) => f.field_key), ['employee_name', 'customer_phone']);
    assert.equal(PS.dropPeopleIdFacts('license-certification', rows).fields.length, 2);
    assert.equal(PS.dropPeopleIdFacts('invoice', rows).fields.length, 4);
  });
  t('plan label fill never targets customer_* / service_* on an HR paper', () => { const pl = P.lf.planLabelFill({ type: 'hr-letter', fields: [], pages: [{ page_no: 1, text: HRI }], allKeys: true, ownNames: [] }); assert.deepEqual(pl.add.map((f) => f.field_key).filter((k) => /^(?:customer_|service_)/.test(k)), []); });
  // 4. typing by structure: a heading that names the paper inside a policy / checklist is not the paper
  for (const [name, txt] of [
    ['bare examiner heading in a policy', "Driver Safety Policy\nAll drivers must keep paperwork current.\nMedical Examiner's Certificate\nRecords are kept in the personnel file."],
    ['bare examiner heading, untitled page', "Records are kept in the personnel file.\nMedical Examiner's Certificate\nQuestions? Call the office."],
    ['bare examiner heading in a checklist', "Annual Compliance Checklist\n[ ] Safety training\nMedical Examiner's Certificate\nVerify before dispatch"],
    ['bare driver licence heading', 'Hiring Policy\nDriver License\nBring it on day one and we will copy it.'],
    ['bare CDL line', 'Dispatch Notes\nCDL\nAssign loads by class.'],
    ['bare medical card line', 'Fleet Memo\nMedical Card\nKeep it in the cab.'],
    ['new-hire bonus flyer with labels', 'New hire bonus program\nPosition: Installer\nStart Date: next month\nManager: see your lead\nSalary: competitive\nApply at the front desk.'],
    ['new-hire agenda with labels', 'New Hire Orientation Agenda\nPosition: Installer\nStart Date: 06/03/2025\nManager: Dana Sample\nSalary: see HR'],
  ]) t('not an ID / HR paper: ' + name, () => assert.ok(!['license-certification', 'hr-letter'].includes(typeOf(txt)), typeOf(txt)));
  t('the real certificate, card and sheet are still typed', () => { assert.equal(typeOf(MEC), 'license-certification'); assert.equal(typeOf(CARD), 'license-certification'); assert.equal(typeOf(HR), 'hr-letter'); assert.equal(typeOf(TRADE), 'license-certification'); });
  t('a permit with a licence-number row is not a licence (upload and Re-check)', () => {
    const permit = ['City of Aurora Building Division', 'ELECTRICAL PERMIT', 'Permit No.   ELC25-65990   Date Issued   3 Jan 2026', 'Expires   2 Jul 2026', 'License #   CO EC-218745   Owner   Verde Apartments LLC'].join('\n');
    assert.notEqual(typeOf(permit), 'license-certification');
    for (const cur of ['permit', 'other', 'inspection-report']) assert.notEqual(P.rs.retypeDecision({ currentType: cur, filename: 'p.pdf', pages: [{ page_no: 1, text: permit }], fields: [] })?.to, 'license-certification');
  });
  { const ID = await import(new URL('../api/_lib/modelAvoidance/idDocFields.js', import.meta.url).href);
    t('id reader alone: a wrapped OMB block is no end_date', () => assert.equal(ID.scanIdDocFacts([{ page_no: 1, text: MECB(['OMB No.', '2126-0006', 'Expires:', '12/31/2027']) }], { type: 'license-certification' }).candidates.end_date, undefined));
    t('label fill alone: an OMB block on a permit is no end_date', () => { const pl = P.lf.planLabelFill({ type: 'permit', fields: [], pages: [{ page_no: 1, text: 'MECHANICAL PERMIT\nPermit No. MP-4411\nSite Address 12 Palo Dr\nOMB No.\n2126-0006\nExpires:\n12/31/2027' }], ownNames: [] }); assert.equal(pl.add.find((f) => f.field_key === 'end_date'), undefined); });
    t('ingest (extractDocument.js) drops customer_* / service_* on HR and ID papers', () => { const src = fs.readFileSync(new URL('../api/_lib/extractDocument.js', import.meta.url), 'utf8'); assert.match(src, /fields = dropPeopleIdFacts\(resolvedType, fields\)\.fields/); });
  }
  for (const bad of ['Alex TESTER', 'Alex tester', 'alex tester', 'Alex Tester,']) t('name shape: case pattern rejects ' + bad, () => assert.equal(PS.nameShape(bad).ok, bad === 'Alex Tester,'));
  for (const bad of ['Alex Of Tester', 'Alex And Tester', 'Pat Is Here']) t('name shape: a closed-class word is never in a name: ' + bad, () => assert.equal(PS.nameShape(bad).ok, false));
  t('a permit titled with the word licence is still a permit', () => { const txt = ['Aurora Building Division', 'Electrical Permit License', 'License No: ELC-4411', 'Issued 3 Jan 2026'].join('\n'); assert.notEqual(P.rs.retypeDecision({ currentType: 'other', filename: 'p.pdf', pages: [{ page_no: 1, text: txt }], fields: [] })?.to, 'license-certification'); });
  t('new-hire anchor needs its labels (one label is not a sheet)', () => assert.ok(typeOf('Acme - New Hire Intake Record\nPosition: Installer\nNotes: call HR\nThanks for reading.') !== 'hr-letter'));
  t('a label row with a licence number is not a title (Re-check)', () => { const txt = ['Site Visit Summary', 'City of Aurora Building Division', 'License #   CO EC-218745   Owner   Verde Apartments LLC', 'Notes   crew on site'].join('\n'); for (const cur of ['other', 'inspection-report', 'permit']) assert.notEqual(P.rs.retypeDecision({ currentType: cur, filename: 'v.pdf', pages: [{ page_no: 1, text: txt }], fields: [] })?.to, 'license-certification'); });
  // 5. the lane: wrong answers W1-W3 and the surviving mutations
  const mkp = (id, type, text, fields = {}) => ({ id, type, fields, pages: [{ page_no: 1, text }] });
  const CDLR = mkp('r1', 'license-certification', 'COMMERCIAL DRIVER LICENSE\nDLN: D55667788   CLASS: A\nISS 03/15/2022   EXP 03/15/2032', { holder_name: 'Pat Rivera', license_number: 'D55667788', license_class: 'A', end_date: '2032-03-15' });
  const HIRER = mkp('h9', 'hr-letter', 'New Hire Information Sheet\nFULL NAME   PHONE\n Lee Kim   (602) 555-0100\nPOSITION   DEPARTMENT   START DATE\n Installer   Field   09/01/2026\nREPORTS TO / MANAGER   HOURLY RATE\n Sam Ortiz   $31.00');
  const L = (docs, q, o = {}) => answerPeople(docs, q, { today: '2026-10-25', canHr: true, ...o });
  for (const qual of ['contractor', 'plumbing', 'business', 'real estate', 'liquor', 'ROC', "contractor's"]) {
    t(`W1: "${qual} license" of a named driver is not answered from the CDL`, () => { assert.equal(L([CDLR], `When does Pat Rivera's ${qual} license expire?`), null); assert.equal(L([CDLR], `What is Pat Rivera's ${qual} license number?`), null); });
  }
  t('W1: the driver licence questions still work', () => { assert.match(L([CDLR], "When does Pat Rivera's driver license expire?").text, /2032/); assert.match(L([CDLR], "When does Pat Rivera's license expire?").text, /2032/); assert.match(L([CDLR], "When does Pat Rivera's CDL license expire?").text, /2032/); });
  for (const w of ['maintenance agreement', 'warranty', 'service', 'job at the house', 'lease', 'installation', 'subscription'])
    t(`W2: a customer's ${w} start is not the hire date of the employee with the same name`, () => { assert.equal(L([HIRER], `When does Lee Kim's ${w} start?`), null); assert.equal(L([HIRER], `When did Lee Kim's ${w} start?`), null); });
  t('W2: the hire date is still answered; money wording is not an employee fact', () => { assert.match(L([HIRER], "What is Lee Kim's start date?").text, /September 1, 2026/); assert.equal(L([HIRER], 'Has Lee Kim paid the invoice?'), null); assert.equal(L([HIRER], "What is Lee Kim's phone number?"), null); });
  const ANN = mkp('a1', 'license-certification', 'COMMERCIAL DRIVER LICENSE\nDLN: D11112222   CLASS: B\nISS 03/15/2022   EXP 03/15/2031', { holder_name: 'Ann Lee', end_date: '2031-03-15' });
  const LEEC = mkp('h8', 'hr-letter', 'New Hire Information Sheet\nFULL NAME   PHONE\n Lee Chang   (602) 555-0111\nPOSITION   DEPARTMENT   START DATE\n Lead   Field   01/05/2024');
  t("W3: 'Lee' is Ann Lee's surname and Lee Chang's first name: no guess", () => { assert.equal(L([ANN, LEEC], "When does Lee's CDL expire?"), null); assert.equal(L([ANN, LEEC], "When does Lee's commercial driver license expire?"), null); assert.match(L([ANN, LEEC], "When does Ann Lee's CDL expire?").text, /2031/); });
  t('W3: "did X renew" is not an expiry answer', () => assert.equal(L([ANN], 'Did Ann Lee renew her CDL?'), null));
  const JON = mkp('j1', 'license-certification', 'CDL\nDLN: D1\nEXP 03/15/2031', { holder_name: 'Jonathan Reeves', end_date: '2031-03-15' });
  const JOH = mkp('j2', 'license-certification', 'CDL\nDLN: D2\nEXP 03/15/2029', { holder_name: 'Johnathan Reeves', end_date: '2029-03-15' });
  t('tie: two people that fit the name nearly equally -> abstain', () => assert.equal(L([JON, JOH], "When does Jonathan Reeves's CDL expire?"), null));
  const S1 = mkp('s1', 'license-certification', 'CDL', { holder_name: 'Pat Smith', end_date: '2031-03-15' }); const S2 = mkp('s2', 'license-certification', 'CDL', { holder_name: 'Kay Smith', end_date: '2029-03-15' });
  t('tie: two people share a surname -> abstain', () => { assert.equal(L([S1, S2], "When does Smith's CDL expire?"), null); assert.match(L([S1, S2], "When does Pat Smith's CDL expire?").text, /2031/); });
  t('expiry today is still current; the day after is expired', () => { const D = mkp('e1', 'license-certification', 'CDL', { holder_name: 'Pat Rivera', end_date: '2026-10-25' }); assert.match(L([D], "Is Pat Rivera's CDL current?").text, /^Yes\./); assert.match(L([D], "Is Pat Rivera's CDL current?", { today: '2026-10-26' }).text, /^No\./); assert.match(L([D], "When does Pat Rivera's CDL expire?", { today: '2026-10-26' }).text, /expired on/); });
  t('a surname alone, lower case and not possessive, is not a name', () => assert.equal(L([CDLR], 'when does rivera cdl expire'), null));
  t('a licence number asked together with an SSN is not answered', () => { assert.equal(L([CDLR], "What is Pat Rivera's CDL number and SSN?"), null); assert.equal(L([CDLR], "What is Pat Rivera's CDL number and date of birth?"), null); });
  t('money / customer wording is never an employee fact (manager, position)', () => { assert.equal(L([HIRER], "Who is the manager on Lee Kim's invoice?"), null); assert.equal(L([HIRER], "What position is on Lee Kim's estimate?"), null); assert.match(L([HIRER], "Who is Lee Kim's manager?").text, /Sam Ortiz/); });
  t('the switch: off unless DONOVAN_READER_V2_IDDOCS is set; ask.js uses the one gate', () => {
    const was = process.env.DONOVAN_READER_V2_IDDOCS;
    try {
      delete process.env.DONOVAN_READER_V2_IDDOCS; assert.equal(PL.peopleLaneOn(), false); assert.equal(PL.peopleLaneApplies("When does Pat Rivera's CDL expire?"), false);
      process.env.DONOVAN_READER_V2_IDDOCS = '1'; assert.equal(PL.peopleLaneOn(), true); assert.equal(PL.peopleLaneApplies("When does Pat Rivera's CDL expire?"), true); assert.equal(PL.peopleLaneApplies('What is the total due?'), false);
      process.env.DONOVAN_READER_V2_IDDOCS = '0'; assert.equal(PL.peopleLaneOn(), false);
    } finally { if (was === undefined) delete process.env.DONOVAN_READER_V2_IDDOCS; else process.env.DONOVAN_READER_V2_IDDOCS = was; }
    const src = fs.readFileSync(new URL('../api/ask.js', import.meta.url), 'utf8');
    assert.match(src, /pl\.peopleLaneApplies\(question\)[\s\S]{0,400}runPeopleLaneFor/);
  });
}

// ---- round 4 (verifier round 3): over-rejection, the real papers' types, the registration issue date, HR contact fields. Invented text only.
{
  const PS = await import(new URL('../api/_lib/modelAvoidance/peopleShape.js', import.meta.url).href);
  const TE = await import(new URL('../api/_lib/modelAvoidance/textExtract.js', import.meta.url).href);
  // names that earlier rules rejected: whole-token matching only (-ed / -ing words, titles, accents)
  for (const ok of ['Mildred Ratched', 'Irving Berlin', 'Winnifred Thackeray-Lowe', 'Sinead Fielding', 'Mark Walking', 'Amy Waring', 'Ron Booking', 'Howard Hayward', 'Sandra Clement', 'Edward Trinity', 'José García', 'María García', 'Zoë Renée', 'Łukasz Björn', 'Jesús Martínez', 'MARÍA GARCÍA'])
    t(`name shape accepts ${ok}`, () => assert.equal(PS.nameShape(ok).ok, true, ok));
  t('name shape strips a title prefix and keeps the name', () => { assert.equal(PS.nameShape('Dr. Ana Reyes').value, 'Ana Reyes'); assert.equal(PS.nameShape('Mrs. Ana Reyes').value, 'Ana Reyes'); assert.equal(PS.nameShape('Dr. Ana Reyes', { kind: 'examiner' }).value, 'Dr. Ana Reyes'); });
  t('a title prefix in front of the same words is not a longer title', () => assert.equal(PS.nameShape('Dr. Ana Reyes', { titleLines: ['Dr. Ana Reyes'] }).ok, true));
  for (const bad of ['Printing Instructions', 'Signed Copy', 'Pending Review', 'Documentation Required', 'Awaiting Clearance', 'Completing Section'])
    t(`name shape still rejects ${bad}`, () => assert.equal(PS.nameShape(bad).ok, false, bad));
  for (const bad of ['Fleet Pool Vehicle', 'Spare Truck Eleven', 'Hourly Staff Member', 'Backup Van Twelve'])
    t(`name shape rejects name-shaped junk: ${bad}`, () => assert.equal(PS.nameShape(bad).ok, false, bad));
  for (const bad of ['Tucson, Washington', 'Yuma, Virginia', 'Casa Grande, Columbia', 'Show Low, DC', 'Flagstaff, WA', 'TUCSON, WASHINGTON'])
    t(`name shape rejects City, State: ${bad}`, () => assert.equal(PS.nameShape(bad).ok, false, bad));
  t('a state-named surname without a comma is still a person', () => assert.equal(PS.nameShape('Denzel Washington').ok, true));
  t('examiner credentials are kept (MD stays a credential for an examiner only)', () => { assert.equal(PS.nameShape('Pat Sampleton, MD', { kind: 'examiner' }).value, 'Pat Sampleton, MD'); assert.equal(PS.nameShape('Pat Sampleton, MD').ok, false); });
  // end to end: the accented and -ing names are read from a sheet, and a city/state is not
  t('employee José García is read from a new-hire sheet', () => assert.equal(val(runDoc(P, doc('New Hire Checklist\nNew Hire Name\nJosé García\nPosition\nField Technician\nStart Date 06/03/2025\n')), 'employee_name'), 'José García'));
  t('holder Mildred Ratched with a Dr. prefix is read', () => assert.equal(val(runDoc(P, doc("Medical Examiner's Certificate\nLicensee: Mrs. Mildred Ratched\nDriver's License Number\nX1234567\nDate of Examination 05/05/2024\n")), 'holder_name'), 'Mildred Ratched'));
  t('"Tucson, Washington" is not a manager or a holder', () => { const r = runDoc(P, doc('New Hire Checklist\nNew Hire Name\nAlex Tester\nPosition\nField Technician\nStart Date 06/03/2025\nSupervisor\nTucson, Washington\n')); assert.equal(val(r, 'manager'), undefined); assert.equal(val(r, 'employee_name'), 'Alex Tester'); });
  // the real papers: noisy scans keep their type
  const HR_SCAN = 'New Hire Intake Form\nNew Hire Name:( AE a ) \\ %)\nPosition: Y \\aa ) L\nStart Date: = ee Nea\nEmail: (_} \\a\nEmployee Number: |_ Raa\n';
  const CARD_PHOTO = 'aa AAA AAA\nARIZONA DRIVER LICENSE |\n12345678 A AAA |\nDOB 03/04/1975\n|_ Raa\n03/04/2026 03/04/2030 ;\n';
  t('a noisy new-hire sheet scan is still an HR paper', () => assert.equal(TE.classifyFromText([{ page_no: 1, text: HR_SCAN }])?.type, 'hr-letter'));
  t('a noisy photographed licence is still a licence', () => assert.equal(TE.classifyFromText([{ page_no: 1, text: CARD_PHOTO }])?.type, 'license-certification'));
  t('a photographed licence with no readable number: capitals title, issue / expiry labels and two dates', () => assert.equal(TE.classifyFromText([{ page_no: 1, text: 'aa A\nARIZONA DRIVER LICENSE |\nISS 03/04/2022 ; EXP 03/04/2030\nDLN |_ Raa\n' }])?.type, 'license-certification'));
  t('the same labels under a sentence-case line are not a licence', () => assert.notEqual(TE.classifyFromText([{ page_no: 1, text: 'aa A\nArizona driver license reminder |\nISS 03/04/2022 ; EXP 03/04/2030\nDLN |_ Raa\n' }])?.type, 'license-certification'));
  t('a new-hire sheet needs its name label (a flyer with three labels is not one)', () => assert.notEqual(TE.classifyFromText([{ page_no: 1, text: 'New hire bonus program\nPosition: Installer\nStart Date: next month\nManager: see your lead\nSalary: competitive\n' }])?.type, 'hr-letter'));
  t('a driver policy with two dates and a phone number is not a licence', () => assert.notEqual(TE.classifyFromText([{ page_no: 1, text: 'Driver Safety Policy\nEvery driver must carry a valid driver license while on duty.\nReviewed 03/04/2026 and 05/06/2026.\nCall 480-555-0100.\n' }])?.type, 'license-certification'));
  t('a long number needs seven digits on a short line (a phone number is not one)', () => { assert.equal(PS.hasLongIdNumber(['12345678 A AAA |']), true); assert.equal(PS.hasLongIdNumber(['Call 480-555-0100']), false); assert.equal(PS.hasLongIdNumber(['Phone 4805550100 x']), false); });
  // registration: the issue date is kept once, as start_date
  const REG = (iss) => `Valley Vehicle Titles and Registration Office\nVEHICLE REGISTRATION\nPlate:\nMCA 7604\nYear / Make / Model: 2019 Ironbell Trailers IB-14D Dump ${iss}\nTrailer 14 ft\nExpiration: 6/18/27 Registration Fee: $110.50\nREGISTERED OWNER\nSidewinder Equipment Rental\n`;
  for (const lab of ['Date Issued: 6/18/26', 'Issued On: 6/18/26', 'Issue Date: 6/18/26'])
    t(`registration "${lab}" in the middle of a row is the start date`, () => { const r = runDoc(P, doc(REG(lab), 'Registration.jpg')); assert.equal(val(r, 'start_date'), '2026-06-18'); assert.equal(val(r, 'end_date'), '2027-06-18'); assert.equal(val(r, 'service_date'), undefined); assert.equal(val(r, 'holder_name'), undefined); });
  t('a mid-row "Date Issued" on another paper type is not read', () => assert.equal(val(runDoc(P, doc('Service Invoice\nCustomer: Alex Tester Date Issued: 6/18/26\nTotal $120.00\n', 'inv.pdf')), 'start_date'), undefined));
  // HR contact fields: kept under HR keys, never customer_* / service_*
  const NHT = 'Blue Agave Catering - New Hire Information Sheet\nPlease print clearly. Return to HR on your first day.\n\n\n Employee\n\nFULL NAME                                                                  PHONE\n\n Elena L. Escalante                                                           (602) 555-0181\nHOME ADDRESS                                                               EMAIL\n\n 8392 S Verde Alamo Ave, Mesa, AZ 85201                                      elena.escalante@example.com\nPOSITION                                            DEPARTMENT                          START DATE\n\n HVAC Installer                                         Transportation                     08/17/2026\nREPORTS TO / MANAGER\n\n Dana Sample\n';
  t('a new hire sheet keeps phone and email as employee_phone / employee_email', () => { const r = runDoc(P, doc(NHT)); assert.equal(val(r, 'employee_phone'), '(602) 555-0181'); assert.equal(val(r, 'employee_email'), 'elena.escalante@example.com'); assert.ok(!r.fields.some((f) => /^(?:customer_|service_|shop_)/.test(f.field_key))); });
  t('a direct deposit form keeps the signed date as signed_date, never service_date', () => { const r = runDoc(P, doc('Direct Deposit Authorization Form\nKestrel Ridge Plumbing - Payroll Department\n\nI authorize the employer named above to deposit my net pay into the account listed below.\nEMPLOYEE NAME                                                               DATE\n\n Ulises M. Zuniga                                                           04/21/2026\nBANK NAME                                                                   ACCOUNT TYPE\n\n Sample Desert Bank                                                         Savings\n')); assert.equal(val(r, 'signed_date'), '2026-04-21'); assert.equal(val(r, 'service_date'), undefined); });
  t('the lane answers an employee phone from the HR key', () => { const d = mk(NHT, 'hire.pdf'); assert.match(ask([d], 'What is the new hire Elena Escalante phone number?')?.text ?? '', /555-0181/); });
  t('the HR keys are in the field registry (labels exist)', () => { const dt = fs.readFileSync(new URL('../api/_lib/documentTypes.js', import.meta.url), 'utf8'); for (const k of ['employee_phone', 'employee_email', 'signed_date']) assert.ok(dt.includes(`${k}:`)); });
  t('the HR keys are never filed for a licence paper', () => { const r = runDoc(P, doc("Medical Examiner's Certificate\nLicensee: Alex Tester\nDriver's License Number\nX1234567\nDate of Examination 05/05/2024\nPhone: (602) 555-0181\n")); assert.ok(!r.fields.some((f) => /^(?:customer_|employee_phone|employee_email)/.test(f.field_key))); });
}

// ---- round 4 (late verifier report): the safety gate, other-licence questions, agreement wording, flyers and Re-check
{
  const SG = await import(new URL('../api/_lib/router/safetyGate.js', import.meta.url).href);
  const RT = await import(new URL('../api/_lib/modelAvoidance/retype.js', import.meta.url).href);
  for (const q of ["What is Pat Rivera's CDL number?", 'dln for Pat', "what is the dln on pat rivera's cdl", 'driver license # for Alex Tester', "What is Pat's ROC license number?", "What is Pat Rivera's contractor license #?", 'medical card number for Alex Tester', 'CDL no. for Pat Rivera'])
    t(`safety gate declines the ID number ask: ${q}`, () => assert.equal(SG.classifySafety(q)?.kind, 'sensitive', q));
  for (const q of ["When does Pat Rivera's CDL expire?", 'Does Pat have a CDL?', 'What is our contractor license number?', "Desert Air LLC's license number", "Bright Plumbing's license number", "Ridgeline Electric's license number", 'How many drivers have a CDL number on file?', 'what is the permit number for 123 Main St'])
    t(`safety gate leaves a normal question alone: ${q}`, () => assert.equal(SG.classifySafety(q), null, q));
  const CDL4 = mk("Arizona Driver License\nName: Pat Rivera\nDLN: D12345678\nClass: A\nDOB: 03/04/1980\nIssued: 03/15/2024\nExpires: 03/15/2032\n", 'cdl4.pdf');
  const HIRE4 = mk('New Hire Checklist\nNew Hire Name: Lee Kim\nPosition: Installer\nStart Date: 09/01/2026\nManager: Dana Sample\n', 'hire4.pdf');
  const AGR4 = mk('Maintenance Agreement\nCustomer: Lee Kim\nAgreement Start: 01/01/2026\nAgreement End: 12/31/2026\nService Address: 12 Main St\n', 'agr4.pdf');
  for (const q of ["When does Pat Rivera's contractor license expire?", "What is Pat Rivera's ROC license number?", "When does Pat's plumbing license expire?"])
    t(`another kind of licence is not answered from the driver licence: ${q}`, () => { assert.equal(ask([CDL4], q), null); assert.equal(answerPeople([CDL4], q, { today: '2026-10-25', canHr: false }), null); });
  for (const q of ["When does Lee Kim's maintenance agreement start?", "When did Lee Kim's warranty start?", "When did the job at Lee Kim's house start?", "When did Lee Kim's service start?"])
    t(`a customer's agreement / job start is not the hire date: ${q}`, () => assert.equal(ask([HIRE4, AGR4], q), null, q));
  t('the real hire date is still answered', () => assert.match(ask([HIRE4], "What is Lee Kim's start date?")?.text ?? '', /September 1, 2026/));
  // Re-check never moves a stored customer paper into the HR lock on a flyer or an agenda; a real sheet still moves
  const rc = (text, st) => RT.retypeDecision({ currentType: st, filename: 'doc.pdf', pages: [{ page_no: 1, text }], fields: [] })?.to ?? null;
  for (const st of ['invoice', 'other', 'correspondence', 'internal', 'schedule']) {
    t(`Re-check: a new-hire flyer stored as ${st} is not moved to HR`, () => assert.notEqual(rc('New hire bonus program\nPosition: Installer\nStart Date: next month\nManager: see your lead\nSalary: competitive\nApply at the front desk.', st), 'hr-letter'));
    t(`Re-check: a new-hire agenda stored as ${st} is not moved to HR`, () => assert.notEqual(rc('New Hire Orientation Agenda\nPosition: Installer\nStart Date: 09/01/2026\nManager: Dana Sample\nRate of Pay: $25/hr\n', st), 'hr-letter'));
  }
  t('Re-check: a real new-hire sheet is moved to HR (it has the HR structure)', () => assert.equal(rc('New Hire Information Sheet\nNew Hire Name: Alex Tester\nPosition: Installer\nStart Date: 09/01/2026\nEmployee Number: 4471\n', 'other'), 'hr-letter'));
  t('Re-check: a permit with a License # row stays a permit', () => assert.notEqual(rc('Electrical Permit\nBuilding Division\nPermit No: ELC25-65990\nLicense #: ROC123456\nDate Issued 3 Jan 2026\nSite: 6924 Vista Pkwy\n', 'permit'), 'license-certification'));
}

// ---- round 5: a name is believed only with positive evidence (a given name people have, or the same name printed twice)
{
  const PS = await import(new URL('../api/_lib/modelAvoidance/peopleShape.js', import.meta.url).href);
  const FN = await import(new URL('../api/_lib/modelAvoidance/firstNames.js', import.meta.url).href);
  const hold = (name, extra = '') => val(runDoc(P, doc(`Medical Examiner's Certificate\n${extra}Driver's Name: ${name}\nDriver's License Number\nX1234567\nDate of Examination 05/05/2024\n`)), 'holder_name');
  const emp = (name, extra = '') => val(runDoc(P, doc(`New Hire Checklist\n${extra}Employee Name: ${name}\nPosition\nField Technician\nStart Date 06/03/2025\n`)), 'employee_name');
  for (const j of ['Standby Tank East', 'Night Cart Lead', 'Satellite Hub Alpha', 'Fleet Pool Vehicle', 'Yard Forklift Bravo', 'Main Gate'])
    t(`junk "${j}" on a name label reads nothing`, () => { assert.equal(hold(j), undefined); assert.equal(emp(j), undefined); });
  for (const n of ['Michael Johnson', 'Maria Hernandez', 'Dr. Ana Reyes', 'José García', 'Mary-Jane O\'Brien', 'Łukasz Kowalski', 'SØREN LINDGREN', 'Johnson, Michael'])
    t(`a real name "${n}" on a name label is read`, () => { assert.ok(hold(n)); assert.ok(emp(n)); });
  t('an unknown first name with an unknown surname is NOT read on its own (recall cost, by design)', () => assert.equal(emp('Tamsin Pryce'), undefined));
  t('...and not read when the same name is merely repeated elsewhere (a header, a body line)', () => assert.equal(emp('Tamsin Pryce', 'Tamsin Pryce\n'), undefined));
  t('...but is read when the same name is printed again on a signature / printed-name line', () => { assert.equal(val(runDoc(P, doc('New Hire Checklist\nEmployee Name: Tamsin Pryce\nPosition\nField Technician\nStart Date 06/03/2025\nEmployee Signature: Tamsin Pryce\n')), 'employee_name'), 'Tamsin Pryce'); assert.equal(val(runDoc(P, doc('New Hire Checklist\nEmployee Name: Tamsin Pryce\nPosition\nField Technician\nStart Date 06/03/2025\n__________________\nTamsin Pryce\n')), 'employee_name'), 'Tamsin Pryce'); });
  t('junk printed twice with a signature line is the only way in, so junk repeated as a header/body is never read', () => { for (const j of ['Standby Tank East', 'Fleet Pool Vehicle', 'Satellite Hub Alpha']) assert.equal(emp(j, `${j}\n${j}\n`), undefined); });
  // round 6: a word CLASS at the end of a value (organisation / place type / unit / group / program / vehicle) is never a person, whatever the first word is
  for (const j of ['Dallas Branch', 'Austin Office', 'Jordan Valley Clinic', 'Madison Center', 'Phoenix Dept', 'Austin Fleet', 'Taylor Team', 'Morgan Program', 'Casey Crew', 'Riley Depot', 'Jordan Warehouse', 'Quinn Annex', 'Avery Terminal'])
    t(`non-person "${j}" is not a name (even with a given-name first word)`, () => { assert.equal(hold(j), undefined); assert.equal(emp(j), undefined); assert.equal(PS.nameShape(j).ok, false); });
  // uncommon real names: a surname-shaped last word on the label's own line is enough; unknown surname + unknown first name is not (by design)
  for (const n of ['Dzung Pham', 'Yazmin Begay', 'Khalid Al-Hamdan', 'Tuan Nguyen', 'Nizhoni Yazzie', 'Rashid Haddad', 'Xochitl Mendoza', 'Hyun-Woo Kim', 'Siosaia Tupou', 'Anh Dinh', 'Wei Zhang'])
    t(`uncommon real name "${n}" on a name label (same line) is read`, () => { assert.equal(hold(n), n); assert.equal(emp(n), n); });
  t('the same uncommon name on the NEXT line of the label is not read on label strength alone, unless the first name is known', () => assert.equal(val(runDoc(P, doc("Medical Examiner's Certificate\nDriver's Name\nDzung Pham\nDriver's License Number\nX1234567\nDate of Examination 05/05/2024\n")), 'holder_name'), undefined));
  t('name occurrences count either order and ignore accents', () => { assert.equal(PS.nameOccurrences('José García', 'Name: García, Jose\nSigned: José García'), 2); assert.equal(PS.nameOccurrences('Ana Reyes', 'Ana Reyes'), 1); assert.equal(PS.nameOccurrences('Ana', 'Ana Ana'), 0); });
  t('given-name test: first word only, prefix and accents ignored', () => { assert.equal(FN.startsWithGivenName('Dr. José García'), true); assert.equal(FN.startsWithGivenName('Fleet Mark Alpha'), false); assert.equal(FN.startsWithGivenName('Łukasz Kowalski'), true); });
  t('the evidence rule is applied to a form reader too (direct deposit with junk as the employee)', () => assert.equal(val(runDoc(P, doc('Direct Deposit Authorization Form\nKestrel Ridge Plumbing - Payroll Department\n\nEMPLOYEE NAME                                                               DATE\n\n Night Cart Lead                                                           04/21/2026\nBANK NAME                                                                   ACCOUNT TYPE\n\n Sample Desert Bank                                                         Savings\n')), 'employee_name'), undefined));
  t('the form reader itself needs the evidence (junk employee on a direct deposit form; a real one is read)', async () => {});
  { const PF = await import(new URL('../api/_lib/modelAvoidance/peopleForms.js', import.meta.url).href);
    const DD = (n) => `Direct Deposit Authorization Form\nKestrel Ridge Plumbing - Payroll Department\n\nEMPLOYEE NAME                                                               DATE\n\n ${n}                                                           04/21/2026\nBANK NAME                                                                   ACCOUNT TYPE\n\n Sample Desert Bank                                                         Savings\n`;
    t('readPeopleForm: junk employee name is not a fact', () => assert.equal(PF.readPeopleForm([{ page_no: 1, text: DD('Night Cart Lead') }]).facts.employee_name, undefined));
    t('readPeopleForm: a real employee name is a fact', () => assert.equal(PF.readPeopleForm([{ page_no: 1, text: DD('Ulises M. Zuniga') }]).facts.employee_name?.value, 'Ulises M. Zuniga')); }
  t('a junk supervisor is not a manager', () => assert.equal(val(runDoc(P, doc('New Hire Checklist\nNew Hire Name: Dana Sample\nPosition: Installer\nStart Date 06/03/2025\nSupervisor: Standby Tank East\n')), 'manager'), undefined));
}
console.log(`verify:id-docs  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
