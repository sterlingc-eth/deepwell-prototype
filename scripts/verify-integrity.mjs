/**
 * Unit checks for the data-integrity scan/fix rules. No database, no network
 * — everything here is a pure function from api/_lib/integrity.js.
 *
 *   node scripts/verify-integrity.mjs
 */
import {
  normalizeAddressKey, normalizeSurname, customerMatchScore, findDuplicateCustomerPairs,
  isUnlinkedDocument, isEquipmentMissingCustomer, multiUnitUnderLinked,
  unitIndexAssignments, unitIndexBackfillPlan, groupExtractionRowsByUnit,
  csvCell, csvRow, CUSTOMER_MATCH_THRESHOLD, CUSTOMER_SUGGEST_THRESHOLD, coalesceEntityData,
  nameTokenCount, preferFullerName, evaluateCustomerMatch, buildMatchEvidence,
  normalizeUnitKey, normalizeCityKey, normalizeZipKey, normalizePhoneKey, normalizeEmailKey,
} from '../api/_lib/integrity.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const gte = (name, got, min) => check(name, got >= min, `got ${got}, want >= ${min}`);
const lt = (name, got, max) => check(name, got < max, `got ${got}, want < ${max}`);

/* ------------------------------------------------------- normalizeAddressKey */

eq('house number + street name survives', normalizeAddressKey('1519 W Juniper'), '1519 w juniper');
eq('suffix + city/state/zip stripped down to the same key', normalizeAddressKey('1519 W Juniper Ave, Mesa AZ 85202'), '1519 w juniper');
eq('unit/suite dropped for the street-line key', normalizeAddressKey('100 Main St Apt 2'), '100 main');
eq('a second apartment at the same building normalizes the same way', normalizeAddressKey('100 Main St Apt 5'), '100 main');
eq('empty/blank -> empty', normalizeAddressKey(''), '');
eq('null -> empty', normalizeAddressKey(null), '');
check(
  'opposite directions on the same street number are DIFFERENT keys',
  normalizeAddressKey('1519 W Juniper') !== normalizeAddressKey('1519 E Juniper'),
  `"${normalizeAddressKey('1519 W Juniper')}" vs "${normalizeAddressKey('1519 E Juniper')}"`
);

/* ----------------------------------------------------------- normalizeSurname */

eq('"Ray & Linda Castillo" -> castillo', normalizeSurname('Ray & Linda Castillo'), 'castillo');
eq('"Castillo, Ray" (surname-first) -> castillo', normalizeSurname('Castillo, Ray'), 'castillo');
eq('"R. Castillo" (initial dropped) -> castillo', normalizeSurname('R. Castillo'), 'castillo');
eq('"The Castillos" (de-pluralized) -> castillo', normalizeSurname('The Castillos'), 'castillo');
eq('a surname that just ends in s is left alone outside "The X" -> williams', normalizeSurname('John Williams'), 'williams');
eq('empty -> empty', normalizeSurname(''), '');

/* --------------------------------------------------------- customerMatchScore */
// The exact cases named in handoffs/TEAM_BRIEF_2026-09-19.md's owner findings.

gte(
  'Castillo pair: same household, differently worded name + address -> >= 0.95',
  customerMatchScore(
    { name: 'Castillo', address: '1519 W Juniper' },
    { name: 'Ray & Linda Castillo', address: '1519 W Juniper Ave, Mesa AZ 85202' }
  ),
  0.95
);

lt(
  '"1519 W Juniper" vs "1519 E Juniper" (same name) must NOT match',
  customerMatchScore(
    { name: 'Castillo', address: '1519 W Juniper' },
    { name: 'Castillo', address: '1519 E Juniper' }
  ),
  CUSTOMER_MATCH_THRESHOLD
);

gte(
  '"Plaza Dental Group" vs "Plaza Dental" at the same address -> >= 0.9',
  customerMatchScore(
    { name: 'Plaza Dental Group', address: '412 Elm St, Mesa AZ' },
    { name: 'Plaza Dental', address: '412 Elm St, Mesa AZ' }
  ),
  0.9
);

lt(
  'two different families sharing one apartment address (different units) -> < 0.9',
  customerMatchScore(
    { name: 'Nguyen', address: '200 Baseline Rd Apt 3' },
    { name: 'Okafor', address: '200 Baseline Rd Apt 7' }
  ),
  0.9
);

eq('unknown vs unknown (no name, no address either side) -> 0', customerMatchScore({}, {}), 0);

/* ------------------------------------------------------ findDuplicateCustomerPairs */

{
  const customers = [
    { id: 'c3', customerNumber: 'C-00003', name: 'Castillo', address: '1519 W Juniper' },
    { id: 'c4', customerNumber: 'C-00004', name: 'Ray & Linda Castillo', address: '1519 W Juniper Ave, Mesa AZ 85202' },
    { id: 'c5', customerNumber: 'C-00005', name: 'Nguyen', address: '9 Oak Ct' },
  ];
  const pairs = findDuplicateCustomerPairs(customers);
  eq('exactly one duplicate pair found among three customers', pairs.length, 1);
  // Owner request 2026-09-20 follow-up: the fuller name ("Ray & Linda
  // Castillo") wins the keep slot even though its customer_number (C-00004)
  // is higher — chooseSurvivorNumber (reviewStore.js) still puts the lower
  // number C-00003 back onto the survivor at merge time regardless of which
  // id is "keep" here.
  check('keep is the fuller name (c4, "Ray & Linda Castillo") despite the higher customer_number', pairs[0]?.keepId === 'c4', JSON.stringify(pairs[0]));
  check('drop is the surname-only record (c3) despite the lower customer_number', pairs[0]?.dropId === 'c3', JSON.stringify(pairs[0]));

  // Idempotency of fix planning: once the pair is "merged" (the dropped
  // customer removed from the list — what mergeCustomers leaves behind),
  // re-planning against the same tenant finds nothing left to do.
  const afterMerge = customers.filter((c) => c.id !== pairs[0].dropId);
  eq('re-planning after a merge finds no more pairs for it', findDuplicateCustomerPairs(afterMerge).length, 0);
}

/* ---------------------------------------------------- "strict rules" follow-up
 * Owner 2026-09-20: "the AI needs to ensure name, address, email, phone
 * number and all information matches prior to recommending merges."
 * evaluateCustomerMatch is the single entry point behind customerMatchScore
 * AND findDuplicateCustomerPairs' tier/evidence. */

eq('normalizeUnitKey: "Apt 2" -> "2"', normalizeUnitKey('100 Main St Apt 2'), '2');
eq('normalizeUnitKey: "Suite 4B" -> "4b"', normalizeUnitKey('9 Oak Ct Suite 4B'), '4b');
eq('normalizeUnitKey: no unit marker -> empty', normalizeUnitKey('1519 W Juniper'), '');
eq('normalizeCityKey: pulls the city out of the "city state zip" tail', normalizeCityKey('1519 W Juniper Ave, Mesa AZ 85202'), 'mesa');
eq('normalizeCityKey: no comma at all -> empty (not a conflict candidate)', normalizeCityKey('1519 W Juniper'), '');
eq('normalizeZipKey: pulls the 5-digit zip', normalizeZipKey('1519 W Juniper Ave, Mesa AZ 85202'), '85202');
eq('normalizePhoneKey: punctuation-insensitive', normalizePhoneKey('(480) 555-1234'), '4805551234');
eq('normalizeEmailKey: case-insensitive', normalizeEmailKey('Ray@Example.com'), 'ray@example.com');

// --- hard veto: a conflicting identity field always wins, however well the
// rest matches (item 1: "ensure ... all information matches").
{
  const conflict = (label, a, b, field) => {
    const r = evaluateCustomerMatch(a, b);
    check(`${label}: hard veto (score 0)`, r.score === 0, JSON.stringify(r));
    eq(`${label}: reason names the conflicting field`, r.reason, `conflict:${field}`);
    check(`${label}: tier is null (never a duplicate)`, r.tier === null, JSON.stringify(r));
  };

  conflict(
    'same address+surname, different phones',
    { name: 'Ray Castillo', address: '1519 W Juniper', phone: '480-555-1111' },
    { name: 'Ray Castillo', address: '1519 W Juniper', phone: '480-555-2222' },
    'phone'
  );
  conflict(
    'same address+surname, different emails',
    { name: 'Ray Castillo', address: '1519 W Juniper', email: 'ray@example.com' },
    { name: 'Ray Castillo', address: '1519 W Juniper', email: 'ray.castillo@other.com' },
    'email'
  );
  conflict(
    'apartment building, different unit numbers',
    { name: 'Nguyen', address: '200 Baseline Rd Apt 3' },
    { name: 'Nguyen', address: '200 Baseline Rd Apt 7' },
    'unit'
  );

  // A missing value on one side is NOT a conflict — fill-only merge still
  // applies to it.
  const oneSidedPhone = evaluateCustomerMatch(
    { name: 'Ray Castillo', address: '1519 W Juniper', phone: '480-555-1111' },
    { name: 'Ray Castillo', address: '1519 W Juniper' }
  );
  check('phone present on only one side is NOT a conflict', oneSidedPhone.evidence.conflicts.length === 0, JSON.stringify(oneSidedPhone));

  // Suffix/city/state/zip differences on the street line are not a conflict
  // — normalizeAddressKey already collapses them to the same key.
  const suffixOnly = evaluateCustomerMatch(
    { name: 'Ray Castillo', address: '1519 W Juniper' },
    { name: 'Ray Castillo', address: '1519 W Juniper Ave, Mesa AZ 85202' }
  );
  check('"1519 W Juniper" vs "...Ave, Mesa AZ 85202": street equal, no conflict', suffixOnly.evidence.conflicts.length === 0, JSON.stringify(suffixOnly));
}

// --- name relation: surname alone (different first names) must never score
// as high as an equal/subset match, and is suggest-only (item 2).
{
  const diffFirstNames = evaluateCustomerMatch(
    { name: 'John Smith', address: '10 Elm St' },
    { name: 'Jane Smith', address: '10 Elm St' }
  );
  check('different first names, same surname, same address -> score <= 0.6', diffFirstNames.score <= 0.6, JSON.stringify(diffFirstNames));
  check('...and never tier auto', diffFirstNames.tier !== 'auto', JSON.stringify(diffFirstNames));

  const subset = evaluateCustomerMatch({ name: 'Castillo', address: '1519 W Juniper' }, { name: 'Ray & Linda Castillo', address: '1519 W Juniper' });
  check('subset name ("Castillo" ⊂ "Ray & Linda Castillo") scores high', subset.score >= 0.95, JSON.stringify(subset));
}

// --- tiers (item 3): auto ONLY when name + street + no conflicts + phone/email
// confirm (or both sides have neither on file).
{
  const bothNoContact = evaluateCustomerMatch(
    { name: 'Castillo', address: '1519 W Juniper' },
    { name: 'Ray & Linda Castillo', address: '1519 W Juniper' }
  );
  eq('subset name + same street + no contact info anywhere -> tier auto', bothNoContact.tier, 'auto');

  const phoneOnOneSide = evaluateCustomerMatch(
    { name: 'Castillo', address: '1519 W Juniper' },
    { name: 'Ray & Linda Castillo', address: '1519 W Juniper', phone: '480-555-1111' }
  );
  eq('subset name + same street, phone on ONE side only -> tier suggest', phoneOnOneSide.tier, 'suggest');
  check('...evidence lists phone as missing (present on only one side)', phoneOnOneSide.evidence.missing.includes('phone'), JSON.stringify(phoneOnOneSide.evidence));

  const samePhone = evaluateCustomerMatch(
    { name: 'Castillo', address: '1519 W Juniper', phone: '480-555-1111' },
    { name: 'Ray & Linda Castillo', address: '1519 W Juniper', phone: '(480) 555-1111' }
  );
  eq('subset name + same street + matching phone (punctuation aside) -> tier auto', samePhone.tier, 'auto');
  check('...evidence lists phone as a match', samePhone.evidence.matches.includes('phone'), JSON.stringify(samePhone.evidence));

  const surnameOnlyDiffFirst = evaluateCustomerMatch(
    { name: 'John Smith', address: '10 Elm St', phone: '480-555-1111' },
    { name: 'Jane Smith', address: '10 Elm St', phone: '480-555-1111' }
  );
  eq('same surname, different first names, even with matching phone -> never auto (name is not equal/subset)', surnameOnlyDiffFirst.tier, 'suggest');
}

// --- findDuplicateCustomerPairs surfaces suggest-tier pairs too (lower than
// CUSTOMER_MATCH_THRESHOLD, at/above CUSTOMER_SUGGEST_THRESHOLD) so a human
// can still see and decide on them; mergeDuplicates (routes/integrity.js)
// is what actually restricts itself to tier 'auto'.
{
  const pairs = findDuplicateCustomerPairs([
    { id: 's1', customerNumber: 'C-00010', name: 'John Smith', address: '10 Elm St' },
    { id: 's2', customerNumber: 'C-00011', name: 'Jane Smith', address: '10 Elm St' },
  ]);
  eq('a surname-only match still shows up as a suggestion', pairs.length, 1);
  eq('...tagged tier suggest', pairs[0]?.tier, 'suggest');
  check('...with evidence attached', Array.isArray(pairs[0]?.evidence?.matches), JSON.stringify(pairs[0]));
}
{
  // Hard veto: score 0 is below even the default (lowest) suggestion bar,
  // so a vetoed pair never appears at all, at any normal threshold.
  const pairs = findDuplicateCustomerPairs([
    { id: 'p1', name: 'Ray Castillo', address: '1519 W Juniper', phone: '480-555-1111' },
    { id: 'p2', name: 'Ray Castillo', address: '1519 W Juniper', phone: '480-555-2222' },
  ]);
  eq('a phone conflict never becomes a suggestion', pairs.length, 0);
}

check('CUSTOMER_SUGGEST_THRESHOLD stays below CUSTOMER_MATCH_THRESHOLD', CUSTOMER_SUGGEST_THRESHOLD < CUSTOMER_MATCH_THRESHOLD);

// --- buildMatchEvidence directly: a field absent on BOTH sides is not
// mentioned at all (nothing to say about it either way).
eq('buildMatchEvidence: phone absent on both sides is omitted entirely', buildMatchEvidence({ name: 'A' }, { name: 'B' }).missing.includes('phone'), false);
eq('buildMatchEvidence: phone absent on both sides is omitted entirely (conflicts too)', buildMatchEvidence({ name: 'A' }, { name: 'B' }).conflicts.includes('phone'), false);

/* --------------------------------------------------- document/equipment rules */

eq('customer_name present, no link -> unlinked', isUnlinkedDocument({ hasCustomerName: true, hasAddress: false, linkedToCustomer: false }), true);
eq('address present, no link -> unlinked', isUnlinkedDocument({ hasCustomerName: false, hasAddress: true, linkedToCustomer: false }), true);
eq('already linked -> not unlinked', isUnlinkedDocument({ hasCustomerName: true, hasAddress: true, linkedToCustomer: true }), false);
eq('names nobody -> not unlinked (nothing to link)', isUnlinkedDocument({ hasCustomerName: false, hasAddress: false, linkedToCustomer: false }), false);

eq('equipment names a customer but has no customer_id -> flagged', isEquipmentMissingCustomer({ hasCustomerId: false, hasCustomerNameOrAddress: true }), true);
eq('equipment already has a customer_id -> not flagged', isEquipmentMissingCustomer({ hasCustomerId: true, hasCustomerNameOrAddress: true }), false);
eq('equipment names nobody -> not flagged', isEquipmentMissingCustomer({ hasCustomerId: false, hasCustomerNameOrAddress: false }), false);

eq(
  'Plaza Dental: 3 distinct serials, only 1 linked -> under-linked',
  multiUnitUnderLinked({ serialValues: ['sn-1', 'sn-2', 'sn-3'], linkedEquipmentCount: 1 }),
  true
);
eq(
  'same unit count as serial count -> not under-linked',
  multiUnitUnderLinked({ serialValues: ['sn-1', 'sn-2'], linkedEquipmentCount: 2 }),
  false
);
eq(
  'a single-serial document is never "multi-unit" regardless of link count',
  multiUnitUnderLinked({ serialValues: ['sn-1'], linkedEquipmentCount: 0 }),
  false
);
eq(
  'duplicate serial VALUES collapse before comparing (case-insensitive)',
  multiUnitUnderLinked({ serialValues: ['SN-1', 'sn-1'], linkedEquipmentCount: 1 }),
  false
);

/* ------------------------------------------------------- unit_index (M3-19) */

{
  const got = unitIndexAssignments(['SN-1', 'sn-2', 'sn-1', 'SN-2', 'sn-3']);
  eq('distinct serials numbered by first appearance, case-insensitive', got && [...got.entries()], [['sn-1', 1], ['sn-2', 2], ['sn-3', 3]]);
}
eq('a single serial (nothing to number) -> null', unitIndexAssignments(['sn-1', 'sn-1']), null);
eq('no serials -> null', unitIndexAssignments([]), null);

{
  // Plaza Dental shape: 3 units, 3 serials + 3 models, none tagged yet.
  const rows = [
    { id: 'e1', field_key: 'serial_number', value: 'AAA', unit_index: null },
    { id: 'e2', field_key: 'model', value: 'M-1', unit_index: null },
    { id: 'e3', field_key: 'serial_number', value: 'BBB', unit_index: null },
    { id: 'e4', field_key: 'model', value: 'M-2', unit_index: null },
    { id: 'e5', field_key: 'serial_number', value: 'CCC', unit_index: null },
    { id: 'e6', field_key: 'model', value: 'M-3', unit_index: null },
    { id: 'e7', field_key: 'customer_name', value: 'Plaza Dental', unit_index: null },
  ];
  const plan = unitIndexBackfillPlan(rows);
  const byId = Object.fromEntries(plan.map((p) => [p.id, p.unitIndex]));
  eq('backfill plan covers every serial + model row, none other', Object.keys(byId).sort(), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
  eq('serials numbered by appearance', [byId.e1, byId.e3, byId.e5], [1, 2, 3]);
  eq('models paired positionally with their serial', [byId.e2, byId.e4, byId.e6], [1, 2, 3]);

  // Idempotency: applying the plan (simulating the UPDATE) leaves nothing
  // left to backfill on a second pass.
  const applied = rows.map((r) => (byId[r.id] != null ? { ...r, unit_index: byId[r.id] } : r));
  eq('re-planning after applying the first plan finds nothing left to do', unitIndexBackfillPlan(applied), []);
}

eq('a single-serial document has no plan (nothing to number)', unitIndexBackfillPlan([{ id: 'e1', field_key: 'serial_number', value: 'AAA', unit_index: null }]), []);
eq('already-tagged rows are left alone (no plan)', unitIndexBackfillPlan([
  { id: 'e1', field_key: 'serial_number', value: 'AAA', unit_index: 1 },
  { id: 'e2', field_key: 'serial_number', value: 'BBB', unit_index: 2 },
]), []);
{
  // Model count doesn't line up 1:1 with serials -> left untagged rather
  // than guessing which unit a model belongs to.
  const plan = unitIndexBackfillPlan([
    { id: 'e1', field_key: 'serial_number', value: 'AAA', unit_index: null },
    { id: 'e2', field_key: 'serial_number', value: 'BBB', unit_index: null },
    { id: 'e3', field_key: 'model', value: 'M-1', unit_index: null }, // only one model for two units
  ]);
  eq('mismatched field count is excluded from the plan', plan.map((p) => p.id).sort(), ['e1', 'e2']);
}

{
  // groupExtractionRowsByUnit: unit_index already on file -> exact grouping.
  const tagged = [
    { field_key: 'serial_number', value: 'AAA', unit_index: 1 },
    { field_key: 'model', value: 'M-1', unit_index: 1 },
    { field_key: 'serial_number', value: 'BBB', unit_index: 2 },
    { field_key: 'model', value: 'M-2', unit_index: 2 },
    { field_key: 'customer_name', value: 'Plaza Dental', unit_index: null },
  ];
  const groups = groupExtractionRowsByUnit(tagged);
  eq('two units grouped by their tagged unit_index', groups.map((g) => g.facts.serial_number), ['AAA', 'BBB']);
  eq('per-unit model stays with its own unit', groups.map((g) => g.facts.model), ['M-1', 'M-2']);
}
{
  // groupExtractionRowsByUnit: legacy rows, no unit_index anywhere -> falls
  // back to the same appearance-order + positional-pairing rule.
  const legacy = [
    { field_key: 'serial_number', value: 'AAA', unit_index: null },
    { field_key: 'model', value: 'M-1', unit_index: null },
    { field_key: 'serial_number', value: 'BBB', unit_index: null },
    { field_key: 'model', value: 'M-2', unit_index: null },
  ];
  const groups = groupExtractionRowsByUnit(legacy);
  eq('legacy fallback still finds both units', groups.map((g) => g.facts.serial_number), ['AAA', 'BBB']);
}
eq('a document naming no serial groups into nothing', groupExtractionRowsByUnit([{ field_key: 'customer_name', value: 'Plaza Dental', unit_index: null }]), []);

/* ------------------------------------------------------- coalesceEntityData */

eq(
  'both sides have a value -> survivor keeps its own',
  coalesceEntityData({ phone: '480-111-1111' }, { phone: '480-222-2222' }).phone,
  '480-111-1111'
);
eq(
  'only the dropped side has a value -> it is taken',
  coalesceEntityData({ phone: '' }, { phone: '480-222-2222' }).phone,
  '480-222-2222'
);
eq(
  'missing key entirely on keep -> filled from drop',
  coalesceEntityData({}, { email: 'a@b.com' }).email,
  'a@b.com'
);
eq(
  'notes on both sides are concatenated, not fill-or-keep',
  coalesceEntityData({ notes: 'Gate code 1234' }, { notes: 'Dog in yard' }).notes,
  'Gate code 1234\nDog in yard'
);
eq(
  'notes only on drop -> taken as-is (no leading blank line)',
  coalesceEntityData({}, { notes: 'Dog in yard' }).notes,
  'Dog in yard'
);
eq(
  'identical notes on both sides are not duplicated',
  coalesceEntityData({ notes: 'same' }, { notes: 'same' }).notes,
  'same'
);
eq(
  'aliases/former_numbers are unioned, not overwritten',
  coalesceEntityData({ aliases: ['A'] }, { aliases: ['B', 'A'] }).aliases,
  ['A', 'B']
);
eq(
  'former_numbers accumulate across merges',
  coalesceEntityData({ former_numbers: ['C-00002'] }, { former_numbers: ['C-00005'] }).former_numbers,
  ['C-00002', 'C-00005']
);
eq(
  'differing customer_name on drop is preserved as an alias, not overwritten',
  coalesceEntityData({ customer_name: 'Plaza Dental' }, { customer_name: 'Plaza Dental Group' }),
  { customer_name: 'Plaza Dental', aliases: ['Plaza Dental Group'] }
);
eq(
  'no customer_name on keep -> drop\'s name is taken directly (no alias)',
  coalesceEntityData({}, { customer_name: 'Plaza Dental' }).customer_name,
  'Plaza Dental'
);
eq(
  'every value present on both, none blank -> nothing from drop leaks in',
  coalesceEntityData({ phone: 'keep-phone' }, { phone: 'drop-phone', fax: 'drop-fax' }),
  { phone: 'keep-phone', fax: 'drop-fax' }
);
eq('null keep and null drop -> empty object, never throws', coalesceEntityData(null, null), {});

/* --------------------------------------------------------- preferFullerName
 * Owner request 2026-09-20 follow-up: keep "Ray & Linda Castillo", not just
 * "Castillo". */

eq('nameTokenCount: counts people, "&" is a separator, not a token', nameTokenCount('Ray & Linda Castillo'), 3);
eq('nameTokenCount: surname alone is one token', nameTokenCount('Castillo'), 1);

eq('both-names beats surname-only (same family)', preferFullerName('Castillo', 'Ray & Linda Castillo'), 'Ray & Linda Castillo');
eq('surname-only offered as drop does not replace an already-fuller keep', preferFullerName('Ray & Linda Castillo', 'Castillo'), 'Ray & Linda Castillo');
eq('equally-full names are left as keep, not reordered', preferFullerName('Castillo, Ray', 'Ray Castillo'), 'Castillo, Ray');
eq('identical names -> keep, trivially', preferFullerName('Ray Castillo', 'Ray Castillo'), 'Ray Castillo');
eq('company names untouched — different "surname" (last word), not a subset', preferFullerName('Plaza Dental', 'Plaza Dental Group'), 'Plaza Dental');
eq('blank keep takes drop outright', preferFullerName('', 'Castillo'), 'Castillo');
eq('blank drop leaves keep alone', preferFullerName('Castillo', ''), 'Castillo');

eq(
  'coalesceEntityData adopts the fuller name from drop and aliases the shorter keep name',
  coalesceEntityData({ customer_name: 'Castillo' }, { customer_name: 'Ray & Linda Castillo' }),
  { customer_name: 'Ray & Linda Castillo', aliases: ['Castillo'] }
);
eq(
  'coalesceEntityData keeps an already-fuller keep name, aliasing the surname-only drop',
  coalesceEntityData({ customer_name: 'Ray & Linda Castillo' }, { customer_name: 'Castillo' }),
  { customer_name: 'Ray & Linda Castillo', aliases: ['Castillo'] }
);

/* ------------------------------- findDuplicateCustomerPairs keep/drop order
 * Nightly auto-merge and "Fix everything" run with no human in the loop, so
 * keep/drop must default to the same fuller-name rule the Customers-tab
 * chooser uses, not just customer_number order. */
{
  const fuller = { id: 'full', name: 'Ray & Linda Castillo', address: '1519 W Juniper', customerNumber: 'C-00004' };
  const surnameOnly = { id: 'surname', name: 'Castillo', address: '1519 W Juniper', customerNumber: 'C-00003' };
  const [pair] = findDuplicateCustomerPairs([fuller, surnameOnly]);
  check(
    'findDuplicateCustomerPairs: fuller name wins keepId even with the HIGHER customer_number',
    pair && pair.keepId === 'full' && pair.dropId === 'surname',
    JSON.stringify(pair)
  );
}
{
  // Same name fullness on both sides -> falls back to the lower customer_number,
  // same as before this change.
  const lower = { id: 'lower', name: 'Ray Castillo', address: '1519 W Juniper', customerNumber: 'C-00002' };
  const higher = { id: 'higher', name: 'Ray Castillo', address: '1519 W Juniper', customerNumber: 'C-00009' };
  const [pair] = findDuplicateCustomerPairs([higher, lower]);
  check(
    'findDuplicateCustomerPairs: equal name fullness falls back to the lower customer_number',
    pair && pair.keepId === 'lower' && pair.dropId === 'higher',
    JSON.stringify(pair)
  );
}

/* --------------------------------------------------------------------- csv */

eq('plain value passes through unquoted', csvCell('Plaza Dental'), 'Plaza Dental');
eq('a comma forces quoting', csvCell('Mesa, AZ'), '"Mesa, AZ"');
eq('an embedded quote doubles and the cell quotes', csvCell('12" duct'), '"12"" duct"');
eq('a newline forces quoting', csvCell('line1\nline2'), '"line1\nline2"');
eq('null/undefined -> empty string, not "null"', csvCell(null), '');
eq('undefined -> empty string', csvCell(undefined), '');
eq('a number is stringified plainly', csvCell(412.5), '412.5');
eq(
  'csvRow joins cells with commas and ends CRLF',
  csvRow(['a', 'b, c', null, 3]),
  'a,"b, c",,3\r\n'
);

/* ------------------------------------------- csvCell formula-injection guard */

eq('leading = gets a quote prefix (formula injection)', csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
eq('leading + gets a quote prefix', csvCell('+1-555-0100'), "'+1-555-0100");
eq('leading - gets a quote prefix', csvCell('-cmd|calc'), "'-cmd|calc");
eq('leading @ gets a quote prefix', csvCell('@SUM'), "'@SUM");
eq('leading tab gets a quote prefix', csvCell('\tvalue'), "'\tvalue");
// \r also triggers the pre-existing newline-quoting rule, so this cell is
// both prefixed AND wrapped in quotes.
eq('leading CR gets a quote prefix (and quoting, since \\r is also a newline)', csvCell('\rvalue'), '"\'\rvalue"');
eq('dangerous prefix past leading spaces is still caught', csvCell('  =evil()'), "'  =evil()");
// Accepted tradeoff: a genuine negative number also gets the safety prefix —
// there is no way to tell "-42.50 the value" from "-42.50 the formula" from
// the string alone, and losing a cosmetic leading quote is cheaper than one
// live formula in an exported sheet.
eq('a real negative number also gets quoted (accepted safety tradeoff)', csvCell(-42.5), "'-42.5");
eq('a dangerous leading char plus a comma still quotes AND prefixes', csvCell('=A,B'), '"\'=A,B"');

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
