/**
 * Donovan learning - MISS REPLAY and RECIPE LIFECYCLE: the part that closes the loop.
 *
 *   replayMisses()   re-runs a shop's open misses through the Donovan agent (the same bounded,
 *                    read-only, grounded pipeline live questions use), records per miss whether it
 *                    is ANSWERED NOW (with the answer) or STILL FAILING (with the reason), and turns
 *                    every grounded answer into a recipe proposal.
 *   submitRecipe()   the recipe policy: a recipe goes live only when (a) the same normalized
 *                    question produced the same result signature twice, or (b) an operator approved
 *                    it / a user gave it a thumbs-up on top of one grounded run. Until then it is a
 *                    pending proposal and is NEVER injected into a prompt or replayed.
 *   applyThumbsUp / applyThumbsDown   the feedback buttons on an answer.
 *
 * Privacy: a replay runs a shop's own misses against THAT shop's own data (tenant context = the
 * shop that asked); nothing of one shop's data or questions is ever executed against another's.
 * Replays never touch a customer's allowance (no incrementAsksThisMonth) but do respect the same
 * daily model budget (runDonovanAgent awaits assertModelBudget) plus a per-run cost ceiling.
 * No question text or answer text is ever logged - counts only.
 */
import { withTenant } from "../recordsStore.js";
import { runDonovanAgent, isAgentEnabled } from "../agent/loop.js";
import { normalizeQuestion } from "../nlNormalize.js";
import { recordAskMiss, MISS_OUTCOMES } from "../missStore.js";
import { getActiveOverlay, invalidateActiveOverlayCache } from "./overlay.js";
import { listOpenMisses, upsertReplay } from "./replayStore.js";
import { buildRecipeCandidate, verifyRecipe, normalizeRecipeQuestion, RECIPE_KIND } from "./recipes.js";
import { decideRecipeStatus } from "./policy.js";
import * as store from "./store.js";

export const REPLAY_LIMIT = 15;
export const DEFAULT_REPLAY_BUDGET_MS = 45_000;
const PER_RUN_MS = 28_000;
const CONCURRENCY = 3;
const DEFAULT_MAX_COST_USD = 0.4;

const FAIL_REASON = {
  "token-cap": "ran out of its token budget",
  deadline: "timed out",
  "turn-cap": "needed too many steps",
  "no-tool": "the model gave no answer",
  error: "the model call failed",
  answered: "the records cannot answer it, or the answer was not grounded",
  "agent-disabled": "the agent is switched off",
};

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The key ask_misses / ask_miss_replays use for a question (ask.js: overlay-aware normalize). */
export function missKey(question, overlay) {
  return String(normalizeQuestion(String(question ?? ""), { overlay }).normalized ?? "").slice(0, 300);
}

/** Lower-case words of the shop's customer names: a recipe's SQL may never carry one as a literal. */
export async function loadNameTokens(ctxArg) {
  const tokens = new Set();
  try {
    const rows = await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT data->>'customer_name' AS n FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL
          AND tenant_id = (current_setting('app.tenant_id', true))::uuid LIMIT 20000`, [])).rows);
    for (const r of rows) for (const w of String(r.n ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? []) tokens.add(w);
  } catch { /* no name filter beats no recipe: recipes.js still refuses non-vocabulary literals */ }
  return tokens;
}

/** The active recipe row (donovan_learned) for a normalized recipe question, or null. */
async function activeRecipeRow(question) {
  const rows = await store.listActiveLearned();
  return rows.find((r) => r.kind === RECIPE_KIND && r.value?.question === question) ?? null;
}

/**
 * Feed one grounded agent run into the recipe lifecycle.
 * @returns {Promise<{status: 'not-eligible'|'active'|'pending'|'approved'|'auto_approved'|'rejected'|'unavailable', id?: string,
 *   seen?: number, reason?: string}>}
 */
export async function submitRecipe({ ctxArg, question, run, operatorApproved = false, thumbsUp = false, decidedBy = "system:agent", nameTokens }) {
  try {
    const tokens = nameTokens ?? (await loadNameTokens(ctxArg));
    const cand = buildRecipeCandidate({ question, run, nameTokens: tokens });
    if (!cand.ok) return { status: "not-eligible", reason: cand.reason };
    const recipe = cand.recipe;
    const verification = verifyRecipe(recipe, { nameTokens: tokens });
    if (!verification.ok) return { status: "not-eligible", reason: verification.reasons.join("; ") };

    const existing = await store.findRecipes(recipe.question);
    if (existing.some((p) => p.status === "rejected")) return { status: "rejected" };
    const live = await activeRecipeRow(recipe.question);
    if (live) return { status: "active" };

    const pending = existing.find((p) => p.status === "pending");
    const prevSig = pending?.evidence?.signature;
    const seen = pending && prevSig === recipe.signature ? (Number(pending.evidence?.seen) || 1) + 1 : 1;
    const thumbs = (Number(pending?.evidence?.thumbsUp) || 0) + (thumbsUp ? 1 : 0);
    const evidence = { seen, signature: recipe.signature, thumbsUp: thumbs, lastSource: decidedBy, lastSeenAt: new Date().toISOString() };
    const decision = decideRecipeStatus({ seen, thumbsUp: thumbs, operatorApproved }, verification, process.env.DONOVAN_AUTO_LEARN);

    let id = pending?.id ?? null;
    if (id) await store.updateRecipeProposal(id, recipe, evidence);
    else id = await store.insertProposal({ kind: RECIPE_KIND, payload: recipe, evidence, verification, status: "pending", reason: null });
    if (!id) return { status: "unavailable" };
    if (decision.status === "pending") return { status: "pending", id, seen };
    if (!(await store.decideProposal(id, decision.status, operatorApproved ? decidedBy : "system:recipe-policy"))) return { status: "unavailable" };
    invalidateActiveOverlayCache();
    return { status: decision.status, id, seen };
  } catch (err) {
    console.warn("donovan-recipes: submitRecipe failed (non-fatal):", err?.name ?? "error");
    return { status: "unavailable" };
  }
}

/** Retire the active recipe for a question (a thumbs-down, or the operator). True when one was retired. */
export async function retireRecipeForQuestion(question) {
  const key = normalizeRecipeQuestion(question);
  const rows = await store.listActiveLearned();
  let retired = false;
  for (const r of rows) {
    if (r.kind === RECIPE_KIND && r.value?.question === key && (await store.deactivateLearned(r.id))) retired = true;
  }
  if (retired) invalidateActiveOverlayCache();
  return retired;
}

const OUTCOME_ANSWER_KEYS = ["kind", "text", "confidence", "interpretation"];
function answerSummary(data) {
  if (!data || typeof data !== "object") return null;
  const out = {};
  for (const k of OUTCOME_ANSWER_KEYS) if (data[k] != null) out[k] = data[k];
  out.facts = (data.facts ?? []).slice(0, 40).map((f) => ({ label: f.label, value: f.value, ...(f.status ? { status: f.status } : {}) }));
  return out;
}

function traceOf(run) {
  return {
    queries: (run.queries ?? []).slice(-3).map((q) => ({ sql: String(q.sql).slice(0, 1200), rowCount: q.rowCount })),
    steps: (run.steps ?? []).length,
    modelCalls: run.modelCalls ?? 0,
    costUsd: run.costUsd ?? 0,
    reason: run.reason,
  };
}

/**
 * Replay ONE question. Never throws except ModelBudgetExceededError, which the caller treats as "stop".
 * @returns {Promise<{question: string, outcome: 'answered_now'|'still_failing', reason?: string, answer?: object,
 *   costUsd: number, recipe?: object}>}
 */
export async function replayOne({ ctxArg, item, overlay, hint, callModel, today, source, confirm, spendLeft, operatorApproved = false, decidedBy }) {
  const runOnce = () => runDonovanAgent({
    withTenant, ctxArg, question: item.question, today, overlay, hint, callModel, deadlineAt: Date.now() + PER_RUN_MS,
  });
  let cost = 0;
  let run;
  try {
    run = await runOnce();
    cost += run.costUsd ?? 0;
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") throw err;
    run = { handled: false, reason: "error", costUsd: 0, steps: [], queries: [] };
  }
  const key = item.normalized;
  if (!run.handled) {
    const reason = FAIL_REASON[run.reason] ?? "still failing";
    await upsertReplay(ctxArg, { question: item.question, questionNormalized: key, outcome: "still_failing", reason, note: hint, trace: traceOf(run), costUsd: cost, source });
    return { question: item.question, outcome: "still_failing", reason, costUsd: cost };
  }
  let recipe;
  if (!hint) {
    recipe = await submitRecipe({ ctxArg, question: item.question, run, operatorApproved, ...(decidedBy ? { decidedBy } : {}) });
    // Confirmation run: "the same question produced the same result signature twice" is what lets a
    // recipe go live without a human, so a first sighting is confirmed right away when budget allows.
    if (confirm && recipe.status === "pending" && recipe.seen === 1 && spendLeft() - cost > 0.03) {
      try {
        const again = await runOnce();
        cost += again.costUsd ?? 0;
        if (again.handled) recipe = await submitRecipe({ ctxArg, question: item.question, run: again });
      } catch (err) {
        if (err?.name === "ModelBudgetExceededError") throw err;
      }
    }
  }
  const answer = answerSummary(run.data);
  await upsertReplay(ctxArg, { question: item.question, questionNormalized: key, outcome: "answered_now", answer, note: hint, trace: traceOf(run), costUsd: cost, source });
  return { question: item.question, outcome: "answered_now", answer, costUsd: cost, ...(recipe ? { recipe } : {}) };
}

/**
 * Replay a shop's open misses.
 * @param {object} p
 * @param {{tenantKey: string, tenantName?: string}} p.ctxArg
 * @param {string[]} [p.questions]  explicit questions (skips the open-miss list and its "already replayed" filter)
 * @param {boolean} [p.force]       replay even when a recent outcome exists
 * @param {number}  [p.limit]       max misses per run (default 15)
 * @param {number}  [p.budgetMs]    wall-clock budget for the whole run
 * @param {number}  [p.maxCostUsd]  per-run cost ceiling (DONOVAN_REPLAY_MAX_USD, default 0.40)
 * @param {Function} [p.callModel]  injectable for tests
 */
export async function replayMisses({ ctxArg, questions, force = false, limit = REPLAY_LIMIT, budgetMs = DEFAULT_REPLAY_BUDGET_MS, maxCostUsd, callModel, hint, source = "replay", confirm = true, today, operatorApproved = false, decidedBy }) {
  const summary = { attempted: 0, answeredNow: 0, stillFailing: 0, remaining: 0, costUsd: 0, stopped: null, recipes: { pending: 0, live: 0, notEligible: 0 }, items: [] };
  if (!isAgentEnabled()) return { ...summary, stopped: "agent-disabled" };
  const ceiling = Number.isFinite(maxCostUsd) ? maxCostUsd : Number(process.env.DONOVAN_REPLAY_MAX_USD) || DEFAULT_MAX_COST_USD;
  const overlay = await getActiveOverlay();
  const day = today ?? todayUtc();

  let queue;
  if (Array.isArray(questions)) {
    const seen = new Set();
    queue = questions.map((q) => String(q ?? "").trim().slice(0, 300)).filter(Boolean)
      .map((q) => ({ question: q, normalized: missKey(q, overlay) }))
      .filter((i) => i.normalized && !seen.has(i.normalized) && seen.add(i.normalized));
  } else {
    const open = await listOpenMisses(ctxArg, { limit: 200 });
    const now = Date.now();
    queue = open.filter((m) => {
      if (force || !m.replay) return true;
      if (Date.parse(m.replay.replayedAt) < Date.parse(m.lastAt)) return true; // asked again since
      // A failure is retried after 3 days (the code and prompts change); a success is not re-run.
      return m.replay.outcome === "still_failing" && now - Date.parse(m.replay.replayedAt) > 3 * 24 * 3600 * 1000;
    });
  }
  const batch = queue.slice(0, Math.max(1, Math.min(REPLAY_LIMIT, limit)));
  summary.remaining = queue.length - batch.length;

  const startedAt = Date.now();
  let spent = 0;
  let next = 0;
  const spendLeft = () => ceiling - spent;
  const worker = async () => {
    for (;;) {
      if (summary.stopped) return;
      const i = next++;
      if (i >= batch.length) return;
      if (spendLeft() <= 0.01) { summary.stopped = "cost-ceiling"; summary.remaining += batch.length - i; return; }
      if (Date.now() - startedAt > budgetMs - 4000) { summary.stopped = "time-budget"; summary.remaining += batch.length - i; return; }
      try {
        const r = await replayOne({ ctxArg, item: batch[i], overlay, hint, callModel, today: day, source, confirm, spendLeft, operatorApproved, decidedBy });
        spent += r.costUsd;
        summary.attempted++;
        if (r.outcome === "answered_now") summary.answeredNow++; else summary.stillFailing++;
        if (r.recipe) {
          const s = r.recipe.status;
          if (s === "pending") summary.recipes.pending++;
          else if (s === "approved" || s === "auto_approved" || s === "active") summary.recipes.live++;
          else summary.recipes.notEligible++;
        }
        summary.items.push({ question: r.question, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}), ...(r.answer ? { answer: r.answer } : {}), ...(r.recipe ? { recipe: r.recipe.status } : {}) });
      } catch (err) {
        if (err?.name === "ModelBudgetExceededError") { summary.stopped = "model-budget"; summary.remaining += batch.length - i; return; }
        summary.attempted++;
        summary.stillFailing++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
  summary.costUsd = Math.round(spent * 10000) / 10000;
  console.log(JSON.stringify({ route: "learning-replay", attempted: summary.attempted, answered_now: summary.answeredNow, still_failing: summary.stillFailing, remaining: summary.remaining, cost_usd: summary.costUsd, stopped: summary.stopped }));
  return summary;
}

/* ------------------------------------------------------------------ feedback */

/**
 * Thumbs-up on an answer. An operator's approves the pending recipe outright; a normal user's counts
 * as one confirmation on top of a grounded run (decideRecipeStatus).
 * @returns {Promise<{status: string}>}
 */
export async function applyThumbsUp({ ctxArg, question, isOperator, decidedBy }) {
  try {
    const norm = normalizeRecipeQuestion(question);
    const existing = await store.findRecipes(norm);
    if (await activeRecipeRow(norm)) return { status: "active" };
    const pending = existing.find((p) => p.status === "pending");
    if (!pending) return { status: "no-recipe" };
    const tokens = await loadNameTokens(ctxArg);
    const verification = verifyRecipe(pending.payload, { nameTokens: tokens });
    const thumbs = (Number(pending.evidence?.thumbsUp) || 0) + 1;
    const evidence = { ...(pending.evidence ?? {}), thumbsUp: thumbs };
    const decision = decideRecipeStatus({ seen: Number(pending.evidence?.seen) || 1, thumbsUp: thumbs, operatorApproved: Boolean(isOperator) }, verification, process.env.DONOVAN_AUTO_LEARN);
    await store.updateRecipeProposal(pending.id, pending.payload, evidence);
    if (decision.status === "pending") return { status: "pending" };
    if (!(await store.decideProposal(pending.id, decision.status, isOperator ? decidedBy : "system:thumbs-up"))) return { status: "unavailable" };
    invalidateActiveOverlayCache();
    return { status: decision.status };
  } catch (err) {
    console.warn("donovan-recipes: thumbs-up failed (non-fatal):", err?.name ?? "error");
    return { status: "unavailable" };
  }
}

/**
 * Thumbs-down: record a correction miss, retire any live recipe for this question (a wrong shortcut
 * must stop being replayed), and re-run the question once with the user's note as a hint.
 * @returns {Promise<{replay: object|null, retired: boolean, budget?: boolean}>}
 */
export async function applyThumbsDown({ ctxArg, question, note, callModel, today }) {
  const q = String(question ?? "").trim().slice(0, 300);
  const overlay = await getActiveOverlay();
  const key = missKey(q, overlay);
  await recordAskMiss(ctxArg, { question: q, questionNormalized: key, outcome: MISS_OUTCOMES.USER_MARKED_WRONG });
  const retired = await retireRecipeForQuestion(q);
  const hint = String(note ?? "").trim().slice(0, 300) || "The user says the previous answer was wrong.";
  try {
    const r = await replayOne({ ctxArg, item: { question: q, normalized: key }, overlay, hint, callModel, today: today ?? todayUtc(), source: "thumbs-down", confirm: false, spendLeft: () => 0 });
    return { replay: { outcome: r.outcome, reason: r.reason ?? null, answer: r.answer ?? null }, retired };
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") return { replay: null, retired, budget: true };
    return { replay: null, retired };
  }
}

/**
 * An operator approving a "Can't do yet" (capability_gap) proposal: approving must DO something, so the
 * example question that exposed the gap is replayed now and, when the agent answers it with a grounded
 * result, its recipe is created and activated (the operator's approval is the confirmation).
 * @returns {Promise<{replayed: boolean, outcome?: string, reason?: string, answer?: object, recipe?: string, costUsd?: number, stopped?: string}>}
 */
export async function replayCapabilityGap({ ctxArg, proposal, decidedBy, callModel, today }) {
  const example = String(proposal?.payload?.example ?? "").trim();
  if (!example) return { replayed: false, reason: "this proposal has no example question" };
  const r = await replayMisses({ ctxArg, questions: [example], force: true, confirm: false, source: "capability-gap", operatorApproved: true, decidedBy, callModel, today });
  const item = r.items[0];
  if (!item) return { replayed: false, ...(r.stopped ? { stopped: r.stopped } : {}), reason: r.stopped ?? "not replayed" };
  return { replayed: true, outcome: item.outcome, ...(item.reason ? { reason: item.reason } : {}), ...(item.answer ? { answer: item.answer } : {}), ...(item.recipe ? { recipe: item.recipe } : {}), costUsd: r.costUsd };
}
