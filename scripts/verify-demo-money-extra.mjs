// npm run verify:demo-money-extra  - gaps the independent verifier found in the demo round's money tests (each check below was
// shown to FAIL under a planted mutation). No database, no model.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0, passed = 0;
const check = (n, ok, d = '') => { if (ok) passed++; else { failed++; console.log(`FAIL ${n}${d ? ` :: ${d}` : ''}`); } };
const FH = await import(path.join(ROOT, 'api/_lib/modelAvoidance/financialsHook.js'));
const FA = await import(path.join(ROOT, 'api/_lib/financials/answers.js'));
const NM = await import(path.join(ROOT, 'api/_lib/financials/normalize.js'));
const DEMO = await import(path.join(ROOT, 'api/_lib/demo/index.js'));
const pg = (t) => [{ page_no: 1, text: t }];
const OWN = ['Acme HVAC'];
const inv = (extra, bill = 'Bill To: Plaza Dental Group') => `Acme HVAC\nINVOICE\nInvoice #: INV-100\nDate: 09/12/2026\n${bill}\nService Address: 18 N Center St, Mesa, AZ 85201\n${extra}\n`;
const fin = (t, type = 'invoice') => FH.financialsInputFromText(pg(t), type, { ownNames: OWN });
// (a) payment status
check('pay: zero balance with no status is NOT read as unpaid', FH.printedPaymentFromText(pg('Total: $50.00\nBalance Due: $0.00')).printed_status !== 'unpaid');
check('pay: positive balance with no status is unpaid', FH.printedPaymentFromText(pg('Total: $50.00\nBalance Due: $50.00')).printed_status === 'unpaid');
check('pay: Status Paid reads paid, Status Unpaid reads unpaid', FH.printedPaymentFromText(pg('Status: Paid')).printed_status === 'paid' && FH.printedPaymentFromText(pg('Status: Unpaid')).printed_status === 'unpaid');
check('pay: conflicting Paid/Unpaid status lines -> nothing', !FH.printedPaymentFromText(pg('Status: Paid\nStatus: Unpaid')).printed_status);
check('pay: partial invoice keeps amount paid and balance', (() => { const r = FH.printedPaymentFromText(pg('Total: $500.00\nAmount Paid: $200.00\nBalance Due: $300.00')); return r.amount_paid?.value === '200.00' && r.balance_due?.value === '300.00'; })());
check('VOID banner invoice with a Balance Due is NOT stored as an unpaid invoice', fin(inv('VOID\nTOTAL DUE: $182.50\nBalance Due: $182.50')) === null);
check('Status: VOID invoice is left to the model', fin(inv('TOTAL DUE: $182.50\nStatus: VOID')) === null);
check('a normal invoice with a balance is still read', fin(inv('TOTAL DUE: $309.60\nBalance Due: $309.60'))?.printed_status === 'unpaid');
// (b) bills to us
const billToUs = `Desert Supply Co\nINVOICE\nInvoice #: 5511\nDate: 09/10/2026\nBill To: Acme HVAC\nRemit To: Desert Supply Co\nTOTAL DUE: $1,240.00\nBalance Due: $1,240.00`;
check('bill addressed to us is payable with the vendor', (() => { const r = fin(billToUs); return r?.direction === 'payable' && r.vendor_name === 'Desert Supply Co' && !r.customer_name; })());
check('same bill WITHOUT the own-company names is not silently payable (the names matter)', fin(billToUs) && FH.financialsInputFromText(pg(billToUs), 'invoice', { ownNames: [] })?.direction !== 'payable');
check('our invoice to a customer who is also a vendor stays receivable', fin(inv('TOTAL DUE: $400.00\nBalance Due: $400.00', 'Bill To: Desert Supply Co'))?.direction === 'receivable');
// (c) wording
const intent = (q) => FA.parseMoneyIntent(q, { today: '2026-10-22' })?.intent;
for (const q of ["Which invoices haven't been paid?", 'Which invoices have not been paid', 'invoices not yet paid', 'Which invoices were never paid']) check(`"${q}" is open invoices`, intent(q) === 'open_invoices', String(intent(q)));
for (const q of ['How many invoices have been paid?', 'Which invoices are paid?']) check(`"${q}" is still paid invoices`, intent(q) === 'payment_status');
for (const q of ['vendor invoices', 'supplier invoices', 'unpaid supplier invoices', 'How many supplier invoices do we have']) check(`"${q}" means bills we owe`, intent(q) === 'payables_open', String(intent(q)));
check('"never paid" is not read as a customer called "never"', !(FA.parseMoneyIntent('How many invoices were never paid', { today: '2026-10-22' })?.subject));
// (d) receipts
check('receipt is a financial document type (so receipts are written to the money table)', NM.isFinancialDocumentType('receipt') && NM.FINANCIAL_KINDS_BY_TYPE.receipt.includes('receipt'));
const rc = fin('Desert Supply Co\nRECEIPT\nReceipt #: R-1\nDate: 10/02/2026\nSold By: Desert Supply Co\nSold To: Acme HVAC\nTotal: $43.84', 'receipt');
check('receipt sold to us is payable spending with its vendor', rc?.kind === 'receipt' && rc.direction === 'payable' && rc.total.value === '43.84' && rc.vendor_name === 'Desert Supply Co', JSON.stringify(rc));
const ans = fs.readFileSync(path.join(ROOT, 'api/_lib/financials/answers.js'), 'utf8');
check('vendor spending SQL counts receipts (both the total and the cited rows)', (ans.match(/f\.direction = 'payable' AND f\.doc_kind IN \('invoice', 'receipt'\)/g) ?? []).length >= 2);
// demo blocks
check('demo: financials correct / verify / backfill and graph refresh are turned off; reads stay open', ['correct', 'verify', 'backfill'].every((o) => DEMO.demoAccountBlocked('financials', o)) && DEMO.demoAccountBlocked('graph', 'refresh') && !DEMO.demoAccountBlocked('financials', 'document') && !DEMO.demoAccountBlocked('graph', 'status'));
check('demo: notification SETTINGS are turned off, marking read is not', DEMO.demoAccountBlocked('notifications', '', { settings: { emailDigest: true } }) && !DEMO.demoAccountBlocked('notifications', '', { markRead: ['x'] }));
check('demo: support handoff email is turned off, chat is not', DEMO.demoAccountBlocked('support', '', { action: 'handoff' }) && !DEMO.demoAccountBlocked('support', '', { message: 'hi' }));
console.log(`verify:demo-money-extra  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
