/**
 * Unit checks for the 100-question persona sample's doc-lookup cluster
 * (2026-09-22): items 1, 2, 3 and 8. Pure shape-detection tests need no
 * database; the DB-touching orchestration functions (runDocLookup,
 * computeVisitHistory, resolveHonestZeroContext) are exercised against small
 * mock `db` objects, same convention as scripts/verify-analytics.mjs's own
 * contact-lookup section. No network, no model call, ever.
 *
 *   node scripts/verify-doclookup.mjs
 */
import {
  parseDocLookupQuestion,
  runDocLookup,
  resolveHonestZeroContext,
  buildHonestZeroText,
} from '../api/_lib/docLookup.js';
import {
  parseContactLookupQuestion,
  runContactLookup,
  computeVisitHistory,
  buildVisitAnswer,
  attachEquipmentFacts,
} from '../api/_lib/contactLookup.js';

let failures = 0;
let count = 0;
const check = (name, ok, detail = '') => {
  count++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ======================================================================
 * Item 1: document lookup by customer/address + type — shape detection.
 * ====================================================================== */

const DOC_LOOKUP_POSITIVES = [
  ['do we have a maintenance agreement on file for the Bracken job', 'maintenance-agreement', 'Bracken', false],
  ['did we pull a permit for 322 N Greenfield Rd', 'permit', '322 N Greenfield Rd', true],
  ['list invoices for Fitzgerald', 'invoice', 'Fitzgerald', false],
  ['show me all the proposals for Mercer', 'proposal-quote', 'Mercer', false],
  ['what proposal did we give Amy Isaacson', 'proposal-quote', 'Amy Isaacson', false],
  ['startup sheet for the Prentiss install', 'startup-sheet', 'Prentiss', false],
  ['Thomas Mercer invoices', 'invoice', 'Thomas Mercer', false],
  // Reviewer NO-GO (2026-09-22): a comma-separated city (and state/zip) after
  // the street must not break the address span.
  ['did we pull a permit for 840 S Ellsworth Rd, Tucson', 'permit', '840 s ellsworth rd, tucson', true],
  ['startup sheet for 322 N Greenfield Rd, Mesa, AZ 85201', 'startup-sheet', '322 n greenfield rd, mesa, arizona 85201', true],
];
for (const [q, doctype, namePhrase, isAddress] of DOC_LOOKUP_POSITIVES) {
  const parsed = parseDocLookupQuestion(q);
  check(`item 1 (positive) :: "${q}" detected`, Boolean(parsed), JSON.stringify(parsed));
  if (parsed) {
    eq(`item 1 (positive) :: "${q}" doctype`, parsed.doctype, doctype);
    eq(`item 1 (positive) :: "${q}" namePhrase`, parsed.namePhrase.toLowerCase(), namePhrase.toLowerCase());
    eq(`item 1 (positive) :: "${q}" isAddress`, parsed.isAddress, isAddress);
  }
}

// Must NOT hijack these — analytics/retrieval own them instead.
const DOC_LOOKUP_NEGATIVES = [
  'how many invoices this year',
  'show me the invoice from March',
  "what's on the Mercer invoice",
  'list invoices for august',
];
for (const q of DOC_LOOKUP_NEGATIVES) {
  eq(`item 1 (negative) :: "${q}" not hijacked`, parseDocLookupQuestion(q), null);
}

/* ======================================================================
 * Item 1: runDocLookup end to end against a mock db.
 * ====================================================================== */
{
  const customerRow = { id: 'c1', customer_number: 'C-1', customer_name: 'Thomas Mercer', service_address: '214 Mercer St' };
  const docRows = [
    { id: 'd1', document_type: 'invoice', original_filename: 'inv-1.pdf', created_at: '2025-08-01', service_date: '2025-08-14' },
    { id: 'd2', document_type: 'invoice', original_filename: 'inv-2.pdf', created_at: '2025-01-01', service_date: '2025-01-05' },
  ];
  const mockDb = {
    // resolveContactCandidates -> a single ILIKE query against entities.
    raw: async (sql) => {
      if (/FROM entities/i.test(sql)) return { rows: [customerRow] };
      if (/FROM documents/i.test(sql)) return { rows: docRows };
      return { rows: [] };
    },
    listCustomerDocumentLinks: async () => [{ document_id: 'd1' }, { document_id: 'd2' }],
    listNameMatchedDocuments: async () => [],
  };
  const answer = await runDocLookup(mockDb, 'Thomas Mercer invoices');
  check('item 1 end-to-end :: names the customer and count', Boolean(answer) && answer.text.includes('2 invoices on file for Thomas Mercer'), answer?.text);
  check('item 1 end-to-end :: facts carry document sources', answer?.facts?.every((f) => f.sources?.[0]?.documentId));
}
{
  // Zero candidates -> honest "couldn't find" answer, not a crash/null.
  const mockDb = { raw: async () => ({ rows: [] }) };
  const answer = await runDocLookup(mockDb, 'list invoices for Nobody Real');
  check('item 1 end-to-end (zero candidates) :: honest fallback', answer?.text === "I couldn't find a customer named Nobody Real.", answer?.text);
}
{
  // Matched customer, but no document of that type on file.
  const customerRow = { id: 'c1', customer_number: 'C-1', customer_name: 'Amy Isaacson', service_address: '10 Main St' };
  const mockDb = {
    raw: async (sql) => (/FROM entities/i.test(sql) ? { rows: [customerRow] } : { rows: [] }),
    listCustomerDocumentLinks: async () => [],
    listNameMatchedDocuments: async () => [],
  };
  const answer = await runDocLookup(mockDb, 'list invoices for Amy Isaacson');
  check('item 1 end-to-end (no docs of type) :: honest zero names the customer', answer?.text === 'No invoice on file for Amy Isaacson.', answer?.text);
}

/* ======================================================================
 * Item 2: last visit / visit history by customer.
 * ====================================================================== */

const VISIT_SHAPE_POSITIVES = [
  ["when were we last at Ellison's", 'lastVisit', 'ellison'],
  ['when did we last service Wyckoff', 'lastVisit', 'wyckoff'],
  ['last time we were at 322 N Greenfield', 'lastVisit', '322 n greenfield'],
  ["how many times have we been to Mercer's", 'visitCount', 'mercer'],
];
for (const [q, field, namePhrase] of VISIT_SHAPE_POSITIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`item 2 (positive) :: "${q}" detected`, Boolean(parsed), JSON.stringify(parsed));
  if (parsed) {
    eq(`item 2 (positive) :: "${q}" field`, parsed.field, field);
    eq(`item 2 (positive) :: "${q}" namePhrase`, parsed.namePhrase.toLowerCase(), namePhrase);
  }
}
// Must not hijack ordinary aggregate/analytics phrasings.
for (const q of ['how many times did we service customers this month', 'when is the next appointment']) {
  eq(`item 2 (negative) :: "${q}" not hijacked`, parseContactLookupQuestion(q), null);
}

{
  const linkRows = [{ document_id: 'd1' }, { document_id: 'd2' }];
  const visitRows = [
    { document_id: 'd1', service_date: '2025-08-14', document_type: 'service-ticket', technician: 'Mike R.' },
    { document_id: 'd2', service_date: '2025-01-05', document_type: 'invoice', technician: null },
  ];
  const mockDb = {
    listCustomerDocumentLinks: async () => linkRows,
    raw: async () => ({ rows: visitRows }),
  };
  const visits = await computeVisitHistory(mockDb, 'c1');
  eq('item 2 computeVisitHistory :: most recent date', visits.mostRecent?.date, '2025-08-14');
  eq('item 2 computeVisitHistory :: count', visits.count, 2);
  const ans = buildVisitAnswer('lastVisit', { customer_name: 'John Ellison' }, visits);
  check('item 2 buildVisitAnswer :: names date, type, tech, count', ans.text === 'Last visit for John Ellison: Aug 14, 2025 (service ticket, tech Mike R.). 2 visits on file.', ans.text);
  const countAns = buildVisitAnswer('visitCount', { customer_name: 'Thomas Mercer' }, visits);
  eq('item 2 buildVisitAnswer (visitCount) :: text', countAns.text, '2 visits to Thomas Mercer on file.');
}
{
  // Honest zero: customer has no service visits on file at all.
  const mockDb = { listCustomerDocumentLinks: async () => [] };
  const visits = await computeVisitHistory(mockDb, 'c1');
  eq('item 2 computeVisitHistory (zero) :: mostRecent null', visits.mostRecent, null);
  const ans = buildVisitAnswer('lastVisit', { customer_name: 'Jane Doe' }, visits);
  eq('item 2 buildVisitAnswer (zero) :: honest fallback', ans.text, 'No service visits on file for Jane Doe.');
  eq('item 2 buildVisitAnswer (zero) :: no facts', ans.facts.length, 0);
}

/* ======================================================================
 * Item 3: contact card completeness — equipment facts on serial/full/bare.
 * ====================================================================== */

for (const [q, namePhrase] of [
  ["what's the serial on the Wyckoff unit", 'wyckoff'],
  ["what's the model on the Bracken unit", 'bracken'],
]) {
  const parsed = parseContactLookupQuestion(q);
  check(`item 3 (positive) :: "${q}" detected`, Boolean(parsed) && parsed.field === 'serial', JSON.stringify(parsed));
  if (parsed) eq(`item 3 (positive) :: "${q}" namePhrase`, parsed.namePhrase.toLowerCase(), namePhrase);
}

{
  const answer = { kind: 'answer', text: 'Sandra Wyckoff on file.', facts: [], sources: [], verifiedCount: 0, unverifiedCount: 0, closest: [], confidence: 1 };
  const equipmentRows = [{ serial_number: 'M100017', manufacturer: 'Trane', model: 'XR16', installation_date: '2019-04-02', warranty: { expires: '2029-04-02' } }];
  const attached = attachEquipmentFacts(answer, equipmentRows);
  check('item 3 attachEquipmentFacts :: appends equipment fact', attached.facts.some((f) => f.value.includes('M100017') && f.value.includes('Trane XR16')), JSON.stringify(attached.facts));
  eq('item 3 attachEquipmentFacts :: verifiedCount bumped', attached.verifiedCount, 1);
}
{
  // No equipment on file -> answer returned unchanged, not a crash.
  const answer = { kind: 'answer', text: 'Sandra Wyckoff on file.', facts: [], sources: [], verifiedCount: 0, unverifiedCount: 0, closest: [], confidence: 1 };
  eq('item 3 attachEquipmentFacts (negative) :: no units -> answer unchanged', attachEquipmentFacts(answer, []), answer);
}
{
  // runContactLookup end to end: a db that doesn't implement
  // listCustomerEquipment must never crash the whole lookup (defensive
  // try/catch — see contactLookup.js's buildResolvedAnswer).
  const rows = [{ id: 'c1', customer_number: 'C-1', customer_name: 'Sandra Wyckoff', service_address: '322 N Greenfield Rd' }];
  const mockDb = { raw: async () => ({ rows }) };
  const answer = await runContactLookup(mockDb, "what's the serial on the Wyckoff unit");
  check('item 3 runContactLookup :: no crash when listCustomerEquipment missing', Boolean(answer) && answer.text.includes('Sandra Wyckoff'), answer?.text);
}

/* ======================================================================
 * Item 8: retrieval honest-zero — known customer/address, nothing to cite.
 * ====================================================================== */
{
  const row = { customer_name: 'Thomas Mercer', service_address: '214 Mercer St' };
  const mockDb = { raw: async () => ({ rows: [row] }) };
  const ctx = await resolveHonestZeroContext(mockDb, 'do we have anything about a compressor replacement for Thomas Mercer');
  check('item 8 resolveHonestZeroContext :: resolves single customer', Boolean(ctx), JSON.stringify(ctx));
  if (ctx) {
    eq('item 8 resolveHonestZeroContext :: name', ctx.name, 'Thomas Mercer');
    const text = buildHonestZeroText(ctx);
    check('item 8 buildHonestZeroText :: names topic + customer + address', text.includes('Thomas Mercer') && text.includes('214 Mercer St') && text.startsWith('Nothing on file about'), text);
  }
}
{
  // Ambiguous (more than one candidate) -> null, caller keeps the generic line.
  const rows = [
    { customer_name: 'Amy Isaacson', service_address: '10 Main St' },
    { customer_name: 'Amy Isaacson', service_address: '20 Main St' },
  ];
  const mockDb = { raw: async () => ({ rows }) };
  const ctx = await resolveHonestZeroContext(mockDb, 'is there anything about a warranty claim for Amy Isaacson');
  eq('item 8 resolveHonestZeroContext (negative) :: ambiguous -> null', ctx, null);
}
{
  // No name/address signal at all -> null.
  const mockDb = { raw: async () => ({ rows: [] }) };
  const ctx = await resolveHonestZeroContext(mockDb, 'what is the warranty policy in general');
  eq('item 8 resolveHonestZeroContext (negative) :: no signal -> null', ctx, null);
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
