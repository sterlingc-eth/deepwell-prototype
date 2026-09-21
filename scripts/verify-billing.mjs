/**
 * Unit checks for Stripe billing: plan catalog math, trial eligibility,
 * webhook signature verification (fixture, no real secret or network),
 * event -> tenant-patch mapping, and gating decisions (planStateFor, grace
 * math, upload/ask 402s). Pure functions only — no database, no Stripe.
 *
 *   node scripts/verify-billing.mjs
 */
delete process.env.STRIPE_SECRET_KEY;
delete process.env.NEON_CONNECTION_STRING;

import crypto from 'node:crypto';
import { estimateCostUsd } from '../api/_lib/usage.js';
import {
  PLAN_CATALOG,
  PLAN_IDS,
  annualPrice,
  lookupKeyFor,
  RECORDS_RESCUE,
  resolveRecordsRescueQuantity,
  isTrialEligible,
  chooseExistingCustomerId,
  verifyStripeSignature,
  patchForEvent,
  billingStatusFromStripeStatus,
  WEBHOOK_EVENTS,
} from '../api/_lib/billing.js';
import {
  PLAN_LIMITS,
  FREE_PREVIEW_DOCUMENTS,
  PAST_DUE_GRACE_DAYS,
  planStateFor,
  isPastGrace,
  gateUpload,
  gateAsk,
  requireActiveBilling,
  assertActiveBilling,
} from '../api/_lib/plan.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DAY = 24 * 60 * 60 * 1000;

/* --------------------------------------------------------- plan catalog / math */

eq('four plans in the catalog', PLAN_IDS, ['solo', 'shop', 'crew', 'fleet']);
eq('solo monthly is $99', PLAN_CATALOG.solo.monthly, 99);
eq('shop monthly is $199', PLAN_CATALOG.shop.monthly, 199);
eq('crew monthly is $399', PLAN_CATALOG.crew.monthly, 399);
eq('fleet monthly is $899', PLAN_CATALOG.fleet.monthly, 899);

eq('annual = 11x monthly (solo)', annualPrice(PLAN_CATALOG.solo.monthly), 1089);
eq('annual = 11x monthly (shop)', annualPrice(PLAN_CATALOG.shop.monthly), 2189);
eq('annual = 11x monthly (crew)', annualPrice(PLAN_CATALOG.crew.monthly), 4389);
eq('annual = 11x monthly (fleet)', annualPrice(PLAN_CATALOG.fleet.monthly), 9889);

eq('lookup key monthly', lookupKeyFor('shop', 'month'), 'shop_monthly');
eq('lookup key annual', lookupKeyFor('shop', 'year'), 'shop_annual');

eq('PLAN_LIMITS solo', PLAN_LIMITS.solo, { technicians: 1, documentsStored: 25000, pagesPerMonth: 750 });
eq('PLAN_LIMITS fleet has no technician/document cap', [PLAN_LIMITS.fleet.technicians, PLAN_LIMITS.fleet.documentsStored], [null, null]);

eq('records rescue min is 4167 units (~$500 @ $0.12)', RECORDS_RESCUE.minUnits, 4167);
check('records rescue min is at least $500', RECORDS_RESCUE.minUnits * RECORDS_RESCUE.unitPriceCents >= 50000);
eq('quantity under the minimum is clamped up', resolveRecordsRescueQuantity(100), 4167);
eq('quantity over the minimum passes through', resolveRecordsRescueQuantity(5000), 5000);
eq('non-numeric quantity clamps to the minimum', resolveRecordsRescueQuantity('nope'), 4167);

/* -------------------------------------------------------------- trial eligibility */

check('solo, never trialed -> eligible', isTrialEligible('solo', { trial_used: false }));
check('solo, never-set trial_used -> eligible', isTrialEligible('solo', {}));
check('solo, already trialed -> not eligible', !isTrialEligible('solo', { trial_used: true }));
check('shop is never trial-eligible', !isTrialEligible('shop', { trial_used: false }));
check('crew is never trial-eligible', !isTrialEligible('crew', {}));
check('fleet is never trial-eligible', !isTrialEligible('fleet', {}));

/* ---------------------------------------------------- customer create/reuse decision */

eq('tenant row\'s own customer id always wins (freshest, post-lock)',
  chooseExistingCustomerId({ tenantRow: { stripe_customer_id: 'cus_tenant' }, foundByMetadata: 'cus_search' }), 'cus_tenant');
eq('falls back to a Stripe metadata search hit when the tenant has none',
  chooseExistingCustomerId({ tenantRow: {}, foundByMetadata: 'cus_search' }), 'cus_search');
eq('falls back to null (create) when neither source has one',
  chooseExistingCustomerId({ tenantRow: {}, foundByMetadata: null }), null);
eq('missing tenantRow is treated the same as an empty one',
  chooseExistingCustomerId({ foundByMetadata: 'cus_search' }), 'cus_search');

/* ---------------------------------------------------------- signature verification */

{
  const secret = 'whsec_test_fixture';
  const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const now = 1_700_000_000_000;
  const t = Math.floor(now / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  const header = `t=${t},v1=${sig}`;

  check('valid signature verifies', verifyStripeSignature(payload, header, secret, { now }));
  check('wrong secret fails', !verifyStripeSignature(payload, header, 'whsec_wrong', { now }));
  check('tampered payload fails', !verifyStripeSignature(payload + 'x', header, secret, { now }));
  check('expired timestamp fails (outside tolerance)', !verifyStripeSignature(payload, header, secret, { now: now + 10 * 60 * 1000 }));
  check('missing header fails', !verifyStripeSignature(payload, '', secret, { now }));
  check('multiple v1 values: any match verifies', verifyStripeSignature(payload, `t=${t},v1=deadbeef,v1=${sig}`, secret, { now }));
}

/* ------------------------------------------------------------- webhook event mapping */

eq('registers exactly the events stripe-setup prints', WEBHOOK_EVENTS, [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

eq('subscription status mapping: trialing', billingStatusFromStripeStatus('trialing'), 'trialing');
eq('subscription status mapping: active', billingStatusFromStripeStatus('active'), 'active');
eq('subscription status mapping: past_due', billingStatusFromStripeStatus('past_due'), 'past_due');
eq('subscription status mapping: unpaid -> past_due', billingStatusFromStripeStatus('unpaid'), 'past_due');
eq('subscription status mapping: canceled', billingStatusFromStripeStatus('canceled'), 'canceled');
eq('subscription status mapping: incomplete -> none', billingStatusFromStripeStatus('incomplete'), 'none');

{
  const event = {
    id: 'evt_sub_1',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'trialing',
        trial_end: 1_700_100_000,
        current_period_end: 1_702_000_000,
        cancel_at_period_end: false,
        items: { data: [{ price: { metadata: { plan: 'solo' } } }] },
      },
    },
  };
  const mapped = patchForEvent(event);
  eq('subscription.updated: customer id', mapped.customerId, 'cus_123');
  eq('subscription.updated: billing_status', mapped.patch.billing_status, 'trialing');
  eq('subscription.updated: plan', mapped.patch.plan, 'solo');
  eq('subscription.updated: limits set from plan', mapped.patch.limits, PLAN_LIMITS.solo);
  check('subscription.updated: trialing sets trial_used', mapped.patch.trial_used === true);
}

{
  const event = { id: 'evt_fail_1', type: 'invoice.payment_failed', data: { object: { customer: 'cus_9', subscription: 'sub_9' } } };
  eq('invoice.payment_failed -> past_due', patchForEvent(event).patch.billing_status, 'past_due');
}

{
  const event = { id: 'evt_paid_1', type: 'invoice.paid', data: { object: { customer: 'cus_9', subscription: 'sub_9' } } };
  eq('invoice.paid -> active', patchForEvent(event).patch.billing_status, 'active');
}

{
  const event = { id: 'evt_del_1', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_9' } } };
  eq('subscription.deleted -> canceled', patchForEvent(event).patch.billing_status, 'canceled');
}

eq('unhandled event type maps to null', patchForEvent({ id: 'evt_x', type: 'ping', data: { object: {} } }), null);
eq('missing data.object maps to null', patchForEvent({ id: 'evt_y', type: 'invoice.paid' }), null);

/* --------------------------------------------------------------- planStateFor */

const now = new Date('2026-09-20T00:00:00Z');

eq('no billing_status -> none', planStateFor({}, now), 'none');
eq('active status -> active', planStateFor({ billing_status: 'active' }, now), 'active');
eq('canceled status -> canceled', planStateFor({ billing_status: 'canceled' }, now), 'canceled');
eq('trialing with future trial_ends_at -> trialing',
  planStateFor({ billing_status: 'trialing', trial_ends_at: new Date(now.getTime() + DAY).toISOString() }, now), 'trialing');
eq('trialing with past trial_ends_at -> none (does not wait on a webhook)',
  planStateFor({ billing_status: 'trialing', trial_ends_at: new Date(now.getTime() - DAY).toISOString() }, now), 'none');

check('past_due within 7-day grace is not past grace',
  !isPastGrace({ billing_status: 'past_due', current_period_end: new Date(now.getTime() - 3 * DAY).toISOString() }, now));
check('past_due past 7-day grace IS past grace',
  isPastGrace({ billing_status: 'past_due', current_period_end: new Date(now.getTime() - 8 * DAY).toISOString() }, now));
eq('grace window is 7 days', PAST_DUE_GRACE_DAYS, 7);
// HARD GATE (owner decision, 2026-09-21): no free preview any more — a
// never-subscribed tenant is blocked at document #0, same as a canceled one.
eq('free preview is 0 documents (hard gate — no free preview)', FREE_PREVIEW_DOCUMENTS, 0);

/* ------------------------------------------------------------------ gateUpload */

check('none + 0 docs: upload blocked (hard gate)', !gateUpload({}, { documentsStored: 0, pagesThisMonth: 0 }, now).allowed);
eq('none + 0 docs: 402', gateUpload({}, { documentsStored: 0, pagesThisMonth: 0 }, now).status, 402);
eq('none + 0 docs: 402 message', gateUpload({}, { documentsStored: 0, pagesThisMonth: 0 }, now).error, 'Choose a plan to get started');
check('none + 3 docs: upload blocked', !gateUpload({}, { documentsStored: 3, pagesThisMonth: 0 }, now).allowed);
eq('none + 3 docs: 402', gateUpload({}, { documentsStored: 3, pagesThisMonth: 0 }, now).status, 402);

check('trialing under page cap: allowed',
  gateUpload({ billing_status: 'trialing', plan: 'solo', trial_ends_at: new Date(now.getTime() + DAY).toISOString() },
    { documentsStored: 10, pagesThisMonth: 100 }, now).allowed);
check('active over page cap: blocked',
  !gateUpload({ billing_status: 'active', plan: 'solo' }, { documentsStored: 10, pagesThisMonth: 750 }, now).allowed);
check('fleet has no page cap ceiling below 10k',
  gateUpload({ billing_status: 'active', plan: 'fleet' }, { documentsStored: 10, pagesThisMonth: 9999 }, now).allowed);
check('canceled: upload blocked',
  !gateUpload({ billing_status: 'canceled' }, { documentsStored: 1, pagesThisMonth: 0 }, now).allowed);
check('past_due within grace: upload allowed',
  gateUpload({ billing_status: 'past_due', plan: 'shop', current_period_end: new Date(now.getTime() - DAY).toISOString() },
    { documentsStored: 1, pagesThisMonth: 1 }, now).allowed);
check('past_due past grace: upload blocked',
  !gateUpload({ billing_status: 'past_due', plan: 'shop', current_period_end: new Date(now.getTime() - 10 * DAY).toISOString() },
    { documentsStored: 1, pagesThisMonth: 1 }, now).allowed);

/* --------------------------------------------------------------------- gateAsk */

check('none + 0 docs: ask blocked (hard gate — no free preview)', !gateAsk({}, { documentsStored: 0 }, now).allowed);
eq('none + 0 docs: 402 message', gateAsk({}, { documentsStored: 0 }, now).error, 'Choose a plan to get started');
check('none + 3 docs: ask blocked', !gateAsk({}, { documentsStored: 3 }, now).allowed);
check('canceled: ask blocked', !gateAsk({ billing_status: 'canceled' }, { documentsStored: 0 }, now).allowed);
eq('canceled: 402 message', gateAsk({ billing_status: 'canceled' }, { documentsStored: 0 }, now).error, 'Choose a plan to get started');
check('past_due past grace: ask STILL allowed (read-only, not blocked)',
  gateAsk({ billing_status: 'past_due', current_period_end: new Date(now.getTime() - 30 * DAY).toISOString() },
    { documentsStored: 50 }, now).allowed);
check('active: ask allowed', gateAsk({ billing_status: 'active' }, { documentsStored: 999 }, now).allowed);

/* ------------------------------------------------------- requireActiveBilling */
// The shared HARD GATE (Reviewer NO-GO, 2026-09-21) behind gateUpload,
// gateAsk, and the model-costing routes (read-document, extract, review's
// reclassify action, via assertActiveBilling below). Pure — no DB — so every
// branch is a fixture-row check same as planStateFor's own tests above.

check('none: blocked', !requireActiveBilling({}, now).allowed);
eq('none: 402', requireActiveBilling({}, now).status, 402);
eq('none: message', requireActiveBilling({}, now).error, 'Choose a plan to get started');
eq('none: points at Billing', requireActiveBilling({}, now).url, '/app/?screen=billing');
check('canceled: blocked', !requireActiveBilling({ billing_status: 'canceled' }, now).allowed);
eq('canceled: message', requireActiveBilling({ billing_status: 'canceled' }, now).error, 'Choose a plan to get started');

check('trialing (unexpired): allowed',
  requireActiveBilling({ billing_status: 'trialing', trial_ends_at: new Date(now.getTime() + DAY).toISOString() }, now).allowed);
check('active: allowed', requireActiveBilling({ billing_status: 'active' }, now).allowed);
check('past_due within grace: allowed',
  requireActiveBilling({ billing_status: 'past_due', current_period_end: new Date(now.getTime() - DAY).toISOString() }, now).allowed);
// past_due PAST grace is deliberately still "allowed" here — this bare
// function only answers "is there a billing relationship at all", not the
// page-cap/grace-window nuance gateUpload layers on top of it for uploads
// specifically (its own past-grace branch above returns its own message
// first and never reaches this function).
check('past_due past grace: still allowed at this bare check (gateUpload/read-document apply their own stricter rule)',
  requireActiveBilling({ billing_status: 'past_due', current_period_end: new Date(now.getTime() - 10 * DAY).toISOString() }, now).allowed);

/* -------------------------------------------------------- assertActiveBilling */
// DB-touching sibling used directly by read-document.js/extract.js/
// review.js's reclassify action (no bespoke gate wrapper of their own).
// This test file runs with NEON_CONNECTION_STRING deleted (top of file), so
// every call below hits the exact "billing lookup itself is broken" case —
// FAILS CLOSED (503), the opposite of every other gate in this file and of
// assertModelBudget's own fail-OPEN default.
{
  const closed = await assertActiveBilling({ tenantKey: 'verify-billing-fixture' });
  check('assertActiveBilling: a lookup failure fails CLOSED, not open', !closed.allowed);
  eq('assertActiveBilling: 503 on a lookup failure', closed.status, 503);
  eq('assertActiveBilling: message', closed.error, 'Billing check unavailable, try again');
}

/* -------------------------------------------------------- aiCostEstimateUsd */
// GET /api/billing?action=status now exposes usage.aiCostEstimateUsd (owner
// ask, 2026-09-20: "make sure we're not wasting money asking questions").
// Pure-function checks on estimateCostUsd itself — the DB round-trip that
// feeds it (getUsage) is not exercised here, same as everything else in this
// file.

{
  const zero = estimateCostUsd({ inputTokens: 0, outputTokens: 0 });
  eq('zero tokens costs $0', zero, 0);

  const some = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  check('a million input + a million output tokens costs a small positive number of dollars, not zero or absurd',
    some > 0 && some < 20, `got ${some}`);

  check('more tokens never costs less',
    estimateCostUsd({ inputTokens: 2_000_000, outputTokens: 0 }) > estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }));

  check('garbage input is handled safely (never NaN, never negative)',
    Number.isFinite(estimateCostUsd({ inputTokens: 'nope', outputTokens: -5 })) &&
    estimateCostUsd({ inputTokens: 'nope', outputTokens: -5 }) >= 0);

  check('missing args default to zero cost, not a throw', estimateCostUsd() === 0);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
