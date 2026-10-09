// npm run verify:doc-rules
// The document rulebook for ANY business (not only HVAC): which type a paper gets, whether a person has to look at it,
// and whether it counts as company paperwork. Fixtures come from the observed Sonoran Comfort Air sample (2026-10-09).
// Runs the real browser rules (recomputeIssues / maxStageFor) and the real backend classifier; no database, no model.
import { recomputeIssues, maxStageFor, isCompanyRecordDoc } from '../src/core/entityGraph.ts';
import { hvacSchema } from '../src/domains/hvac/schema.ts';
import type { Doc } from '../src/core/types.ts';
// @ts-expect-error plain JS module without types
import * as dt from '../api/_lib/documentTypes.js';
// @ts-expect-error plain JS module without types
import { classifyFromText } from '../api/_lib/modelAvoidance/textExtract.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('verify:doc-rules');

type Fx = {
  name: string; file: string; title?: string; facts: Record<string, string>; linked?: boolean;
  type: string; needsPerson: boolean; company: boolean;
  /** What the OLD HVAC-only rulebook did with it (type it got, whether it sat in Needs you) - for the reduction estimate. */
  old: { type: string; needsPerson: boolean };
};

const F: Fx[] = [
  { name: 'R-201xx store receipt', file: 'Receipt R-20120.pdf', facts: { vendor: 'Desert Supply', service_date: '2026-09-02', cost: '48.20' }, type: 'receipt', needsPerson: false, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'RC return slip', file: 'RC-0312 Return Slip.pdf', facts: { vendor: 'Desert Supply', service_date: '2026-09-04', cost: '12.00' }, type: 'receipt', needsPerson: false, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'CM credit memo', file: 'CM-0045 Credit Memo.pdf', facts: { customer_name: 'Acme Roofing', service_date: '2026-09-05', cost: '-75.00' }, type: 'invoice', needsPerson: false, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'PS packing slip (carries a cost)', file: 'PS-0099 Packing Slip.pdf', facts: { vendor: 'Desert Supply', service_date: '2026-09-06', cost: '210.00' }, type: 'delivery-ticket', needsPerson: false, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'PT pickup ticket', file: 'PT-0071.pdf', title: 'Pickup Ticket', facts: { customer_name: 'Lena Ortiz', service_date: '2026-09-07', cost: '35.00' }, type: 'delivery-ticket', needsPerson: false, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'DT delivery ticket', file: 'DT-0072 Delivery Ticket.pdf', facts: { vendor: 'Valley Freight', service_date: '2026-09-08' }, type: 'delivery-ticket', needsPerson: false, company: false, old: { type: 'dispatch-note', needsPerson: true } },
  { name: 'RA rental agreement', file: 'RA-0012 Rental Agreement.pdf', facts: { vendor: 'Mesa Equipment Rental', service_date: '2026-08-01' }, type: 'agreement', needsPerson: false, company: true, old: { type: 'invoice', needsPerson: true } },
  { name: 'consignment agreement', file: 'CA-0007 Consignment Agreement.pdf', title: 'Consignment Agreement', facts: { vendor: 'Rivera Antiques', service_date: '2026-07-15' }, type: 'agreement', needsPerson: false, company: true, old: { type: 'invoice', needsPerson: true } },
  { name: 'PO purchase order', file: 'PO-3102.pdf', facts: { vendor: 'Carrier Supply', cost: '334.56' }, type: 'purchase-order', needsPerson: false, company: true, old: { type: 'purchase-order', needsPerson: true } },
  { name: 'weekly schedule', file: 'Weekly Schedule 10-06.xlsx', facts: { notes: 'Mon Ana, Tue Ben', service_date: '2026-10-06' }, type: 'schedule', needsPerson: false, company: true, old: { type: 'other', needsPerson: true } },
  { name: 'price list csv', file: 'Price List 2026.csv', facts: { notes: 'Filter 16x20 $9', service_date: '2026-01-01' }, type: 'price-list', needsPerson: false, company: true, old: { type: 'other', needsPerson: true } },
  { name: 'offer letter', file: 'Offer Letter - J Smith.pdf', facts: { customer_name: 'J Smith' }, type: 'hr-letter', needsPerson: false, company: true, old: { type: 'correspondence', needsPerson: true } },
  { name: 'NDA', file: 'NDA - Acme.pdf', facts: { vendor: 'Acme Holdings', service_date: '2026-06-01' }, type: 'agreement', needsPerson: false, company: true, old: { type: 'correspondence', needsPerson: true } },
  { name: 'COI certificate of insurance', file: 'COI - Acme Insurance.pdf', facts: { vendor: 'Acme Insurance' }, type: 'insurance-certificate', needsPerson: false, company: true, old: { type: 'correspondence', needsPerson: true } },
  { name: 'rent ledger (has amounts)', file: 'Rent Ledger Sept.xlsx', facts: { vendor: 'Sunset Properties', cost: '1800.00' }, type: 'statement', needsPerson: false, company: true, old: { type: 'invoice', needsPerson: true } },
  { name: 'fuel card statement', file: 'Statement - Fuel Card.pdf', facts: { vendor: 'FleetCor', cost: '640.10' }, type: 'statement', needsPerson: false, company: true, old: { type: 'invoice', needsPerson: true } },
  { name: 'law-firm invoice, no address', file: 'Invoice 24310 - Hale Law.pdf', facts: { vendor: 'Hale Law', service_date: '2026-09-01', cost: '900.00' }, type: 'invoice', needsPerson: false, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'work order, no technician, linked', file: 'Work Order WO-55.pdf', facts: { service_address: '12 Oak St', service_date: '2026-09-10', work_performed: 'Replace filter' }, linked: true, type: 'work-order', needsPerson: false, company: false, old: { type: 'work-order', needsPerson: true } },
  // Controls: genuinely incomplete or wrong documents must STILL need a person.
  { name: 'CONTROL invoice with no amount', file: 'Invoice 24311.pdf', facts: { vendor: 'Hale Law', service_date: '2026-09-01' }, type: 'invoice', needsPerson: true, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'CONTROL invoice with an address but no link', file: 'Invoice 24312.pdf', facts: { customer_name: 'Pat Lee', service_address: '5 Elm St', service_date: '2026-09-01', cost: '100.00' }, type: 'invoice', needsPerson: true, company: false, old: { type: 'invoice', needsPerson: true } },
  { name: 'CONTROL work order with no address', file: 'Work Order WO-56.pdf', facts: { service_date: '2026-09-10' }, linked: true, type: 'work-order', needsPerson: true, company: false, old: { type: 'work-order', needsPerson: true } },
  { name: 'CONTROL receipt with no amount', file: 'Receipt R-20121.pdf', facts: { vendor: 'Desert Supply', service_date: '2026-09-02' }, type: 'receipt', needsPerson: true, company: false, old: { type: 'invoice', needsPerson: true } },
];

function docFor(fx: Fx, typeId: string): Doc {
  return {
    id: fx.name, filename: fx.file, fileType: 'pdf', pages: 1, batchId: 'b', source: 'upload', receivedAt: new Date(0),
    typeId, stage: 'read', linkedEntityIds: fx.linked ? ['c1'] : [], linkConfidence: fx.linked ? 0.9 : 0, issues: [],
    extracted: Object.entries(fx.facts).map(([name, value]) => ({ name, value, confidence: 0.95, location: { page: 1 } })),
  } as unknown as Doc;
}

let before = 0;
let after = 0;
for (const fx of F) {
  // 1. The type: a title line first (what the page announces), else the deterministic fallback on facts + file name.
  const hit = fx.title ? classifyFromText([{ page_no: 1, text: fx.title }]) : null;
  const got = hit?.type ?? dt.inferDocumentType(fx.facts, fx.file);
  eq(`${fx.name}: type`, got, fx.type);

  // 2. Does it need a person (the browser's own rule: any issue on a document that is not verified)?
  const d = recomputeIssues(docFor(fx, got), hvacSchema);
  const stage = maxStageFor(d, hvacSchema);
  const needs = d.issues.length > 0;
  eq(`${fx.name}: needs a person`, needs, fx.needsPerson);
  if (!needs) check(`${fx.name}: may be checked automatically (ceiling is verified)`, stage === 'verified', stage);

  // 3. Company paperwork flag.
  eq(`${fx.name}: company record`, isCompanyRecordDoc(d, hvacSchema), fx.company);

  // 4. The server's automatic check agrees with the browser: complete + readable + no link needed.
  const fields = Object.entries(fx.facts).map(([field_key, value]) => ({ field_key, value, confidence: 0.95 }));
  const complete = dt.completenessFor(got, fields).complete;
  const autoNoLink = complete && dt.mayVerifyWithoutLink(got, fields);
  if (!fx.linked && !fx.needsPerson) check(`${fx.name}: automatic check needs no link`, autoNoLink === true);
  if (fx.needsPerson && !fx.linked) check(`${fx.name}: automatic check refuses`, autoNoLink === false);

  // 5. The one-time re-sort moves an old "Invoice" only when the name or title is confident.
  if (fx.old.type !== got && ['invoice', 'other', 'correspondence', 'dispatch-note'].includes(fx.old.type)) {
    const r = dt.resortDecision({ currentType: fx.old.type, filename: fx.file, titleType: hit?.type ?? null });
    if (fx.type !== 'invoice' && fx.type !== 'work-order') eq(`${fx.name}: re-sort from ${fx.old.type}`, r, fx.type === fx.old.type ? null : fx.type);
  }
  if (fx.old.needsPerson) before++;
  if (needs) after++;
}
console.log(`  Needs-you on these ${F.length} fixtures: before ${before}, after ${after}`);

// ---- the owner's rules, stated directly
eq('invoice requires a customer or vendor, a date and an amount, and no address', dt.REQUIRED_FIELDS.invoice, ['customer_name|vendor', 'service_date', 'cost']);
eq('correspondence requires nothing', dt.REQUIRED_FIELDS.correspondence, []);
check('work order does not require a technician', !dt.REQUIRED_FIELDS['work-order'].includes('technician'));
for (const t of ['work-order', 'service-ticket', 'inspection-report', 'permit']) check(`${t} still requires a service address`, dt.REQUIRED_FIELDS[t].includes('service_address'));
for (const t of ['receipt', 'agreement', 'delivery-ticket', 'schedule', 'price-list', 'statement', 'insurance-certificate', 'hr-letter']) {
  check(`new type ${t} exists with a label`, dt.DOCUMENT_TYPE_IDS.has(t) && !!dt.documentTypeLabel(t) && dt.documentTypeLabel(t) !== 'Other');
  check(`new type ${t} has a model definition`, !!dt.DOCUMENT_TYPE_DEFINITIONS[t]);
}
for (const t of ['purchase-order', 'schedule', 'price-list', 'internal', 'statement', 'hr-letter', 'insurance-certificate']) check(`${t} is company paperwork`, dt.isCompanyRecordType(t));
check('an agreement naming a customer is not company paperwork', !dt.isCompanyRecordType('agreement', new Set(['customer_name'])));
check('a readable-nothing correspondence is not auto-checked', dt.mayVerifyWithoutLink('correspondence', []) === false);
check('the undecided "other" type is never auto-checked without a link', dt.mayVerifyWithoutLink('other', [{ field_key: 'notes', value: 'x' }]) === false);
// A cost no longer forces "invoice" ahead of a specific file name; a plain "invoice" name still does.
eq('a specific name beats the cost rule', dt.inferDocumentType({ cost: '5' }, 'Packing Slip PS-1.pdf'), 'delivery-ticket');
eq('a bare cost still falls back to invoice', dt.inferDocumentType({ cost: '5' }, 'scan0001.pdf'), 'invoice');
// Low-confidence facts never auto-check an unlinked document, even for types that require nothing.
const lowc = (k: string, v: string, c: number) => [{ field_key: k, value: v, confidence: c }];
check('schedule with one 0.1 fact is not auto-checked', dt.mayVerifyWithoutLink('schedule', lowc('notes', 'x', 0.1)) === false);
check('hr-letter with one 0.05 fact is not auto-checked', dt.mayVerifyWithoutLink('hr-letter', lowc('customer_name', 'J Smith', 0.05)) === false);
check('correspondence with a 0.2 name is not auto-checked', dt.mayVerifyWithoutLink('correspondence', lowc('customer_name', 'J Smith', 0.2)) === false);
check('a single confident non-name fact is not readable enough', dt.mayVerifyWithoutLink('schedule', lowc('notes', 'x', 0.99)) === false);
check('a confident name alone is enough', dt.mayVerifyWithoutLink('hr-letter', lowc('customer_name', 'J Smith', 0.95)) === true);
check('two confident facts are enough', dt.mayVerifyWithoutLink('schedule', [...lowc('notes', 'x', 0.95), ...lowc('service_date', '2026-10-01', 0.9)]) === true);
// Two identical unlinked receipts (same vendor, date, amount): the rules treat each on its own, so BOTH are auto-checked.
// There is no document-level duplicate rule yet (diagnosis 3.5); this documents the current behaviour.
{
  const r = [{ field_key: 'vendor', value: 'Desert Supply', confidence: 0.95 }, { field_key: 'service_date', value: '2026-09-02', confidence: 0.95 }, { field_key: 'cost', value: '48.20', confidence: 0.95 }];
  check('identical unlinked receipts: each is auto-checked (no duplicate rule)', dt.mayVerifyWithoutLink('receipt', r) === true && dt.mayVerifyWithoutLink('receipt', r) === true);
}
// Re-sort safety
eq('re-sort never touches a type outside invoice/other/correspondence/dispatch-note', dt.resortDecision({ currentType: 'work-order', filename: 'Receipt.pdf' }), null);
eq('re-sort is not confident when title and name disagree', dt.resortDecision({ currentType: 'invoice', filename: 'Receipt R-1.pdf', titleType: 'statement' }), null);
eq('re-sort leaves a plain invoice name alone', dt.resortDecision({ currentType: 'invoice', filename: 'Invoice 24310.pdf' }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
