/**
 * Duplicates count, business-name fragments and Records fallbacks.
 *   tsx scripts/verify-dupes-names-records.ts
 */
// @ts-ignore plain JS modules
import {
  findDuplicateCustomerPairs, dedupePairs, crowdedAddressKeys, MAX_CUSTOMERS_PER_ADDRESS,
  compareNamesStrict, normalizeSurname, isFragmentName, isBusinessName, possibleDuplicatePairKey,
// @ts-ignore
} from '../api/_lib/integrity.js';
// @ts-ignore
import { planPossibleDuplicates } from '../api/_lib/routes/customers.js';
// @ts-ignore
import { applyBrowseFallbacks, normalizeCustomerNameText } from '../api/_lib/recordsStore.js';

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`PASS  ${name}`);
  else { failed++; console.log(`FAIL  ${name}${detail === undefined ? '' : ' - ' + JSON.stringify(detail)}`); }
}

type C = { id: string; customerNumber: string; name: string; address: string };
const c = (n: number, name: string, address: string): C => ({ id: `c${n}`, customerNumber: `C-${String(n).padStart(5, '0')}`, name, address });
const chipCount = (cs: C[]) => {
  const d = findDuplicateCustomerPairs(cs);
  const p = dedupePairs(planPossibleDuplicates(cs), d);
  return { d, p, total: d.length + p.length };
};

// 1. Pair dedupe: a surname pair appears in both raw lists, once after dedupe.
{
  const cs = [c(1, 'John Smith', '10 Elm St'), c(2, 'Jane Smith', '10 Elm St')];
  const d = findDuplicateCustomerPairs(cs);
  const rawP = planPossibleDuplicates(cs);
  check('raw lists overlap on a surname pair', d.length === 1 && rawP.length === 1);
  check('chip count is 1 after dedupe, not 2', chipCount(cs).total === 1, chipCount(cs).total);
  check('dedupePairs drops repeats inside one list', dedupePairs([rawP[0], rawP[0]]).length === 1);
}

// 2. Shared-address threshold.
{
  const many = Array.from({ length: 23 }, (_, i) => c(i + 1, `Shopper${i} Number${i}`, '500 Main St, Mesa AZ'));
  check('23 unrelated customers at one address = 0 pairs (was 253)', chipCount(many).total === 0, chipCount(many).total);
  const sameSurname = Array.from({ length: 6 }, (_, i) => c(i + 1, `P${i} Garcia`, '500 Main St'));
  check('6 same-surname customers at one shop address = 0 pairs', chipCount(sameSurname).total === 0, chipCount(sameSurname).total);
  const three = [c(1, 'Ann Lee', '1 A St'), c(2, 'Bob Lee', '1 A St'), c(3, 'Cy Lee', '1 A St')];
  check(`${MAX_CUSTOMERS_PER_ADDRESS} customers at an address still pair (household)`, chipCount(three).total === 3, chipCount(three).total);
  check('4 customers makes the address crowded', crowdedAddressKeys([...three, c(4, 'Di Lee', '1 A St')]).size === 1);
}

// 3. Real copies still caught (same receipt customer captured twice, even at a crowded address).
{
  const cs = [
    c(1, 'Acme Hardware', '9 Store Rd'), c(2, 'Acme Hardware', '9 Store Rd'),
    c(3, 'X One', '9 Store Rd'), c(4, 'Y Two', '9 Store Rd'), c(5, 'Z Three', '9 Store Rd'),
  ];
  const { d } = chipCount(cs);
  check('identical-name pair still caught at a crowded address', d.length === 1 && d.some((p: any) => [p.keepId, p.dropId].sort().join() === 'c1,c2'), d.length);
  const sub = [c(1, 'Castillo', '1519 W Juniper'), c(2, 'Ray & Linda Castillo', '1519 W Juniper Ave')];
  check('subset name pair still caught', findDuplicateCustomerPairs(sub).length === 1);
}

// 4. Fragments.
for (const f of ['Management', 'Inc.', 'Group', 'LLC', 'Co', 'Corp', 'Services', 'Properties', 'Partners', 'Holdings', 'Company', 'Ltd', 'LP', 'Trust', 'Association', 'HOA', 'Group LLC', 'Property Management']) {
  check(`fragment rejected: "${f}"`, isFragmentName(f) && normalizeCustomerNameText(f) === '' && compareNamesStrict(f, 'Mesa Property Management Inc.') === 'unknown' && normalizeSurname(f) === '', compareNamesStrict(f, 'Mesa Property Management Inc.'));
}
check('real names are not fragments', !isFragmentName('Ray & Linda Castillo') && !isFragmentName('Smith'));
check('empty is not a fragment (it is "no name")', !isFragmentName(''));
check('a fragment never pairs customers by address', findDuplicateCustomerPairs([c(1, 'Management', '1 A St'), c(2, 'Management', '1 A St')]).length === 0);

// 5. Whole-name business matching.
{
  const a = 'Smith Property Management LLC';
  check('business has no surname', normalizeSurname(a) === '' && isBusinessName(a));
  check('same business matches as equal', compareNamesStrict(a, 'smith property management, llc') === 'equal');
  check('suffix variant matches as a whole name', compareNamesStrict(a, 'Smith Property Management') === 'subset');
  check('two businesses sharing only a suffix do not match', compareNamesStrict('Mesa Property Management Inc.', 'Tempe Property Management Inc.') === 'no-match');
  check('business vs a person sharing a word does not match', compareNamesStrict(a, 'John Smith') === 'no-match');
  check('"Foo Group" and "Bar Group" do not match', compareNamesStrict('Foo Group', 'Bar Group') === 'no-match');
  check('people still match by surname (Ray & Linda Castillo / Castillo)', compareNamesStrict('Ray & Linda Castillo', 'Castillo') === 'subset' && normalizeSurname('Ray & Linda Castillo') === 'castillo');
  const dupes = findDuplicateCustomerPairs([c(1, a, '5 Oak Ct'), c(2, 'Smith Property Management', '5 Oak Ct')]);
  check('same business at same address is one duplicate pair', dupes.length === 1);
}

// 5b. Business names without a legal suffix never collapse to a last-word surname.
{
  const pairs: [string, string][] = [['Johnson & Sons Plumbing', 'Smith & Sons Plumbing'], ['Smith Heating & Air', 'Jones Heating & Air'], ['Desert Dental Group', 'Sunrise Dental Group'], ['ABC Equipment Rentals', 'XYZ Equipment Rentals']];
  for (const [a, b] of pairs) check(`business "${a}" vs "${b}" no-match, no surname`, compareNamesStrict(a, b) === 'no-match' && normalizeSurname(a) === '', compareNamesStrict(a, b));
  check('John Smith vs Jane Smith still surname', compareNamesStrict('John Smith', 'Jane Smith') === 'surname');
  check('"Smith, John" vs "Jane Smith" surname', compareNamesStrict('Smith, John', 'Jane Smith') === 'surname' && normalizeSurname('Smith, John') === 'smith');
  check('"Mr. Smith" vs "Jane Smith" surname', compareNamesStrict('Mr. Smith', 'Jane Smith') !== 'no-match');
}

// 6. Browse fallback (pure).
{
  const linked = applyBrowseFallbacks({ customer_name: 'Linked Co Name', site_address: '1 Linked St', amount: '10.5', ex_customer_name: 'Extracted', ex_service_address: 'Ex St', ex_cost: '99' });
  check('linked values win', linked.customerName === 'Linked Co Name' && linked.siteAddress === '1 Linked St' && linked.amount === 10.5 && !linked.customerFromDocument && !linked.amountFromDocument);
  const fb = applyBrowseFallbacks({ customer_name: null, site_address: null, amount: null, ex_customer_name: 'Pat Rivera', ex_service_address: '2 Ex St, Mesa', ex_cost: '$334.56' });
  check('unlinked row falls back to extracted customer/address/amount', fb.customerName === 'Pat Rivera' && fb.siteAddress === '2 Ex St, Mesa' && fb.amount === 334.56 && fb.customerFromDocument && fb.addressFromDocument && fb.amountFromDocument, fb);
  check('total preferred over cost', applyBrowseFallbacks({ ex_total: '1,200.00', ex_cost: '5' }).amount === 1200);
  check('fragment extracted name is not shown', applyBrowseFallbacks({ ex_customer_name: 'Inc.' }).customerName === null);
  check('nothing at all stays null', applyBrowseFallbacks({}).amount === null && applyBrowseFallbacks({}).customerName === null);
  check('unparseable amount stays null', applyBrowseFallbacks({ ex_cost: 'n/a' }).amount === null);
}

check('pair key is order independent', possibleDuplicatePairKey('a', 'b') === possibleDuplicatePairKey('b', 'a'));
if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nAll checks passed.');
