// npm run verify:recheck-all
// Inbox "Re-check all open papers": which papers are sent (every open one, never verified or set-aside), how "still need a person" is read
// from the refreshed Inbox, and the plain-words banner. The server side is proven by scripts/verify-recheck-bulk.mjs on a real Postgres.
import { readFileSync } from 'node:fs';
import * as React from 'react';
(globalThis as unknown as { React: typeof React }).React = React;
import { recomputeIssues, type GraphSnapshot } from '../src/core/entityGraph';
import { hvacSchema } from '../src/domains/hvac/schema';
import { openPaperIds, recheckBanner, recheckProgress, stillOpenSummary } from '../src/screens/recheckAll';
import type { Doc } from '../src/core/types';

import { substantiveFactNames } from '../src/core/entityGraph';
const substantiveFactNamesOf = (d: Doc) => substantiveFactNames(d).length;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); } };
console.log('verify:recheck-all');
const field = (name: string, value: string, confidence = 0.9) => ({ name, value, confidence, location: {} });
const doc = (id: string, o: Partial<Doc> = {}): Doc => recomputeIssues({
  id, filename: `${id}.pdf`, fileType: 'pdf', pages: 1, batchId: 'b1', source: 'drive', receivedAt: new Date('2026-01-01'),
  typeId: null, stage: 'linked', extracted: [], linkedEntityIds: ['c1'], linkConfidence: 1, issues: [], preview: 'text', ...o,
} as Doc, hvacSchema);
const graphOf = (docs: Doc[]): GraphSnapshot => ({ schema: hvacSchema, entities: {}, batches: {}, docs: Object.fromEntries(docs.map((d) => [d.id, d])), conflicts: {}, lastError: null });

const gap = doc('gap', { typeId: 'invoice', stage: 'classified', extracted: [field('cost', '9')] });
const unl = doc('unl', { typeId: 'work-order', stage: 'extracted', linkedEntityIds: [], extracted: [field('service_date', '2026-01-02'), field('service_address', '1 Main'), field('work_performed', 'x')] });
const ver = doc('ver', { typeId: 'invoice', stage: 'verified', extracted: [field('cost', '9')] });
const g = graphOf([gap, unl, ver]);
check('sends every open paper, not only missing-info ones', openPaperIds(g).sort().join() === 'gap,unl');
check('never sends a verified paper', !openPaperIds(g).includes('ver'));
const s = stillOpenSummary(g, ['gap', 'unl', 'ver']);
check('still-open count skips verified papers', s.count === 2, JSON.stringify(s));
check('top reasons are plain words with counts', s.top.length >= 1 && s.top.every((t) => t.label && t.count > 0), JSON.stringify(s));
const g2 = graphOf([gap, unl, { ...unl, id: 'unl2' }, ver]);
check('after a refresh a paper that is now verified drops out', stillOpenSummary(graphOf([gap, { ...unl, stage: 'verified' }, ver]), ['gap', 'unl']).count === 1);
check('reasons are sorted largest first', stillOpenSummary(g2, ['gap', 'unl', 'unl2']).top[0]!.count >= 1);
const banner = recheckBanner({ checked: 960, fields: 717, linked: 321, verified: 611, retyped: 0 }, { count: 349, top: [{ label: 'Fact not on the page', count: 149 }, { label: 'Choose a document type', count: 35 }] });
check('banner lists filled, linked, checked, still need a person and top reasons', banner === 'Re-checked 960 papers. Filled in 717 facts, linked 321 to customers, checked 611 automatically. 349 still need a person. Main reasons: Fact not on the page (149), Choose a document type (35).', banner);
check('banner is singular for one paper', /^Re-checked 1 paper\. Filled in 1 fact,/.test(recheckBanner({ checked: 1, fields: 1, linked: 0, verified: 0, retyped: 0 }, { count: 0, top: [] })));
check('banner omits reasons when nobody is left', !/Main reasons/.test(recheckBanner({ checked: 2, fields: 0, linked: 0, verified: 2, retyped: 0 }, { count: 0, top: [] })));
check('progress line', recheckProgress(100, 960) === 'Re-checking 100 of 960...');
const screen = readFileSync(new URL('../src/screens/ReviewScreen.tsx', import.meta.url), 'utf8');
check('button sends in chunks and re-queues papers the server ran out of time for', /RECHECK_CHUNK/.test(screen) && /leftIds/.test(screen) && /openAll: true/.test(screen));
check('button is shown on Missing info, Needs a person, Needs linking and Ready to verify', /filter === 'unlinked' \|\| filter === 'ready'\) && openIds\.length > 0/.test(screen));

// ---- Round 2 safety: who may a paper be linked to? (pure matcher; the database side is verify-recheck-all-safety.mjs)
const { findCustomersInBody, splitPartyZones, isSetAsidePaper, printedNameMatches, isAddressContinuation } = await import('../api/_lib/bodyNameLink.js');
const pg = (text: string) => [{ page_no: 1, text }];
const C = [
  { id: 'jane', name: 'Jane Smith', address: '12 Oak Ln, Mesa, AZ' },
  { id: 'john', name: 'John Smith', address: '40 Cedar Dr, Mesa, AZ' },
  { id: 'maria', name: 'Maria Lopez', address: '500 Pine Rd, Mesa, AZ' },
  { id: 'bob', name: 'Bob Stone', address: '9 Birch St, Tempe, AZ' },
  { id: 'own1', name: 'Sonoran Comfort Air LLC', address: '' },
  { id: 'acme', name: 'Acme Dental Group', address: '77 Mill Ave, Tempe, AZ' },
];
const OWN = ['Sonoran Comfort Air'];
const NOLINK = ['none', 'partial', 'ambiguous'];
const noLink = (text: string, o: Record<string, unknown> = {}) => NOLINK.includes(String(link(text, o)));
const link = (text: string, o: Record<string, unknown> = {}) => { const v = findCustomersInBody(pg(text), C, { ownNames: OWN, ...o }); return v.status === 'unique' ? v.matches[0].customerId : v.status; };

// D1 own company, with Inc / LLC / "The" / punctuation variations
for (const v of ['Sonoran Comfort Air', 'Sonoran Comfort Air, Inc.', 'SONORAN COMFORT AIR L.L.C.', 'The Sonoran Comfort Air Co', 'Sonoran Comfort Air LLC']) {
  const cs = [{ id: 'own', name: v, address: '' }];
  const r = findCustomersInBody(pg(`Bill To: ${v}\nThank you`), cs, { ownNames: OWN });
  check(`own company "${v}" never links as a customer`, r.status !== 'unique', r.status);
}
check('own company named "Sonoran Comfort Air Services" (longer) is still us', findCustomersInBody(pg('Bill To: Sonoran Comfort Air Services'), [{ id: 'o', name: 'Sonoran Comfort Air Services', address: '' }], { ownNames: OWN }).status !== 'unique');
check('R4 our own name as bill-to plus a customer ADDRESS alone is not strong enough', noLink('Bill To: Sonoran Comfort Air LLC\nService Address: 12 Oak Ln, Mesa, AZ'));
check('a real customer on the same paper as our own name still links (name and address)', link('Bill To: Sonoran Comfort Air LLC\nCustomer: Jane Smith\nService Address: 12 Oak Ln, Mesa, AZ') === 'jane');
check('a different company with a similar start is not "us"', link('Customer: Acme Dental Group') === 'acme');

// D2 vendor / issuer block is never the bill-to
check('vendor named like a customer + walk-in bill-to = no link', link('Vendor: John Smith Heating & Air\n500 Pine Rd\nBill To: Walk-in customer') === 'none');
check('vendor address equal to a customer address, bill-to is walk-in = no link', link('From: Desert Air Co\n500 Pine Rd, Mesa AZ\nBill To: Walk-in customer\nTotal $90') === 'none');
check('letterhead (no labels on top) naming a customer street, bill-to elsewhere = bill-to wins', link('Pine Rd Plumbing LLC 500 Pine Rd Mesa AZ (480) 555-0100\nBill To: Bob Stone\n9 Birch St, Tempe, AZ') === 'bob');
check('letterhead address of a customer + bill-to walk-in = no link', link('Pine Road Plumbing LLC\n500 Pine Rd Mesa AZ (480) 555-0100\nBill To: Walk-in customer') === 'none');
check('remit-to block naming a customer is ignored', link('Bill To: Walk-in\nRemit To: John Smith\n40 Cedar Dr, Mesa') === 'none');
check('customer name inside the vendor name AND bill-to is not trusted', noLink('From: John Smith Heating & Air\nBill To: John Smith\nTotal $10'));
check('bill-to Maria + vendor "John Smith Heating" links Maria only', link('From: John Smith Heating & Air\nBill To: Maria Lopez\n500 Pine Rd') === 'maria');
check('R4 a service-address label with only a street (no name) is weak: not linked', noLink('Invoice 77\nService Address: 40 Cedar Dr, Mesa AZ\nVendor: Desert Air'));
check('R4 name as the customer value plus its street links', link('Invoice 77\nCustomer: John Smith\nService Address: 40 Cedar Dr, Mesa AZ\nVendor: Desert Air') === 'john');
check('R4 a memo naming a customer inside a sentence is weak (listed for a person, not linked)', noLink("Reminder logged for Bob Stone's account: confirm filter size on next visit"));
check('R4 a memo naming the customer AND the street links', link("Meeting notes\nDate 3/4\nAttendees: staff\nAgenda: filters\nItems: none\nReminder for Bob Stone at 9 Birch St, Tempe: confirm filter size on the next visit") === 'bob');
check('memo letterhead line is not treated as customer', noLink('Desert Air Heating LLC (480) 555-0100\nNote for Bob Stone: call back'));

// multi-column invoices
check('two columns FROM / BILL TO on one header row, values below', link('FROM                     BILL TO\nJohn Smith Heating       Maria Lopez\n40 Cedar Dr              500 Pine Rd') === 'maria');
check('two columns, customer on the LEFT (BILL TO / FROM)', link('BILL TO                  FROM\nBob Stone                John Smith Heating\n9 Birch St               40 Cedar Dr') === 'bob');
check('two columns Bill To / Ship To, both the same customer', link('Bill To:           Ship To:\nBob Stone          Bob Stone\n9 Birch St         9 Birch St') === 'bob');
check('two columns Bill To / Ship To, two different customers = ambiguous', link('Bill To:           Ship To:\nBob Stone          Maria Lopez') === 'ambiguous');
check('same-line "FROM: x   BILL TO: y"', link('FROM: Desert Air Co    BILL TO: Maria Lopez') === 'maria');
check('three columns with a cell that does not line up is dropped (no guess)', link('FROM      BILL TO     SHIP TO\nDesert Air Maria Lopez') === 'none');
check('pipe separated columns', link('Vendor | Bill To\nJohn Smith Heating | Bob Stone') === 'bob');

// D3 printed customer_name wins
check('printed customer Zed Printed + body note naming John Smith = no link', link('Customer: Zed Printed\nNote: John Smith referred us\nBill To: Zed Printed', { printedName: 'Zed Printed' }) === 'none');
check('printed customer, mention in a customer zone of someone else = no link', link('Bill To: John Smith\nShip To: John Smith', { printedName: 'Zed Printed' }) === 'none');
check('printed customer matches the one named = links', link('Bill To: Jane Smith', { printedName: 'Jane Smith' }) === 'jane');
check('printed John Smith does not let the page\'s Jane link', noLink('Bill To: Jane Smith', { printedName: 'John Smith' }));
check('printed "J. Smith" vs "Jane Smith": same surname + initial is accepted', printedNameMatches('J. Smith', 'Jane Smith'));
check('printed "Smith" alone does not match "Jane Smith" by surname', !printedNameMatches('Smith', 'Jane Smith'));
check('a label read as a printed value is ignored (Walk-in)', link('Bill To: Jane Smith', { printedName: 'Walk-in customer' }) === 'jane');
check('printed name = our own company is ignored', link('Bill To: Jane Smith', { printedName: 'Sonoran Comfort Air Inc' }) === 'jane');
check('printed "Acme Dental Group Inc" matches customer "Acme Dental Group"', link('Bill To: Acme Dental Group', { printedName: 'Acme Dental Group Inc.' }) === 'acme');

// still strict as before
check('same surname only = partial, no link', ['partial', 'none'].includes(String(link('Bill To: Mr. Smith'))));
check('two customers on one paper = ambiguous', link('Bill To: John Smith\nShip To: Jane Smith') === 'ambiguous');
check('first names only = no link', link('Bill To: Maria') === 'none');

// zones
const z = splitPartyZones(pg('Desert Air LLC (480) 555-0100\nBill To: Maria Lopez\n500 Pine Rd\nPhone: 555\nRemit To: PO Box 1'));
check('zones: customer lines are Maria + street, vendor has the letterhead and remit', z.customer.join('|') === 'Maria Lopez|500 Pine Rd' && z.vendor.length === 2, JSON.stringify(z));

// ---- Round 3: zone bleed, false labels, collapsed lines, bare issuer line
const C3 = [...C, { id: 'delta', name: 'Delta Plumbing Supply', address: '' }, { id: 'acme2', name: 'Acme Dental Group', address: '77 Mill Ave, Tempe, AZ' }];
const link3 = (text: string, o: Record<string, unknown> = {}) => { const v = findCustomersInBody(pg(text), C3, { ownNames: OWN, ...o }); return v.status === 'unique' ? v.matches[0].customerId : v.status; };
// W1
check('W1 "Bill To: Walk-in" then the vendor name on the next line does not link the vendor', link3('Bill To: Walk-in\nJohn Smith Heating & Air\n(480) 555-0100') !== 'john');
check('W1 "Ship To: Walk-in" then a supplier name does not link it', link3('Ship To: Walk-in\nDelta Plumbing Supply\n10 Main St') !== 'delta');
check('W1 label alone, value on the next line, still links', link3('Bill To:\nMaria Lopez\n500 Pine Rd') === 'maria');
check('R5 a customer label alone, one blank line (scan gap), then the exact name, links', link('BILL TO\n\nBob Stone\n9 Birch St') === 'bob');
check('R5 two blank lines end the block', noLink('BILL TO\n\n\nBob Stone\n9 Birch St'));
check('R4 label alone, name on the very next line, links', link3('BILL TO\nBob Stone\n9 Birch St') === 'bob');
check('W1 name, address, then a second name: the second is not read', link3('Bill To: Walk-in\n12 Oak Ln\nJohn Smith') !== 'john');
check('W1 a filled bill-to followed by an address line: the address alone is weak, no link', link3('Bill To: Walk-in\n40 Cedar Dr, Mesa AZ 85201') !== 'john');
check('W1 filled customer value then a vendor line = only the customer', link3('Customer: Maria Lopez\nDelta Plumbing Supply\nTotal $5') === 'maria');
check('W1 a service-address label followed by a name line after a filled address is closed', link3('Service Address: 22 Nowhere Way\nBob Stone\n') !== 'bob');
check('W1 "Attn" in capitals does not close the block (still weak: no link)', link3('Bill To: Walk-in\nATTN: Accounts\n40 Cedar Dr, Mesa AZ 85201') !== 'john');
// W2
for (const t of ['Customer Service: Jane Smith', 'Customer Care: Jane Smith', 'Client Services: Jane Smith', 'Client Signature: Jane Smith', 'Customer Support Jane Smith', 'Bill To: Walk-in\nCustomer Service: Jane Smith', 'Client Signature: Jane Smith\nBill To: Walk-in']) {
  check(`W2 "${t.replace(/\n/g, ' / ')}" is not a party label`, link3(t) !== 'jane');
}
check('W2 "Customer: Jane Smith" is a label', link3('Customer: Jane Smith') === 'jane');
check('W2 "Customer - Jane Smith" is a label', link3('Customer - Jane Smith') === 'jane');
check('W2 "Customer Name: Jane Smith" is a label', link3('Customer Name: Jane Smith') === 'jane');
// W3
check('W3 collapsed line "Bill To Walk-in From <vendor>" does not link the vendor', link3('Bill To Walk-in From John Smith Heating 300 Birch St') !== 'john');
check('W3 collapsed line "Bill To <customer> From <vendor>" links the customer', link3('Bill To Maria Lopez From John Smith Heating') === 'maria');
check('W3 collapsed "Sold To Bob Stone Remit To Delta Plumbing Supply"', link3('Sold To Bob Stone Remit To Delta Plumbing Supply') === 'bob');
check('W3 collapsed "Bill To Walk-in Vendor: Delta Plumbing Supply"', link3('Bill To Walk-in Vendor: Delta Plumbing Supply') !== 'delta');
check('W3 collapsed "Bill To Walk-in Sold By John Smith"', link3('Bill To Walk-in Sold By John Smith') !== 'john');
// W4
check('W4 bare issuer name on line 1 of an unlabelled paper is never linked', link3('Acme Dental Group\n77 Mill Ave\nTempe, AZ 85281\n(480) 555-0111\n\nMinutes of the March meeting') === 'none');
check('W4 bare issuer name + address only (no phone) is not linked', link3('Acme Dental Group\n77 Mill Ave, Tempe\n\nBudget summary 2026') === 'none');
check('W4 issuer line 1, customer named later in the body, is weak: not linked', noLink('Acme Dental Group\n77 Mill Ave\n\nStatement for Bob Stone: balance $20'));
check('W4 issuer is a sole proprietor "Bob Stone" on line 1 of a letter: not linked', link3('Bob Stone\n9 Birch St\n\nDear customer, your filter is due') === 'none');
check('W4 a one-line memo naming a customer is weak: not linked', noLink("Reminder logged for Maria Lopez's account: confirm filter size on next visit"));
check('W4 memo whose first line is a sentence: weak, not linked', noLink('Call back Bob Stone about the quote\nThanks'));

// ---- Round 4: strong evidence only (the verifier's 6 wrong links + new variants)
const C4 = [...C, { id: 'delta', name: 'Delta Plumbing Supply', address: '' }];
const link4 = (text: string, o: Record<string, unknown> = {}) => { const v = findCustomersInBody(pg(text), C4, { ownNames: OWN, ...o }); return v.status === 'unique' ? v.matches[0].customerId : v.status; };
const wrongOf = (text: string, bad: string) => link4(text) !== bad;
// D1: continuation lines after a filled bill-to must be a real address, not a vendor
check('R4 "Delta Plumbing Supply, Co" after a filled bill-to is not an address', wrongOf('Bill To: Walk-in\nDelta Plumbing Supply, Co', 'delta'));
check('R4 "Bob Stone Heating, LP" after a filled bill-to is not an address', wrongOf('Bill To: Walk-in\nBob Stone Heating, LP', 'bob'));
check('R4 "4 Seasons Delta Plumbing Supply" (digit-led vendor) is not an address', wrongOf('Bill To: Walk-in\n4 Seasons Delta Plumbing Supply', 'delta'));
check('R4 "Delta Plumbing Supply, CO" is a company word line, not a city line', wrongOf('Bill To: Walk-in\nDelta Plumbing Supply, CO', 'delta'));
check('R4 ", Inc" / ", LLC" / ", Ltd" vendor lines are not addresses', ['Delta Plumbing Supply, Inc', 'Delta Plumbing Supply, LLC', 'Delta Plumbing Supply, Ltd'].every((v) => wrongOf(`Bill To: Walk-in\n${v}`, 'delta')));
check('R4 a real street and city line are still address continuation', isAddressContinuation('4 Seasons Way') && isAddressContinuation('Mesa, AZ 85201') && isAddressContinuation('Suite 305') && !isAddressContinuation('Delta Plumbing Supply, Co'));
// D2: label + blank + letterhead-looking value
check('R4 "Customer:" blank line "Bob Stone Plumbing & Heating" is not a link', wrongOf('Customer:\n\nBob Stone Plumbing & Heating\n(480) 555-1212', 'bob'));
check('R4 "Customer:" blank line "John Smith Mechanical LLC" is not a link', wrongOf('Customer:\n\nJohn Smith Mechanical LLC', 'john'));
check('R4 "Customer:" directly followed by a vendor-like name is not an exact name value', wrongOf('Customer:\nJohn Smith Heating & Air\n300 Birch St', 'john'));
check('R4 "Bill To: John Smith Heating & Air" (name + trade words) is not the customer "John Smith"', wrongOf('Bill To: John Smith Heating & Air', 'john'));
check('R4 "Owner: John Smith Heating & Air" is not a link', wrongOf('Owner: John Smith Heating & Air', 'john'));
// D3: lowercase / any-case OCR issuer
check('R4 lowercase issuer line "acme dental group" + "report" is not linked', wrongOf('acme dental group\nreport\nprepared by staff', 'acme'));
check('R4 UPPERCASE issuer line is not linked', wrongOf('ACME DENTAL GROUP\nMonthly report', 'acme'));
check('R4 issuer with trailing punctuation-free short line + sentence below is not linked', wrongOf('Acme Dental Group\nPlease find the schedule for next month below.', 'acme'));
// strong evidence cases that must link
check('R4 (a) name is the Bill To value', link4('Bill To: Maria Lopez') === 'maria');
check('R4 (a) name is the value with a legal suffix ("Acme Dental Group Inc.")', link4('Bill To: Acme Dental Group Inc.') === 'acme');
check('R4 (a) name then inline street', link4('Customer: Maria Lopez 500 Pine Rd') === 'maria');
check('R4 (a) next-line value', link4('Sold To\nMaria Lopez\n500 Pine Rd, Mesa AZ 85201') === 'maria');
check('R4 (b) name inside a sentence on the customer side + its street links', link4('Customer: Maria Lopez asked for a call\n500 Pine Rd, Mesa AZ') === 'maria');
check('R4 name inside a sentence but no street is weak', noLink('Customer: see notes\nNotes: Maria Lopez asked for a call'));
check('R4 name matches one customer, street matches another = ambiguous (review)', link4('Bill To: Maria Lopez\n9 Birch St, Tempe AZ') === 'ambiguous');
// warranty OWNER column beside INSTALLING DEALER
check('R4 warranty registration: OWNER column beside INSTALLING DEALER links the owner', link4('OWNER                      INSTALLING DEALER\nBob Stone                  Delta Plumbing Supply\n9 Birch St                 10 Main St') === 'bob');
check('R4 warranty registration: owner on the right', link4('INSTALLING DEALER           OWNER\nDelta Plumbing Supply        Bob Stone') === 'bob');
check('R4 "Registered Owner: Maria Lopez" links', link4('Registered Owner: Maria Lopez') === 'maria');
check('R4 "Installer: Maria Lopez Heating" never links', wrongOf('Installer: Maria Lopez Heating\nOwner: Walk-in', 'maria'));

// ---- Round 5: new label forms (recall) and a seeded fuzz set (zero wrong links is the hard bar)
const C5 = [
  { id: 'maria', name: 'Maria Lopez', address: '500 Pine Rd, Mesa, AZ' }, { id: 'bob', name: 'Bob Stone', address: '9 Birch St, Tempe, AZ' },
  { id: 'delta', name: 'Delta Plumbing Supply', address: '10 Main St, Tempe, AZ' }, { id: 'acme', name: 'Acme Dental Group', address: '77 Mill Ave, Tempe, AZ' },
  { id: 'john', name: 'John Smith', address: '40 Cedar Dr, Mesa, AZ' }, { id: 'jane', name: 'Jane Smith', address: '12 Oak Ln, Mesa, AZ' },
  { id: 'harbor', name: 'Harborlight Neighbors Alliance', address: '7714 N Aspen Way, Tacoma, WA' }, { id: 'own', name: 'Sonoran Comfort Air LLC', address: '1558 S Meadow St, Mesa, AZ' },
];
const L5 = (text: string, o: Record<string, unknown> = {}) => { const v = findCustomersInBody(pg(text), C5, { ownNames: OWN, ...o }); return v.status === 'unique' ? v.matches[0].customerId : v.status; };
// labels that the verifiers' lost links used
check('R5 "TO" alone, blank line, name (letters)', L5('Date 3/4\nTO\n\nMaria Lopez\n500 Pine Rd') === 'maria');
check('R5 memo "To: Maria Lopez"', L5('MEMO\nTo: Maria Lopez\nRe: filter') === 'maria');
check('R5 "To:" in the middle of a sentence is not a label', noLink('Please send the filter to  Maria Lopez  tomorrow'));
check('R5 GRANTEE column beside FUNDER', L5('FUNDER                       GRANTEE\nDelta Plumbing Supply        Harborlight Neighbors Alliance\nAttn: Gordon          7714 N Aspen Way') === 'harbor');
check('R5 RECEIVED FROM, blank line, name', L5('RECEIVED FROM\n\nBob Stone\n9 Birch St') === 'bob');
check('R5 Client ... Client ID header on one line', L5('Client   Jane Smith   Client ID   C-1034\nPeriod   June 2025') === 'jane');
check('R5 Client | name | Client ID | id table row', L5('Client | Jane Smith | Client ID | C-1011\nPay Period | 08/01') === 'jane');
check('R5 DOCX " / " on the label line', L5('Grant No. | AW-25-1471\nTO / Harborlight Neighbors Alliance / Attn: Gordon Patel / 7714 N Aspen Way\nDear Marguerite Hale:') === 'harbor');
check('R5 CREDIT TO label', L5('CREDIT TO\nBob Stone\n9 Birch St') === 'bob');
check('R6 an applicant (employment/grant) is not a customer: never links', noLink('APPLICANT\nAcme Dental Group\nAttn: Grace Ortega') && noLink('Applicant: Linda Kowalczyk\nPosition: Tech'));
check('R5 Spanish: Facturar a / Cliente / Vendido a / Enviar a', ['Facturar a: Maria Lopez', 'Cliente: Maria Lopez', 'Vendido a: Maria Lopez', 'Enviar a: Maria Lopez'].every((x) => L5(x) === 'maria'));
check('R5 Spanish vendor labels never link the vendor', ['De: Delta Plumbing Supply\nFacturar a: Walk-in', 'Proveedor: Delta Plumbing Supply\nCliente: Walk-in', 'Emisor: Bob Stone\nCliente: Walk-in'].every((x) => !['delta', 'bob'].includes(String(L5(x)))));
check('R5 OCR labels: BiII To / Bi11 To / B1LL TO / Sold T0 / Sh1p To', ['BiII To: Maria Lopez', 'Bi11 To: Maria Lopez', 'B1LL TO: Maria Lopez', 'Sold T0: Maria Lopez', 'Sh1p To: Maria Lopez'].every((x) => L5(x) === 'maria'));
check('R5 OCR label with walk-in + vendor below does not link the vendor', ['BiII To: Walk-in\nDelta Plumbing Supply', 'B1LL TO: Walk-in\nBob Stone', 'Sold T0: Walk-in\nJohn Smith Heating & Air'].every((x) => !['delta', 'bob', 'john'].includes(String(L5(x)))));
check('R5 bulleted and table labels', ['• Bill To: Maria Lopez', '- Bill To: Maria Lopez', 'Row 5 | Bill To | Maria Lopez', '| Bill To | Maria Lopez |'].every((x) => L5(x) === 'maria'));
check('R5 bulleted vendor label never links', ['• From: Delta Plumbing Supply\n• Bill To: Walk-in', 'Row 2 | Vendor | Bob Stone\nRow 3 | Bill To | Walk-in'].every((x) => !['delta', 'bob'].includes(String(L5(x)))));

// R6.2 a labelled value wrapped onto the next line is the same label's value
check('R6.2 "Customer: Maria" + "Lopez" on the next line links to Maria Lopez', L5('Invoice 5\nCustomer: Maria\nLopez\nTotal $5') === 'maria' && L5('Bill To: Jane\nSmith\n12 Oak Ln') === 'jane');
check('R6.2 a wrapped value never links when the joined text is not the whole name, or the next line is a vendor/other label', [
  'Customer: Maria\nLopez Foods', 'Customer: Walk-in\nBob Stone', 'Customer: Maria\nDate: 3/4\nLopez', 'Customer: Maria\n500 Pine Rd', 'From: Bob\nStone\nBill To: Walk-in', 'Customer Service: Maria\nLopez', 'Customer: John\nSmith Heating & Air Supply',
].every((x) => noLink(x)), ['Customer: Maria\nLopez Foods', 'Customer: Walk-in\nBob Stone', 'Customer: Maria\nDate: 3/4\nLopez', 'Customer: Maria\n500 Pine Rd', 'From: Bob\nStone\nBill To: Walk-in', 'Customer Service: Maria\nLopez', 'Customer: John\nSmith Heating & Air Supply'].map((x) => L5(x)).join());

check('R6.2 a read value that is only the first line of a wrapped value ("Maria") still links; a conflicting read value ("Bob") does not', L5('Customer: Maria\nLopez', { printedName: 'Maria' }) === 'maria' && noLink('Customer: Maria\nLopez', { printedName: 'Bob' }) );

// fuzz: a customer slot (or a walk-in slot) plus vendor-side decoys; the answer may be the true customer or no link, NEVER a decoy
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rnd = rng(Number(process.env.FUZZ_SEED) || 20261025);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const CUST_SLOTS: ((n: string, a: string) => string)[] = [
  (n) => `Bill To: ${n}`, (n) => `BILL TO\n${n}`, (n) => `BILLTO\n\n${n}`, (n, a) => `Bill To\n${n}\n${a}`, (n) => `• Bill To: ${n}`, (n) => `Row 5 | Bill To | ${n}`,
  (n, a) => `TO / ${n} / Attn: Accounts / ${a}`, (n) => `TO\n\n${n}`, (n) => `RECEIVED FROM\n\n${n}`, (n) => `Client   ${n}   Client ID   C-1`, (n) => `Client | ${n} | Client ID | C-1`,
  (n) => `Facturar a: ${n}`, (n) => `Cliente: ${n}`, (n) => `BiII To: ${n}`, (n) => `B1LL TO: ${n}`, (n) => `Sold T0: ${n}`, (n) => `To: ${n}`, (n) => `Customer: ${n}`,
  (n, a) => `Service Address: ${a}\nCustomer: ${n}`,
  (n) => `Customer: ${n.split(' ')[0]}\n${n.split(' ').slice(1).join(' ')}`, (n) => `Bill To: ${n.split(' ')[0]}\n${n.split(' ').slice(1).join(' ')}\n(480) 555-0100`, (n) => `Sold To\n${n}\nAttn: Bob`, (n) => `Bill To Walk-in From ${n} Heating`,
];
const WALK_SLOTS = ['Bill To: Walk-in', 'BILL TO\nWalk-in customer', 'Customer:\n\nWalk-in', 'Cliente: Mostrador', 'To: Staff', 'Bill To: Walk-in\n(480) 555-0100', 'Bill To:', 'Customer: Walk-in\nStaff', 'Customer: Walk-in\nCounter Sale'];
const DECOYS: ((v: string, a: string) => string)[] = [
  (v) => `From: ${v}`, (v, a) => `Vendor: ${v}\n${a}`, (v, a) => `Remit To: ${v}\n${a}`, (v, a) => `${v}\n${a}\n(480) 555-0100\n`, (v) => `Sold By ${v}`, (v) => `Make checks payable to ${v}`,
  (v) => `De: ${v}`, (v) => `Proveedor: ${v}`, (v) => `• From: ${v}`, (v) => `Row 2 | Vendor | ${v}`, (v) => `Installer: ${v} Heating`, (v) => `Issued by ${v}`,
  (v) => `Bill To: Walk-in\n${v}, Co`, (v) => `Bill To: Walk-in\n${v}, LP`, (v) => `Customer Service: ${v}`, (v) => `From: ${v.split(' ')[0]}\n${v.split(' ').slice(1).join(' ')}`, (v) => `Vendor: ${v.split(' ')[0]}\n${v.split(' ').slice(1).join(' ')}`, (v) => `Customer: Walk-in\n${v}`, (v) => `Technician: ${v}`, (v) => `${v} Heating & Air\n(480) 555-1212`,
];
const NAMES = C5.filter((c) => c.id !== 'own');
let fuzzWrong = 0, fuzzLinked = 0, fuzzCases = 0, firstBad = '';
for (let i = 0; i < (Number(process.env.FUZZ_N) || 4000); i++) {
  const walk = rnd() < 0.35;
  const truth = pick(NAMES);
  const decoys = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => { const d = pick(NAMES.filter((x) => x.id !== truth.id)); return { d, text: pick(DECOYS)(d.name, d.address) }; });
  const slot = walk ? pick(WALK_SLOTS) : pick(CUST_SLOTS)(truth.name, truth.address);
  const parts = [slot, ...decoys.map((x) => x.text)];
  if (rnd() < 0.5) parts.reverse();
  const body = ['Invoice 1042', ...parts, 'Total $90'].join(rnd() < 0.5 ? '\n' : '\n\n');
  const v = findCustomersInBody(pg(body), C5, { ownNames: OWN });
  fuzzCases++;
  if (v.status === 'unique') {
    fuzzLinked++;
    const got = v.matches[0].customerId;
    const slotNamesDecoy = !walk && /Bill To Walk-in From/.test(slot);
    if (walk ? true : got !== truth.id) { if (!slotNamesDecoy || got !== truth.id) { fuzzWrong++; if (!firstBad) firstBad = JSON.stringify({ body, got, truth: walk ? null : truth.id }); } }
  }
}
check(`R5 fuzz: ${fuzzCases} papers, ${fuzzLinked} linked, zero wrong links`, fuzzWrong === 0, `${fuzzWrong} wrong; first: ${firstBad}`);
check('R5 fuzz recall is not trivially zero (strong forms still link)', fuzzLinked > 800, String(fuzzLinked));

// ---- Round 5/6: "Link to <customer>" suggestions kept for a person (Doc.linkSuggestionIds, filled by the sync from the server's audit record; never a fact)
const { linkSuggestions } = await import('../src/core/entityGraph');
const entMap = { c1: { id: 'c1', type: 'customer', fields: {} }, c2: { id: 'c2', type: 'customer', fields: {} }, u1: { id: 'u1', type: 'unit', fields: {} } } as never;
const sugDoc = (ids: string[], linked: string[] = []) => ({ ...doc('sug', { typeId: 'invoice', stage: 'read', linkedEntityIds: linked }), linkSuggestionIds: ids });
check('R5 a stored suggestion is offered for an unlinked paper', linkSuggestions(sugDoc(['c1', 'c2']), entMap).map((e) => e.id).join() === 'c1,c2');
check('R5 a suggestion for a customer that no longer exists is dropped', linkSuggestions(sugDoc(['gone']), entMap).length === 0);
check('R5 a non-customer is never suggested', linkSuggestions(sugDoc(['u1']), entMap).length === 0);
check('R5 a paper that is already linked shows no suggestion', linkSuggestions(sugDoc(['c1'], ['c2']), entMap).length === 0);
const screen5 = readFileSync(new URL('../src/screens/ReviewScreen.tsx', import.meta.url), 'utf8');
check('R6 final strings and one-click buttons are in the Review screen', /data-testid="link-suggestions"/.test(screen5) && /Link to \{entityLabel\(e\)\}/.test(screen5) && screen5.includes('This paper seems to name this customer, but not clearly enough to link automatically. Check it, then link.') && screen5.includes('This paper may belong to one of these customers. Check it, then pick one.'));
const sugAt = screen5.indexOf('data-testid="link-suggestions"');
check('R6 the suggestion block is NOT inside the "no missing info and has a type" condition', sugAt > 0 && !/doc\.typeId && missing\.length === 0/.test(screen5.slice(screen5.lastIndexOf('{/*', sugAt), sugAt)));
// D4 set-aside
check('VOID paper is set aside', isSetAsidePaper({ filename: 'inv-1.pdf', text: 'VOID\nInvoice' }));
check('"(copy)" and "copy of" and "(2)" and "v2" file names are set aside', ['a (copy).pdf', 'Copy of a.pdf', 'a (2).pdf', 'a_v2.pdf'].every((f) => isSetAsidePaper({ filename: f })));
check('a normal paper is not set aside', !isSetAsidePaper({ filename: 'invoice-1042.pdf', text: 'Invoice\nBill To: Maria' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
