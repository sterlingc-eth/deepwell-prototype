import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useAuth, useOrganization } from '@clerk/clerk-react';
import { AlertTriangle, Inbox, Info } from 'lucide-react';
import { authHeader, setAuthTokenProvider } from './services/authToken';
import { useAppStore } from './store/appStore';
import { usePostgresSync } from './hooks/usePostgresSync';
import { useDeepLink } from './hooks/useDeepLink';
import { AskScreen, BrowseScreen, DashboardScreen, EntityScreen, IntakeScreen, LoginScreen, RecordsScreen, ReviewScreen } from './screens';
import { OnboardingScreen } from './screens/OnboardingScreen';
import './index.css';

// The claim-packet export pulls in jspdf + html2canvas (~60 KB gzipped); only load it when opened.
const WarrantyExportScreen = lazy(() => import('./screens/WarrantyExportScreen').then((m) => ({ default: m.WarrantyExportScreen })));

// Same flag main.tsx reads to decide whether to bootstrap the HVAC fixture.
// In demo mode the fixture IS the data — real sync stays off so it can never
// overwrite it (and never race it into an "error" banner against a backend
// the demo was never pointed at).
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

function App() {
  const { isSignedIn, isLoaded, getToken, userId, orgId } = useAuth();
  const { organization } = useOrganization();

  // Hand Clerk's token getter to the service layer so api/ calls are authenticated.
  useEffect(() => {
    setAuthTokenProvider(() => getToken());
    return () => setAuthTokenProvider(null);
  }, [getToken]);
  const currentScreen = useAppStore((s) => s.currentScreen);

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
  const prevOrgId = useRef(orgId);
  const [mergeNotice, setMergeNotice] = useState(false);
  useEffect(() => {
    const had = prevOrgId.current;
    prevOrgId.current = orgId;
    if (!isSignedIn || had || !orgId) return;

    setMergeNotice(true);
    const timer = window.setTimeout(() => setMergeNotice(false), 10_000);
    void (async () => {
      try {
        const headers = { 'Content-Type': 'application/json', ...(await authHeader()) };
        await fetch('/api/merge-tenant', { method: 'POST', headers, body: '{}' });
      } catch {
        /* optimistic — see the comment above this effect */
      }
    })();
    return () => window.clearTimeout(timer);
  }, [isSignedIn, orgId]);

  // Only fetches while signed in, and never in demo mode. Runs unconditionally
  // (rules of hooks) — the `enabled` flag is what actually gates the fetch, so
  // this is safe to call before the isLoaded/isSignedIn returns below.
  const sync = usePostgresSync(!DEMO_MODE && isLoaded && isSignedIn, orgId ?? userId ?? null);

  // ?entity= / ?doc= / ?screen= in the URL open the right record once the
  // graph is loaded. Unconditional for the rules of hooks; it waits for the
  // graph internally and is a no-op without a query string.
  useDeepLink();

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

  // Block on real data the same way we already block on auth: a screen
  // rendered mid-fetch would show zero documents for a beat and look exactly
  // like a fake "empty tenant", which is the one thing this bridge must never
  // do. Demo mode skips this — `sync` never leaves 'idle' there, and the
  // fixture bootstrap in main.tsx already ran synchronously before render.
  if (!DEMO_MODE && (sync.status === 'idle' || sync.status === 'loading')) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }

  const screen = (() => {
    switch (currentScreen) {
      case 'ask':
        return <AskScreen />;
      case 'entity':
        return <EntityScreen />;
      case 'records':
        return <RecordsScreen />;
      case 'ingest':
        return <IntakeScreen />;
      case 'review':
        return <ReviewScreen />;
      case 'dashboard':
        return <DashboardScreen />;
      case 'browse':
        return <BrowseScreen />;
      case 'warranty-export':
        return (
          <Suspense fallback={<div className="min-h-screen bg-bg" aria-busy="true" />}>
            <WarrantyExportScreen />
          </Suspense>
        );
      default:
        return <AskScreen />;
    }
  })();

  return (
    <>
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
      {!DEMO_MODE && sync.status === 'ready' && sync.isEmpty && (
        <div className="dw-card border-line px-5 py-3 m-4 mb-0 text-ink-2 flex items-start gap-2">
          <Inbox className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>Nothing ingested yet for this account. Head to Intake to add your first document.</p>
        </div>
      )}
      {screen}
    </>
  );
}

export default App;
