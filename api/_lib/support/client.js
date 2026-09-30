/**
 * Round 28 — Support Assistant, the model client. The ONLY file in api/_lib/support that touches the
 * Anthropic SDK, and it is imported lazily (only when the model path is actually taken), so the SDK never
 * loads for a FAQ answer and never enters api/account.js's cold start (see scripts/verify-cold-start.mjs).
 *
 * KEY ISOLATION (owner decision, Round 28): the support assistant uses ITS OWN key, SUPPORT_ANTHROPIC_API_KEY.
 * It never falls back to CLAUDE_API_KEY / ANTHROPIC_API_KEY (Donovan's key), and a failure here never calls
 * recordProviderOutage — a runaway public widget or an empty support workspace must not be able to mark
 * Donovan as down or spend Donovan's credits.
 *
 * Env:
 *   SUPPORT_ANTHROPIC_API_KEY   unset  -> no model path at all ($0; FAQ + hand-off only)
 *   SUPPORT_ASSISTANT_MODEL     "off" (or 0/false/disabled) -> kill switch; a value starting "claude-" overrides the model id
 */
import { MODEL, LIMITS } from './policy.js';

let _testClient = null;
let _client = null;
let _clientKey = null;

/** Test hook (scripts/verify-support-assistant.mjs): a fake with messages.create(). Pass null to clear. */
export function _setClientForTest(fake) { _testClient = fake ?? null; }

export function getSupportApiKey(env = process.env) {
  const k = typeof env?.SUPPORT_ANTHROPIC_API_KEY === 'string' ? env.SUPPORT_ANTHROPIC_API_KEY.trim() : '';
  return k && !k.includes('YOUR_API_KEY') ? k : null;
}

export function modelKillSwitch(env = process.env) {
  return /^(?:off|0|false|disabled|no)$/i.test(String(env?.SUPPORT_ASSISTANT_MODEL ?? '').trim());
}

/** Model on only when a dedicated key exists AND the kill switch is not thrown. */
export function supportModelEnabled(env = process.env) {
  if (_testClient) return !modelKillSwitch(env);
  return Boolean(getSupportApiKey(env)) && !modelKillSwitch(env);
}

export function supportModelId(env = process.env) {
  const v = String(env?.SUPPORT_ASSISTANT_MODEL ?? '').trim();
  return /^claude-[a-z0-9.-]+$/i.test(v) ? v : MODEL.id;
}

async function getClient(env) {
  if (_testClient) return _testClient;
  const key = getSupportApiKey(env);
  if (!key) return null;
  if (_client && _clientKey === key) return _client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: LIMITS.modelTimeoutMs });
  _clientKey = key;
  return _client;
}

/**
 * One model call. Returns {ok:true, input, usage, stopReason, latencyMs} or {ok:false, error: <short label>}.
 * Never throws and never logs the request or response text.
 */
export async function callSupportModel(request, env = process.env) {
  const started = Date.now();
  try {
    const client = await getClient(env);
    if (!client) return { ok: false, error: 'no-key' };
    const resp = await client.messages.create(request, { timeout: LIMITS.modelTimeoutMs, maxRetries: 0 });
    const tool = (resp?.content ?? []).find((b) => b?.type === 'tool_use' && b?.name === 'reply');
    const u = resp?.usage ?? {};
    return {
      ok: true,
      input: tool?.input ?? null,
      stopReason: resp?.stop_reason ?? null,
      latencyMs: Date.now() - started,
      usage: {
        inputTokens: Number(u.input_tokens) || 0,
        outputTokens: Number(u.output_tokens) || 0,
        cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0,
        cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
      },
    };
  } catch (err) {
    const status = err?.status ?? null;
    const label = status ? `http-${status}` : err?.name === 'AbortError' || /timeout/i.test(err?.message ?? '') ? 'timeout' : 'error';
    console.error(`support model call failed (${label}); serving the FAQ fallback`);
    return { ok: false, error: label, latencyMs: Date.now() - started };
  }
}
