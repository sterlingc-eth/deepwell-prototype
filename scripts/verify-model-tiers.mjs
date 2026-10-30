// Tiered model policy check (owner 2026-10-30): Haiku is the default for every paid call; Sonnet only via the designated, budget-gated
// escalation paths (api/_lib/agent/escalation.js default; used by agent/loop.js and agent/loopV2.js). Stub only: no network, no DB.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
for (const k of Object.keys(process.env)) if (/(_MODEL|MODEL_|AI_COST|DONOVAN_(SONNET|ESCALATION|RESEARCH|CHEAP))/.test(k) && k !== "MODEL_AVOIDANCE") delete process.env[k];
const isHaiku = (m) => /^claude-haiku-/.test(String(m));

// 1. Static: a Sonnet/Opus model id literal may only appear in the designated escalation module (comments and usage.js price notes excluded).
const ALLOWED = new Set(["api/_lib/agent/escalation.js"]);
const hits = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|ts)$/.test(e.name)) {
  const rel = path.relative(root, p).replaceAll("\\", "/");
  fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => { const code = line.replace(/^\s*(\/\/|\*|\/\*).*/, ""); if (/["'`]claude-(sonnet|opus)[-0-9a-z.]*["'`]/i.test(code) && !ALLOWED.has(rel)) hits.push(`${rel}:${i + 1}`); }); } } })(path.join(root, "api"));
ok(hits.length === 0, "no Sonnet/Opus id literal outside escalation.js" + (hits.length ? " -> " + hits.slice(0, 8).join(", ") : ""));

// 2. Runtime defaults (env cleaned above).
const imp = async (rel) => { try { return await import(path.join(root, rel)); } catch (e) { ok(false, `import ${rel}: ${e.message.split("\n")[0]}`); return null; } };
const checks = [
  ["api/_lib/extractDocument.js", (m) => m.EXTRACT_MODEL, "EXTRACT_MODEL"],
  ["api/_lib/docrecord/provider.js", (m) => m.RECORD_MODEL, "RECORD_MODEL"],
  ["api/_lib/financials/extract.js", (m) => m.FINANCIALS_MODEL, "FINANCIALS_MODEL"],
  ["api/_lib/routes/analytics.js", (m) => m.ANALYTICS_MODEL, "ANALYTICS_MODEL"],
  ["api/_lib/routes/expenses.js", (m) => m.EXPENSE_EXTRACT_MODEL, "EXPENSE_EXTRACT_MODEL"],
  ["api/_lib/agent/loop.js", (m) => m.AGENT_MODEL, "AGENT_MODEL (first attempt)"],
  ["api/_lib/agent/loopV2.js", (m) => m.CHEAP_MODEL, "research CHEAP_MODEL (first attempt)"],
  ["api/_lib/learning/proposer.js", (m) => m.LEARN_MODEL, "learning LEARN_MODEL"],
  ["api/_lib/learning/vocabMining.js", (m) => m.VOCAB_MINE_MODEL, "learning VOCAB_MINE_MODEL"],
  ["api/_lib/scorecard/grader.js", (m) => m.GRADER_MODEL, "scorecard GRADER_MODEL"],
  ["api/_lib/records/pickCall.js", (m) => m.MENU_MODEL(), "MENU_MODEL"],
  ["api/_lib/records/orgPickCall.js", (m) => m.ORG_MODEL(), "ORG_MODEL"],
  ["api/_lib/dql/translator/call.js", (m) => m.TRANSLATOR_MODEL(), "TRANSLATOR_MODEL"],
  ["api/_lib/safetynet/flags.js", (m) => m.auditModel(), "safetynet auditModel"],
  ["api/_lib/support/policy.js", (m) => m.MODEL.id, "support chat MODEL.id"],
  ["api/_lib/aiFinish.js", (m) => m.aiFinishModel(), "aiFinishModel"],
  ["api/_lib/demo/tryown/config.js", (m) => (m.resolveConfig)?.(process.env)?.model, "demo sandbox model"],
  ["api/_lib/readDocument.js", (m) => { const r = m.resolveTranscribeModels({}); return `${r.fast}|${r.strong}`; }, "TRANSCRIBE fast|strong"],
  ["api/ask.js", (m) => m.ASK_MODEL, "ASK_MODEL"],
];
for (const [rel, get, label] of checks) { const m = await imp(rel); if (!m) continue; let v; try { v = get(m); } catch (e) { ok(false, `${label}: ${e.message}`); continue; } ok(String(v).split("|").every(isHaiku), `${label} defaults to Haiku (${v})`); }

// 3. Tiering policy.
const esc = await imp("api/_lib/agent/escalation.js");
if (esc) {
  ok(/sonnet/.test(esc.escalationModel({})), "designated escalation default is Sonnet: " + esc.escalationModel({}));
  const caps = { solo: 6, shop: 9, crew: 14, fleet: 35 };
  for (const [p, c] of Object.entries(caps)) { ok(esc.sonnetMonthlyCapUsd(p, "active", {}) === c, `Sonnet monthly cap ${p}=$${c}`); ok(Math.abs(esc.sonnetDailyCapForPlanUsd(p, "active", {}) - c / 8) < 1e-9, `Sonnet daily cap ${p}=monthly/8`); }
  ok(esc.sonnetMonthlyCapUsd("solo", "trialing", {}) === 1, "trial Sonnet total = $1");
  ok(esc.sonnetMonthlyCapUsd("mystery", "active", {}) === 0 && esc.sonnetMonthlyCapUsd("demo", "demo", {}) === 0, "unknown plan / demo -> no Sonnet");
  ok(esc.platformSonnetDailyUsd({}) === 10, "platform Sonnet daily = $10");
  ok(esc.sonnetMonthlyCapUsd("solo", "active", { DONOVAN_SONNET_MONTHLY_USD_SOLO: "7" }) === 7, "env override works");
  ok(esc.QUESTION_SONNET_INPUT_CAP === 40000 && esc.QUESTION_SONNET_OUTPUT_CAP === 1500 && (40000 * 2 + 1500 * 10) / 1e6 <= esc.QUESTION_SONNET_HARD_STOP_USD + 1e-9, "per-question cap <= $0.095");
  const base = { plan: "shop", billingStatus: "active", spentDayUsd: 0, spentMonthUsd: 0, spentPlatformDayUsd: 0, env: {} };
  ok(esc.decideSonnet(base).allowed, "gate allows under all caps");
  ok(esc.decideSonnet({ ...base, spentMonthUsd: 9 }).why === "monthly-cap", "fail closed: monthly cap");
  ok(esc.decideSonnet({ ...base, spentDayUsd: 9 / 8 }).why === "daily-cap", "fail closed: daily cap");
  ok(esc.decideSonnet({ ...base, spentPlatformDayUsd: 10 }).why === "platform-cap", "fail closed: platform cap");
  ok(esc.decideSonnet({ ...base, spentPlatformDayUsd: null }).why === "spend-unreadable", "fail closed: unreadable platform counter");
  const broken = async () => { throw new Error("db down"); };
  const g = await esc.sonnetAllowed(broken, {}, {});
  ok(g.allowed === false && g.why === "spend-unreadable", "fail closed: DB error -> Haiku answer stands");
  ok((await esc.sonnetAllowed(broken, {}, { DONOVAN_ESCALATION: "0" })).why === "disabled", "DONOVAN_ESCALATION=0 disables");
  ok(esc.needsEscalation({ handled: true, steps: [{}, {}], dropped: { verify: 1 } }) === "verification-failed", "multi-step verification failure triggers escalation");
  ok(esc.needsEscalation({ handled: true, steps: [{}], dropped: { verify: 1 } }) === null, "single-step run does not");
}
const v2 = await imp("api/_lib/agent/loopV2.js");
if (v2) { ok(v2.isCheapTierEnabled({}) && !v2.isCheapTierEnabled({ DONOVAN_CHEAP_TIER: "0" }), "research agent starts on Haiku by default"); }

// 4. Monthly total allowance + safety ceilings.
const al = await imp("api/_lib/aiAllowance.js");
if (al) {
  for (const [p, c] of Object.entries({ solo: 20, shop: 40, crew: 80, fleet: 180 })) ok(al.aiMonthlyCeilingUsd(p, "active", {}) === c, `AI monthly ceiling ${p}=$${c}`);
  ok(al.aiMonthlyCeilingUsd("solo", "trialing", {}) === 8, "trial total $8");
  ok(al.aiMonthlyCeilingUsd("x", "active", {}) === 0, "unknown plan -> 0 (closed)");
  ok(al.decideAllowance({ plan: "solo", billingStatus: "active", spentUsd: 20 }).why === "monthly-ceiling", "at ceiling -> paused");
  ok(al.decideAllowance({ plan: "solo", billingStatus: "active", spentUsd: 19.99 }).allowed, "under ceiling -> allowed");
  ok(al.decideAllowance({ plan: "solo", billingStatus: "active", spentUsd: null }).allowed === false, "unreadable spend -> closed");
  const msg = al.allowanceMessage(Date.UTC(2026, 9, 30)); ok(/resets on November 1\./.test(msg) && !/\$|\d+\.\d\d/.test(msg), "customer message names reset date, no dollars: " + msg);
  ok((await al.allowanceStatus(async () => { throw new Error("x"); }, {})).allowed === false, "allowanceStatus fails closed on DB error");
}
const plan = await imp("api/_lib/plan.js");
if (plan) for (const [p, n] of Object.entries({ solo: 1000, shop: 3000, crew: 8000 })) ok(plan.donovanSafetyPerMonth({}, p) === n, `Donovan safety ceiling ${p}=${n}`);
console.log(fails ? `\n${fails} FAILED` : "\nall model-tier checks passed"); process.exit(fails ? 1 : 0);
