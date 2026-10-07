/**
 * Electrical regressions for the loop-3 review findings (Build 2 QA, electrical lane). Fresh randomized data per seed, truth
 * computed here from the raw rows (never from the lane). A decline is always acceptable unless the case says MUST ANSWER.
 * Classes: card linked to its customer/address through the permit number; test-due window / due-today / equipment;
 * extractor (mixed pages, status words, dotted dates, two numbers on one paper); number-less credentials; shared-address
 * finals; mixed results ("Failed - re-inspection passed").
 */
import { seedDocs, addSecondCompany, rng, pick, leadNumber } from './class-variants-core.mjs';
const TODAY = '2026-10-05';
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const wipe = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
const CUST = ['Gamma Inc', 'Delta Foods', 'Orchid Dental', 'Pike Brewing', 'Marlow Storage', 'Quill Print Shop', 'Harbor Realty', 'Sable Fitness', 'Juniper Cafe', 'Westin Tire'];
const STREETS = ['Alder', 'Birch', 'Cedar', 'Dune', 'Fern', 'Garnet', 'Hollis', 'Ivy', 'Jasper', 'Kestrel'];
const numFmt = (r, n) => pick(r, [n, n.toLowerCase(), ` ${n}  `, n.replace(/-/g, ' '), n.replace(/-/g, '')]);

export async function runElectricalLoop4({ H, lane, attention, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => ({ key, value: v }))) });
  const B2 = await addSecondCompany(H, 'electrical', 'l4');

  /* ---------- F1 (HIGH): cards that carry only a permit number belong to the permit's customer */
  for (let seed = 1; seed <= 6; seed++) {
    const r = rng(seed * 101);
    const custs = [...CUST].sort(() => r() - 0.5).slice(0, 4);
    const specs = custs.map((c, i) => ({ c, no: `EL-26-${String(20000 + seed * 100 + i)}`, addr: `${10 + i * 7} ${STREETS[(i + seed) % 10]} Street, Mesa AZ`, cards: [] }));
    const docs = [];
    for (const s of specs) {
      docs.push(doc(`${s.no}-permit.pdf`, 'permit', { permit_number: s.no, customer_name: s.c, service_address: s.addr }));
      const k = Math.floor(r() * 3); // 0..2 cards
      for (let j = 0; j < k; j++) {
        const stage = pick(r, ['Rough-in', 'Final']); const res = pick(r, ['Failed', 'Passed', 'Corrections Required', 'Approved']);
        const d = addDays('2026-06-01', Math.floor(r() * 90));
        s.cards.push({ stage, res, d });
        docs.push(doc(`${s.no}-card-${j}.pdf`, 'inspection-report', { permit_number: numFmt(r, s.no), inspection_type: stage, inspection_result: res, service_date: d }));
      }
    }
    await H.as('electrical', async (db) => {
      await wipe(db); await seedDocs(db, docs);
      for (const s of specs) {
        const failed = s.cards.filter((x) => /fail|correction/i.test(x.res)).length;
        const a = await ask(db, `How many failed inspections does ${s.c} have?`);
        check(`L4-F1 s${seed}: "${s.c}" failed inspections via permit number = ${failed}`, a != null && (failed === 0 ? /^No failed/.test(a.text) : leadNumber(a.text) === failed), a?.text ?? "declined (must answer)");
        const finalPassed = s.cards.some((x) => x.stage === 'Final' && /^(passed|approved)$/i.test(x.res));
        const o = await ask(db, `Which permits are still open for ${s.c}?`);
        check(`L4-F1 s${seed}: "${s.c}" open permits via permit number (${finalPassed ? 'closed' : 'open'})`, o == null || (finalPassed ? /^(?:None|That permit has a passed)/i.test(o.text) || /^0\b/.test(o.text) : /^1 permit has/.test(o.text)), o?.text);
        const last = s.cards.filter((x) => x.stage === 'Final').sort((x, y) => y.d.localeCompare(x.d))[0];
        if (last) { const p = await ask(db, `Did ${s.c} pass final inspection?`); const want = /^(passed|approved)$/i.test(last.res) ? /passed|approved/i : /failed|corrections/i; check(`L4-F1 s${seed}: "${s.c}" final result is the card's (${last.res})`, p == null || (want.test(p.text) && !(want.source.startsWith('passed') ? /failed/i : /passed|approved/i).test(p.text.split(':').slice(1).join(':'))), p?.text); }
      }
    });
    // second organization sees none of it
    await B2.as(async (db) => { await wipe(db); const o = await ask(db, `How many failed inspections does ${custs[0]} have?`); check(`L4-F1 s${seed}: another company gets no answer built from these records`, o == null || !/\b[1-9]\d* failed/.test(o.text), o?.text); });
  }
  // unsafe links decline: no link at all, one number on two permits for different customers, card names someone else
  await H.as('electrical', async (db) => {
    await wipe(db);
    await seedDocs(db, [
      doc('p1.pdf', 'permit', { permit_number: 'EL-26-70001', customer_name: 'Gamma Inc', service_address: '1 Alder Street, Mesa AZ' }),
      doc('p2.pdf', 'permit', { permit_number: 'EL-26-70002', customer_name: 'Delta Foods', service_address: '2 Birch Street, Mesa AZ' }),
      doc('orphan.pdf', 'inspection-report', { inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-08-01' }),
    ]);
    const a = await ask(db, 'How many failed inspections does Gamma Inc have?');
    check('L4-F1: a failed card tied to no permit, customer or address makes a customer count decline (it could be theirs)', a == null, a?.text);
    await wipe(db);
    await seedDocs(db, [
      doc('p1.pdf', 'permit', { permit_number: 'EL-26-70001', customer_name: 'Gamma Inc', service_address: '1 Alder Street, Mesa AZ' }),
      doc('p1b.pdf', 'permit', { permit_number: 'EL-26-70001', customer_name: 'Delta Foods', service_address: '2 Birch Street, Mesa AZ' }),
      doc('c.pdf', 'inspection-report', { permit_number: 'EL-26-70001', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-08-01' }),
    ]);
    const b = await ask(db, 'How many failed inspections does Gamma Inc have?');
    check('L4-F1: one permit number printed for two different customers is never linked (decline)', b == null, b?.text);
    await wipe(db);
    await seedDocs(db, [
      doc('p1.pdf', 'permit', { permit_number: 'EL-26-70001', customer_name: 'Gamma Inc', service_address: '1 Alder Street, Mesa AZ' }),
      doc('c.pdf', 'inspection-report', { permit_number: 'EL-26-70001', customer_name: 'Delta Foods', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-08-01' }),
    ]);
    const c = await ask(db, 'How many failed inspections does Gamma Inc have?'); const d2 = await ask(db, 'How many failed inspections does Delta Foods have?');
    check('L4-F1: a card naming a different customer than its permit is never counted for either (decline)', c == null && d2 == null, `${c?.text} | ${d2?.text}`);
    await wipe(db);
    await seedDocs(db, [
      doc('p1.pdf', 'permit', { permit_number: 'EL-26-70001', customer_name: 'Gamma Inc', service_address: '1 Alder Street, Mesa AZ' }),
      doc('c.pdf', 'inspection-report', { permit_no: 'EL-26-70001', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-08-01' }),
    ]);
    const e = await ask(db, 'How many failed inspections does Gamma Inc have?');
    check('L4-F1: a permit number stored under the key permit_no still links', e != null && leadNumber(e.text) === 1, e?.text);
    await wipe(db);
    const f = await ask(db, 'How many failed inspections does Gamma Inc have?');
    check('L4-F1: empty data says no inspection reports on file, never "none"', f == null || /on file yet/.test(f.text) || /No failed/.test(f.text) === false, f?.text);
  });

  /* ---------- F2 (MED): equipment test-due questions respect the window; due today is not overdue */
  for (let seed = 1; seed <= 4; seed++) {
    const r = rng(seed * 77);
    const eq = [['Generator', 'GENERATOR LOAD TEST REPORT'], ['Transfer Switch', 'TRANSFER SWITCH TEST REPORT'], ['Generator', 'GENERATOR LOAD TEST REPORT'], ['Generator', 'GENERATOR LOAD TEST REPORT'], ['Thermography', 'THERMOGRAPHY TEST REPORT']];
    const offs = [0, -Math.floor(5 + r() * 20), 400 + Math.floor(r() * 100), -Math.floor(1 + r() * 4), 15];
    const rows = eq.map((e, i) => ({ eq: e[0], off: offs[i], due: addDays(TODAY, offs[i]), addr: `${100 + i * 11} ${STREETS[(i + seed) % 10]} Road, Tempe AZ`, title: e[1] }));
    const docs = rows.map((t, i) => doc(`t${i}.pdf`, 'test-report', { equipment_type: t.eq, service_address: t.addr, service_date: addDays(t.due, -365), next_test_due: t.due }));
    await H.as('electrical', async (db) => {
      await wipe(db); await seedDocs(db, docs);
      const gen = rows.filter((t) => t.eq === 'Generator');
      const a = await ask(db, 'Which generator tests are overdue?');
      check(`L4-F2 s${seed}: overdue generator tests = ${gen.filter((t) => t.off < 0).length} (due today and far-future are not overdue)`, a != null && leadNumber(a.text) === gen.filter((t) => t.off < 0).length && !gen.filter((t) => t.off >= 0).some((t) => a.facts.some((f) => f.label.includes(t.addr))), a?.text ?? 'declined');
      const b = await ask(db, 'Which generator tests are due in the next 30 days?');
      check(`L4-F2 s${seed}: generator tests due within 30 days or overdue = ${gen.filter((t) => t.off <= 30).length}`, b != null && leadNumber(b.text) === gen.filter((t) => t.off <= 30).length, b?.text ?? 'declined');
      const c = await ask(db, 'Which tests are overdue?');
      check(`L4-F2 s${seed}: all overdue tests = ${rows.filter((t) => t.off < 0).length}`, c != null && leadNumber(c.text) === rows.filter((t) => t.off < 0).length, c?.text);
      const t0 = rows[0]; const d = await ask(db, `Is the generator test at ${t0.addr.split(',')[0]} overdue?`);
      check(`L4-F2 s${seed}: due-today generator test is "due", never "overdue"`, d == null || (!/overdue/i.test(d.text.replace(/not overdue|none overdue\./gi, "")) && /due/i.test(d.text)), d?.text);
      const e = await ask(db, `Which tests are overdue at ${rows[1].addr.split(',')[0]}?`);
      check(`L4-F2 s${seed}: place + overdue lists only an overdue test at that place`, e == null || (e.facts.length === 1 && /overdue/i.test(e.text)), e?.text);
    });
  }

  /* ---------- F3 (MED): extractor */
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const has = (r, k) => r?.fields.find((x) => x.key === k)?.value ?? null;
  const PERMIT = 'ELECTRICAL PERMIT\nPermit No: EL-26-81234\nSite Address: 9 Alder Street, Mesa AZ\nOwner: Gamma Inc\nDate Issued: 03/02/2026';
  check('L4-F3: a file with a permit page and a final-inspection page is never read as one permit (declines to the normal path)', ex(PERMIT, 'FINAL INSPECTION REPORT\nPermit No: EL-26-81234\nResult: Passed\nDate of Inspection: 04/01/2026') === null);
  check('L4-F3: a file with a permit page and a certificate-of-completion page is not collapsed', ex(PERMIT, 'CERTIFICATE OF COMPLETION\nPermit No: EL-26-81234\nDate Completed: 04/01/2026') === null);
  check('L4-F3: a permit with a plain continuation page is still read', has(ex(PERMIT, 'Conditions of approval\nSee sheet E-2 for panel locations.'), 'permit_number') === 'EL-26-81234');
  check('L4-F3: a license file with two different license numbers is not stored as one', ex('CONTRACTOR LICENSE\nLicense No: ROC-111111\nLicense Expires: 01/31/2027', 'CONTRACTOR LICENSE\nLicense No: ROC-222222\nLicense Expires: 01/31/2028') === null);
  const LIC = (extra) => `CONTRACTOR LICENSE\nLicense No: ROC-318244\nLicensee: Desert Line Electric LLC\nLicense Expires: 12/31/2027${extra ? `\n${extra}` : ''}`;
  check('L4-F3: a plain license keeps its expiry', has(ex(LIC('Status: Active')), 'license_expiry') === '2027-12-31');
  for (const w of ['Status: Suspended', 'Status: Revoked', 'Status: Cancelled', 'Status: Canceled', 'This license was renewed on 11/01/2027', 'Replaced by license ROC-400000', 'Superseded by a later license', 'Status: Terminated', 'License suspended pending hearing', 'Renewal extended through 06/30/2029', 'Not renewed'])
    check(`L4-F3: license paper saying "${w}" keeps no expiry (never a guess)`, has(ex(LIC(w)), 'license_expiry') === null, String(has(ex(LIC(w)), 'license_expiry')));
  const COI = (extra) => `CERTIFICATE OF LIABILITY INSURANCE\nInsurer: Summit Mutual\nPolicy No: GL-4410-2291\nPolicy Expires: 08/15/2027${extra ? `\n${extra}` : ''}`;
  const BOND = (extra) => `CONTRACTOR LICENSE BOND\nBond No: SB-90311\nBond Expires: 08/15/2027${extra ? `\n${extra}` : ''}`;
  for (const w of ['Status: Cancelled', 'Policy replaced by GL-9999-0001', 'Renewed through 08/15/2028', 'Policy suspended', 'Notice of cancellation issued'])
    check(`L4-F3: COI "${w}" keeps no expiry`, has(ex(COI(w)), 'policy_expiry') === null);
  for (const w of ['Status: Cancelled', 'Bond revoked', 'Replaced by SB-1', 'Bond renewed through 2028'])
    check(`L4-F3: bond "${w}" keeps no expiry`, has(ex(BOND(w)), 'bond_expiry') === null);
  check('L4-F3: a COI that merely says "Replaces policy" is read conservatively (no expiry), never wrong', has(ex(COI('This policy replaces policy GL-1000')), 'policy_expiry') === null);
  check('L4-F3: "void after" on a permit is not a cancellation', has(ex(`${PERMIT}\nVoid after 180 days of inactivity`), 'permit_number') === 'EL-26-81234');
  check('L4-F3: permit Status: Cancelled is stored as the permit status (not an inspection result)', has(ex(`${PERMIT}\nStatus: Cancelled`), 'permit_status') === 'Cancelled' && has(ex(`${PERMIT}\nStatus: Cancelled`), 'inspection_result') === null);
  for (const [s, iso] of [['05.10.2027', null], ['03.04.2027', null], ['13.10.2027', '2027-10-13'], ['10.10.2027', '2027-10-10'], ['10.13.2027', '2027-10-13'], ['05/10/2027', '2027-05-10'], ['05-10-2027', '2027-05-10']])
    check(`L4-F3: license expiry printed ${s} reads ${iso ?? 'nothing (ambiguous dotted date)'}`, has(ex(`CONTRACTOR LICENSE\nLicense No: ROC-318244\nLicense Expires: ${s}`), 'license_expiry') === iso);
  check('L4-F3: a dotted permit issue date 05.06.2026 is not read month-first', has(ex(PERMIT.replace('03/02/2026', '05.06.2026')), 'permit_issue_date') === null);

  /* ---------- F4 (LOW-MED): number-less licenses / insurance */
  const credOrg = async (db, docs, q) => { await wipe(db); await seedDocs(db, docs); return ask(db, q); };
  const liOld = (n, f) => doc(f, 'contractor-license', { license_number: n, license_holder: 'Desert Line Electric LLC', license_expiry: '2025-12-31' });
  const liNew = (n, f) => doc(f, 'contractor-license', { license_number: n, license_holder: 'Desert Line Electric LLC', license_expiry: '2027-12-31' });
  await H.as('electrical', async (db) => {
    for (const [name, a, b, bad] of [
      ['no numbers on either paper, different filenames', liOld(null, 'license-2025.pdf'), liNew(null, 'license-2027-renewal.pdf'), /\bexpired\b/i],
      ['same number written two ways (ROC-318244 / roc 318244)', liOld('ROC-318244', 'a.pdf'), liNew('roc 318244', 'b.pdf'), /\bexpired\b/i],
      ['same number, punctuation dropped (ROC318244)', liOld('ROC-318244', 'a.pdf'), liNew('ROC318244', 'b.pdf'), /\bexpired\b/i],
      ['number with a one-character typo on the renewal', liOld('ROC-318244', 'a.pdf'), liNew('ROC-318245', 'b.pdf'), /\bexpired\b/i],
    ]) {
      const r1 = await credOrg(db, [a, b], 'Which licenses have already expired?');
      check(`L4-F4: ${name}: "already expired" never lists the old paper while a current one exists`, r1 == null || !/^[1-9]/.test(r1.text), r1?.text);
      const r2 = await credOrg(db, [a, b], 'Which licenses expire in the next 60 days?');
      check(`L4-F4: ${name}: one credential is never counted twice`, r2 == null || !/^2\b/.test(r2.text), r2?.text);
      const at = await attention(db, { today: TODAY });
      check(`L4-F4: ${name}: the attention list does not call it expired`, !at.items.some((i) => i.kind === 'expired'), JSON.stringify(at.items));
    }
    const ok = await credOrg(db, [liOld('ROC-111111', 'a.pdf'), liNew('ROC-222222', 'b.pdf')], 'Which licenses have already expired?');
    check('L4-F4: two clearly different license numbers still answer (1 expired)', ok != null && leadNumber(ok.text) === 1, ok?.text);
    const coi = (n, ins, exp, f) => doc(f, 'certificate-of-insurance', { policy_number: n, insurer: ins, policy_expiry: exp });
    const c1 = await credOrg(db, [coi(null, 'Summit Mutual', '2026-09-01', 'gl.pdf'), coi(null, 'Summit Mutual', '2027-09-01', 'gl2.pdf')], 'Which insurance certificates have expired?');
    check('L4-F4: number-less COIs from one insurer never leave "expired" while a current one exists', c1 == null || !/^[1-9]/.test(c1.text), c1?.text);
    const c2 = await credOrg(db, [coi(null, 'Summit Mutual', '2026-09-01', 'gl.pdf')], 'Which insurance certificates have expired?');
    check('L4-F4: a single number-less COI that is expired still answers expired', c2 != null && leadNumber(c2.text) === 1, c2?.text);
  });

  /* ---------- F5 (LOW): shared-address final without a permit number; mixed results */
  await H.as('electrical', async (db) => {
    const A = '14 Cedar Street, Mesa AZ';
    const base = [doc('p1.pdf', 'permit', { permit_number: 'EL-26-60001', customer_name: 'Gamma Inc', service_address: A }), doc('p2.pdf', 'permit', { permit_number: 'EL-26-60002', customer_name: 'Gamma Inc', service_address: A })];
    await wipe(db); await seedDocs(db, [...base, doc('fin.pdf', 'inspection-report', { service_address: A, inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-08-01' })]);
    const a = await ask(db, 'Which permits are still open?'); const b = await ask(db, 'How many permits are open?');
    check('L4-F5: a passed final with no permit number at an address holding two permits never leaves "2 open" (decline)', a == null && b == null, `${a?.text} | ${b?.text}`);
    await wipe(db); await seedDocs(db, [...base, doc('fin.pdf', 'inspection-report', { permit_number: 'EL-26-60001', service_address: A, inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-08-01' })]);
    const c = await ask(db, 'How many permits are open?');
    check('L4-F5: with the permit number on the final, only the other permit is open (1)', c != null && leadNumber(c.text) === 1, c?.text);
    for (const res of ['Failed - re-inspection passed', 'FAILED / reinspection passed', 'Fail, passed on re-inspection 8/9', 'Corrections required - approved on recheck']) {
      await wipe(db); await seedDocs(db, [base[0], doc('i.pdf', 'inspection-report', { permit_number: 'EL-26-60001', inspection_type: 'Final', inspection_result: res, service_date: '2026-08-01' })]);
      const f = await ask(db, 'How many failed inspections do we have?'); const g = await ask(db, 'Which permits are open?'); const h = await ask(db, 'How many failed inspections does Gamma Inc have?');
      check(`L4-F5: result "${res}" is neither a plain failed count nor a plain closed/open answer (decline)`, f == null && g == null && h == null, `${f?.text} | ${g?.text} | ${h?.text}`);
    }
    await wipe(db); await seedDocs(db, [base[0], doc('i.pdf', 'inspection-report', { permit_number: 'EL-26-60001', inspection_type: 'Final', inspection_result: 'Did not pass', service_date: '2026-08-01' })]);
    const k = await ask(db, 'How many failed inspections do we have?');
    check('L4-F5: "Did not pass" is still one plain failed inspection', k != null && leadNumber(k.text) === 1, k?.text);
  });
}

/** Review loop 1 (electrical) findings: partial cards, serial-numbered units, same street in two cities, prefix-less renewals, negations, id absorbing dates, applicant vs owner, equipment lines, CANCELLATION heading. */
export async function runElectricalReviewLoop1({ H, lane, attention, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
  const P = (no, c, a) => doc(`p-${no}.pdf`, 'permit', { permit_number: no, customer_name: c, service_address: a });
  const wipe2 = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
  const run = async (docs, qs) => H.as('electrical', async (db) => { await wipe2(db); await seedDocs(db, docs); const o = []; for (const q of qs) o.push(await ask(db, q)); return o; });
  for (const seed of [1, 2, 3]) {
    const r = rng(seed * 17); const c = pick(r, CUST); const st = `${10 + Math.floor(r() * 80)} ${pick(r, STREETS)} Street`; const A = `${st}, Mesa AZ`;
    // address-only / customer-only cards
    let [a1, a2] = await run([P('EL-26-100', c, A), doc('f1.pdf', 'inspection-report', { service_address: A, inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-07-20' }), doc('f2.pdf', 'inspection-report', { customer_name: c, inspection_type: 'Final', inspection_result: 'Not approved', service_date: '2026-07-23' })], [`How many failed inspections at ${st}?`, `Did ${st} pass final inspection?`]);
    check(`L5-A s${seed}: address question counts the customer-only failed card (or declines)`, a1 == null || leadNumber(a1.text) === 1, a1?.text);
    check(`L5-A s${seed}: address final result is the newest (July 23, not approved) or declines`, a2 == null || !/Passed/.test(a2.text), a2?.text);
    [a1] = await run([P('EL-26-200', c, A), doc('f1.pdf', 'inspection-report', { permit_number: 'EL-26-200', inspection_type: 'Final', inspection_result: 'Not approved', service_date: '2026-08-21' }), doc('f2.pdf', 'inspection-report', { service_address: A, inspection_type: 'Rough-in', inspection_result: 'Rejected', service_date: '2026-06-14' })], [`How many failed inspections does ${c} have?`]);
    check(`L5-A s${seed}: customer question counts the address-only failed card (2)`, a1 == null || leadNumber(a1.text) === 2, a1?.text);
    [a1] = await run([P('EL-26-1', c, A), doc('f.pdf', 'inspection-report', { inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-07-01', customer_name: c })], [`Which permits are still open for ${c}?`, 'How many open permits do we have?']);
    check(`L5-A s${seed}: a customer-only passed final closes the customer's permit`, a1 == null || /^(?:None|0)|has a passed final/.test(a1.text), a1?.text);
    const [b1, b2] = await run([P('EL-26-1', 'Gamma Inc', A), P('EL-26-2', 'Delta Foods', A), doc('f.pdf', 'inspection-report', { service_address: A, inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-07-01' })], ['How many failed inspections does Gamma Inc have?', 'How many failed inspections does Delta Foods have?']);
    check(`L5-A s${seed}: an address-only failure at a shared address is never "none" for either customer`, b1 == null && b2 == null, `${b1?.text} | ${b2?.text}`);
  }
  // serial-numbered units, retests, two cities
  const T = (fn, f) => doc(fn, 'test-report', f);
  let [t1, t2, t3] = await run([T('a.pdf', { equipment_type: 'Generator', service_address: '10 Alder Street, Mesa AZ', serial_number: 'SN-111', service_date: '2025-06-01', next_test_due: '2026-06-01' }), T('b.pdf', { equipment_type: 'Generator', service_address: '10 Alder Street, Mesa AZ', serial_number: 'SN-222', service_date: '2026-03-01', next_test_due: '2027-03-01' })], ['Which generator tests are overdue?', 'Which tests are due in the next 30 days?', 'Which generator tests are overdue at 10 Alder Street?']);
  check('L5-B: two generators (serial numbers) at one address: the overdue one is not hidden (1 overdue)', t1 != null && leadNumber(t1.text) === 1, t1?.text);
  [t1, t2] = await run([T('a.pdf', { equipment_type: 'Generator', service_address: '10 Alder Street, Mesa AZ', service_date: '2025-06-01', next_test_due: '2026-06-01' }), T('b.pdf', { equipment_type: 'Generator Load Test', service_address: '10 Alder Street, Mesa AZ', service_date: '2026-06-05', next_test_due: '2027-06-05' })], ['Which generator tests are overdue?', 'Which tests are overdue?']);
  check('L5-B: an older "Generator" report beside a newer "Generator Load Test" retest is not called overdue (decline)', t1 == null && t2 == null, `${t1?.text} | ${t2?.text}`);
  [t1] = await run([T('a.pdf', { equipment_type: 'Generator', service_address: '10 Alder Street, Mesa AZ', service_date: '2025-06-01', next_test_due: '2026-06-01' }), T('b.pdf', { equipment_type: 'Generator', service_address: '10 Alder Street, Mesa AZ', next_test_due: '2027-06-05' })], ['Which tests are overdue?']);
  check('L5-B: a retest with no printed service date beside an older dated one declines', t1 == null, t1?.text);
  [t1, t2] = await run([T('a.pdf', { equipment_type: 'Generator', service_address: '12 Alder Street, Mesa AZ', service_date: '2025-01-01', next_test_due: '2026-01-01' }), T('b.pdf', { equipment_type: 'Generator', service_address: '12 Alder Street, Gilbert AZ', service_date: '2026-07-01', next_test_due: '2027-07-01' })], ['Is the generator test at 12 Alder Street overdue?', 'Which tests are overdue?']);
  check('L5-B: the same street in two cities is two generators (the Mesa one is overdue)', t1 != null && /Mesa|overdue since/.test(`${t1.text} ${JSON.stringify(t1.facts)}`) && t2 != null && leadNumber(t2.text) === 1, `${t1?.text} | ${t2?.text}`);
  [t1] = await run([T('a.pdf', { equipment_type: 'Cummins 100kW standby', service_address: '1 A Street, Mesa AZ', service_date: '2025-01-01', next_test_due: '2026-01-01' }), T('b.pdf', { equipment_type: 'Generator', service_address: '2 B Street, Mesa AZ', service_date: '2025-01-01', next_test_due: '2026-01-01' })], ['Which generator tests are overdue?']);
  check('L5-B: a report whose equipment kind is not recognisable declines an equipment-filtered list', t1 == null, t1?.text);
  // renewals written without prefix
  for (const [oldN, newN] of [['ROC-318244', '318244'], ['ROC-318244', 'C-11 318244'], ['ROC-318244', 'roc318244']]) {
    const [r1, r2] = await run([doc('a.pdf', 'contractor-license', { license_number: oldN, license_expiry: '2025-12-31' }), doc('b.pdf', 'contractor-license', { license_number: newN, license_expiry: '2027-12-31' })], ['Which licenses have already expired?', 'Which licenses expire in the next 60 days?']);
    check(`L5-C: renewal "${newN}" of ${oldN} is never reported as an expired license`, r1 == null || !/^[1-9]/.test(r1.text), r1?.text);
    check(`L5-C: renewal "${newN}" of ${oldN} is not counted twice in a window`, r2 == null || !/^2\b/.test(r2.text), r2?.text);
  }
  // negations and directions
  const L = [doc('a.pdf', 'contractor-license', { license_number: 'ROC-111111', license_expiry: addDays(TODAY, 15) }), doc('b.pdf', 'contractor-license', { license_number: 'ROC-222222', license_expiry: '2028-12-31' }), doc('c.pdf', 'contractor-license', { license_number: 'ROC-333333', license_expiry: '2025-01-31' })];
  const negs = await run([...L, T('t.pdf', { equipment_type: 'Generator', service_address: '1 A Street, Mesa AZ', service_date: '2025-01-01', next_test_due: '2026-01-01' })], ["Which licenses won't expire in the next 30 days?", 'Which licenses are not expiring soon?', 'Which licenses expire after the next 30 days?', 'Which licenses expire in 60 days or more?', 'Which tests are not overdue?', 'Which tests are not due in the next 30 days?', 'Which tests are due next year?', 'Which tests are due this week?']);
  negs.forEach((n, i) => check(`L5-G: negated / directional / calendar question #${i} is not answered with the opposite list`, n == null, n?.text));
  // extractor
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const has = (r, k) => r?.fields.find((x) => x.key === k)?.value ?? null;
  check('L5-E: a date after the permit number is not part of the number', has(ex('ELECTRICAL PERMIT\nPermit No: EL-26-81234 03/02/2026\nSite Address: 9 A St, Mesa AZ'), 'permit_number') === 'EL-26-81234');
  check('L5-E: dates after license / bond / policy numbers are not part of them', has(ex('CONTRACTOR LICENSE\nLicense No: ROC-318244  12/31/2027\nLicense Expires: 12/31/2027'), 'license_number') === 'ROC-318244' && has(ex('CONTRACTOR LICENSE BOND\nBond No: SB-90311 08/15/2027\nBond Expires: 08/15/2027'), 'bond_number') === 'SB-90311' && has(ex('CERTIFICATE OF LIABILITY INSURANCE\nPolicy No: GL-4410-2291 08/15/2026 08/15/2027\nPolicy Expires: 08/15/2027'), 'policy_number') === 'GL-4410-2291');
  check('L5-E: a class code after the license number is not part of it', has(ex('CONTRACTOR LICENSE\nLicense No: ROC 318244 CR-11\nLicense Expires: 12/31/2027'), 'license_number') === 'ROC 318244' && has(ex('CONTRACTOR LICENSE\nLicense No: ROC-318244 C-11\nLicense Expires: 12/31/2027'), 'license_number') === 'ROC-318244');
  check('L5-F: the owner, not the applicant (the contractor), is the permit customer', has(ex('ELECTRICAL PERMIT\nPermit No: EL-26-81234\nApplicant: Desert Line Electric LLC\nOwner: Gamma Inc\nSite Address: 9 Alder Street, Mesa AZ'), 'customer_name') === 'Gamma Inc');
  const tr = ex('GENERATOR LOAD TEST REPORT\nSite Address: 1 A Street, Mesa AZ\nEquipment: Cummins 100kW standby\nDate Tested: 01/01/2025\nNext Test Due: 01/01/2026');
  check('L5-7: a test report keeps the kind of test from its title even with an Equipment line', has(tr, 'equipment_type') === 'Generator' && has(tr, 'equipment_detail') === 'Cummins 100kW standby');
  check('L5-7: a "Panel:" line on a thermography report does not replace the kind of test', has(ex('THERMOGRAPHY TEST REPORT\nSite Address: 1 A Street, Mesa AZ\nPanel: MDP-1\nDate Tested: 01/01/2025'), 'equipment_type') === 'Thermography');
  check('L5-J: an ACORD certificate with a CANCELLATION heading keeps its expiry', has(ex('CERTIFICATE OF LIABILITY INSURANCE\nInsurer: Summit Mutual\nPolicy No: GL-4410-2291\nPolicy Expires: 08/15/2027\nCERTIFICATE HOLDER\nCANCELLATION\nSHOULD ANY OF THE ABOVE DESCRIBED POLICIES BE\nCANCELLED BEFORE THE EXPIRATION DATE THEREOF'), 'policy_expiry') === '2027-08-15');
  // undated / same-day unresolved failures
  const [u1, u2] = await run([P('EL-26-9', 'Gamma Inc', '9 Fern Street, Mesa AZ'), doc('x.pdf', 'inspection-report', { permit_number: 'EL-26-9', inspection_type: 'Rough-in', inspection_result: 'Failed' }), doc('y.pdf', 'inspection-report', { permit_number: 'EL-26-9', inspection_type: 'Rough-in', inspection_result: 'Passed', service_date: '2026-05-01' })], ['Which failed inspections are unresolved?', 'How many unresolved failed inspections do we have?']);
  check('L5-U: an undated failed rough-in is not "resolved" by an earlier pass', u1 == null && u2 == null, `${u1?.text} | ${u2?.text}`);
  const [s1] = await run([P('EL-26-9', 'Gamma Inc', '9 Fern Street, Mesa AZ'), doc('x.pdf', 'inspection-report', { permit_number: 'EL-26-9', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-05-01' }), doc('y.pdf', 'inspection-report', { permit_number: 'EL-26-9', inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-05-01' })], ['Which failed inspections are unresolved?']);
  check('L5-U: a failure and a pass on the same day: order unknown, declines', s1 == null, s1?.text);
}

/** Review loop 2 (electrical): address spellings, filler words inside customer names, ever-failed, none-corrections, panel/load, certificate status, window words, extractor titles and repeated values. */
export async function runElectricalReviewLoop2({ H, lane, attention, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
  const P = (no, c, a, extra = {}) => doc(`p-${no}.pdf`, 'permit', { permit_number: no, customer_name: c, service_address: a, ...extra });
  const C = (fn, f) => doc(fn, 'inspection-report', f);
  const wipe2 = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
  const run = async (docs, qs) => H.as('electrical', async (db) => { await wipe2(db); await seedDocs(db, docs); const o = []; for (const q of qs) o.push(await ask(db, q)); return o; });
  // 1/2/3 address spellings
  for (const [a, b, q, n] of [['12 North Alder Street, Mesa AZ', '12 N Alder St, Mesa AZ', 'How many failed inspections at 12 North Alder Street?', 1], ['12 N Alder St, Mesa AZ', '12 North Alder Street, Mesa AZ', 'How many failed inspections at 12 N Alder St?', 1], ['7 Birch Road Suite 4, Mesa AZ', '7 Birch Rd Ste 4, Mesa AZ', 'How many failed inspections at 7 Birch Rd Ste 4?', 1], ['7 Birch Road Suite 4, Mesa AZ', '7 Birch Road #4, Mesa AZ', 'How many failed inspections at 7 Birch Rd Ste 4?', 1], ['7 Birch Road, Suite 4, Mesa AZ', '7 Birch Rd Unit 4, Mesa AZ', 'How many failed inspections at 7 Birch Rd #4?', 1]]) {
    const [r] = await run([P('EL-26-1', 'Gamma Inc', a), C('c.pdf', { service_address: b, inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-07-01' })], [q]);
    check(`L6-1: "${a}" / "${b}" asked "${q}" counts ${n} (or declines)`, r == null || leadNumber(r.text) === n, r?.text);
  }
  { const [r, o] = await run([P('EL-26-20001', 'A Co', '1 Fern St, Unit B, Mesa AZ'), P('EL-26-20002', 'B Co', '2 Fern St, Mesa AZ'), P('EL-26-20003', 'C Co', '3 Fern St, Suite 200, Mesa AZ'), P('EL-26-20004', 'D Co', '4 Fern St, Mesa Arizona'), P('EL-26-20005', 'E Co', '5 Fern St, Gilbert AZ'), C('f.pdf', { permit_number: 'EL-26-20002', inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-07-01' })], ['How many permits are in Mesa?', 'How many open permits in Mesa?']);
    check('L6-3: permits in Mesa counts 4 however the second address part is written (or declines)', r == null || leadNumber(r.text) === 4, r?.text);
    check('L6-3: open permits in Mesa = 3 of 4 (or declines)', o == null || /^3 of the 4/.test(o.text), o?.text); }
  // 4/5 filler/qualifier words inside customer names
  { const rows = [P('EL-26-10001', 'Choice Dental', '1 Alder St, Mesa AZ'), C('a.pdf', { permit_number: 'EL-26-10001', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-07-01' }), P('EL-26-10002', 'First Choice Dental', '2 Birch St, Mesa AZ'), C('b.pdf', { permit_number: 'EL-26-10002', inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-07-01' })];
    const [a, b, c] = await run(rows, ['How many failed inspections does First Choice Dental have?', 'Did First Choice Dental pass final inspection?', 'How many failed inspections does Choice Dental have?']);
    check('L6-4: "First Choice Dental" has 0 failed (never Choice Dental\'s failure)', a == null || /^No failed/.test(a.text), a?.text);
    check('L6-4: First Choice Dental final = Passed', b == null || (/Passed/.test(b.text) && !/Failed/.test(b.text)), b?.text);
    check('L6-4: Choice Dental has 1 failed', c == null || leadNumber(c.text) === 1, c?.text); }
  for (const [name, expect] of [['Final Touch Painting', 2], ['Rough Rider Saloon', 2], ['Open Door Realty', 2], ['Pending Hope Church', 2]]) {
    const [a] = await run([P('EL-26-11001', name, '3 Cedar St, Mesa AZ'), C('a.pdf', { permit_number: 'EL-26-11001', inspection_type: 'Rough-in', inspection_result: 'Failed', service_date: '2026-05-01' }), C('b.pdf', { permit_number: 'EL-26-11001', inspection_type: 'Rough-in', inspection_result: 'Passed', service_date: '2026-06-01' }), C('c.pdf', { permit_number: 'EL-26-11001', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-07-01' })], [`How many failed inspections does ${name} have?`]);
    check(`L6-5: "${name}": both failures counted (words inside the name are not filters)`, a == null || (leadNumber(a.text) === expect && !/unresolved/.test(a.text)), a?.text);
  }
  // 6 none corrections
  for (const res of ['Corrections Required: None', 'Corrections required: 0', 'Corrections needed: none', 'Corrections Required: N/A']) {
    const [a] = await run([P('EL-26-30001', 'Gamma Inc', '9 Cedar St, Mesa AZ'), C('c.pdf', { permit_number: 'EL-26-30001', inspection_type: 'Final', inspection_result: res, service_date: '2026-07-01' })], ['How many failed inspections does Gamma Inc have?']);
    check(`L6-6: result "${res}" is not a failed inspection`, a == null || /^No failed/.test(a.text), a?.text);
  }
  // 7 ever failed
  { const rows = [P('EL-26-40001', 'Gamma Inc', '9 Cedar St, Mesa AZ'), C('a.pdf', { permit_number: 'EL-26-40001', inspection_type: 'Rough-in', inspection_result: 'Failed', service_date: '2026-05-01' }), C('b.pdf', { permit_number: 'EL-26-40001', inspection_type: 'Rough-in', inspection_result: 'Passed', service_date: '2026-06-01' })];
    for (const q of ['Has the rough inspection at 9 Cedar St ever failed?', 'Is there a failed inspection at 9 Cedar St?', 'Has 9 Cedar St failed any inspection?', 'Has the rough inspection at 9 Cedar St ever passed?']) { const [a] = await run(rows, [q]); check(`L6-7: "${q}" is not answered with the newest result as a yes/no`, a == null || (/ever passed/.test(q) ? false : leadNumber(a.text) === 1), a?.text); } }
  // 8 panel from a generator record; 9 load calc revisions
  { const [a, b] = await run([doc('g.pdf', 'equipment-record', { equipment_type: 'Generator', service_address: '8 Ivy Rd, Mesa AZ', amperage: '60', voltage: '240V', phase: 'single-phase' })], ['What is the panel size at 8 Ivy Rd?', 'What voltage is the panel at 8 Ivy Rd?']);
    check('L6-8: a generator record is not a panel', a == null && b == null, `${a?.text} | ${b?.text}`);
    const [c] = await run([doc('p.pdf', 'panel-schedule', { service_address: '9 Ivy Rd, Mesa AZ', phase: 'single-phase' })], ['What is the panel size at 9 Ivy Rd?']);
    check('L6-8: asking the panel size when only the phase is written declines', c == null, c?.text);
    const [d] = await run([doc('u.pdf', 'utility-application', { service_address: '9 Ivy Rd, Mesa AZ', amperage: '200' })], ['What is the panel size at 9 Ivy Rd?']);
    check('L6-8: a utility application (proposed service) is not the panel size', d == null, d?.text); }
  { for (const order of [0, 1]) { const L = [doc('l1.pdf', 'load-calculation', { service_address: '5 Ivy Rd, Mesa AZ', demand_load: '40 kVA', service_date: '2026-08-01' }), doc('l2.pdf', 'load-calculation', { service_address: '5 Ivy Rd, Mesa AZ', demand_load: '30 kVA', service_date: '2026-02-01' })]; if (order) L.reverse();
      const [a] = await run(L, ['What is the demand load at 5 Ivy Rd?']); check(`L6-9: two load calculations: the newest (40 kVA) is shown whatever the storage order (${order})`, a == null || (/40 kVA/.test(a.text) && !/30 kVA/.test(a.text.replace(/newest/, ''))), a?.text); }
    const [u] = await run([doc('l1.pdf', 'load-calculation', { service_address: '5 Ivy Rd, Mesa AZ', demand_load: '40 kVA' }), doc('l2.pdf', 'load-calculation', { service_address: '5 Ivy Rd, Mesa AZ', demand_load: '30 kVA' })], ['What is the demand load at 5 Ivy Rd?']);
    check('L6-9: two undated different load calculations decline', u == null, u?.text); }
  // certificate status
  for (const st of ['Pending', 'Incomplete', 'Not Complete', 'On Hold', 'Draft', 'In Progress', 'Scheduled', 'Submitted', 'Awaiting signature']) {
    const [a] = await run([P('EL-26-1', 'Gamma Inc', '9 Fern Street, Mesa AZ'), doc('cert.pdf', 'certificate-of-completion', { permit_number: 'EL-26-1', inspection_result: st })], ['Which permits are still open for Gamma Inc?']);
    check(`L6-C: a certificate with status "${st}" does not close the permit`, a == null || !/has a passed final/.test(a.text), a?.text);
  }
  // window words
  { const L = [-100, -10, -3, 5, 20, 40, 70, 200].map((o, i) => doc(`l${i}.pdf`, 'contractor-license', { license_number: `ROC-${i}${i}7${(i * 37) % 10}${i + 3}9`, license_expiry: addDays(TODAY, o) }));
    const qs = ['Which licenses expired over 30 days ago?', 'Which licenses expired 30 days ago?', 'Which licenses expired over a month ago?', 'Which licenses expire in 30+ days?', 'Which licenses expire 60 days from now or later?', 'Which licenses are expiring in less than 30 days?', 'licenses expiring 7 days', 'Which licenses are about to expire but haven\'t yet?', 'Which licenses expire within 60 days and which are expired?', 'Which licenses expire exactly 5 days from now?', 'Which licenses expire on 2026-10-10?', 'Which tests are due a week from now?', 'Which tests are due within 10 days and which are overdue?', 'When does license ROC-100003 expire?'];
    const out = await run(L, qs); out.forEach((a, i) => check(`L6-W: "${qs[i]}" is declined (its condition is not one the list applies)`, a == null, a?.text));
    const [g] = await run(L, ['Which licenses expire in the next 30 days?']); check('L6-W: the supported window still answers (6 within 30 days or expired = 5)', g != null && leadNumber(g.text) === 5, g?.text); }
  // extractor
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const ty = (r) => r?.type ?? null; const has = (r, k) => r?.fields.find((x) => x.key === k)?.value ?? null;
  check('L6-X1: a letterhead with "Electrical Permit Division" above a final-inspection report is never typed as a permit (inspection report or declined)', ['inspection-report', null].includes(ty(ex('City of Mesa Electrical Permit Division\nFINAL INSPECTION REPORT\nPermit No: EL-26-1234\nResult: Failed'))));
  check('L6-X1: "NOTICE OF CORRECTIONS - ELECTRICAL PERMIT" is a correction notice', ty(ex('NOTICE OF CORRECTIONS - ELECTRICAL PERMIT\nPermit No: EL-26-1234\nCorrections Required:\n1. Label panel')) === 'correction-notice');
  check('L6-X1: "CERTIFICATE OF COMPLETION - ELECTRICAL PERMIT" and "ELECTRICAL PERMIT FINAL APPROVAL" are certificates', ty(ex('CERTIFICATE OF COMPLETION - ELECTRICAL PERMIT\nPermit No: EL-26-1234')) === 'certificate-of-completion' && ty(ex('ELECTRICAL PERMIT FINAL APPROVAL\nPermit No: EL-26-1234')) === 'certificate-of-completion');
  check('L6-X1: a plain "ELECTRICAL PERMIT" is still a permit', ty(ex('ELECTRICAL PERMIT\nPermit No: EL-26-1234\nSite Address: 1 A St, Mesa AZ')) === 'permit');
  check('L6-X2: a bond continuation page with a different expiry is not read as the first', has(ex('SURETY BOND\nBond No: SB-1\nBond Expiration: 06/30/2025', 'CONTINUATION CERTIFICATE\nBond No: SB-1\nBond Expiration: 06/30/2027'), 'bond_expiry') !== '2025-06-30');
  check('L6-X2: a renewed license page with a different expiry is not read as the first', has(ex('CONTRACTOR LICENSE\nLicense No: ROC-1\nExpires: 12/31/2024', 'CONTRACTOR LICENSE RENEWAL\nLicense No: ROC-1\nExpires: 12/31/2026'), 'license_expiry') !== '2024-12-31');
  check('L6-X2: two units on one test report are not read as the first', ex('GENERATOR LOAD TEST REPORT\nSite Address: 1 A St\nSerial No: G-100\nNext Test Due: 03/01/2027\nTRANSFER SWITCH\nSerial No: ATS-200\nNext Test Due: 09/01/2026') === null);
  check('L6-X2: two different invoice totals on two pages are not read as the first', has(ex('INVOICE\nInvoice No: 5\nTotal: $1,080.00', 'Total: $2,500.00'), 'cost') !== '1080.00');
  const RI = ex('INSPECTION REPORT\nPermit No: EL-26-1234\nInspection Type: Final\nResult: Failed\nDate of Inspection: 04/01/2026\nRe-inspection Date: 04/15/2026\nRe-inspection Result: Passed');
  check('L6-X3: a re-inspection result on the same card is kept beside the first (mixed, never only "Failed")', RI == null || /passed/i.test(has(RI, 'inspection_result') ?? ''));
  for (const [t, hasField] of [['Owner: Same as applicant', 'customer_name'], ['Owner: N/A', 'customer_name'], ['Owner: ________', 'customer_name'], ['Owner: TBD', 'customer_name']]) check(`L6-X4: "${t}" is never stored as a customer`, has(ex(`ELECTRICAL PERMIT\nPermit No: EL-26-1\nApplicant: Gamma Inc\n${t}`), hasField) !== t.split(': ')[1]);
  check('L6-X4: "Site Address: TBD" is not an address', has(ex('ELECTRICAL PERMIT\nPermit No: EL-26-1\nSite Address: TBD'), 'service_address') === null);
  check('L6-X4: "Owner/Agent: Gamma Inc" beats the applicant', has(ex('ELECTRICAL PERMIT\nPermit No: EL-26-1\nOwner/Agent: Gamma Inc\nApplicant: Volt Co'), 'customer_name') === 'Gamma Inc');
  check('L6-X4: a second label on the same line is not part of the name or address', has(ex('ELECTRICAL PERMIT\nPermit No: EL-26-1\nOwner: Gamma Inc     Phone: 555-1212'), 'customer_name') === 'Gamma Inc' && has(ex('ELECTRICAL PERMIT\nPermit No: EL-26-1\nSite Address: 9 Alder St, Mesa AZ  Parcel: 123'), 'service_address') === '9 Alder St, Mesa AZ');
  check('L6-X4: the certificate holder is not the insured', has(ex('CERTIFICATE OF LIABILITY INSURANCE\nInsurer: Summit\nPolicy No: GL-1-2\nPolicy Expires: 08/15/2027\nHolder: Gamma Inc'), 'license_holder') !== 'Gamma Inc');
  check('L6-X5: "INVOICE - Generator Load Test" is an invoice; a work order is a work order', ty(ex('INVOICE - Generator Load Test\nInvoice No: 10\nCustomer: Gamma Inc\nTotal: $450.00')) === 'invoice' && ty(ex('WORK ORDER\nTransfer switch test and service\nCustomer: Gamma Inc')) === 'work-order');
  check('L6-X5: "THERMOGRAPHY REPORT" is a test report', ty(ex('THERMOGRAPHY REPORT\nSite Address: 1 A St, Mesa AZ\nDate Tested: 01/01/2026')) === 'test-report');
  check('L6-X: a year after the permit number is not part of it', has(ex('ELECTRICAL PERMIT\nPermit No: EL-26-1234 2026'), 'permit_number') === 'EL-26-1234');
  check('L6-X: "Status: Inactive" on a license keeps no expiry', has(ex('CONTRACTOR LICENSE\nLicense No: ROC-1234\nLicense Expires: 12/31/2028\nStatus: Inactive'), 'license_expiry') === null);
  // multi-coverage COI with one unreadable expiry
  { const [a] = await run([doc('c.pdf', 'certificate-of-insurance', { policy_expiry: '2027-03-01', insurer: 'Summit' }), { filename: 'c.pdf', type: 'x', fields: [] }].slice(0, 1).map((d) => ({ ...d, fields: [...d.fields, { key: 'policy_expiry', value: '9/1/26' }] })), ['Which insurance certificates expire in the next 60 days?']);
    check('L6-X6: a coverage whose expiry cannot be read makes the insurance answer decline, never "none"', a == null, a?.text); }
}

/** Loop-3 review classes: wording the lane must not guess at (declines) and the plain forms that must still answer. */
export async function runElectricalReviewLoop3({ H, lane, attention, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
  const wipe3 = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
  for (let seed = 1; seed <= 4; seed++) {
    const r = rng(seed * 313); const st = pick(r, STREETS); const city = pick(r, ['Mesa', 'Tempe', 'Gilbert', 'Chandler']);
    const no = `EL-26-${30000 + seed}`; const c = pick(r, CUST);
    const docs = [doc('p.pdf', 'permit', { permit_number: no, customer_name: c, service_address: `${10 + seed} ${st} Street, ${city} AZ` }),
      doc('c.pdf', 'inspection-report', { permit_number: no, inspection_type: 'Final', inspection_result: 'Failed', service_date: addDays('2026-06-01', seed * 5) }),
      doc('l.pdf', 'contractor-license', { license_number: `ROC-${seed}41${seed}9`, license_expiry: addDays(TODAY, 20 * seed) }),
      doc('b.pdf', 'surety-bond', { bond_number: `SB-${seed}77`, bond_expiry: addDays(TODAY, 90) })];
    await H.as('electrical', async (db) => {
      await wipe3(db); await seedDocs(db, docs);
      for (const q of [`How many closed permits are in ${city}?`, `How many permits in ${city} or Phoenix?`,
        `How many inspections did ${c} pass?`, `Did ${c} fail an inspection last month?`, `Has ${st} failed an inspection this year?`,
        `Any failed inspection at ${10 + seed} ${st} @ Oak?`, `${10 + seed} ${st} & Oak failed inspections`, `Which licenses are still valid today?`, `Which licenses expire tomorrow?`, `Which licenses expire in 30d?`,
        `How many licenses and bonds do we have?`]) {
        const a = await ask(db, q); check(`L7-D: "${q}" is declined (wording the lane does not apply)`, a == null, a?.text);
      }
      const ok = await ask(db, `How many failed inspections at ${10 + seed} ${st} Street?`);
      check(`L7-D: the plain failed-inspection question at the address still answers 1`, ok != null && leadNumber(ok.text) === 1, ok?.text);
    });
  }
  // extractor classes
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const ty = (x) => x?.type ?? null; const has = (x, k) => x?.fields.find((f) => f.key === k)?.value ?? null;
  check('L7-X: an unambiguous dotted date 31.12.2027 is read', has(ex('CONTRACTOR LICENSE\nLicense No: ROC-9\nLicense Expires: 31.12.2027'), 'license_expiry') === '2027-12-31');
  check('L7-X: an ambiguous dotted date 03.04.2027 is not read', has(ex('CONTRACTOR LICENSE\nLicense No: ROC-9\nLicense Expires: 03.04.2027'), 'license_expiry') === null);
  for (const w of ['Cancelled', 'Suspended', 'Revoked', 'Replaced', 'Void', 'Lapsed']) check(`L7-X: "Status: ${w}" keeps no expiry`, has(ex(`SURETY BOND\nBond No: SB-1\nBond Expiration: 12/31/2028\nStatus: ${w}`), 'bond_expiry') === null);
  check('L7-X: a mixed permit + inspection page is never typed as a permit', ty(ex('ELECTRICAL PERMIT\nPermit No: EL-26-1\nINSPECTION REPORT\nResult: Failed')) == null);
  check('L7-X: a number-less license keeps its expiry only as an unnumbered paper (no invented number)', has(ex('CONTRACTOR LICENSE\nExpires: 12/31/2028'), 'license_number') === null);
}

/** Loop-4 review classes: dropped negations / qualifiers, credential words in names, ZIP+4 cities, late notices, mixed equipment, extractor label bleed. */
export async function runElectricalReviewLoop4({ H, lane, attention, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
  const wipe4 = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
  for (let seed = 1; seed <= 3; seed++) {
    const r = rng(seed * 917); const st = pick(r, STREETS); const c = pick(r, CUST); const n0 = 40000 + seed * 10;
    const docs = [];
    const addr = (i) => `${20 + i} ${st} Road, Mesa AZ 8520${i}${i === 1 ? '-5678' : ''}`;
    for (let i = 0; i < 3; i++) {
      docs.push(doc(`p${i}.pdf`, 'permit', { permit_number: `EL-26-${n0 + i}`, customer_name: i === 0 ? c : `Other ${i}`, service_address: addr(i) }));
      docs.push(doc(`c${i}.pdf`, 'inspection-report', { permit_number: `EL-26-${n0 + i}`, inspection_type: i % 2 ? 'Final' : 'Rough-in', inspection_result: 'Failed', service_date: addDays('2026-06-01', i * 9) }));
    }
    docs.push(doc('n.pdf', 'correction-notice', { permit_number: `EL-26-${n0}`, inspection_type: 'Rough-in', service_date: addDays('2026-06-01', 30) }));
    docs.push(doc('b.pdf', 'surety-bond', { bond_number: 'SB-1', bond_expiry: addDays(TODAY, 20) }));
    docs.push(doc('t1.pdf', 'test-report', { equipment_type: 'Generator Transfer Switch', service_address: addr(0), next_test_due: addDays(TODAY, -10), service_date: '2025-01-01' }));
    await H.as('electrical', async (db) => {
      await wipe4(db); await seedDocs(db, docs);
      for (const q of ['Which open permits are not in Mesa?', 'Which failed inspections are not rough-in?', 'Which failed inspections are not finals?', `Which failed inspections are not for ${c}?`,
        'Which failed inspections are closed?', 'What was the last failed inspection?', 'Any new failed inspections?', 'How many permits have been finaled?', 'How many inspections are pending?', 'Which open permits have no inspections?', 'How many open permits by city?',
        `How many unresolved failed inspections does ${c} have?`, `When did ${20} ${st} Road get its permit?`, 'Which licenses are past due?', 'Did ' + c + ' pass all its inspections?', 'What tests are due in the next -5 days?', 'Which generator tests are overdue?']) {
        const a = await ask(db, q); check(`L8-D: "${q}" is declined`, a == null, a?.text);
      }
      const m = await ask(db, 'How many permits are in Mesa?'); check('L8-C6: a ZIP+4 address still counts in its city (3 of 3)', m != null && leadNumber(m.text) === 3, m?.text);
      const fi = await ask(db, `How many failed inspections does ${c} have?`); check('L8-C7: a correction notice dated weeks after its failed card is the same failure (1)', fi != null && leadNumber(fi.text) === 1, fi?.text);
    });
  }
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const has = (x, k) => x?.fields.find((f) => f.key === k)?.value ?? null;
  const P = (t) => `ELECTRICAL PERMIT\nPermit No: E-1\n${t}`;
  for (const [t, k] of [['Owner:      Contractor: Volt Bros Electric', 'customer_name'], ['Customer: Date: 10/05/2026', 'customer_name'], ['Bill To: Ship To: 12 Oak St', 'customer_name'], ['Job Address: 123 Main St Unit: 4B Austin TX', 'service_address'], ['Site Address: 123 Main St City: Austin State: TX', 'service_address'], ['Owner: John Smith (555) 123-4567', 'customer_name'], ['Bill To: Mr. Smith - 12 Oak St', 'customer_name']]) check(`L8-X: "${t}" gives no ${k}`, has(ex(P(t)), k) === null);
  check('L8-X: the next label\'s first word is not part of the name', has(ex(P('Customer: John Smith Service Address: 12 Oak St Austin TX')), 'customer_name') === 'John Smith');
  check('L8-X: a mailing address is not part of the service address', has(ex(P('Job Address: 12 Oak St Mailing Address: PO Box 3')), 'service_address') === '12 Oak St');
  for (const [t, v] of [['Invoice #: 5521 NET 30', '5521'], ['Invoice #: 5521 PO 4488', '5521'], ['Invoice #: 5521    555-123-4567', '5521'], ['Invoice #: 5521 05-Oct-2026', '5521'], ['Invoice #: 5521 2026/10/05', '5521']]) check(`L8-X: "${t}" keeps only the number`, has(ex(`INVOICE\n${t}`), 'invoice_number') === v);
  for (const w of ['Surrendered', 'Forfeited', 'Delinquent', 'Not Active', 'Closed', 'Denied']) check(`L8-X: license "Status: ${w}" keeps no expiry`, has(ex(`CONTRACTOR LICENSE\nLicense No: EC-12345\nStatus: ${w}\nExpires: 12/31/2027`), 'license_expiry') === null);
  check('L8-X: "Status: VOID" permit records its status (so the lane declines it)', /void/i.test(has(ex('ELECTRICAL PERMIT\nPermit No: E-1\nStatus: VOID\nExpires: 12/31/2027'), 'permit_status') ?? ''));
  check('L8-X: a letterhead is not the inspection type', !/temporary power/i.test(has(ex('Temporary Power Solutions LLC\nFINAL INSPECTION REPORT\nResult: Pass\nDate of Inspection: 10/01/2026'), 'inspection_type') ?? ''));
  check('L8-X: a test voltage is not the equipment voltage', has(ex('MEGGER TEST REPORT\nSite Address: 1 A St\nTest Voltage: 500 V'), 'voltage') === null);
}

/** Loop-5 review classes: unreadable / missing dates beside others, address vs customer-name words, credentials naming a customer, two kinds in a yes/no, extractor titles and label leaks. */
export async function runElectricalReviewLoop5({ H, lane, attention, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
  const wipe5 = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
  for (let seed = 1; seed <= 3; seed++) {
    const r = rng(seed * 733); const c = pick(r, CUST); const st = pick(r, STREETS); const no = `EL-26-${50000 + seed}`;
    const base = [doc('p.pdf', 'permit', { permit_number: no, customer_name: c, service_address: `${100 + seed} ${st} Street, Mesa AZ` })];
    const cards = (a, b) => [...base, doc('c1.pdf', 'inspection-report', { permit_number: no, inspection_type: 'Final', inspection_result: 'Failed', service_date: a }), doc('c2.pdf', 'inspection-report', { permit_number: no, inspection_type: 'Final', inspection_result: 'Passed', service_date: b })];
    for (const [a, b] of [['3/15/26', '2026-05-01'], [null, '2026-05-01'], ['10-Apr-26', '2026-01-05'], ['04.10.2026', '2026-01-05']]) await H.as('electrical', async (db) => {
      await wipe5(db); await seedDocs(db, cards(a, b));
      const x = await ask(db, `Did ${c} pass final inspection?`); check(`L9-A: a final dated "${a}" beside a dated one is never headlined by string order`, x == null, x?.text);
    });
    await H.as('electrical', async (db) => {
      await wipe5(db); await seedDocs(db, [doc('p.pdf', 'permit', { permit_number: no, customer_name: 'Main Street Bakery', service_address: `100 Oak Street, Mesa AZ` }), doc('c.pdf', 'inspection-report', { permit_number: no, inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-08-01' }),
        doc('b1.pdf', 'surety-bond', { bond_number: 'SB-222222', customer_name: 'Pike Brewing', bond_expiry: addDays(TODAY, 40) }), doc('b2.pdf', 'surety-bond', { bond_number: 'SB-333333', customer_name: c, bond_expiry: addDays(TODAY, 400) }), doc('l.pdf', 'contractor-license', { license_number: 'ROC-12345', license_expiry: addDays(TODAY, 90) })]);
      for (const q of ['any failed inspections at 100 Main Street', 'did 100 Main Street pass final', 'what is the permit number at 100 Main Street', 'when does the bond for Pike Brewing expire', `bond expiry for ${c}`, 'do we have a license bond on file', 'do we have any permit inspection reports on file']) { const a = await ask(db, q); check(`L9-C: "${q}" is declined`, a == null, a?.text); }
      const ok = await ask(db, 'any failed inspections at 100 Oak Street'); check('L9-C: the real address still answers (1)', ok != null && leadNumber(ok.text) === 1, ok?.text);
    });
  }
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const ty = (x) => x?.type ?? null; const has = (x, k) => x?.fields.find((f) => f.key === k)?.value ?? null;
  for (const t of ['ELECTRICAL PERMIT INVOICE\nInvoice No: 8812\nTotal Due: $185.00', 'Generator Test Invoice\nInvoice No: 8812\nTotal Due: $485.00', 'Load Calculation Invoice\nInvoice No: 7\nTotal Due: $450.00']) check(`L9-X: "${t.split('\n')[0]}" is an invoice`, ty(ex(t)) === 'invoice');
  for (const t of ['Final Inspection Fee Estimate\nEstimate No: 12\nTotal: $200.00', 'Arc Flash Study Proposal\nProposal No: 7\nTotal: $4,500.00']) check(`L9-X: "${t.split('\n')[0]}" is a quote`, ty(ex(t)) === 'proposal-quote');
  check('L9-X: a company letterhead starting "Quote" does not hide the INVOICE title', [ 'invoice', null ].includes(ty(ex('Quote Electric LLC\nINVOICE\nInvoice No: 4421\nTotal Due: $300.00'))));
  check('L9-X: two different money titles are never guessed', ty(ex('INVOICE\nESTIMATE\nInvoice No: 4421\nTotal Due: $300.00')) == null);
  check('L9-X: a sentence is not a title', ty(ex('Dear Mr Smith,\nYour final inspection passed on 10/05/2026.\nThank you')) == null);
  check('L9-X: an invoice due date is not a correction due date', has(ex('INVOICE\nInvoice No: 5\nDue Date: 11/06/2026\nTotal: $10.00'), 'correction_due') === null);
  check('L9-X: an invoice status is not an inspection result', has(ex('INVOICE\nInvoice No: 5\nStatus: Paid\nTotal: $10.00'), 'inspection_result') === null);
  check('L9-X: a license status is not an inspection result', has(ex('CONTRACTOR LICENSE\nLicense No: EC-1\nStatus: Expired\nExpires: 06/30/2027'), 'inspection_result') === null);
  check('L9-X: permit boilerplate is not the permit status', has(ex('ELECTRICAL PERMIT\nPermit No: E-5\nThis permit becomes void when work is suspended or abandoned for 180 days.'), 'permit_status') === null);
  check('L9-X: two customers on one paper are not guessed', has(ex('INVOICE\nInvoice No: 5\nCustomer: Smith\nCustomer: Jones\nTotal: $10.00'), 'customer_name') === null);
  check('L9-X: a date with an extra digit is not read', has(ex('CONTRACTOR LICENSE\nLicense No: EC-1\nExpires: 10/07/20267'), 'license_expiry') === null);
  check('L9-X: a trailing separator is not part of the value', has(ex('INSPECTION REPORT\nPermit No: E-5\nResult: Pass | Inspector: M. Ruiz'), 'inspection_result') === 'Pass');
  check('L9-X: a feeder voltage is not the panel voltage', has(ex('PANEL SCHEDULE\nPanel: LP-1 (Fed from MDP 480V)\nMain Breaker: 100 A'), 'voltage') === null);
}

/** Loop-6 review classes: unknown result words, reissued permit papers, same-key tests with different due dates, longer customer names, unlinked variant-name cards, extractor id / label / type leaks. */
export async function runElectricalReviewLoop6({ H, lane, attention, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
  const wipe6 = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
  for (let seed = 1; seed <= 3; seed++) {
    const r = rng(seed * 577); const c = pick(r, CUST); const st = pick(r, STREETS); const no = `EL-26-${60000 + seed}`; const addr = `${5 + seed} ${st} Street, Mesa AZ`;
    const permit = (extra = {}) => doc('p.pdf', 'permit', { permit_number: no, customer_name: c, service_address: addr, ...extra });
    const card = (res, d = '2026-08-01', t = 'Final', more = {}) => doc(`c-${res}-${d}.pdf`, 'inspection-report', { permit_number: no, inspection_type: t, inspection_result: res, service_date: d, ...more });
    const cases = [
      ...['Faild', 'UNSAT', 'Deficient', 'Rejectd', 'Needs rework', 'Pased', 'Satisfactry', 'Complete', 'Signed off'].map((w) => [`result "${w}"`, [permit(), card(w)], [`How many failed inspections does ${c} have?`, 'Which permits are open?']]),
      ['a failed final newer than a passed final', [permit(), card('Passed', '2026-06-01'), card('Failed', '2026-08-01')], ['Which permits are open?', `How many open permits does ${c} have?`]],
      ['a reissued permit paper', [permit({ permit_issue_date: '2026-01-05', jurisdiction: 'City of Mesa' }), doc('p2.pdf', 'permit', { permit_number: no, customer_name: c, service_address: addr, permit_issue_date: '2026-05-09', jurisdiction: 'City of Tempe' })], [`When was the permit at ${5 + seed} ${st} Street issued?`, `Who issued the permit at ${5 + seed} ${st} Street?`]],
      ['same unit and date, different due dates', [doc('t1.pdf', 'test-report', { equipment_type: 'Generator', service_address: addr, service_date: '2025-09-01', next_test_due: '2026-03-01' }), doc('t2.pdf', 'test-report', { equipment_type: 'Generator', service_address: addr, service_date: '2025-09-01', next_test_due: '2026-12-01' })], ['Which generator tests are overdue?', 'Which tests are overdue?']],
      ['a test report that names no equipment', [doc('report-1.pdf', 'test-report', { service_address: addr, service_date: '2025-03-01', next_test_due: '2026-03-01' }), doc('report-2.pdf', 'test-report', { service_address: addr, service_date: '2025-09-01', next_test_due: '2026-12-01' })], ['Which tests are overdue?']],
      ['a longer customer name', [doc('p.pdf', 'permit', { permit_number: no, customer_name: `${c} West`, service_address: addr }), card('Failed')], [`How many failed inspections does ${c} have?`, `Did ${c} pass final inspection?`]],
      ['a card under a variant customer name', [permit(), doc('v.pdf', 'inspection-report', { customer_name: `${c}orporated`, inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-08-01' })], [`How many failed inspections does ${c} have?`]],
      ['a permit with a written status', [doc('p.pdf', 'permit', { permit_number: no, customer_name: c, service_address: addr, status: 'Cancelled' })], ['Which permits are open?']],
    ];
    for (const [label, docs, qs] of cases) await H.as('electrical', async (db) => { await wipe6(db); await seedDocs(db, docs); for (const q of qs) { const a = await ask(db, q); check(`L10: ${label}: "${q}" is declined`, a == null, a?.text); } });
  }
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const has = (x, k) => x?.fields.find((f) => f.key === k)?.value ?? null;
  for (const [t, v] of [['B26 12345', 'B26 12345'], ['E26 0451', 'E26 0451'], ['E1 2026-0451', 'E1 2026-0451']]) check(`L10-X: permit id "${t}" is not cut at a class-code-looking token`, [v, null].includes(has(ex(`ELECTRICAL PERMIT\nPermit No: ${t}`), 'permit_number')) && has(ex(`ELECTRICAL PERMIT\nPermit No: ${t}`), 'permit_number') !== t.split(' ')[1]);
  check('L10-X: "No. 26-1" echoes no label', ![ 'No. 26-1' ].includes(has(ex('ELECTRICAL PERMIT\nPermit No: No. 26-1'), 'permit_number')));
  for (const t of ['ELECTRICAL PERMIT\nPermit No: 26-9921\nDate: 10/01/2026', 'CONTRACTOR LICENSE\nLicense No: EC-1\nDate: 01/01/2026\nExpires: 12/31/2026', 'SURETY BOND\nBond No: SB-1\nDate: 03/15/2026']) check(`L10-X: a generic Date on a paper with no service has no service_date (${t.split('\n')[0]})`, has(ex(t), 'service_date') === null);
  check('L10-X: "Inspection: Passed" is not an inspection type', has(ex('INSPECTION REPORT\nPermit No: 26-1\nInspection: Passed\nDate: 10/10/2026'), 'inspection_type') === null);
  check('L10-X: a permit work "Type:" is not an inspection type', has(ex('ELECTRICAL PERMIT\nPermit No: 26-9921\nType: Service Upgrade'), 'inspection_type') === null);
  check('L10-X: a template checkbox result is not kept', has(ex('INSPECTION REPORT\nPermit No: 26-1\nResult: [ ] Pass [X] Fail'), 'inspection_result') === null);
  check('L10-X: "Status: Scheduled" is not a result', has(ex('INSPECTION REPORT\nPermit No: 26-1\nStatus: Scheduled\nInspection Type: Final'), 'inspection_result') === null);
  for (const [t, k] of [['Owner: Jane Doe Phone #: 555-1234', 'customer_name'], ['Owner: Jane Doe, 1420 Oak St', 'customer_name'], ['Owner: Homeowner', 'customer_name'], ['Work Location: Kitchen', 'service_address'], ['Site Address: n/a - phone call', 'service_address']]) check(`L10-X: "${t}" gives a clean value or none`, ![ 'Jane Doe Phone #: 555-1234', 'Jane Doe, 1420 Oak St', 'Homeowner', 'Kitchen', 'n/a - phone call' ].includes(has(ex(`ELECTRICAL PERMIT\nPermit No: E-1\n${t}`), k)));
  check('L10-X: a bond "Issued to" is the obligee, not a holder', has(ex('SURETY BOND\nBond No: SB1\nIssued to: City of Springfield'), 'license_holder') === null);
  check('L10-X: two permit statuses on two pages are not guessed', has(ex('ELECTRICAL PERMIT\nPermit No: E-1\nStatus: Issued', 'ELECTRICAL PERMIT\nPermit No: E-1\nStatus: Expired'), 'permit_status') === null);
  check('L10-X: a letterhead starting "Estimate" does not type the paper', ex('Estimate Electric LLC\nINSPECTION REPORT\nPermit No: E26-0451\nInspection Type: Final\nResult: Pass')?.type !== 'proposal-quote');
}

/** Loop-7 review classes (compact): unlinked cards, orphan finals, odd stage words, extractor ids / labels / types. */
export async function runElectricalReviewLoop7({ H, lane, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline && !r.clarify ? r : null; };
  const doc = (filename, type, fields) => ({ filename, type, fields: Object.entries(fields).filter(([, v]) => v != null).map(([key, value]) => ({ key, value })) });
  const wipe7 = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
  const P = doc('p.pdf', 'permit', { permit_number: 'EL-26-1', customer_name: 'Gamma Inc', service_address: '12 Alder Street, Mesa AZ' });
  const cs = (extra) => doc('c.pdf', 'inspection-report', { inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-07-01', ...extra });
  const cases = [
    ['two customers failing with no permit or address', [doc('a.pdf', 'inspection-report', { customer_name: 'Gamma Inc', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-07-01' }), doc('b.pdf', 'inspection-report', { customer_name: 'Delta Foods', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-07-01' })], ['How many failed inspections do we have?', 'How many failed inspections does Delta Foods have?']],
    ['a passed final whose number matches no permit', [P, cs({ permit_number: 'EL-26-99', service_address: '12 Alder Street, Mesa AZ' })], ['Which permits are open?', 'How many open permits do we have?']],
    ['a customer-only passed final', [P, cs({ customer_name: 'Gamma Inc' })], ['How many open permits do we have?']],
    ...['Non-Final Inspection', 'Final Rough', 'Rough Final', 'Semi-Final', 'Final Framing', 'Final Inspection Request'].map((t) => [`stage "${t}" passed`, [P, cs({ permit_number: 'EL-26-1', inspection_type: t })], ['Which permits are open?', 'Did Gamma Inc pass final inspection?']]),
    ['a notice with no stage', [P, doc('n.pdf', 'correction-notice', { permit_number: 'EL-26-1', service_date: '2026-07-02', correction_items: 'Label panel' })], ['How many failed rough inspections does Gamma Inc have?', 'How many failed final inspections does Gamma Inc have?']],
    ['a one-digit house number typed in lowercase', [P, cs({ permit_number: 'EL-26-1', inspection_result: 'Failed' })], ['how many failed inspections at 7 alder', 'did 7 alder pass final']],
    ['a filename number as a house number', [P, doc('inspection 8.pdf', 'inspection-report', { permit_number: 'EL-26-1', inspection_type: 'Final', inspection_result: 'Failed', service_date: '2026-07-01' })], ['How many failed inspections at 8 Alder?']],
    ['a retest with the serial written another way', [doc('t1.pdf', 'test-report', { equipment_type: 'Generator', service_address: '12 Alder Street, Mesa AZ', serial_number: 'SN-111', service_date: '2025-06-01', next_test_due: '2026-06-01' }), doc('t2.pdf', 'test-report', { equipment_type: 'Generator', service_address: '12 Alder Street Mesa AZ', serial_number: 'SN111', service_date: '2026-06-05', next_test_due: '2027-06-05' })], ['Which tests are overdue?']],
  ];
  for (const [label, docs, qs] of cases) await H.as('electrical', async (db) => { await wipe7(db); await seedDocs(db, docs); for (const q of qs) { const a = await ask(db, q); const none = a == null || /\b(?:no|none|0)\b.*\b(?:overdue)\b/i.test(a.text) && label.startsWith('a retest'); const okA = a == null || (label.startsWith('a retest') && /^None overdue/i.test(a.text))
          || (label.startsWith('two customers') && ((/do we have/.test(q) && leadNumber(a.text) === 2) || (/Delta/.test(q) && leadNumber(a.text) === 1)))
          || (label.startsWith('a customer-only') && /^Every permit on file has a passed final/.test(a.text))
          || (label.startsWith('stage "') && (/^1 permit has no passed final/.test(a.text) || /don't see a final/.test(a.text)));
        check(`L11: ${label}: "${q}" is declined or exactly right`, okA, a?.text); } });
  const ex = (...pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const has = (x, k) => x?.fields.find((f) => f.key === k)?.value ?? null;
  check('L11-X: a date on the previous line is not the code edition year', has(ex('ELECTRICAL PERMIT\nPermit No: E-5512\nIssued: 05/13/2026\nNEC Edition: 2020'), 'code_edition') !== '2026 NEC');
  for (const t of ['E-5512 5/13', 'E-5512 12/2026']) check(`L11-X: "${t}" keeps only the id`, has(ex(`ELECTRICAL PERMIT\nPermit No: ${t}`), 'permit_number') === 'E-5512');
  for (const [t, v] of [['Customer: Pat Lee Home Phone: 555-123-4567', 'Pat Lee'], ['Customer: Pat Lee Terms Net 30', 'Pat Lee'], ['Customer: Pat Lee, pat@x.com', 'Pat Lee']]) check(`L11-X: "${t}" gives a clean name`, [v, null].includes(has(ex(`INVOICE\nInvoice No: 5\n${t}\nTotal: $9.00`), 'customer_name')));
  check('L11-X: a boilerplate sentence is not the permit status', has(ex('ELECTRICAL PERMIT\nPermit No: E-5\nPermits not used are subject to cancellation'), 'permit_status') === null);
  check('L11-X: a blank "Voided: ____" is not the permit status', has(ex('ELECTRICAL PERMIT\nPermit No: E-5\nVoided: ________'), 'permit_status') === null);
  check('L11-X: a room is not a service address', has(ex('WORK ORDER\nWork Order No: 55\nWork Location: Panel 2 in garage'), 'service_address') === null);
  check('L11-X: a load range is not read', has(ex('LOAD CALCULATION\nConnected Load: 25-30 kVA'), 'connected_load') === null);
  check('L11-X: kWh is not kW', has(ex('LOAD CALCULATION\nConnected Load: 40 kWh'), 'connected_load') === null);
  for (const t of ['FINAL APPROVAL DENIED', 'FINAL INSPECTION SCHEDULED', 'LICENSE RENEWAL', 'CERTIFICATE OF INSURANCE REQUEST']) check(`L11-X: "${t}" is not typed as the paper it talks about`, ex(`${t}\nPermit No: E-1\nLicense No: EC-1\nExpires: 06/30/2027`) == null);
}
