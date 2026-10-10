// npm run verify:ingest-deterministic
// The widened deterministic extractor (modelAvoidance/labelledExtract.js + textExtract.js + financialsHook.js): about 50
// realistic text fixtures written for this check. Each ACCEPT fixture lists the exact fields it must yield; each REFUSE
// fixture must fall back to the model. The rule that matters: ZERO WRONG VALUES. A refusal is always acceptable for an
// "any" fixture; an accepted document must carry exactly the expected fields with exactly the expected values.
// No database, no model, no network.
// @ts-expect-error plain JS module without types
import { extractFromText } from '../api/_lib/modelAvoidance/textExtract.js';
// @ts-expect-error plain JS module without types
import { financialsInputFromText } from '../api/_lib/modelAvoidance/financialsHook.js';
// @ts-expect-error plain JS module without types
import { parseMoney } from '../api/_lib/modelAvoidance/labelledExtract.js';
// @ts-expect-error plain JS module without types
import plumbing from '../api/_lib/industry/packs/plumbing.js';
// @ts-expect-error plain JS module without types
import electrical from '../api/_lib/industry/packs/electrical.js';
// @ts-expect-error plain JS module without types
import hvac from '../api/_lib/industry/packs/hvac.js';
// @ts-expect-error plain JS module without types
import { classifyFromText } from '../api/_lib/modelAvoidance/textExtract.js';
// @ts-expect-error plain JS module without types
import { resolveDocumentType, inferTypeFromFilename } from '../api/_lib/documentTypes.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}

type Fx = {
  name: string;
  text: string;
  pack?: unknown;
  /** accept: must be accepted with exactly `fields`. refuse: must fall back to the model. any: refusal fine, else exact. */
  expect: 'accept' | 'refuse' | 'any';
  type?: string;
  fields?: Record<string, string>;
  /** reason substring the refusal should carry (documentation + a guard against refusing for the wrong reason) */
  why?: string;
};

const F: Fx[] = [
  /* ------------------------------------------------------------------ ACCEPT: the document types that used to go to the model */
  {
    name: 'retail receipt', expect: 'accept', type: 'receipt',
    text: `Desert Supply Co\nRECEIPT\nReceipt #: R-20120\nDate: 10/02/2026\nSold By: Desert Supply Co\nThanks for shopping with us!\nFilter 16x20   2   $9.00   $18.00\nContactor 30A   1   $22.50   $22.50\nSubtotal: $40.50\nSales Tax: $3.34\nTotal: $43.84\nVISA ****1234   $43.84`,
    fields: { vendor: 'Desert Supply Co', service_date: '2026-10-02', invoice_number: 'R-20120', cost: '43.84' },
  },
  {
    name: 'retail receipt, two-cell totals, no dollar signs', expect: 'accept', type: 'receipt',
    text: `Sales Receipt\nMerchant: Mesa Tool & Fastener\nTransaction Date: 09/18/2026\nTransaction #: 88231\n1 Box deck screws          11.98\n2 Wire nuts               4.50\nSUBTOTAL        16.48\nTAX             1.36\nTOTAL           17.84\nCash            20.00\nChange           2.16`,
    fields: { vendor: 'Mesa Tool & Fastener', service_date: '2026-09-18', invoice_number: '88231', cost: '17.84' },
  },
  {
    name: 'credit memo printed negative', expect: 'accept', type: 'invoice',
    text: `Credit Memo\nCredit Memo #: CM-0045\nDate: 09/05/2026\nCustomer: Acme Roofing\nReason: returned goods\nReturned items credited at original price.\nTotal Credit: -$75.00`,
    fields: { customer_name: 'Acme Roofing', service_date: '2026-09-05', invoice_number: 'CM-0045', cost: '-75.00' },
  },
  {
    name: 'credit memo, parentheses negative', expect: 'accept', type: 'invoice',
    text: `CREDIT NOTE\nCredit Note No: CN-7712\nIssue Date: 2026-08-19\nBill To: Lena Ortiz\nAdjustment for duplicate billing\nGrand Total: ($1,240.50)`,
    fields: { customer_name: 'Lena Ortiz', service_date: '2026-08-19', invoice_number: 'CN-7712', cost: '-1240.50' },
  },
  {
    name: 'packing slip', expect: 'accept', type: 'delivery-ticket',
    text: `PACKING SLIP\nPacking Slip #: PS-0099\nShip Date: 09/06/2026\nSold By: Desert Supply\nShip To: Valley Mechanical\nQty   Item   Description\n4   FLT-1620   Filter 16x20\n2   CAP-4550   Capacitor 45/5`,
    fields: { vendor: 'Desert Supply', customer_name: 'Valley Mechanical', service_date: '2026-09-06', invoice_number: 'PS-0099' },
  },
  {
    name: 'pickup ticket', expect: 'accept', type: 'delivery-ticket',
    text: `Pickup Ticket\nTicket #: PT-0071\nPickup Date: Sep 7, 2026\nCustomer: Lena Ortiz\nItems picked up at the counter, paid at pickup.\nTotal Paid: $35.00`,
    fields: { customer_name: 'Lena Ortiz', service_date: '2026-09-07', invoice_number: 'PT-0071', cost: '35.00' },
  },
  {
    name: 'delivery ticket, vendor only', expect: 'accept', type: 'delivery-ticket',
    text: `Delivery Ticket\nVendor: Valley Freight\nDelivery Date: 09/08/2026\nDelivered 6 pallets to the north dock. Driver signature on file.`,
    fields: { vendor: 'Valley Freight', service_date: '2026-09-08' },
  },
  {
    name: 'purchase order', expect: 'accept', type: 'purchase-order',
    text: `PURCHASE ORDER\nPO #: 3102\nOrder Date: 09/29/2026\nVendor: Carrier Supply Houston\nBill To: Sonoran Comfort Air\nShip To: Sonoran Comfort Air\nQty   Part   Description   Amount\n2   GL-1190   Gas valve   $210.00\n4   FL-0042   Filter drier   $124.56\nTotal: $334.56`,
    fields: { vendor: 'Carrier Supply Houston', service_date: '2026-09-29', invoice_number: '3102', cost: '334.56' },
  },
  {
    name: 'purchase order, two-column footer', expect: 'accept', type: 'purchase-order',
    text: `Purchase Order No. 5521\nSupplier: Baker Distributing\nDate: 10/01/2026\n12 x 3/4 copper tee      $5.20\nSubtotal   $62.40     Tax   $5.15     Total   $67.55`,
    fields: { vendor: 'Baker Distributing', service_date: '2026-10-01', invoice_number: '5521', cost: '67.55' },
  },
  {
    name: 'rent ledger', expect: 'accept', type: 'statement',
    text: `Rent Ledger\nTenant: Jordan Ellis\nProperty: 412 Elm St, Mesa, AZ 85201\nStatement Date: 10/01/2026\nDate         Description       Charge      Payment\n08/01/2026   Rent              1800.00\n08/03/2026   Payment                       1800.00\n09/01/2026   Rent              1800.00\n09/05/2026   Payment                       1800.00\n10/01/2026   Rent              1800.00\nBalance Due: $1,800.00`,
    fields: { customer_name: 'Jordan Ellis', service_address: '412 Elm St, Mesa, AZ 85201', service_date: '2026-10-01', cost: '1800.00' },
  },
  {
    name: 'vendor statement', expect: 'accept', type: 'statement',
    text: `Statement of Account\nFrom: Baker Distributing\nAccount Name: Sonoran Comfort Air\nStatement Date: 09/30/2026\nPrevious Balance      $410.00\nPayments             -$410.00\nNew Charges           $612.30\nAmount Due: $612.30`,
    fields: { vendor: 'Baker Distributing', customer_name: 'Sonoran Comfort Air', service_date: '2026-09-30', cost: '612.30' },
  },
  {
    name: 'rental agreement', expect: 'accept', type: 'agreement',
    text: `Rental Agreement\nLandlord: Sunset Properties LLC\nTenant: Jordan Ellis\nLease Term: 12 months, 10/01/2026 - 09/30/2027\nThe tenant agrees to pay rent on the first of each month. Pets are not permitted without written consent. The landlord may enter on 24 hours notice.\nSignature: ____________`,
    fields: { vendor: 'Sunset Properties LLC', customer_name: 'Jordan Ellis', agreement_term: '12 months, 10/01/2026 - 09/30/2027' },
  },
  {
    name: 'equipment rental agreement with a second title-like line', expect: 'refuse',
    text: `Equipment Rental Agreement\n(rental agreement)\nLessor: Mesa Equipment Rental\nCustomer: Sonoran Comfort Air\nEffective Date: 08/01/2026\nRental of one scissor lift for a period of 30 days.`,
  },
  {
    name: 'vendor agreement (vendor/client, effective date)', expect: 'accept', type: 'agreement',
    text: `Vendor Agreement\nVendor: Pinnacle IT Services\nClient: Sonoran Comfort Air\nEffective Date: 08/01/2026\nPinnacle will provide managed IT support. Either party may terminate with 30 days written notice.`,
    fields: { vendor: 'Pinnacle IT Services', customer_name: 'Sonoran Comfort Air', service_date: '2026-08-01' },
  },
  {
    name: 'offer letter', expect: 'accept', type: 'hr-letter',
    text: `Offer Letter\nDate: October 1, 2026\nCandidate: Jordan Ellis\nDear Jordan,\nWe are pleased to offer you the position of Service Coordinator at a starting salary of $52,000 per year. Your start date will be October 19, 2026.\nSincerely, Pat Moreno`,
    fields: { customer_name: 'Jordan Ellis', service_date: '2026-10-01' },
  },
  {
    name: 'certificate of insurance', expect: 'accept', type: 'insurance-certificate',
    text: `CERTIFICATE OF LIABILITY INSURANCE\nDate Issued: 07/15/2026\nInsured: Sonoran Roofing LLC\nInsurer A: Western Mutual\nPolicy Number: GL-4419-221\nGeneral Aggregate $2,000,000\nCertificate Holder: Sonoran Comfort Air`,
    fields: { vendor: 'Sonoran Roofing LLC', service_date: '2026-07-15' },
  },
  {
    name: 'price list', expect: 'accept', type: 'price-list',
    text: `Price List\nVendor: Baker Distributing\nEffective Date: 01/01/2026\nItem   Description   Price\nFLT-1620   Filter 16x20   $9.00\nFLT-2025   Filter 20x25   $11.50\nPrices subject to change without notice.`,
    fields: { vendor: 'Baker Distributing', service_date: '2026-01-01' },
  },
  {
    name: 'law-firm invoice', expect: 'accept', type: 'invoice',
    text: `INVOICE\nHale & Brandt LLP\nInvoice No.: 24310\nInvoice Date: 09/01/2026\nFrom: Hale & Brandt LLP\nClient: Sonoran Comfort Air\nMatter: Lease review, 4410 E Main St\n08/12/2026   Review of commercial lease and markup     2.5 hrs   $750.00\n08/19/2026   Call with landlord counsel                   0.5 hrs   $150.00\nTotal fees: $900.00\nTotal Due: $900.00\nPayment is due within 30 days. Please remit to the address above.`,
    fields: { vendor: 'Hale & Brandt LLP', customer_name: 'Sonoran Comfort Air', service_date: '2026-09-01', invoice_number: '24310', cost: '900.00' },
  },
  {
    name: 'bookkeeping invoice, reconciles', expect: 'accept', type: 'invoice',
    text: `Invoice\nGreenline Bookkeeping\nInvoice #: GB-2026-114\nInvoice Date: 09/30/2026\nFrom: Greenline Bookkeeping\nBill To: Sonoran Comfort Air\nMonthly bookkeeping, September   1   $450.00   $450.00\nPayroll processing   1   $120.00   $120.00\nSubtotal: $570.00\nTax: $0.00\nTotal: $570.00`,
    fields: { vendor: 'Greenline Bookkeeping', customer_name: 'Sonoran Comfort Air', service_date: '2026-09-30', invoice_number: 'GB-2026-114', cost: '570.00' },
  },
  {
    name: 'invoice with shipping and discount (cannot reconcile, adjustments printed)', expect: 'accept', type: 'invoice',
    text: `INVOICE\nInvoice #: 7781\nDate: 10/04/2026\nBill To: Rivera Antiques\nFrom: Desert Office Supply\nCopy paper   10   $4.00   $40.00\nSubtotal: $40.00\nDiscount: -$4.00\nShipping: $6.00\nTax: $3.20\nTotal: $45.20`,
    fields: { vendor: 'Desert Office Supply', customer_name: 'Rivera Antiques', service_date: '2026-10-04', invoice_number: '7781', cost: '45.20' },
  },
  {
    name: 'plumbing invoice (plumbing pack)', expect: 'accept', type: 'invoice', pack: plumbing,
    text: `INVOICE\nInvoice #: P-5521\nDate of Service: 09/22/2026\nBill To: Marcus Whitfield\nService Address: 912 W Palm Ln, Tempe, AZ 85281\nClear main line, camera inspection   1   $285.00\nTotal Due: $285.00`,
    fields: { customer_name: 'Marcus Whitfield', service_address: '912 W Palm Ln, Tempe, AZ 85281', service_date: '2026-09-22', invoice_number: 'P-5521', cost: '285.00' },
  },
  {
    name: 'electrical install invoice (needs judgement, so model)', expect: 'refuse', why: 'install', pack: electrical,
    text: `Invoice\nInvoice No: E-3010\nInvoice Date: 10/06/2026\nCustomer: Amy Isaacson\nJob Site: 248 W Guadalupe Rd, Phoenix, AZ 85001\nInstall two ceiling fans   2   $140.00   $280.00\nTotal: $280.00`,
  },
  {
    name: 'electrical invoice, no install wording', expect: 'accept', type: 'invoice', pack: electrical,
    text: `Invoice\nInvoice No: E-3011\nInvoice Date: 10/06/2026\nCustomer: Amy Isaacson\nJob Site: 248 W Guadalupe Rd, Phoenix, AZ 85001\nReplace GFCI outlet, kitchen   2   $140.00   $280.00\nSubtotal: $280.00\nTotal: $280.00`,
    fields: { customer_name: 'Amy Isaacson', service_address: '248 W Guadalupe Rd, Phoenix, AZ 85001', service_date: '2026-10-06', invoice_number: 'E-3011', cost: '280.00' },
  },
  {
    name: 'HVAC service invoice with line-item table', expect: 'accept', type: 'invoice',
    text: `Sonoran Comfort Air\nINVOICE\nInvoice #: INV-31004\nDate of Service: 09/12/2026\nBill To: Plaza Dental Group\nService Address: 18 N Center St, Mesa, AZ 85201\nDescription                     Qty   Amount\nDiagnostic and labor              1    $95.00\nThank you for your business.\nTOTAL DUE: $95.00`,
    fields: { customer_name: 'Plaza Dental Group', service_address: '18 N Center St, Mesa, AZ 85201', service_date: '2026-09-12', invoice_number: 'INV-31004', cost: '95.00' },
  },
  {
    name: 'HVAC work order (strict template path)', expect: 'accept', type: 'work-order',
    text: `Sonoran Comfort Air\n(480) 555-0199\nWORK ORDER\nWork Order #: WO-5521\nDate of Service: 09/10/2026\nCustomer: Robert Castillo\nService Address: 918 W Palm Ln, Tempe, AZ 85281\nTechnician: Marcus Bell\nStatus: Completed`,
    fields: { shop_phone: '(480) 555-0199', invoice_number: 'WO-5521', service_date: '2026-09-10', customer_name: 'Robert Castillo', service_address: '918 W Palm Ln, Tempe, AZ 85281', technician: 'Marcus Bell', status: 'Completed' },
  },
  {
    name: 'quote with customer, total and prose', expect: 'any', type: 'proposal-quote',
    text: `Estimate\nEstimate #: Q-2210\nEstimate Date: 10/03/2026\nCustomer: Plaza Dental Group\nProposed: replace the break-room exhaust fan and motor, including haul-away.\nThis estimate is valid for 30 days.\nEstimate Total: $640.00`,
    fields: { customer_name: 'Plaza Dental Group', service_date: '2026-10-03', invoice_number: 'Q-2210', cost: '640.00' },
  },
  {
    name: 'bill-to block with the name on the next line', expect: 'accept', type: 'invoice',
    text: `INVOICE\nInvoice #: 5003\nInvoice Date: 10/01/2026\nBill To:\nNorthgate Property Management\n1200 N Scottsdale Rd\nScottsdale, AZ 85257\nFrom: Cactus Landscape Supply\nTotal Due: $1,284.00`,
    fields: { customer_name: 'Northgate Property Management', vendor: 'Cactus Landscape Supply', service_date: '2026-10-01', invoice_number: '5003', cost: '1284.00' },
  },
  {
    name: 'two labels on one line', expect: 'accept', type: 'invoice',
    text: `INVOICE\nInvoice #: 6120 Date: 10/05/2026\nBill To: Rivera Antiques\nFrom: Copy Corner\nTotal: $212.75`,
    fields: { customer_name: 'Rivera Antiques', vendor: 'Copy Corner', service_date: '2026-10-05', invoice_number: '6120', cost: '212.75' },
  },

  /* ------------------------------------------------------------------ REFUSE: must fall back to the model */
  { name: 'ambiguous: two different Totals', expect: 'refuse', why: 'ambiguous-total', text: `Receipt\nSold By: Desert Supply\nDate: 10/02/2026\nTotal: $43.84\nTotal: $48.12` },
  { name: 'ambiguous: Total and Balance Due differ', expect: 'refuse', why: 'ambiguous-total', text: `INVOICE\nInvoice #: 4410\nDate: 10/02/2026\nBill To: Rivera Antiques\nTotal: $500.00\nBalance Due: $200.00` },
  { name: 'ambiguous: subtotal + tax does not equal total (with prose)', expect: 'refuse', why: 'does-not-reconcile', text: `INVOICE\nInvoice #: 4411\nDate: 10/02/2026\nBill To: Rivera Antiques\nPayment is due within 30 days of the invoice date.\nSubtotal: $100.00\nTax: $8.00\nTotal: $120.00` },
  { name: 'ambiguous: subtotal + tax does not equal total (plain form)', expect: 'refuse', why: 'does-not-reconcile', text: `INVOICE\nInvoice #: 4419\nDate: 10/02/2026\nBill To: Rivera Antiques\nSubtotal: $100.00\nTax: $8.00\nTotal: $120.00` },
  { name: 'ambiguous: total without cents or dollar sign', expect: 'refuse', why: 'bad-value', text: `INVOICE\nInvoice #: 4412\nDate: 10/02/2026\nBill To: Rivera Antiques\nPayment is due within 30 days.\nTotal: 1234` },
  { name: 'no labels at all', expect: 'refuse', why: 'missing-required', text: `RECEIPT\nThanks for visiting Desert Supply on October 2nd.\nYou bought 2 filters and a contactor for 43.84 total.\nCome again soon!` },
  { name: 'no title (labels only)', expect: 'refuse', why: 'no-title', text: `Sold By: Desert Supply\nDate: 10/02/2026\nTotal: $43.84` },
  { name: 'scanned garbage', expect: 'refuse', text: `lI| ,, .. ~~ ;; Tota1  $4S.B4\nDa+e 1O/O2/2O26 ..\nSo1d By  Des3rt Suppl.y\n|||| .. // ~~ ,,,` },
  { name: 'garbage with a title word', expect: 'refuse', text: `INVOICE\nxx|| ~~ ,, .. Tota1: S4S.B4\n..,, // ||| 1O/O2 '' ;;\nBi11 T0  R1vera  Ant1ques` },
  { name: 'receipt that names equipment (serial)', expect: 'refuse', why: 'equipment-signal', text: `Receipt\nMerchant: Desert Supply\nDate: 10/02/2026\nCondenser fan motor, Serial 4A7B9231-XT, returned\nTotal: $212.00` },
  { name: 'receipt with a brand name in a line item', expect: 'refuse', why: 'equipment-signal', text: `Receipt\nMerchant: Desert Supply\nDate: 10/02/2026\nCarrier filter drier   1   $24.00\nTotal: $24.00` },
  { name: 'invoice for an install (needs judgement)', expect: 'refuse', why: 'install', text: `INVOICE\nInvoice #: 8812\nDate: 10/02/2026\nBill To: Rivera Antiques\nInstall new water heater   1   $1,450.00\nTotal Due: $1,450.00` },
  { name: 'invoice with a work-performed block', expect: 'refuse', why: 'work-block', text: `INVOICE\nInvoice #: 8813\nDate: 10/02/2026\nBill To: Rivera Antiques\nWork performed:\n- Replaced capacitor\n- Cleared drain line\nThe customer was also quoted a new thermostat for next time.\nTotal Due: $310.00` },
  { name: 'customer label followed by a sentence', expect: 'refuse', why: 'bad-value', text: `INVOICE\nInvoice #: 8814\nDate: 10/02/2026\nCustomer: Jane Doe called to complain about the last visit\nPayment is due within 30 days.\nTotal Due: $310.00` },
  { name: 'customer label followed by a sentence (plain form)', expect: 'refuse', why: 'customer-name-is-a-sentence', text: `INVOICE\nInvoice #: 8824\nDate: 10/02/2026\nCustomer: Jane Doe called to complain about the last visit\nTotal Due: $310.00` },
  { name: 'customer label followed by an address', expect: 'refuse', why: 'bad-value', text: `INVOICE\nInvoice #: 8815\nDate: 10/02/2026\nBill To: Jane Doe, 412 Elm St, Mesa AZ 85201\nTotal Due: $310.00` },
  { name: 'date label with a non-date', expect: 'refuse', why: 'bad-value', text: `INVOICE\nInvoice #: 8816\nDate: sometime in May\nBill To: Jane Doe\nTotal Due: $310.00` },
  { name: 'two different document dates', expect: 'refuse', why: 'conflict:service_date', text: `INVOICE\nInvoice #: 8817\nDate: 10/02/2026\nDate: 10/03/2026\nBill To: Jane Doe\nTotal Due: $310.00` },
  { name: 'swappable date when the file uses both orders', expect: 'refuse', text: `INVOICE\nInvoice #: 8818\nDate: 03/04/2026\nBill To: Jane Doe\nNet 30, due 25/04/2026 (04/25/2026 in the old format)\nPayment is due within 30 days.\nTotal Due: $310.00` },
  { name: 'two invoices in one file', expect: 'refuse', text: `INVOICE\nInvoice #: 9001\nDate: 10/02/2026\nBill To: Jane Doe\nTotal Due: $310.00\nINVOICE\nInvoice #: 9002\nDate: 10/03/2026\nBill To: Pat Lee\nTotal Due: $75.00` },
  { name: 'service ticket with prose (template path refuses; not a generic type)', expect: 'refuse', text: `SERVICE TICKET\nCustomer: Robert Castillo\nService Address: 918 W Palm Ln, Tempe, AZ 85281\nDate of Service: 09/10/2026\nCustomer said the unit also rattles at night and asked about the attic fan next visit.` },
  { name: 'receipt in a plumbing pack (receipt is not a plumbing type)', expect: 'refuse', pack: plumbing, why: 'type-not-in-pack', text: `Receipt\nMerchant: Desert Supply\nDate: 10/02/2026\nTotal: $43.84` },
  { name: 'plumbing invoice with no service address', expect: 'refuse', pack: plumbing, why: 'missing-required', text: `INVOICE\nInvoice #: P-5522\nDate: 09/22/2026\nBill To: Marcus Whitfield\nTotal Due: $285.00` },
  { name: 'invoice with no total', expect: 'refuse', why: 'missing-required', text: `INVOICE\nInvoice #: 4413\nDate: 10/02/2026\nBill To: Rivera Antiques\nPayment due on receipt.` },
  { name: 'purchase order naming two different vendors', expect: 'refuse', why: 'conflict:vendor', text: `PURCHASE ORDER\nPO #: 3103\nVendor: Carrier Supply Houston\nSupplier: Baker Distributing\nOrder Date: 09/29/2026\nTotal: $334.56` },
  { name: 'statement that names nobody', expect: 'refuse', why: 'missing-required', text: `Statement\nStatement Date: 09/30/2026\nAmount Due: $612.30` },
  { name: 'letter with no title', expect: 'refuse', text: `Hey Danny,\ncan you swing by the Castillo place tomorrow morning?\nThanks, Marcus` },
  { name: 'empty text', expect: 'refuse', text: `   ` },
  { name: 'receipt with a conflicting merchant and sold-by', expect: 'refuse', why: 'conflict:vendor', text: `Receipt\nMerchant: Desert Supply\nSold By: Valley Hardware\nDate: 10/02/2026\nTotal: $12.00` },
  { name: 'bill-to and ship-to columns side by side', expect: 'refuse', why: 'bad-value', text: `INVOICE\nInvoice #: 4414\nDate: 10/02/2026\nBill To:        Ship To:\nRivera Antiques      Copy Corner\nTotal: $44.00` },
];

/* ------------------------------------------------------------------ run */
function run(f: Fx) {
  const pack = f.pack === undefined ? undefined : f.pack;
  return extractFromText([{ page_no: 1, text: f.text }], pack === undefined ? {} : { pack });
}
const norm = (v: unknown) => String(v).replace(/\s+/g, ' ').trim();

let accepted = 0;
let refused = 0;
let wrong = 0;
const wrongDetail: string[] = [];
const expectedAccept = F.filter((f) => f.expect === 'accept');
let expectedAcceptHit = 0;

for (const raw of F) {
  const f = raw;
  const want = f.expect;
  const r = run(f);
  if (r.accepted) {
    accepted++;
    const got: Record<string, string> = {};
    for (const x of r.toolInput.fields) { if (x.key in got) { wrong++; wrongDetail.push(`${f.name}: duplicate key ${x.key}`); } got[x.key] = norm(x.value); }
    if (want === 'refuse') { wrong++; wrongDetail.push(`${f.name}: accepted but must refuse -> ${JSON.stringify(got)}`); check(`${f.name}: refused`, false, 'was accepted'); continue; }
    if (!f.fields) { check(`${f.name}: accepted (no field expectation)`, true); continue; }
    const want_ = Object.fromEntries(Object.entries(f.fields).map(([k, v]) => [k, norm(v)]));
    const problems: string[] = [];
    for (const [k, v] of Object.entries(got)) if (want_[k] === undefined) problems.push(`unexpected ${k}="${v}"`); else if (want_[k] !== v) problems.push(`${k}: got "${v}" want "${want_[k]}"`);
    for (const k of Object.keys(want_)) if (got[k] === undefined) problems.push(`missing ${k}`);
    if (f.type && r.type !== f.type) problems.push(`type ${r.type} want ${f.type}`);
    // every field carries a confidence and the page it came from
    for (const x of r.toolInput.fields) if (!(x.confidence > 0 && x.confidence <= 1) || !Number.isInteger(x.page_no) || !x.verbatim) problems.push(`field ${x.key} lacks confidence/page/verbatim`);
    if (problems.length) { wrong += problems.length; wrongDetail.push(`${f.name}: ${problems.join('; ')}`); check(`${f.name}: exact fields`, false, problems.join('; ')); }
    else { check(`${f.name}: accepted with exactly the expected fields`, true); if (want === 'accept') expectedAcceptHit++; }
  } else {
    refused++;
    if (want === 'accept') check(`${f.name}: accepted`, false, `refused: ${r.reason} / ${(r as { genericReason?: string }).genericReason ?? ''}`);
    else {
      const reason = `${r.reason} ${(r as { genericReason?: string }).genericReason ?? ''}`;
      const okWhy = !f.why || want === 'any' || reason.includes(f.why);
      check(`${f.name}: falls back to the model${f.why ? ` (${f.why})` : ''}`, okWhy, reason);
    }
  }
}

const total = F.length;
console.log(`\nfixtures: ${total}; accepted deterministically: ${accepted}; refused (model): ${refused}; WRONG values: ${wrong}`);
console.log(`positive fixtures accepted: ${expectedAcceptHit}/${expectedAccept.length} (${(100 * expectedAcceptHit / expectedAccept.length).toFixed(0)}%); all fixtures: ${accepted}/${total} (${(100 * accepted / total).toFixed(0)}%)`);
for (const w of wrongDetail) console.log('   wrong:', w);
check('zero wrong values on the whole fixture set', wrong === 0, wrongDetail.slice(0, 3).join(' | '));
check('at least 40 fixtures', total >= 40, String(total));
check('at least 85% of the positive fixtures skip the model', expectedAcceptHit / expectedAccept.length >= 0.85, `${expectedAcceptHit}/${expectedAccept.length}`);

/* ------------------------------------------------------------------ money parsing */
{
  const cases: [string, string | null][] = [
    ['$1,234.56', '1234.56'], ['1234.56', '1234.56'], ['-$45.00', '-45.00'], ['$-45.00', '-45.00'], ['($45.00)', '-45.00'], ['45.00-', '-45.00'],
    ['$1,234', '1234'], ['1234', null], ['12,34.00', null], ['$1,234.5', null], ['--5.00', null], ['$45.00 USD', '45.00'], ['TBD', null], ['1.234,56', null], ['', null],
  ];
  for (const [i, o] of cases) check(`parseMoney(${JSON.stringify(i)}) = ${JSON.stringify(o)}`, parseMoney(i) === o, String(parseMoney(i)));
}

/* ------------------------------------------------------------------ behaviour that must not change */
{
  const receipt = F[0];
  check('kill switch: generic:false restores refusal for a receipt', !extractFromText([{ page_no: 1, text: receipt.text }], { generic: false }).accepted);
  const strictInvoice = `Sonoran Comfort Air\nINVOICE\nInvoice #: INV-31000\nDate: 09/12/2026\nBill To: Plaza Dental Group\nService Address: 18 N Center St, Mesa, AZ 85201\nTOTAL DUE: $182.50\nTechnician: Marcus Bell`;
  const a = extractFromText([{ page_no: 1, text: strictInvoice }], { generic: false });
  const b = extractFromText([{ page_no: 1, text: strictInvoice }]);
  check('a document the template path accepts is returned unchanged by the wrapper', a.accepted && b.accepted && JSON.stringify(a.toolInput) === JSON.stringify(b.toolInput));
  const hvacPack = extractFromText([{ page_no: 1, text: receipt.text }], { pack: hvac });
  check('hvac pack object behaves like no pack', hvacPack.accepted);
  check('a non-HVAC pack no longer blanket-refuses a plumbing invoice', run(F.find((x) => x.name.startsWith('plumbing invoice (plumbing')) as Fx).accepted);
  const sp = extractFromText([{ page_no: 1, text: '' }], {});
  check('empty pages are refused', !sp.accepted);
}

/* ------------------------------------------------------------------ financials hook: same acceptance rule */
{
  const po = F.find((f) => f.name === 'purchase order') as Fx;
  const pages = [{ page_no: 1, text: po.text }];
  const fin = financialsInputFromText(pages, 'purchase-order');
  check('financials: PO with a clear total skips the model', fin?.total?.value === '334.56' && fin.kind === 'po' && fin.direction === 'payable' && fin.vendor_name === 'Carrier Supply Houston' && fin.po_number === '3102', JSON.stringify(fin));
  check('financials: total carries page + verbatim', fin?.total?.page_no === 1 && /334\.56/.test(fin?.total?.verbatim ?? ''));
  const cm = financialsInputFromText([{ page_no: 1, text: F[2].text }], 'invoice');
  check('financials: credit memo is a credit_memo with the printed (negative) amount', cm?.kind === 'credit_memo' && cm.total.value === '-75.00', JSON.stringify(cm));
  const inv = financialsInputFromText([{ page_no: 1, text: (F.find((f) => f.name.startsWith('law-firm')) as Fx).text }], 'invoice');
  check('financials: law-firm invoice total, number and date', inv?.total?.value === '900.00' && inv.invoice_number === '24310' && inv.invoice_date === '2026-09-01', JSON.stringify(inv));
  check('financials: two different totals -> model', financialsInputFromText([{ page_no: 1, text: F.find((f) => f.name.includes('two different Totals'))!.text.replace('Receipt', 'INVOICE') }], 'invoice') == null);
  check('financials: ambiguous total on a PO -> model', financialsInputFromText([{ page_no: 1, text: po.text.replace('Total: $334.56', 'Total: $334.56\nTotal: $400.00') }], 'purchase-order') == null);
  check('financials: a receipt is not a financial type here', financialsInputFromText([{ page_no: 1, text: F[0].text }], 'receipt') == null);
  check('financials: plumbing invoice with the plumbing pack', financialsInputFromText([{ page_no: 1, text: (F.find((f) => f.name.startsWith('plumbing invoice (plumbing')) as Fx).text }], 'invoice', { pack: plumbing })?.total?.value === '285.00');
  check('financials: stored type must equal the title type', financialsInputFromText(pages, 'invoice') == null);
}

/* ------------------------------------------------------------------ classification gaps */
{
  const t = (title: string) => classifyFromText([{ page_no: 1, text: `${title}\nx` }])?.type ?? null;
  const want: [string, string][] = [
    ['Credit Memo', 'invoice'], ['Credit Note', 'invoice'], ['Receipt', 'receipt'], ['Rental Agreement', 'agreement'], ['Packing Slip', 'delivery-ticket'],
    ['Pickup Ticket', 'delivery-ticket'], ['Purchase Order', 'purchase-order'], ['Rent Ledger', 'statement'], ['Statement of Account', 'statement'],
    ['Offer Letter', 'hr-letter'], ['Certificate of Insurance', 'insurance-certificate'], ['Price List', 'price-list'], ['Weekly Schedule', 'schedule'], ['Invoice', 'invoice'],
  ];
  for (const [title, type] of want) check(`title "${title}" -> ${type}`, t(title) === type, String(t(title)));
  check('filename: credit memo -> invoice, packing slip -> delivery-ticket', inferTypeFromFilename('CM-0045 Credit Memo.pdf') === 'invoice' && inferTypeFromFilename('PS-0099 Packing Slip.pdf') === 'delivery-ticket');
  check('resolveDocumentType keeps a title-derived generic type', resolveDocumentType({ document_type: 'receipt', document_type_confidence: 0.95 }, {}, 'x.pdf', null).documentType === 'receipt');
}

console.log(`\n${fail ? `${fail} check(s) FAILED` : 'All ingest-deterministic checks passed'} (${pass} ok)`);
process.exit(fail ? 1 : 0);
