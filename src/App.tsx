import { lazy, Suspense, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { AlertTriangle, Inbox } from 'lucide-react';
import { setAuthTokenProvider } from './services/authToken';
import { useAppStore } from './store/appStore';
import { usePostgresSync } from './hooks/usePostgresSync';
import { AskScreen, BrowseScreen, DashboardScreen, EntityScreen, IntakeScreen, LoginScreen, RecordsScreen, ReviewScreen } from './screens';
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

  // Hand Clerk's token getter to the service layer so api/ calls are authenticated.
  useEffect(() => {
    setAuthTokenProvider(() => getToken());
    return () => setAuthTokenProvider(null);
  }, [getToken]);
  const currentScreen = useAppStore((s) => s.currentScreen);

  // Only fetches while signed in, and never in demo mode. Runs unconditionally
  // (rules of hooks) — the `enabled` flag is what actually gates the fetch, so
  // this is safe to call before the isLoaded/isSignedIn returns below.
  const sync = usePostgresSync(!DEMO_MODE && isLoaded && isSignedIn, orgId ?? userId ?? null);

  // Show loading screen while authentication is loading
  if (!isLoaded) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }

  // Show login screen if not authenticated
  if (!isSignedIn) {
    return <LoginScreen />;
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
