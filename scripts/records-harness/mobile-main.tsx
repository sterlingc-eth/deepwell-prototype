// See mobile.html's comment.
import { createRoot } from 'react-dom/client';
import { DocsTab } from '../../src/mobile/DocsTab';
import '../../src/index.css';
import '../../src/mobile/mobile.css';

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
    <DocsTab
      syncStatus="ready"
      onOpenDoc={(id) => window.__dwOpened?.push(id)}
      onRefresh={async () => {}}
    />
  );
}
