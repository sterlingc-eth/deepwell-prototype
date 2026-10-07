/**
 * Plumbing round-2 regressions (nightly plumbing quality run, loop 1 findings). Truth is written here by hand from the rows, not taken from the product.
 *  R1 a later page opening with a DIFFERENT title is never stored as one document   R2 "pass with conditions / Passed*" is not a plain pass
 *  L1 gas/electric/tank filters are never dropped from expiry lists   L2 a serial-less certificate is never absorbed into a serial'd device
 *  L3 "X" and "X LLC" are never silently merged or split   L4 one permit number at two addresses is two permits   L5 a failed final on/after a passed final is a conflict
 *  L6 count qualifiers (defects, technician, scheduled) are never dropped   L7 stacked adjectives (overdue + failed) are declined   L8 maker spelling variants decline
 *  L9 a future-dated ticket is never "the last service"   L10 tank/tankless disagreement between papers is not guessed   L11 attention never says "failed" for conflicting certificates
 *  E1 colon-less retest passes   E2 two Status lines   E3 several technicians on one line
 */
import { seedDocs, leadNumber } from './class-variants-core.mjs';
const TODAY = '2026-10-05';
const wipe = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };
const F = (o) => Object.entries(o).map(([key, value]) => ({ key, value }));
const D = (type, filename, o) => ({ filename, type, fields: F(o) });

export async function runPlumbingRound2({ H, lane, extract, resultClass, check }) {
  const ex = (pages) => extract(pages.map((text, i) => ({ page_no: i + 1, text })), { today: TODAY });
  const A = 'Service Address: 15 Cactus Wren Lane, Mesa AZ';
  check('R1: permit + failed final-inspection card in one file is declined', ex([`PLUMBING PERMIT\nPermit No: PL-26-777\n${A}\nStatus: Open`, `FINAL INSPECTION CARD\nPermit No: PL-26-777\nInspection Type: Final\nResult: Failed\n${A}`]) === null);
  check('R1: backflow report + service ticket in one file is declined', ex([`BACKFLOW TEST REPORT\nSerial Number: BF123\nService Address: 1 A St, Mesa AZ\nTest Date: 03/02/2026\nResult: Passed`, `SERVICE TICKET\nTechnician: Dana Ruiz\nService Address: 1 A St, Mesa AZ\nWork Performed: cleaned`]) === null);
  check('R1: a same-type second page still reads', ex([`BACKFLOW TEST REPORT\nSerial Number: BF123\n${A}\nTest Date: 03/02/2026\nResult: Passed`, `Page 2 of 2\nTester: Dana Ruiz`])?.type === 'backflow-test-certificate');
  for (const t of ['Pass w/ conditions', 'Pass with conditions', 'Passed - conditional', 'Passed with caveats', 'Passed*', 'Passed (see note)', 'Passed (temporary)', 'Passed provisionally', 'Passed - out of service', 'Passed per owner'])
    check(`R2: "${t}" is not a plain pass`, resultClass(t) !== 'passed', resultClass(t));
  check('R2: plain Passed still passes', resultClass('Passed') === 'passed' && resultClass('Pass') === 'passed');
  const bf = (extra) => ex([`BACKFLOW TEST REPORT\nSerial Number: BF123\n${A}\nTest Date: 03/02/2026\n${extra}`]);
  check('E1: "Result: Failed" then colon-less "Retest passed 03/09/2026" is declined (two tests)', bf('Result: Failed\nRetest passed 03/09/2026') === null);
  check('E1: "Repaired and retested - passed" is declined', bf('Result: Failed\nRepaired and retested - passed') === null);
  check('E1: "repair and retest required" on a failed certificate still reads as failed', bf('Result: Failed\nAssembly failed - repair and retest required')?.fields.some((x) => x.key === 'backflow_test_result' && x.value === 'Failed'));
  const pm = (b) => ex([`PLUMBING PERMIT\nPermit No: PL-26-777\n${A}\n${b}`]);
  check('E2: two different Status lines keep no status', !pm('Status: Open\nStatus: Final')?.fields.some((x) => x.key === 'permit_status'));
  const tech = (v) => ex([`SERVICE TICKET\nInvoice No: T-1\n${A}\nTechnician: ${v}\nDate: 03/02/2026`])?.fields.find((x) => x.key === 'technician')?.value ?? null;
  for (const v of ['Ann Lee, Bob Ray', 'Ann Lee (lead), Bob Ray (helper)', 'Lee, Ann', 'Ann Lee/Bob Ray', 'Ann Lee + Bob Ray', 'Ann Lee & Bob Ray']) check(`E3: technician "${v}" claims no single technician`, tech(v) === null, String(tech(v)));
  check('E3: a plain technician is still read', tech('Ann Lee') === 'Ann Lee');

  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline ? r : null; };
  const addr = '12 Elm St, Mesa AZ';
  const wr = (n, make, fuel, exp, type = 'Tank') => D('warranty-registration', `wr${n}.pdf`, { serial_number: `W${n}`, service_address: `${n} Oak Rd, Mesa AZ`, manufacturer: make, equipment_type: type, fuel_type: fuel, warranty_expires: exp, warranty_registered_date: '2024-01-01' });
  await H.as('plumbing', async (db) => {
    await wipe(db);
    await seedDocs(db, [wr(1, 'Rheem', 'Gas', '2025-12-01'), wr(2, 'Rheem', 'Gas', '2030-01-01'), wr(3, 'Bradford', 'Electric', '2025-12-01'), wr(4, 'Bradford', 'Electric', '2026-12-01')]);
    for (const q of ['Which gas water heaters have expired warranties?', 'Which electric water heater warranties are expired?', 'Which tankless water heaters have an expired warranty?', 'Which gas water heater warranties are expiring in the next 90 days?'])
      check(`L1: "${q}" is declined, never answered unfiltered`, (await ask(db, q)) === null);
    const g = await ask(db, 'How many gas water heaters have an expired warranty?');
    check('L1: the count form stays exact (1)', !g || leadNumber(g.text) === 1, g?.text);
    const un = await ask(db, 'Which water heater warranties have expired?');
    check('L1: the unfiltered expired list still answers (2)', !un || leadNumber(un.text) === 2, un?.text);
    // L8 maker variants
    await wipe(db);
    await seedDocs(db, [wr(1, 'RHEEM', 'Gas', '2030-01-01'), wr(2, 'Rheem Manufacturing', 'Gas', '2030-01-01'), wr(3, 'Bradford', 'Gas', '2030-01-01')]);
    check('L8: "How many Rheem water heaters" with two spellings on file is declined (or 2)', await (async () => { const r = await ask(db, 'How many Rheem water heaters do we have?'); return !r || leadNumber(r.text) === 2; })());
    // L10 tank / tankless disagreement
    await wipe(db);
    await seedDocs(db, [D('startup-sheet', 's1.pdf', { serial_number: 'WH9', service_address: addr, manufacturer: 'Navien', equipment_type: 'Tankless', installation_date: '2024-01-01' }), D('warranty-registration', 'r1.pdf', { serial_number: 'WH9', service_address: addr, manufacturer: 'Navien', equipment_type: 'Water Heater (tank)', warranty_expires: '2030-01-01' })]);
    check('L10: tank vs tankless disagreement is not counted as tankless', (await ask(db, 'How many tankless water heaters do we have?')) === null);
  });
  const bfd = (n, serial, date, res, due, extra = {}) => D('backflow-test-certificate', `bf${n}.pdf`, { ...(serial ? { serial_number: serial } : {}), service_address: addr, customer_name: 'Delmar Orchards', service_date: date, backflow_test_result: res, ...(due ? { next_test_due: due } : {}), ...extra });
  await H.as('plumbing', async (db) => {
    await wipe(db);
    await seedDocs(db, [bfd(1, 'S1', '2025-01-10', 'Failed', ''), bfd(2, '', '2026-06-01', 'Passed', '2027-06-01')]);
    for (const q of ['Which backflow tests failed?', 'Which backflow tests are overdue?', 'What needs attention?']) { const r = await ask(db, q); check(`L2: "${q}" never says None when a serial'd device failed and a serial-less certificate shares its address`, !r || !/^None\b/.test(r.text) || /could not be read or that disagrees/.test(r.text), r?.text); }
    const c = await ask(db, 'How many backflow devices do we track?'); check('L2: device count is not 1 (ambiguous: declined or 2)', !c || leadNumber(c.text) !== 1, c?.text);
    // L11 conflicting certificates, same device and date
    await wipe(db);
    await seedDocs(db, [bfd(1, 'DD4', '2026-03-01', 'Passed', '2027-03-01'), bfd(2, 'DD4', '2026-03-01', 'Failed', '2027-03-01')]);
    const at = await ask(db, 'What needs attention?');
    check('L11: attention never states "failed" for conflicting certificates', !at || !/\bfailed\b/i.test(at.facts.map((x) => `${x.label} ${x.value}`).join(' ')), at?.text);
    // B2 note for unreadable due date
    await wipe(db);
    await seedDocs(db, [bfd(1, 'BB2', '2026-03-01', 'Passed', ''), bfd(2, 'BB3', '2025-03-01', 'Passed', '2026-03-01')]);
    const nd = await ask(db, 'What needs attention?'); check('B2: attention says a passed device has no readable next test date', !nd || /no readable next test date/.test(nd.text), nd?.text);
    // L7 stacked adjectives
    await wipe(db);
    await seedDocs(db, [bfd(1, 'S1', '2026-01-10', 'Failed', ''), bfd(3, 'S3', '2025-01-10', 'Passed', '2026-01-10')]);
    for (const q of ['Which overdue backflow tests failed?', 'Which failed backflow tests are overdue?']) check(`L7: "${q}" is declined`, (await ask(db, q)) === null);
  });
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const inv = (n, c, t) => D('invoice', `inv${n}.pdf`, { invoice_number: `INV-${n}`, customer_name: c, service_address: addr, cost: t, service_date: '2026-09-01' });
    await seedDocs(db, [inv(1, 'DELMAR ORCHARDS', '100'), inv(2, 'Delmar Orchards, LLC', '200'), inv(3, 'Delmar Orchards Inc.', '300')]);
    check('L3: "Delmar Orchards" vs "Delmar Orchards LLC / Inc." is declined, never $500 of $600', (await ask(db, 'What did we bill Delmar Orchards?')) === null);
    await wipe(db);
    await seedDocs(db, [D('permit', 'p1.pdf', { permit_number: '2026-001', service_address: '90 Oak Ave, Tempe AZ', customer_name: 'Ann Co', permit_status: 'Open', permit_expires: '2027-06-01' }), D('permit', 'p2.pdf', { permit_number: '2026-001', service_address: addr, customer_name: 'Bob Co', permit_status: 'Final', permit_expires: '2027-06-01' })]);
    for (const q of ['How many permits do we have?', 'How many permits are open?']) check(`L4: "${q}" with one number at two addresses is declined`, (await ask(db, q)) === null);
    await wipe(db);
    const pe = D('permit', 'p.pdf', { permit_number: 'P1', service_address: addr, permit_status: 'Open', permit_expires: '2027-06-01' });
    const fin = (n, date, res) => D('inspection-report', `i${n}.pdf`, { permit_number: 'P1', service_address: addr, inspection_type: 'Final', inspection_result: res, service_date: date });
    await seedDocs(db, [pe, fin(1, '2026-09-01', 'Passed'), fin(2, '2026-09-01', 'Failed')]);
    const s1 = await ask(db, 'What is the status of permit P1?'); check('L5: passed + failed final on the same day is not "finished"', !s1 || !/finished/i.test(s1.text), s1?.text);
    await wipe(db);
    await seedDocs(db, [pe, fin(1, '2026-09-01', 'Passed'), fin(2, '2026-09-15', 'Failed')]);
    const s2 = await ask(db, 'How many permits are open?'); check('L5: a later failed final is not "0 open / finished"', !s2 || !/\b0 permits open\b/.test(s2.text), s2?.text);
    await wipe(db);
    await seedDocs(db, [pe, fin(1, '2026-09-01', 'Failed'), fin(2, '2026-09-15', 'Passed')]);
    const s3 = await ask(db, 'What is the status of permit P1?'); check('L5: failed then re-inspected and passed is still finished (or declined)', !s3 || /finished/i.test(s3.text), s3?.text);
    await wipe(db);
    const cam = (n, fnd) => D('sewer-camera-report', `c${n}.pdf`, { service_address: `${n} Elm St, Mesa AZ`, ...(fnd ? { line_findings: fnd } : {}), service_date: '2026-08-01' });
    await seedDocs(db, [cam(1, 'Root intrusion at 40 ft'), cam(2, ''), cam(3, '')]);
    for (const q of ['How many sewer camera inspections found defects?', 'How many sewer camera reports show defects?']) check(`L6: "${q}" is declined, never the total 3`, (await ask(db, q)) === null);
    check('L6: the plain camera count still answers (3)', await (async () => { const r = await ask(db, 'How many sewer camera reports do we have?'); return !!r && leadNumber(r.text) === 3; })());
    await wipe(db);
    const tk = (n, tech) => D('service-ticket', `t${n}.pdf`, { invoice_number: `T-${n}`, service_address: addr, ...(tech ? { technician: tech } : {}), service_date: n === 2 ? '2026-10-20' : '2026-09-01', work_performed: 'work' });
    await seedDocs(db, [tk(1, 'Dana Ruiz'), tk(2, '')]);
    check('L6: "How many service tickets have a technician?" is declined', (await ask(db, 'How many service tickets have a technician?')) === null);
    for (const q of ['When was the last service at 12 Elm St?', 'Who was the technician on the last service ticket for 12 Elm St?']) check(`L9: "${q}" with a ticket dated after today is declined`, (await ask(db, q)) === null);
  });
  // ---- loop 2
  await H.as('plumbing', async (db) => {
    await wipe(db);
    await seedDocs(db, [D('invoice', 'i1.pdf', { invoice_number: 'INV-1', customer_name: 'Acme', service_address: addr, cost: '100', service_date: '2024-09-15' }), D('sewer-camera-report', 'c1.pdf', { service_address: addr, service_date: '2021-01-01', line_findings: 'none' }), D('service-ticket', 't1.pdf', { invoice_number: 'T-1', service_address: addr, service_date: '2026-09-01', technician: 'Dana Ruiz' })]);
    for (const q of ['How many invoices in the next 30 days?', 'How many invoices within 2 weeks?', 'How many camera reports in the next 30 days?', 'How many tickets in the next 30 days?', 'How many backflow devices in the next 30 days?', 'How many water heaters expire within 30 days?', 'How many open permits expire in the next 30 days?', 'Which backflow tests are overdue in the next 30 days?', 'Which permits are expired in the next 30 days?', 'Which water heaters have an expired warranty in the next 30 days?'])
      check(`W1: "${q}" (a window the lane does not apply) is declined`, (await ask(db, q)) === null);
    check('W1: the plain invoice count still answers', await (async () => { const r = await ask(db, 'How many invoices do we have?'); return !!r && leadNumber(r.text) === 1; })());
    // A3 install date conflict
    await wipe(db);
    const su = (n, date) => D('startup-sheet', `su${n}.pdf`, { serial_number: 'W1', service_address: '1 A St, Mesa AZ', manufacturer: 'Rheem', equipment_type: 'Tank', installation_date: date });
    await seedDocs(db, [su(1, '2016-03-04'), su(2, '2021-03-04')]);
    for (const q of ['How old is the water heater at 1 A St?', 'When was the water heater at 1 A St installed?']) check(`A3: "${q}" with two different install dates is declined`, (await ask(db, q)) === null);
    // A4 registration with term but no expiry
    await wipe(db);
    await seedDocs(db, [su(1, '2016-03-04'), D('warranty-registration', 'r1.pdf', { serial_number: 'W1', service_address: '1 A St, Mesa AZ', warranty_registered_date: '2019-05-01', warranty_term: '6 year' })]);
    check('A4: a registration with no printed expiry is never worded as "no warranty record"', (await ask(db, 'Which water heaters are out of warranty?')) === null);
    // A5 / A6 re-sent copies
    await wipe(db);
    const inv = (n) => D('invoice', `inv${n}.pdf`, { invoice_number: 'INV-1', customer_name: 'Acme', service_address: addr, cost: '1200', service_date: '2026-09-01' });
    await seedDocs(db, [inv(1), inv(2)]);
    check('A5: two documents numbered INV-1 are not counted as 2 invoices', (await ask(db, 'How many invoices do we have?')) === null);
    await wipe(db);
    const tk = (n, who) => D('service-ticket', `t${n}.pdf`, { invoice_number: 'T-1', service_address: addr, service_date: '2026-09-01', technician: who, work_performed: 'w' });
    await seedDocs(db, [tk(1, 'Dana Ruiz'), tk(2, 'Bo Lee')]);
    check('A6: the same ticket number with two technicians is declined', (await ask(db, 'Who was the technician on ticket T-1?')) === null);
    // A7 future passed final, A8 unassigned final
    await wipe(db);
    const pe = (n) => D('permit', `p${n}.pdf`, { permit_number: `P${n}`, service_address: '1 A St, Mesa AZ', permit_status: 'Open', permit_expires: '2027-06-01' });
    const fin = (no, date) => D('inspection-report', `i${no ?? 'x'}.pdf`, { ...(no ? { permit_number: no } : {}), service_address: '1 A St, Mesa AZ', inspection_type: 'Final', inspection_result: 'Passed', service_date: date });
    await seedDocs(db, [pe(1), fin('P1', '2026-11-01')]);
    const f1 = await ask(db, 'What is the status of permit P1?'); check('A7: a passed final dated well after today is not "finished"', !f1 || !/finished/i.test(f1.text), f1?.text);
    await wipe(db);
    await seedDocs(db, [pe(1), pe(2), fin(null, '2026-09-01')]);
    const f2 = await ask(db, 'What is the status of permit P1?'); check('A8: an unassignable passed final never yields "no final"', !f2 || !/no final/i.test(f2.text), f2?.text);
    // B1 serial-only overdue question
    await wipe(db);
    await seedDocs(db, [bfd(1, 'BF1001', '2025-03-01', 'Passed', '2026-08-01'), bfd(6, 'BF1006', '2024-01-01', 'Passed', '2025-01-01'), bfd(3, 'BF1003', '2026-03-01', 'Passed', '2026-12-01')]);
    const o = await ask(db, 'Is BF1003 overdue?'); check('B1: "Is BF1003 overdue?" never says no backflow tests are overdue company-wide', !o || (!/^None\. No backflow tests are overdue/.test(o.text) && /BF1003|December 1, 2026|not overdue|No\b/.test(o.text)), o?.text);
  });
  // ---- loop 3
  const rows = (type, filename, list) => ({ filename, type, fields: list.map((x) => (Array.isArray(x) ? { key: x[0], value: x[1], ...(x[2] !== undefined ? { corrected: x[2] } : {}) } : x)) });
  await H.as('plumbing', async (db) => {
    // H2: leftover lane words never change a count silently
    await wipe(db);
    await seedDocs(db, [wr(1, 'Rheem', 'Gas', '2025-12-01'), wr(2, 'Rheem', 'Propane', '2030-01-01'), wr(3, 'Bradford', 'Electric', '2030-01-01'), wr(4, 'Bradford', 'Gas', '2030-01-01'),
      D('permit', 'p1.pdf', { permit_number: 'P1', service_address: '1 A St, Mesa AZ', permit_status: 'Open', permit_expires: '2027-06-01' }), bfd(1, 'S1', '2026-03-01', 'Failed', '')]);
    for (const q of ['How many water heaters are expired?', 'How many water heaters have expired?', 'How many water heaters are valid?', 'How many water heaters are registered?', 'How many propane water heaters do we have?', 'How many permits passed?', 'How many permits are failing?', 'How many backflow devices need a retest?', 'How many backflow devices are waiting on a retest?'])
      check(`H2: "${q}" is declined, never the unqualified total`, (await ask(db, q)) === null);
    check('H2: plain counts still answer', await (async () => { const a = await ask(db, 'How many water heaters do we have?'); const b = await ask(db, 'How many permits do we have?'); return !!a && !!b && leadNumber(a.text) === 4 && leadNumber(b.text) === 1; })());
    // H3: customer + city
    await wipe(db);
    const inv = (n, c, a, t) => D('invoice', `inv${n}.pdf`, { invoice_number: `INV-${n}`, customer_name: c, service_address: a, cost: t, service_date: '2026-09-01' });
    await seedDocs(db, [inv(1, 'Acme Foods', '40 Palm Rd, Mesa AZ', '100'), inv(2, 'Acme Foods', '8 Dune Dr, Gilbert AZ', '200')]);
    for (const q of ['What did we bill Acme Foods in Gilbert?', 'How much did we invoice Acme Foods in Mesa?']) check(`H3: "${q}" never answers the customer total with the city dropped`, (await ask(db, q)) === null);
    const tot = await ask(db, 'What did we bill Acme Foods?'); check('H3: the customer total still answers ($300.00)', !!tot && /\$300\.00/.test(tot.text), tot?.text);
    // M1: one document, two values for one single-valued field
    await wipe(db);
    await seedDocs(db, [rows('service-ticket', 't1.pdf', [['invoice_number', 'T-1'], ['service_address', '40 Palm Rd, Mesa AZ'], ['service_date', '2026-09-01'], ['technician', 'Ann Lee'], ['technician', 'Bob Ray']])]);
    check('M1: a ticket with two technician rows is declined', (await ask(db, 'Who was the technician at 40 Palm Rd?')) === null);
    await wipe(db);
    await seedDocs(db, [rows('sewer-camera-report', 'c1.pdf', [['service_address', '40 Palm Rd, Mesa AZ'], ['service_date', '2026-08-01'], ['line_length', '80 ft'], ['line_length', '120 ft'], ['line_findings', 'Roots at 40 ft']])]);
    check('M1: a camera report with two lengths is declined', (await ask(db, 'How long was the camera run at 40 Palm Rd?')) === null);
    // M2: attention never states a self-contradicting paper as fact
    await wipe(db);
    await seedDocs(db, [rows('permit', 'p.pdf', [['permit_number', 'PL-2'], ['service_address', '40 Palm Rd, Mesa AZ'], ['permit_status', 'Open'], ['permit_expires', '2027-01-01'], ['permit_expires', '2025-01-01']]), rows('warranty-registration', 'w.pdf', [['serial_number', 'W9'], ['service_address', '50 Palm Rd, Mesa AZ'], ['warranty_expires', '2026-10-10'], ['warranty_expires', '2030-10-10']]), rows('backflow-test-certificate', 'b.pdf', [['serial_number', 'B9'], ['service_address', '60 Palm Rd, Mesa AZ'], ['service_date', '2026-03-01'], ['backflow_test_result', 'Passed'], ['next_test_due', '2026-10-10'], ['next_test_due', '2027-10-10']])]);
    const at = await ask(db, 'What needs attention?');
    check('M2: attention lists no item for papers that contradict themselves', !at || (!/expir|due in|expired/i.test(at.facts.map((x) => `${x.label} ${x.value}`).join(' '))), at?.text + ' | ' + at?.facts?.map((x) => x.value).join('; '));
    // M3: a cleared field is not refilled from an older certificate
    await wipe(db);
    const c1 = rows('backflow-test-certificate', 'old.pdf', [['serial_number', 'S1'], ['service_address', '40 Palm Rd, Mesa AZ'], ['service_date', '2025-03-01'], ['backflow_test_result', 'Passed'], ['device_size', '1 inch'], ['water_utility', 'City of Mesa']]);
    const c2 = rows('backflow-test-certificate', 'new.pdf', [['serial_number', 'S1'], ['service_address', '40 Palm Rd, Mesa AZ'], ['service_date', '2026-03-01'], ['backflow_test_result', 'Passed'], ['next_test_due', '2027-03-01'], ['device_size', '1 inch', ''], ['water_utility', 'City of Mesa', '']]);
    await seedDocs(db, [c1, c2]);
    for (const q of ['What size is the backflow device at 40 Palm Rd?', 'Which water utility is the backflow test filed with at 40 Palm Rd?']) { const r = await ask(db, q); check(`M3: "${q}" does not state a value a person cleared`, !r || !/1 inch|1"|City of Mesa/.test(r.text), r?.text); }
    // M4 future dates / M5 due before test
    await wipe(db);
    await seedDocs(db, [rows('sewer-camera-report', 'c.pdf', [['service_address', '21 Sun Ave, Mesa AZ'], ['service_date', '2027-03-01'], ['line_findings', 'Roots at 40 ft']]), bfd(1, 'S1', '2027-03-02', 'Passed', '2028-03-02')]);
    check('M4: a camera report dated well in the future is not stated as done', (await ask(db, 'When was the camera inspection at 21 Sun Ave?')) === null);
    check('M4: a backflow test dated well in the future is not stated as the last test', await (async () => { const r = await ask(db, 'When was the backflow test at 12 Elm St last done?'); return !r || !/March 2, 2027/.test(r.text); })());
    await wipe(db);
    await seedDocs(db, [bfd(1, 'S1', '2026-03-02', 'Passed', '2025-03-02')]);
    const ov = await ask(db, 'Is the backflow device at 12 Elm St overdue?'); check('M5: a next test due before the test itself is not stated as overdue', !ov || !/582 days|^Yes/.test(ov.text), ov?.text);
    // M6 finding wording
    await wipe(db);
    const cam = (n, fnd) => D('sewer-camera-report', `c${n}.pdf`, { service_address: `${n} Elm St, Mesa AZ`, line_findings: fnd, service_date: '2026-08-01' });
    await seedDocs(db, [cam(1, 'No evidence of roots or breaks'), cam(2, 'Pipe free of defects'), cam(3, 'No root intrusion'), cam(4, 'Roots'), cam(5, 'Belly at 30 ft, no roots')]);
    const d = await ask(db, 'Which sewer lines have defects?'); check('M6: defects list is exact (2) or declined, never 5', !d || leadNumber(d.text) === 2, d?.text);
    await wipe(db);
    await seedDocs(db, [cam(1, 'Line in good condition, no obstructions'), cam(2, 'Roots at 40 ft')]);
    check('M6: a finding that is neither plainly clean nor plainly a defect declines the list', (await ask(db, 'Which sewer lines have defects?')) === null);
    // cap note
    await wipe(db);
    await seedDocs(db, Array.from({ length: 55 }, (_, i) => D('backflow-test-certificate', `bf${i}.pdf`, { serial_number: `CAP-${i}`, service_address: `${100 + i} Cap St, Mesa AZ`, service_date: '2025-01-01', backflow_test_result: 'Passed', next_test_due: '2026-01-01' })));
    const ca = await ask(db, 'Which backflow tests are overdue?'); check('cap: a 55-row list says it shows the first 40', !!ca && leadNumber(ca.text) === 55 && /first 40/.test(ca.text), ca?.text);
    // MED-2 conflict listed honestly
    await wipe(db);
    await seedDocs(db, [bfd(1, 'Q2', '2025-06-01', 'Passed', '2026-06-01'), bfd(2, 'Q2', '2025-06-01', 'Failed', '')]);
    const cl = await ask(db, 'How many backflow devices do we have?'); check('MED-2: a same-day Passed/Failed conflict is not listed with one confident result', !cl || !cl.facts.some((x) => /: (Passed|Failed)$/.test(x.value)), cl?.facts?.map((x) => x.value).join('; '));
  });
  const camx = (lines) => ex([`SEWER CAMERA INSPECTION REPORT\nService Address: 9 Oak St, Mesa AZ\nDate: 10/02/2026\n${lines}`]);
  check('H1: findings on plain continuation lines are not read piecemeal (declined)', camx('Findings: Pipe in good condition\nBelly at 30 ft\nCracked pipe at 55 ft') === null);
  check('H1: a "Findings (cont.)" continuation is declined', ex([`SEWER CAMERA INSPECTION REPORT\nService Address: 9 Oak St, Mesa AZ\nDate: 10/02/2026\nFindings: No visible roots`, 'Findings (cont.): Collapsed pipe at 90 ft']) === null);
  check('H1: a single-line finding still reads', camx('Findings: Roots at 40 ft\nRecommendation: hydrojet')?.fields.some((x) => x.key === 'line_findings'));
  // ---- loop 4
  const pg = (body) => ex([`PLUMBING PERMIT\nPermit No: PL-26-777\n${A}\n${body}`]);
  check('M2: a revised total printed beside the first total keeps no total', !ex([`INVOICE\nInvoice No: INV-1\nBill To: Acme\n${A}\nDate: 09/01/2026\nTotal: $1,800.00\nRevised Total: $2,200.00`])?.fields.some((x) => x.key === 'cost'));
  check('M3: an amended expiry keeps no expiry', !pg('Expires: 09/02/2026\nAmended Expiration: 09/02/2027\nStatus: Open')?.fields.some((x) => x.key === 'permit_expires'));
  for (const extra of ['Date Finaled: 09/20/2026', 'Closed: 09/20/2026', 'Voided on 09/20/2026', 'Cancelled 09/20/2026', 'New Status: Finaled']) check(`M4: "${extra}" beside Status: Open keeps no status`, !pg(`Status: Open\n${extra}`)?.fields.some((x) => x.key === 'permit_status'));
  await H.as('plumbing', async (db) => {
    const pm = (st) => D('permit', 'p.pdf', { permit_number: 'P1', service_address: '1 A St, Mesa AZ', permit_status: st, permit_expires: '2027-06-01' });
    for (const st of ['Final TBD', 'Final overdue', 'Non-final', 'Semi-final', 'Final postponed', 'Approved for final', 'Final expected']) { await wipe(db); await seedDocs(db, [pm(st)]); const r = await ask(db, 'How many permits are open?'); check(`M5: status "${st}" is not counted as finished (never "0 permits open")`, !r || !/^0 permits open/.test(r.text), r?.text); }
    // M6 inspection that contradicts the permit's address and customer; partial final; cleared result
    await wipe(db);
    await seedDocs(db, [D('permit', 'p.pdf', { permit_number: 'PL-1', service_address: '15 Cactus Wren Lane, Mesa AZ', customer_name: 'Ned Fox', permit_status: 'Open', permit_expires: '2027-06-01' }), D('inspection-report', 'i.pdf', { permit_number: 'PL-1', service_address: '7 Juniper Ct, Mesa AZ', customer_name: 'Ann Lee', inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-09-01' })]);
    const m6 = await ask(db, 'Is the permit at 15 Cactus Wren Lane open?'); check('M6: a final for another address and customer does not finish the permit', !m6 || !/finished/i.test(m6.text), m6?.text);
    await wipe(db);
    const p2 = D('permit', 'p.pdf', { permit_number: 'PL-2', service_address: '7 Juniper Ct, Mesa AZ', permit_status: 'Open', permit_expires: '2027-06-01' });
    await seedDocs(db, [p2, D('inspection-report', 'i.pdf', { permit_number: 'PL-2', service_address: '7 Juniper Ct, Mesa AZ', inspection_type: 'Final (gas only)', inspection_result: 'Passed', service_date: '2026-09-01' })]);
    const m6b = await ask(db, 'Is the permit at 7 Juniper Ct open?'); check('M6: a partial ("gas only") final does not finish the permit', !m6b || !/finished/i.test(m6b.text), m6b?.text);
    await wipe(db);
    await seedDocs(db, [p2, { filename: 'i.pdf', type: 'inspection-report', fields: [{ key: 'permit_number', value: 'PL-2' }, { key: 'service_address', value: '7 Juniper Ct, Mesa AZ' }, { key: 'inspection_type', value: 'Final' }, { key: 'inspection_result', value: 'Passed', corrected: '' }, { key: 'service_date', value: '2026-09-01' }] }]);
    const m7 = await ask(db, 'Is the permit at 7 Juniper Ct open?'); check('M7: a cleared final result leaves the permit undecided (declined), never "open"', m7 === null || !/\bis open\b/.test(m7.text), m7?.text);
    // M8 / M9
    await wipe(db);
    const iv = (n, t, d2) => D('invoice', `inv${n}.pdf`, { invoice_number: `INV-${n}`, customer_name: 'Ned Fox', service_address: addr, cost: t, service_date: d2 });
    await seedDocs(db, [iv(1, '100', '2026-09-01'), iv(2, '200', '2026-09-15')]);
    for (const q of ['How much was the last invoice for Ned Fox?', 'How much was the latest invoice for Ned Fox?']) check(`M8: "${q}" is declined, never the total of all`, (await ask(db, q)) === null);
    await wipe(db);
    const po = (n, t, a) => D('purchase-order', `po${n}.pdf`, { invoice_number: `PO-${n}`, customer_name: 'Ned Fox', service_address: a, cost: t, service_date: '2026-06-01' });
    await seedDocs(db, [po(1, '11', addr), po(2, '99', addr)]);
    check('M9: two purchase orders for one customer are never silently reduced to one', (await ask(db, 'How much was the PO for Ned Fox?')) === null);
    // M10 serial-less heaters that disagree
    await wipe(db);
    const nr = (n, make) => D('warranty-registration', `r${n}.pdf`, { service_address: '1 A St, Mesa AZ', customer_name: 'Ned Fox', manufacturer: make, equipment_type: 'Tank', warranty_expires: '2030-01-01' });
    await seedDocs(db, [nr(1, 'Rheem'), nr(2, 'Bradford White')]);
    check('M10: two serial-less registrations that disagree on the maker are not merged into one heater', (await ask(db, 'How many water heaters do we have?')) === null);
    // MED-1 two values on one single-valued key
    await wipe(db);
    await seedDocs(db, [rows('sewer-camera-report', 'c.pdf', [['service_address', '1 Elm St, Mesa AZ'], ['service_date', '2026-08-01'], ['recommendation', 'Replace line'], ['recommendation', 'No action needed'], ['line_findings', 'Roots']])]);
    check('MED-1: a camera report with two recommendations is declined', (await ask(db, 'What is the camera recommendation at 1 Elm St?')) === null);
    await wipe(db);
    await seedDocs(db, [rows('permit', 'p.pdf', [['permit_number', 'PL-1'], ['service_address', '1 Pine Rd, Mesa AZ'], ['permit_status', 'Open'], ['permit_expires', '2027-01-01'], ['jurisdiction', 'City of Mesa'], ['jurisdiction', 'City of Gilbert']])]);
    check('MED-1: a permit with two issuing offices is declined', (await ask(db, 'Which office issued the permit at 1 Pine Rd?')) === null);
    // B1: how many overdue
    await wipe(db);
    await seedDocs(db, [bfd(1, 'BF1001', '2025-03-01', 'Passed', '2026-08-01'), bfd(6, 'BF1006', '2024-01-01', 'Passed', '2025-01-01'), bfd(3, 'BF1003', '2026-03-01', 'Passed', '2026-12-01')]);
    const ho = await ask(db, 'How many backflow tests are overdue?'); check('B1: "How many backflow tests are overdue?" answers 2', !!ho && leadNumber(ho.text) === 2, ho?.text);
    check('B1: "How many backflow certificates are overdue?" (a different noun) is not answered as devices', (await ask(db, 'How many backflow certificates are overdue?')) === null);
  });
  // ---- loop 5
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const bs = (n, a, date, res, due) => D('backflow-test-certificate', `b${n}.pdf`, { serial_number: '12345', service_address: a, customer_name: 'Acme', service_date: date, backflow_test_result: res, ...(due ? { next_test_due: due } : {}) });
    await seedDocs(db, [bs(1, '1 A St, Mesa AZ', '2026-01-10', 'Failed'), bs(2, '9 B St, Tempe AZ', '2026-02-10', 'Passed', '2027-02-10')]);
    for (const q of ['Which backflow tests failed?', 'What needs attention?']) { const r = await ask(db, q); check(`A1: "${q}" never says None when one serial sits at two addresses and one failed`, !r || !/^None\b/.test(r.text) || /could not be read or that disagrees/.test(r.text), r?.text); }
    const c = await ask(db, 'How many backflow devices do we track?'); check('A1: one serial at two addresses is never counted as 1 device', !c || leadNumber(c.text) !== 1, c?.text);
    await wipe(db);
    const hr = (n, make, a, exp) => D('warranty-registration', `h${n}.pdf`, { serial_number: 'A100', service_address: a, manufacturer: make, equipment_type: 'Tank', warranty_expires: exp });
    await seedDocs(db, [hr(1, 'Rheem', '1 A St, Mesa AZ', '2025-01-01'), hr(2, 'Bradford', '9 B St, Tempe AZ', '2030-01-01')]);
    check('A1: one heater serial at two addresses is not counted as 1 heater', (await ask(db, 'How many water heaters do we have?')) === null);
    await wipe(db);
    const pe = (st) => D('permit', `p${st}.pdf`, { permit_number: 'P1', service_address: '1 A St, Mesa AZ', permit_status: st, permit_expires: '2027-06-01' });
    await seedDocs(db, [pe('Final'), pe('Open')]);
    check('A2: two papers with one permit number and different statuses are declined (upload order never decides)', (await ask(db, 'How many permits are open?')) === null);
    await wipe(db);
    await seedDocs(db, [D('permit', 'p.pdf', { permit_number: 'P1', service_address: '1 A St, Mesa AZ', customer_name: 'Acme', permit_status: 'Open', permit_expires: '2027-06-01' }), D('inspection-report', 'i.pdf', { permit_number: 'P1', service_address: '99 Z Rd, Tempe AZ', customer_name: 'Acme', inspection_type: 'Final', inspection_result: 'Passed', service_date: '2026-09-01' })]);
    const a3 = await ask(db, 'How many permits are open?'); check('A3: a final at another address (same customer) does not finish the permit', !a3 || !/^0 permits open/.test(a3.text), a3?.text);
    for (const bad of ['2026-02-30', '2026-13-01', '2025-02-29', '2026-00-10']) { await wipe(db); await seedDocs(db, [bfd(1, 'S1', '2025-01-10', 'Passed', bad)]); const r = await ask(db, 'Which backflow tests are overdue?'); check(`A4: impossible due date ${bad} never prints as a date or an overdue count`, !r || !/undefined|NaN|February 30|April 31|February 29|overdue since/.test(r.text + r.facts.map((x) => x.value).join(' ')) && (leadNumber(r.text) !== 1), r?.text); }
    await wipe(db);
    await seedDocs(db, [D('startup-sheet', 's.pdf', { serial_number: 'W1', service_address: '1 A St, Mesa AZ', manufacturer: 'Rheem', equipment_type: 'Tank', installation_date: '2026-10-20' })]);
    check('A6: an install date after today is not stated as past fact', (await ask(db, 'How old is the water heater at 1 A St?')) === null);
    await wipe(db);
    await seedDocs(db, [D('permit', 'p.pdf', { permit_number: 'BLD-3', service_address: '403 Chandler Way, Mesa AZ', permit_status: 'Expired', permit_expires: '2027-01-31' })]);
    const e1 = await ask(db, 'Is permit BLD-3 expired?'); check('B2: "Is permit expired?" with a printed Expired status says so', !e1 || /status says expired/.test(e1.text), e1?.text);
    const e2 = await ask(db, 'What needs attention?'); check('B1: attention never words a status-expired future-dated permit as expired on its future date', !e2 || !e2.facts.some((x) => /January 31, 2027 \(/.test(x.value)), e2?.facts?.map((x) => x.value).join('; '));
  });
}
