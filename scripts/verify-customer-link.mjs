/**
 * Unit checks for customer matching. No database, no network.
 *
 * What this guards: findOrCreateCustomer's whole job is deciding whether a
 * document is about a customer this tenant has already seen. Getting that
 * wrong in one direction (merge) shows one customer another's equipment and
 * warranty state — a privacy defect, not just an untidy table. Getting it
 * wrong in the other direction (never merge) just means duplicate rows a
 * human can tidy up later. These checks exist to keep the code on the safe
 * side of that asymmetry.
 *
 *   node scripts/verify-customer-link.mjs
 */
import { normalizeMatchText, selectCustomerMatch } from '../api/_lib/recordsStore.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- normalizeMatchText */

eq('plain name survives', normalizeMatchText('John Smith'), 'John Smith');
eq('internal whitespace collapsed', normalizeMatchText('John   Smith'), 'John Smith');
eq('leading/trailing whitespace trimmed', normalizeMatchText('  John Smith  '), 'John Smith');
eq('tabs and newlines collapsed', normalizeMatchText('John\t\nSmith'), 'John Smith');

// The adversarial cases the build brief calls out by name.
eq('whitespace-only name rejected', normalizeMatchText('   '), '');
eq('punctuation-only name rejected', normalizeMatchText('---'), '');
eq('em-dash-only name rejected', normalizeMatchText('—'), '');
eq('dots-only name rejected', normalizeMatchText('...'), '');
eq('null rejected', normalizeMatchText(null), '');
eq('undefined rejected', normalizeMatchText(undefined), '');
eq('empty string rejected', normalizeMatchText(''), '');

// A name with ANY letter or digit is accepted even if mostly punctuation —
// this function's job is refusing garbage, not judging plausibility.
eq('mostly punctuation but one letter survives', normalizeMatchText('--- A ---'), '--- A ---');
eq('"N/A" survives (has letters; a real value, arguably)', normalizeMatchText('N/A'), 'N/A');

{
  const long = 'A'.repeat(5000);
  const got = normalizeMatchText(long);
  check('5000-char name is not truncated or corrupted', got === long, `length ${got.length}`);
}

{
  // Two names differing only in whitespace/case must normalize to values that
  // compare equal case-insensitively — this is exactly what the SQL query
  // relies on (lower(data->>'customer_name') = lower($1)).
  const a = normalizeMatchText('  Jane   Doe ');
  const b = normalizeMatchText('Jane Doe');
  check('whitespace variants match case-insensitively', a.toLowerCase() === b.toLowerCase(), `"${a}" vs "${b}"`);
}

/* ------------------------------------------------------- selectCustomerMatch */

const smithA = { id: 'smith-a', data: { customer_name: 'John Smith', service_address: '123 Main St' } };
const smithB = { id: 'smith-b', data: { customer_name: 'John Smith', service_address: '456 Oak Ave' } };
const smithNoAddr = { id: 'smith-no-addr', data: { customer_name: 'John Smith' } };

eq('no candidates, no address -> null (create new)', selectCustomerMatch([], ''), null);
eq('no candidates, with address -> null (create new)', selectCustomerMatch([], '123 Main St'), null);

eq('one candidate, no incoming address -> matches it', selectCustomerMatch([smithA], ''), smithA);
eq('one candidate, matching address -> matches it', selectCustomerMatch([smithA], '123 Main St'), smithA);
eq('one candidate, matching address is case-insensitive', selectCustomerMatch([smithA], '123 MAIN ST'), smithA);
// A name-only row must NOT swallow the next person of the same name. The
// customer whose first document had no address gets a duplicate row instead —
// visible and mergeable, unlike a silent false merge.
eq('one candidate with no address on file, incoming HAS one -> null (no merge)', selectCustomerMatch([smithNoAddr], '123 Main St'), null);
eq('name-only row still matches when incoming also has no address', selectCustomerMatch([smithNoAddr], ''), smithNoAddr);
eq('one candidate, address disagrees -> null (create new, not a merge)', selectCustomerMatch([smithA], '456 Oak Ave'), null);

// The load-bearing case: two different Smiths must never merge.
eq(
  'two Smiths at different addresses, no incoming address -> ambiguous, refuse',
  selectCustomerMatch([smithA, smithB], ''),
  null
);
eq(
  'two Smiths at different addresses, incoming address picks the right one',
  selectCustomerMatch([smithA, smithB], '456 Oak Ave'),
  smithB
);
eq(
  'two Smiths, incoming address matches neither -> a third Smith, not a guess',
  selectCustomerMatch([smithA, smithB], '789 Elm St'),
  null
);
eq(
  'Smith-with-matching-address wins over a same-named row with no address',
  selectCustomerMatch([smithA, smithNoAddr], '123 Main St'),
  // Requiring a POSITIVE address match makes this unambiguous rather than
  // refusing: only smithA is eligible, and we have real evidence it is the
  // right one. The addressless row is no longer a wildcard that matches
  // everyone of that name.
  smithA
);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
