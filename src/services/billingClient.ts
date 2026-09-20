/**
 * Typed client for POST/GET /api/billing — checkout, portal, and status.
 * Follows reviewClient.ts's postJson + error-parsing shape (authHeader +
 * messageFromResponse, same as every other browser service that calls a
 * DeepWell API route).
 *
 * Plan catalog, per-plan limits, and Records Rescue pricing are mirrored
 * here as plain display data from api/_lib/billing.js and api/_lib/plan.js
 * (documented in handoffs/BILLING_RULES.md) — the same "hand-mirrored copy"
 * pattern src/domains/hvac/documentTypes.ts uses for api/_lib/documentTypes.js,
 * since src/ cannot import api/ (different tsconfig root). Nothing here talks
 * to Stripe directly; prices are only ever resolved server-side by lookup_key.
 */

import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';

const API_URL = '/api/billing';

/** Thrown by every billingClient call on a non-2xx response. `.status` and
 *  `.url` let a caller distinguish a plain failure from the specific 402
 *  shape `{ error, url: "/app/?screen=billing" }` upload/ask also send. */
export class BillingApiError extends Error {
  status: number;
  url?: string;
  constructor(message: string, status: number, url?: string) {
    super(message);
    this.name = 'BillingApiError';
    this.status = status;
    this.url = url;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      parsedBody = raw ? JSON.parse(raw) : null;
      const parsed = parsedBody as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* not JSON — a 500 from Vercel is an HTML page */
    }
    if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
    const url = (parsedBody as { url?: string } | null)?.url;
    throw new BillingApiError(message, res.status, url);
  }
  return res.json() as Promise<T>;
}

async function postAction<T>(action: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body ?? {}),
  });
  return handle<T>(res);
}

async function getAction<T>(action: string): Promise<T> {
  const res = await fetch(`${API_URL}?action=${action}`, {
    method: 'GET',
    headers: { ...(await authHeader()) },
  });
  return handle<T>(res);
}

export type BillingPlanId = 'solo' | 'shop' | 'crew' | 'fleet';
export const PLAN_IDS: readonly BillingPlanId[] = ['solo', 'shop', 'crew', 'fleet'];
export type BillingInterval = 'month' | 'year';
export type BillingState = 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';

export interface PlanLimits {
  technicians: number | null;
  documentsStored: number | null;
  pagesPerMonth: number | null;
}

export interface BillingStatus {
  plan: BillingPlanId | null;
  status: BillingState;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  limits: Partial<PlanLimits>;
  usage: { documentsStored: number; pagesThisMonth: number };
}

/** Monthly USD price per plan — mirrors api/_lib/billing.js's PLAN_CATALOG. */
export const PLAN_CATALOG: Record<BillingPlanId, { name: string; monthly: number; trialEligible: boolean }> = {
  solo: { name: 'DeepWell Solo', monthly: 99, trialEligible: true },
  shop: { name: 'DeepWell Shop', monthly: 199, trialEligible: false },
  crew: { name: 'DeepWell Crew', monthly: 399, trialEligible: false },
  fleet: { name: 'DeepWell Fleet', monthly: 899, trialEligible: false },
};

/** Mirrors api/_lib/plan.js's PLAN_LIMITS — display only. */
export const PLAN_LIMITS: Record<BillingPlanId, PlanLimits> = {
  solo: { technicians: 1, documentsStored: 25_000, pagesPerMonth: 750 },
  shop: { technicians: 4, documentsStored: 100_000, pagesPerMonth: 2_000 },
  crew: { technicians: 10, documentsStored: 500_000, pagesPerMonth: 5_000 },
  fleet: { technicians: null, documentsStored: null, pagesPerMonth: 10_000 },
};

/** One month free: annual = 11 * monthly (mirrors api/_lib/billing.js's annualPrice). */
export function annualPrice(monthly: number): number {
  return monthly * 11;
}

export function isValidPlanId(value: string | null | undefined): value is BillingPlanId {
  return !!value && (PLAN_IDS as readonly string[]).includes(value);
}

export const RECORDS_RESCUE_MIN_PAGES = 4167; // ceil($500 / $0.12) — mirrors api/_lib/billing.js's RECORDS_RESCUE.minUnits
export const RECORDS_RESCUE_UNIT_PRICE_CENTS = 12;

/** Clamp a requested page count up to the $500 minimum — mirrors
 *  api/_lib/billing.js's resolveRecordsRescueQuantity exactly, so the total
 *  shown here always matches what checkout will actually charge. */
export function resolveRecordsRescueQuantity(requested: number): number {
  const n = Math.trunc(Number(requested) || 0);
  return Math.max(RECORDS_RESCUE_MIN_PAGES, n);
}

export function recordsRescueTotalCents(requestedPages: number): number {
  return resolveRecordsRescueQuantity(requestedPages) * RECORDS_RESCUE_UNIT_PRICE_CENTS;
}

/** Whole days remaining until `iso` (rounded up — "ends in 1 day" through its
 *  final hour, not "0 days"), or null when there is no date to count down to
 *  or it fails to parse. Never negative. */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return null;
  const ms = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export interface BillingBanner {
  kind: 'trialing' | 'past_due' | 'cap';
  message: string;
}

/** Never-subscribed tenants may ingest/ask about this many documents before
 *  a trial or subscription is required — mirrors api/_lib/plan.js's
 *  FREE_PREVIEW_DOCUMENTS. */
export const FREE_PREVIEW_DOCUMENTS = 3;

/**
 * What AppShell's global banner should say, if anything, for a given billing
 * status: trial countdown, a past-due warning, or a free-preview-exhausted
 * nudge — each linking to Billing. Pure function of the status the caller
 * already fetched, so it's directly unit-testable (scripts/verify-ui.ts).
 */
export function billingBannerFor(status: BillingStatus | null, now: Date = new Date()): BillingBanner | null {
  if (!status) return null;
  if (status.status === 'trialing') {
    const days = daysUntil(status.trialEndsAt, now);
    const message =
      days == null
        ? 'Your free trial is active.'
        : days <= 0
          ? 'Your free trial ends today.'
          : `Your free trial ends in ${days} day${days === 1 ? '' : 's'}.`;
    return { kind: 'trialing', message };
  }
  if (status.status === 'past_due') {
    return { kind: 'past_due', message: 'Your last payment failed. Update billing to keep uploading.' };
  }
  if (status.status === 'none' && status.usage.documentsStored >= FREE_PREVIEW_DOCUMENTS) {
    return { kind: 'cap', message: 'Free preview used up. Start your 30-day trial to keep going.' };
  }
  return null;
}

export const billingClient = {
  checkout(plan: string, interval: BillingInterval = 'month', quantity?: number) {
    return postAction<{ url: string }>('checkout', { plan, interval, quantity });
  },
  portal() {
    return postAction<{ url: string }>('portal');
  },
  status() {
    return getAction<BillingStatus>('status');
  },
};
