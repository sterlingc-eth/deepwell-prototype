/**
 * Unit checks for customer profiles. No database, no network.
 *
 * What this guards (handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md):
 *   - customer number formatting/next-number math, pinned against
 *     next_customer_number()'s SQL (M3-config/15-customer-profiles.sql) so
 *     the two never silently disagree.
 *   - the document union's dedupe-by-priority rule (a document reachable
 *     through more than one path must show the STRONGEST one).
 *   - duplicate-customer detection (same name OR same address).
 *   - updateCustomer's patch allowlist.
 *   - mergeCustomers' "keep the lower number" rule.
 *
 *   node scripts/verify-customers.mjs
 */
import {
  formatCustomerNumber,
  nextNumberFromExisting,
  isValidCustomerNumber,
  mergeDocumentVia,
  formatVia,
  duplicateReason,
  deriveCity,
  countWarrantyAlerts,
  CUSTOMER_NUMBER_RE,
} from '../api/_lib/routes/customers.js';
import {
  filterCustomerPatch,
  CUSTOMER_PATCH_KEYS,
  chooseSurvivorNumber,
} from '../api/_lib/reviewStore.js';
import { extractCustomerNumber, classifyMetaQuestion } from '../api/ask.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* --------------------------------------------------------- formatCustomerNumber */

eq('1 formats as C-00001', formatCustomerNumber(1), 'C-00001');
eq('42 formats as C-00042', formatCustomerNumber(42), 'C-00042');
eq('100000 formats without truncating', formatCustomerNumber(100000), 'C-100000');
eq('0 is not a valid number', formatCustomerNumber(0), null);
eq('a negative number is invalid', formatCustomerNumber(-1), null);
eq('a non-numeric input is invalid', formatCustomerNumber('abc'), null);
eq('a numeric string is accepted (SQL returns int)', formatCustomerNumber('7'), 'C-00007');

/* -------------------------------------------------------- nextNumberFromExisting
 * Mirrors next_customer_number()'s MAX(suffix)+1 rule from
 * M3-config/15-customer-profiles.sql — see that file's step 3. */

eq('empty tenant starts at C-00001', nextNumberFromExisting([]), 'C-00001');
eq('next after C-00001 is C-00002', nextNumberFromExisting(['C-00001']), 'C-00002');
eq('picks the MAX, not the count', nextNumberFromExisting(['C-00001', 'C-00005', 'C-00003']), 'C-00006');
eq('ignores non-matching junk (legacy/garbage rows)', nextNumberFromExisting(['C-00001', 'not-a-number', null, 'C-00002']), 'C-00003');
eq('duplicates do not confuse the max', nextNumberFromExisting(['C-00004', 'C-00004']), 'C-00005');

/* -------------------------------------------------------------- isValidCustomerNumber */

eq('a real number passes', isValidCustomerNumber('C-00012'), true);
eq('lowercase c fails (case-sensitive contract)', isValidCustomerNumber('c-00012'), false);
eq('too few digits fails', isValidCustomerNumber('C-123'), false);
eq('too many digits fails', isValidCustomerNumber('C-1234567'), false);
eq('no dash fails', isValidCustomerNumber('C00012'), false);
eq('empty string fails', isValidCustomerNumber(''), false);
eq('non-string fails', isValidCustomerNumber(12345), false);

/* -------------------------------------------------------------------- mergeDocumentVia
 * The priority rule: direct > equipment > name-match. A document reachable
 * through more than one path must report the STRONGEST one, never lose a
 * document, and never duplicate one. */

{
  const got = mergeDocumentVia([
    { documentId: 'd1', via: 'name-match' },
    { documentId: 'd1', via: 'direct' },
  ]);
  eq('direct beats name-match for the same document', got, [{ documentId: 'd1', via: 'direct', serial: null }]);
}
{
  const got = mergeDocumentVia([
    { documentId: 'd1', via: 'equipment', serial: 'SN-1' },
    { documentId: 'd1', via: 'name-match' },
  ]);
  eq('equipment beats name-match', got, [{ documentId: 'd1', via: 'equipment', serial: 'SN-1' }]);
}
{
  const got = mergeDocumentVia([
    { documentId: 'd1', via: 'direct' },
    { documentId: 'd1', via: 'equipment', serial: 'SN-1' },
  ]);
  eq('direct beats equipment regardless of input order', got, [{ documentId: 'd1', via: 'direct', serial: null }]);
}
{
  const got = mergeDocumentVia([
    { documentId: 'd1', via: 'direct' },
    { documentId: 'd2', via: 'equipment', serial: 'SN-2' },
  ]);
  eq('two distinct documents both survive', got.length, 2);
}
eq('empty input yields empty output', mergeDocumentVia([]), []);
eq('null/undefined entries are ignored', mergeDocumentVia([null, undefined, { documentId: 'd1', via: 'direct' }]).length, 1);

/* ------------------------------------------------------------------------- formatVia */

eq('equipment with a serial', formatVia('equipment', 'SN-42'), 'equipment:SN-42');
eq('equipment with no serial falls back to the bare word', formatVia('equipment', null), 'equipment');
eq('direct passes through', formatVia('direct', null), 'direct');
eq('name-match passes through', formatVia('name-match', null), 'name-match');

/* --------------------------------------------------------------------- duplicateReason */

eq('same name and address', duplicateReason('John Smith', '1 Main St', 'John Smith', '1 Main St'), 'same name and address');
eq('same name only', duplicateReason('John Smith', '1 Main St', 'John Smith', '2 Oak Ave'), 'same name');
eq('same address only', duplicateReason('John Smith', '1 Main St', 'Jane Doe', '1 Main St'), 'same address');
eq('neither matches -> null', duplicateReason('John Smith', '1 Main St', 'Jane Doe', '2 Oak Ave'), null);
eq('case-insensitive name match', duplicateReason('john smith', '1 Main St', 'JOHN SMITH', '2 Oak Ave'), 'same name');
eq('missing address on both sides never "matches"', duplicateReason('John Smith', '', 'John Smith', ''), 'same name');
eq('empty name on both sides never "matches" as a name', duplicateReason('', '1 Main St', '', '1 Main St'), 'same address');

/* ------------------------------------------------------------------------- deriveCity */

eq('street, city, state zip', deriveCity('123 Main St, Phoenix, AZ 85001'), 'Phoenix');
eq('street, city (no state)', deriveCity('123 Main St, Phoenix'), 'Phoenix');
eq('no comma at all -> null (nothing to derive from)', deriveCity('123 Main St'), null);
eq('empty address -> null', deriveCity(''), null);
eq('null address -> null', deriveCity(null), null);

/* --------------------------------------------------------------------- countWarrantyAlerts */

{
  // countWarrantyAlerts counts exactly the two tiers the brief names —
  // alertTier()'s buckets are mutually exclusive, so a unit expiring in the
  // next 30 days (its own 'expiring-30' tier) is deliberately NOT counted
  // here; only 'expired' and 'expiring-90' are. See the brief's exact
  // wording ("warrantyAlerts (count of units with tier expired/expiring-90)")
  // and handoffs/REQUESTS_customers_backend.md for the ambiguity this left.
  const today = '2026-09-20';
  const warranties = [
    { expires: '2026-08-01' },              // ~50 days ago -> expired
    { expires: '2026-09-25' },              // 5 days out -> expiring-30 (NOT counted)
    { expires: '2026-11-30' },              // ~71 days out -> expiring-90
    { expires: '2027-09-01' },              // far out -> ok / expiring-365
    null,                                    // no warranty on file
  ];
  const n = countWarrantyAlerts(warranties, today);
  check('counts only expired + expiring-90, skips expiring-30/ok/none', n === 2, `got ${n}`);
}
eq('no units -> zero alerts', countWarrantyAlerts([], '2026-09-20'), 0);
eq('all-null warranties -> zero alerts', countWarrantyAlerts([null, null], '2026-09-20'), 0);

/* ---------------------------------------------------------------- filterCustomerPatch */

eq('allowed keys pass through, mapped to data keys', filterCustomerPatch({ name: 'Jane Doe', phone: '555-1234' }),
  { customer_name: 'Jane Doe', phone: '555-1234' });
eq('unknown keys are dropped', filterCustomerPatch({ name: 'Jane Doe', stage: 'verified', tenantId: 'evil' }),
  { customer_name: 'Jane Doe' });
eq('null/undefined values are omitted (means "leave unchanged")', filterCustomerPatch({ name: 'Jane Doe', email: null, notes: undefined }),
  { customer_name: 'Jane Doe' });
eq('an empty string is an explicit clear, not omitted', filterCustomerPatch({ phone: '' }), { phone: '' });
eq('values are trimmed', filterCustomerPatch({ name: '  Jane Doe  ' }), { customer_name: 'Jane Doe' });
eq('empty patch yields empty output', filterCustomerPatch({}), {});
eq('patch itself missing yields empty output', filterCustomerPatch(undefined), {});
check('CUSTOMER_PATCH_KEYS never includes a security-sensitive column',
  !CUSTOMER_PATCH_KEYS.some((k) => ['stage', 'customerNumber', 'customer_number', 'tenantId', 'id'].includes(k)),
  JSON.stringify(CUSTOMER_PATCH_KEYS));

/* ---------------------------------------------------------------------- chooseSurvivorNumber */

eq('lower number wins (keep has it)', chooseSurvivorNumber('C-00003', 'C-00012'), { survivorNumber: 'C-00003', retiredNumber: 'C-00012' });
eq('lower number wins (drop has it)', chooseSurvivorNumber('C-00012', 'C-00003'), { survivorNumber: 'C-00003', retiredNumber: 'C-00012' });
eq('keep has none -> drop\'s number survives, nothing retired', chooseSurvivorNumber(null, 'C-00003'), { survivorNumber: 'C-00003', retiredNumber: null });
eq('drop has none -> keep\'s number survives, nothing retired', chooseSurvivorNumber('C-00003', null), { survivorNumber: 'C-00003', retiredNumber: null });
eq('neither has one -> nothing to do', chooseSurvivorNumber(null, null), { survivorNumber: null, retiredNumber: null });

/* -------------------------------------------------------------------- extractCustomerNumber */

eq('finds a number at the start of a question', extractCustomerNumber('C-00012: what is the warranty status'), 'C-00012');
eq('finds a number anywhere in the question', extractCustomerNumber('what is the warranty status for C-00012'), 'C-00012');
eq('lowercase input still resolves to canonical uppercase', extractCustomerNumber('c-00099 equipment list'), 'C-00099');
eq('no number present -> null', extractCustomerNumber('what is the warranty on the Goodman condenser'), null);
eq('too few digits does not match', extractCustomerNumber('see file C-123 please'), null);
eq('a longer digit run does not falsely match a 5-digit prefix', extractCustomerNumber('invoice C-123456'), null);
check('customers.js\'s own CUSTOMER_NUMBER_RE accepts the canonical shape', CUSTOMER_NUMBER_RE.test('C-00012'));

/* ---------------------------------------------------------------- classifyMetaQuestion
 * Only the NEW "show everything for C-00012" branch — the rest of
 * classifyMetaQuestion's behavior is already pinned in verify-retrieval.mjs. */

eq('"show everything for C-00012" resolves to a customer meta-question',
  classifyMetaQuestion('show everything for C-00012'), { kind: 'customer', number: 'C-00012' });
eq('"show me everything about C-00012" also matches', classifyMetaQuestion('show me everything about C-00012'),
  { kind: 'customer', number: 'C-00012' });
eq('case-insensitive punctuation-tolerant', classifyMetaQuestion('Show everything for c-00012?'),
  { kind: 'customer', number: 'C-00012' });
eq('a per-entity question about a customer is NOT caught here (must still retrieve normally)',
  classifyMetaQuestion('show me everything about the Andersons'), null);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
