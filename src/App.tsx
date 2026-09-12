import { lazy, Suspense } from 'react';
import { useAppStore } from './store/appStore';
import { AskScreen, BrowseScreen, DashboardScreen, EntityScreen, IntakeScreen, RecordsScreen, ReviewScreen } from './screens';
import './index.css';

// The claim-packet export pulls in jspdf + html2canvas (~60 KB gzipped); only load it when opened.
const WarrantyExportScreen = lazy(() => import('./screens/WarrantyExportScreen').then((m) => ({ default: m.WarrantyExportScreen })));

function App() {
  const currentScreen = useAppStore((s) => s.currentScreen);

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
