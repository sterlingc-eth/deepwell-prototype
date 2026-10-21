// npm run verify:inbox-team
// Inbox round (2026-10-21): reproduces the five patterns from the Sonoran Comfort Air inbox read (A-E) on synthetic fixtures and
// checks the inbox now asks a person only about real decisions. Pure: no database, no model, no network.
import * as React from 'react';
(globalThis as unknown as { React: typeof React }).React = React;
import * as dt from '../api/_lib/documentTypes.js';
import * as hv from '../src/domains/hvac/documentTypes';
import { planLabelFill, addressFromFilename } from '../api/_lib/modelAvoidance/labelFill.js';
import { issuerNotCustomer } from '../api/_lib/modelAvoidance/ownCompany.js';
import { orgNameTypo, evaluatePair, ENTITY_SUGGEST_THRESHOLD } from '../api/_lib/entities/similarity.js';
import { evaluateCustomerMatch } from '../api/_lib/integrity.js';
import { planPossibleDuplicates } from '../api/_lib/routes/customers.js';
import { recomputeIssues, withPossibleCopies, isAnswerable, isSetAside, requiredFieldsForDoc } from '../src/core/entityGraph';
import { hvacSchema } from '../src/domains/hvac/schema';
import { isAttention } from '../src/screens/ReviewScreen';
import { needInfo } from '../src/screens/reviewGrouping';
import type { Doc } from '../src/core/types';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const F = (k: string, v = 'x', c = 0.95) => ({ field_key: k, value: v, confidence: c });
const ac = (type: string, fields: object[], o: object = {}) => dt.autoCheckDecision(type, fields as never, { hasText: true, ...o });
const pages = (...lines: string[]) => [{ page_no: 1, text: lines.join('\n') }];
console.log('verify:inbox-team');

// ---- A. required facts that fit the paper ----
check('A1 walk-in receipt (amount + date, no customer, no vendor) is checked without a person', ac('receipt', [F('cost', '11.73'), F('service_date', '2026-03-02')]).ok);
check('A1 receipt with only a number and an amount is checked', ac('receipt', [F('cost', '20'), F('invoice_number', 'R-20120')]).ok);
check('A1 an unsure store name read from the letterhead no longer blocks a receipt', ac('receipt', [F('cost', '9'), F('service_date', '2026-01-01'), F('vendor', 'Copperline Fuel', 0.8)]).ok);
check('A1 an unsure CUSTOMER name still blocks (it decides which customer the paper joins)', !ac('receipt', [F('cost', '9'), F('service_date', '2026-01-01'), F('customer_name', 'P Roberts', 0.6)]).ok);
check('A1 a receipt with no amount still asks', !ac('receipt', [F('service_date', '2026-01-01')]).ok);
eq('A2 invoice keeps the owner rule (party, date, amount)', dt.REQUIRED_FIELDS.invoice, ['customer_name|vendor', 'service_date', 'cost']);
{
  const plan = planLabelFill({ type: 'invoice', fields: [F('customer_name', 'Summit Line Electric'), F('cost', '1110.70')], pages: pages('TAX INVOICE', 'Invoice   INV85254     Issued   04/29/2026', 'BILL TO', 'Summit Line Electric', 'Amount Due $1,110.70'), today: '2026-10-21' });
  eq('A2 an invoice printing "Issued 04/29/2026" gets its date from the page', plan.add.find((f: { field_key: string }) => f.field_key === 'service_date')?.value, '2026-04-29');
}
{
  const plan = planLabelFill({ type: 'work-order', fields: [], pages: pages('MAINTENANCE WORK ORDER', 'Work Order #:   WO-4400     Date Reported:   March 20, 2025', 'Premises:   9758 Mesquite Row Unit A, Frisco, TX 75033'), today: '2026-10-21' });
  const got = Object.fromEntries(plan.add.map((f: { field_key: string; value: string }) => [f.field_key, f.value]));
  check('A2 a work order printing "Date Reported" gets its date', got.service_date === '2025-03-20', JSON.stringify(got));
  check('A2 a work order printing "Premises" gets its service address', /9758 Mesquite Row/.test(String(got.service_address ?? '')), JSON.stringify(got));
}
check('A2 a work order with a number but no date read is complete', dt.completenessFor('work-order', [F('service_address', '1 Main St'), F('invoice_number', 'WO-4409')]).complete);
eq('A3 pickup ticket read as an invoice is filed as a delivery / pickup ticket', dt.resolveDocumentType({ document_type: 'invoice', document_type_confidence: 0.9 }, {}, 'Pickup Ticket PT-8803 RA-4022.pdf').documentType, 'delivery-ticket');
check('A3 a pickup ticket needs no amount', ac('delivery-ticket', [F('invoice_number', 'PT-8803'), F('customer_name', 'Keller Demolition Group')], { filename: 'Pickup Ticket PT-8803.pdf' }).ok);
eq('A3 "WO 7314 - Pearson" read as an invoice is a work order', dt.resolveDocumentType({ document_type: 'invoice', document_type_confidence: 0.9 }, {}, 'WO 7314 - Pearson.docx').documentType, 'work-order');
check('A3 an invoice whose name says invoice is never moved to work order', dt.resolveDocumentType({ document_type: 'invoice', document_type_confidence: 0.9 }, {}, 'Invoice for WO 7314.pdf').documentType === 'invoice');
for (const n of ['NDA - Ibarra and Lakeshore.pdf', 'Pledge Form - Ruiz.pdf', 'Engagement Letter EN-2026-131 - Calloway.pdf', 'MOU - Beacon (Youth).pdf', 'Volunteer Agreement - Tran.pdf', 'Grant Agreement GR-26-8763 - Silverleaf.pdf']) {
  check(`A4 ${n}: a party alone is enough (no term demanded)`, ac('agreement', [F('customer_name', 'Counterparty Org')], { filename: n }).ok);
}
check('A4 a lease still needs its term (a lease always prints one)', !ac('agreement', [F('customer_name', 'Maria Lopez')], { filename: 'Lease - 4361 Limestone Dr.pdf' }).ok);
check('A4 a grant award with nothing read but page text is filed as company paper', ac('agreement', [], { filename: 'Award Letter - Valdez GR-25-5397.pdf' }).ok);
eq('A5 permit address from the file name when the page prints it too', addressFromFilename('Permit PLB26-72783 - 7442 W Palo Dr.pdf', pages('Site Address  7442 W Palo Dr, Mesa AZ')), '7442 W Palo Dr');
eq('A5 ...never when the page does not print it', addressFromFilename('Permit PLB26-72783 - 7442 W Palo Dr.pdf', pages('Site Address  12 Elm St')), null);
check('A6 change order "CO-02" needs only an amount or the work (once it is on a job)', ac('proposal-quote', [F('cost', '850')], { filename: 'Quote CO-02 Palo.pdf', hasLink: true }).ok);
eq('A6 ...without a job it asks only which job, not for a customer name or address', ac('proposal-quote', [F('cost', '850')], { filename: 'Quote CO-02 Palo.pdf' }).reason, 'needs-link');

// ---- B. the right type ----
const R = (model: string, name: string, facts = {}) => dt.resolveDocumentType({ document_type: model, document_type_confidence: 0.9 }, facts, name).documentType;
eq('B1 plumbing licence read as warranty registration', R('warranty-registration', 'Plumbing License - Chloe Alvarez.pdf'), 'license-certification');
eq('B1 electrician licence read as warranty registration', R('warranty-registration', 'Electrician License - Julian Delgado.pdf'), 'license-certification');
check('B1 a licence is company paper checked on its page text', ac('license-certification', [], { filename: 'Electrician License - Grace Walsh.jpg' }).ok);
eq('B2 certificate of insurance read as warranty registration', R('warranty-registration', 'Certificate of Insurance - Meridian 2025.pdf'), 'insurance-certificate');
eq('B2 ...even with a serial number on it', R('warranty-registration', 'Certificate of Insurance - Meridian 2025.pdf', { serial_number: 'X1' }), 'insurance-certificate');
eq('B2 a real warranty card with a serial is never moved', R('warranty-registration', 'Warranty Registration - Brightwater.pdf', { serial_number: 'X1' }), 'warranty-registration');
eq('B3 equipment floater declarations', R('warranty-registration', 'Equipment Floater Declarations - Cardinal.pdf', { serial_number: 'EQ-1' }), 'insurance-certificate');
eq('B3 ...shown as an insurance policy', dt.documentKindFor('insurance-certificate', 'Equipment Floater Declarations - Cardinal.pdf')?.id, 'insurance-policy');
eq('B4 subcontract read as warranty registration', R('warranty-registration', 'Subcontract SC-133 - Meridian.pdf'), 'agreement');
eq('B5 return slip read as an insurance certificate', R('insurance-certificate', 'Return Slip RC-0304.pdf'), 'receipt');
eq('B5 ...shown as a return slip', dt.documentKindFor('receipt', 'Return Slip RC-0304.pdf')?.id, 'return-slip');
eq('B6 pay application', dt.documentKindFor('invoice', 'Pay App 06 Bennett.pdf')?.id, 'pay-application');
check('B6 a pay application with a party and an amount needs no service date', ac('invoice', [F('customer_name', 'Bennett'), F('cost', '45000')], { filename: 'Pay App 06 Bennett.pdf' }).ok);
eq('B7 backflow test read as an invoice', R('invoice', 'Backflow Test BF-2202 Brightwater.pdf'), 'inspection-report');
eq('B7 ...shown as a backflow test', dt.documentKindFor('inspection-report', 'Backflow Test BF-2202 Brightwater.pdf')?.id, 'backflow-test');
eq('B8 inventory count kind', dt.documentKindFor('internal', 'Inventory Count 2026-03.xlsx')?.id, 'inventory-count');
eq('B8 consignor statement kind', dt.documentKindFor('statement', 'Consignor Statement CS-14.pdf')?.id, 'consignor-statement');
eq('B8 retainer receipt kind', dt.documentKindFor('receipt', 'Retainer Receipt - Calloway.pdf')?.id, 'retainer-receipt');
eq('B8 credit memo kind', dt.documentKindFor('invoice', 'Credit Memo CM-210 - Escobar.pdf')?.id, 'credit-memo');
eq('B8 packing slip kind', dt.documentKindFor('delivery-ticket', 'Packing Slip PS-48434 Desert.pdf')?.id, 'packing-slip');
eq('B8 display label', dt.documentTypeDisplayLabel('agreement', { filename: 'NDA - Ibarra.pdf' }), 'Agreement / contract · Non-disclosure agreement');
// browser and server kinds agree
eq('B9 browser and server list the same kinds', hv.DOCUMENT_KINDS.map((k) => [k.id, k.type, k.label, String(k.re), k.requires ?? null]), dt.DOCUMENT_KINDS.map((k: { id: string; type: string; label: string; re: RegExp; requires?: string[] }) => [k.id, k.type, k.label, String(k.re), k.requires ?? null]));
for (const n of ['Pay App 06 Bennett.pdf', 'NDA - Ibarra.pdf', 'Return Slip RC-0304.pdf', 'Plain invoice 44.pdf']) {
  const t = dt.inferTypeFromFilename(n) ?? 'invoice';
  eq(`B9 browser and server require the same facts: ${n}`, hv.requiredFieldsFor(t, n), dt.requiredFieldsFor(t, { filename: n }));
}

// ---- C. extraction errors ----
check('C1 "DELIVERED TO" is a label, not a customer', dt.isLabelValue('DELIVERED TO') && dt.isLabelValue('Bill To:') && dt.isLabelValue('N/A') && dt.isLabelValue('Walk-in customer'));
check('C1 real names are not labels', !dt.isLabelValue('Priya Roberts') && !dt.isLabelValue('Delivery Express LLC') && !dt.isLabelValue('Customer Service Pros Inc'));
check('C1 a label-valued customer does not satisfy an invoice', !dt.completenessFor('invoice', [F('customer_name', 'DELIVERED TO'), F('service_date', '2026-01-01'), F('cost', '1622.77')]).complete);
check('C1 the label scan never offers a label as the customer', !planLabelFill({ type: 'invoice', fields: [F('service_date', '2026-01-01'), F('cost', '5')], pages: pages('BILL TO                         DELIVERED TO', 'Cardinal Ridge Construction     Eli Valdez'), today: '2026-10-21' }).add.some((f: { field_key: string; value: string }) => f.field_key === 'customer_name' && /delivered/i.test(f.value)));
check('C2 OCR misspelling of an organisation is suggested', orgNameTypo('Harboright Neighbors Alliance', 'Harborlight Neighbors Alliance') && evaluatePair({ name: 'Harboright Neighbors Alliance' }, { name: 'Harborlight Neighbors Alliance' }).score >= ENTITY_SUGGEST_THRESHOLD);
check('C2 two people with similar names are never suggested this way', !orgNameTypo('Maria Lopez', 'Mario Lopez'));
check('C2 two businesses differing by their trade word are not suggested', !orgNameTypo('Desert Ridge Dental', 'Desert Ridge Rental'));
check('C2 never an automatic merge', evaluateCustomerMatch({ name: 'Harboright Neighbors Alliance' }, { name: 'Harborlight Neighbors Alliance' }).tier !== 'auto');
{
  const pairs = planPossibleDuplicates([{ id: 'a', name: 'Harboright Neighbors Alliance', address: '' }, { id: 'b', name: 'Harborlight Neighbors Alliance', address: '7714 N Aspen Way, Tacoma, WA 98483' }, { id: 'c', name: 'Harborview Apartments', address: '' }]);
  eq('C2 the Customers list offers the pair for a person to merge', pairs.map((p: { aId: string; bId: string; reason: string }) => [p.aId, p.bId, p.reason]), [['a', 'b', 'likely typo']]);
  const far = planPossibleDuplicates([{ id: 'a', name: 'Harboright Neighbors Alliance', address: '1 Elm St, Tacoma, WA' }, { id: 'b', name: 'Harborlight Neighbors Alliance', address: '7714 N Aspen Way, Tacoma, WA' }]);
  eq('C2 ...but not when both have different addresses', far.length, 0);
}
{
  const p = pages('JUNIPER LANE MERCANTILE', '214 Main St, Bisbee, AZ 85603 | (520) 555-0100', 'SALES RECEIPT', 'Sold To: Juniper Lane Mercantile');
  const r = issuerNotCustomer([F('customer_name', 'Juniper Lane Mercantile'), F('cost', '12')], p);
  check('C3 the store on the letterhead is moved from customer to vendor', !r.fields.some((f: { field_key: string }) => f.field_key === 'customer_name') && r.fields.some((f: { field_key: string; value: string }) => f.field_key === 'vendor' && f.value === 'Juniper Lane Mercantile'));
  const r2 = issuerNotCustomer([F('customer_name', 'Priya Roberts')], p);
  check('C3 a real customer is never touched', r2.fields[0]?.field_key === 'customer_name' && r2.moved.length === 0);
}

// ---- D. duplicates and VOID ----
check('D1 VOID in the file name', dt.isVoidMarked({ filename: 'Invoice 24324 - Evergreen VOID.pdf' }) && hv.isVoidMarked('Invoice 4115 - Bishop VOID.pdf'));
check('D1 a VOID line on the page', dt.isVoidMarked({ filename: 'scan.pdf', text: 'INVOICE\n*** VOID ***\nTotal $5' }));
check('D1 words that merely contain "void" do not count', !dt.isVoidMarked({ filename: 'Avoid Delays Memo.pdf', text: 'to avoid delays, void where prohibited by law' }));
eq('D1 a VOID paper is never checked automatically', ac('invoice', [F('customer_name', 'Mata'), F('service_date', '2026-02-07'), F('cost', '295')], { filename: 'Invoice 24329 - Mata VOID.pdf' }).reason, 'void');
const field = (name: string, value: string) => ({ name, value, confidence: 0.95, location: {} });
const doc = (id: string, o: Partial<Doc> = {}): Doc => recomputeIssues({
  id, filename: `${id}.pdf`, fileType: 'pdf', pages: 1, batchId: 'b1', source: 'drive', receivedAt: new Date('2026-01-01'),
  typeId: 'invoice', stage: 'linked', extracted: [], linkedEntityIds: ['c1'], linkConfidence: 1, issues: [], preview: 'text', ...o,
} as Doc, hvacSchema);
{
  const v = doc('v', { filename: 'Invoice 24324 - Evergreen VOID.pdf', extracted: [field('customer_name', 'Evergreen'), field('cost', '50')] });
  check('D1 a VOID paper is set aside, not "needs you"', isSetAside(v) && !isAttention(v));
  check('D1 a VOID paper is never counted, even with unchecked papers included', !isAnswerable(v, true));
  eq('D1 its row says why', needInfo(v, []).text, 'Marked VOID - kept on file, not counted');
  const docs = withPossibleCopies({
    a: doc('a', { filename: 'Patel INV-96101.docx', extracted: [field('invoice_number', 'INV-96101'), field('cost', '286.54')] }),
    b: doc('b', { filename: 'Patel INV-96101 (copy).pdf', receivedAt: new Date('2026-01-02'), extracted: [field('invoice_number', 'INV-96101'), field('cost', '286.54')] }),
    c: doc('c', { filename: 'Molina INV-31220.pdf', extracted: [field('invoice_number', 'INV-31220'), field('cost', '410.00')] }),
    d: doc('d', { filename: 'INV-31220 Molina scan.jpg', receivedAt: new Date('2026-01-03'), extracted: [field('invoice_number', 'INV-31220'), field('cost', '410.00')] }),
    e: doc('e', { filename: 'Estimate E-4118 Campos.pdf', typeId: 'proposal-quote', extracted: [field('invoice_number', 'E-4118'), field('cost', '393.25')] }),
    f: doc('f', { filename: 'Estimate E-4118 Campos v2.pdf', typeId: 'proposal-quote', extracted: [field('invoice_number', 'E-4118'), field('cost', '459.49')] }),
  });
  check('D2 "(copy)" with the same number and amount is set aside, not asked', isSetAside(docs.b!) && !isAttention(docs.b!) && !isAnswerable(docs.b!, true));
  check('D2 the same number and amount under another name is set aside as a copy', isSetAside(docs.d!) && !isAttention(docs.d!));
  check('D2 the original stays counted', !isSetAside(docs.a!) && !isSetAside(docs.c!));
  check('D2 a revision with a different amount is not a copy', !isSetAside(docs.f!));
}

// ---- E. links ----
eq('E1 a work order named with its address gets the address when the page prints it', addressFromFilename('WO-4402 8254 Bluebonnet Ct.pdf', pages('Premises: 8254 Bluebonnet Ct, Austin TX')), '8254 Bluebonnet Ct');
check('E1 a work order with an address still needs its customer (a person picks one when no customer matches)', !ac('work-order', [F('service_address', '8254 Bluebonnet Ct'), F('invoice_number', 'WO-4402')], { hasLink: false }).ok);
check('E2 an agreement with a customer and no address needs no link', dt.linkNotRequired('agreement', new Set(['customer_name'])));

// ---- browser requirement helper uses the kind ----
eq('F1 browser requirement for an NDA row', requiredFieldsForDoc({ typeId: 'agreement', filename: 'NDA - Ibarra.pdf', displayName: undefined }, hvacSchema.documentTypes.find((t) => t.id === 'agreement')), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
