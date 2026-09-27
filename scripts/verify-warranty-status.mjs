/**
 * R16 D2 audit item 1 — regression guard for the warranty-status bug fix.
 *
 * Root cause (see api/_lib/analytics.js's warrantyStatusOf doc comment): the
 * "coverage status" a dispatcher asks about ("is this unit still under
 * warranty") was being computed from warrantyRules.alertTier(), which folds
 * in a SEPARATE signal — a REGISTRATION-PAPERWORK deadline closing within 30
 * days — ahead of the actual coverage-expiry bucket. A unit years from
 * expiring but with an unregistered 60/90-day window about to close came
 * back "expiring", wrong by years, on every consumer that reuses
 * warrantyStatusOf: rollups (api/_lib/rollups/refresh.js), rankings
 * (api/_lib/rankings.js), compose.js, agent/tools.js, customerFile.js,
 * graph/query.js.
 *
 * This file tests the fix END TO END through the REAL derivation pipeline
 * (deriveWarranty -> warrantyStatusOf), not hand-built stand-ins for
 * `warranty`, so a future change to either function is caught the same way
 * the original bug would have been. Pure: no database, no network, no model.
 *
 *   node scripts/verify-warranty-status.mjs
 */
import { deriveWarranty } from '../api/_lib/warrantyRules.js';
import { warrantyStatusOf, registrationActionNeededOf } from '../api/_lib/analytics.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DAY = 86_400_000;
function addDaysUtc(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * DAY;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/* ============================================================ 1. the exact golden-export shape */
// unit id 2af10100-... (customer Robert Thornton), warranty.expires=2031-08-28 (>1800 days out,
// oracle bucket = active), registrationDeadline ~2026-10-27 (~31 days out from the D2 audit's own
// measurement date, unregistered). Reconstructed here via the REAL deriveWarranty pipeline: a Trane
// unit installed 60 days minus a hair before today, unregistered.
{
  const TODAY = '2026-09-26';
  // registrationWindowDays for Trane is 60; install date chosen so the 60-day deadline lands 29
  // days from TODAY (well inside alertTier's 30-day "closing" window), while the computed 5-year
  // unregistered expiry sits ~1797 days out — the exact shape of the golden-export bug.
  const installDate = addDaysUtc(TODAY, -(60 - 29)); // deadline = installDate + 60 = TODAY + 29
  const facts = { manufacturer: 'Trane', installation_date: installDate };
  const warranty = deriveWarranty(facts, null); // ingestion stores dates WITHOUT a clock, same as extractDocument.js

  const daysToDeadline = Math.round((Date.parse(warranty.registrationDeadline) - Date.parse(TODAY)) / DAY);
  eq('setup sanity: registration deadline really is 29 days from today', daysToDeadline, 29);
  check('setup sanity: expiry really is years out (unregistered 5-year floor)', warranty.expires > '2031-01-01', warranty.expires);

  eq('THE FIX: warrantyStatusOf reads "active" (years from expiring), not "expiring"', warrantyStatusOf(warranty, TODAY), 'active');
  check('THE FIX preserves the SEPARATE registration signal: registrationActionNeededOf is still true', registrationActionNeededOf(warranty, TODAY) === true);
}

/* ============================================================ 2. date-robust boundary sweep */
// "Date-robust" per the round contract: pin `today` and sweep the boundary from both sides, for
// BOTH signals independently (registration-deadline days-out, and expiry days-out), never
// hand-picking one date that happens to work.
{
  const TODAY = '2026-01-15';
  for (const regDays of [0, 1, 29, 30, 31, 45, 90]) {
    // Unregistered, expiry pinned far out (2035) regardless of the registration deadline — every
    // one of these must read "active": the registration signal must NEVER leak into this bucket,
    // whatever its own day-count is (inside, at, or outside alertTier's own 30-day window).
    const w = deriveWarranty(
      { manufacturer: 'Goodman', installation_date: addDaysUtc(TODAY, regDays - 60), warranty_expires: '2035-01-01' },
      null
    );
    eq(`registration due in ${regDays} day(s), expiry pinned far out (2035) -> always active`, warrantyStatusOf(w, TODAY), 'active');
    const shouldFlagRegistration = regDays >= 0 && regDays <= 30;
    check(
      `registrationActionNeededOf(${regDays}d) is ${shouldFlagRegistration} (independent of warrantyStatusOf)`,
      registrationActionNeededOf(w, TODAY) === shouldFlagRegistration
    );
  }

  // Expiry-side boundary, registration fully on file and irrelevant (registeredInTime true, so no
  // registration signal can fire at all) — 364/365/366 days out around the oracle's own <=365 cutoff.
  for (const [expDays, want] of [[-1, 'expired'], [0, 'expiring'], [364, 'expiring'], [365, 'expiring'], [366, 'active']]) {
    const install = '2020-01-01';
    const w = deriveWarranty(
      { manufacturer: 'Goodman', installation_date: install, warranty_registered_date: addDaysUtc(install, 5), warranty_expires: addDaysUtc(TODAY, expDays) },
      null
    );
    eq(`expiry ${expDays} day(s) out (registered, no registration signal possible) -> ${want}`, warrantyStatusOf(w, TODAY), want);
  }
}

/* ============================================================ 3. unaffected paths stay unaffected */
{
  const TODAY = '2026-09-26';
  check('unknown brand -> still unknown (no crash, no guess)', warrantyStatusOf(deriveWarranty({ manufacturer: 'Frobozz Cooling', installation_date: '2020-01-01' }, null), TODAY) === 'unknown');
  check('no data at all -> unknown', warrantyStatusOf(deriveWarranty({}, null), TODAY) === 'unknown');
  check('null warranty -> unknown', warrantyStatusOf(null, TODAY) === 'unknown');
  check('no today -> unknown (never guesses urgency with no clock)', warrantyStatusOf({ expires: '2030-01-01' }, null) === 'unknown');
  check('implausible today -> unknown', warrantyStatusOf({ expires: '2030-01-01' }, '1000-01-01') === 'unknown');
  // A printed expiry (never computed) is completely unaffected by the registration signal either way.
  const printed = deriveWarranty({ manufacturer: 'Carrier', installation_date: '2020-01-01', warranty_expires: '2031-01-01' }, null);
  eq('printed expiry, unregistered Carrier with a closing deadline -> still active (printed expiry always wins)', warrantyStatusOf(printed, TODAY), 'active');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll warranty-status checks passed.');
process.exit(failures ? 1 : 0);
