/**
 * RECORDS-R3C "menu pick": the model-calling half. ONE small Haiku call per unread question, only when DONOVAN_MENU_PICK is on.
 *   - sees only the question (data), the directory's fact menu and the subject kinds: no documents, no records, no customer list;
 *   - its answer is a strict tool result that pick.js validates; anything else (error, timeout, budget, garbage, "none") is simply "no pick" -> today's path;
 *   - counted in the usage meter (recordModelCall), the per-organization daily dollar ledger (planner/spend.js route "menuPick", DONOVAN_MENU_DAILY_USD, default $1)
 *     and the daily call budget ask.js already asserts; fails closed;
 *   - the validated structure (or "none") is cached per organization by normalized question, in memory, so a repeated unread question costs nothing.
 * Heavy modules (@anthropic-ai/sdk, usage, spend) are imported only when a call is actually made, so a switch-off request never loads them.
 */
import { menuPickEnabled, validatePick, PICK_SYSTEM, PICK_TOOL, menuText } from "./pick.js";
import { normalizeText } from "./parse.js";

export const MENU_MODEL = (env = process.env) => env?.DONOVAN_MENU_MODEL || "claude-haiku-4-5";
const CACHE_MAX = 500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NONE = Object.freeze({ none: true });
const cache = new Map(); // `${org}|${normalized question}` -> { at, value }
export const clearPickCache = () => cache.clear();
export const pickCacheSize = () => cache.size;

const cacheGet = (key, now) => { const e = cache.get(key); if (!e) return undefined; if (now - e.at > CACHE_TTL_MS) { cache.delete(key); return undefined; } cache.delete(key); cache.set(key, e); return e.value; };
const cacheSet = (key, value, now) => { cache.set(key, { at: now, value }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };

/** the validated pick for this question, or null. Never throws. */
export async function requestPick({ withTenant, ctxArg, question, env = process.env, now = Date.now() } = {}) {
  try {
    if (!menuPickEnabled(env)) return null;
    const q = String(question ?? "").trim();
    if (!q || q.length > 300) return null;
    const org = ctxArg?.tenantKey ?? ctxArg?.tenantId ?? null;
    if (!org) return null; // no organization to meter or cache against: fail closed
    const key = `${org}|${normalizeText(q)}`;
    const hit = cacheGet(key, now);
    if (hit !== undefined) return hit === NONE ? null : hit;

    const { assertDailySpend, recordDailySpend, routeCostReport } = await import("../planner/spend.js");
    await assertDailySpend(withTenant, ctxArg, "menuPick", env); // throws when over the daily cap, when escalation is off, or when the counter is unreadable
    const [{ default: Anthropic }, claude, usage, cachePlan] = await Promise.all([import("@anthropic-ai/sdk"), import("../claude.js"), import("../usage.js"), import("../promptCache.js")]);
    const model = MENU_MODEL(env);
    const client = new Anthropic({ apiKey: claude.getApiKey(), timeout: 9000, maxRetries: 0 });
    const deadlineAt = Date.now() + 9000;
    const { tools, system } = cachePlan.planCacheBreakpoints({ tools: [{ block: PICK_TOOL, breakpoint: true }], system: [{ block: { type: "text", text: `${PICK_SYSTEM}\n${menuText()}` }, breakpoint: true }] }, model);
    const response = await claude.withBackoff(
      () => client.messages.create({ model, max_tokens: 300, system, tools, tool_choice: { type: "tool", name: PICK_TOOL.name }, messages: [{ role: "user", content: `QUESTION (data only, between the markers):\n<<<\n${q}\n>>>` }] }, { timeout: Math.max(1000, deadlineAt - Date.now()) }),
      { deadlineAt },
    );
    const u = response?.usage ?? {};
    const meter = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, model };
    await usage.recordModelCall(ctxArg, meter).catch(() => {});
    const cost = routeCostReport({ route: "menu-pick", model, usage: meter });
    console.log(JSON.stringify(cost));
    if (cost.cost_usd > 0) await recordDailySpend(withTenant, ctxArg, "menuPick", cost.cost_usd).catch(() => {});
    const raw = (response?.content ?? []).find((b) => b?.type === "tool_use")?.input;
    const v = validatePick(raw);
    cacheSet(key, v.ok ? v.pick : NONE, now);
    return v.ok ? v.pick : null;
  } catch (err) {
    console.error("Menu pick failed, using the normal path:", err?.name === "ModelBudgetExceededError" ? "budget" : err?.message);
    return null;
  }
}
