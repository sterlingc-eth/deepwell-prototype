/**
 * R31 (Team B): model-cost checks — no network, no real model, no real database (PGlite + a scripted callModel).
 *
 *   1. promptCache.js withRollingBreakpoint: pure rules (no mutation, minimum length, forced-final, cap, block types).
 *   2. Byte-stable cached prefix: the research agent's tools + system are identical across questions/dates/tenants of
 *      one industry, carry exactly the intended breakpoints, and the per-question text never gets one.
 *   3. The rolling breakpoint end to end: request 1 has none in `messages`; a later, non-final request has exactly one,
 *      on the last block; a forced-final request has none; the run's own history is never mutated; <= 4 in total.
 *   4. Cheap-model tier (DONOVAN_CHEAP_TIER, default OFF): off = Sonnet only; on + simple question = Haiku first, accepted
 *      only when it answered with nothing dropped; any failure re-runs on Sonnet with the two runs' cost summed;
 *      hard / enumeration questions never go to Haiku.
 *   5. Estimated $/1000 questions before/after (assumption-labelled: no live model is called here).
 *
 *   node scripts/verify-r31-cost.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
let passes = 0;
const check = (name, ok, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DONOVAN_AGENT_QUERY_TIMEOUT_MS = "3000";
process.env.DONOVAN_RESEARCH_DAILY_USD = "10";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_API_KEY;
delete process.env.VOYAGE_API_KEY;
delete process.env.DONOVAN_CHEAP_TIER;
delete process.env.DONOVAN_ROLLING_CACHE;

const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"route"')) return; realLog(...a); };
const realWarn = console.warn; console.warn = () => {};
const realErr = console.error; console.error = () => {};

const { withRollingBreakpoint, planCacheBreakpoints, estimateTokens, minTokensFor, MAX_CACHE_BREAKPOINTS } = await import("../api/_lib/promptCache.js");

/* ================================================================== 1. withRollingBreakpoint (pure) */
{
  const big = "x".repeat(4 * 5000); // ~4.3k estimated tokens
  const q = { role: "user", content: [{ type: "text", text: "QUESTION: how old is the unit" }] };
  const a = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_documents", input: { query: "unit" } }] };
  const r = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] };
  const msgs = [q, a, r];
  const snapshot = JSON.stringify(msgs);

  const out = withRollingBreakpoint(msgs, { model: "claude-sonnet-4-5", prefixTokens: 6800, breakpointsUsed: 2 });
  check("rolling: marks the LAST block of the LAST message", out[2].content[0].cache_control?.type === "ephemeral" && !out[0].content[0].cache_control && !out[1].content[0].cache_control);
  eq("rolling: never mutates the caller's messages", JSON.stringify(msgs), snapshot);
  check("rolling: returns new objects for the marked message only", out !== msgs && out[0] === msgs[0] && out[1] === msgs[1] && out[2] !== msgs[2]);
  check("rolling: the first request (question alone) is never marked", withRollingBreakpoint([q], { model: "claude-sonnet-4-5", prefixTokens: 9000 }) .every((m) => m.content.every((b) => !b.cache_control)));
  check("rolling: a forced-final request is never marked (nothing follows it)", withRollingBreakpoint(msgs, { model: "claude-sonnet-4-5", prefixTokens: 6800, final: true }) === msgs);
  check("rolling: respects the 4-breakpoint cap", withRollingBreakpoint(msgs, { model: "claude-sonnet-4-5", prefixTokens: 6800, breakpointsUsed: MAX_CACHE_BREAKPOINTS }) === msgs);
  check("rolling: below the model's caching minimum it is a no-op (Haiku needs 4096 tokens)", withRollingBreakpoint([q, a, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "short" }] }], { model: "claude-haiku-4-5", prefixTokens: 100 }).length === 3 && !JSON.stringify(withRollingBreakpoint([q, a, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "short" }] }], { model: "claude-haiku-4-5", prefixTokens: 100 })).includes("cache_control"));
  check("rolling: a last message that is not a user turn is left alone", withRollingBreakpoint([q, r, a], { model: "claude-sonnet-4-5", prefixTokens: 6800 })[2] === a);
  check("rolling: an existing breakpoint on an older block is not duplicated by copying", (() => {
    const m2 = [q, a, r, { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "compute", input: { expression: "1+1" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "2" }] }];
    const o = withRollingBreakpoint(m2, { model: "claude-sonnet-4-5", prefixTokens: 6800 });
    return (JSON.stringify(o).match(/cache_control/g) ?? []).length === 1;
  })());
}

/* ================================================================== 2/3/4: research agent on a real (PGlite) tenant */
let offline;
try { offline = await import("./offline-exam.mjs"); } catch (err) { realLog(`SKIP  offline-exam.mjs failed to load (${err?.message}). Run npm ci.`); process.exit(0); }
const { installPgHarness, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = offline;
await installPgHarness();
const lite = await createPGlite();
await setActiveDatabase(lite);
const exp = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "golden", "golden-export.json"), "utf8"));
const { ctx } = await loadExportIntoNewTenant(lite, exp, { tenantKey: "r31-cost", tenantName: "R31 Cost" });
const { withTenant } = await import("../api/_lib/recordsStore.js");
const v2 = await import("../api/_lib/agent/loopV2.js");
const { estimateModelCostUsd } = await import("../api/_lib/usage.js");

// A real page with text, and a phrase that is literally on it (so a fact citing it survives the verify step).
const pageRow = (await lite.query(`SELECT p.document_id, p.page_no, p.text FROM document_pages p WHERE length(p.text) > 200 ORDER BY p.document_id, p.page_no LIMIT 1`)).rows[0];
const phrase = pageRow.text.replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" ");
const docId = pageRow.document_id;

let n = 0;
const tu = (name, input) => ({ type: "tool_use", id: `toolu_${++n}`, name, input });
const answerToolUse = (extra = {}) => tu("answer", { status: "answered", text: `The record starts with ${phrase}.`, facts: [{ label: "Record", value: phrase, sources: [{ documentId: docId, location: { page: pageRow.page_no } }] }], confidence: 0.9, ...extra });

/** A scripted model. `turns` is a list of functions (or arrays) — one per model call, per model. Requests are deep-cloned at call time. */
function scripted(turns, usage = { input_tokens: 3000, output_tokens: 200 }) {
  let i = 0;
  const requests = [];
  const fn = async (req) => {
    requests.push(JSON.parse(JSON.stringify(req)));
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    const out = typeof turn === "function" ? turn(req) : turn;
    const content = Array.isArray(out) ? out : out.content;
    return { content, usage: out.usage ?? usage, stop_reason: "tool_use" };
  };
  fn.requests = requests;
  return fn;
}
const TODAY = "2026-09-25";
const baseEnv = { DONOVAN_ESCALATION: "1", DONOVAN_RESEARCH_DAILY_USD: "10" };
const run = (question, callModel, env = {}, extra = {}) => v2.runResearchAgent({ withTenant, ctxArg: ctx, question, today: TODAY, callModel, env: { ...baseEnv, ...env }, ...extra });
const msgBreakpoints = (req) => req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control).length;
const prefixBreakpoints = (req) => [...(req.tools ?? []), ...(req.system ?? [])].filter((b) => b.cache_control).length;

// --- 2 + 3: three-turn run: tool, tool, answer (NOT forced) -----------------------------------------------------
let stableA;
{
  const model = scripted([
    () => [tu("read_document", { documentId: docId })],
    () => [tu("describe_data", {})],
    () => [answerToolUse()],
  ]);
  const r = await run("what is the first line on that record", model);
  check("run A: answered with a grounded fact", r.handled === true, JSON.stringify(r).slice(0, 300));
  eq("run A: three model calls", model.requests.length, 3);
  eq("request 1: no message-level breakpoint (the question text is variable)", msgBreakpoints(model.requests[0]), 0);
  check("request 1: tools + system carry the stable-prefix breakpoints", prefixBreakpoints(model.requests[0]) === 2, String(prefixBreakpoints(model.requests[0])));
  eq("request 2: exactly one message-level breakpoint (rolling)", msgBreakpoints(model.requests[1]), 1);
  const last2 = model.requests[1].messages.at(-1);
  check("request 2: it sits on the last block of the last message", last2.content.at(-1).cache_control?.type === "ephemeral");
  eq("request 3: still exactly one (older markers do not accumulate)", msgBreakpoints(model.requests[2]), 1);
  check("request 3: total breakpoints within Anthropic's cap of 4", msgBreakpoints(model.requests[2]) + prefixBreakpoints(model.requests[2]) <= MAX_CACHE_BREAKPOINTS);
  stableA = JSON.stringify({ tools: model.requests[0].tools, system: model.requests[0].system });
  check("prefix is identical on every request of the run (byte-stable)", model.requests.every((q) => JSON.stringify({ tools: q.tools, system: q.system }) === stableA));
  check("no request ever puts a breakpoint on the question block itself", model.requests.every((q) => !q.messages[0].content.some((b) => b.cache_control)));
}
{
  // second run: different question AND different date — the cached prefix must not move by a single byte.
  const model = scripted([() => [tu("read_document", { documentId: docId })], () => [answerToolUse()]]);
  await v2.runResearchAgent({ withTenant, ctxArg: ctx, question: "a completely different question about warranties", today: "2027-01-02", callModel: model, env: baseEnv });
  check("prefix is byte-identical across different questions and dates", JSON.stringify({ tools: model.requests[0].tools, system: model.requests[0].system }) === stableA);
  check("the per-question date/text lives only in the (uncached) message", !stableA.includes("2027-01-02") && !stableA.includes("warranties question"));
}
{
  // kill switch: DONOVAN_ROLLING_CACHE=0 puts no breakpoint in the messages at all.
  const model = scripted([() => [tu("read_document", { documentId: docId })], () => [answerToolUse()]]);
  await run("what is the first line on that record", model, { DONOVAN_ROLLING_CACHE: "0" });
  check("DONOVAN_ROLLING_CACHE=0 disables the rolling breakpoint", model.requests.every((q) => msgBreakpoints(q) === 0));
}
{
  // forced final: a run that hits its turn cap is forced to answer on the last turn — that request carries none.
  const model = scripted([() => [tu("read_document", { documentId: docId })], () => [tu("describe_data", {})], () => [answerToolUse()]]);
  await run("what is the first line on that record", model, {}, { limits: { maxTurns: 3 } });
  const finalReq = model.requests.at(-1);
  check("a forced-final request (tool_choice: answer) carries no message-level breakpoint", finalReq.tool_choice?.type === "tool" && msgBreakpoints(finalReq) === 0, JSON.stringify(finalReq.tool_choice));
}

// --- 4: cheap-model tier ----------------------------------------------------------------------------------------
{
  const { isCheapTierCandidate, cheapRunNeedsFullModel, CHEAP_MODEL, RESEARCH_MODEL } = v2;
  check("candidate: a plain single-record lookup qualifies", isCheapTierCandidate("what's the serial on nakamura's unit"));
  check("candidate: a comparison does not", !isCheapTierCandidate("do we have more invoices or more service tickets"));
  check("candidate: a 'why' question does not", !isCheapTierCandidate("why did the compressor fail at 17 Cactus Ln"));
  check("candidate: an enumeration / 'everything on' question does not", !isCheapTierCandidate("list every customer with a Trane") && !isCheapTierCandidate("everything we have on the Whitmore account"));
  check("candidate: a very long question does not", !isCheapTierCandidate("what is the serial ".repeat(20)));
  eq("cheap models: Haiku for the tier, Sonnet as the full model", [/haiku/i.test(CHEAP_MODEL), /sonnet/i.test(RESEARCH_MODEL)], [true, true]);
  eq("needsFull: a clean handled run stands", cheapRunNeedsFullModel({ handled: true, reason: "answered", dropped: { facts: 0, verify: 0, claims: 0 }, steps: [] }), null);
  check("needsFull: verify/claim drops force the full model", cheapRunNeedsFullModel({ handled: true, reason: "answered", dropped: { facts: 0, verify: 1, claims: 0 }, steps: [] }) === "verification-dropped" && cheapRunNeedsFullModel({ handled: true, reason: "answered", dropped: { facts: 0, verify: 0, claims: 2 }, steps: [] }) === "verification-dropped");
  check("needsFull: no answer forces the full model", cheapRunNeedsFullModel({ handled: false, reason: "no-tool", steps: [] }) === "no-answer");
  eq("needsFull: a provider outage is NOT retried on a second model", cheapRunNeedsFullModel({ handled: false, reason: "provider-unavailable", providerUnavailable: true, steps: [] }), null);
}
const SIMPLE_Q = "what's the first line on that record";
{
  // flag OFF (default): every request is Sonnet, even for a simple question.
  const model = scripted([() => [tu("read_document", { documentId: docId })], () => [answerToolUse()]]);
  const r = await run(SIMPLE_Q, model);
  check("tier OFF (default): a simple question runs on Sonnet only", model.requests.every((q) => /sonnet/i.test(q.model)) && r.escalation === undefined);
}
let cheapCost = 0;
let fullCost = 0;
{
  // flag ON, simple question, Haiku answers cleanly -> accepted, Sonnet never called.
  const model = scripted([(req) => [tu("read_document", { documentId: docId })], () => [answerToolUse()]], { input_tokens: 2500, output_tokens: 200, cache_read_input_tokens: 7000 });
  const r = await run(SIMPLE_Q, model, { DONOVAN_CHEAP_TIER: "1" });
  check("tier ON: a simple question is tried on Haiku first", /haiku/i.test(model.requests[0].model));
  check("tier ON: a clean Haiku answer is accepted — Sonnet is never called", r.handled && model.requests.every((q) => /haiku/i.test(q.model)) && r.escalation === undefined, JSON.stringify(model.requests.map((q) => q.model)));
  check("tier ON: the Haiku run is bounded (<= 3 turns)", model.requests.length <= 3);
  cheapCost = r.costUsd;
  const sonnet = scripted([() => [tu("read_document", { documentId: docId })], () => [answerToolUse()]], { input_tokens: 2500, output_tokens: 200, cache_read_input_tokens: 7000 });
  const rs = await run(SIMPLE_Q, sonnet);
  fullCost = rs.costUsd;
  check("tier ON: the same run costs about a third on Haiku ($1/$5 vs $3/$15 per MTok)", cheapCost > 0 && Math.abs(fullCost / cheapCost - 3) < 0.2, `${cheapCost} vs ${fullCost}`);
}
{
  // Haiku gives up honestly -> re-run on Sonnet, cost of BOTH is counted, escalation recorded.
  const per = { haiku: 0, sonnet: 0 };
  const model = async (req) => {
    const fam = /haiku/i.test(req.model) ? "haiku" : "sonnet";
    per[fam]++;
    if (fam === "haiku") return { content: [tu("answer", { status: "cannot_answer", text: "I cannot tell.", missing: "not sure" })], usage: { input_tokens: 2500, output_tokens: 100 }, stop_reason: "tool_use" };
    return per.sonnet === 1 ? { content: [tu("read_document", { documentId: docId })], usage: { input_tokens: 2500, output_tokens: 100 }, stop_reason: "tool_use" } : { content: [answerToolUse()], usage: { input_tokens: 2500, output_tokens: 200 }, stop_reason: "tool_use" };
  };
  const r = await run(SIMPLE_Q, model, { DONOVAN_CHEAP_TIER: "1" });
  check("escalation: a Haiku miss re-runs the question on Sonnet and answers", r.handled === true && per.haiku >= 1 && per.sonnet >= 2, JSON.stringify(per));
  check("escalation: the result names both models and why", Array.isArray(r.models) && /haiku/i.test(r.models[0]) && /sonnet/i.test(r.models[1]) && typeof r.escalation?.why === "string", JSON.stringify({ models: r.models, esc: r.escalation }));
  const haikuUsd = estimateModelCostUsd("claude-haiku-4-5", { inputTokens: 2500, outputTokens: 100 }) * per.haiku;
  const sonnetUsd = estimateModelCostUsd("claude-sonnet-4-5", { inputTokens: 2500, outputTokens: 100 }) * (per.sonnet - 1) + estimateModelCostUsd("claude-sonnet-4-5", { inputTokens: 2500, outputTokens: 200 });
  check("escalation: total cost is the SUM of the Haiku attempt and the Sonnet run", Math.abs(r.costUsd - (haikuUsd + sonnetUsd)) < 1e-5, `${r.costUsd} vs ${haikuUsd + sonnetUsd}`);
  check("escalation: modelCalls / tokens are summed too", r.modelCalls === per.haiku + per.sonnet && r.outputTokens === 100 * per.haiku + 100 * (per.sonnet - 1) + 200, JSON.stringify({ mc: r.modelCalls, out: r.outputTokens, per }));
}
{
  // Haiku answers, but cites a fact the page does not say -> verify drops it -> Sonnet re-runs (a Haiku answer never ships un-verified).
  const per = { haiku: 0, sonnet: 0 };
  const model = async (req) => {
    const fam = /haiku/i.test(req.model) ? "haiku" : "sonnet";
    per[fam]++;
    if (fam === "haiku") {
      if (per.haiku === 1) return { content: [tu("read_document", { documentId: docId })], usage: { input_tokens: 2500, output_tokens: 100 }, stop_reason: "tool_use" };
      return { content: [tu("answer", { status: "answered", text: "Serial ZZ-0000-FAKE.", facts: [{ label: "Serial", value: "ZZ-0000-FAKE", sources: [{ documentId: docId, location: { page: pageRow.page_no } }] }], confidence: 0.9 })], usage: { input_tokens: 2500, output_tokens: 100 }, stop_reason: "tool_use" };
    }
    return per.sonnet === 1 ? { content: [tu("read_document", { documentId: docId })], usage: { input_tokens: 2500, output_tokens: 100 }, stop_reason: "tool_use" } : { content: [answerToolUse()], usage: { input_tokens: 2500, output_tokens: 200 }, stop_reason: "tool_use" };
  };
  const r = await run(SIMPLE_Q, model, { DONOVAN_CHEAP_TIER: "1" });
  check("a fabricated Haiku fact is never returned (verify drops it, Sonnet answers instead)", r.handled && !JSON.stringify(r.data).includes("ZZ-0000-FAKE") && per.sonnet >= 1, JSON.stringify({ per, data: r.data }).slice(0, 300));
}
{
  // hard question never touches Haiku, even with the flag on.
  const model = scripted([() => [tu("read_document", { documentId: docId })], () => [answerToolUse()]]);
  await run("why did the compressor fail and is it more common on trane than carrier", model, { DONOVAN_CHEAP_TIER: "1" });
  check("tier ON: a hard question goes straight to Sonnet", model.requests.every((q) => /sonnet/i.test(q.model)));
}

/* ================================================================== 5. estimated $/1000 questions */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const tools = (await import("../api/_lib/agent/tools.js")).ALL_TOOL_DEFS_V2;
  const P = estimateTokens(tools) + estimateTokens(v2.RESEARCH_SYSTEM_PROMPT); // stable prefix, tokens
  const Q = 150, H1 = 2500, H2 = 2500, OUT_TOOL = 250, OUT_ANS = 600;
  const usd = (model, calls) => calls.reduce((s, u) => s + estimateModelCostUsd(model, u), 0);
  // steady state: the prefix is a cache READ on every call (0.1x); history is paid at 1x (before) or read at 0.1x + written at 1.25x (after).
  const beforeCalls = [
    { inputTokens: Q, cacheReadInputTokens: P, outputTokens: OUT_TOOL },
    { inputTokens: Q + H1, cacheReadInputTokens: P, outputTokens: OUT_TOOL },
    { inputTokens: Q + H1 + H2, cacheReadInputTokens: P, outputTokens: OUT_ANS },
  ];
  const afterCalls = [
    { inputTokens: Q, cacheReadInputTokens: P, outputTokens: OUT_TOOL },
    { inputTokens: 0, cacheReadInputTokens: P + Q, cacheCreationInputTokens: H1, outputTokens: OUT_TOOL },
    { inputTokens: 0, cacheReadInputTokens: P + Q + H1, cacheCreationInputTokens: H2, outputTokens: OUT_ANS }, // (a non-final turn 2 wrote the H1 breakpoint; the last call is the answer and writes nothing)
  ];
  afterCalls[2].cacheCreationInputTokens = 0; afterCalls[2].inputTokens = H2; // the forced/answer turn carries no breakpoint: its new tokens are plain input
  const sonnetBefore = usd("claude-sonnet-4-5", beforeCalls);
  const sonnetRolling = usd("claude-sonnet-4-5", afterCalls);
  // cheap tier: <= 3 turns of the same shape on Haiku (min cacheable 4096 tokens: the same prefix qualifies)
  const haikuRun = usd("claude-haiku-4-5", afterCalls);

  // route mix from the offline exam (1704 questions): how many need a model, and how many of those are tier candidates.
  const resultsFile = process.env.R31_EXAM_RESULTS;
  let needsModel = 197, total = 1704, candidates = null;
  if (resultsFile && fs.existsSync(resultsFile)) {
    const res = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    total = res.overall.total; needsModel = res.overall.needsModel;
    candidates = res.perQuestion.filter((q) => q.status === "needs-model" && v2.isCheapTierCandidate(q.question)).length;
  }
  const candShare = candidates == null ? null : candidates / needsModel;
  realLog(`\nEST   stable prefix ${P} tokens; per Sonnet research run (3 calls, warm prefix): before $${sonnetBefore.toFixed(4)}, with rolling breakpoint $${sonnetRolling.toFixed(4)} (${((1 - sonnetRolling / sonnetBefore) * 100).toFixed(0)}% less); a Haiku run of the same shape $${haikuRun.toFixed(4)}`);
  check("estimate: the rolling breakpoint makes a 3-call Sonnet run cheaper", sonnetRolling < sonnetBefore, `${sonnetRolling} vs ${sonnetBefore}`);
  if (candShare != null) {
    const per1000 = (perRunCost) => (needsModel / total) * 1000 * perRunCost;
    const before = per1000(sonnetBefore);
    const rollingOnly = per1000(sonnetRolling);
    for (const accept of [0.6, 0.8, 0.95]) {
      const tier = candShare * (accept * haikuRun + (1 - accept) * (haikuRun + sonnetRolling)) + (1 - candShare) * sonnetRolling;
      realLog(`EST   $/1000 exam-mix questions (${needsModel}/${total} need a model; ${(candShare * 100).toFixed(0)}% of those are tier candidates): before $${before.toFixed(2)} | rolling cache $${rollingOnly.toFixed(2)} | + cheap tier @${(accept * 100).toFixed(0)}% Haiku acceptance $${per1000(tier).toFixed(2)}`);
    }
    realLog("EST   (assumptions: 3 model calls/run, 2.5k tokens of tool results per round, warm prefix cache; the Haiku acceptance rate is UNMEASURED — needs the live A/B: node scripts/model-ab.mjs)");
  }
}

console.log = realLog; console.warn = realWarn; console.error = realErr;
const apiFiles = fs.readdirSync(path.join(ROOT, "api"), { withFileTypes: true }).filter((e) => e.isFile()).length;
eq("api/ still has exactly 12 top-level files", apiFiles, 12);
console.log("");
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
