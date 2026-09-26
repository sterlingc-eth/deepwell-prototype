// See desktop.html's comment. Renders IntakeQueuePanel on its own, with a
// window-exposed hook to flip theme (dark = Office, light = Field) for the
// verify script. IntakeQueuePanel is itself responsive (same Tailwind
// breakpoints InboxScreen renders it at), so one entry point covers both the
// 1280px desktop and 390px mobile-web screenshots — no separate mobile file
// needed (unlike RecordsBrowser/DocsTab, which really are two components).
import { createRoot } from 'react-dom/client';
import { IntakeQueuePanel } from '../../src/components/intake/IntakeQueuePanel';
import '../../src/index.css';

declare global {
  interface Window {
    __dwSetDark?: (on: boolean) => void;
  }
}
window.__dwSetDark = (on: boolean) => document.documentElement.classList.toggle('dark', on);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <div style={{ minHeight: '100vh', padding: '16px' }} className="bg-bg text-ink">
      <IntakeQueuePanel />
    </div>
  );
}
