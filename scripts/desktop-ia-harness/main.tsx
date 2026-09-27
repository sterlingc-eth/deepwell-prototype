// Desktop IA verify harness (round 17, U2/D2 build). Mounts the REAL
// AppShell + real screens against the app's own HVAC demo fixture
// (src/domains/hvac, the same one VITE_DEMO_MODE uses), with
// '@clerk/clerk-react' aliased to a local mock (clerk-mock.tsx) — same
// technique as ../ux17-harness/ (the U2 auditor's own read-only harness),
// adapted here so scripts/verify-desktop-ia.mjs can drive it and actually
// assert on the DOM, not just screenshot it.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import '/repo/src/index.css';
import { bootstrapHvac } from '/repo/src/domains/hvac';
import { useAppStore, type Screen } from '/repo/src/store/appStore';
import { AskScreen } from '/repo/src/screens/AskScreen';
import { DashboardScreen } from '/repo/src/screens/DashboardScreen';
import { TeamScreen } from '/repo/src/screens/TeamScreen';
import { InboxScreen } from '/repo/src/screens/InboxScreen';
import { BrowseScreen } from '/repo/src/screens/BrowseScreen';
import { CustomerProfileScreen } from '/repo/src/screens/CustomerProfileScreen';
import { EntityScreen } from '/repo/src/screens/EntityScreen';
import { BillingScreen } from '/repo/src/screens/BillingScreen';
import { roleState } from './clerk-mock';

bootstrapHvac();

declare global {
  interface Window {
    __dwGo?: (s: Screen) => void;
    __dwDark?: (on: boolean) => void;
    __dwSetAdmin?: (on: boolean) => void;
  }
}

function Root() {
  const currentScreen = useAppStore((s) => s.currentScreen);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const [, force] = useState(0);

  useEffect(() => {
    window.__dwGo = (s: Screen) => setCurrentScreen(s);
    window.__dwDark = (on: boolean) => { document.documentElement.classList.toggle('dark', on); force((n) => n + 1); };
    window.__dwSetAdmin = (on: boolean) => { roleState.role = on ? 'org:admin' : 'org:member'; force((n) => n + 1); };
  }, [setCurrentScreen]);

  switch (currentScreen) {
    case 'ask': return <AskScreen />;
    case 'dashboard': case 'records': return <DashboardScreen />;
    case 'team': return <TeamScreen />;
    case 'ingest': case 'review': return <InboxScreen />;
    case 'browse': return <BrowseScreen />;
    case 'customer': return <CustomerProfileScreen />;
    case 'entity': return <EntityScreen />;
    case 'billing': return <BillingScreen />;
    default: return <AskScreen />;
  }
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Root />);
