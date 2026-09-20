#!/usr/bin/env node
/**
 * One-time (and re-run-safe) Stripe object setup: products, prices (by
 * lookup_key), and a Customer Portal configuration. Idempotent — searches by
 * lookup_key/product name and only creates what's missing; never updates or
 * deletes an existing object.
 *
 * Run locally, never in CI or a deploy step:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
 *
 * STRIPE_SECRET_KEY is read from the environment ONLY and is never logged —
 * not even truncated. Nothing this script prints can be used to reconstruct it.
 */
import Stripe from 'stripe';
import { PLAN_CATALOG, PLAN_IDS, annualPrice, lookupKeyFor, RECORDS_RESCUE, WEBHOOK_EVENTS } from '../api/_lib/billing.js';
import { PLAN_LIMITS } from '../api/_lib/plan.js';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set. Run: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });

async function findProductByName(name) {
  const { data } = await stripe.products.search({ query: `name:"${name}" AND active:'true'` });
  return data[0] ?? null;
}

async function ensureProduct(name) {
  const existing = await findProductByName(name);
  if (existing) return existing;
  return stripe.products.create({ name });
}

async function findPriceByLookupKey(lookupKey) {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  return data[0] ?? null;
}

async function ensureRecurringPrice({ product, lookupKey, unitAmountCents, interval, plan }) {
  const existing = await findPriceByLookupKey(lookupKey);
  if (existing) return existing;
  return stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: unitAmountCents,
    recurring: { interval },
    lookup_key: lookupKey,
    metadata: { plan, interval: interval === 'year' ? 'year' : 'month' },
  });
}

async function ensureUsagePrice({ product, lookupKey, unitAmountCents }) {
  const existing = await findPriceByLookupKey(lookupKey);
  if (existing) return existing;
  return stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: unitAmountCents,
    lookup_key: lookupKey,
    metadata: { kind: 'records_rescue' },
  });
}

async function ensurePortalConfiguration(subscriptionPriceIds) {
  const { data } = await stripe.billingPortal.configurations.list({ limit: 100 });
  const existing = data.find((c) => c.metadata?.deepwell === 'default');
  if (existing) return existing;
  return stripe.billingPortal.configurations.create({
    business_profile: { headline: 'DeepWell Technology billing' },
    metadata: { deepwell: 'default' },
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: [], // Stripe fills this from the prices list below via price ids
      },
    },
  }).catch(async (err) => {
    // Some accounts require `products` to be explicit product/price groups
    // rather than empty; retry once with them filled in.
    if (!/products/i.test(err?.message ?? '')) throw err;
    const byProduct = new Map();
    for (const priceId of subscriptionPriceIds) {
      const price = await stripe.prices.retrieve(priceId);
      if (!byProduct.has(price.product)) byProduct.set(price.product, []);
      byProduct.get(price.product).push(priceId);
    }
    const products = [...byProduct.entries()].map(([product, prices]) => ({ product, prices }));
    return stripe.billingPortal.configurations.create({
      business_profile: { headline: 'DeepWell Technology billing' },
      metadata: { deepwell: 'default' },
      features: {
        customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: { enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations', products },
      },
    });
  });
}

async function main() {
  const rows = [];
  const subscriptionPriceIds = [];

  for (const plan of PLAN_IDS) {
    const catalogEntry = PLAN_CATALOG[plan];
    const product = await ensureProduct(catalogEntry.name);
    const monthly = await ensureRecurringPrice({
      product,
      lookupKey: lookupKeyFor(plan, 'month'),
      unitAmountCents: Math.round(catalogEntry.monthly * 100),
      interval: 'month',
      plan,
    });
    const annual = await ensureRecurringPrice({
      product,
      lookupKey: lookupKeyFor(plan, 'year'),
      unitAmountCents: Math.round(annualPrice(catalogEntry.monthly) * 100),
      interval: 'year',
      plan,
    });
    subscriptionPriceIds.push(monthly.id, annual.id);
    rows.push({ plan, product: product.id, monthly: monthly.id, annual: annual.id, limits: PLAN_LIMITS[plan] });
  }

  const rrProduct = await ensureProduct(RECORDS_RESCUE.productName);
  const rrPrice = await ensureUsagePrice({
    product: rrProduct,
    lookupKey: RECORDS_RESCUE.lookupKey,
    unitAmountCents: RECORDS_RESCUE.unitPriceCents,
  });

  const portalConfig = await ensurePortalConfiguration(subscriptionPriceIds);

  console.log('\n=== DeepWell Stripe catalog ===');
  console.table(rows.map((r) => ({ plan: r.plan, product: r.product, monthly_price: r.monthly, annual_price: r.annual })));
  console.log(`Records Rescue: product=${rrProduct.id} price=${rrPrice.id} ($0.12/pg, ${RECORDS_RESCUE.minUnits}-page minimum)`);
  console.log(`Customer Portal configuration: ${portalConfig.id}`);

  console.log('\n=== Webhook setup ===');
  console.log('Endpoint URL: https://deepwelltechnology.com/api/billing?action=webhook');
  console.log('Events to register:');
  for (const evt of WEBHOOK_EVENTS) console.log(`  - ${evt}`);
  console.log('\nAfter creating the endpoint in the Stripe dashboard (or `stripe listen`/`stripe trigger` for local testing),');
  console.log('set STRIPE_WEBHOOK_SECRET in Vercel to the signing secret Stripe shows for that endpoint.');
}

main().catch((err) => {
  console.error('stripe-setup failed:', err?.message ?? err);
  process.exit(1);
});
