// Split out of main.tsx so this file only exports a component (oxlint's react-refresh rule), same
// convention scripts/ask-suggest-harness/Fixtures.tsx and scripts/answer-harness/Fixtures.tsx already use.
import { useSamplePrompts } from '../../src/core/suggestions';
import { SamplePromptChips, SamplePromptsPlaceholder } from '../../src/components/ask';
import { FIXTURES } from './fixtures';

// Query params (set by scripts/verify-ask-ux.mjs's page.goto URL, read once per page load — a reload IS
// a fresh "visit" for the tenant this is testing, exactly matching the bug report: "when I click on
// Donovan" is a fresh mount, not a re-render of one already showing):
//   tenant   — cache-scoping key passed straight to useSamplePrompts (never derived from Clerk here —
//              this harness has no ClerkProvider; see AskScreen.tsx/AskTab.tsx for the real source).
//   role     — 'tech' | 'office', defaults 'office'.
//   delay    — ms the mocked /api/account?action=ask-suggest response is held before resolving.
//   variant  — which FIXTURES entry the mock responds with this load.
const params = new URLSearchParams(window.location.search);
const MOCK_DELAY_MS = Number(params.get('delay') ?? '0');
const MOCK_VARIANT = params.get('variant') ?? 'A';

// Installed once, at module load — before React's first effect can possibly fire — so every
// useSamplePrompts fetch this page ever makes goes through this mock, never a real network call.
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (url.includes('action=ask-suggest')) {
    let op = '';
    try {
      op = (JSON.parse(String(init?.body ?? '{}')) as { op?: string }).op ?? '';
    } catch {
      /* malformed body — fall through to the 400 a real server would give */
    }
    if (op === 'samples') {
      return new Promise((resolve) => {
        window.setTimeout(() => {
          const prompts = FIXTURES[MOCK_VARIANT] ?? [];
          resolve(new Response(JSON.stringify({ prompts }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }, MOCK_DELAY_MS);
      });
    }
  }
  return realFetch(input, init);
};

export function AskUxHarness() {
  const tenant = params.get('tenant');
  const role = params.get('role') === 'tech' ? 'tech' : 'office';
  const { prompts, loading } = useSamplePrompts(role, true, tenant);
  return (
    <div style={{ maxWidth: 672, margin: '0 auto', padding: 16 }}>
      <h2 className="dw-label">Try asking</h2>
      <div data-testid="suggestions-container">
        {loading ? <SamplePromptsPlaceholder /> : <SamplePromptChips prompts={prompts} onPick={() => {}} />}
      </div>
    </div>
  );
}
