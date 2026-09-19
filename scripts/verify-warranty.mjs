/**
 * Unit checks for the warranty derivation layer. No database, no network.
 *
 * What this guards: these numbers tell a contractor whether a homeowner has
 * five years of parts coverage or ten, and whether there is still time to
 * secure the difference. A wrong deadline is worse than no deadline — it
 * tells someone they have time when they don't.
 *
 *   node scripts/verify-warranty.mjs
 */
import {
  BRAND_RULES,
  normalizeBrand,
  deriveWarranty,
  describeWarranty,
  daysBetween,
  addDays,
  ruleCoverage,
  isValidYmd,
  alertTier,
  upsell,
} from '../api/_lib/warrantyRules.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------------- brands */

eq('plain brand', normalizeBrand('Goodman'), 'goodman');
eq('uppercase + suffix', normalizeBrand('GOODMAN MFG'), 'goodman');
eq('punctuation and company words', normalizeBrand('Goodman Manufacturing Co.'), 'goodman');
eq('two-word brand survives', normalizeBrand('American Standard'), 'american standard');
// Deliberate false negative: a model string is not a manufacturer field, and
// guessing inside one is how "Trane Certified Dealer" became a warranty deadline.
eq('model string refused rather than guessed', normalizeBrand('TRANE XR14 CONDENSING UNIT'), null);
eq('brand written last is refused', normalizeBrand('condenser, Trane'), null);
eq('descriptor stripped', normalizeBrand('Mitsubishi Electric'), 'mitsubishi');
eq('unknown brand', normalizeBrand('Frobozz Cooling'), null);
eq('empty', normalizeBrand(''), null);
eq('null', normalizeBrand(null), null);

/* --------------- adversarial: a brand word is not a brand field -----------
 * `manufacturer` is free text from a model reading OCR'd paper. A matcher that
 * accepts the word anywhere turns a surname into a confident warranty deadline,
 * and Goodman is both a common surname AND one of only two brands with real
 * rules — so a false match there does not fail safe. */

eq('surname is not a manufacturer', normalizeBrand('Sold by John Goodman'), null);
eq('place name is not a manufacturer', normalizeBrand('New York Blower Company'), null);
eq('dealer name is not a manufacturer', normalizeBrand('Goodman & Sons Heating and Air'), null);
eq('contractor letterhead is not a manufacturer', normalizeBrand('Trane Certified Dealer'), null);
eq('marketing badge is not a manufacturer', normalizeBrand('Trane Comfort Specialist'), null);
eq('electrical contractor is not a manufacturer', normalizeBrand('Goodman Electric'), null);
eq('trade name with HVAC is not a manufacturer', normalizeBrand('Goodman HVAC'), null);
eq('parts desk is not a manufacturer', normalizeBrand('Trane Parts'), null);
eq('financing arm is not a manufacturer', normalizeBrand('Trane Financing'), null);
eq('warehouse is not a manufacturer', normalizeBrand('Goodman Furnace Warehouse'), null);
eq('premises is not a manufacturer', normalizeBrand('Goodman Residence'), null);
eq('prose is refused outright', normalizeBrand('unit was supplied and installed by Trane dealer network here'), null);
eq('label prefix tolerated', normalizeBrand('Manufacturer: Goodman'), 'goodman');
eq('parent-company name is an explicit alias', normalizeBrand('Trane Technologies'), 'trane');

// A business word at the end is not a legal suffix. "Goodman Group" is a real
// and entirely unrelated company; stripping these turned it into a warranty
// deadline on equipment that was never Goodman's.
eq('Group is not a suffix', normalizeBrand('Goodman Group'), null);
eq('Holdings is not a suffix', normalizeBrand('Goodman Holdings'), null);
eq('Products is not a suffix', normalizeBrand('Goodman Products'), null);
eq('Brands is not a suffix', normalizeBrand('Goodman Brands'), null);
eq('International is not a suffix', normalizeBrand('Goodman International'), null);
eq('USA is not a suffix', normalizeBrand('Goodman USA'), null);
eq('Industries is not a suffix', normalizeBrand('Trane Industries'), null);
eq('legal suffixes still shed', normalizeBrand('Goodman Co Inc Corp'), 'goodman');
eq('alias survives a legal suffix', normalizeBrand('Mitsubishi Electric Corporation'), 'mitsubishi');
eq('bare suffix word alone', normalizeBrand('Corp'), null);
eq('bare label word alone', normalizeBrand('Manufacturer'), null);

/* -------------------------------------------------- newly verified brands */

eq('Lennox plain', normalizeBrand('Lennox'), 'lennox');
eq('Amana plain', normalizeBrand('Amana'), 'amana');
eq('American Standard plain', normalizeBrand('American Standard'), 'american standard');
eq('Carrier plain', normalizeBrand('Carrier'), 'carrier');
eq('Bryant plain', normalizeBrand('Bryant'), 'bryant');
eq('Payne plain', normalizeBrand('Payne'), 'payne');
eq('Rheem plain', normalizeBrand('Rheem'), 'rheem');
eq('Ruud plain', normalizeBrand('Ruud'), 'ruud');
eq('Daikin plain', normalizeBrand('Daikin'), 'daikin');

// Real parent-company legal names, deliberately whitelisted as aliases —
// same precedent as "Trane Technologies" and "Goodman Global" above.
eq('Lennox Industries is an explicit alias', normalizeBrand('Lennox Industries'), 'lennox');
eq('Carrier Global is an explicit alias', normalizeBrand('Carrier Global'), 'carrier');
eq('Daikin Industries is an explicit alias', normalizeBrand('Daikin Industries'), 'daikin');
eq('suffix stripping works for a new brand too', normalizeBrand('Rheem Manufacturing Company'), 'rheem');
eq('suffix stripping works for another new brand', normalizeBrand('Carrier Corporation'), 'carrier');
eq('suffix stripping works for Bryant', normalizeBrand('Bryant Inc.'), 'bryant');
eq('suffix stripping works for Payne', normalizeBrand('Payne Co'), 'payne');

/* ---- adversarial: common words and plausible business names, per brand ---
 * The same failure mode as "Sold by John Goodman" and "Trane Certified
 * Dealer" — a business, department, or product line that merely contains the
 * brand name must not resolve, because a false positive here is a confidently
 * wrong deadline on a brand this file now actually computes for. */

eq('dealer name is not a manufacturer (Payne)', normalizeBrand('Payne Plumbing'), null);
eq('department is not a manufacturer (Carrier)', normalizeBrand('Carrier Services'), null);
eq('unrelated company sharing the name (American Standard)', normalizeBrand('American Standard Insurance'), null);
eq('dealer name is not a manufacturer (Bryant)', normalizeBrand('Bryant & Sons'), null);
eq('dealer name is not a manufacturer (Lennox)', normalizeBrand('Lennox Heating & Air'), null);
eq('product line is not a manufacturer (Rheem)', normalizeBrand('Rheem Water Heaters'), null);
eq('dealer name is not a manufacturer (Ruud)', normalizeBrand('Ruud Distributors'), null);
eq('near-alias is not the alias (Daikin)', normalizeBrand('Daikin Applied Sales'), null);
eq('unrelated appliance line sharing the name (Amana)', normalizeBrand('Amana Appliance Co'), null);
eq('financing arm is not a manufacturer (Carrier)', normalizeBrand('Carrier Financing'), null);
eq('warehouse is not a manufacturer (Bryant)', normalizeBrand('Bryant Furnace Warehouse'), null);
eq('brand written last is refused (Rheem)', normalizeBrand('water heater, Rheem'), null);

/* ------------------------------------------------------------ date math */

eq('days between', daysBetween('2024-03-04', '2024-05-03'), 60);
eq('negative days', daysBetween('2024-05-03', '2024-03-04'), -60);
eq('bad date', daysBetween('nope', '2024-03-04'), null);

/* ---------------------------------------------- printed always wins */
{
  const w = deriveWarranty(
    { manufacturer: 'Goodman', installation_date: '2024-03-04', warranty_expires: '2030-01-01' },
    '2026-09-16'
  );
  eq('printed expiry used', w.expires, '2030-01-01');
  eq('basis is printed', w.expiresBasis, 'printed');
  check('no term invented when printed', w.termYears === null);
}

/* ------------------------------------- registration still open (the feature) */
{
  // Installed 41 days before "today"; 60-day window, so 19 days left.
  const w = deriveWarranty(
    { manufacturer: 'Goodman', installation_date: '2026-08-06' },
    '2026-09-16'
  );
  eq('deadline computed', w.registrationDeadline, '2026-10-05');
  eq('days remaining', w.daysToRegister, 19);
  eq('state is due', w.registrationState, 'due');
  check('action names the deadline', /Register with Goodman within 19 day/.test(w.action || ''), w.action);
  check('action names both terms', /10-year/.test(w.action) && /instead of 5/.test(w.action), w.action);
}

/* ----------------------------------------------------- window already closed */
{
  const w = deriveWarranty(
    { manufacturer: 'Trane', installation_date: '2026-01-05' },
    '2026-09-16'
  );
  eq('state is closed', w.registrationState, 'window_closed');
  check('action asks to confirm, not accuse', /Confirm whether this unit was registered/.test(w.action || ''), w.action);
}

/* ------------------------------------------------- registered inside window */
{
  const w = deriveWarranty(
    {
      manufacturer: 'Goodman',
      installation_date: '2024-03-04',
      warranty_registered_date: '2024-03-10',
    },
    '2026-09-16'
  );
  eq('long term earned', w.termYears, 10);
  eq('expiry from install date', w.expires, '2034-03-04');
  eq('basis is computed', w.expiresBasis, 'computed');
  eq('registration on file', w.registrationState, 'on_file');
}

/* --------------------------------------------------- registered too late */
{
  const w = deriveWarranty(
    {
      manufacturer: 'Goodman',
      installation_date: '2024-03-04',
      warranty_registered_date: '2024-07-01',
    },
    '2026-09-16'
  );
  eq('short term applies', w.termYears, 5);
  eq('expiry five years out', w.expires, '2029-03-04');
  check('late registration noted', w.notes.some((n) => /after the 60-day window closed/.test(n)), w.notes.join(' | '));
}

/* ------------------- no registration on file: assume short, say so plainly */
{
  const w = deriveWarranty(
    { manufacturer: 'Goodman', installation_date: '2018-05-01' },
    '2026-09-16'
  );
  eq('conservative term', w.termYears, 5);
  check(
    'note says no registration ON FILE, not unregistered',
    w.notes.some((n) => /No registration on file/.test(n)) &&
      !w.notes.some((n) => /\bis not registered\b/.test(n)),
    w.notes.join(' | ')
  );
}

/* ----------------------------------- unverified brand computes NOTHING */
{
  // York specifically: york.com currently redirects to a Bosch landing page,
  // so nothing could be confirmed to manufacturer standard and it stays null.
  const w = deriveWarranty(
    { manufacturer: 'York', installation_date: '2026-08-06' },
    '2026-09-16'
  );
  eq('no deadline', w.registrationDeadline, null);
  eq('no expiry', w.expires, null);
  eq('no term', w.termYears, null);
  eq('no action', w.action, null);
  check('brand recognised but unverified', w.brand === 'york' && w.brandVerified === false);
  check('note explains why', w.notes.some((n) => /not verified yet/.test(n)), w.notes.join(' | '));
}

/* ------------------------ sibling brands are independently verified, not aliased */
{
  const amana = deriveWarranty({ manufacturer: 'Amana', installation_date: '2026-08-06' }, '2026-09-16');
  const astd = deriveWarranty({ manufacturer: 'American Standard', installation_date: '2026-08-06' }, '2026-09-16');
  check('Amana normalizes to its own key, not Goodman', amana.brand === 'amana');
  check('American Standard normalizes to its own key, not Trane', astd.brand === 'american standard');
  eq('Amana deadline computed on its own rule', amana.registrationDeadline, '2026-10-05');
  eq('American Standard deadline computed on its own rule', astd.registrationDeadline, '2026-10-05');
  check(
    "Amana's rule object is not a reused reference to Goodman's",
    BRAND_RULES.amana.rule !== BRAND_RULES.goodman.rule
  );
  check(
    "American Standard's rule object is not a reused reference to Trane's",
    BRAND_RULES['american standard'].rule !== BRAND_RULES.trane.rule
  );
  check(
    'Amana was verified against its own page, not Goodman’s',
    BRAND_RULES.amana.source !== BRAND_RULES.goodman.source
  );
  check(
    'American Standard was verified against its own page, not Trane’s',
    BRAND_RULES['american standard'].source !== BRAND_RULES.trane.source
  );
}

/* ------------------------------------------- 90-day-window brands, plain case */
{
  // Same install-41-days-ago fixture as the Goodman "feature" test above, but
  // a 90-day window means 49 days remain, not 19.
  for (const brand of ['Carrier', 'Bryant', 'Payne', 'Rheem', 'Ruud']) {
    const w = deriveWarranty({ manufacturer: brand, installation_date: '2026-08-06' }, '2026-09-16');
    eq(`${brand} uses a 90-day window`, w.registrationDeadline, '2026-11-04');
    eq(`${brand} 90-day window leaves 49 days`, w.daysToRegister, 49);
    eq(`${brand} unregistered floor is 5 years`, w.termYears, 5);
  }
}

/* --------------------------- Carrier: the parts-or-labor choice at registration */
{
  // Registered in time, but nothing on file says which option the homeowner
  // elected. The floor (5, same as unregistered) is used, not a guess.
  const w = deriveWarranty(
    { manufacturer: 'Carrier', installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' },
    '2026-09-16'
  );
  eq('registered but election unknown: floor term, not a guess', w.termYears, 5);
  eq('expiry follows the floor', w.expires, '2029-03-04');
  check('term is flagged as conditional, not final', w.termConditional === true);
  check(
    "note explains the unresolved election, both branches",
    w.notes.some((n) => /elected 10-year parts/.test(n) && /elected 5-year parts \+ 3-year labor/.test(n)),
    w.notes.join(' | ')
  );
  check('no invented 10-year action wording', !/10-year/.test(w.action || ''), w.action);

  // If the election happens to be on file (nothing populates this key today,
  // but the mechanism must actually resolve it when it is there) the real
  // term is used with certainty.
  const resolved = deriveWarranty(
    {
      manufacturer: 'Carrier',
      installation_date: '2024-03-04',
      warranty_registered_date: '2024-03-10',
      warranty_coverage_election: 'parts10',
    },
    '2026-09-16'
  );
  eq('election on file resolves to the elected term', resolved.termYears, 10);
  check('resolved term is not flagged conditional', resolved.termConditional === false);
}

/* -------------------------------------- Carrier: unresolvable choice while still open */
{
  // Registration window still open, not yet registered: the "due" action
  // must not promise a specific number it can't back.
  const w = deriveWarranty({ manufacturer: 'Carrier', installation_date: '2026-08-06' }, '2026-09-16');
  eq('state is due', w.registrationState, 'due');
  check(
    'action states the guaranteed floor and the possible ceiling, not a single promised number',
    /could reach 10 years instead of the guaranteed 5/.test(w.action || ''),
    w.action
  );
}

/* ------------------------------------------------ Bryant: original-owner cap */
{
  const base = { manufacturer: 'Bryant', installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' };
  const unknown = deriveWarranty(base, '2026-09-16');
  eq('ownership unknown: floor term used', unknown.termYears, 5);
  check(
    'note names the original-owner condition',
    unknown.notes.some((n) => /original owner/.test(n)),
    unknown.notes.join(' | ')
  );

  const original = deriveWarranty({ ...base, original_owner: true }, '2026-09-16');
  eq('confirmed original owner: full term', original.termYears, 10);

  const subsequent = deriveWarranty({ ...base, original_owner: false }, '2026-09-16');
  eq('confirmed subsequent owner: capped at floor, not the full term', subsequent.termYears, 5);
}

/* --------------------------------------------- Rheem / Ruud: model dependence */
{
  for (const brand of ['Rheem', 'Ruud']) {
    const base = { manufacturer: brand, installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' };
    const unknown = deriveWarranty(base, '2026-09-16');
    eq(`${brand}: model qualification unknown, floor used`, unknown.termYears, 5);
    check(
      `${brand}: note explains the model dependence`,
      unknown.notes.some((n) => /qualifies/.test(n)),
      unknown.notes.join(' | ')
    );

    const qualifies = deriveWarranty({ ...base, model_qualifies_extended_warranty: true }, '2026-09-16');
    eq(`${brand}: qualifying model earns the full term`, qualifies.termYears, 10);
  }
}

/* --------------------------------------------- Daikin: owner-occupied condition */
{
  const base = { manufacturer: 'Daikin', installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' };

  const unknown = deriveWarranty(base, '2026-09-16');
  eq('occupancy unknown: floor term, not a guess', unknown.termYears, 5);
  check(
    'note lists both the 12-year and 10-year branches',
    unknown.notes.some((n) => /owner-occupied/.test(n) && /not owner-occupied/.test(n)),
    unknown.notes.join(' | ')
  );
  check(
    "the entry-level no-extension line is disclosed as a caveat",
    unknown.notes.some((n) => /entry-level Daikin line has no registration-extension/.test(n)),
    unknown.notes.join(' | ')
  );

  const occupied = deriveWarranty({ ...base, owner_occupied: true }, '2026-09-16');
  eq('owner-occupied: the 12-year term', occupied.termYears, 12);
  eq('expiry follows the 12-year term', occupied.expires, '2036-03-04');

  const notOccupied = deriveWarranty({ ...base, owner_occupied: false }, '2026-09-16');
  eq('not owner-occupied: the 10-year term', notOccupied.termYears, 10);
}

/* ------------------------------------------ Lennox: caveats always disclosed */
{
  const w = deriveWarranty(
    { manufacturer: 'Lennox', installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' },
    '2026-09-16'
  );
  eq('Lennox Merit/Elite: full registered term computed plainly', w.termYears, 10);
  check('term is not marked conditional (this is the unconditional Merit/Elite rule)', w.termConditional === false);
  check(
    'jurisdiction auto-extension is disclosed, never silently applied',
    w.notes.some((n) => /CA, FL, GA, and Quebec/.test(n)),
    w.notes.join(' | ')
  );
  check(
    'Signature-line exclusion is disclosed',
    w.notes.some((n) => /Signature line/.test(n)),
    w.notes.join(' | ')
  );
}

/* ------------------------------- Payne: shares Carrier's certificate and caveats */
{
  const w = deriveWarranty(
    { manufacturer: 'Payne', installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' },
    '2026-09-16'
  );
  eq('Payne: election unknown, floor used like Carrier', w.termYears, 5);
  check(
    'shared-certificate provenance is disclosed',
    w.notes.some((n) => /Carrier.*CDN/.test(n)),
    w.notes.join(' | ')
  );
}

/* ------------------------------------------------------- expired but conditional */
{
  // Registered, election/model/occupancy unknown, long since expired on the
  // floor term. The message must not claim the floor is definitely the whole
  // story when a higher term is still possible.
  const w = deriveWarranty(
    { manufacturer: 'Carrier', installation_date: '2010-01-01', warranty_registered_date: '2010-01-05' },
    '2026-09-16'
  );
  check('reported expired on the floor', /expired/.test(w.action || ''), w.action);
  check(
    'caveat says coverage may run longer, pending confirmation',
    /Coverage may run longer/.test(w.action || ''),
    w.action
  );
}

/* ------------------------------------------------------- missing inputs */
{
  const w = deriveWarranty({ manufacturer: 'Goodman' }, '2026-09-16');
  eq('no install date, no deadline', w.registrationDeadline, null);
  check('missing install noted', w.notes.some((n) => /No installation date on file/.test(n)));
}
{
  const w = deriveWarranty({}, '2026-09-16');
  check('empty facts are safe', w.expires === null && w.action === null && w.brand === null);
}
{
  const w = deriveWarranty({ manufacturer: 'Goodman', installation_date: '2026-08-06' }, null);
  eq('no today means no countdown', w.daysToRegister, null);
  eq('state stays unknown without today', w.registrationState, 'unknown');
  check('but the deadline is still knowable', w.registrationDeadline === '2026-10-05');
}

/* ------------------------------------------------------------ leap years */
{
  const w = deriveWarranty(
    { manufacturer: 'Goodman', installation_date: '2024-02-29', warranty_registered_date: '2024-03-01' },
    '2026-09-16'
  );
  eq('leap day clamps to Feb 28', w.expires, '2034-02-28');
}

/* ------------------------------------------------------- expiry messaging */
{
  const w = deriveWarranty(
    { manufacturer: 'Trane', installation_date: '2021-10-01', warranty_registered_date: '2021-10-05' },
    '2031-06-01'
  );
  check('expiring soon flagged as an opportunity', /extended-warranty opportunity/.test(w.action || ''), w.action);
  check('computed expiry is labelled as computed', /\(computed\)/.test(w.action || ''), w.action);
}
{
  const w = deriveWarranty(
    { manufacturer: 'Trane', installation_date: '2010-01-01', warranty_registered_date: '2010-01-05' },
    '2026-09-16'
  );
  check('expired reported', /expired/.test(w.action || ''), w.action);
}

/* ------------------------------ caller's expiry horizon must be honoured */
{
  // ~2.7 years out. Under the old hardcoded 365-day threshold this produced no
  // action, so the endpoint fetched the row and then silently dropped it.
  const stable = deriveWarranty(
    { manufacturer: 'Trane', installation_date: '2021-06-01', warranty_registered_date: '2021-06-05' }
  );
  const near = describeWarranty(stable, '2028-10-01');
  eq('outside default horizon, no action', near.action, null);

  const wide = describeWarranty(stable, '2028-10-01', { expiringWithinDays: 1200 });
  check('wide horizon produces an action', /extended-warranty opportunity/.test(wide.action || ''), wide.action);
  eq('urgency set', wide.urgency, 'expiring');
}

/* ------------------------------------------------------ date validation */

check('real date accepted', isValidYmd('2024-02-29'));
check('impossible day rejected', !isValidYmd('2024-02-30'));
check('month 13 rejected', !isValidYmd('2024-13-40'));
check('wrong shape rejected', !isValidYmd('3/4/2024'));
check('empty rejected', !isValidYmd(''));

/* --------------------------------------------------------- rule coverage */
{
  const c = ruleCoverage();
  check('every verified rule carries a source URL', c.verified.every((v) => /^https:\/\//.test(v.source || '')));
  check('coverage counts agree', c.verifiedCount === c.verified.length && c.totalCount === Object.keys(BRAND_RULES).length);
  check('unverified brands are listed, not hidden', c.unverified.length > 0);
  check('York is still unverified', c.unverified.some((v) => v.brand === 'york'));
  check('every verified brand carries a confidence rating', c.verified.every((v) => v.confidence === 'high' || v.confidence === 'medium'));
  check(
    'Ruud is flagged medium confidence (window carried over from Rheem)',
    c.verified.find((v) => v.brand === 'ruud')?.confidence === 'medium'
  );
  check(
    'brands verified to full confidence are not downgraded',
    c.verified.find((v) => v.brand === 'goodman')?.confidence === 'high'
  );
  const conditionalBrands = c.conditional.map((v) => v.brand).sort();
  eq(
    'conditional-term brands are listed by name, not silently lumped into "verified"',
    conditionalBrands,
    ['bryant', 'carrier', 'daikin', 'mitsubishi', 'payne', 'rheem', 'ruud']
  );
  console.log(`      (${c.verifiedCount} of ${c.totalCount} brands verified, ${c.conditional.length} of those condition-gated)`);
}

/* ------------------------------------------------------ new verified brands */

eq('Heil normalizes', normalizeBrand('Heil'), 'heil');
eq('Tempstar normalizes', normalizeBrand('Tempstar'), 'tempstar');
eq('Comfortmaker normalizes', normalizeBrand('Comfortmaker'), 'comfortmaker');
eq('KeepRite normalizes', normalizeBrand('KeepRite'), 'keeprite');
eq('Arcoaire normalizes', normalizeBrand('Arcoaire'), 'arcoaire');
eq('Day & Night alias resolves (ampersand cleaned to space)', normalizeBrand('Day & Night'), 'day and night');
eq('Armstrong Air normalizes', normalizeBrand('Armstrong'), 'armstrong');
eq('AirEase normalizes', normalizeBrand('AirEase'), 'airease');
eq('Ducane normalizes', normalizeBrand('Ducane'), 'ducane');
eq('Napoleon normalizes', normalizeBrand('Napoleon'), 'napoleon');
eq('Mitsubishi Electric alias still resolves', normalizeBrand('Mitsubishi Electric'), 'mitsubishi');

{
  // Heil/Tempstar: 90-day window, same shape as Carrier's floor, but a plain
  // (unconditional) 10-year registered term — no election gate.
  for (const brand of ['Heil', 'Tempstar', 'Comfortmaker', 'Day and Night', 'KeepRite', 'Arcoaire']) {
    const w = deriveWarranty(
      { manufacturer: brand, installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' },
      '2026-09-16'
    );
    eq(`${brand}: unconditional 10-year registered term`, w.termYears, 10);
    check(`${brand}: not flagged conditional`, w.termConditional === false);
  }
}

{
  // Armstrong/AirEase/Ducane: 60-day window like Lennox, plain 5/10.
  for (const brand of ['Armstrong', 'AirEase', 'Ducane', 'Napoleon']) {
    const w = deriveWarranty({ manufacturer: brand, installation_date: '2026-08-06' }, '2026-09-16');
    eq(`${brand}: 60-day window`, w.registrationDeadline, '2026-10-05');
    eq(`${brand}: 5-year unregistered floor`, w.termYears, 5);
  }
}

{
  // Mitsubishi: 90-day window, floor 5, registered term gated on owner-
  // occupied (contractor tier not modeled, so the ceiling here is 10, not 12).
  const base = { manufacturer: 'Mitsubishi', installation_date: '2024-03-04', warranty_registered_date: '2024-03-10' };
  const unknown = deriveWarranty(base, '2026-09-16');
  eq('Mitsubishi: occupancy unknown, floor used', unknown.termYears, 5);
  check('Mitsubishi: note explains the owner-occupied gate', unknown.notes.some((n) => /owner-occupied/.test(n)));

  const occupied = deriveWarranty({ ...base, owner_occupied: true }, '2026-09-16');
  eq('Mitsubishi: owner-occupied earns the modeled 10-year ceiling', occupied.termYears, 10);
}

{
  // York/Coleman/Luxaire, Fujitsu, Bosch, Maytag, Nordyne remain unmodeled —
  // each for a different, documented reason (see warrantyRules.js comments).
  for (const brand of ['York', 'Coleman', 'Luxaire', 'Fujitsu', 'Bosch', 'Maytag', 'Nordyne']) {
    const w = deriveWarranty({ manufacturer: brand, installation_date: '2026-08-06' }, '2026-09-16');
    check(`${brand}: still unverified, computes nothing`, w.brandVerified === false && w.expires === null);
  }
}

/* --------------------------------------------------------------- alertTier */

{
  const stableExpired = { expires: '2026-01-01', registrationOnFile: '2020-01-01', registrationDeadline: null };
  eq('alertTier: expired', alertTier(stableExpired, '2026-09-16'), 'expired');

  const mk = (daysOut) => ({ expires: addDays('2026-09-16', daysOut), registrationOnFile: '2020-01-01', registrationDeadline: null });
  eq('alertTier: 0 days out is expiring-30 (boundary)', alertTier(mk(0), '2026-09-16'), 'expiring-30');
  eq('alertTier: 30 days out is expiring-30 (boundary)', alertTier(mk(30), '2026-09-16'), 'expiring-30');
  eq('alertTier: 31 days out is expiring-90', alertTier(mk(31), '2026-09-16'), 'expiring-90');
  eq('alertTier: 90 days out is expiring-90 (boundary)', alertTier(mk(90), '2026-09-16'), 'expiring-90');
  eq('alertTier: 91 days out is expiring-365', alertTier(mk(91), '2026-09-16'), 'expiring-365');
  eq('alertTier: 365 days out is expiring-365 (boundary)', alertTier(mk(365), '2026-09-16'), 'expiring-365');
  eq('alertTier: 366 days out is ok', alertTier(mk(366), '2026-09-16'), 'ok');

  const stableNoData = { expires: null, registrationOnFile: null, registrationDeadline: null };
  eq('alertTier: no dates at all is unknown', alertTier(stableNoData, '2026-09-16'), 'unknown');
  eq('alertTier: no today is unknown', alertTier(mk(10), null), 'unknown');
  eq('alertTier: implausible today is unknown', alertTier(mk(10), '1000-01-01'), 'unknown');

  // Registration window closing takes priority over a far-off computed expiry
  // (the floor term's expiry can be years away while the deadline to earn the
  // long term is imminent).
  const stableRegClosing = {
    expires: '2031-08-06', // 5-year floor, still years off
    registrationOnFile: null,
    registrationDeadline: addDays('2026-09-16', 10),
  };
  eq('alertTier: registration closing beats a distant expiry', alertTier(stableRegClosing, '2026-09-16'), 'unregistered-window-closing');

  // ...but only while the deadline hasn't actually passed yet.
  const stableRegPast = { ...stableRegClosing, registrationDeadline: addDays('2026-09-16', -1) };
  check('alertTier: a deadline already missed is not "closing"', alertTier(stableRegPast, '2026-09-16') !== 'unregistered-window-closing');

  // Already registered: the deadline is moot even if it's within 30 days.
  const stableRegistered = { ...stableRegClosing, registrationOnFile: '2024-03-05' };
  check('alertTier: on-file registration ignores the deadline', alertTier(stableRegistered, '2026-09-16') !== 'unregistered-window-closing');
}

/* ------------------------------------------------------------------ upsell */

{
  const w = deriveWarranty({ manufacturer: 'Goodman', installation_date: '2010-01-01', warranty_registered_date: '2010-01-05' }, '2026-09-16');
  const u = upsell(w, '2026-09-16');
  check('upsell: expired verified-brand unit is eligible', u.eligible === true);
  check('upsell: reason names expiry', /expired/i.test(u.reason));
  check('upsell: reason also names the parts-only gap', /parts only/i.test(u.reason));
}
{
  // Well within warranty (5+ years left) but still a verified brand: eligible
  // on the standing parts-only labor-gap reason alone.
  const w = deriveWarranty({ manufacturer: 'Trane', installation_date: '2026-06-01', warranty_registered_date: '2026-06-05' }, '2026-09-16');
  const u = upsell(w, '2026-09-16');
  check('upsell: far from expiry but verified brand is still eligible (parts-only gap)', u.eligible === true);
  check('upsell: reason does not falsely claim expiry proximity', !/expires within/i.test(u.reason));
}
{
  // Unverified brand, no printed expiry at all: no evidence, not eligible.
  const w = deriveWarranty({ manufacturer: 'Frobozz Cooling', installation_date: '2026-06-01' }, '2026-09-16');
  const u = upsell(w, '2026-09-16');
  check('upsell: no evidence means not eligible', u.eligible === false);
}
{
  const w = deriveWarranty({ manufacturer: 'Rheem', installation_date: '2020-01-01', warranty_expires: '2027-01-01' }, '2026-09-16');
  const u = upsell(w, '2026-09-16');
  check('upsell: printed expiry within a year is eligible even for a conditional brand', u.eligible === true);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll warranty checks passed.');
process.exit(failures ? 1 : 0);
