import type { Answer, AnswerProvider, Fact } from '../core/types';
import { authHeader } from './authToken';
import type { GraphSnapshot } from '../core/entityGraph';

/**
 * Claude-backed provider. Sends only the question to /api/ask (a Vercel
 * function that holds the API key). The server retrieves the tenant's own
 * document pages and already-extracted fields and returns an answer that is
 * already shaped and citation-checked against that retrieval — see
 * api/_lib/answer.js for where the actual trust boundary lives.
 *
 * This used to also export the local entity graph as a `records` field and
 * send it along, so the server could answer from it whenever retrieval came
 * up empty. That graph is `src/domains/hvac/seed.ts` — a hardcoded demo
 * fixture, unconditionally bootstrapped on every load (src/main.tsx) — so
 * "send the graph as evidence" meant sending demo data as though it were the
 * customer's, and once it was on the wire the server had no way to tell the
 * difference. The fix is on both ends: the server no longer has any code
 * path that accepts client-supplied evidence, and this client no longer
 * offers any, so there is nothing left here that could be mistaken for it
 * even if the server's guard were ever loosened by mistake.
 *
 * `normalizeAnswer` below used to do the same thing in miniature: it
 * re-filtered the server's sources against this local demo graph's document
 * ids before trusting them. Server document ids come from Postgres; demo ids
 * are literal strings like "doc-wr-EQ003" (see seed.ts) — two disjoint id
 * spaces. So that filter either did nothing, or (for every real, correctly-
 * sourced server answer) silently zeroed the whole thing out, because a real
 * documentId is never a key in the demo graph. It was never actually
 * validating anything; it just meant a working retrieval-backed answer could
 * come back from the server and get thrown away here. The server is the only
 * place that knows what retrieval really returned, so it's the only place a
 * citation can be checked — this file's job is to render what it's given,
 * defensively against malformed JSON, not to re-referee it against the
 * wrong evidence set.
 */
export function createClaudeProvider(snapshot: () => GraphSnapshot, endpoint = '/api/ask'): AnswerProvider {
  return {
    async ask(question, opts) {
      const g = snapshot();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ question, today: (opts?.now ?? new Date()).toISOString().slice(0, 10) }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Answer service ${res.status}: ${detail || res.statusText}`);
      }
      const body = (await res.json()) as { success: boolean; data?: Partial<Answer>; error?: string };
      if (!body.success || !body.data) throw new Error(body.error ?? 'Answer service returned no data');
      return normalizeAnswer(body.data, g);
    },
  };
}

function normalizeAnswer(a: Partial<Answer>, g: GraphSnapshot): Answer {
  // Defends against a malformed/short response shape — NOT a trust boundary.
  // The trust boundary (does a citation match what retrieval returned) is
  // enforced server-side in shapeAnswer(); see the file comment above for
  // why this used to re-check against the demo graph and why that was wrong.
  const facts: Fact[] = (Array.isArray(a.facts) ? a.facts : []).filter(
    (f) => !!f && Array.isArray(f.sources) && f.sources.length > 0
  );
  const sources = facts.flatMap((f) => f.sources);
  const docIds = new Set(sources.map((s) => s.documentId));
  const out: Answer = {
    kind: facts.length ? 'answer' : 'no-answer',
    text: a.text ?? 'Nothing in your records answers that.',
    facts,
    sources,
    confidence: a.confidence ?? (facts.length ? 0.8 : 0),
    verifiedCount: docIds.size,
    unverifiedCount: a.unverifiedCount ?? 0,
    closest: Array.isArray(a.closest) ? a.closest : [],
  };
  if (a.entityId && g.entities[a.entityId]) out.entityId = a.entityId;
  if (a.interpretation) out.interpretation = a.interpretation;
  return out;
}
