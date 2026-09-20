/**
 * Pure decision-table tests for the customer/equipment LINKING layer — the
 * root-cause fix behind handoffs/LINKING_ROOT_CAUSE_2026-09-20.md ("Margaret
 * Henderson" defect: a document with customer_name/service_address at high
 * confidence, equipment linked, customer not). No database, no network.
 *
 * Run via tsx (not plain node) because the parity section below imports both
 * the server (api/_lib/*.js) and client (src/**\/*.ts) sides of the same
 * rules — same technique scripts/verify-ui.ts already uses.
 *
 *   npx tsx scripts/verify-linking.mjs
 */
import {
  isUnlinkedDocument, addressOnlyCustomerName, isAddressOnlyCustomer, normalizeAddressKey,
  isLikelyShopAddress,
} from '../api/_lib/integrity.js';
import { completenessFor as serverCompletenessFor, REQUIRED_FIELDS } from '../api/_lib/documentTypes.js';
import { completenessFor as clientCompletenessFor } from '../src/domains/hvac/documentTypes';
import { recomputeIssues } from '../src/core/entityGraph';
import { hvacSchema } from '../src/domains/hvac/schema';
import { isAttention } from '../src/screens/ReviewScreen';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------------------
 * Decision table: document type x {customer_name, service_address, serial,
 * model} -> which links a correctly-behaving pipeline creates. This is the
 * table handoffs/LINKING_ROOT_CAUSE_2026-09-20.md documents; each row here is
 * one of its columns, asserted against the real pure functions rather than
 * just written down as prose.
 *
 *   field()  -> a completenessFor-shaped extracted field, confidence 0.99
 *   FIXTURES -> ten documents covering: complete-but-customer-unlinked
 *   (Henderson's exact case), a genuinely missing required field, address-
 *   only (no name at all), fully linked, and "names nobody" (no customer
 *   info to link at all — should say so plainly, never a false "needs a
 *   person for the customer").
 * ------------------------------------------------------------------------ */
const field = (field_key, value) => ({ field_key, value, confidence: 0.99 });

const FIXTURES = [
  {
    name: 'Henderson case: warranty-registration, complete, equipment linked, customer NOT linked',
    typeId: 'warranty-registration',
    fields: [field('serial_number', '4N2119-08772'), field('model', 'FV4CNF002'), field('warranty_term', '10 years'),
      field('customer_name', 'Margaret Henderson'), field('service_address', '3247 Elm St, Mesa, AZ 85204')],
    linkedEntityIds: ['equip-1'], // equipment only — no direct customer link
    hasCustomerName: true, hasAddress: true, linkedToCustomer: false,
    expectComplete: true, expectMissing: [], expectUnlinked: true, expectAttention: false,
  },
  {
    name: 'warranty-registration missing model: a real gap, not a link bug',
    typeId: 'warranty-registration',
    fields: [field('serial_number', 'ABC123'), field('warranty_term', '10 years'),
      field('customer_name', 'Jo Park'), field('service_address', '10 Oak Ave')],
    linkedEntityIds: ['equip-2'],
    hasCustomerName: true, hasAddress: true, linkedToCustomer: false,
    expectComplete: false, expectMissing: ['model'], expectUnlinked: true, expectAttention: true,
  },
  {
    name: 'dispatch-note: names a customer, no link at all yet',
    typeId: 'dispatch-note',
    fields: [field('customer_name', 'R. Diaz'), field('service_date', '2026-09-18')],
    linkedEntityIds: [],
    hasCustomerName: true, hasAddress: false, linkedToCustomer: false,
    expectComplete: true, expectMissing: [], expectUnlinked: true, expectAttention: true,
  },
  {
    name: 'permit: address-only, no customer_name at all',
    typeId: 'permit',
    fields: [field('service_address', '55 Cactus Rd'), field('permit_number', 'PMT-9')],
    linkedEntityIds: [],
    hasCustomerName: false, hasAddress: true, linkedToCustomer: false,
    expectComplete: true, expectMissing: [], expectUnlinked: true, expectAttention: true,
  },
  {
    name: 'correspondence: name only, no address',
    typeId: 'correspondence',
    fields: [field('customer_name', 'T. Nguyen')],
    linkedEntityIds: ['cust-3'],
    hasCustomerName: true, hasAddress: false, linkedToCustomer: true,
    expectComplete: true, expectMissing: [], expectUnlinked: false, expectAttention: false,
  },
  {
    name: 'equipment-record: names nobody — correctly not a link bug',
    typeId: 'equipment-record',
    fields: [field('serial_number', 'XYZ999'), field('model', 'RTU-5')],
    linkedEntityIds: ['equip-4'],
    hasCustomerName: false, hasAddress: false, linkedToCustomer: false,
    expectComplete: true, expectMissing: [], expectUnlinked: false, expectAttention: false,
  },
  {
    name: 'maintenance-agreement missing customer_name: a real gap',
    typeId: 'maintenance-agreement',
    fields: [field('service_address', '9 Palm Ct'), field('warranty_term', '1 year')],
    linkedEntityIds: [],
    hasCustomerName: false, hasAddress: true, linkedToCustomer: false,
    expectComplete: false, expectMissing: ['customer_name'], expectUnlinked: true, expectAttention: true,
  },
  {
    name: 'work-order: fully linked directly to customer — the baseline good case',
    typeId: 'work-order',
    fields: [field('service_address', '1 Main St'), field('service_date', '2026-09-01'), field('technician', 'A. Lee')],
    linkedEntityIds: ['cust-8'],
    hasCustomerName: false, hasAddress: true, linkedToCustomer: true,
    expectComplete: true, expectMissing: [], expectUnlinked: false, expectAttention: false,
  },
  {
    name: 'startup-sheet: no owner info at all, equipment linked — nothing to fix',
    typeId: 'startup-sheet',
    fields: [field('serial_number', 'SN-1'), field('service_date', '2026-08-01')],
    linkedEntityIds: ['equip-9'],
    hasCustomerName: false, hasAddress: false, linkedToCustomer: false,
    expectComplete: true, expectMissing: [], expectUnlinked: false, expectAttention: false,
  },
  {
    name: 'invoice: address-only, not yet linked to anything',
    typeId: 'invoice',
    fields: [field('service_address', '77 Birch Ln'), field('cost', '450.00')],
    linkedEntityIds: [],
    hasCustomerName: false, hasAddress: true, linkedToCustomer: false,
    expectComplete: true, expectMissing: [], expectUnlinked: true, expectAttention: true,
  },
];

for (const fx of FIXTURES) {
  const serverC = serverCompletenessFor(fx.typeId, fx.fields);
  const clientC = clientCompletenessFor(fx.typeId, fx.fields);
  eq(`${fx.name} — server completeness`, { complete: serverC.complete, missing: serverC.missing }, { complete: fx.expectComplete, missing: fx.expectMissing });
  eq(`${fx.name} — server/client completeness PARITY`, serverC, clientC);

  const unlinked = isUnlinkedDocument({ hasCustomerName: fx.hasCustomerName, hasAddress: fx.hasAddress, linkedToCustomer: fx.linkedToCustomer });
  eq(`${fx.name} — isUnlinkedDocument (should auto-repair a customer link)`, unlinked, fx.expectUnlinked);

  // Predicate parity: server "should this document have been auto-linked"
  // vs. the client "Needs a person" queue. They answer different questions
  // (isUnlinkedDocument is a link-repair signal; isAttention is a human-task
  // signal) and MUST be allowed to disagree — the point of this fixture set
  // is that a document only wrongly sits in "Needs a person" when it has a
  // genuine gap (a missing required field, or truly no link at all), never
  // merely because its direct customer link hasn't been repaired yet.
  const doc = {
    id: 'd', filename: 'f', fileType: 'pdf', pages: 1, batchId: 'b', source: 'drive',
    receivedAt: new Date(), typeId: fx.typeId, stage: 'linked',
    extracted: fx.fields.map((f) => ({ name: f.field_key, value: f.value, confidence: f.confidence, location: {} })),
    linkedEntityIds: fx.linkedEntityIds, linkConfidence: fx.linkedEntityIds.length ? 1 : 0,
    issues: [], preview: '',
  };
  const withIssues = recomputeIssues(doc, hvacSchema);
  eq(`${fx.name} — isAttention ("Needs a person")`, isAttention(withIssues), fx.expectAttention);
}

/* ------------------------------------------------------------------------
 * Address-only customer creation naming (owner root-cause fix, item 1):
 * findOrCreateCustomer creates "Customer at <address>" flagged
 * data.name_source='address' when a document names an address but no
 * customer — asserted here as the pure naming/flagging rule; the DB
 * match-or-create itself is exercised in recordsStore.js and cannot run
 * without Postgres.
 * ------------------------------------------------------------------------ */
eq('addressOnlyCustomerName formats the placeholder', addressOnlyCustomerName('3247 Elm St, Mesa, AZ 85204'), 'Customer at 3247 Elm St, Mesa, AZ 85204');
eq('addressOnlyCustomerName degrades for a blank address', addressOnlyCustomerName(''), 'Customer (address unknown)');
eq('isAddressOnlyCustomer flags a placeholder', isAddressOnlyCustomer({ name_source: 'address', customer_name: 'Customer at 3247 Elm St' }), true);
eq('isAddressOnlyCustomer is false for a real customer', isAddressOnlyCustomer({ customer_name: 'Margaret Henderson' }), false);
eq('isAddressOnlyCustomer is false for no data', isAddressOnlyCustomer(null), false);

/* ------------------------------------------------------------------------
 * Upgrade-by-fuller-name path: the address key a later document with the
 * real name must match against a placeholder created earlier — this is the
 * exact lookup recordsStore.js's findOrCreateCustomer runs before creating a
 * brand-new customer, so a real name never creates a duplicate next to its
 * own placeholder.
 * ------------------------------------------------------------------------ */
eq('same address, different punctuation/case -> same key (upgrade would find it)',
  normalizeAddressKey('3247 Elm St, Mesa, AZ 85204') === normalizeAddressKey('3247 elm street'), true);
eq('a genuinely different address -> different key (no false upgrade)',
  normalizeAddressKey('3247 Elm St') === normalizeAddressKey('99 Oak Ave'), false);

/* ------------------------------------------------------------------------
 * REQUIRED_FIELDS sanity: every type the decision table exercises is a real
 * canonical type (catches a typo in the fixtures above before it ever
 * reaches completenessFor and silently passes with an empty required list).
 * ------------------------------------------------------------------------ */
for (const fx of FIXTURES) {
  check(`${fx.typeId} is a canonical type with a REQUIRED_FIELDS entry`, fx.typeId in REQUIRED_FIELDS);
}

/* ------------------------------------------------------------------------
 * Shop-address guard (reviewer follow-up, 2026-09-20): the address-only
 * customer-creation path must never turn the contractor's OWN letterhead
 * address into a "customer". isLikelyShopAddress is pure — no DB — so this
 * exercises the exact decision recordsStore.js's computeShopAddressContext
 * feeds it, per the reviewer's own two examples.
 * ------------------------------------------------------------------------ */
const desertPeakKey = normalizeAddressKey('2210 E Main St, Mesa, AZ 85213');
const realCustomerKey = normalizeAddressKey('88 Saguaro Way, Mesa, AZ 85201');

eq('Desert Peak letterhead on 5 docs / 3 distinct customer names -> shop address',
  isLikelyShopAddress(desertPeakKey, {
    tenantAddressKey: null,
    letterheadCounts: { [desertPeakKey]: { shopAddressDocs: 0, serviceAddressDocs: 5, distinctCustomerNames: 3 } },
  }),
  true);

eq('a real customer address on 5 docs / 1 name -> NOT a shop address',
  isLikelyShopAddress(realCustomerKey, {
    tenantAddressKey: null,
    letterheadCounts: { [realCustomerKey]: { shopAddressDocs: 0, serviceAddressDocs: 5, distinctCustomerNames: 1 } },
  }),
  false);

eq('any address the model tagged shop_address even once -> shop address',
  isLikelyShopAddress(desertPeakKey, {
    tenantAddressKey: null,
    letterheadCounts: { [desertPeakKey]: { shopAddressDocs: 1, serviceAddressDocs: 0, distinctCustomerNames: 0 } },
  }),
  true);

eq('address matching the tenant\'s own address on file -> shop address, even with no letterhead history',
  isLikelyShopAddress(desertPeakKey, { tenantAddressKey: desertPeakKey, letterheadCounts: {} }),
  true);

eq('below both floors (2 docs, 2 names) -> not a shop address',
  isLikelyShopAddress(realCustomerKey, {
    tenantAddressKey: null,
    letterheadCounts: { [realCustomerKey]: { shopAddressDocs: 0, serviceAddressDocs: 2, distinctCustomerNames: 2 } },
  }),
  false);

eq('unknown address key (no data at all) -> not a shop address',
  isLikelyShopAddress(normalizeAddressKey('1 Nowhere Ln'), { tenantAddressKey: null, letterheadCounts: {} }),
  false);

eq('empty address key -> never a shop address',
  isLikelyShopAddress('', { tenantAddressKey: null, letterheadCounts: {} }),
  false);

console.log(`\n${failures === 0 ? 'All linking checks passed.' : `${failures} linking check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
