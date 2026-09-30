// Mounts the real App (see index.html). Auth state comes from window.__QA_AUTH (set via Playwright's
// addInitScript) through clerk-mock.tsx; the backend is faked by Playwright routes in verify-app-qa.mjs.
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import App from '../../src/App';
import { useAppStore } from '../../src/store/appStore';
import { useGraph } from '../../src/core/entityGraph';

(window as unknown as { __store: typeof useAppStore }).__store = useAppStore;
(window as unknown as { __graph: typeof useGraph }).__graph = useGraph;

import { installErrorReporter } from '../../src/services/errorReporter';
// Same call src/main.tsx makes (verify-r31-qa.mjs also checks the real entry files).
installErrorReporter('app', () => useAppStore.getState().currentScreen);

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
