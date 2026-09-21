import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useAuth, useOrganization } from '@clerk/clerk-react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { authHeader, setAuthTokenProvider } from './services/authToken';
import { fetchDocumentStatus, isProcessingTerminal, pollDocumentStatusChunked } from './services/ingestClient';
import { billingClient } from './services/billingClient';
import { useAppStore } from './store/appStore';
import { DEFAULT_CUSTOMER_FILTERS } from './core/customerFilters';
import { usePostgresSync } from './hooks/usePostgresSync';
import { useDeepLink } from './hooks/useDeepLink';
import { AskScreen, BillingScreen, BrowseScreen, CustomerProfileScreen, DashboardScreen, EntityScreen, InboxScreen, LoginScreen, TeamScreen } from './screens';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { isAdminRole } from './services/teamClient';
import './index.css';

// The claim-packet export pulls in jspdf + html2canvas (~60 KB gzipped); only load it when opened.
const WarrantyExportScreen = lazy(() => import('./screens/WarrantyExportScreen').then((m) => ({ default: m.WarrantyExportScreen })));
// Reached from the Dashboard or a deep link only (not primary nav) — lazy same as WarrantyExportScreen.
const OutreachScreen = lazy(() => import('./screens/OutreachScreen').then((m) => ({ default: m.OutreachScreen })));

// Same flag main.tsx reads to decide whether to bootstrap the HVAC fixture.
// In demo mode the fixture IS the data — real sync stays off so it can never
// overwrite it (and never race it into an "error" banner against a backend
// the demo was never pointed at).
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

function App() {
  const { isSignedIn, isLoaded, getToken, userId, orgId, orgRole } = useAuth();
  const { organization } = useOrganization();

  // Hand Clerk's token getter to the service layer so api/ calls are authenticated.
  useEffect(() => {
    setAuthTokenProvider(() => getToken());
    return () => setAuthTokenProvider(null);
  }, [getToken]);
  const currentScreen = useAppStore((s) => s.currentScreen);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  // Fires once, the moment a signed-in user goes from having no active
  // Clerk organization to having one — creating a shop, accepting an invite,
  // or picking one in OrganizationList all land here, since all three just
  // change `orgId` and OnboardingScreen (rendered below whenever orgId is
  // absent) unmounts as soon as that happens, before it could react itself.
  // NOT fired on an ordinary login where orgId was already set on first
  // render (`prevOrgId` starts at the current value, not null) — this is only
  // for the "just joined/created a shop" transition, which is the one moment
  // any solo work this person did before joining needs to follow them in.
  //
  // api/_lib/auth.js's tenant fallback (`user_${userId}`) is exactly the solo
  // tenant M3-config/07-multi-user.sql's merge_tenant() moves out of; the
  // endpoint below is the one piece of that this UI cannot own (api/ belongs
  // to other engineers) — see HANDOFF.md for its exact contract. Calling it
  // here is deliberately optimistic: on a brand-new account there is nothing
  // to move and the call is a harmless no-op; if the endpoint doesn't exist
  // yet, or the request fails outright, the notice still says what SHOULD
  // happen and nothing about the app breaks either way.
  //
  // Admin-only (handoffs/ORG_INVITES_AUDIT.md): merge_tenant() folds THIS
  // browser's own solo tenant (`user_<callerId>`) into the shop, so a plain
  // invited member running it only ever touches their own prior solo work —
  // never another technician's or the shop's. It's still gated to admins
  // because for an invited member that "solo work" is almost always just
  // pre-invite testing/scratch uploads, not anything that belongs mixed into
  // the shop's shared records without anyone deciding that on purpose, and
  // because a member who just joined has no reason to spend a serverless
  // invocation checking for something an owner-created shop already covers.
  const prevOrgId = useRef(orgId);
  const [mergeNotice, setMergeNotice] = useState(false);
  useEffect(() => {
    const had = prevOrgId.current;
    prevOrgId.current = orgId;
    if (!isSignedIn || had || !orgId || !isAdminRole(orgRole ?? null)) return;

    // Once this browser has already run (or tried) the merge for this org, it
    // must never ask again — without this, `had` is `null` on every fresh
    // page load (this ref starts at whatever `orgId` was on first render,
    // which is always `null` before Clerk resolves it), so the "just joined
    // this org" branch above fires on every single reload, not just the one
    // real transition. Wrapped in try/catch: a browser with storage blocked
    // (private window, locked-down profile) just re-asks every time, which is
    // no worse than before this fix, not a crash.
    const storageKey = `deepwell.merged.${orgId}`;
    try {
      if (window.localStorage.getItem(storageKey) === '1') return;
    } catch {
      /* no localStorage — fall through and run the merge as normal */
    }

    let cancelled = false;
    void (async () => {
      try {
        const headers = { 'Content-Type': 'application/json', ...(await authHeader()) };
        const res = await fetch('/api/merge-tenant', { method: 'POST', headers, body: '{}' });
        if (cancelled) return;
        // The banner text is only ever rendered from here on — after the
        // call has actually started AND finished — never speculatively
        // before we know there was anything to move.
        const data: { moved?: Record<string, number> } = await res.json().catch(() => ({}));
        const movedRows = Object.values(data.moved ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
        try {
          window.localStorage.setItem(storageKey, '1');
        } catch {
          /* best effort — worst case this re-runs next reload */
        }
        if (movedRows > 0) {
          setMergeNotice(true);
          window.setTimeout(() => setMergeNotice(false), 10_000);
        }
      } catch {
        /* optimistic — see the comment above this effect. Deliberately leave
         * the storage flag unset on a real failure so a later reload can
         * still retry the actual merge. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, orgId, orgRole]);

  // Only fetches while signed in, and never in demo mode. Runs unconditionally
  // (rules of hooks) — the `enabled` flag is what actually gates the fetch, so
  // this is safe to call before the isLoaded/isSignedIn returns below.
  const tenantKey = orgId ?? userId ?? null;
  const sync = usePostgresSync(!DEMO_MODE && isLoaded && isSignedIn, tenantKey);

  // Customers tab filters persist for the session (appStore), but a switch
  // to a different tenant (another shop, or back to solo) must not carry a
  // stale filter into data it was never chosen against — reset to defaults
  // whenever the effective tenant actually changes. `prevTenantKey` starts at
  // the first render's value, so this only fires on a real switch, never on
  // ordinary login/reload.
  const prevTenantKey = useRef(tenantKey);
  const setCustomerFilters = useAppStore((s) => s.setCustomerFilters);
  useEffect(() => {
    if (prevTenantKey.current !== tenantKey) {
      prevTenantKey.current = tenantKey;
      setCustomerFilters(DEFAULT_CUSTOMER_FILTERS);
    }
  }, [tenantKey, setCustomerFilters]);

  // First-run: a brand-new shop with zero documents lands straight on the
  // Inbox's "Add files" tab with its big call-to-action, instead of an Ask
  // screen with nothing to ask about or a Dashboard full of zero-value
  // tiles. Skipped whenever the URL itself asked for a specific screen (a
  // deep link) — that request wins. Fires at most once per session.
  const hadDeepLinkOnLoad = useRef(typeof window !== 'undefined' && window.location.search.length > 0);
  const firstRunRedirectedRef = useRef(false);
  useEffect(() => {
    if (DEMO_MODE || firstRunRedirectedRef.current || hadDeepLinkOnLoad.current) return;
    if (sync.status !== 'ready' || !sync.isEmpty) return;
    if (currentScreen !== 'ask') return; // the app default — anything else was a deliberate navigation
    firstRunRedirectedRef.current = true;
    setCurrentScreen('ingest');
  }, [sync.status, sync.isEmpty, currentScreen, setCurrentScreen]);

  // ?entity= / ?doc= / ?screen= / ?plan= in the URL open the right record (or
  // Billing) once the graph is loaded. Unconditional for the rules of hooks;
  // it waits for the graph internally and is a no-op without a query string.
  useDeepLink();

  // Billing status backs AppShell's global banner, BillingScreen's own
  // display, and — HARD GATE (owner decision, 2026-09-21) — whether this
  // tenant gets the app at all: a tenant whose status is 'none' or
  // 'canceled' sees only Billing until they pick a plan (see the render
  // guards below). Fetched once here (not per-screen). `billingStatusLoaded`
  // flips true whether the fetch succeeds or fails so a broken endpoint
  // can't hang the app on the blank/busy screen forever — a failed fetch
  // just means `billingStatus` stays null, which the gate below treats as
  // "not gated" (fails open, same best-effort spirit as the banner always
  // had).
  const billingStatus = useAppStore((s) => s.billingStatus);
  const setBillingStatus = useAppStore((s) => s.setBillingStatus);
  const setBillingConfirming = useAppStore((s) => s.setBillingConfirming);
  const [billingStatusLoaded, setBillingStatusLoaded] = useState(false);
  useEffect(() => {
    if (DEMO_MODE || !isSignedIn || !orgId) return;
    let cancelled = false;
    void billingClient
      .status()
      .then((status) => {
        if (!cancelled) setBillingStatus(status);
      })
      .catch(() => {
        /* best effort — see comment above */
      })
      .finally(() => {
        if (!cancelled) setBillingStatusLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, orgId, setBillingStatus]);

  // `?billing=success|cancel` — Stripe Checkout's return trip. A toast plus a
  // fresh status fetch (the webhook that actually updates billing_status can
  // land a beat after the redirect, but re-fetching now catches it as soon as
  // it does rather than waiting for next reload). Read and scrubbed once, on
  // mount, the same way useDeepLink handles its own query params.
  const [billingToast, setBillingToast] = useState<'success' | 'cancel' | null>(null);
  const billingToastHandledRef = useRef(false);
  useEffect(() => {
    if (billingToastHandledRef.current) return;
    billingToastHandledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const billing = params.get('billing');
    if (billing !== 'success' && billing !== 'cancel') return;
    setBillingToast(billing);
    params.delete('billing');
    const url = new URL(window.location.href);
    url.search = params.toString();
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (billing !== 'success' || DEMO_MODE) return;

    // The webhook that actually flips billing_status away from 'none' can
    // land a beat after Checkout's redirect — a single refetch here would
    // often still show 'none' and re-trap the person behind the hard gate
    // for a few seconds. Poll instead: every 3s for up to 60s, until the
    // status is no longer 'none' (or we give up — a reload/"Manage billing"
    // still works after that). `billingConfirming` drives BillingScreen's
    // "Confirming your subscription…" state while this runs.
    let cancelled = false;
    setBillingConfirming(true);
    const deadline = Date.now() + 60_000;
    const poll = () => {
      void billingClient
        .status()
        .then((s) => {
          if (cancelled) return;
          setBillingStatus(s);
          if (s.status !== 'none') {
            setBillingConfirming(false);
            return;
          }
          if (Date.now() < deadline) window.setTimeout(poll, 3000);
          else setBillingConfirming(false);
        })
        .catch(() => {
          if (cancelled) return;
          if (Date.now() < deadline) window.setTimeout(poll, 3000);
          else setBillingConfirming(false);
        });
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [setBillingStatus, setBillingConfirming]);

  // Server-side pipeline polling behind the header's "Processing N of M…"
  // pill (store/appStore.ts's selectIngestProgress). Lives here — mounted for
  // the whole signed-in session — rather than in IntakeScreen, so it keeps
  // running no matter which screen the person navigates to mid-upload.
  // Capped at ten minutes of wall clock; past that this stops polling and the
  // pill switches to "Still working on N — check Inbox" (see AppShell.tsx).
  const processingPending = useAppStore((s) => s.processingPending);
  const processingStartedAt = useAppStore((s) => s.processingStartedAt);
  const settleProcessingDocs = useAppStore((s) => s.settleProcessingDocs);
  const setProcessingStalled = useAppStore((s) => s.setProcessingStalled);
  useEffect(() => {
    if (DEMO_MODE || processingPending.length === 0) return;
    const CAP_MS = 10 * 60 * 1000;
    let cancelled = false;
    let intervalId: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (processingStartedAt !== null && Date.now() - processingStartedAt > CAP_MS) {
        setProcessingStalled(true);
        // Stop polling the moment the cap trips — a stalled run has nothing
        // left to check for until the next upload starts a fresh one, so an
        // interval left running here would just be a no-op timer forever.
        if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
        return;
      }
      try {
        // Chunked (≤100 ids/request, api/document-status.js's own cap) with
        // each chunk isolated: a bulk import tracking hundreds of documents
        // must not have one failed chunk's request stall every other
        // chunk's documents from ever settling.
        const rows = await pollDocumentStatusChunked(processingPending, fetchDocumentStatus);
        if (cancelled) return;
        const done = rows.filter(isProcessingTerminal).map((r) => r.id);
        if (done.length) settleProcessingDocs(done);
      } catch {
        /* a dropped poll just tries again next tick */
      }
    };

    void tick();
    intervalId = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [processingPending, processingStartedAt, settleProcessingDocs, setProcessingStalled]);

  // Show loading screen while authentication is loading
  if (!isLoaded) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }

  // Show login screen if not authenticated
  if (!isSignedIn) {
    return <LoginScreen />;
  }

  // A signed-in user with no active shop is mid-onboarding, not mid-loading —
  // show the gate instead of a blank app whose every screen would report an
  // empty, unshared account. Skipped in demo mode: the fixture bootstrap in
  // main.tsx is not a real Clerk org and must never be blocked on becoming one.
  if (!DEMO_MODE && !orgId) {
    return <OnboardingScreen />;
  }

  // HARD GATE (owner decision, 2026-09-21): don't decide "full app or
  // paywall" until billing status has actually loaded once — same blank/busy
  // treatment as the auth guard above, so a never-subscribed tenant never
  // sees the real app flash before the gate below yanks it away.
  if (!DEMO_MODE && !billingStatusLoaded) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }

  // A tenant with no active subscription — never subscribed ('none') or a
  // canceled one — gets ONLY Billing (plus Team/Sign out in AppShell's nav)
  // until they pick a plan. No free preview any more; api/_lib/plan.js's
  // FREE_PREVIEW_DOCUMENTS enforces the same rule server-side on upload/ask
  // so this is UI convenience, not the actual security boundary.
  // `billingStatus` staying null (never fetched, or the fetch failed) fails
  // OPEN — consistent with the banner's existing best-effort handling above.
  const billingGateActive = !DEMO_MODE && !!billingStatus && (billingStatus.status === 'none' || billingStatus.status === 'canceled');

  // Block on real data the same way we already block on auth: a screen
  // rendered mid-fetch would show zero documents for a beat and look exactly
  // like a fake "empty tenant", which is the one thing this bridge must never
  // do. Demo mode skips this — `sync` never leaves 'idle' there, and the
  // fixture bootstrap in main.tsx already ran synchronously before render.
  // Skipped while the billing gate is active — a gated tenant never sees
  // synced document data, so there's nothing worth waiting on here.
  if (!billingGateActive && !DEMO_MODE && (sync.status === 'idle' || sync.status === 'loading')) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }

  const screen = (() => {
    // Gated: only Billing and Team (matching AppShell's restricted nav) are
    // reachable — anything else (including the 'ask' default) falls back to
    // Billing rather than rendering a screen full of data this tenant can't
    // have yet.
    if (billingGateActive) {
      return currentScreen === 'team' ? <TeamScreen /> : <BillingScreen />;
    }
    switch (currentScreen) {
      case 'ask':
        return <AskScreen />;
      case 'entity':
        return <EntityScreen />;
      case 'customer':
        return <CustomerProfileScreen />;
      // 'ingest' and 'review' both render the merged Inbox screen — which
      // tab is active lives in the store's `inboxTab`, not in this switch
      // (see store/appStore.ts's setCurrentScreen aliasing).
      case 'ingest':
      case 'review':
        return <InboxScreen />;
      // 'records' is a retired top-level id, aliased to 'dashboard' by the
      // store the moment it's set — kept here too as a defensive fallback.
      case 'records':
      case 'dashboard':
        return <DashboardScreen />;
      case 'browse':
        return <BrowseScreen />;
      case 'billing':
        return <BillingScreen />;
      case 'team':
        return <TeamScreen />;
      case 'warranty-export':
        return (
          <Suspense fallback={<div className="min-h-screen bg-bg" aria-busy="true" />}>
            <WarrantyExportScreen />
          </Suspense>
        );
      case 'outreach':
        return (
          <Suspense fallback={<div className="min-h-screen bg-bg" aria-busy="true" />}>
            <OutreachScreen />
          </Suspense>
        );
      default:
        return <AskScreen />;
    }
  })();

  return (
    <>
      {billingToast && (
        <div
          role="status"
          className={[
            'dw-card px-5 py-3 m-4 mb-0 flex items-start gap-2',
            billingToast === 'success' ? 'border-ok/40 text-ok-ink dark:text-ok-bg' : 'border-line text-ink-2',
          ].join(' ')}
        >
          {billingToast === 'success' ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          ) : (
            <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          )}
          <p className="flex-1">{billingToast === 'success' ? 'Billing updated — thanks!' : 'Checkout canceled — nothing was charged.'}</p>
          <button type="button" onClick={() => setBillingToast(null)} aria-label="Dismiss" className="text-ink-3 hover:text-ink shrink-0">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}
      {mergeNotice && (
        <div className="dw-card border-line px-5 py-3 m-4 mb-0 text-ink-2 flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>Moving any earlier uploads into {organization?.name ?? 'your shop'}…</p>
        </div>
      )}
      {!DEMO_MODE && sync.status === 'error' && (
        <div role="alert" className="dw-card border-bad/40 px-5 py-3 m-4 mb-0 text-bad-ink dark:text-bad-bg flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-medium">Couldn't load your records.</span>{' '}
            <span className="text-body">{sync.error} Showing whatever loaded earlier this session, if anything.</span>
          </p>
        </div>
      )}
      {screen}
    </>
  );
}

export default App;
