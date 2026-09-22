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
  shouldClassifyAsShopInternal,
  modelCallBudget,
  MODEL_CALL_MIN_BUDGET_MS,
  MODEL_CALL_MAX_TIMEOUT_MS,
  ReviewError,
  aiVerifyDocument,
  reclassifyDocuments,
  extractReminders,
  normalizeFieldsForReminder,
  findExistingByAddress,
} from '../api/_lib/reviewStore.js';
import { normalizeAddressKey } from '../api/_lib/integrity.js';
import { isShopInternalDocument } from '../api/_lib/documentTypes.js';
import { normalizeReminderTrigger } from '../api/_lib/extractFields.js';
import { APPLY_ACTIONS, ADMIN_ONLY_ACTIONS } from '../api/_lib/routes/integrity.js';
import { resolveOpenReminders, shapeReminderRow, listOpenReminders, REMINDER_ELIGIBLE_DOCUMENT_TYPES } from '../api/_lib/reminders.js';
import { findCustomerNameCandidates, findCustomerByReminderName } from '../api/_lib/recordsStore.js';

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

/* ---------------------------------------------- shop-internal reclassification
 * Round 5 (2026-09-22): live founder-account documents ingested before the
 * 'internal' type existed — "143-dispatch-note-shop-truck.txt" and
 * "144-other-parts-count.pdf" — typed as canonical (dispatch-note,
 * correspondence), naming no customer, stuck in Needs Linking forever.
 * isShopInternalDocument's own exhaustive field-shape tests live in
 * verify-doctypes.mjs; these two pin the exact live shapes by name. */
const f = (key, value) => ({ field_key: key, value });

check(
  '143-dispatch-note-shop-truck.txt shape (shop_address/shop_phone + a free-text note) is shop-internal',
  isShopInternalDocument([f('shop_address', '2210 E Main St, Mesa AZ'), f('shop_phone', '(480) 555-0199'), f('notes', 'Truck 3 dispatched for parts run')])
);
check(
  '144-other-parts-count.pdf shape (shop_address/shop_phone + free text, no customer) is shop-internal',
  isShopInternalDocument([f('shop_address', '2210 E Main St, Mesa AZ'), f('shop_phone', '(480) 555-0199'), f('notes', 'Counted 40 capacitors in stock')])
);
check(
  'a dispatch note that NAMES A CUSTOMER is not shop-internal, even with shop_* fields present',
  !isShopInternalDocument([f('shop_address', '2210 E Main St, Mesa AZ'), f('customer_name', 'Plaza Dental'), f('service_date', '2026-09-10')])
);

/* ------------------------------------------------ shouldClassifyAsShopInternal
 * Pure combination of the three guards reclassifyDocuments/classifyShopRecords
 * apply: no customer link, never human-classified, and the shop-internal
 * shape itself. Each guard is checked independently, then all three together. */
eq(
  'all three conditions met -> classify',
  shouldClassifyAsShopInternal({ humanClassified: false, hasCustomerLink: false, isShopInternal: true }),
  true
);
eq(
  'human-classified guard: a human decision blocks it even though it looks shop-internal',
  shouldClassifyAsShopInternal({ humanClassified: true, hasCustomerLink: false, isShopInternal: true }),
  false
);
eq(
  'no-customer guard: an existing direct customer link blocks it even though it looks shop-internal',
  shouldClassifyAsShopInternal({ humanClassified: false, hasCustomerLink: true, isShopInternal: true }),
  false
);
eq(
  'not shop-internal-shaped at all -> never classify, regardless of the other two guards',
  shouldClassifyAsShopInternal({ humanClassified: false, hasCustomerLink: false, isShopInternal: false }),
  false
);
eq(
  'every guard failing at once -> classify is still refused (not merely one wrong reason)',
  shouldClassifyAsShopInternal({ humanClassified: true, hasCustomerLink: true, isShopInternal: false }),
  false
);

/* ------------------------------------------------------- classifyShopRecords
 * routes/integrity.js's APPLY_ACTIONS/ADMIN_ONLY_ACTIONS membership — pins
 * "classifyShopRecords is a fixable action, gated the same plain
 * effectiveDryRun way as healSplitUnits/refillCustomerContacts, not the
 * admin-only ask-twice gate mergeDuplicates/retireShopCustomers use." */
check('classifyShopRecords is an applyable integrity fix', APPLY_ACTIONS.has('classifyShopRecords'));
check('classifyShopRecords is NOT admin-gated (plain effectiveDryRun default, like every other additive fix)',
  !ADMIN_ONLY_ACTIONS.has('classifyShopRecords'));

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

/* ========================================================= CUSTOMER REMINDERS
 * Build 2026-09-22. Pure checks only, per the build brief: field parsing/
 * normalization, trigger parsing, the open/done resolution against a fake
 * db, and that a memo naming nobody never creates a customer.
 * ========================================================================= */

/* ---------------------------------------------------- normalizeReminderTrigger */
eq('reminder trigger "next_visit" passes through', normalizeReminderTrigger('next_visit'), 'next_visit');
eq('reminder trigger "Next Visit" (case/spacing) normalizes to next_visit', normalizeReminderTrigger('Next Visit'), 'next_visit');
eq('reminder trigger "next-visit" normalizes to next_visit', normalizeReminderTrigger('next-visit'), 'next_visit');
eq('reminder trigger "11/15/2026" normalizes to YYYY-MM-DD', normalizeReminderTrigger('11/15/2026'), '2026-11-15');
eq('reminder trigger "2026-11-15" passes through', normalizeReminderTrigger('2026-11-15'), '2026-11-15');
eq('reminder trigger month-only "11/2026" is refused (not a usable trigger)', normalizeReminderTrigger('11/2026'), null);
eq('reminder trigger empty/garbage -> null', normalizeReminderTrigger('sometime soon'), null);
eq('reminder trigger null/undefined -> null', normalizeReminderTrigger(undefined), null);

/* --------------------------------------------------- normalizeFieldsForReminder */
{
  const r = normalizeFieldsForReminder({
    reminder_text: 'confirm filter size on next visit',
    reminder_customer_name: 'Karen Abernathy',
    reminder_trigger: 'next_visit',
  });
  eq('normalizeFieldsForReminder keeps a well-formed reminder', r.fields, {
    reminder_text: 'confirm filter size on next visit',
    reminder_customer_name: 'Karen Abernathy',
    reminder_trigger: 'next_visit',
  });
}
{
  const longText = 'x'.repeat(300);
  const r = normalizeFieldsForReminder({ reminder_text: longText });
  eq('normalizeFieldsForReminder caps reminder_text at 200 chars', r.fields.reminder_text.length, 200);
}
{
  const r = normalizeFieldsForReminder({ reminder_trigger: 'next_visit' });
  eq('normalizeFieldsForReminder drops trigger with no reminder_text (meaningless alone)', r.fields, {
    reminder_text: null, reminder_customer_name: null, reminder_trigger: null,
  });
}
{
  const r = normalizeFieldsForReminder({});
  eq('normalizeFieldsForReminder on an empty tool call keeps nothing', r.fields, {
    reminder_text: null, reminder_customer_name: null, reminder_trigger: null,
  });
}

/* --------------------------------------------------------- resolveOpenReminders */
{
  const rows = [
    { documentId: 'd1', reminderText: 'confirm filter size' },
    { documentId: 'd2', reminderText: 'check capacitor' },
  ];
  eq('resolveOpenReminders: no done rows -> everything stays open', resolveOpenReminders(rows, []), rows);
  eq('resolveOpenReminders: one done id drops just that reminder',
    resolveOpenReminders(rows, ['d1']), [rows[1]]);
  eq('resolveOpenReminders: a done id for a document with no reminder is simply ignored',
    resolveOpenReminders(rows, ['not-a-reminder-doc']), rows);
  eq('resolveOpenReminders: every reminder done -> empty', resolveOpenReminders(rows, ['d1', 'd2']), []);
  eq('resolveOpenReminders: empty/undefined input is safe', resolveOpenReminders(undefined, undefined), []);
}

/* -------------------------------------------------------------- shapeReminderRow */
{
  const shaped = shapeReminderRow({
    document_id: 'd1', reminder_text: 'confirm filter size', reminder_trigger: 'next_visit',
    reminder_customer_name: 'Karen Abernathy', created_at: '2026-09-20', original_filename: '054-other-c10.pdf',
    document_type: 'other', customer_id: 'c1', customer_name: 'Karen Abernathy',
  });
  eq('shapeReminderRow maps a raw SQL row to the client shape', shaped, {
    documentId: 'd1', reminderText: 'confirm filter size', reminderTrigger: 'next_visit',
    reminderCustomerName: 'Karen Abernathy', createdAt: '2026-09-20', filename: '054-other-c10.pdf',
    documentType: 'other', customerId: 'c1', customerName: 'Karen Abernathy',
  });
}

/* -------------------------------------------------- listOpenReminders (fake db) */
{
  const reminderRow = {
    document_id: 'd1', reminder_text: 'confirm filter size', reminder_trigger: 'next_visit',
    reminder_customer_name: 'Karen Abernathy', created_at: '2026-09-20', original_filename: 'memo.pdf',
    document_type: 'other', customer_id: null, customer_name: null,
  };
  const calls = [];
  const fakeDb = {
    raw: async (sql) => {
      calls.push(sql);
      if (/FROM extractions rt/.test(sql)) return { rows: [reminderRow] };
      if (/FROM audit_log/.test(sql)) return { rows: [{ resource_id: 'd1' }] }; // this one is done
      return { rows: [] };
    },
  };
  const open = await listOpenReminders(fakeDb, { limit: 10 });
  eq('listOpenReminders drops a reminder whose document has a reminder.done row', open, []);
  check('listOpenReminders reads both the reminder query and the done-audit query', calls.length === 2);
}
{
  const reminderRow = {
    document_id: 'd2', reminder_text: 'check capacitor', reminder_trigger: null,
    reminder_customer_name: null, created_at: '2026-09-21', original_filename: 'dispatch.pdf',
    document_type: 'dispatch-note', customer_id: null, customer_name: null,
  };
  const fakeDb = {
    raw: async (sql) => (/FROM extractions rt/.test(sql) ? { rows: [reminderRow] } : { rows: [] }),
  };
  const open = await listOpenReminders(fakeDb, {});
  eq('listOpenReminders keeps a reminder with no matching done row', open.map((r) => r.documentId), ['d2']);
}

check('REMINDER_ELIGIBLE_DOCUMENT_TYPES covers the four memo-like types',
  ['correspondence', 'dispatch-note', 'other', 'internal'].every((t) => REMINDER_ELIGIBLE_DOCUMENT_TYPES.has(t)));
check('REMINDER_ELIGIBLE_DOCUMENT_TYPES excludes an ordinary form type',
  !REMINDER_ELIGIBLE_DOCUMENT_TYPES.has('invoice') && !REMINDER_ELIGIBLE_DOCUMENT_TYPES.has('work-order'));

/* -------------------------- a memo naming nobody never creates a customer */
{
  const calls = [];
  const fakeDb = {
    raw: async (sql, _params) => {
      calls.push(sql);
      return { rows: [] }; // no existing customer looks anything like this
    },
  };
  const match = await findCustomerByReminderName(fakeDb, '');
  eq('findCustomerByReminderName on an empty/no name never even queries', match, null);
  eq('...and issues no SQL at all for an empty name', calls.length, 0);
}
{
  const calls = [];
  const fakeDb = {
    raw: async (sql, _params) => { calls.push(sql); return { rows: [] }; },
  };
  const match = await findCustomerByReminderName(fakeDb, 'Karen Abernathy');
  eq('findCustomerByReminderName with zero matches returns null (never guesses, never creates)', match, null);
  check('findCustomerByReminderName issues only SELECTs, never a write',
    calls.length > 0 && calls.every((sql) => /^\s*SELECT/i.test(sql)),
    calls.join('\n'));
}
{
  // Two same-surname customers with no first-name agreement -> ambiguous,
  // still never auto-picked (findCustomerNameCandidates returns both; the
  // "never guess" call is the CALLER's, same contract findOrCreateCustomer's
  // own selectCustomerMatch documents).
  const rows = [
    { id: 'c1', customer_name: 'Karen Abernathy', service_address: null },
    { id: 'c2', customer_name: 'John Abernathy', service_address: null },
  ];
  const fakeDb = { raw: async () => ({ rows }) };
  const candidates = await findCustomerNameCandidates(fakeDb, 'Abernathy');
  check('findCustomerNameCandidates surfaces both ambiguous matches rather than picking one',
    candidates.length === 2, JSON.stringify(candidates));
  const resolved = await findCustomerByReminderName(fakeDb, 'Abernathy');
  eq('findCustomerByReminderName refuses to guess between 2+ candidates', resolved, null);
}

check('extractReminders is exported as a function', typeof extractReminders === 'function');
{
  const result = await extractReminders({ tenantKey: 'unused' }, { documentIds: [] });
  eq('extractReminders no-ops on an empty id list without a db call', result, { changes: [], remaining: 0 });
}
{
  let threw = null;
  let result;
  try {
    result = await extractReminders({ tenantKey: 'unused' }, {
      documentIds: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    });
  } catch (err) {
    threw = err;
  }
  check('extractReminders does not throw when the database is unreachable (fails open, per-document)', threw === null, threw?.message);
  eq('a non-empty id list with no reachable database yields no changes, nothing left pending',
    result, { changes: [], remaining: 0 });
}

/* ---------------------------------------------------- findExistingByAddress
 * Owner defect report (2026-09-22): the manual "Add customer" form must
 * check the normalized address BEFORE creating, and offer "Open it" / "Add
 * anyway" — this is the search createCustomer's pre-check runs, pinned
 * against a plain array so it's checkable with no database. */
{
  const rows = [
    { id: 'c1', customer_number: 'C-00010', name: 'Donna Thornton', address: '174 N College Ave, Mesa, AZ' },
    { id: 'c2', customer_number: 'C-00020', name: 'Desert Ridge Dental', address: '880 S Dobson Rd Suite 110, Chandler, AZ' },
  ];
  eq('finds the existing customer at a matching normalized address (city/state/zip and casing ignored)',
    findExistingByAddress(rows, normalizeAddressKey('174 N COLLEGE AVE'))?.id, 'c1');
  eq('a unit/suite marker on the new address does not stop it matching the same building',
    findExistingByAddress(rows, normalizeAddressKey('880 S Dobson Rd Suite 220, Chandler, AZ'))?.id, 'c2');
  eq('no match at an unrelated address -> null',
    findExistingByAddress(rows, normalizeAddressKey('1 Nowhere Ln, Tempe, AZ')), null);
  eq('an empty/unparseable address key never "matches" -> null', findExistingByAddress(rows, ''), null);
  eq('empty rows -> null', findExistingByAddress([], normalizeAddressKey('174 N College Ave, Mesa, AZ')), null);
  eq('null/undefined rows are safe -> null', findExistingByAddress(null, normalizeAddressKey('174 N College Ave, Mesa, AZ')), null);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
