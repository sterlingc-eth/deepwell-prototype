// See desktop.html's comment. Renders GridView on its own, with a
// window-exposed hook to flip theme (dark = Office, light = Field) for the
// verify script. GridView reads useAppStore().openDocument (real store —
// harmless no-op here since nothing subscribes to selectedDocumentId) and
// useRecordsBrowse (real hook, hits the mocked /api/records).
import { createRoot } from 'react-dom/client';
import { GridView } from '../../src/components/grid/GridView';
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
    <div style={{ height: '100vh', padding: 16 }} className="bg-surface">
      <GridView />
    </div>,
  );
}
