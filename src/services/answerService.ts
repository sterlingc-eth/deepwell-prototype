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
import { createMockProvider } from './answerService.mock';
import { createClaudeProvider } from './answerService.claude';

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

function getProvider(): AnswerProvider {
  if (!provider) {
    const snapshot = () => useGraph.getState();
    provider = providerName === 'claude' ? createClaudeProvider(snapshot) : createMockProvider(snapshot);
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
  return getProvider().ask(trimmed, opts);
}
