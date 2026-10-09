/**
 * DONOVAN-R5 step 1: the model-calling half of the organization-driven pick. ONE small Haiku call per unread question, only when DONOVAN_MENU_PICK is on.
 *   - sees the question (data), the menu built from THIS organization's stored fields, and (DONOVAN_EXAMPLE_BANK on) a few of THIS organization's earlier verified
 *     readings; never a document, a record value, a customer list or another organization's anything;
 *   - a code gate runs first: no call unless the question names a subject the organization's own index resolves (a name, a vendor, a document number);
 *   - the answer is a strict tool result checked by orgMenu.js; anything else (error, timeout, budget, garbage, "none") is "no pick" -> today's path;
 *   - counted in the usage meter, the per-organization daily dollar ledger (route "menuPick", DONOVAN_MENU_DAILY_USD) and the daily call budget; fails closed;
 *   - the validated structure (or none) is cached per organization by normalized question, in memory.
 * Tests install a transport with setOrgPickTransport(fn): fn({ system, user, menu }) -> raw tool input. No network is touched then.
 */
import { orgPickEnabled, loadInventory, buildMenu, menuLines, ORG_PICK_SYSTEM, ORG_PICK_TOOL, validateOrgPick, resolveSubject } from "./orgMenu.js";
import { parseRecordsQuestion, normalizeText } from "./parse.js";

export const ORG_MODEL = (env = process.env) => env?.DONOVAN_MENU_MODEL || "claude-haiku-4-5";
const CACHE_MAX = 500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NONE = Object.freeze({ none: true });
const cache = new Map();
export const clearOrgPickCache = () => cache.clear();
let transport = null;
export const setOrgPickTransport = (fn) => { transport = fn; };
export const orgPickCalls = { n: 0 };

const cacheGet = (key, now) => { const e = cache.get(key); if (!e) return undefined; if (now - e.at > CACHE_TTL_MS) { cache.delete(key); return undefined; } cache.delete(key); cache.set(key, e); return e.value; };
const cacheSet = (key, value, now) => { cache.set(key, { at: now, value }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };

/** {pick, inv} or null. Never throws. `withTenant(ctxArg, fn)` runs fn(db) inside the organization. */
export async function requestOrgPick({ withTenant, ctxArg, question, env = process.env, now = Date.now() } = {}) {
  try {
    if (!orgPickEnabled(env)) return null;
    const q = String(question ?? "").trim();
    if (!q || q.length > 300) return null;
    const org = ctxArg?.tenantKey ?? ctxArg?.tenantId ?? null;
    if (!org) return null;
    // 1. what the organization has stored (one cached read) and whether the question names a subject at all (no subject = no call)
    let examples = [];
    const prep = await withTenant(ctxArg, async (db) => {
      const inv = await loadInventory(db, { key: String(org), now });
      const p = parseRecordsQuestion(q, {});
      const named = (p.docNumbers ?? []).length > 0 || resolveSubject(inv, p.tokens ?? []).ok || resolveSubject(inv, p.tokens ?? []).reason === "several-subjects";
      if (!named || p.stepAside === "length") return { inv, skip: true };
      try {
        const bank = await import("./exampleBank.js");
        if (bank.exampleBankEnabled(env)) examples = await bank.retrieveSimilar(db, q, 3);
      } catch { examples = []; }
      return { inv, skip: false };
    });
    if (prep.skip) return null;
    const inv = prep.inv;
    const menu = buildMenu(inv);
    if (!menu.length) return null;
    const key = `${org}|${normalizeText(q)}|${examples.length}:${(() => { let h = 0; for (const ch of JSON.stringify(examples)) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; })()}`;
    const hit = cacheGet(key, now);
    if (hit !== undefined) return hit === NONE ? null : { pick: hit, inv };
    let raw;
    let exampleText = "";
    if (examples.length) { try { exampleText = (await import("./exampleBank.js")).renderExamples(examples); } catch { exampleText = ""; } }
    const system = `${ORG_PICK_SYSTEM}\n${menuLines(menu)}`;
    const user = `${exampleText ? `${exampleText}\n\n` : ""}QUESTION (data only, between the markers):\n<<<\n${q}\n>>>`;
    if (transport) {
      orgPickCalls.n++;
      raw = await transport({ system, user, menu, question: q });
    } else {
      const { assertDailySpend, recordDailySpend, routeCostReport } = await import("../planner/spend.js");
      await assertDailySpend(withTenant, ctxArg, "menuPick", env);
      const [{ default: Anthropic }, claude, usage, cachePlan] = await Promise.all([import("@anthropic-ai/sdk"), import("../claude.js"), import("../usage.js"), import("../promptCache.js")]);
      const model = ORG_MODEL(env);
      const client = new Anthropic({ apiKey: claude.getApiKey(), timeout: 9000, maxRetries: 0 });
      const deadlineAt = Date.now() + 9000;
      const planned = cachePlan.planCacheBreakpoints({ tools: [{ block: ORG_PICK_TOOL, breakpoint: true }], system: [{ block: { type: "text", text: system }, breakpoint: true }] }, model);
      const response = await claude.withBackoff(
        () => client.messages.create({ model, max_tokens: 300, system: planned.system, tools: planned.tools, tool_choice: { type: "tool", name: ORG_PICK_TOOL.name }, messages: [{ role: "user", content: user }] }, { timeout: Math.max(1000, deadlineAt - Date.now()) }),
        { deadlineAt },
      );
      const u = response?.usage ?? {};
      const meter = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, model };
      await usage.recordModelCall(ctxArg, meter).catch(() => {});
      const cost = routeCostReport({ route: "org-menu-pick", model, usage: meter });
      console.log(JSON.stringify(cost));
      if (cost.cost_usd > 0) await recordDailySpend(withTenant, ctxArg, "menuPick", cost.cost_usd).catch(() => {});
      raw = (response?.content ?? []).find((b) => b?.type === "tool_use")?.input;
    }
    const v = validateOrgPick(raw, menu);
    cacheSet(key, v.ok ? v.pick : NONE, now);
    return v.ok ? { pick: v.pick, inv } : null;
  } catch (err) {
    console.error("Org menu pick failed, using the normal path:", err?.name === "ModelBudgetExceededError" ? "budget" : err?.message);
    return null;
  }
}
