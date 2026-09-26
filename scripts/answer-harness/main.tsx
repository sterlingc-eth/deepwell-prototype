// Dev-only harness for scripts/verify-answer-ui.mjs — mounts AnswerCard and MobileAnswer against the
// fixtures in ./fixtures.ts, one of each per answerLayout() kind, seeded into useGraph so citation
// chips/SourceList/documentName all resolve for real. Same technique as scripts/graph-harness (its own
// comment explains why this is safe to ship as a non-production entry — vite.config.ts never lists it).
import { createRoot } from 'react-dom/client';
import { useGraph } from '../../src/core/entityGraph';
import { useAppStore } from '../../src/store/appStore';
import { DOCS, SCHEMA } from './fixtures';
import { DesktopFixtures, MobileFixtures } from './Fixtures';
import '../../src/index.css';

declare global {
  interface Window {
    __dwSetField?: (on: boolean) => void;
  }
}
window.__dwSetField = (on: boolean) => useAppStore.getState().setFieldMode(on);
window.__dwOpens = [];

useGraph.getState().seed(SCHEMA, [], Object.values(DOCS), [], []);

const params = new URLSearchParams(window.location.search);
const view = params.get('view') === 'mobile' ? 'mobile' : 'desktop';

const root = document.getElementById('root');
if (root) createRoot(root).render(view === 'mobile' ? <MobileFixtures /> : <DesktopFixtures />);
