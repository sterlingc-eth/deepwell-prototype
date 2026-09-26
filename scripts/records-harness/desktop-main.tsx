// See desktop.html's comment. Renders RecordsBrowser on its own, with a
// window-exposed hook to flip theme (dark = Office, light = Field) for the
// verify script, and records opened-document clicks on window for assertions.
import { createRoot } from 'react-dom/client';
import { RecordsBrowser } from '../../src/components/records/RecordsBrowser';
import '../../src/index.css';

declare global {
  interface Window {
    __dwSetDark?: (on: boolean) => void;
    __dwOpened?: string[];
  }
}
window.__dwSetDark = (on: boolean) => document.documentElement.classList.toggle('dark', on);
window.__dwOpened = [];

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <div style={{ height: '100vh' }}>
      <RecordsBrowser onOpenDocument={(id) => window.__dwOpened?.push(id)} />
    </div>
  );
}
