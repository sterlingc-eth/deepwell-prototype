/**
 * Permanent regressions from the independent plumbing review (one per finding, written as classes):
 *  F1 a named customer scopes every answer to THAT customer, never to other customers at the same address
 *  F2/F3 invoice money is read only from one plain US-dollar total (no currency / sign / CR / comma-decimal / spaced digits / range / "Net 30";
 *        "Amount Due $0.00 / PAID IN FULL" and vendor bills are not customer totals)
 *  F4 water heater type / fuel are negation-aware and never guessed when both are named
 *  F5 a renewed / extended permit keeps no printed expiry   F6 a "NOT REGISTERED" warranty card is not an active warranty
 *  F7 serial-less certificates at one address with different dates are ambiguous   F8 a cleared permit status and "Passed - needs repair" are not guessed
 */
import { seedDocs, leadNumber } from './class-variants-core.mjs';

const TODAY = '2026-10-05';
const wipe = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };

export async function runPlumbingRegressions({ H, lane, extract, resultClass, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline ? r : null; };
  const A = '15 Cactus Wren Lane, Mesa AZ';
  // ---- F1
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const inv = (c, a, n, cost) => ({ filename: `inv-${n}.pdf`, type: 'invoice', fields: [{ key: 'service_address', value: a }, { key: 'customer_name', value: c }, { key: 'invoice_number', value: n }, { key: 'cost', value: cost }, { key: 'service_date', value: '2026-09-01' }] });
    const bf = (c, n, due) => ({ filename: `bf-${n}.pdf`, type: 'backflow-test-certificate', fields: [{ key: 'service_address', value: A }, { key: 'customer_name', value: c }, { key: 'serial_number', value: n }, { key: 'service_date', value: '2026-01-01' }, { key: 'backflow_test_result', value: 'Passed' }, { key: 'next_test_due', value: due }] });
    const pm = (c, n) => ({ filename: `pm-${n}.pdf`, type: 'permit', fields: [{ key: 'service_address', value: A }, { key: 'customer_name', value: c }, { key: 'permit_number', value: n }, { key: 'permit_status', value: 'Open' }, { key: 'permit_expires', value: '2027-01-01' }] });
    const tk = (c, n, who) => ({ filename: `tk-${n}.pdf`, type: 'service-ticket', fields: [{ key: 'service_address', value: A }, { key: 'customer_name', value: c }, { key: 'technician', value: who }, { key: 'service_date', value: '2026-08-01' }, { key: 'work_performed', value: `work ${n}` }] });
    await seedDocs(db, [inv('Delmar Orchards', A, 'INV-1', '100'), inv('Ned Fox', A, 'INV-2', '250'), inv('Ned Fox', '3 Pebble St, Mesa AZ', 'INV-3', '25'), bf('Delmar Orchards', 'D1', '2026-02-01'), bf('Ned Fox', 'N1', '2027-02-01'), pm('Delmar Orchards', 'P-D'), pm('Ned Fox', 'P-N'), tk('Delmar Orchards', 'D', 'Dana Ruiz'), tk('Ned Fox', 'N', 'Nico Park')]);
    const a = await ask(db, 'What did we bill Ned Fox?');
    check('review F1: "What did we bill Ned Fox?" is Ned Fox only ($275.00, 2 invoices)', !a || (/\$275\.00/.test(a.text) && leadNumber(a.text) === 2), a?.text);
    const b = await ask(db, 'Which backflow tests are overdue for Ned Fox?');
    check('review F1: Ned Fox\'s backflow list never includes the other customer\'s overdue device', !b || (!/\bD1\b|February 1, 2026/.test(b.text)), b?.text);
    const c = await ask(db, 'What is the permit number for Ned Fox?');
    check('review F1: Ned Fox\'s permit number is P-N, never the neighbour\'s', !c || (/P-N/.test(c.text) && !/P-D/.test(c.text)), c?.text);
    const d = await ask(db, 'Who was the technician on the last service ticket for Ned Fox?');
    check('review F1: Ned Fox\'s technician is not the other customer\'s', !d || (/Nico Park/.test(d.text) && !/Dana Ruiz/.test(d.text)), d?.text);
    const e = await ask(db, 'What did we bill Delmar Orchards?');
    check('review F1: Delmar\'s bill does not include Ned Fox\'s $250.00', !e || !/\$350\.00|\$250\.00/.test(e.text), e?.text);
  });
  // ---- F2 / F3 extractor money
  const ex = (body, head = 'INVOICE\nInvoice No: INV-77\nBill To: Delmar Orchards\nService Address: 15 Cactus Wren Lane, Mesa AZ\nDate: 09/01/2026\n') => extract([{ page_no: 1, text: head + body }], { today: TODAY });
  const cost = (r) => r?.fields.find((f) => f.key === 'cost')?.value ?? null;
  for (const t of ['$400.00 CAD', 'CAD 400.00', 'C$400.00', '$400.00 MXN', '€400.00', '£400.00', '-$400.00', '($400.00)', '$400.00 CR', 'Credit $400.00', '$1.200,50', '$ 4 00.00', 'Net 30', '$12,34.00', '$400.00 - $800.00', '$400.00/mo', '$400.00 plus tax'])
    check(`review F2/F3: invoice total "${t}" is not stored as a dollar amount`, cost(ex(`Total: ${t}`)) === null, String(cost(ex(`Total: ${t}`))));
  for (const [t, v] of [['$400.00', '400.00'], ['400.00 USD', '400.00'], ['$1,200.50', '1200.50'], ['$400', '400']]) check(`review F2: plain total "${t}" is still read`, cost(ex(`Total: ${t}`)) === v, String(cost(ex(`Total: ${t}`))));
  check('review F3: "Amount Due: $0.00 / PAID IN FULL" is not the invoice total', cost(ex('Description: Repipe\nAmount Due: $0.00\nPAID IN FULL')) === null);
  check('review F3: a deposit paper keeps its Total, not the balance', cost(ex('Deposit received: $500.00\nTotal: $2,000.00\nBalance Due: $1,500.00')) === '2000.00');
  check('review F2: a vendor bill (From: supplier, Bill To: the company itself) keeps no customer total', cost(ex('Total: $1,695.00', 'INVOICE\nInvoice No: V-9\nFrom: Ferguson Enterprises\nTo: Canyon State Plumbing LLC\nPO Number: PO-7745\n')) === null && cost(ex('Total: $900.00\nStatus: Payable', 'INVOICE\nInvoice No: F-1\nBill To: Canyon State Plumbing LLC\n')) === null);
  // ---- F4 lane
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const su = (i, type, fuel) => ({ filename: `su${i}.pdf`, type: 'startup-sheet', fields: [{ key: 'serial_number', value: `WHX${i}` }, { key: 'service_address', value: `${100 + i} Elm Street, Mesa AZ` }, { key: 'manufacturer', value: 'Rheem' }, { key: 'equipment_type', value: type }, { key: 'fuel_type', value: fuel }, { key: 'installation_date', value: '2024-01-01' }] });
    await seedDocs(db, [su(1, 'Conventional storage tank (not tankless)', 'Natural Gas'), su(2, 'Tank', 'Gas (120V electric ignition)'), su(3, 'Tank', 'Gas / Electric'), su(4, 'Tankless', 'Gas')]);
    const t = await ask(db, 'How many tankless water heaters do we have?');
    check('review F4: "(not tankless)" is a tank heater: tankless count is 1 (or declined)', !t || leadNumber(t.text) === 1, t?.text);
    const e = await ask(db, 'How many electric water heaters do we have?');
    check('review F4: "Gas (120V electric ignition)" and "Gas / Electric" are never counted as electric', !e || leadNumber(e.text) === 0 || /^none/i.test(e.text), e?.text);
  });
  // ---- F5 / F6 / F8 extractor + resultClass
  const pm = (b) => extract([{ page_no: 1, text: `PLUMBING PERMIT\nPermit No: PL-26-777\nService Address: ${A}\nIssued: 03/02/2026\n${b}` }], { today: TODAY });
  check('review F5: "Expires ... Renewed to ..." keeps no expiry', !pm('Expires: 09/02/2026\nRenewed to: 09/02/2027\nStatus: Open')?.fields.some((f) => f.key === 'permit_expires'));
  check('review F5: "Extension granted through ..." keeps no expiry', !pm('Expires: 09/02/2026\nExtension granted through 03/02/2027\nStatus: Active')?.fields.some((f) => f.key === 'permit_expires'));
  check('review F5: a plain permit keeps its expiry', pm('Expires: 09/02/2026\nStatus: Open')?.fields.some((f) => f.key === 'permit_expires' && f.value === '2026-09-02'));
  const wr = extract([{ page_no: 1, text: 'WARRANTY REGISTRATION\nSerial Number: WH111\nWarranty Expires: 03/15/2032\nStatus: NOT REGISTERED' }], { today: TODAY });
  check('review F6: "NOT REGISTERED" warranty card keeps no warranty expiry', !wr || !wr.fields.some((f) => f.key === 'warranty_expires'));
  for (const v of ['Passed - needs repair', 'Repair & pass', 'Passed, repairs required', 'Approved subject to repair']) check(`review F8: result "${v}" is not classed passed`, resultClass(v) !== 'passed', resultClass(v));
  check('review F8: plain results still classify', resultClass('Passed') === 'passed' && resultClass('Failed') === 'failed' && resultClass('Passed, no repairs required') === 'passed');
  // ---- F7 / F8 lane
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const c = (n, date, due) => ({ filename: `c${n}.pdf`, type: 'backflow-test-certificate', fields: [{ key: 'service_address', value: A }, { key: 'customer_name', value: 'Delmar Orchards' }, { key: 'service_date', value: date }, { key: 'backflow_test_result', value: 'Passed' }, { key: 'next_test_due', value: due }] });
    await seedDocs(db, [c(1, '2025-01-01', '2026-01-01'), c(2, '2026-03-01', '2027-03-01')]);
    const r = await ask(db, 'Which backflow tests are overdue?');
    check('review F7: two serial-less certificates at one address with different dates are not merged into "None overdue"', !r || !/^none/i.test(r.text) || /could not be read|disagrees/.test(r.text), r?.text);
    await wipe(db);
    await seedDocs(db, [{ filename: 'p1.pdf', type: 'permit', fields: [{ key: 'service_address', value: A }, { key: 'customer_name', value: 'Delmar Orchards' }, { key: 'permit_number', value: 'PL-9' }, { key: 'permit_status', value: 'Final', corrected: '' }, { key: 'permit_expires', value: '2027-06-01' }] }]);
    const o = await ask(db, 'How many permits are open?');
    check('review F8: a human-cleared permit status is not counted open (declines)', !o, o?.text);
  });
  // ================= loop 2 =================
  // ---- L2-F1 a name that is a word-prefix of a longer customer name
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const inv = (c, a, n, cost) => ({ filename: `inv-${n}.pdf`, type: 'invoice', fields: [{ key: 'service_address', value: a }, { key: 'customer_name', value: c }, { key: 'invoice_number', value: n }, { key: 'cost', value: cost }, { key: 'service_date', value: '2026-09-01' }] });
    const pm = (c, a, n) => ({ filename: `pm-${n}.pdf`, type: 'permit', fields: [{ key: 'service_address', value: a }, { key: 'customer_name', value: c }, { key: 'permit_number', value: n }, { key: 'permit_status', value: 'Open' }, { key: 'permit_expires', value: '2027-01-01' }] });
    await seedDocs(db, [inv('Ace Dental', '1 Oak St, Mesa AZ', 'I1', '100'), inv('Ace Dental Group', '2 Pine St, Mesa AZ', 'I2', '1000'), pm('Ace Dental', '1 Oak St, Mesa AZ', 'P-A'), pm('Ace Dental Group', '2 Pine St, Mesa AZ', 'P-G')]);
    const g = await ask(db, 'What did we bill Ace Dental Group?');
    check('review L2-F1: "Ace Dental Group" is billed $1,000.00 only (never $1,100 / the shorter name\'s invoice)', !g || (/\$1,000\.00/.test(g.text) && !/\$1,100\.00|\$100\.00/.test(g.text)), g?.text);
    const a = await ask(db, 'What did we bill Ace Dental?');
    check('review L2-F1: "Ace Dental" is $100.00 only', !a || (/\$100\.00/.test(a.text) && !/\$1,100\.00|\$1,000\.00/.test(a.text)), a?.text);
    const x = await ask(db, 'How much did we invoice Ace Dental Group at 1 Oak St?');
    check('review L2-F1: a named address that belongs to the other customer declines', !x, x?.text);
    const p = await ask(db, 'What is the permit number for Ace Dental Group?');
    check('review L2-F1: permit for "Ace Dental Group" is P-G only', !p || (/P-G/.test(p.text) && !/P-A\b/.test(p.text)), p?.text);
  });
  // ---- L2-F3 vendor bill billed to the company's own name (lane)
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const { rows } = await db.raw(`SELECT name FROM tenants WHERE id = (current_setting('app.tenant_id', true))::uuid`, []);
    await seedDocs(db, [{ filename: 'own.pdf', type: 'invoice', fields: [{ key: 'service_address', value: '1 A St, Mesa AZ' }, { key: 'customer_name', value: rows[0]?.name ?? 'Own Co' }, { key: 'invoice_number', value: 'OWN-1' }, { key: 'cost', value: '100' }, { key: 'service_date', value: '2026-09-01' }] }]);
    const r = await ask(db, 'What is the total on invoice OWN-1?');
    check('review L2-F3: an invoice billed to the company\'s own name is not answered as a customer invoice', !r, r?.text);
  });
  // ---- L2-F7 permit statuses
  await H.as('plumbing', async (db) => {
    await wipe(db);
    const pm = (n, st) => ({ filename: `pm-${n}.pdf`, type: 'permit', fields: [{ key: 'service_address', value: `${n.length} Elm St, Mesa AZ` }, { key: 'permit_number', value: n }, { key: 'permit_status', value: st }, { key: 'permit_expires', value: '2027-06-01' }] });
    await seedDocs(db, [pm('PH-1', 'Final Hold'), pm('PH-22', 'Closed Without Final'), pm('PH-333', 'Closed - No Final'), pm('PH-4444', 'Final')]);
    const o = await ask(db, 'How many permits are open?');
    check('review L2-F7: "Final Hold", "Closed Without Final" and "Closed - No Final" are open (3), only "Final" is finished', !o || leadNumber(o.text) === 3, o?.text);
  });
  // ---- extractor classes
  const IH = 'INVOICE\nInvoice No: INV-9\nBill To: Delmar Orchards\nService Address: 15 Cactus Wren Lane, Mesa AZ\nDate: 09/01/2026\n';
  const c2 = (body, head = IH) => cost(extract([{ page_no: 1, text: head + body }], { today: TODAY }));
  for (const [n, body, head] of [['Status: VOID', 'Status: VOID\nTotal: $400.00'], ['*** CANCELLED ***', '*** CANCELLED ***\nTotal: $400.00'], ['VOID first line', 'Total: $400.00', 'VOID\n' + IH], ['voided and replaced', 'Total: $400.00\nThis invoice was voided and replaced by INV-10'],
    ['Bill From:', 'Total: $400.00', 'INVOICE\nBill From: Ferguson\nBill To: Canyon State Plumbing\nInvoice No: V-1\n'], ['Invoice from X', 'Total: $400.00', 'INVOICE\nInvoice from Ferguson Enterprises\nInvoice No: V-1\nBill To: Canyon State Plumbing\n'], ['Please remit', 'Total: $400.00\nPlease remit payment of this invoice to Ferguson'], ['Sold By', 'Total: $400.00', 'INVOICE\nSold By: Ferguson\nInvoice No: V-1\nBill To: Canyon State Plumbing\n'],
    ['Previous Balance', 'Previous Balance: $1,000.00\nTotal Due: $1,432.00'], ['Total: 2026', 'Total: 2026'], ['Total: 400', 'Total: 400']])
    check(`review L2-F2/F3/F5/F8: invoice "${n}" keeps no customer total`, c2(body, head) === null, String(c2(body, head)));
  check('review L2-F2: an ordinary invoice keeps its total', c2('Total: $400.00') === '400.00');
  const ex2 = (pages) => extract(pages.map((t, i) => ({ page_no: i + 1, text: t })), { today: TODAY });
  check('review L2-F4: two permits in one file (PL-1 then PL-2) is not stored as one permit', ex2(['PLUMBING PERMIT\nPermit No: PL-1\nService Address: 1 A St, Mesa AZ\nStatus: Open', 'PLUMBING PERMIT\nPermit No: PL-2\nService Address: 2 B St, Mesa AZ\nStatus: Open']) === null);
  check('review L2-F4: two invoices in one file (INV-9 then INV-10) is not stored as one invoice', ex2([IH + 'Total: $50.00', IH.replace('INV-9', 'INV-10') + 'Total: $60.00']) === null);
  check('review L2-F4: two backflow certificates in one file (two addresses, same title) is not stored as one', ex2(['BACKFLOW TEST REPORT\nSerial Number: S1\nService Address: 1 A St, Mesa AZ\nTest Date: 03/02/2026\nResult: Passed', 'BACKFLOW TEST REPORT\nSerial Number: S2\nService Address: 2 B St, Mesa AZ\nTest Date: 03/02/2026\nResult: Failed']) === null);
  const cust = (t) => extract([{ page_no: 1, text: t }], { today: TODAY })?.fields.find((f) => f.key === 'customer_name')?.value ?? null;
  check('review L2-F6: "Bill To:   Ship To:" two-column header never gives a customer named "Ship To:"', !/ship to/i.test(String(cust('INVOICE\nBill To:                       Ship To:\nDelmar Orchards              Delmar Orchards Barn\n15 Cactus Wren Lane          9 Barn Rd\nTotal: $50.00'))));
  const f1 = (t, k) => extract([{ page_no: 1, text: t }], { today: TODAY })?.fields.find((f) => f.key === k)?.value ?? null;
  const AG = 'MAINTENANCE AGREEMENT\nAgreement No: A-1\nCustomer: Mesa Grill\n';
  check('review L2-F8: agreement "Term: 1" and "Term: 2026" are not read as a length', f1(AG + 'Term: 1', 'agreement_term') === null && f1(AG + 'Term: 2026', 'agreement_term') === null && f1(AG + 'Term: 12 months', 'agreement_term') === '12 months');
  const TK = (tech) => `SERVICE TICKET\nTicket No: T-1\nCustomer: Mesa Grill\nService Address: 3 Elm St, Mesa AZ\nTechnician: ${tech}\nWork performed: Repair`;
  check('review L2-F8: two technicians on one line are not one technician', f1(TK('Ann Lee (reassigned to Bob Ray)'), 'technician') === null && f1(TK('Ann Lee and Bob Ray'), 'technician') === null && f1(TK('Ann Lee'), 'technician') === 'Ann Lee');
  check('review L2-F9: a ticket "Parts: $50.00" is a price, not a part number', !extract([{ page_no: 1, text: 'SERVICE TICKET\nTicket No: T-1\nCustomer: Mesa Grill\nService Address: 3 Elm St, Mesa AZ\nTechnician: Ann Lee\nParts: $50.00\nLabor: $100.00\nTotal: $150.00' }], { today: TODAY })?.fields.some((f) => f.key === 'part_number' && /^\$/.test(f.value)));
  check('review L2-F10: a two-column serial / manufacturer header row never merges "S1 Watts" into one value', !ex2(['BACKFLOW TEST REPORT\nSerial Number:        Manufacturer:\nS1                     Watts\nService Address: 1 A St, Mesa AZ\nResult: Passed'])?.fields.some((f) => /S1 Watts/.test(f.value)));
}
