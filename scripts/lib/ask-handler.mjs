/**
 * In-process /api/ask for a mixed-harness company (no network, model blocked and COUNTED). Used by the verify-industry-* scripts to prove what the real
 * handler answers (lane, decline text, conversation turns) rather than only the lane in isolation.
 *   const ask = await makeAsk(H, 'electrical');  const r = await ask('Which permits are open?', conversationContext?)  // r.text, r.modelCalls
 */
import { SCORECARD_CALL } from '../../api/_lib/scorecard/hook.js';

let counter = null;
async function blockModel() {
  if (counter) return counter;
  process.env.CLAUDE_API_KEY ||= 'sk-ant-offline-disabled';
  process.env.DEEPWELL_TELEMETRY_OFF = '1';
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'x' }).messages);
  counter = { n: 0 };
  proto.create = async function blocked() { counter.n += 1; const e = new Error('model disabled in verify'); e.status = 400; e.isMock = true; throw e; };
  return counter;
}

export async function makeAsk(H, industry, { today = '2026-09-25' } = {}) {
  const c = await blockModel();
  const handler = (await import('../../api/ask.js')).default;
  const ctx = H.companies[industry].ctx;
  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName, userId: null };
  return async (question, conversationContext) => {
    c.n = 0;
    const res = { statusCode: 200, headers: {}, body: undefined, setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; }, getHeader(k) { return res.headers[String(k).toLowerCase()]; }, status(s) { res.statusCode = s; return res; }, json(b) { res.body = b; return res; }, end() { return res; } };
    const req = { method: 'POST', headers: {}, query: {}, body: { question, today, ...(conversationContext ? { conversationContext } : {}) }, [SCORECARD_CALL]: { auth, escalate: false } };
    const log = console.log; const err = console.error; const warn = console.warn; const errs = []; console.log = () => {}; console.error = (...a) => errs.push(a.join(' ')); console.warn = () => {};
    try { await handler(req, res); } finally { console.log = log; console.error = err; console.warn = warn; }
    const d = res.body?.data ?? null;
    return { data: d, text: String(d?.text ?? d?.answer ?? res.body?.error ?? ''), modelCalls: c.n, errors: errs, status: res.statusCode };
  };
}
