/**
 * Startup performance (handoffs/STARTUP_PERF_R13.md).
 *
 * The old startup waterfall fired billing status, two records calls, review,
 * document-status and account/notifications one after another (~3.8s warm,
 * much worse cold). This hook fires ONE request — POST /api/records
 * action=bootstrap — that returns billing status, the notification badge
 * count, and a first page of documents in a single tenant transaction (see
 * api/records.ts's runBootstrap), and wires the result into the same store
 * fields the old per-endpoint calls used, so no consuming component needs to
 * know which path filled them.
 *
 * Billing status specifically also gets a sessionStorage cache: read
 * synchronously (well, in the first effect tick — see below) BEFORE the
 * network call resolves, so a returning tenant's billing gate (App.tsx's
 * `billingGateActive`) has last-known-good data immediately instead of
 * failing open (briefly showing the full app) on every single reload. The
 * gate only ever actually blocks once a status — cached or fresh — says
 * none/canceled; a cache miss or a slow network still fails open, same as
 * before this hook existed.
 *
 * Cross-tenant isolation (reviewer NO-GO, 2026-09-26): a same-tab tenant
 * switch (Clerk's OrganizationSwitcher, no page reload) changes `orgId`
 * without unmounting anything, so this hook now (a) keys the sessionStorage
 * cache by BOTH org id and user id — never just the `tenantKey` shorthand,
 * which collapses to a single id and would let a cache entry read back
 * against the wrong pairing — and (b) clears whatever the PREVIOUS tenant
 * left in the store (billing status, notification count) synchronously the
 * moment a switch is detected, before this tenant's own cache read or
 * fetch, so nothing from the old tenant is ever shown against the new one.
 */
import { useEffect, useRef } from 'react';
import { bootstrapClient } from '../services/bootstrapClient';
import { billingClient, type BillingStatus } from '../services/billingClient';
import { useAppStore } from '../store/appStore';
import { seedDocsPartial } from './usePostgresSync';

const CACHE_PREFIX = 'deepwell.billingStatus.';

/** Keyed by BOTH ids — see this file's cross-tenant-isolation doc comment. */
function cacheKeyFor(orgId: string | null | undefined, userId: string | null | undefined): string {
  return `${CACHE_PREFIX}${userId ?? 'anon'}::${orgId ?? 'solo'}`;
}

function readCachedBilling(cacheKey: string): BillingStatus | null {
  try {
    const raw = window.sessionStorage.getItem(cacheKey);
    return raw ? (JSON.parse(raw) as BillingStatus) : null;
  } catch {
    return null; // private window, storage blocked, or a stale/corrupt entry — just skip the cache
  }
}

function writeCachedBilling(cacheKey: string, status: BillingStatus): void {
  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify(status));
  } catch {
    /* best-effort — worst case this tenant just fails open again next reload */
  }
}

export function useBootstrap(enabled: boolean, orgId: string | null | undefined, userId: string | null | undefined): void {
  const setBillingStatus = useAppStore((s) => s.setBillingStatus);
  const setNotificationsUnread = useAppStore((s) => s.setNotificationsUnread);
  const setBootstrapStatus = useAppStore((s) => s.setBootstrapStatus);
  const tenantKey = orgId ?? userId ?? null;
  const cacheKey = cacheKeyFor(orgId, userId);
  // Guards against StrictMode's double-invoked effect and re-renders that
  // don't actually change tenantKey firing this twice for the same tenant;
  // also what detects an actual tenant switch (see below).
  const ranFor = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !tenantKey) return;

    // Cross-tenant isolation: a real switch (not the first-ever run) —
    // whatever the previous tenant left in the store must never leak into
    // this one, even for the instant before this tenant's own data lands.
    if (ranFor.current !== null && ranFor.current !== tenantKey) {
      setBillingStatus(null);
      setNotificationsUnread(0);
      setBootstrapStatus('idle');
    }

    const cached = readCachedBilling(cacheKey);
    if (cached) setBillingStatus(cached);

    if (ranFor.current === tenantKey) return;
    ranFor.current = tenantKey;

    let cancelled = false;
    setBootstrapStatus('loading');
    void bootstrapClient
      .bootstrap()
      .then((data) => {
        if (cancelled) return;
        setBillingStatus(data.billing);
        writeCachedBilling(cacheKey, data.billing);
        setNotificationsUnread(data.notifications.unreadCount);
        seedDocsPartial(data.records.rows);
        setBootstrapStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setBootstrapStatus('error');
        // Fall back to the one thing the hard gate actually depends on —
        // this keeps working even against an API deployed before the
        // bootstrap action existed (unknown action -> 400 -> this branch).
        void billingClient
          .status()
          .then((status) => {
            if (cancelled) return;
            setBillingStatus(status);
            writeCachedBilling(cacheKey, status);
          })
          .catch(() => {
            /* best-effort, same as the old billing effect this replaces */
          });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, tenantKey, cacheKey, setBillingStatus, setNotificationsUnread, setBootstrapStatus]);
}
