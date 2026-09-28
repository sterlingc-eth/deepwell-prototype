#!/usr/bin/env node
/**
 * MOCK ANTHROPIC CLIENT — ROUND 23 (T1, live-credit test day prep), build item 1.
 *
 * scripts/offline-exam.mjs's `installModelBlock` patches the shared `Anthropic.prototype.messages`
 * object (every `new Anthropic(...)` call site in this codebase gets the SAME instance, since the SDK
 * puts `messages` on the prototype chain) so every model call throws. This file uses the exact same
 * patch point, but instead of throwing it returns a REALISTIC, SCHEMA-VALID response with plausible
 * usage — so scripts/verify-live-test-day.mjs can drive scripts/live-test-day.mjs and
 * scripts/model-ab.mjs's `--live` path through the ENTIRE production code path (ask.js's pre-router,
 * the analytics planner, agent/loopV2.js's tool loop, withBackoff's retry logic, the scorecard runner's
 * cost/latency accounting) with ZERO real network calls and ZERO Anthropic credits spent — finding a
 * bug in the live path TODAY, in this sandbox, rather than tomorrow when the owner is watching.
 *
 * This is a TEST DOUBLE, not a second implementation of Donovan: it never inspects the actual question
 * or tries to answer it correctly (it has no access to the tenant's data — nor should it, since a
 * correct-looking mocked answer would be MORE dangerous to trust than an obviously-mocked one). Every
 * mocked answer's text says outright that it is a mock. What IS realistic:
 *   - the response shape (`content: [...]`, `usage: {...}`) is byte-identical to what the SDK returns;
 *   - every tool call OBEYS the request's own `tool_choice`/`tools` (a forced tool gets a schema-valid
 *     input for THAT tool's required properties; "auto" mode picks the `answer` tool when the toolset
 *     has one, exactly like a real model that already knows enough — or thinks it does);
 *   - usage numbers are DERIVED from the real request (promptCache.js's own `estimateTokens` on the
 *     actual system/messages/tools this call sent), not hardcoded, so cost accounting is exercised
 *     against realistically-sized numbers that scale with the real prompts this codebase builds;
 *   - failure modes (429/529/credits-out/slow) are OPT IN per scenario, so a test can specifically
 *     exercise withBackoff's retry path, ProviderUnavailableError classification, or a per-question
 *     timeout without guessing at random when they'll occur.
 *
 * Usage:
 *   import { installMockAnthropicClient } from "./lib/mockAnthropicClient.mjs";
 *   const mock = await installMockAnthropicClient({ mode: "answer", wrongRate: 0.1 });
 *   ... exercise the real pipeline ...
 *   mock.calls          // total messages.create invocations this process has made since install
 *   mock.restore()       // put the original (offline-exam-blocked or real) create back
 *
 * Only ONE installer (this one or offline-exam.mjs's installModelBlock) should be active at a time —
 * both patch the same shared prototype method, so whichever installs LAST wins; `restore()` puts back
 * whatever `create` was in place immediately before this call (chainable).
 */
import { estimateTokens } from "../../api/_lib/promptCache.js";
import { makeRng } from "./rng.mjs";

/** Every tool name this codebase's own forced tool_choice can ask for, and how to fill a schema-valid
 *  `input` for it without knowing anything about the real question. Extend this map, never hardcode a
 *  new tool's shape inline in `fillToolInput`, so a future tool this pipeline adds degrades to the
 *  generic filler (still schema-valid — see `genericFill`) rather than crashing the mock. */
const KNOWN_TOOL_FILLERS = {
  /** api/_lib/agent/tools.js's ANSWER_TOOL_DEF — the tool loopV2.js's turn 1 (tool_choice: "auto") and
   *  every forced final turn both end on. `status` is chosen from `plan` below so a caller can dial the
   *  mix of honest-decline vs. (clearly labeled, ungrounded) "answered" mock outcomes — the latter
   *  exists ONLY so scripts/verify-live-test-day.mjs can assert the report's CONFIDENT-WRONG counter
   *  actually counts something, not because a mocked "answered" is meant to look trustworthy. */
  answer(plan) {
    const roll = plan.rng();
    if (roll < plan.wrongRate) {
      return {
        status: "answered",
        text: "MOCK ANSWER (live-test-day rehearsal, no real model was called): the on-file records show 42 as the figure for this question.",
        facts: [{ label: "mock fact", value: "42" }],
        confidence: 0.9,
      };
    }
    if (roll < plan.wrongRate + plan.declineRate) {
      return {
        status: "cannot_answer",
        text: "MOCK ANSWER (live-test-day rehearsal, no real model was called): these records do not contain enough to answer this confidently.",
        missing: "mock mode — no real model call was made",
      };
    }
    return { status: "none_found", text: "MOCK ANSWER (live-test-day rehearsal, no real model was called): nothing on file matched." };
  },
  /** api/_lib/analytics.js's ANALYTICS_TOOL — required: entity, op. A minimal, always-valid plan; the
   *  executor downstream (routes/analytics.js) still runs a REAL query against the REAL (PGlite) tenant
   *  data for whichever entity/op comes back, so this still exercises real DB code, just not a plan
   *  that necessarily matches the question's own intent (the mock cannot read the question and know
   *  what a human would ask for without defeating the point of a test double). */
  analytics_plan() {
    return { entity: "customers", op: "count" };
  },
};

/** For any OTHER forced tool (one of tools.js's research tools, if a future request ever forces one
 *  directly instead of leaving it to "auto") — fill only the `required` properties, generic by JSON
 *  Schema `type`, so the response always validates against the tool's own schema without this file
 *  needing to know that tool's business meaning. */
function genericFill(toolDef) {
  const props = toolDef?.input_schema?.properties ?? {};
  const required = toolDef?.input_schema?.required ?? [];
  const out = {};
  for (const key of required) {
    const spec = props[key] ?? {};
    if (Array.isArray(spec.enum) && spec.enum.length) { out[key] = spec.enum[0]; continue; }
    switch (spec.type) {
      case "number": out[key] = 1; break;
      case "boolean": out[key] = true; break;
      case "array": out[key] = []; break;
      case "object": out[key] = {}; break;
      default: out[key] = `mock-${key}`;
    }
  }
  return out;
}

function fillToolInput(toolDef, plan) {
  const filler = KNOWN_TOOL_FILLERS[toolDef?.name];
  return filler ? filler(plan) : genericFill(toolDef);
}

/** Which tool this call's response should use: whatever `tool_choice` forces, else (auto/unset) the
 *  `answer` tool if the toolset offers one (every agent-loop turn does), else the first tool listed —
 *  a request with `tools` but no `answer` and no forced choice is not a shape this codebase's own call
 *  sites produce today, so falling back to "the first one" is a reasonable, non-crashing default rather
 *  than a shape this file needs to special-case. */
function pickTool(req) {
  const tools = Array.isArray(req?.tools) ? req.tools.map((t) => t?.block ?? t) : [];
  if (req?.tool_choice?.type === "tool" && req.tool_choice.name) {
    return tools.find((t) => t?.name === req.tool_choice.name) ?? { name: req.tool_choice.name, input_schema: { type: "object", properties: {} } };
  }
  return tools.find((t) => t?.name === "answer") ?? tools[0] ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [opts]
 * @param {"answer"|"flaky"|"overloaded"|"creditsOut"|"authError"|"slow"} [opts.mode="answer"]
 *   "answer"      normal operation: every call gets a schema-valid tool_use response immediately.
 *   "flaky"       the first `opts.failFirstN` calls (default 2) throw a retryable 529 overloaded_error
 *                 (isRetryableModelStatus in api/_lib/claude.js treats 429/529 as retryable), then this
 *                 mode behaves like "answer" — exercises withBackoff's real retry/backoff path.
 *   "overloaded"  EVERY call throws 529 — exhausts withBackoff's retries, exercising
 *                 classifyProviderError / ProviderUnavailableError / recordProviderOutage.
 *   "creditsOut"  EVERY call throws the exact 400 shape classifyProviderError's CREDIT_ERROR_RE
 *                 matches ("Your credit balance is too low...") — the real shape an exhausted account
 *                 returns; NOT retried (withBackoff only retries 429/529).
 *   "authError"   EVERY call throws 401 — an invalid/revoked key.
 *   "slow"        every call sleeps `opts.latencyMs` (default 500) before answering — combine with a
 *                 short `deadlineAt` on the caller's side (askViaHandler's own param) to exercise a
 *                 per-question timeout without a real multi-second wait in a verify script.
 * @param {number} [opts.failFirstN=2]     "flaky" mode: how many leading calls fail before succeeding.
 * @param {number} [opts.latencyMs=0]      artificial per-call delay in every mode (ms).
 * @param {number} [opts.wrongRate=0]      "answer" tool: fraction of calls that mock a confidently
 *   WRONG "answered" response (clearly labeled as a mock in its own text) instead of an honest decline
 *   — lets a verify script assert the live-test-day report's CONFIDENT-WRONG counter actually counts.
 * @param {number} [opts.declineRate=0.7]  fraction that mock "cannot_answer" (the rest "none_found").
 * @param {number} [opts.seed]             seeds the wrongRate/declineRate roll for reproducible asserts.
 * @param {number} [opts.outputTokens=110] mocked output token count per call (a small, plausible
 *   tool_use response is a couple hundred tokens at most — never a made-up huge number).
 * @param {number} [opts.cacheReadShare=0] fraction of the call's total input tokens reported as
 *   `cache_read_input_tokens` instead of fresh `input_tokens` — 0 by default (never assume a cache hit
 *   that promptCache.js's own breakpoint logic didn't actually request); set > 0 to exercise the
 *   cache-aware cost math in api/_lib/usage.js's estimateModelCostUsd / planner/spend.js's
 *   routeCostReport.
 * @returns {Promise<{calls: number, callLog: object[], restore: () => void}>}
 */
export async function installMockAnthropicClient(opts = {}) {
  const {
    mode = "answer", failFirstN = 2, latencyMs = 0, wrongRate = 0, declineRate = 0.7,
    seed, outputTokens = 110, cacheReadShare = 0,
  } = opts;
  const rng = makeRng(seed);

  process.env.CLAUDE_API_KEY ||= "sk-ant-mock-live-test-day";
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const probe = new Anthropic({ apiKey: "x" });
  const proto = Object.getPrototypeOf(probe.messages);
  const previousCreate = proto.create;

  const state = { calls: 0, callLog: [] };
  const plan = { rng, wrongRate, declineRate };

  proto.create = async function mockAnthropicCreate(req) {
    state.calls += 1;
    const callIndex = state.calls;
    if (latencyMs > 0) await sleep(latencyMs);

    if (mode === "overloaded" || (mode === "flaky" && callIndex <= failFirstN)) {
      const err = new Error("Overloaded (mocked live-test-day scenario)");
      err.status = 529;
      err.type = "overloaded_error";
      state.callLog.push({ call: callIndex, thrown: "overloaded" });
      throw err;
    }
    if (mode === "creditsOut") {
      const err = new Error("Your credit balance is too low to access the Anthropic API (mocked live-test-day scenario)");
      err.status = 400;
      err.type = "invalid_request_error";
      state.callLog.push({ call: callIndex, thrown: "credits" });
      throw err;
    }
    if (mode === "authError") {
      const err = new Error("invalid x-api-key (mocked live-test-day scenario)");
      err.status = 401;
      state.callLog.push({ call: callIndex, thrown: "auth" });
      throw err;
    }

    const toolDef = pickTool(req);
    const input = toolDef ? fillToolInput(toolDef, plan) : {};
    const content = toolDef
      ? [{ type: "tool_use", id: `mock-${callIndex}-${toolDef.name}`, name: toolDef.name, input }]
      : [{ type: "text", text: "MOCK ANSWER (live-test-day rehearsal, no real model was called)." }];

    // Real prompt size, real estimator (see file header) — never a hardcoded input-token figure.
    const realInputTokens = estimateTokens({ system: req?.system, messages: req?.messages, tools: req?.tools });
    const cacheReadInputTokens = Math.round(realInputTokens * Math.max(0, Math.min(1, cacheReadShare)));
    const inputTokens = Math.max(0, realInputTokens - cacheReadInputTokens);

    state.callLog.push({ call: callIndex, model: req?.model, tool: toolDef?.name ?? null, inputTokens, outputTokens });
    return {
      id: `mock-msg-${callIndex}`,
      type: "message",
      role: "assistant",
      model: req?.model,
      content,
      stop_reason: toolDef ? "tool_use" : "end_turn",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: 0,
      },
    };
  };

  return {
    get calls() { return state.calls; },
    get callLog() { return state.callLog; },
    restore() { proto.create = previousCreate; },
  };
}
