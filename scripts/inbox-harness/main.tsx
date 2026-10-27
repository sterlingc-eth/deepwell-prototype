// Dev-only harness for the Inbox redesign (never part of a production build): the REAL AppShell + InboxScreen over a
// synthetic inbox of a few hundred papers. '@clerk/clerk-react' is aliased to the desktop harness's mock by the runner.
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { InboxScreen } from '../../src/screens/InboxScreen';
import { useAppStore } from '../../src/store/appStore';
import { seedInbox } from './seed';
import { useGraph } from '../../src/core/entityGraph';

const q = new URLSearchParams(window.location.search);
seedInbox({ total: Number(q.get('n') ?? 400) });
useAppStore.getState().setInboxTab('needs-person');
(window as unknown as { __dwGraph: typeof useGraph }).__dwGraph = useGraph;
(window as unknown as { __dwDark: (on: boolean) => void }).__dwDark = (on) => document.documentElement.classList.toggle('dark', on);
if (q.get('theme') === 'light') document.documentElement.classList.remove('dark');

const root = document.getElementById('root');
if (root) createRoot(root).render(<InboxScreen />);
