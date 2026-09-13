import type { AnswerProvider, AskStage } from '../core/types';
import type { GraphSnapshot } from '../core/entityGraph';
import { answerHvac } from '../domains/hvac/answer';

const STAGES: readonly AskStage[] = ['reading', 'linking', 'writing'];

/**
 * Deterministic provider: reads the entity graph, understands a fixed set of
 * question shapes, and cites the documents behind every fact. It reports the
 * same three progress stages the server does, spaced across a short delay,
 * so the UI behaves identically whichever provider is active.
 */
export function createMockProvider(snapshot: () => GraphSnapshot, delayMs = 220): AnswerProvider {
  return {
    async ask(question, opts) {
      const step = Math.round(delayMs / STAGES.length);
      const answer = answerHvac(question, snapshot(), opts);
      for (const stage of STAGES) {
        opts?.onStatus?.(stage);
        if (step > 0) await new Promise((r) => setTimeout(r, step));
      }
      return answer;
    },
  };
}

/** Synchronous variant for tests and the eval script. */
export function answerSync(question: string, snapshot: GraphSnapshot, opts?: Parameters<typeof answerHvac>[2]) {
  return answerHvac(question, snapshot, opts);
}
