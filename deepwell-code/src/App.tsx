import { AnimatePresence } from 'framer-motion';
import { useAppStore } from './store/appStore';
import {
  HomeScreen,
  OnSiteSearchScreen,
  JobDispatchBriefScreen,
  WarrantyExportScreen,
  DocumentIngestionScreen,
  ExtractionReviewScreen,
  DashboardScreen,
  TechnicianProfileScreen,
  EquipmentDetailScreen,
  WarrantyTrackingScreen,
} from './screens';
import './index.css';

function App() {
  const currentScreen = useAppStore((s) => s.currentScreen);

  return (
    <AnimatePresence mode="wait">
      {currentScreen === 'home' && <DocumentIngestionScreen key="home" />}
      {currentScreen === 'dashboard' && <DashboardScreen key="dashboard" />}
      {currentScreen === 'extraction-review' && <ExtractionReviewScreen key="extraction-review" />}
      {currentScreen === 'search' && <OnSiteSearchScreen key="search" />}
      {currentScreen === 'dispatch-brief' && <JobDispatchBriefScreen key="dispatch-brief" />}
      {currentScreen === 'warranty-export' && <WarrantyExportScreen key="warranty-export" />}
      {currentScreen === 'technician-profile' && <TechnicianProfileScreen key="technician-profile" />}
      {currentScreen === 'equipment-detail' && <EquipmentDetailScreen key="equipment-detail" />}
      {currentScreen === 'warranty-tracking' && <WarrantyTrackingScreen key="warranty-tracking" />}
    </AnimatePresence>
  );
}

export default App;
