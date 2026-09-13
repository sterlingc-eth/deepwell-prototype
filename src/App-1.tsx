import { lazy, Suspense } from 'react';
import { SignedIn, SignedOut, useAuth } from '@clerk/clerk-react';
import { useAppStore } from './store/appStore';
import { usePostgresSync } from './hooks/usePostgresSync';
import { AskScreen, BrowseScreen, DashboardScreen, EntityScreen, IntakeScreen, RecordsScreen, ReviewScreen } from './screens';
import { LoginScreen } from './screens/LoginScreen';
import './index.css';

// The claim-packet export pulls in jspdf + html2canvas (~60 KB gzipped); only load it when opened.
const WarrantyExportScreen = lazy(() => import('./screens/WarrantyExportScreen').then((m) => ({ default: m.WarrantyExportScreen })));

function AppContent() {
  const currentScreen = useAppStore((s) => s.currentScreen);
  const { userId, orgId } = useAuth();

  // Use orgId as tenantId (Clerk organizations = tenants)
  const tenantId = orgId || userId || 'tenant-default';

  // Enable Postgres sync on app load with real tenantId
  usePostgresSync(tenantId);

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
}

function App() {
  return (
    <>
      <SignedOut>
        <LoginScreen />
      </SignedOut>
      <SignedIn>
        <AppContent />
      </SignedIn>
    </>
  );
}

export default App;
