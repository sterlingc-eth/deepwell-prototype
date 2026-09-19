/**
 * Unit checks for the review state machine. No database, no network.
 *
 * What this guards: reviewStore.js enforces every transition in SQL
 * (`WHERE stage = '...'`), but the RULE that SQL encodes — a document needs a
 * link before it can verify, a correction on a verified document drops it
 * back to linked — is worth pinning as a plain function too, so a future edit
 * to the SQL can be checked against the same rule without a database.
 *
 *   node scripts/verify-review.mjs
 */
import {
  isUuid,
  isNonEmptyString,
  assertUuid,
  assertNonEmptyString,
  canVerify,
  nextStageAfterCorrection,
  wasClassifiedByHuman,
  modelCallBudget,
  MODEL_CALL_MIN_BUDGET_MS,
  MODEL_CALL_MAX_TIMEOUT_MS,
  ReviewError,
  aiVerifyDocument,
  reclassifyDocuments,
} from '../api/_lib/reviewStore.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* --------------------------------------------------------------- isUuid */

eq('a real uuid passes', isUuid('3fa85f64-5717-4562-b3fc-2c963f66afa6'), true);
eq('a real uppercase uuid passes', isUuid('3FA85F64-5717-4562-B3FC-2C963F66AFA6'), true);
eq('a plain string fails', isUuid('not-a-uuid'), false);
eq('an empty string fails', isUuid(''), false);
eq('null fails', isUuid(null), false);
eq('undefined fails', isUuid(undefined), false);
eq('a number fails (not even a string)', isUuid(12345), false);
eq('a uuid missing a segment fails', isUuid('3fa85f64-5717-4562-b3fc'), false);
eq('sql-injection-shaped text fails', isUuid("' OR '1'='1"), false);

/* --------------------------------------------------------- isNonEmptyString */

eq('a real string passes', isNonEmptyString('hello'), true);
eq('whitespace-only string fails (nothing to store)', isNonEmptyString('   '), false);
eq('empty string fails', isNonEmptyString(''), false);
eq('null fails', isNonEmptyString(null), false);
eq('a number fails (not a string)', isNonEmptyString(42), false);

/* -------------------------------------------------------------- assertUuid */

{
  let threw = false;
  try {
    assertUuid('documentId', 'not-a-uuid');
  } catch (err) {
    threw = err instanceof ReviewError && err.status === 400;
  }
  check('assertUuid throws a 400 ReviewError on a bad id', threw);
}
{
  let threw = false;
  try {
    assertUuid('documentId', '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  } catch {
    threw = true;
  }
  check('assertUuid is silent on a good id', !threw);
}

/* ------------------------------------------------------ assertNonEmptyString */

{
  let threw = false;
  try {
    assertNonEmptyString('value', '  ');
  } catch (err) {
    threw = err instanceof ReviewError && err.status === 400;
  }
  check('assertNonEmptyString throws a 400 ReviewError on blank input', threw);
}

/* -------------------------------------------------------------- canVerify */

eq('linked with one link can verify', canVerify({ stage: 'linked' }, [{ id: '1' }]), true);
eq('linked with several links can verify', canVerify({ stage: 'linked' }, [{ id: '1' }, { id: '2' }]), true);
eq('linked with zero links cannot verify — the whole point of this build', canVerify({ stage: 'linked' }, []), false);
eq('mapped (not yet linked) cannot verify even with a link row', canVerify({ stage: 'mapped' }, [{ id: '1' }]), false);
eq('already verified cannot "verify" again through this check', canVerify({ stage: 'verified' }, [{ id: '1' }]), false);
eq('received cannot verify', canVerify({ stage: 'received' }, [{ id: '1' }]), false);
eq('a missing document cannot verify', canVerify(null, [{ id: '1' }]), false);
eq('a missing document cannot verify (undefined)', canVerify(undefined, [{ id: '1' }]), false);
eq('a non-array links value cannot verify', canVerify({ stage: 'linked' }, null), false);
eq('a non-array links value cannot verify (undefined)', canVerify({ stage: 'linked' }, undefined), false);

/* ------------------------------------------------------ nextStageAfterCorrection */

eq('correcting a verified document drops it to linked', nextStageAfterCorrection('verified'), 'linked');
eq('correcting a linked document leaves it linked', nextStageAfterCorrection('linked'), 'linked');
eq('correcting a mapped document leaves it mapped', nextStageAfterCorrection('mapped'), 'mapped');
eq('correcting a read document leaves it read', nextStageAfterCorrection('read'), 'read');
eq('correcting a received document leaves it received', nextStageAfterCorrection('received'), 'received');
// Idempotent: applying it twice must not fall through to 'received' or anywhere else.
eq('applying the rule twice from verified settles at linked, not further', nextStageAfterCorrection(nextStageAfterCorrection('verified')), 'linked');

/* ------------------------------------------------------- wasClassifiedByHuman */

eq('no classification rows -> not human-classified', wasClassifiedByHuman('other', []), false);
eq('no classification rows (undefined) -> not human-classified', wasClassifiedByHuman('other', undefined), false);
eq(
  'a row matching the CURRENT type -> human-classified, do not touch',
  wasClassifiedByHuman('work-order', [{ changes: { documentType: 'work-order' } }]),
  true
);
eq(
  "a human picking 'other' is never protective — still reclassifiable",
  wasClassifiedByHuman('other', [{ changes: { documentType: 'other' } }]),
  false
);
eq(
  'a row for a DIFFERENT type than current -> not a match, safe to reclassify',
  wasClassifiedByHuman('other', [{ changes: { documentType: 'work-order' } }]),
  false
);
eq(
  'most recent of several rows is the one that matches',
  wasClassifiedByHuman('invoice', [{ changes: { documentType: 'other' } }, { changes: { documentType: 'invoice' } }]),
  true
);
eq('a row with no changes payload is safe', wasClassifiedByHuman('other', [{}]), false);
eq('a null row in the list is safe', wasClassifiedByHuman('other', [null]), false);

/* ------------------------------------------------------------ modelCallBudget */
// The fix for the NO-GO blocker: 20 sequential model calls must never be able
// to run past api/review.js's 60s function ceiling.

eq('plenty of time left -> capped at MAX, not the full remainder', modelCallBudget(45_000), MODEL_CALL_MAX_TIMEOUT_MS);
eq('remainder smaller than the cap -> use the remainder', modelCallBudget(10_000), 10_000);
eq('exactly at the minimum budget -> still allowed', modelCallBudget(MODEL_CALL_MIN_BUDGET_MS), MODEL_CALL_MIN_BUDGET_MS);
eq('just under the minimum -> refuse (null), count toward remaining', modelCallBudget(MODEL_CALL_MIN_BUDGET_MS - 1), null);
eq('no time left -> refuse', modelCallBudget(0), null);
eq('negative remaining (deadline already passed) -> refuse', modelCallBudget(-500), null);
eq('NaN is safe and refuses', modelCallBudget(NaN), null);
eq('undefined is safe and refuses', modelCallBudget(undefined), null);
check('a granted budget never exceeds the per-call cap', modelCallBudget(999_999) <= MODEL_CALL_MAX_TIMEOUT_MS);

/* --------------------------------------------------- new review.js actions */
// No database here — this just pins the module's public shape and its
// no-DB-call fast paths, so a signature change or a broken import surfaces
// without needing Postgres. Full behavior is covered by documentTypes.js's
// own tests (verify-doctypes.mjs) plus manual/staging verification against
// Neon, per the team brief's "no DDL, no live DB in verify scripts" rule.
check('aiVerifyDocument is exported as a function', typeof aiVerifyDocument === 'function');
check('reclassifyDocuments is exported as a function', typeof reclassifyDocuments === 'function');

{
  // Empty/no-id input must short-circuit before ever touching the database.
  const result = await reclassifyDocuments({ tenantKey: 'unused' }, { documentIds: [] });
  eq('reclassifyDocuments no-ops on an empty id list without a db call', result, { changes: [], remaining: 0 });
}
{
  const result = await reclassifyDocuments({ tenantKey: 'unused' }, {});
  eq('reclassifyDocuments no-ops with no documentIds at all', result, { changes: [], remaining: 0 });
}

/* ----------------------------------------------- B1: reclassify's budget check
 * 2026-09-19 adversarial audit: reclassify's Haiku fallback was one of four
 * billed call sites with no daily-budget check. The check
 * (getDailyModelBudgetStatus, called once before the per-document loop) FAILS
 * OPEN with no database — same principle as every other rate/budget lookup in
 * this codebase — so a non-empty id list must still run to completion (every
 * per-document DB call also fails, is caught, and is skipped) rather than the
 * new budget check itself becoming a new way for this endpoint to throw. */
{
  let threw = null;
  let result;
  try {
    result = await reclassifyDocuments({ tenantKey: 'unused' }, {
      documentIds: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    });
  } catch (err) {
    threw = err;
  }
  check('reclassifyDocuments does not throw when the budget check has no database (fails open)', threw === null, threw?.message);
  eq('a non-empty id list with no reachable database yields no changes, nothing left pending',
    result, { changes: [], remaining: 0 });
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
