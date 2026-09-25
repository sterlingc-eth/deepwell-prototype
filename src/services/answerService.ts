/**
 * answerService — the one entry point the UI calls.
 *
 *   ask(question) => Promise<Answer>
 *
 * Provider is chosen once: the deterministic mock (default) or the Claude-
 * backed provider behind /api/ask. Same Answer shape either way, so the
 * AnswerCard never changes.
 */
import type { Answer, AnswerProvider, AskOptions } from '../core/types';
import { useGraph } from '../core/entityGraph';
import { createClaudeProvider } from './answerService.claude';

// Re-exported so screens (AskScreen) can `instanceof` check a 402 without
// reaching past this module into the provider-specific file directly.
export { AskApiError } from './answerService.claude';

export type ProviderName = 'mock' | 'claude';

function chooseProvider(): ProviderName {
  const fromEnv = (import.meta.env.VITE_ANSWER_PROVIDER as string | undefined)?.toLowerCase();
  return fromEnv === 'claude' ? 'claude' : 'mock';
}

let provider: AnswerProvider | null = null;
let providerName: ProviderName = chooseProvider();

export function getProviderName(): ProviderName {
  return providerName;
}

/** Swap providers at runtime (settings toggle, tests). */
export function setProvider(name: ProviderName): void {
  providerName = name;
  provider = null;
}

// The deterministic mock (and the HVAC demo answer engine behind it) is only
// ever used in demo/dev builds, so it's loaded on demand rather than shipped
// in every production bundle (it was ~30 KB of the phone app's first load).
async function getProvider(): Promise<AnswerProvider> {
  if (!provider) {
    const snapshot = () => useGraph.getState();
    if (providerName === 'claude') {
      provider = createClaudeProvider(snapshot);
    } else {
      const { createMockProvider } = await import('./answerService.mock');
      provider = createMockProvider(snapshot);
    }
  }
  return provider;
}

export function ask(question: string, opts?: AskOptions): Promise<Answer> {
  const trimmed = question.trim();
  if (!trimmed) {
    return Promise.resolve({
      kind: 'no-answer',
      text: 'Type an address, a serial number, a name, or a question.',
      facts: [],
      sources: [],
      confidence: 0,
      verifiedCount: 0,
      unverifiedCount: 0,
      closest: [],
    });
  }
  return getProvider().then((p) => p.ask(trimmed, opts));
}
