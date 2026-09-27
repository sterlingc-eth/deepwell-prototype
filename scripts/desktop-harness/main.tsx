// Dev-only harness for scripts/verify-desktop-ux.mjs. Mounts the REAL AppShell + real screens
// against the app's own HVAC demo fixture (bootstrapHvac), with '@clerk/clerk-react' aliased to
// clerk-mock.tsx (see the runner's vite config) so no live Clerk session is needed. Adapted from
// the U2 desktop UX audit's read-only scratch harness (../ux17-harness/ one directory up from the
// repo) — this copy lives inside the repo so the R17 UX-D1 verify script can run it directly, but
// it is still never part of any production build (vite.config.ts's rollupOptions.input never
// lists this directory).
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import '../../src/index.css';
import { bootstrapHvac } from '../../src/domains/hvac';
import { useAppStore, type Screen } from '../../src/store/appStore';
import { AskScreen } from '../../src/screens/AskScreen';
import { DashboardScreen } from '../../src/screens/DashboardScreen';
import { InboxScreen } from '../../src/screens/InboxScreen';
import { BrowseScreen } from '../../src/screens/BrowseScreen';
import { CustomerProfileScreen } from '../../src/screens/CustomerProfileScreen';
import { WarrantyExportScreen } from '../../src/screens/WarrantyExportScreen';
import { CUSTOMER_ID, CUSTOMERS_LIST_RESPONSE, CUSTOMER_DETAIL_RESPONSE, REMINDERS_RESPONSE } from './fixtures';

bootstrapHvac();

// CustomerProfileScreen/CustomersScreen hit real endpoints even in demo mode (only
// DashboardScreen's own bonus cards gate on VITE_DEMO_MODE) — stub just those three so the
// customer -> equipment-tab check (R17 UX audit fix #6 / task 4) exercises the real click path
// instead of a load-error screen. Everything else falls through to the real fetch (which 404s
// harmlessly — every caller here already fails quiet).
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('/api/v1/customers')) return json(CUSTOMERS_LIST_RESPONSE);
  if (url.startsWith('/api/v1/customer?')) return json(CUSTOMER_DETAIL_RESPONSE);
  if (url.startsWith('/api/review') && init?.body && String(init.body).includes('remindersList')) return json(REMINDERS_RESPONSE);
  return realFetch(input, init);
}) as typeof window.fetch;

declare global {
  interface Window {
    __dwGo?: (s: Screen) => void;
    __dwDark?: (on: boolean) => void;
    __dwOpenCustomer?: () => void;
  }
}

function Root() {
  const currentScreen = useAppStore((s) => s.currentScreen);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const openCustomer = useAppStore((s) => s.openCustomer);
  const [, force] = useState(0);

  useEffect(() => {
    window.__dwGo = (s: Screen) => setCurrentScreen(s);
    window.__dwDark = (on: boolean) => { document.documentElement.classList.toggle('dark', on); force((n) => n + 1); };
    window.__dwOpenCustomer = () => openCustomer(CUSTOMER_ID);
  }, [setCurrentScreen, openCustomer]);

  switch (currentScreen) {
    case 'ask': return <AskScreen />;
    case 'dashboard': return <DashboardScreen />;
    case 'ingest': case 'review': return <InboxScreen />;
    case 'browse': return <BrowseScreen />;
    case 'customer': return <CustomerProfileScreen />;
    case 'warranty-export': return <WarrantyExportScreen />;
    default: return <DashboardScreen />;
  }
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Root />);
