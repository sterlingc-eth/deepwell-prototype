import { lazy, Suspense, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { setAuthTokenProvider } from './services/authToken';
import { useAppStore } from './store/appStore';
import { AskScreen, BrowseScreen, DashboardScreen, EntityScreen, IntakeScreen, LoginScreen, RecordsScreen, ReviewScreen } from './screens';
import './index.css';

// The claim-packet export pulls in jspdf + html2canvas (~60 KB gzipped); only load it when opened.
const WarrantyExportScreen = lazy(() => import('./screens/WarrantyExportScreen').then((m) => ({ default: m.WarrantyExportScreen })));

function App() {
  const { isSignedIn, isLoaded, getToken } = useAuth();

  // Hand Clerk's token getter to the service layer so api/ calls are authenticated.
  useEffect(() => {
    setAuthTokenProvider(() => getToken());
    return () => setAuthTokenProvider(null);
  }, [getToken]);
  const currentScreen = useAppStore((s) => s.currentScreen);

  // Show loading screen while authentication is loading
  if (!isLoaded) {
    return <div className="min-h-screen bg-bg" aria-busy="true" />;
  }

  // Show login screen if not authenticated
  if (!isSignedIn) {
    return <LoginScreen />;
  }

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

export default App;
