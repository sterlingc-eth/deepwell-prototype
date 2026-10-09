// DONOVAN-R4: the grounding prompt switch. OFF = byte-identical prompt and temperature 0; ON = appended once (idempotent), same cached block, no sampling params on 5.x models.
import assert from "node:assert/strict";
import { withGroundingV2, samplingFor, groundingV2Text, groundingV2Enabled } from "../api/_lib/grounding/promptV2.js";
import { planCacheBreakpoints } from "../api/_lib/promptCache.js";
const off = {}, on = { DONOVAN_GROUNDING_V2: "1" };
const P = "You are Donovan. Rules: cite documents.";
assert.equal(groundingV2Enabled(off), false);
assert.equal(withGroundingV2(P, { env: off }), P, "off = identical");
const a = withGroundingV2(P, { env: on });
assert.ok(a.startsWith(P) && a.includes("GROUNDING DISCIPLINE") && a.length > P.length);
assert.equal(withGroundingV2(a, { env: on }), a, "idempotent");
assert.equal(a.split("GROUNDING DISCIPLINE (applies").length, 2, "appended once");
assert.ok(groundingV2Text("agent").includes("search once more") && !groundingV2Text("grounded").includes("search once more"));
assert.equal(withGroundingV2(a, { env: on, path: "agent" }), a);
assert.deepEqual(samplingFor("claude-sonnet-5-5", off), {}, "5.x never gets temperature, switch or not");
assert.deepEqual(samplingFor("claude-haiku-4-5", off), { temperature: 0 }, "older models keep temperature 0");
assert.deepEqual(samplingFor("claude-sonnet-5-5", on), {});
assert.deepEqual(samplingFor("claude-haiku-5-5", on), {});
assert.deepEqual(samplingFor("claude-haiku-4-5", on), { temperature: 0 });
// same constant text for every call/tenant => the cached prefix is stable
assert.equal(withGroundingV2(P, { env: on }), withGroundingV2(P, { env: on }));
// no injection channel: the text contains no placeholders filled from user data
assert.ok(!/\$\{|\{\{/.test(groundingV2Text("grounded")));
// the cache planner still sees one stable system block
const big = a + "\n" + "x ".repeat(6000);
const plan = planCacheBreakpoints({ system: [{ block: { type: "text", text: big }, breakpoint: true }], messageBlocks: [{ block: { type: "text", text: "question" } }] }, "claude-sonnet-5-5");
assert.ok(JSON.stringify(plan.system).includes("cache_control"), "cache breakpoint kept on the system block");
assert.ok(!JSON.stringify(plan.messageBlocks).includes("cache_control"), "question block never cached");
console.log("ok   grounding V2 prompt: off identical, on appended once, 5.x sampling omitted, cache block intact");
