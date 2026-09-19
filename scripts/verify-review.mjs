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
  eq('reclassifyDocuments no-ops on an empty id list without a db call', result, { changes: [] });
}
{
  const result = await reclassifyDocuments({ tenantKey: 'unused' }, {});
  eq('reclassifyDocuments no-ops with no documentIds at all', result, { changes: [] });
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
