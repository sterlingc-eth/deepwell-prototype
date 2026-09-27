// Dev-only harness for scripts/verify-ask-ux.mjs — see Harness.tsx and that script's own comment. Same
// technique as scripts/ask-suggest-harness (its own comment explains why this is safe to ship as a
// non-production entry — vite.config.ts never lists it).
import { createRoot } from 'react-dom/client';
import { useAppStore } from '../../src/store/appStore';
import { AskUxHarness } from './Harness';
import '../../src/index.css';

declare global {
  interface Window {
    __dwSetField?: (on: boolean) => void;
  }
}
window.__dwSetField = (on: boolean) => useAppStore.getState().setFieldMode(on);

const root = document.getElementById('root');
if (root) createRoot(root).render(<AskUxHarness />);
