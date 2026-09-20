import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { useAppStore } from '../store/appStore';
import {
  billingClient,
  BillingApiError,
  PLAN_CATALOG,
  PLAN_IDS,
  PLAN_LIMITS,
  RECORDS_RESCUE_MIN_PAGES,
  RECORDS_RESCUE_UNIT_PRICE_CENTS,
  annualPrice,
  daysUntil,
  recordsRescueTotalCents,
  resolveRecordsRescueQuantity,
  type BillingInterval,
  type BillingPlanId,
  type BillingStatus,
} from '../services/billingClient';

function formatUSD(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}
function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatCap(n: number | null | undefined): string {
  return n == null ? 'Unlimited' : n.toLocaleString('en-US');
}

const STATUS_LABEL: Record<BillingStatus['status'], string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment failed',
  canceled: 'Canceled',
  none: 'No plan yet',
};

const STATUS_PILL: Record<BillingStatus['status'], string> = {
  trialing: 'dw-pill-info',
  active: 'dw-pill-ok',
  past_due: 'dw-pill-warn',
  canceled: 'dw-pill-bad',
  none: 'dw-pill-muted',
};

/** The one plan action in flight at a time — disables every button so a
 *  double-click can't fire two checkout sessions. */
type Busy = null | 'trial' | 'portal' | 'rescue' | `checkout:${BillingPlanId}`;

export function BillingScreen() {
  const status = useAppStore((s) => s.billingStatus);
  const setBillingStatus = useAppStore((s) => s.setBillingStatus);
  const pendingPlan = useAppStore((s) => s.pendingPlan);
  const clearPendingPlan = useAppStore((s) => s.clearPendingPlan);

  const [interval, setInterval] = useState<BillingInterval>(pendingPlan?.interval ?? 'month');
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rescuePages, setRescuePages] = useState<number>(RECORDS_RESCUE_MIN_PAGES);
  const [loadingStatus, setLoadingStatus] = useState(true);

  // Always refetches on open — this screen is the one place a stale status
  // (from before a checkout/portal round trip) would actually mislead someone.
  useEffect(() => {
    let cancelled = false;
    setLoadingStatus(true);
    billingClient
      .status()
      .then((s) => {
        if (!cancelled) setBillingStatus(s);
      })
      .catch(() => {
        /* keep whatever AppShell already had, if anything */
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The deep-linked plan only needs to survive long enough to preselect the
  // toggle and highlight its tile above — consumed once, then cleared so
  // leaving and returning to Billing later doesn't keep re-highlighting it.
  useEffect(() => () => clearPendingPlan(), [clearPendingPlan]);

  const highlightedPlan = pendingPlan?.plan;
  const trialEligible = status?.status === 'none';
  const trialDaysLeft = daysUntil(status?.trialEndsAt ?? null);

  const rescueQuantity = resolveRecordsRescueQuantity(rescuePages);
  const rescueTotalCents = recordsRescueTotalCents(rescuePages);

  const runCheckout = async (key: Busy, fn: () => Promise<{ url: string }>) => {
    setActionError(null);
    setBusy(key);
    try {
      const { url } = await fn();
      window.location.assign(url);
    } catch (e) {
      setActionError(e instanceof BillingApiError || e instanceof Error ? e.message : 'Something went wrong. Try again.');
      setBusy(null);
    }
  };

  return (
    <AppShell>
      <div className="space-y-8 max-w-3xl mx-auto">
        <header>
          <h1 className="text-h1">Billing</h1>
          <p className="text-ink-2 mt-1">Your DeepWell plan, trial, and usage.</p>
        </header>

        <section className="dw-card p-5 space-y-4" aria-labelledby="current-plan-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="current-plan-heading" className="text-h3">
              Current plan
            </h2>
            {loadingStatus ? (
              <Loader2 className="w-4 h-4 animate-spin text-ink-3" aria-hidden="true" />
            ) : (
              <span className={STATUS_PILL[status?.status ?? 'none']}>{STATUS_LABEL[status?.status ?? 'none']}</span>
            )}
          </div>

          <p className="text-body">
            {status?.plan ? PLAN_CATALOG[status.plan]?.name ?? status.plan : 'No plan selected yet — try 3 documents free, no card required.'}
            {status?.status === 'trialing' && trialDaysLeft != null && (
              <> — trial ends in {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'}.</>
            )}
            {status?.cancelAtPeriodEnd && status.currentPeriodEnd && <> Ends {new Date(status.currentPeriodEnd).toLocaleDateString()}.</>}
          </p>

          {status?.plan && (
            <dl className="grid grid-cols-3 gap-3 text-body">
              <div>
                <dt className="text-caption text-ink-3">Technicians</dt>
                <dd>{formatCap(status.limits.technicians)}</dd>
              </div>
              <div>
                <dt className="text-caption text-ink-3">Documents stored</dt>
                <dd>
                  {status.usage.documentsStored.toLocaleString()} / {formatCap(status.limits.documentsStored)}
                </dd>
              </div>
              <div>
                <dt className="text-caption text-ink-3">Pages this month</dt>
                <dd>
                  {status.usage.pagesThisMonth.toLocaleString()} / {formatCap(status.limits.pagesPerMonth)}
                </dd>
              </div>
            </dl>
          )}

          {actionError && (
            <p role="alert" className="dw-pill-warn inline-flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" /> {actionError}
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {trialEligible && (
              <button
                type="button"
                className="dw-btn-primary"
                disabled={busy !== null}
                onClick={() => void runCheckout('trial', () => billingClient.checkout('solo', interval))}
              >
                {busy === 'trial' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                Start 30-day free trial
              </button>
            )}
            <button type="button" className="dw-btn-secondary" disabled={busy !== null} onClick={() => void runCheckout('portal', () => billingClient.portal())}>
              {busy === 'portal' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              Manage billing
            </button>
          </div>
        </section>

        <section aria-labelledby="plans-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="plans-heading" className="text-h3">
              Choose a plan
            </h2>
            <div className="inline-flex rounded-md border border-line-2 overflow-hidden" role="group" aria-label="Billing interval">
              {(['month', 'year'] as BillingInterval[]).map((iv) => (
                <button
                  key={iv}
                  type="button"
                  aria-pressed={interval === iv}
                  onClick={() => setInterval(iv)}
                  className={['px-3 py-1.5 text-body min-h-touch', interval === iv ? 'bg-forest-700 text-stone-0' : 'bg-surface text-ink-2 hover:bg-surface-2'].join(' ')}
                >
                  {iv === 'month' ? 'Monthly' : 'Annual · 1 month free'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {PLAN_IDS.map((planId) => {
              const plan = PLAN_CATALOG[planId];
              const limits = PLAN_LIMITS[planId];
              const price = interval === 'year' ? annualPrice(plan.monthly) : plan.monthly;
              const isCurrent = !!status && status.plan === planId && (status.status === 'active' || status.status === 'trialing' || status.status === 'past_due');
              const isHighlighted = highlightedPlan === planId;
              return (
                <div key={planId} className={['dw-card p-4 space-y-3 flex flex-col', isHighlighted ? 'ring-2 ring-focus' : ''].join(' ')}>
                  <div>
                    <h3 className="text-h3">{plan.name.replace('DeepWell ', '')}</h3>
                    {planId === 'solo' && <span className="dw-pill-info mt-1 inline-block">30-day free trial</span>}
                  </div>
                  <p>
                    <span className="font-display text-h1">{formatUSD(price)}</span>
                    <span className="text-ink-3 text-body">/{interval === 'year' ? 'yr' : 'mo'}</span>
                  </p>
                  <ul className="text-body text-ink-2 space-y-1 flex-1">
                    <li>{formatCap(limits.technicians)} technician{limits.technicians === 1 ? '' : 's'}</li>
                    <li>{formatCap(limits.documentsStored)} documents stored</li>
                    <li>{formatCap(limits.pagesPerMonth)} pages/month</li>
                  </ul>
                  <button
                    type="button"
                    className={isCurrent ? 'dw-btn-secondary' : 'dw-btn-primary'}
                    disabled={busy !== null || isCurrent}
                    onClick={() => void runCheckout(`checkout:${planId}`, () => billingClient.checkout(planId, interval))}
                  >
                    {busy === `checkout:${planId}` && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                    {isCurrent && <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
                    {isCurrent ? 'Current plan' : 'Choose plan'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="dw-card p-5 space-y-3" aria-labelledby="rescue-heading">
          <h2 id="rescue-heading" className="text-h3">
            Records Rescue
          </h2>
          <p className="text-ink-2">
            One-time scanning service — {formatCents(RECORDS_RESCUE_UNIT_PRICE_CENTS)}/page, {RECORDS_RESCUE_MIN_PAGES.toLocaleString()}-page minimum (~$500).
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="rescue-pages" className="dw-label block mb-1.5">
                Pages
              </label>
              <input
                id="rescue-pages"
                type="number"
                min={RECORDS_RESCUE_MIN_PAGES}
                step={1}
                className="dw-input w-40"
                value={rescuePages}
                onChange={(e) => setRescuePages(Number(e.target.value) || 0)}
              />
            </div>
            <p className="text-body">
              {rescueQuantity.toLocaleString()} pages · <span className="font-medium">{formatCents(rescueTotalCents)}</span> total
            </p>
          </div>
          <button
            type="button"
            className="dw-btn-primary"
            disabled={busy !== null}
            onClick={() => void runCheckout('rescue', () => billingClient.checkout('records_rescue', 'month', rescueQuantity))}
          >
            {busy === 'rescue' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            Buy Records Rescue
          </button>
        </section>
      </div>
    </AppShell>
  );
}
