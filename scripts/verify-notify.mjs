/**
 * Unit checks for the warranty notification engine (handoffs/NOTIFICATIONS.md).
 * Pure functions only — no DB, no network, no Clerk. The SQL dedupe itself
 * (UNIQUE (tenant_id, unit_id, tier)) is exercised by M3-config/16's own
 * proof queries once applied; `isNewTierEvent` here is the pure restatement
 * scripts can check without a database.
 *
 *   node scripts/verify-notify.mjs
 */
import {
  NOTIFY_TIERS,
  isNewTierEvent,
  capRecipients,
  digestEnabled,
  alreadySentDigestToday,
  renderDigest,
  tierLabel,
  suggestedAction,
  orderByLastNotified,
  sweepWithDeadline,
} from '../api/_lib/notify.js';
import { sendEmail, EMAIL_FROM } from '../api/_lib/email.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- tier transitions */

eq('NOTIFY_TIERS is the four urgent tiers, ok/expiring-365 excluded', [...NOTIFY_TIERS].sort(), [
  'expired',
  'expiring-30',
  'expiring-90',
  'unregistered-window-closing',
].sort());

check('isNewTierEvent: first time at any tier is new', isNewTierEvent([], 'expiring-90'));
check('isNewTierEvent: same tier again is NOT new', !isNewTierEvent(['expiring-90'], 'expiring-90'));
check('isNewTierEvent: tier progressed 90 -> 30 IS new', isNewTierEvent(['expiring-90'], 'expiring-30'));
check('isNewTierEvent: tier progressed 30 -> expired IS new', isNewTierEvent(['expiring-90', 'expiring-30'], 'expired'));
check('isNewTierEvent: already-seen expired is not renotified', !isNewTierEvent(['expiring-90', 'expiring-30', 'expired'], 'expired'));

for (const tier of NOTIFY_TIERS) {
  check(`tierLabel(${tier}) is non-empty`, typeof tierLabel(tier) === 'string' && tierLabel(tier).length > 0);
  check(`suggestedAction(${tier}) is non-empty`, typeof suggestedAction(tier) === 'string' && suggestedAction(tier).length > 0);
}
eq('tierLabel: unknown tier falls back to itself', tierLabel('made-up'), 'made-up');

/* ------------------------------------------------------------ recipients */

eq('capRecipients: dedupes case-insensitively', capRecipients(['A@x.com', 'a@x.com', 'b@x.com']), ['a@x.com', 'b@x.com']);
eq('capRecipients: drops junk (no @, blank, null)', capRecipients(['not-an-email', '', null, 'ok@x.com']), ['ok@x.com']);
eq(
  'capRecipients: caps at 10 by default',
  capRecipients(Array.from({ length: 15 }, (_, i) => `u${i}@x.com`)).length,
  10
);
eq('capRecipients: respects a smaller explicit cap', capRecipients(['a@x.com', 'b@x.com', 'c@x.com'], 2).length, 2);

/* ---------------------------------------------------------- digest gates */

check('digestEnabled: default (no settings) is ON', digestEnabled(undefined) && digestEnabled(null) && digestEnabled({}));
check('digestEnabled: explicit false is OFF', !digestEnabled({ emailDigest: false }));
check('digestEnabled: explicit true is ON', digestEnabled({ emailDigest: true }));

check('alreadySentDigestToday: no marker -> false', !alreadySentDigestToday(undefined, '2026-09-20'));
check(
  'alreadySentDigestToday: marker from today -> true',
  alreadySentDigestToday({ lastDigestSentAt: '2026-09-20T09:17:03Z' }, '2026-09-20')
);
check(
  'alreadySentDigestToday: marker from yesterday -> false (a new day may send)',
  !alreadySentDigestToday({ lastDigestSentAt: '2026-09-19T23:59:00Z' }, '2026-09-20')
);

/* ------------------------------------------------------------- rendering */

{
  const items = [
    { unitId: 'unit-1', serial: 'SN1', brand: 'Trane', model: 'XR16', customer: 'Jane Doe', address: '1 Elm St', tier: 'expired', expires: '2026-08-01', daysLeft: -50, upsell: { eligible: true, reason: 'x' } },
    { unitId: 'unit-2', serial: 'SN2', brand: 'Goodman', model: 'GSX16', customer: 'Bob Roe', address: '2 Oak St', tier: 'expiring-30', expires: '2026-10-10', daysLeft: 20, upsell: { eligible: true, reason: 'y' } },
  ];
  const digest = renderDigest({ tenantName: 'Acme HVAC', items, appUrl: 'https://deepwelltechnology.com' });

  check('renderDigest: subject counts the items and pluralizes', digest.subject === '2 warranties need attention — DeepWell', digest.subject);
  check('renderDigest: singular wording for exactly one item', renderDigest({ tenantName: 'Acme', items: [items[0]], appUrl: 'https://x' }).subject.startsWith('1 warranty needs attention'));
  check('renderDigest: text mentions every customer', digest.text.includes('Jane Doe') && digest.text.includes('Bob Roe'));
  check('renderDigest: text carries a per-unit outreach link keyed by unitId', digest.text.includes('entity=unit-1') && digest.text.includes('entity=unit-2'));
  check('renderDigest: html is a table with a Draft outreach link per row', (digest.html.match(/Draft outreach/g) ?? []).length === 2);
  check('renderDigest: html escapes customer names (no raw HTML injection)', !renderDigest({ tenantName: 'Acme', items: [{ ...items[0], customer: '<script>x</script>' }], appUrl: 'https://x' }).html.includes('<script>x</script>'));
  check('renderDigest: zero items still produces a well-formed (if odd) digest, never throws', renderDigest({ tenantName: 'Acme', items: [], appUrl: 'https://x' }).subject.startsWith('0 warranties'));
}

/* -------------------------------------- shared deadline + fair rotation */
//
// REVIEW FIX 2026-09-20: the whole cron sweep must fit api/account.js's 60s
// maxDuration. The notification step gets one shared deadline (start + 45s
// in cron-sweep.js) and must stop before crossing it rather than overrun —
// and a tenant it had to skip must lead the very next run, not get starved
// forever by tenants that keep being checked first.

eq(
  'orderByLastNotified: never-notified (null) tenants sort before ones with a timestamp',
  orderByLastNotified([{ tenant_key: 'has-ts', last_notified_at: '2026-09-19T00:00:00Z' }, { tenant_key: 'never', last_notified_at: null }]).map((t) => t.tenant_key),
  ['never', 'has-ts']
);
eq(
  'orderByLastNotified: older timestamps sort before newer ones',
  orderByLastNotified([{ tenant_key: 'b', last_notified_at: '2026-09-20T00:00:00Z' }, { tenant_key: 'a', last_notified_at: '2026-09-01T00:00:00Z' }]).map((t) => t.tenant_key),
  ['a', 'b']
);
eq('orderByLastNotified: does not mutate its input', (() => { const input = [{ tenant_key: 'a', last_notified_at: null }]; orderByLastNotified(input); return input.map((t) => t.tenant_key); })(), ['a']);

{
  // 20 tenants, none notified yet, each simulated to cost 3s (perTenantMs) —
  // exactly the reviewer's scenario. A fake clock (no real timers) advances
  // only when a tenant is actually "processed".
  const perTenantMs = 3000;
  const budgetMs = 45_000;
  let clock = 0;
  const deadlineAt = clock + budgetMs;
  const tenants = Array.from({ length: 20 }, (_, i) => ({ tenant_key: `t${i}`, last_notified_at: null }));
  const order = [];

  const { processed, skipped } = await sweepWithDeadline(tenants, {
    deadlineAt,
    perTenantMs,
    now: () => clock,
    processTenant: async (t) => {
      order.push(t.tenant_key);
      clock += perTenantMs;
      t.last_notified_at = new Date(clock).toISOString(); // simulates mark_tenant_notified
    },
  });

  eq('sweepWithDeadline: with 3s/tenant and a 45s budget, exactly 15 of 20 tenants run', processed.length, 15);
  eq('sweepWithDeadline: the remaining 5 are reported skipped, not silently dropped', skipped.length, 5);
  eq('sweepWithDeadline: processed + skipped covers every tenant, none lost', processed.length + skipped.length, 20);
  check('sweepWithDeadline: never starts a tenant whose estimated finish would cross the deadline', processed.length * perTenantMs <= budgetMs);
  eq('sweepWithDeadline: processes tenants in the given (rotation) order', order, tenants.slice(0, 15).map((t) => t.tenant_key));

  const nextRunOrder = orderByLastNotified([...processed, ...skipped]).map((t) => t.tenant_key);
  eq(
    'fairness: the 5 skipped-this-run tenants lead next run\'s queue (still null last_notified_at)',
    nextRunOrder.slice(0, 5).sort(),
    skipped.map((t) => t.tenant_key).sort()
  );
}

{
  // Empty and single-tenant edges never throw and never mis-skip.
  const empty = await sweepWithDeadline([], { deadlineAt: 1000, perTenantMs: 3000, now: () => 0, processTenant: async () => {} });
  eq('sweepWithDeadline: empty tenant list -> nothing processed, nothing skipped', [empty.processed.length, empty.skipped.length], [0, 0]);

  const noBudget = await sweepWithDeadline([{ tenant_key: 'only' }], { deadlineAt: 100, perTenantMs: 3000, now: () => 0, processTenant: async () => {} });
  eq('sweepWithDeadline: a single tenant that would blow the deadline is skipped, not force-run', [noBudget.processed.length, noBudget.skipped.length], [0, 1]);
}

/* --------------------------------------------------- log-only email path */

{
  const originalKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const result = await sendEmail({ to: ['owner@shop.com'], subject: 'test', text: 'test', html: '<p>test</p>' });
  eq('sendEmail: no RESEND_API_KEY -> log-only, channel in-app, not sent', result, { sent: false, channel: 'in-app' });
  check('EMAIL_FROM is the deepwelltechnology.com sending address', EMAIL_FROM === 'alerts@deepwelltechnology.com');
  if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
}

{
  const result = await sendEmail({ to: [], subject: 'test', text: 'test', html: '<p>test</p>' });
  eq('sendEmail: no recipients -> log-only, never throws', result, { sent: false, channel: 'in-app' });
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
