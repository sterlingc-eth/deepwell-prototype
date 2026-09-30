/**
 * Round 28 — Support Assistant route. Dispatched from api/account.js as ?action=support
 * (vercel.json rewrites /api/support -> /api/account?action=support).
 *
 *   GET  /api/support?starter=1&surface=public|app|mobile   -> {greeting, suggestions}   static, $0, no auth
 *   POST /api/support {message, history?, surface, page?, turn?} -> {reply, sources, mode, redirectTo?, handoff?, suggestions?}
 *   POST /api/support {action:'handoff', email, name?, message, transcript?, surface} -> {ok:true}
 *
 * Auth: surface "public" needs none (the website widget). Surface "app"/"mobile" needs a Clerk session via
 * requireAuth (401 otherwise). The tenant is only ever what the session says — nothing in the body is trusted.
 * Nothing about the conversation is stored; logs carry hashes and counts only.
 */
import { requireAuth, denyAuth } from '../auth.js';
import { handleCors } from '../claude.js';
import { sendEmail } from '../email.js';
import { estimateModelCostUsd } from '../usage.js';
import { modelCallLogLine } from '../promptCache.js';
import { hashForLog } from '../privacy/redact.js';
import { LIMITS, SURFACES } from './policy.js';
import { respond, starter } from './engine.js';
import { createLimiter } from './limits.js';
import { callSupportModel, supportModelEnabled, supportModelId } from './client.js';
import { validateHandoff, deliverHandoff } from './handoff.js';
import * as tools from './tools.js';

export const config = { api: { bodyParser: { sizeLimit: '24kb' } } };

let limiter = null;
const getLimiter = () => (limiter ??= createLimiter());

const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

function parseBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') { try { const j = JSON.parse(b); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
  return {};
}

/** Auth only for the in-app surfaces. Returns {auth} (null for public) or {denied:true} after answering. */
async function authFor(surface, req, res) {
  if (surface === 'public') return { auth: null };
  try {
    return { auth: await requireAuth(req) };
  } catch (err) {
    denyAuth(res, err);
    return { denied: true };
  }
}

function rateLimited(res, r) {
  res.setHeader('Retry-After', String(r.retryAfterSec ?? 60));
  return bad(res, 429, 'You are sending messages quickly. Please wait a moment and try again.', { retryAfterSec: r.retryAfterSec ?? 60 });
}

export default async function handler(req, res) {
  handleCors(res, req);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const surfaceOf = (v) => (SURFACES.includes(v) ? v : 'public');

  if (req.method === 'GET') {
    if (!req.query?.starter) return bad(res, 400, 'Unsupported request');
    const st = starter(surfaceOf(String(req.query.surface ?? 'public')));
    return res.status(200).json({ greeting: st.greeting, suggestions: st.suggestions });
  }
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

  const body = parseBody(req);
  if (body.surface !== undefined && !SURFACES.includes(body.surface)) return bad(res, 400, 'Invalid surface');
  const surface = surfaceOf(body.surface);

  const gate = await authFor(surface, req, res);
  if (gate.denied) return undefined;
  const auth = gate.auth;
  const lim = getLimiter();

  /* ------------------------------------------------------------ hand-off */
  if (body.action === 'handoff') {
    const v = validateHandoff({ ...body, surface });
    if (!v.ok) return bad(res, 400, v.error);
    if (v.value.honeypot) return res.status(200).json({ ok: true }); // bots get a happy face and nothing is sent
    const rl = await lim.checkHandoff({ surface, req, auth });
    if (!rl.ok) return rateLimited(res, rl);
    let account = null;
    if (auth) {
      try {
        const p = await tools.getPlanAndUsage(auth);
        account = { plan: p?.plan ?? null, state: p?.state ?? null, role: auth.orgRole ?? null, tenantHash: hashForLog(auth.tenantId) };
      } catch { account = { tenantHash: hashForLog(auth.tenantId) }; }
    }
    try {
      const out = await deliverHandoff(v, { account, send: sendEmail });
      console.log(out.log);
      if (!out.ok) return bad(res, 502, 'We could not send that just now. Please email support@deepwelltechnology.com directly.');
      return res.status(200).json({ ok: true });
    } catch {
      return bad(res, 502, 'We could not send that just now. Please email support@deepwelltechnology.com directly.');
    }
  }

  /* ------------------------------------------------------------ chat */
  if (typeof body.message !== 'string' || !body.message.trim()) return bad(res, 400, 'Please type a question.');
  if (body.message.length > LIMITS.maxChars) return bad(res, 400, `Please keep your question under ${LIMITS.maxChars} characters.`);
  if (body.history !== undefined && !Array.isArray(body.history)) return bad(res, 400, 'Invalid history');

  const rl = await lim.checkRate({ surface, req, auth });
  if (!rl.ok) return rateLimited(res, rl);

  const modelId = supportModelId();
  const deps = {
    tools,
    model: {
      enabled: () => supportModelEnabled(),
      id: modelId,
      call: (request) => callSupportModel(request),
      priceUsd: (usage) => estimateModelCostUsd(modelId, usage),
    },
    budget: { gate: (p) => lim.modelGate(p), record: (p) => lim.recordSpend(p) },
  };

  const started = Date.now();
  let out;
  try {
    out = await respond({ message: body.message, history: body.history, surface, page: typeof body.page === 'string' ? body.page : undefined, turn: body.turn, auth }, deps);
  } catch {
    console.error('support respond failed');
    return res.status(200).json({ reply: "I'm not sure about that one — want me to pass it to the team?", sources: [], mode: 'fallback', handoff: { offered: true, reason: 'error' } });
  }
  const { body: payload, meta } = out;
  console.log(JSON.stringify({ route: 'support', surface, mode: payload.mode, path: meta.path, reason: meta.reason ?? null, faq: meta.faqId ?? null, msg_len: body.message.length, msg_h: hashForLog(body.message), usd: Number((meta.usd ?? 0).toFixed(6)), ms: Date.now() - started }));
  if (meta.modelCalled && meta.usage) {
    console.log(modelCallLogLine({ route: 'support', model: modelId, ...meta.usage, latencyMs: meta.latencyMs ?? 0 }));
  }
  return res.status(200).json(payload);
}
