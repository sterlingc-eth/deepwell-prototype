/**
 * Unit checks for the customer outreach engine (handoffs/OUTREACH_2026-09-20.md).
 * Pure functions only — no DB, no network, no Clerk.
 *
 *   node scripts/verify-outreach.mjs
 */
import {
  OUTREACH_TIERS,
  subjectFor,
  renderOutreachEmail,
  maskSerial,
  dedupeKey,
  isOptedOut,
  batchForSend,
  sweepAction,
  classifyCandidates,
  DEFAULT_OFFER_TEXT,
  assertEnabledForOp,
  assertModeAllowed,
  sendCapFor,
  SEND_BATCH_CAP,
} from '../api/_lib/outreach.js';
import { hasOutreachAutoEntitlement } from '../api/_lib/plan.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* --------------------------------------------------------------- tiers -- */

eq('OUTREACH_TIERS is exactly the three warranty-upsell tiers', [...OUTREACH_TIERS].sort(), ['expired', 'expiring-30', 'expiring-90'].sort());
check("registration-window tier is NOT an outreach tier (that's the bell's job)", !OUTREACH_TIERS.includes('unregistered-window-closing'));

/* ---------------------------------------------------------- tier -> subject */

for (const tier of OUTREACH_TIERS) {
  const s = subjectFor(tier, 'Acme HVAC');
  check(`subjectFor(${tier}) mentions the shop name`, s.includes('Acme HVAC'));
  check(`subjectFor(${tier}) is non-empty`, s.length > 0);
}
check('subjectFor: expired subject reads as expired, not "expiring"', subjectFor('expired', 'Acme').toLowerCase().includes('expired'));
check('subjectFor: expiring-30 subject mentions 30 days', subjectFor('expiring-30', 'Acme').includes('30'));
check('subjectFor: no shop name falls back to a generic phrase, never blank', subjectFor('expiring-90', null).length > 0);

/* ------------------------------------------------------------- maskSerial */

eq('maskSerial: null in, null out', maskSerial(null), null);
eq('maskSerial: empty string is null', maskSerial('  '), null);
eq('maskSerial: short serial is not truncated (nothing to hide)', maskSerial('AB12'), 'AB12');
eq('maskSerial: long serial keeps only the last 4', maskSerial('1234567890'), '••••7890');
check('maskSerial never returns the full serial for a long value', !maskSerial('SECRET1234567').includes('SECRET'));

/* -------------------------------------------------------- renderOutreachEmail */

{
  const { subject, bodyText, footer } = renderOutreachEmail({
    tier: 'expired',
    shopName: 'Acme HVAC',
    customerName: 'Jane Doe',
    manufacturer: 'Trane',
    model: 'XR16',
    serial: '1234567890',
    installDate: '2018-05-01',
    expiryDate: '2026-01-01',
    offerText: null,
    replyTo: 'service@acmehvac.com',
  });
  check('renderOutreachEmail: subject is non-empty', subject.length > 0);
  check('renderOutreachEmail: greets the customer by name', bodyText.includes('Jane Doe'));
  check('renderOutreachEmail: masks the serial (last 4 only)', bodyText.includes('7890') && !bodyText.includes('1234567890'));
  check('renderOutreachEmail: mentions the unit', bodyText.includes('Trane') && bodyText.includes('XR16'));
  check('renderOutreachEmail: includes the install date', bodyText.includes('2018-05-01'));
  check('renderOutreachEmail: falls back to the default offer text when none is set', bodyText.includes(DEFAULT_OFFER_TEXT));
  check('renderOutreachEmail: includes reply-to', bodyText.includes('service@acmehvac.com'));
  check('renderOutreachEmail: MANDATORY footer names the shop', footer.includes('Acme HVAC'));
  check('renderOutreachEmail: MANDATORY footer includes the STOP line', footer.includes('Reply STOP to opt out'));
  check('renderOutreachEmail: footer is present in the body sent to the customer', bodyText.includes('Reply STOP to opt out'));
}

{
  // No offer text override, no address on file — footer must still be present
  // and must never fabricate an address that wasn't supplied.
  const { footer } = renderOutreachEmail({ tier: 'expiring-90', shopName: 'Acme', customerName: null });
  check('renderOutreachEmail: footer present with no address on file', footer.includes('Reply STOP to opt out'));
  check('renderOutreachEmail: no address on file means none is fabricated', !footer.includes('undefined') && !footer.includes('null'));
}

{
  const { footer } = renderOutreachEmail({ tier: 'expired', shopName: 'Acme', address: '123 Main St, Springfield' });
  check('renderOutreachEmail: a supplied address is included in the footer', footer.includes('123 Main St, Springfield'));
}

check('renderOutreachEmail: missing customer name falls back to "there", never blank', renderOutreachEmail({ tier: 'expired', customerName: null }).bodyText.includes('Hi there,'));

/* --------------------------------------------- renderOutreachEmail: shop fields (REQUEST 2a) */
// "Donovan uses their information to draft the emails" — shop phone, sender
// name and a signature line distinct from just the shop name.

{
  const { bodyText } = renderOutreachEmail({
    tier: 'expiring-30',
    shopName: 'Acme HVAC',
    shopPhone: '555-0100',
    senderName: 'Dana',
    signature: 'Dana, Acme HVAC',
    customerName: 'Jane Doe',
    replyTo: 'help@acme.test',
  });
  check('renderOutreachEmail: body offers the shop phone as a way to reply', bodyText.includes('call us at 555-0100'));
  check('renderOutreachEmail: body still offers the reply-to email too', bodyText.includes('reach us at help@acme.test'));
  check('renderOutreachEmail: signs off with the signature line, not just the shop name', bodyText.includes('— Dana, Acme HVAC'));
}
{
  const { bodyText } = renderOutreachEmail({ tier: 'expiring-30', shopName: 'Acme HVAC', senderName: 'Dana', customerName: 'Jane' });
  check('renderOutreachEmail: falls back to the sender name when no signature line is set', bodyText.includes('— Dana') && !bodyText.includes('— Acme HVAC'));
}
{
  const { bodyText } = renderOutreachEmail({ tier: 'expired', shopName: 'Acme HVAC', customerName: 'Jane' });
  check('renderOutreachEmail: falls back to the shop name when neither sender name nor signature is set (unchanged default)', bodyText.includes('— Acme HVAC'));
  check('renderOutreachEmail: no shop phone set means no phone line is fabricated', !bodyText.includes('call us at'));
}

/* ------------------------------------------------------------- dedupeKey */

eq('dedupeKey: stable format', dedupeKey('equip-1', 'expiring-30'), 'equip-1:expiring-30');
check('dedupeKey: different tiers for the same unit are different keys', dedupeKey('equip-1', 'expiring-90') !== dedupeKey('equip-1', 'expiring-30'));
check('dedupeKey: different units at the same tier are different keys', dedupeKey('equip-1', 'expired') !== dedupeKey('equip-2', 'expired'));

/* ------------------------------------------------------------- isOptedOut */

check('isOptedOut: boolean true', isOptedOut({ opted_out: true }));
check('isOptedOut: string "true" (jsonb ->> round-trip)', isOptedOut({ opted_out: 'true' }));
check('isOptedOut: false by default', !isOptedOut({}));
check('isOptedOut: null data', !isOptedOut(null));
check('isOptedOut: string "false" is not opted out', !isOptedOut({ opted_out: 'false' }));

/* ------------------------------------------------------------- batchForSend */

eq('batchForSend: under the cap is unchanged', batchForSend([1, 2, 3], 50).length, 3);
eq('batchForSend: exactly at the cap is unchanged', batchForSend(Array.from({ length: 50 }, (_, i) => i), 50).length, 50);
eq('batchForSend: over the cap is truncated to exactly 50', batchForSend(Array.from({ length: 137 }, (_, i) => i), 50).length, 50);
eq('batchForSend: default cap is 50', batchForSend(Array.from({ length: 137 }, (_, i) => i)).length, 50);
eq('batchForSend: empty/undefined input', batchForSend(undefined, 50), []);

/* ------------------------------------------------------------- sweepAction */

eq('sweepAction: mode "auto" sends', sweepAction({ mode: 'auto' }), 'auto');
eq('sweepAction: mode "review" only drafts', sweepAction({ mode: 'review' }), 'review');
eq('sweepAction: missing/unknown mode defaults to review (the safe default)', sweepAction({}), 'review');
eq('sweepAction: null settings default to review', sweepAction(null), 'review');

/* --------------------------------------------------------- classifyCandidates */

{
  const items = [
    { entityId: 'eq-1', tier: 'expiring-90' },
    { entityId: 'eq-2', tier: 'expiring-30' },
    { entityId: 'eq-3', tier: 'expired' },
    { entityId: 'eq-4', tier: 'expiring-90' },
    { entityId: 'eq-5', tier: 'expiring-90' },
    { entityId: 'eq-6', tier: 'unregistered-window-closing' }, // not an outreach tier — ignored entirely
  ];
  const contacts = new Map([
    ['eq-1', { customerId: 'c-1', email: 'a@example.com', optedOut: false }],
    ['eq-2', { customerId: 'c-2', email: null, optedOut: false }], // needs email
    ['eq-3', { customerId: 'c-3', email: 'c@example.com', optedOut: true }], // opted out
    ['eq-4', { customerId: 'c-4', email: 'd@example.com', optedOut: false }], // already drafted
    // eq-5 has no contact row at all -> needs email
  ]);
  const existingKeys = new Set([dedupeKey('eq-4', 'expiring-90')]);
  const daysLeftByEntity = new Map([
    ['eq-1', 45],
    ['eq-2', 20],
    ['eq-3', null],
    ['eq-4', 10],
    ['eq-5', 200], // outside the 90-day lead window
  ]);

  const result = classifyCandidates(items, contacts, existingKeys, 90, daysLeftByEntity);
  eq('classifyCandidates: exactly one eligible candidate (eq-1)', result.eligible.map((e) => e.item.entityId), ['eq-1']);
  eq('classifyCandidates: needsEmail counts eq-2 (eq-5 is filtered earlier, by lead window)', result.needsEmail, 1);
  eq('classifyCandidates: optedOut counts eq-3', result.optedOut, 1);
  eq('classifyCandidates: alreadyDrafted counts eq-4', result.alreadyDrafted, 1);
  eq('classifyCandidates: outsideLeadWindow counts eq-5', result.outsideLeadWindow, 1);
}

{
  // 'expired' always qualifies regardless of leadDays (it has no "days left" to be outside of).
  const items = [{ entityId: 'eq-9', tier: 'expired' }];
  const contacts = new Map([['eq-9', { customerId: 'c-9', email: 'x@example.com', optedOut: false }]]);
  const result = classifyCandidates(items, contacts, new Set(), 7, new Map([['eq-9', null]]));
  eq('classifyCandidates: an expired unit is eligible even with a tiny lead window', result.eligible.length, 1);
}

/* ----------------------------------------------- assertEnabledForOp (item 1) */
// REVIEW FIX 2026-09-20: 'approve' and 'sendApproved' must refuse until an
// admin has turned outreach on; every other op is unaffected.

eq('assertEnabledForOp: sendApproved is blocked when disabled', assertEnabledForOp('sendApproved', { enabled: false }), {
  status: 409,
  error: 'Turn on Customer outreach in settings first',
});
eq('assertEnabledForOp: approve is blocked when disabled', assertEnabledForOp('approve', { enabled: false }), {
  status: 409,
  error: 'Turn on Customer outreach in settings first',
});
eq('assertEnabledForOp: sendApproved is allowed when enabled', assertEnabledForOp('sendApproved', { enabled: true }), null);
eq('assertEnabledForOp: approve is allowed when enabled', assertEnabledForOp('approve', { enabled: true }), null);
eq('assertEnabledForOp: missing settings (no row saved yet) is blocked, not allowed by default', assertEnabledForOp('approve', null), {
  status: 409,
  error: 'Turn on Customer outreach in settings first',
});
eq("assertEnabledForOp: 'generate' is never gated — a draft can be made and previewed with outreach off", assertEnabledForOp('generate', { enabled: false }), null);
eq("assertEnabledForOp: 'skip' is never gated", assertEnabledForOp('skip', { enabled: false }), null);
eq("assertEnabledForOp: 'settings'/'list'/'preview'/'optOut' are never gated", [
  assertEnabledForOp('settings', { enabled: false }),
  assertEnabledForOp('list', { enabled: false }),
  assertEnabledForOp('preview', { enabled: false }),
  assertEnabledForOp('optOut', { enabled: false }),
], [null, null, null, null]);

/* --------------------------------------------- assertModeAllowed (REQUEST 2b) */
// mode='review' (Donovan drafts, a human copies/opens in mail) never needs
// the add-on or RESEND_API_KEY; mode='auto' (unattended nightly sending) is
// gated behind the outreachAuto entitlement.

eq("assertModeAllowed: 'review' mode is always allowed, entitlement or not", assertModeAllowed('review', false), null);
eq("assertModeAllowed: 'review' mode allowed even when entitled (no reason to differ)", assertModeAllowed('review', true), null);
eq("assertModeAllowed: undefined mode (unchanged on this save) is allowed", assertModeAllowed(undefined, false), null);
eq("assertModeAllowed: 'auto' mode allowed once entitled", assertModeAllowed('auto', true), null);
check("assertModeAllowed: 'auto' mode refused (402) without the entitlement", assertModeAllowed('auto', false)?.status === 402);
check('assertModeAllowed: the refusal names it as an add-on, not a generic error', assertModeAllowed('auto', false)?.error.toLowerCase().includes('add-on'));

/* --------------------------------------------- hasOutreachAutoEntitlement (REQUEST 2b) */

check('hasOutreachAutoEntitlement: true only when tenants.limits.outreachAuto is literally true', hasOutreachAutoEntitlement({ limits: { outreachAuto: true } }));
check('hasOutreachAutoEntitlement: false when unset', !hasOutreachAutoEntitlement({ limits: {} }));
check('hasOutreachAutoEntitlement: false when limits itself is missing', !hasOutreachAutoEntitlement({}));
check('hasOutreachAutoEntitlement: false for a null tenant row', !hasOutreachAutoEntitlement(null));
check('hasOutreachAutoEntitlement: a truthy-but-not-true value does not count (jsonb round-trip safety)', !hasOutreachAutoEntitlement({ limits: { outreachAuto: 'true' } }));

/* ------------------------------------------------------- sendCapFor (item 4) */
// REVIEW FIX 2026-09-20: the nightly auto-sweep is capped tighter than an
// interactive admin click, so one tenant's backlog can't eat the whole
// shared cron budget — the rest carry over to the next night.

eq('sendCapFor: interactive cap is 50', sendCapFor('interactive'), 50);
eq('sendCapFor: auto (cron) cap is 20 — tighter, so one tenant cannot hog the shared cron budget', sendCapFor('auto'), 20);
check('sendCapFor: auto is strictly smaller than interactive', sendCapFor('auto') < sendCapFor('interactive'));
eq('sendCapFor: unknown context falls back to the (safer, larger) interactive default', sendCapFor('made-up'), SEND_BATCH_CAP.interactive);
check('batchForSend actually enforces the auto cap end to end', batchForSend(Array.from({ length: 37 }, (_, i) => i), sendCapFor('auto')).length === 20);

console.log(failures === 0 ? `\nAll outreach checks passed.` : `\n${failures} outreach check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
