/**
 * Electrical regressions for the classes the independent plumbing review found: a named customer scopes an answer to THAT customer
 * (never the neighbour at the same address), and invoice money is read only from one plain US-dollar total.
 */
import { seedDocs } from './class-variants-core.mjs';
const TODAY = '2026-10-05';
const wipe = async (db) => { await db.raw(`DELETE FROM extractions`, []); await db.raw(`DELETE FROM facets`, []); await db.raw(`DELETE FROM documents`, []); };

export async function runElectricalRegressions({ H, lane, extract, check }) {
  const ask = async (db, q) => { const it = lane.classify(q, { today: TODAY }); const r = it ? await lane.run(db, it, { today: TODAY }) : null; return r && !r.decline ? r : null; };
  const A = '15 Cactus Wren Lane, Mesa AZ';
  await H.as('electrical', async (db) => {
    await wipe(db);
    const pm = (c, n) => ({ filename: `pm-${n}.pdf`, type: 'permit', fields: [{ key: 'service_address', value: A }, { key: 'customer_name', value: c }, { key: 'permit_number', value: n }] });
    const ins = (c, n, res) => ({ filename: `in-${n}.pdf`, type: 'inspection-report', fields: [{ key: 'service_address', value: A }, { key: 'customer_name', value: c }, { key: 'permit_number', value: n }, { key: 'inspection_type', value: 'Final' }, { key: 'inspection_result', value: res }, { key: 'service_date', value: '2026-08-01' }] });
    await seedDocs(db, [pm('Delmar Orchards', 'EL-26-11111'), pm('Ned Fox', 'EL-26-22222'), ins('Delmar Orchards', 'EL-26-11111', 'Failed'), ins('Ned Fox', 'EL-26-22222', 'Passed')]);
    const a = await ask(db, 'What is the permit number for Ned Fox?');
    check('review E1: Ned Fox\'s permit number is his own, never the neighbour\'s at the same address', !a || (/22222/.test(a.text) && !/11111/.test(a.text)), a?.text);
    const b = await ask(db, 'Did Ned Fox pass final inspection?');
    check('review E1: Ned Fox\'s final inspection is his own result (Passed), not the neighbour\'s Failed', !b || (!/failed/i.test(b.text) && /passed/i.test(b.text)), b?.text);
    const c = await ask(db, 'Did Delmar Orchards pass final inspection?');
    check('review E1: Delmar\'s final inspection is Failed, not Ned Fox\'s Passed', !c || (/failed/i.test(c.text) && !/passed/i.test(c.text)), c?.text);
  });
  const ex = (body) => extract([{ page_no: 1, text: `INVOICE\nInvoice No: INV-77\nCustomer: Delmar Orchards\nService Address: ${A}\nDate: 09/01/2026\n${body}` }], { today: TODAY });
  const cost = (r) => r?.fields.find((f) => f.key === 'cost')?.value ?? null;
  for (const t of ['$400.00 CAD', 'C$400.00', '€400.00', '-$400.00', '($400.00)', '$400.00 CR', '$1.200,50', '$ 4 00.00', 'Net 30', '$12,34.00', '$400.00 - $800.00'])
    check(`review E2: electrical invoice total "${t}" is not stored as a dollar amount`, cost(ex(`Total: ${t}`)) === null, String(cost(ex(`Total: ${t}`))));
  check('review E2: a plain total is still read', cost(ex('Total: $1,250.50')) === '1250.50');
  check('review E2: "Amount Due: $0.00 / PAID IN FULL" is not the invoice total', cost(ex('Amount Due: $0.00\nPAID IN FULL')) === null);
  check('review E2: a vendor bill keeps no customer total', cost(ex('From: Graybar Electric\nTotal: $900.00')) === null);
  // ---- loop 2 classes
  await H.as('electrical', async (db) => {
    await wipe(db);
    const pm = (c, a, n) => ({ filename: `pm-${n}.pdf`, type: 'permit', fields: [{ key: 'service_address', value: a }, { key: 'customer_name', value: c }, { key: 'permit_number', value: n }] });
    await seedDocs(db, [pm('Ace Dental', '1 Oak St, Mesa AZ', 'EL-26-11111'), pm('Ace Dental Group', '2 Pine St, Mesa AZ', 'EL-26-22222')]);
    const g = await ask(db, 'What is the permit number for Ace Dental Group?');
    check('review E-L2-F1: "Ace Dental Group" permit is its own (22222), never the shorter name\'s (11111)', !g || (/22222/.test(g.text) && !/11111/.test(g.text)), g?.text);
    const a = await ask(db, 'What is the permit number for Ace Dental?');
    check('review E-L2-F1: "Ace Dental" permit is its own (11111), never the longer name\'s (22222)', !a || (/11111/.test(a.text) && !/22222/.test(a.text)), a?.text);
  });
  const IH = `INVOICE\nInvoice No: INV-9\nCustomer: Delmar Orchards\nService Address: ${A}\nDate: 09/01/2026\n`;
  const c2 = (body, head = IH) => cost(extract([{ page_no: 1, text: head + body }], { today: TODAY }));
  for (const [n, body, head] of [['Status: VOID', 'Status: VOID\nTotal: $400.00'], ['*** CANCELLED ***', '*** CANCELLED ***\nTotal: $400.00'], ['voided and replaced', 'Total: $400.00\nThis invoice was voided and replaced by INV-10'],
    ['Bill From:', 'Total: $400.00', 'INVOICE\nBill From: Graybar\nCustomer: Canyon State Electric\nInvoice No: V-1\n'], ['Please remit', 'Total: $400.00\nPlease remit payment of this invoice to Graybar'], ['Previous Balance', 'Previous Balance: $1,000.00\nTotal Due: $1,432.00'], ['Total: 2026', 'Total: 2026']])
    check(`review E-L2: electrical invoice "${n}" keeps no customer total`, c2(body, head) === null, String(c2(body, head)));
  check('review E-L2: two invoices in one file is not stored as one', extract([{ page_no: 1, text: IH + 'Total: $50.00' }, { page_no: 2, text: IH.replace('INV-9', 'INV-10') + 'Total: $60.00' }], { today: TODAY }) === null);
  check('review E-L2: a customer printed as "Ship To:" is never kept', !extract([{ page_no: 1, text: 'INVOICE\nBill To:                       Ship To:\nDelmar Orchards              Delmar Barn\nTotal: $50.00' }], { today: TODAY })?.fields.some((f) => f.key === 'customer_name' && /ship to/i.test(f.value)));
}
