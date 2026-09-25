import type { Answer, AnswerProvider, Fact } from '../core/types';
import { authHeader } from './authToken';
import { messageFromResponse } from './httpError';
import type { GraphSnapshot } from '../core/entityGraph';
import { normalizeCitations } from '../core/citations';

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
/**
 * Thrown by the Claude-backed provider on a non-2xx response. `.status` and
 * `.url` let AskScreen tell a subscription-required 402 (billing's exact
 * shape: `{ error, url: "/app/?screen=billing" }`, per handoffs/BILLING_RULES.md)
 * apart from an ordinary failure, so it can offer "See plans" instead of just
 * an error line.
 */
export class AskApiError extends Error {
  status: number;
  url?: string;
  constructor(message: string, status: number, url?: string) {
    super(message);
    this.name = 'AskApiError';
    this.status = status;
    this.url = url;
  }
}

/**
 * Reads a `/api/ask` response that opted into streaming (see below): newline-delimited JSON, zero or
 * more `{"type":"step","message":"..."}` progress lines (forwarded to `onStep`, best-effort — a
 * malformed or missing step line is simply skipped, never fatal) and exactly one
 * `{"type":"final",success,data|error,url?}` line, which resolves/rejects exactly as the non-streaming
 * branch below would have from the whole-body JSON. A response whose Content-Type turns out NOT to be
 * NDJSON (a deterministic fast-layer answer never streams at all — see api/ask.js) is read as a single
 * JSON object instead, so this path is a strict superset of the non-streaming one, never a second
 * contract to keep in sync.
 */
async function readNdjsonAnswer(res: Response, onStep?: (step: { message: string }) => void): Promise<{ success: boolean; data?: Partial<Answer>; error?: string; url?: string }> {
  const reader = res.body?.getReader();
  if (!reader) return res.json();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: { success: boolean; data?: Partial<Answer>; error?: string; url?: string } | null = null;
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return; // a partial/garbled line is skipped, never fatal
    }
    const e = evt as { type?: string; message?: string; success?: boolean; data?: Partial<Answer>; error?: string; url?: string };
    if (e.type === 'step') {
      if (typeof e.message === 'string' && onStep) onStep({ message: e.message });
    } else if (e.type === 'final') {
      final = { success: e.success !== false, data: e.data, error: e.error, url: e.url };
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer) handleLine(buffer);
  return final ?? { success: false, error: 'The connection ended before an answer arrived.' };
}

export function createClaudeProvider(snapshot: () => GraphSnapshot, endpoint = '/api/ask'): AnswerProvider {
  return {
    async ask(question, opts) {
      const g = snapshot();
      // Streaming is opt-in from the caller's side too: only asked for when something wants to show
      // progress (AskScreen passes onStep). A caller with no onStep gets the exact same request/response
      // shape as before this feature existed.
      const wantStream = typeof opts?.onStep === 'function';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({
          question,
          today: (opts?.now ?? new Date()).toISOString().slice(0, 10),
          ...(wantStream ? { stream: true } : {}),
          // TEAM T2: only sent when the thread actually has a prior turn — see
          // api/_lib/conversation.js. Omitted entirely for a first/"New question" ask.
          // Sent on a streaming request exactly the same as a non-streaming one.
          ...(opts?.conversationContext?.turns.length ? { conversationContext: opts.conversationContext } : {}),
        }),
        signal: opts?.signal,
      });
      if (!res.ok) {
        // A 500 from Vercel is an HTML page, not JSON. Reading it as text and
        // showing it raw put a literal <!DOCTYPE html> in front of the user on
        // the Ask screen. Same guard the ingest and records clients already use.
        const raw = await res.text().catch(() => '');
        let message = `${res.status} ${res.statusText}`;
        let parsedBody: unknown = null;
        try {
          parsedBody = JSON.parse(raw);
          const parsed = parsedBody as { error?: string };
          if (parsed?.error) message = parsed.error;
        } catch {
          /* not JSON — keep the status line rather than dumping the page */
        }
        if (res.status === 429) message = messageFromResponse(res, parsedBody, message);
        const billingUrl = (parsedBody as { url?: string } | null)?.url;
        throw new AskApiError(message, res.status, billingUrl);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const body = contentType.includes('ndjson')
        ? await readNdjsonAnswer(res, opts?.onStep)
        : ((await res.json()) as { success: boolean; data?: Partial<Answer>; error?: string });
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
  // A server-vouched `kind: 'answer'` (analytics / meta / agent aggregates and lists, see
  // api/_lib/analytics.js and api/_lib/agent/shape.js) legitimately carries facts with no
  // document sources — shapeAnswer() never returns kind 'answer' without sourced facts, so
  // the sourceless case only ever comes from those deterministic paths. Anything else is
  // held to the original "every fact cites a source" rule.
  const serverAnswer = a.kind === 'answer';
  const facts: Fact[] = (Array.isArray(a.facts) ? a.facts : []).filter(
    (f) => !!f && Array.isArray(f.sources) && (f.sources.length > 0 || serverAnswer)
  );
  const sources = facts.flatMap((f) => f.sources);
  const docIds = new Set(sources.map((s) => s.documentId));
  // Belt-and-braces alongside shapeAnswer's own fix (api/_lib/answer.js): once
  // facts.length is 0 nothing here was actually grounded, so `a.text` — the
  // model's free prose, never citation-checked — must not reach the screen
  // even if a future server regression forwards it. This is exactly the
  // 2026-09-19 bug (a confident narrative with `sources: []`), guarded here
  // too so the client alone still fails safe.
  const out: Answer = {
    kind: facts.length || (serverAnswer && !!a.text) ? 'answer' : 'no-answer',
    text: facts.length || (serverAnswer && a.text) ? (a.text ?? '') : 'Nothing in your records answers that.',
    facts,
    sources,
    confidence: a.confidence ?? (facts.length ? 0.8 : 0),
    verifiedCount: docIds.size,
    unverifiedCount: a.unverifiedCount ?? 0,
    closest: Array.isArray(a.closest) ? a.closest : [],
  };
  if (a.entityId && g.entities[a.entityId]) out.entityId = a.entityId;
  if (a.interpretation) out.interpretation = a.interpretation;
  // Citation contract: the rows behind the answer + one sentence on how it was computed.
  const cite = normalizeCitations(a);
  if (cite.records) out.records = cite.records;
  if (cite.recordsTotal != null) out.recordsTotal = cite.recordsTotal;
  if (cite.recordsKind) out.recordsKind = cite.recordsKind;
  if (cite.basis) out.basis = cite.basis;
  return out;
}
