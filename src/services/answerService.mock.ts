import type { AnswerProvider } from '../core/types';
import type { GraphSnapshot } from '../core/entityGraph';
import { answerHvac } from '../domains/hvac/answer';

/**
 * Deterministic provider: reads the entity graph, understands a fixed set of
 * question shapes, and cites the documents behind every fact. A short delay
 * keeps the UI honest about its loading state.
 */
export function createMockProvider(snapshot: () => GraphSnapshot, delayMs = 220): AnswerProvider {
  return {
    async ask(question, opts) {
      const answer = answerHvac(question, snapshot(), opts);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return answer;
    },
  };
}

/** Synchronous variant for tests and the eval script. */
export function answerSync(question: string, snapshot: GraphSnapshot, opts?: Parameters<typeof answerHvac>[2]) {
  return answerHvac(question, snapshot, opts);
}
