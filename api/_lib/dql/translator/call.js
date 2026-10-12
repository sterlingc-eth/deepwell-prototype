/**
 * dql/translator/call.js - the model-calling half. ONE small Haiku call per question, only when DONOVAN_PLAN_TRANSLATOR=1.
 *   - the call, the SDK, the retry and timeout, the usage meter, the per-organization daily dollar ledger and the daily call budget are the same ones
 *     records/pickCall.js and the agent loop use (claude.js, usage.js, rateLimit.js assertModelBudget, planner/spend.js route "planTranslator" default $0.5/day); fails closed;
 *   - the model sees the question (fenced as data) and the company's facts; its reply is a tool result that validate.js checks; anything else
 *     (error, timeout, budget, garbage, "none") is simply "no plan" and the question goes the way it always went;
 *   - the validated plan (or "none") is cached per organization by the normalized question, in memory, so a repeated question costs nothing.
 * The SDK, usage and spend modules load only when a call is actually made, so a switch-off request never pays for them.
 */
import { buildSystem, userMessage } from './prompt.js';
import { PLAN_TOOL } from './schema.js';

export const translatorEnabled = (env = process.env) => env?.DONOVAN_PLAN_TRANSLATOR === '1';
export const TRANSLATOR_MODEL = (env = process.env) => env?.DONOVAN_TRANSLATOR_MODEL || 'claude-haiku-4-5';
const CACHE_MAX = 500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map(); // `${org}|${question}` -> {at, value}
export const clearTranslatorCache = () => cache.clear();
const norm = (q) => String(q ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
const cacheGet = (k, now) => { const e = cache.get(k); if (!e) return undefined; if (now - e.at > CACHE_TTL_MS) { cache.delete(k); return undefined; } cache.delete(k); cache.set(k, e); return e.value; };
const cacheSet = (k, value, now) => { cache.set(k, { at: now, value }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };

/** the model's raw plan (tool input) for this question, or null. Never throws. `tv`/`pack` build the company facts. */
let TEST_CALL = null;
/** tests only: a recorded model reply (no SDK, no meter) used by every requestPlan call until cleared with null */
export const setTranslatorCallForTests = (fn) => { TEST_CALL = fn; };

export async function requestPlan({ withTenant, ctxArg, question, tv, pack, env = process.env, now = Date.now(), callModel } = {}) {
  try {
    if (!translatorEnabled(env)) return null;
    const q = String(question ?? '').trim();
    if (!q || q.length > 300) return null;
    const org = ctxArg?.tenantKey ?? ctxArg?.tenantId ?? null;
    if (!org) return null; // no organization to meter or cache against: fail closed
    const key = `${org}|${norm(q)}`;
    const hit = cacheGet(key, now);
    if (hit !== undefined) return hit.none ? null : hit;
    const system = buildSystem(tv, pack);
    let response;
    const model = TRANSLATOR_MODEL(env);
    let spend = null; let usage = null;
    callModel ??= TEST_CALL;
    if (callModel) {
      response = await callModel({ model, system, tools: [PLAN_TOOL], messages: [{ role: 'user', content: userMessage(q) }] }); // tests: a recorded response, no SDK, no meter
    } else {
      spend = await import('../../planner/spend.js');
      await (await import('../../rateLimit.js')).assertModelBudget(ctxArg); // the same daily call budget every model-billed path respects (ask.js starts its own check in parallel; the decompose stage runs before it is awaited)
      await spend.assertDailySpend(withTenant, ctxArg, 'planTranslator', env); // throws when over the daily cap, when escalation is off, or when the counter is unreadable
      const [{ default: Anthropic }, claude, usageMod, cachePlan] = await Promise.all([import('@anthropic-ai/sdk'), import('../../claude.js'), import('../../usage.js'), import('../../promptCache.js')]);
      usage = usageMod;
      const client = new Anthropic({ apiKey: claude.getApiKey(), timeout: 9000, maxRetries: 0 });
      const deadlineAt = Date.now() + 9000;
      const planned = cachePlan.planCacheBreakpoints({ tools: [{ block: PLAN_TOOL, breakpoint: true }], system: [{ block: { type: 'text', text: system }, breakpoint: true }] }, model);
      response = await claude.withBackoff(
        () => client.messages.create({ model, max_tokens: 400, system: planned.system, tools: planned.tools, tool_choice: { type: 'tool', name: PLAN_TOOL.name }, messages: [{ role: 'user', content: userMessage(q) }] }, { timeout: Math.max(1000, deadlineAt - Date.now()) }),
        { deadlineAt },
      );
      const u = response?.usage ?? {};
      const meter = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, model };
      await usage.recordModelCall(ctxArg, meter).catch(() => {});
      const cost = spend.routeCostReport({ route: 'plan-translator', model, usage: meter });
      console.log(JSON.stringify(cost));
      if (cost.cost_usd > 0) await spend.recordDailySpend(withTenant, ctxArg, 'planTranslator', cost.cost_usd).catch(() => {});
    }
    const raw = (response?.content ?? []).find((b) => b?.type === 'tool_use' && b?.name === PLAN_TOOL.name)?.input ?? null;
    cacheSet(key, raw && typeof raw === 'object' ? raw : { none: true }, now);
    return raw && typeof raw === 'object' ? raw : null;
  } catch (err) {
    console.error('Plan translator failed, using the normal path:', err?.name === 'ModelBudgetExceededError' ? 'budget' : err?.message);
    return null;
  }
}
