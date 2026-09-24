/**
 * Unit checks for the 100-question persona sample's doc-lookup cluster
 * (2026-09-22): items 1, 2, 3 and 8, plus the two remaining live-sample
 * clusters fixed after the Tier 3 deploy (2026-09-22b): address resolution
 * (item 9) and named-unit attribute questions (item 10). Pure shape-detection
 * tests need no database; the DB-touching orchestration functions
 * (runDocLookup, computeVisitHistory, resolveHonestZeroContext,
 * resolveAddressCandidates, runContactLookup) are exercised against small
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
  resolveAddressCandidates,
  buildUnitAttributeAnswer,
  buildReminderAnswer,
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
      // Team A: document ids now come from one raw query over links (both direct and via units).
      if (/document_entity_links/i.test(sql) && !/FROM documents/i.test(sql)) return { rows: docRows.map((d) => ({ document_id: d.id })) };
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
  eq('item 2 buildVisitAnswer (visitCount) :: text', countAns.text, '2 visits to Thomas Mercer on file, the latest on August 14, 2025.');
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

/* ======================================================================
 * Item 9 (post-Tier-3-deploy live 100-question sample, 2026-09-22): address
 * resolution — house number + street's first significant token, tolerant of
 * trailing city/state/zip, "Apt N", punctuation, and street-suffix
 * abbreviations. Reviewer NO-GO: this used to be a whole-string ILIKE (via
 * resolveStreetCandidates), which broke on exactly this cluster — see
 * resolveAddressCandidates' own doc comment in contactLookup.js.
 * ====================================================================== */

/** A real SQL LIKE/ILIKE pattern -> an equivalent JS RegExp, matched against
 *  the WHOLE string (LIKE always implicitly anchors both ends; `%` is "any
 *  run of characters", `_` is "any one character", a backslash escapes the
 *  next character literally — Postgres's own default LIKE escape). Used to
 *  actually exercise resolveAddressCandidates' anchoring behavior (a
 *  no-leading-`%` house-number pattern must NOT match a longer number that
 *  merely starts the same way), not just a loose substring stand-in. */
function likeToRegExp(pattern) {
  let out = '^';
  const s = String(pattern);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      out += s[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '%') {
      out += '.*';
    } else if (c === '_') {
      out += '.';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$', 'is');
}

/** A tiny in-process ILIKE ALL simulator: `addresses` is every customer's
 *  stored service_address; returns the rows resolveAddressCandidates' own
 *  query would, given the (never string-concatenated) pattern array it
 *  builds. Exercises the real SQL shape, not just a canned mock return. */
function mockAddressDb(addresses) {
  return {
    raw: async (sql, params) => {
      check('item 9 :: query is tenant-scoped', /tenant_id = \(current_setting/.test(sql));
      check('item 9 :: query is parameterized (patterns via $1, never concatenated)', /ILIKE ALL\(\$1::text\[\]\)/.test(sql));
      check('item 9 :: query caps at LIMIT 5', /LIMIT 5\b/.test(sql));
      const patterns = (params?.[0] ?? []).map(likeToRegExp);
      const rows = addresses
        .map((a, i) => ({ id: `c${i}`, customer_number: `C-${i}`, customer_name: `Customer ${i}`, service_address: a }))
        .filter((r) => patterns.every((re) => re.test(r.service_address)));
      return { rows };
    },
  };
}

const ADDRESS_RESOLUTION_POSITIVES = [
  // Exact stored address, with trailing city/state/zip — the literal live
  // miss: "I couldn't find a customer at 322 N Greenfield Rd..." even though
  // this exact customer exists.
  ['322 N Greenfield Rd, Mesa, AZ 85201', '322 N Greenfield Rd, Mesa, AZ 85201'],
  // normalizeQuestion expands "AZ" -> "Arizona" upstream (docLookup.js's own
  // SHAPES capture runs the NORMALIZED text) — must still resolve against a
  // stored address that only ever says "AZ".
  ['840 S Ellsworth Rd, Tucson, Arizona 85701', '840 S Ellsworth Rd, Tucson, AZ 85701'],
  // Street-suffix abbreviation mismatch (Rd vs Road) must not block a match.
  ['174 N College Rd', '174 N College Road'],
  // A trailing "Apt 101" (or any unit number) must never be REQUIRED to
  // match — the stored address here has no unit at all.
  ['322 N Greenfield Rd, Apt 101, Mesa, AZ 85201', '322 N Greenfield Rd, Mesa, AZ 85201'],
  // Stray punctuation (a period after the abbreviated suffix) tolerated.
  ['840 S Ellsworth Rd., Tucson', '840 S Ellsworth Rd, Tucson, AZ 85701'],
];
for (const [queryAddress, storedAddress] of ADDRESS_RESOLUTION_POSITIVES) {
  const rows = await resolveAddressCandidates(mockAddressDb([storedAddress]), queryAddress);
  check(`item 9 (positive) :: "${queryAddress}" resolves against stored "${storedAddress}"`, rows.length === 1 && rows[0].service_address === storedAddress, JSON.stringify(rows));
}

// Negatives: must not resolve to the WRONG customer, and must not treat "no
// tokens at all" as "match everything".
{
  const rows = await resolveAddressCandidates(mockAddressDb(['840 S Ellsworth Rd, Tucson, AZ 85701']), '322 N Greenfield Rd, Mesa, AZ 85201');
  eq('item 9 (negative) :: different house number+street -> no match', rows.length, 0);
}
{
  // Same house number, different street — the street token still has to agree.
  const rows = await resolveAddressCandidates(mockAddressDb(['322 N Main St, Mesa, AZ 85201']), '322 N Greenfield Rd, Mesa, AZ 85201');
  eq('item 9 (negative) :: same house number, different street -> no match', rows.length, 0);
}
{
  // Reviewer NO-GO (2026-09-22): a house-number pattern must be anchored to
  // the START of the stored address, not a bare substring — "1 Main St"
  // must never match a stored "100 E Main St" just because "1" appears
  // inside "100".
  const rows = await resolveAddressCandidates(mockAddressDb(['100 E Main St']), '1 Main St');
  eq('item 9 (negative) :: "1 Main St" does not match "100 E Main St"', rows.length, 0);
}
{
  // Same anchoring requirement the other direction: "100 E Main St" must
  // never match a stored "1100 E Main St".
  const rows = await resolveAddressCandidates(mockAddressDb(['1100 E Main St']), '100 E Main St');
  eq('item 9 (negative) :: "100 E Main St" does not match "1100 E Main St"', rows.length, 0);
}
{
  // Empty/garbage input -> empty candidates, never a "match everything" scan.
  const mockDb = { raw: async () => { throw new Error('must never query with zero tokens'); } };
  eq('item 9 (negative) :: no usable tokens -> empty, no query issued', await resolveAddressCandidates(mockDb, ''), []);
}

{
  // End to end: runDocLookup against the exact reported live-miss phrasing.
  const storedAddress = '322 N Greenfield Rd, Mesa, AZ 85201';
  const customerRow = { id: 'c1', customer_number: 'C-1', customer_name: 'Sandra Wyckoff', service_address: storedAddress };
  const mockDb = {
    raw: async (sql, params) => {
      if (/FROM entities/i.test(sql)) {
        const patterns = (params?.[0] ?? []).map(likeToRegExp);
        return { rows: patterns.every((re) => re.test(storedAddress)) ? [{ ...customerRow, entity_type: 'customer' }] : [] };
      }
      return { rows: [] };
    },
    listCustomerDocumentLinks: async () => [],
    listNameMatchedDocuments: async () => [],
  };
  const answer = await runDocLookup(mockDb, 'did we pull a permit for 322 N Greenfield Rd, Mesa, AZ 85201');
  check('item 9 end-to-end :: no longer "I couldn\'t find a customer"', Boolean(answer) && !answer.text.startsWith("I couldn't find"), answer?.text);
  check('item 9 end-to-end :: names the resolved customer', Boolean(answer) && answer.text.includes('Sandra Wyckoff'), answer?.text);
}

/* ======================================================================
 * Item 10 (post-Tier-3-deploy live 100-question sample, 2026-09-22):
 * named-unit attribute questions — "Is the Salazar unit still under
 * warranty?" / "what's the serial on the Wyckoff unit" / "what model is the
 * Prentiss system" / "how old is the Bracken unit" routed deterministically
 * through contactLookup.js's equipment path instead of falling through to
 * retrieval's "Nothing in your records answers that."
 * ====================================================================== */

const NAMED_UNIT_POSITIVES = [
  ['Is the Salazar unit still under warranty?', 'unitWarranty', 'salazar'],
  ['Is the Chavez unit under warranty', 'unitWarranty', 'chavez'],
  ["what's the serial on the Wyckoff unit", 'serial', 'wyckoff'], // pre-existing shape 3b still wins
  ['what model is the Prentiss system', 'unitModel', 'prentiss'],
  ['how old is the Bracken unit', 'unitAge', 'bracken'],
];
for (const [q, field, namePhrase] of NAMED_UNIT_POSITIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`item 10 (positive) :: "${q}" detected`, Boolean(parsed), JSON.stringify(parsed));
  if (parsed) {
    eq(`item 10 (positive) :: "${q}" field`, parsed.field, field);
    eq(`item 10 (positive) :: "${q}" namePhrase`, parsed.namePhrase.toLowerCase(), namePhrase);
  }
}

// Must NOT hijack an address form or an analytics question.
const NAMED_UNIT_NEGATIVES = [
  'the unit at 123 Main St is still under warranty',
  'how many units are under warranty',
  'which units have expired warranties',
  // Reviewer NO-GO (2026-09-22): a brand or a generic descriptor is never a
  // customer's name — must defer to the existing brand/equipment path or
  // retrieval instead of guessing (and never fuzzy-match some unrelated
  // customer's surname).
  'is the Trane unit under warranty',
  'is the new unit under warranty',
];
for (const q of NAMED_UNIT_NEGATIVES) {
  const parsed = parseContactLookupQuestion(q);
  const hijacked = Boolean(parsed?.field) && parsed.field.startsWith('unit');
  check(`item 10 (negative) :: "${q}" not hijacked as a named-unit question`, !hijacked, JSON.stringify(parsed));
}

{
  // buildUnitAttributeAnswer: warranty, expired.
  const row = { customer_name: 'Maria Salazar' };
  const units = [{ manufacturer: 'Trane', model: '4TTR6', serial_number: 'M900123', installation_date: '2009-01-15', warranty: { expires: '2019-01-01' } }];
  const ans = buildUnitAttributeAnswer('warranty', 'Salazar', row, units, '2026-09-22');
  check('item 10 buildUnitAttributeAnswer :: expired warranty', ans.text.includes('warranty expired') && ans.text.includes('Salazar'), ans.text);
}
{
  // buildUnitAttributeAnswer: warranty, active.
  const units = [{ manufacturer: 'Carrier', model: '24ABC6', warranty: { expires: '2030-01-01' } }];
  const ans = buildUnitAttributeAnswer('warranty', 'Chavez', { customer_name: 'Brian Chavez' }, units, '2026-09-22');
  check('item 10 buildUnitAttributeAnswer :: active warranty', ans.text.includes('under warranty until'), ans.text);
}
{
  // buildUnitAttributeAnswer: no warranty date on file -> honest, never a guess.
  const units = [{ manufacturer: 'Lennox', model: 'XC16' }];
  const ans = buildUnitAttributeAnswer('warranty', 'Prentiss', { customer_name: 'Jane Prentiss' }, units, '2026-09-22');
  check('item 10 buildUnitAttributeAnswer :: no warranty date on file', ans.text.includes('no warranty date on file'), ans.text);
}
{
  // buildUnitAttributeAnswer: model.
  const units = [{ manufacturer: 'Lennox', model: 'XC16' }];
  const ans = buildUnitAttributeAnswer('model', 'Prentiss', { customer_name: 'Jane Prentiss' }, units, '2026-09-22');
  eq('item 10 buildUnitAttributeAnswer :: model text', ans.text, 'The Prentiss unit — a Lennox XC16.');
}
{
  // buildUnitAttributeAnswer: age.
  const units = [{ installation_date: '2016-09-01' }];
  const ans = buildUnitAttributeAnswer('age', 'Bracken', { customer_name: 'Bracken' }, units, '2026-09-22');
  check('item 10 buildUnitAttributeAnswer :: age names years old', ans.text.includes('10 years old'), ans.text);
}
{
  // Honest zero: no equipment on file at all.
  const ans = buildUnitAttributeAnswer('serial', 'Nobody', { customer_name: 'Nobody Real' }, [], '2026-09-22');
  eq('item 10 buildUnitAttributeAnswer (zero) :: no equipment on file', ans.text, 'No equipment on file for Nobody Real.');
  eq('item 10 buildUnitAttributeAnswer (zero) :: no facts', ans.facts.length, 0);
}
{
  // Multiple units -> one line/fact per unit, never guessed down to one.
  const units = [{ serial_number: 'A1' }, { serial_number: 'B2' }];
  const ans = buildUnitAttributeAnswer('serial', 'Mercer', { customer_name: 'Thomas Mercer' }, units, '2026-09-22');
  check('item 10 buildUnitAttributeAnswer (multiple) :: names both units', ans.text.includes('unit 1') && ans.text.includes('unit 2') && ans.text.includes('A1') && ans.text.includes('B2'), ans.text);
  eq('item 10 buildUnitAttributeAnswer (multiple) :: one fact per unit', ans.facts.length, 2);
}
{
  // runContactLookup end to end: resolves the customer, fetches equipment,
  // answers the attribute — the exact live-miss phrasing.
  const rows = [{ id: 'c1', customer_number: 'C-1', customer_name: 'Maria Salazar', service_address: '10 Main St' }];
  const units = [{ manufacturer: 'Trane', model: '4TTR6', installation_date: '2009-01-15', warranty: { expires: '2019-01-01' } }];
  const mockDb = { raw: async () => ({ rows }), listCustomerEquipment: async () => units };
  const answer = await runContactLookup(mockDb, 'Is the Salazar unit still under warranty?', { today: '2026-09-22' });
  check('item 10 runContactLookup :: end-to-end warranty answer', Boolean(answer) && answer.text.includes('warranty expired'), answer?.text);
}

/* ======================================================================
 * CUSTOMER REMINDERS build (2026-09-22): "any notes/reminders for Abernathy",
 * "what should I check at Ellison's", "reminders for 322 N Greenfield" —
 * question routing to reminders.js's listOpenReminders via contactLookup.js.
 * ====================================================================== */

const REMINDER_QUESTION_POSITIVES = [
  ['any notes/reminders for Abernathy', 'abernathy', false],
  ['reminders for Abernathy', 'abernathy', false],
  ['what should I check at Ellison\'s', 'ellison', false],
  ['reminders for 322 N Greenfield', '322 n greenfield', true],
];
for (const [q, expectedName, expectedIsStreet] of REMINDER_QUESTION_POSITIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`reminder shape :: "${q}" -> field 'reminders'`, parsed?.field === 'reminders', JSON.stringify(parsed));
  eq(`reminder shape :: "${q}" -> namePhrase`, parsed?.namePhrase, expectedName);
  eq(`reminder shape :: "${q}" -> isStreet`, Boolean(parsed?.isStreet), expectedIsStreet);
}

// Must never hijack an ordinary analytics/aggregate question that merely
// contains "reminders" or "notes" as a word.
const REMINDER_QUESTION_NEGATIVES = [
  'how many reminders do we have open',
  'list customers missing a phone number',
];
for (const q of REMINDER_QUESTION_NEGATIVES) {
  const parsed = parseContactLookupQuestion(q);
  check(`reminder shape must not hijack :: "${q}"`, parsed?.field !== 'reminders', JSON.stringify(parsed));
}

/* -------------------------------------------------------- buildReminderAnswer */
eq('buildReminderAnswer :: honest zero', buildReminderAnswer([], 'Karen Abernathy').text, 'No open reminders for Karen Abernathy.');
{
  const reminders = [{ documentId: 'd1', reminderText: 'confirm filter size on next visit', reminderTrigger: 'next_visit' }];
  const ans = buildReminderAnswer(reminders, 'Karen Abernathy');
  check('buildReminderAnswer :: names the reminder text', ans.text.includes('confirm filter size on next visit'), ans.text);
  eq('buildReminderAnswer :: one fact per reminder', ans.facts.length, 1);
}

/* --------------------------------------------- runContactLookup end to end */
{
  const customerRow = { id: 'c1', customer_number: 'C-1', customer_name: 'Karen Abernathy', service_address: null, phone: null, email: null, serial_number: null };
  const reminderRow = {
    document_id: 'd1', reminder_text: 'confirm filter size on next visit', reminder_trigger: 'next_visit',
    reminder_customer_name: 'Karen Abernathy', created_at: '2026-09-20', original_filename: '054-other-c10.pdf',
    document_type: 'other', customer_id: 'c1', customer_name: 'Karen Abernathy',
  };
  const mockDb = {
    raw: async (sql) => {
      if (/FROM extractions rt/.test(sql)) return { rows: [reminderRow] };
      if (/FROM audit_log/.test(sql)) return { rows: [] };
      return { rows: [customerRow] }; // the two customer-candidate queries
    },
  };
  const answer = await runContactLookup(mockDb, 'any reminders for Abernathy');
  check('reminders :: runContactLookup end-to-end names the reminder', Boolean(answer) && answer.text.includes('confirm filter size on next visit'), answer?.text);
}
{
  // Zero matching customer -> defer (null), same "don't know this customer"
  // contract as every other contactLookup field, never a guess.
  const mockDb = { raw: async () => ({ rows: [] }) };
  const answer = await runContactLookup(mockDb, 'reminders for Nobody Real');
  eq('reminders :: zero customer match defers to the rest of the pipeline (null)', answer, null);
}
{
  // Resolved customer, but no open reminders -> honest zero, not a defer.
  const customerRow = { id: 'c2', customer_number: 'C-2', customer_name: 'John Ellison', service_address: null, phone: null, email: null, serial_number: null };
  const mockDb = {
    raw: async (sql) => {
      if (/FROM extractions rt/.test(sql)) return { rows: [] };
      if (/FROM audit_log/.test(sql)) return { rows: [] };
      return { rows: [customerRow] };
    },
  };
  const answer = await runContactLookup(mockDb, "what should I check at Ellison's");
  eq('reminders :: resolved customer with no open reminders -> honest zero', answer?.text, 'No open reminders for John Ellison.');
}


/* ======================================================================
 * Team A (2026-09-24): answer correctness - time semantics, future dates, comparisons, age math, maintenance due,
 * scope resolution, deterministic routing, no-fabrication.
 * ====================================================================== */
{
  const S = await import('../api/_lib/scope.js');
  const C = await import('../api/_lib/comparison.js');
  const M = await import('../api/_lib/maintenanceDue.js');
  const D = await import('../api/_lib/deterministicRouter.js');
  const A = await import('../api/_lib/analytics.js');
  const TODAY = '2026-09-23';

  // 1. time semantics
  eq('teamA time :: "added" -> upload date', S.dateBasisOf('which documents were added in august'), 'uploaded');
  eq('teamA time :: "uploaded/received/scanned/filed" -> upload date', ['uploaded last week', 'received in may', 'scanned today', 'filed this month'].map((q) => S.dateBasisOf(`invoices ${q}`)).join(','), 'uploaded,uploaded,uploaded,uploaded');
  eq('teamA time :: "serviced/visited/job/work done/installed" -> service date', ['serviced in august', 'visited last month', 'jobs in march', 'work done in june', 'installed in 2019'].map((q) => S.dateBasisOf(`units ${q}`)).join(','), 'service,service,service,service,service');
  eq('teamA time :: no stated basis -> null', S.dateBasisOf('how many customers in mesa'), null);
  check('teamA time :: the answer says which date it used', /upload date/.test(S.dateBasisPhrase('uploaded')) && /service date/.test(S.dateBasisPhrase('service')));
  const planA = A.validatePlan({ entity: 'documents', op: 'count', dateBasis: 'uploaded' });
  eq('teamA time :: validatePlan keeps dateBasis', planA?.dateBasis, 'uploaded');
  check('teamA time :: dateBasis is part of the cache identity', A.analyticsPlanHash(planA) !== A.analyticsPlanHash({ ...planA, dateBasis: 'service' }));

  // 2. future dates
  const sp = S.splitFuture([{ date: '2027-03-01' }, { date: '2026-05-01' }, { date: '2026-09-23' }], TODAY);
  eq('teamA future :: a date after today is never "past"', sp.past.map((r) => r.date).join(','), '2026-09-23,2026-05-01');
  eq('teamA future :: it is set aside', sp.future.map((r) => r.date).join(','), '2027-03-01');
  check('teamA future :: the note mentions the excluded date', /March 1, 2027/.test(S.futureNote(sp.future, TODAY)) && /left it out/.test(S.futureNote(sp.future, TODAY)));
  {
    const v = await S.fetchVisits({ raw: async () => ({ rows: [
      { document_id: 'd1', service_date: '2027-03-01', document_type: 'service_ticket', original_filename: 'a.pdf' },
      { document_id: 'd2', service_date: '2026-05-01', document_type: 'service_ticket', original_filename: 'b.pdf' },
      { document_id: 'd3', service_date: '2026-06-01', document_type: 'quote', original_filename: 'c.pdf' },
    ] }) }, ['d1', 'd2', 'd3']);
    eq('teamA visits :: only visit-type documents count (a quote date is not a visit)', v.map((r) => r.documentId).sort().join(','), 'd1,d2');
  }

  // 4. comparisons
  const cmp = C.parseComparison('do we have more invoices or more service tickets on file?');
  eq('teamA compare :: both doc types parsed', `${cmp?.a?.key}|${cmp?.b?.key}`, 'invoice|service-ticket');
  const cAns = C.buildComparisonAnswer(cmp, { a: 12, b: 30, breakdown: [{ id: 'service-ticket', label: 'Service ticket', count: 30 }, { id: 'invoice', label: 'Invoice', count: 12 }, { id: 'permit', label: 'Permit', count: 4 }] });
  check('teamA compare :: text gives BOTH numbers and the winner', /More service tickets: 12 invoices vs 30 service tickets|More service tickets/.test(cAns.text) && /12/.test(cAns.text) && /30/.test(cAns.text), cAns.text);
  check('teamA compare :: breakdown lists every type on file', cAns.facts.length === 3 && cAns.facts.some((f) => f.label === 'Permit' && f.value === '4'));
  eq('teamA compare :: brands parse', C.parseComparison('do we have more trane or more carrier units')?.kind, 'brand');
  eq('teamA compare :: unrelated sides are left to the agent', C.parseComparison('more invoices or more trane units'), null);

  // 5. age math (year arithmetic in code)
  eq('teamA age :: older than 10 years (2026) -> installYear < 2016', JSON.stringify(A.resolveAgeFilter('customers with units older than 10 years', TODAY)), JSON.stringify({ field: 'installYear', op: 'lt', value: 2016 }));
  eq('teamA age :: newer than 5 years -> installYear >= 2021', JSON.stringify(A.resolveAgeFilter('units newer than 5 years', TODAY)), JSON.stringify({ field: 'installYear', op: 'gte', value: 2021 }));
  eq('teamA age :: no age words -> null', A.resolveAgeFilter('how many customers', TODAY), null);

  // 8. maintenance due (deterministic)
  eq('teamA maintenance :: "2 visits per year" -> 6 months', M.parseCadenceMonths('2 visits per year'), 6);
  eq('teamA maintenance :: default cadence is 12', M.parseCadenceMonths('annual'), 12);
  eq('teamA maintenance :: season parsed', M.parseMaintenanceDue('who is due for maintenance this fall')?.season, 'fall');
  {
    const res = M.computeMaintenanceDue({
      customers: [{ id: 'a', name: 'Alpha', address: '1 A St' }, { id: 'b', name: 'Bravo', address: '2 B St' }, { id: 'c', name: 'Charlie', address: '3 C St' }],
      agreements: [{ customerId: 'a', documentId: 'ag1', cadenceMonths: 6 }, { customerId: 'b', documentId: 'ag2', cadenceMonths: null }, { customerId: 'c', documentId: 'ag3', cadenceMonths: 12 }],
      visits: [
        { customerId: 'a', documentId: 'v1', date: '2026-01-10', documentType: 'service-ticket', serviceType: 'maintenance' },
        { customerId: 'b', documentId: 'v2', date: '2026-02-01', documentType: 'service-ticket', serviceType: 'maintenance' },
        { customerId: 'c', documentId: 'v3', date: '2027-01-01', documentType: 'service-ticket', serviceType: 'maintenance' }, // future: ignored
        { customerId: 'c', documentId: 'v4', date: '2026-08-01', documentType: 'service-ticket', serviceType: 'maintenance' },
      ],
    }, { today: TODAY, mode: 'cadence' });
    eq('teamA maintenance :: 6-month agreement last seen Jan 10 is overdue; 12-month (default) Feb 1 is not', res.overdue.map((e) => e.name).join(','), 'Alpha');
    check('teamA maintenance :: a future-dated visit is excluded and mentioned', res.futureVisits.length === 1 && /left it out/.test(M.buildMaintenanceAnswer(res).text));
    const ans = M.buildMaintenanceAnswer(res);
    check('teamA maintenance :: each listed customer carries the last visit date and a citation', ans.facts[0].value.includes('January 10, 2026') || ans.facts[0].value.includes('Jan'), ans.facts[0].value);
    check('teamA maintenance :: cites the visit document', ans.facts[0].sources.some((s) => s.documentId === 'v1'));
  }

  // deterministic routing (history / installer / comparison ahead of the planner)
  eq('teamA route :: last service at an address', D.classifyDeterministic('when did we last service the unit at 12 Main St')?.kind, 'last-service');
  eq('teamA route :: installer is a single-field lookup', D.classifyDeterministic('who installed the unit at 12 Main St')?.kind, 'installer');
  eq('teamA route :: comparison', D.classifyDeterministic('do we have more invoices or more service tickets on file')?.route, 'comparison');

  // 7. address / unit ambiguity
  eq('teamA scope :: "Apt 104" is a unit designator', S.extractUnitDesignator('permit for 500 Elm St Apt 104'), S.extractUnitDesignator('permit for 500 Elm St Apt 104'));
  check('teamA scope :: an address without a unit names no unit', !S.extractUnitDesignator('permit for 500 Elm St'));
  check('teamA scope :: unit designator recognised', Boolean(S.extractUnitDesignator('permit for 500 Elm St Apt 104')));

  // 9. full file / unit notes are recognised
  eq('teamA file :: "what do we have on file for X" is a full-file lookup', parseContactLookupQuestion('what do we have on file for Bracken')?.field, 'full');
  check('teamA notes :: "notes on the Bracken unit" is recognised', Boolean(parseContactLookupQuestion('notes on the Bracken unit')));
}

console.log(`\n${count - failures}/${count} checks passed.`);
if (failures > 0) {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
