// Dev-only harness for the iPad screenshots (scripts/demo-acct/shoot-ipad.mjs): the REAL DemoPicker, AppShell and
// AskScreen, with the Clerk mock and a fetch stub that replays answers captured from the REAL /api/ask handler.
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import '../../../src/index.css';
import { AskScreen } from '../../../src/screens/AskScreen';
import { DemoPicker } from '../../../src/demoAccount/DemoPicker';
import { demoPicked, subscribeDemoPicked } from '../../../src/demoAccount/industries';
import { useAuth } from '@clerk/clerk-react';

const ANSWERS: Record<string, unknown> = (window as any).__ANSWERS ?? {};
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('/api/ask')) {
    const q = JSON.parse(String(init?.body ?? '{}')).question;
    const hit = Object.entries(ANSWERS).find(([k]) => k.endsWith(`::${q}`));
    await new Promise((r) => setTimeout(r, 300));
    return json(hit ? hit[1] : { success: true, data: { kind: 'no-answer', text: 'Nothing in your records answers that yet.' } });
  }
  if (url.includes('action=demo')) return json({ demo: true, industry: 'HVAC', company: 'Coppervane Heating & Air', documents: 45, seedDocuments: 45, scans: 0 });
  if (url.startsWith('/api/')) return json({ success: true, data: {}, prompts: [], items: [] });
  return realFetch(input, init);
}) as typeof window.fetch;

function Root() {
  const { orgId } = useAuth();
  const picked = useSyncExternalStore(subscribeDemoPicked, demoPicked);
  if (!orgId || !picked) return <DemoPicker />;
  return <AskScreen />;
}
createRoot(document.getElementById('root')!).render(<Root />);
