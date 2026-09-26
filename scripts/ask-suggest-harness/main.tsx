// Dev-only harness for scripts/verify-ask-suggest-ui.mjs — mounts the Round 14 K1 Ask-suggestion
// components (TypeaheadDropdown, PreflightPill, SamplePromptChips, DidYouMeanChips) against fixed
// fixtures (./fixtures.ts), no store/network/auth involved. Same technique as scripts/answer-harness
// (its own comment explains why this is safe to ship as a non-production entry — vite.config.ts never
// lists it).
import { createRoot } from 'react-dom/client';
import { useAppStore } from '../../src/store/appStore';
import { AskSuggestFixtures } from './Fixtures';
import '../../src/index.css';

declare global {
  interface Window {
    __dwSetField?: (on: boolean) => void;
  }
}
window.__dwSetField = (on: boolean) => useAppStore.getState().setFieldMode(on);
window.__dwOpens = [];

const root = document.getElementById('root');
if (root) createRoot(root).render(<AskSuggestFixtures />);
