// Dev-only harness for scripts/verify-insights-ui.mjs — mounts the real InsightsCard against a
// stubbed fetch (canned FIXTURE_RESPONSE / EMPTY_RESPONSE from ./fixtures.ts), so the component's
// own network call, expand/collapse state and action routing all run for real. Same technique as
// scripts/answer-harness (its own comment explains why this is safe to ship as a non-production
// entry — vite.config.ts never lists it).
import { createRoot } from 'react-dom/client';
import { useAppStore } from '../../src/store/appStore';
import { InsightsCard } from '../../src/components/insights/InsightsCard';
import { FIXTURE_RESPONSE, EMPTY_RESPONSE } from './fixtures';
import '../../src/index.css';

declare global {
  interface Window {
    __dwSetField?: (on: boolean) => void;
    __dwAsks?: string[];
    __dwInboxOpens?: number;
  }
}
window.__dwSetField = (on: boolean) => useAppStore.getState().setFieldMode(on);
window.__dwAsks = [];
window.__dwInboxOpens = 0;

const params = new URLSearchParams(window.location.search);
const empty = params.get('state') === 'empty';

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('action=insights')) {
    return new Response(JSON.stringify(empty ? EMPTY_RESPONSE : FIXTURE_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input, init);
}) as typeof window.fetch;

function Harness() {
  return (
    <div className="min-h-screen bg-surface p-4 max-w-md mx-auto" data-testid="insights-root">
      <InsightsCard
        onAsk={(q) => window.__dwAsks?.push(q)}
        onOpenInbox={() => {
          window.__dwInboxOpens = (window.__dwInboxOpens ?? 0) + 1;
        }}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Harness />);
