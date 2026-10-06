/**
 * Plumbing question set (Build 2, stage 2C). buildQuestions(T) -> [{kind, question, must, mustNot?, cite?, computed?, mode?}]
 * T = truth() from plumbing-fixtures.mjs (worked out from the raw specs, never from any lane).
 *  - must      strings the answer must contain (case-insensitive); dates are written long ("March 4, 2026")
 *  - mustNot   strings the answer must not contain (e.g. history values from an older near-duplicate certificate)
 *  - cite      [[filename, field_key, page?]] the answer must carry (page defaults to 1)
 *  - computed  must-strings that are counts / sums / state words, not copied from a page (the selfcheck exempts them)
 *  - mode:'null'  not on file or out of scope: the answer must NOT be produced from records (same meaning as in the electrical set)
 *  - kind      backflow | waterheater | permit | camera | service | invoice | count | unanswerable | general | decoy
 * Decisions D1-D9 are in the header of plumbing-fixtures.mjs (overdue = due < TODAY, due today is not overdue, windows are inclusive,
 * failed devices are only in the failed list, no registration = no warranty answer, expired-by-date permits are expired not open, ...).
 */
import { TODAY, addDays, long, money, SITES, site, INVOICES, CAMERAS, TICKETS, WORKORDERS, PROPOSAL, AGREEMENT, PO, DISPATCH } from './plumbing-fixtures.mjs';

export function buildQuestions(T) {
  const out = [];
  const q = (kind, question, o = {}) => out.push({ kind, question, ...o });
  const serials = (arr) => arr.map((d) => d.serial);

  /* ---- backflow: one device at a time ---- */
  T.devices.forEach((d, i) => {
    const a = d.s.addr; const c = d.current; const f = c.file;
    const near = d.nAtSite === 1 ? `at ${a}` : `(${d.loc}) at ${a}`;
    const oldDue = d.history.filter((h) => h.due).map((h) => long(h.due));
    const oldTest = d.history.map((h) => long(h.test));
    // next due
    if (d.status === 'passed') {
      q('backflow', `When is the next backflow test due ${near}?`, { must: [long(d.due)], mustNot: oldDue, cite: [[f, 'next_test_due']] });
      q('backflow', `${d.kind} annual test due date ${near}`, { must: [long(d.due)], mustNot: oldDue, cite: [[f, 'next_test_due']] });
      if (d.nAtSite === 1) q('backflow', `When does ${d.s.cust} need their backflow retested?`, { must: [long(d.due)], mustNot: oldDue, cite: [[f, 'next_test_due']] });
    } else {
      q('backflow', `When is the next backflow test due ${near}?`, { must: ['fail'], computed: ['fail'], cite: [[f, 'backflow_test_result']] });
      q('backflow', `Does the ${d.kind} ${near} need a retest?`, { must: ['fail', 'retest'], computed: ['retest'], cite: [[f, 'backflow_test_result']] });
    }
    // result
    const word = d.status === 'passed' ? 'pass' : 'fail';
    q('backflow', `Did the backflow ${near} pass its last test?`, { must: [word, long(d.tested)], mustNot: d.history.length ? oldTest : [], cite: [[f, 'backflow_test_result']] });
    q('backflow', `${d.kind} test result ${near}`, { must: [word], cite: [[f, 'backflow_test_result']] });
    // tester, date, serial
    q('backflow', `Who tested the backflow ${near}?`, { must: [d.tester.name], cite: [[f, 'technician']] });
    q('backflow', `When was the ${d.kind} ${near} last tested?`, { must: [long(d.tested)], mustNot: oldTest, cite: [[f, 'service_date']] });
    q('backflow', `What is the serial number of the ${d.kind} ${near}?`, { must: [d.serial], cite: [[f, 'serial_number']] });
    // every other device: size, make, location, utility, tester cert
    if (i % 2 === 0) {
      q('backflow', `What size is the backflow device ${near}?`, { must: [d.size], cite: [[f, 'device_size']] });
      q('backflow', `What brand is the ${d.kind} ${near}?`, { must: [d.make], cite: [[f, 'manufacturer']] });
      q('backflow', d.nAtSite === 1 ? `Where is the backflow device located at ${a}?` : `Where is the ${d.make} ${d.size} ${d.kind} located at ${a}?`, { must: [d.loc], cite: [[f, 'device_location']] });
      q('backflow', `Which water utility is the ${d.kind} test filed with ${near}?`, { must: [d.util], cite: [[f, 'water_utility']] });
      q('backflow', `What is the cert number of the tester on the ${d.kind} ${near}?`, { must: [d.tester.cert], cite: [[f, 'tester_cert_number']] });
    }
  });
  // lists (D2, D3)
  const dueSet = (n) => T.dueWithin(n); const notIn = (n) => serials(T.devices.filter((d) => !dueSet(n).includes(d)));
  for (const n of [30, 60, 90]) {
    const set = dueSet(n);
    q('backflow', `Which backflow tests are due in the next ${n} days?`, { must: serials(set), mustNot: notIn(n), cite: set.map((d) => [d.current.file, 'next_test_due']) });
    q('backflow', `What backflow devices need testing within ${n} days?`, { must: serials(set), mustNot: notIn(n), cite: set.map((d) => [d.current.file, 'next_test_due']) });
  }
  q('backflow', 'Show me RPZ tests due in the next 90 days', { must: serials(dueSet(90).filter((d) => d.kind === 'RPZ')), mustNot: serials(T.devices.filter((d) => !(dueSet(90).includes(d) && d.kind === 'RPZ'))), cite: dueSet(90).filter((d) => d.kind === 'RPZ').map((d) => [d.current.file, 'next_test_due']) });
  const od = T.overdue();
  for (const ph of ['Which backflow tests are overdue?', 'What backflow tests are past due?', 'Any overdue backflow certifications?'])
    q('backflow', ph, { must: serials(od), mustNot: serials(T.devices.filter((d) => !od.includes(d))), cite: od.map((d) => [d.current.file, 'next_test_due']) });
  for (const k of ['RPZ', 'DCVA', 'PVB']) {
    const set = od.filter((d) => d.kind === k);
    if (set.length) q('backflow', `Which ${k} tests are overdue?`, { must: serials(set), mustNot: serials(T.devices.filter((d) => !set.includes(d))), cite: set.map((d) => [d.current.file, 'next_test_due']) });
    else q('backflow', `Which ${k} tests are overdue?`, { must: [], mustNot: serials(T.devices), expectEmpty: true });
  }
  const today = T.dueToday();
  q('backflow', 'Which backflow tests are due today?', { must: serials(today), mustNot: serials(T.devices.filter((d) => !today.includes(d))), cite: today.map((d) => [d.current.file, 'next_test_due']) });
  q('backflow', 'Is anything overdue on backflow as of today?', { must: serials(od), mustNot: serials(today), cite: od.map((d) => [d.current.file, 'next_test_due']) });
  const fl = T.failedNoRetest();
  for (const ph of ['Which backflow devices failed and still need a retest?', 'Show failed backflow tests that have not been retested', 'What backflow failures are we waiting on?'])
    q('backflow', ph, { must: serials(fl), mustNot: serials(T.devices.filter((d) => !fl.includes(d))), cite: fl.map((d) => [d.current.file, 'backflow_test_result']) });
  const retested = T.devices.filter((d) => d.history.some((h) => !h.result) && d.status === 'passed');
  for (const d of retested) q('backflow', `Is the ${d.kind} ${d.nAtSite === 1 ? 'at ' + d.s.addr : '(' + d.loc + ') at ' + d.s.addr} currently passing after its earlier failure?`, { must: ['pass', long(d.tested)], mustNot: d.history.map((h) => long(h.test)), cite: [[d.current.file, 'backflow_test_result']] });
  // counts
  q('count', 'How many backflow test certificates do we have on file?', { must: [`${T.byType['backflow-test-certificate']} backflow`], computed: [`${T.byType['backflow-test-certificate']} backflow`] });
  q('count', 'How many backflow devices do we track?', { must: [`${T.devices.length} backflow`], computed: [`${T.devices.length} backflow`] });
  for (const k of ['RPZ', 'DCVA', 'PVB']) q('count', `How many ${k} devices do we have?`, { must: [`${T.devices.filter((d) => d.kind === k).length} ${k}`], computed: [`${T.devices.filter((d) => d.kind === k).length} ${k}`] });
  q('count', 'How many backflow tests did not pass?', { must: [`${fl.length} backflow`], computed: [`${fl.length} backflow`] });

  /* ---- water heaters ---- */
  T.heaters.forEach((w, i) => {
    const a = w.s.addr; const sf = w.startFile; const WH = i % 2 ? 'WH' : 'water heater';
    q('waterheater', `Who made the ${WH} at ${a}?`, { must: [w.make], cite: [[sf, 'manufacturer', w.id === 'w7' ? 2 : 1]] });
    q('waterheater', `When was the water heater at ${a} installed?`, { must: [long(w.install)], cite: [[sf, 'installation_date']] });
    q('waterheater', `What is the serial number of the ${WH} at ${a}?`, { must: [w.serial], cite: [[sf, 'serial_number', w.id === 'w7' ? 2 : 1]] });
    q('waterheater', `What is the model number of the ${WH} for ${w.s.cust}?`, { must: [w.model], cite: [[sf, 'model', w.id === 'w7' ? 2 : 1]] });
    q('waterheater', `Is the ${WH} at ${a} gas or electric?`, { must: [w.fuel], mustNot: [w.fuel === 'gas' ? 'electric' : 'gas'], cite: [[sf, 'fuel_type']] });
    q('waterheater', `How old is the water heater at ${a}?`, { must: [long(w.install)], cite: [[sf, 'installation_date']] });
    if (!w.tankless) q('waterheater', `How many gallons is the ${WH} at ${a}?`, { must: [`${w.gal} gallon`], cite: [[sf, 'gallons']] });
    else q('waterheater', `Is the water heater at ${a} a tank or tankless?`, { must: ['tankless'], cite: [[sf, 'equipment_type']] });
    if (w.reg) {
      const rf = w.regFile; const expired = w.exp < TODAY;
      q('waterheater', `When does the warranty expire on the ${WH} at ${a}?`, { must: [long(w.exp)], cite: [[rf, 'warranty_expires']] });
      q('waterheater', `Is the ${WH} at ${a} still under warranty?`, expired ? { must: [long(w.exp), 'expired'], computed: ['expired'], cite: [[rf, 'warranty_expires']] } : { must: [long(w.exp)], mustNot: ['expired'], cite: [[rf, 'warranty_expires']] });
      q('waterheater', `What is the warranty term on the water heater for ${w.s.cust}?`, { must: [`${w.term} year`], cite: [[rf, 'warranty_term']] });
    } else {
      q('unanswerable', `When does the warranty expire on the ${WH} at ${a}?`, { mode: 'null' });
      q('unanswerable', `Is the water heater at ${a} still under warranty?`, { mode: 'null' });
    }
  });
  for (const n of [30, 60, 90, 120]) {
    const set = T.whExpiring(n); const rest = T.heaters.filter((w) => !set.includes(w));
    if (set.length) q('waterheater', `Which water heater warranties expire in the next ${n} days?`, { must: set.map((w) => w.serial), mustNot: rest.map((w) => w.serial), cite: set.map((w) => [w.regFile, 'warranty_expires']) });
    else q('waterheater', `Which water heater warranties expire in the next ${n} days?`, { must: [], mustNot: T.heaters.map((w) => w.serial), expectEmpty: true });
  }
  q('waterheater', 'Which WH warranties are expiring in the next 90 days?', { must: T.whExpiring(90).map((w) => w.serial), mustNot: T.heaters.filter((w) => !T.whExpiring(90).includes(w)).map((w) => w.serial), cite: T.whExpiring(90).map((w) => [w.regFile, 'warranty_expires']) });
  const ex = T.whExpired();
  for (const ph of ['Which water heater warranties have expired?', 'Which WH are out of warranty?']) q('waterheater', ph, { must: ex.map((w) => w.serial), mustNot: T.heaters.filter((w) => !ex.includes(w)).map((w) => w.serial), cite: ex.map((w) => [w.regFile, 'warranty_expires']) });
  q('count', 'How many water heaters have an expired warranty?', { must: [`${ex.length} water heater`], computed: [`${ex.length} water heater`] });
  const cnt = (f) => T.heaters.filter(f).length;
  q('count', 'How many water heaters do we have on file?', { must: [`${T.heaters.length} water heater`], computed: [`${T.heaters.length} water heater`] });
  q('count', 'How many tankless water heaters do we have?', { must: [`${cnt((w) => w.tankless)} tankless`], computed: [`${cnt((w) => w.tankless)} tankless`] });
  q('count', 'How many tank water heaters versus tankless?', { must: [`${cnt((w) => !w.tankless)} tank`, `${cnt((w) => w.tankless)} tankless`], computed: [`${cnt((w) => !w.tankless)} tank`, `${cnt((w) => w.tankless)} tankless`] });
  q('count', 'How many gas water heaters do we have?', { must: [`${cnt((w) => w.fuel === 'gas')} gas`], computed: [`${cnt((w) => w.fuel === 'gas')} gas`] });
  q('count', 'How many electric water heaters do we have?', { must: [`${cnt((w) => w.fuel === 'electric')} electric`], computed: [`${cnt((w) => w.fuel === 'electric')} electric`] });
  for (const mk of ['Rheem', 'Navien']) q('count', `How many ${mk} water heaters do we have?`, { must: [`${cnt((w) => w.make === mk)} ${mk}`], computed: [`${cnt((w) => w.make === mk)} ${mk}`] });
  q('waterheater', 'Which water heaters are tankless gas units?', { must: T.heaters.filter((w) => w.tankless && w.fuel === 'gas').map((w) => w.serial), mustNot: T.heaters.filter((w) => !(w.tankless && w.fuel === 'gas')).map((w) => w.serial), cite: T.heaters.filter((w) => w.tankless && w.fuel === 'gas').map((w) => [w.startFile, 'equipment_type']) });

  /* ---- permits ---- */
  T.permits.forEach((p, i) => {
    const a = p.s.addr; const pf = p.file;
    q('permit', `What is the permit number for ${a}?`, { must: [p.no], cite: [[pf, 'permit_number']] });
    q('permit', `What permit does ${p.s.cust} have?`, { must: [p.no], cite: [[pf, 'permit_number']] });
    q('permit', `Which office issued the permit for ${a}?`, { must: [p.jur], cite: [[pf, 'jurisdiction']] });
    q('permit', `When does the permit at ${a} expire?`, { must: [long(p.expires)], cite: [[pf, 'permit_expires']] });
    q('permit', `What type of permit is ${p.no}?`, { must: [p.type], cite: [[pf, 'permit_type']] });
    q('permit', `When was the permit for ${a} issued?`, { must: [long(p.issued)], cite: [[pf, 'permit_issued_date']] });
    q('permit', `What is the status of the permit at ${a}?`, p.state === 'expired' ? { must: ['expired'], computed: ['expired'], cite: [[pf, 'permit_status']] } : p.state === 'open' ? { must: ['open'], computed: ['open'], mustNot: ['expired'], cite: [[pf, 'permit_status']] } : { must: [p.status.toLowerCase()], mustNot: ['expired'], cite: [[pf, 'permit_status']] });
    for (const [stage, ins, file, phr] of [['Rough-in', p.rough, p.roughFile, ['Did the rough-in pass at', 'What was the rough-in inspection result at']], ['Final', p.final, p.finalFile, ['Did the final inspection pass at', 'What is the final inspection result at']]]) {
      if (ins) {
        q('permit', `${phr[i % 2]} ${a}?`, { must: [ins.result.toLowerCase(), long(ins.date)], cite: [[file, 'inspection_result']] });
        q('permit', `When was the ${stage.toLowerCase()} inspection at ${a}?`, { must: [long(ins.date)], cite: [[file, 'service_date']] });
      } else q('unanswerable', `${phr[i % 2]} ${a}?`, { mode: 'null' });
    }
  });
  const op = T.openPermits(); const xp = T.expiredPermits();
  for (const ph of ['Which permits are still open?', 'Show me open permits', 'What plumbing permits are open right now?'])
    q('permit', ph, { must: op.map((p) => p.no), mustNot: T.permits.filter((p) => !op.includes(p)).map((p) => p.no), cite: op.map((p) => [p.file, 'permit_status']) });
  for (const ph of ['Which permits have expired?', 'Show expired permits', 'Do we have any permits that ran out?'])
    q('permit', ph, { must: xp.map((p) => p.no), mustNot: T.permits.filter((p) => !xp.includes(p)).map((p) => p.no), cite: xp.map((p) => [p.file, 'permit_expires']) });
  for (const n of [7, 30, 120]) { const set = T.permitsExpiring(n); q('permit', `Which open permits expire in the next ${n} days?`, set.length ? { must: set.map((p) => p.no), mustNot: T.permits.filter((p) => !set.includes(p)).map((p) => p.no), cite: set.map((p) => [p.file, 'permit_expires']) } : { must: [], mustNot: T.permits.map((p) => p.no), expectEmpty: true }); }
  q('count', 'How many permits are open?', { must: [`${op.length} permit`], computed: [`${op.length} permit`] });
  q('count', 'How many permits have expired?', { must: [`${xp.length} permit`], computed: [`${xp.length} permit`] });
  q('count', 'How many permits do we have?', { must: [`${T.permits.length} permit`], computed: [`${T.permits.length} permit`] });
  q('permit', 'Which inspections failed?', { must: T.permits.flatMap((p) => [p.rough, p.final].filter((x) => x && /fail/i.test(x.result)).map(() => p.no)), mustNot: T.permits.filter((p) => ![p.rough, p.final].some((x) => x && /fail/i.test(x.result))).map((p) => p.no), cite: T.permits.filter((p) => p.rough && /fail/i.test(p.rough.result)).map((p) => [p.roughFile, 'inspection_result']) });

  /* ---- sewer camera ---- */
  const cams = CAMERAS;
  const cameraSpecs = cams.map((c) => ({ d: { filename: `${c.id}-camera.pdf` }, c }));
  cameraSpecs.forEach(({ d, c }, i) => {
    const s = site(c.site); const a = s.addr; const f = d.filename; const pg = c.pages;
    q('camera', `What did the sewer camera find at ${a}?`, { must: c.findings, cite: [[f, 'line_findings', pg]] });
    q('camera', `What defects were found on the camera inspection for ${s.cust}?`, { must: c.findings, cite: [[f, 'line_findings', pg]] });
    q('camera', `When was the sewer line inspected at ${a}?`, { must: [long(c.date)], cite: [[f, 'service_date']] });
    q('camera', `What was the recommendation from the camera inspection at ${a}?`, { must: [c.rec], cite: [[f, 'recommendation', pg]] });
    q('camera', `What is the footage file for the sewer camera at ${a}?`, { must: [c.footage], cite: [[f, 'footage_ref']] });
    if (i % 2 === 0) { q('camera', `How long a run was inspected at ${a}?`, { must: [c.len], cite: [[f, 'line_length']] }); q('camera', `Which part of the line was camera inspected at ${a}?`, { must: [c.loc], cite: [[f, 'line_location']] }); }
  });
  q('count', 'How many sewer camera reports do we have?', { must: [`${cams.length} sewer camera`], computed: [`${cams.length} sewer camera`] });
  const bad = cameraSpecs.filter(({ c }) => !/no defects/i.test(c.findings[0]));
  q('camera', 'Which sewer lines have defects?', { must: bad.map(({ c }) => site(c.site).addr), mustNot: cameraSpecs.filter((x) => !bad.includes(x)).map(({ c }) => site(c.site).addr), cite: bad.map(({ d, c }) => [d.filename, 'line_findings', c.pages]) });

  /* ---- service tickets, work orders ---- */
  const tk = TICKETS.map((t) => ({ d: { filename: `${t.id}-ticket.pdf` }, t }));
  tk.forEach(({ d, t }, i) => {
    const s = site(t.site); const a = s.addr; const f = d.filename;
    q('service', `What was done at ${a} on the last service call?`, { must: t.work, cite: [[f, 'work_performed']] });
    q('service', `Who was the technician at ${a}?`, { must: [t.tech], cite: [[f, 'technician']] });
    q('service', `When was the service call at ${a}?`, { must: [long(t.date)], cite: [[f, 'service_date']] });
    q('service', `How much was the service ticket for ${s.cust}?`, { must: [money(t.cost)], cite: [[f, 'cost']] });
    if (i % 2 === 0) q('service', `What kind of service call was ${a}?`, { must: [t.type], cite: [[f, 'service_type']] });
  });
  q('count', 'How many service tickets do we have?', { must: [`${tk.length} service ticket`], computed: [`${tk.length} service ticket`] });
  const wos = WORKORDERS.map((w) => ({ d: { filename: `${w.id}-workorder.pdf` }, w }));
  wos.forEach(({ d, w }) => {
    const s = site(w.site); const a = s.addr; const f = d.filename;
    q('service', `What is the work order at ${a}?`, { must: w.work, cite: [[f, 'work_performed']] });
    q('service', `Who is assigned to the work order for ${s.cust}?`, { must: [w.tech], cite: [[f, 'technician']] });
    q('service', `When is the work order scheduled at ${a}?`, { must: [long(w.date)], cite: [[f, 'service_date']] });
  });
  q('count', 'How many work orders do we have?', { must: [`${wos.length} work order`], computed: [`${wos.length} work order`] });
  q('service', `What does the proposal for ${site(PROPOSAL.site).cust} come to?`, { must: [money(PROPOSAL.amount), PROPOSAL.no], cite: [[PROPOSAL.file, 'cost']] });
  q('service', `What work does quote ${PROPOSAL.no} cover?`, { must: [PROPOSAL.scope], cite: [[PROPOSAL.file, 'work_performed']] });
  q('service', `How long is the maintenance agreement at ${site(AGREEMENT.site).addr}?`, { must: [AGREEMENT.term], cite: [[AGREEMENT.file, 'agreement_term']] });
  q('service', `What does the ${site(AGREEMENT.site).cust} agreement cover?`, { must: [AGREEMENT.scope], cite: [[AGREEMENT.file, 'work_performed']] });
  q('service', `What is on purchase order ${PO.no}?`, { must: [PO.item, money(PO.cost)], cite: [[PO.file, 'part_number']] });
  q('service', `Who is going to ${site(DISPATCH.site).addr} and when?`, { must: [DISPATCH.tech, long(DISPATCH.date)], cite: [[DISPATCH.file, 'technician']] });

  /* ---- invoices ---- */
  INVOICES.forEach((iv, i) => {
    const s = site(iv.site);
    q('invoice', `What is the total on invoice ${iv.n}?`, { must: [money(iv.amount)], cite: [[iv.file, 'cost']] });
    if (i % 2 === 0) q('invoice', `What did we bill ${s.cust} for ${iv.desc.toLowerCase()}?`, { must: [money(iv.amount)], cite: [[iv.file, 'cost']] });
  });
  for (const cust of T.customers) {
    const invs = T.invByCust(cust);
    q('invoice', `What is the invoice total for ${cust}?`, { must: [money(T.custTotal(cust)).replace('$', '')], computed: [money(T.custTotal(cust)).replace('$', '')], cite: invs.map((iv) => [iv.file, 'cost']) });
  }
  q('count', 'How many invoices do we have?', { must: [`${INVOICES.length} invoice`], computed: [`${INVOICES.length} invoice`] });

  /* ---- counts by document type (D6) ---- */
  const bt = T.byType;
  q('count', 'How many permits are on file?', { must: [`${bt.permit} permit`], computed: [`${bt.permit} permit`] });
  q('count', 'How many inspection reports are on file?', { must: [`${bt['inspection-report']} inspection report`], computed: [`${bt['inspection-report']} inspection report`] });
  q('count', 'How many warranty registrations do we have?', { must: [`${bt['warranty-registration']} warranty registration`], computed: [`${bt['warranty-registration']} warranty registration`] });
  q('count', 'How many water heater startup sheets or installation records do we have?', { must: [`${bt['startup-sheet']} `], computed: [`${bt['startup-sheet']} `] });
  q('count', 'How many purchase orders do we have?', { must: [`${bt['purchase-order']} purchase order`], computed: [`${bt['purchase-order']} purchase order`] });
  q('count', 'How many proposals or quotes do we have?', { must: [`${bt['proposal-quote']} `], computed: [`${bt['proposal-quote']} `] });

  /* ---- unanswerable: not on file ---- */
  const nulls = [
    'What was the backflow test result at 77 Nowhere Lane?', 'Who tested the RPZ at 9999 Phantom Road?', 'When is the next backflow test due at 700 Thornbird Way?',
    'What is the serial number of the water heater at 700 Thornbird Way?', 'What does the sewer camera show at 88 Harmon Street?', 'When was the water heater at 150 Main Street last flushed?',
    'What is the permit number for 61 Sagebrush Trail?', 'What is the invoice total for Nobody Construction?', 'How much was the service ticket at 5530 Warehouse Way?',
    'Which devices passed their backflow test in 2019?', 'What did the camera find at 61 Sagebrush Trail?',
    'Who is the backflow tester for 700 Thornbird Way?', 'What tonnage is the air conditioner at 700 Thornbird Way?', 'When is the A/C service due at 700 Thornbird Way?',
  ];
  for (const n of nulls) q(n.includes('Thornbird') ? 'decoy' : 'unanswerable', n, { mode: 'null' });
  /* ---- out of scope: general knowledge ---- */
  for (const g of ['Tell me about the weather', 'Who is the best plumber in Arizona?', 'What is the capital of Arizona?', 'How do I solder a copper fitting?', 'What does the plumbing code say about vent pipe size?', 'Write me a poem about pipes'])
    q('general', g, { mode: 'null' });

  // make question text unique (the same phrase can arise from two sources)
  const seen = new Set(); return out.filter((e) => { const k = e.question; if (seen.has(k)) return false; seen.add(k); return true; });
}
