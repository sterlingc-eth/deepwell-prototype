// Mounts the real App (see index.html). Auth state comes from window.__QA_AUTH (set via Playwright's
// addInitScript) through clerk-mock.tsx; the backend is faked by Playwright routes in verify-app-qa.mjs.
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import App from '../../src/App';
import { useAppStore } from '../../src/store/appStore';

(window as unknown as { __store: typeof useAppStore }).__store = useAppStore;

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
