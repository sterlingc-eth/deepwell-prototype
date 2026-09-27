/**
 * ROUND 20 (J4, credit-return readiness), task 2: checks for
 * api/_lib/planner/spend.js (the per-tenant daily $ cap / per-question budget / $-per-question
 * reporting helpers) plus the prompt-caching wiring this round adds to the analytics planner and the
 * research agent's own existing use of it.
 *
 * No real Postgres, no real Anthropic call, no network: `withTenant` is a small in-memory fake that
 * mimics the ONE query shape escalation.js's sonnetSpentTodayUsd/recordSonnetSpend actually run
 * (SELECT units ... / INSERT ... ON CONFLICT ... DO UPDATE) closely enough to exercise this file's own
 * routing/fail-open logic end to end — the DB-hitting SQL itself is already covered against a real
 * PGlite-backed Postgres by scripts/verify-scorecard.mjs's own daily-Sonnet-spend section. This file's
 * job is proving THIS layer (bucket selection, env-var caps, ModelBudgetExceededError, reporting), not
 * re-proving escalation.js's own SQL a second time.
 *
 *   node scripts/verify-spend-control.mjs
 */
import {
  ROUTE_BUCKETS, dailyCapUsd, assertDailySpend, recordDailySpend,
  DEFAULT_PER_QUESTION_MAX_USD, perQuestionCapUsd, withinPerQuestionBudget, routeCostReport,
} from '../api/_lib/planner/spend.js';
import { SONNET_BUCKET } from '../api/_lib/agent/escalation.js';
import { estimateTokens, cacheable, minTokensFor, planCacheBreakpoints } from '../api/_lib/promptCache.js';
import { ANALYTICS_TOOL, ANALYTICS_SYSTEM_PROMPT, buildAnalyticsSystemPrompt } from '../api/_lib/analytics.js';
import { ANALYTICS_MODEL } from '../api/_lib/routes/analytics.js';
import { readFileSync } from 'node:fs';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

/* ============================================================ 0. bucket naming stays paired with
 * agent/loopV2.js's own RESEARCH_BUCKET constant — see spend.js's own doc comment on why it does NOT
 * import loopV2.js directly (cold-start: routes/analytics.js, which imports THIS file, is one of the
 * modules ask.js deliberately keeps behind a dynamic import() specifically to avoid dragging in
 * loopV2's own large module tree — see scripts/verify-cold-start.mjs). This is the guard against the
 * two literals drifting apart. */
{
  const { RESEARCH_BUCKET: loopV2ResearchBucket } = await import('../api/_lib/agent/loopV2.js');
  check(
    'ROUTE_BUCKETS.research.bucket stays paired with agent/loopV2.js\'s own RESEARCH_BUCKET',
    ROUTE_BUCKETS.research.bucket === loopV2ResearchBucket,
    `spend.js: ${ROUTE_BUCKETS.research.bucket}, loopV2.js: ${loopV2ResearchBucket}`
  );
}
check(
  'ROUTE_BUCKETS.escalation.bucket stays paired with agent/escalation.js\'s own SONNET_BUCKET',
  ROUTE_BUCKETS.escalation.bucket === SONNET_BUCKET
);

/* ============================================================ 1. dailyCapUsd: env override, default, invalid input */

check('dailyCapUsd: analyticsPlanner defaults to $1', dailyCapUsd('analyticsPlanner', {}) === 1);
check('dailyCapUsd: env override wins', dailyCapUsd('analyticsPlanner', { DONOVAN_ANALYTICS_DAILY_USD: '3.5' }) === 3.5);
check('dailyCapUsd: 0 is a valid override (disables the route)', dailyCapUsd('analyticsPlanner', { DONOVAN_ANALYTICS_DAILY_USD: '0' }) === 0);
check('dailyCapUsd: a garbage env value falls back to the default, never NaN', dailyCapUsd('analyticsPlanner', { DONOVAN_ANALYTICS_DAILY_USD: 'nope' }) === 1);
check('dailyCapUsd: a negative env value falls back to the default', dailyCapUsd('analyticsPlanner', { DONOVAN_ANALYTICS_DAILY_USD: '-5' }) === 1);
check('dailyCapUsd: an unknown route is never capped (Infinity, never metered)', dailyCapUsd('not-a-real-route', {}) === Infinity);

/* ============================================================ 2. fail-open: no tenant context */

{
  const status = await assertDailySpend(undefined, undefined, 'analyticsPlanner');
  check('assertDailySpend: no withTenant/ctxArg -> allowed, skipped (fails open)', status.allowed === true && status.skipped === true);
  const recorded = await recordDailySpend(undefined, undefined, 'analyticsPlanner', 1);
  check('recordDailySpend: no withTenant/ctxArg -> no-op, returns false', recorded === false);
}
{
  // A real withTenant/ctxArg but an unknown route name: also skips, never throws for a route this
  // file doesn't know about.
  const fakeWithTenant = async (_ctx, fn) => fn({ raw: async () => ({ rows: [] }) });
  const status = await assertDailySpend(fakeWithTenant, { tenantKey: 'x' }, 'not-a-real-route');
  check('assertDailySpend: unknown route -> allowed, skipped', status.allowed === true && status.skipped === true);
}

/* ============================================================ 3. in-memory fake withTenant: the real
 * SELECT/INSERT-ON-CONFLICT round trip escalation.js's sonnetSpentTodayUsd/recordSonnetSpend run,
 * faked closely enough to exercise assertDailySpend/recordDailySpend end to end. */

function makeFakeWithTenant() {
  const store = new Map(); // `${tenantKey}|${bucket}|${windowStart}` -> micro-dollars
  return async (ctx, fn) => {
    const db = {
      async raw(sql, params) {
        if (/^\s*SELECT/i.test(sql)) {
          const [bucket, windowStart] = params;
          return { rows: [{ units: store.get(`${ctx.tenantKey}|${bucket}|${windowStart}`) ?? 0 }] };
        }
        const [bucket, windowStart, micro] = params;
        const key = `${ctx.tenantKey}|${bucket}|${windowStart}`;
        store.set(key, Math.min(2_000_000_000, (store.get(key) ?? 0) + micro));
        return { rows: [] };
      },
    };
    return fn(db);
  };
}

{
  const withTenant = makeFakeWithTenant();
  const ctxArg = { tenantKey: 'org_spend_a' };
  const env = { DONOVAN_ANALYTICS_DAILY_USD: '1' };

  const before = await assertDailySpend(withTenant, ctxArg, 'analyticsPlanner', env);
  check('assertDailySpend: an untouched tenant is allowed, spentUsd 0', before.allowed === true && before.spentUsd === 0);

  await recordDailySpend(withTenant, ctxArg, 'analyticsPlanner', 0.7);
  const mid = await assertDailySpend(withTenant, ctxArg, 'analyticsPlanner', env);
  check('assertDailySpend: spend recorded shows up on the next read', mid.allowed === true && Math.abs(mid.spentUsd - 0.7) < 1e-9);

  await recordDailySpend(withTenant, ctxArg, 'analyticsPlanner', 0.4);
  let threw = null;
  try { await assertDailySpend(withTenant, ctxArg, 'analyticsPlanner', env); }
  catch (err) { threw = err; }
  check('assertDailySpend: throws ModelBudgetExceededError once the cap is passed', threw?.name === 'ModelBudgetExceededError');
  check('assertDailySpend: the thrown error carries a route-specific message', typeof threw?.message === 'string' && threw.message.includes('analyticsPlanner'));

  // A DIFFERENT tenant, and a DIFFERENT route on the SAME tenant, are unaffected — separate ledgers.
  const otherTenant = await assertDailySpend(withTenant, { tenantKey: 'org_spend_b' }, 'analyticsPlanner', env);
  check('assertDailySpend: a different tenant has its own, untouched ledger', otherTenant.allowed === true && otherTenant.spentUsd === 0);
  const otherRoute = await assertDailySpend(withTenant, ctxArg, 'retrieval', env);
  check('assertDailySpend: a different ROUTE on the same tenant has its own ledger', otherRoute.allowed === true && otherRoute.spentUsd === 0);

  const recorded = await recordDailySpend(withTenant, ctxArg, 'analyticsPlanner', 0);
  check('recordDailySpend: a zero/non-positive amount is a no-op', recorded === false);
}

/* ============================================================ 4. per-question budget (pure) */

check('DEFAULT_PER_QUESTION_MAX_USD: a sane positive default with no env override', DEFAULT_PER_QUESTION_MAX_USD === 0.5);
check('withinPerQuestionBudget: under cap -> true', withinPerQuestionBudget(0.1, 0.5) === true);
check('withinPerQuestionBudget: at cap -> false (strictly under, never AT)', withinPerQuestionBudget(0.5, 0.5) === false);
check('withinPerQuestionBudget: over cap -> false', withinPerQuestionBudget(0.6, 0.5) === false);
{
  const capUsd = perQuestionCapUsd('claude-sonnet-4-5', 120_000);
  check('perQuestionCapUsd: a 120k-input-token Sonnet ceiling prices around $0.36', Math.abs(capUsd - 0.36) < 0.01, String(capUsd));
}

/* ============================================================ 5. $/question cost report */

{
  const report = routeCostReport({
    route: 'analytics-planner', model: 'claude-haiku-4-5',
    usage: { inputTokens: 500, outputTokens: 50, cacheReadInputTokens: 4000, cacheCreationInputTokens: 0 },
  });
  check('routeCostReport: names the route and model back', report.route === 'analytics-planner' && report.model === 'claude-haiku-4-5');
  check('routeCostReport: cost_usd is positive and small for a tiny planner call', report.cost_usd > 0 && report.cost_usd < 0.01, String(report.cost_usd));
  check('routeCostReport: cache_read_share reflects the cache-heavy call', report.cache_read_share > 0.8, String(report.cache_read_share));
}
{
  const emptyReport = routeCostReport({ route: 'x', model: 'claude-haiku-4-5' });
  check('routeCostReport: no usage at all -> zeros, never NaN/throws', emptyReport.cost_usd === 0 && emptyReport.cache_read_share === 0);
}

/* ============================================================ 6. prompt caching wiring
 *
 * Honest finding, not assumed: the analytics planner's DEFAULT prompt (no learned few-shot, no
 * tenant-vocab match) is genuinely too small to clear Haiku's real 4096-token cache minimum — tool
 * schema (~740 est. tokens) + base system prompt (~1200 est. tokens) is well under it. That is NOT a
 * bug in the wiring; promptCache.js's whole design is "never attach a breakpoint below the minimum" —
 * this section proves BOTH regimes: the wiring correctly does nothing (byte-identical request, no
 * wasted breakpoint) at today's default size, AND correctly activates once vocabLines/an overlay's
 * approved few-shot push the combined prefix past the minimum (a realistic shape for a tenant with a
 * healthy learned-examples set — see buildAnalyticsSystemPrompt's own 12-item/500-token learned-few-shot
 * budget, which alone cannot cross ~2150 more tokens, so this also folds in vocabLines, exactly as
 * routes/analytics.js's own call already does). */

{
  const basePrompt = buildAnalyticsSystemPrompt({});
  check('caching: the prompt is byte-identical to the pre-round constant (no accidental drift)', basePrompt === ANALYTICS_SYSTEM_PROMPT);
  check(
    'caching: today\'s DEFAULT prompt is below Haiku\'s cache minimum — wiring correctly no-ops, not a bug',
    estimateTokens(basePrompt) < minTokensFor(ANALYTICS_MODEL),
    `estimated ${estimateTokens(basePrompt)} tokens (need >= ${minTokensFor(ANALYTICS_MODEL)} to cache at all)`
  );
  check('caching: cacheable() agrees the default prompt alone is not cacheable', cacheable(basePrompt, ANALYTICS_MODEL) === false);

  const { tools: toolsSmall, system: systemSmall } = planCacheBreakpoints(
    {
      tools: [{ block: ANALYTICS_TOOL, breakpoint: true }],
      system: [{ block: { type: 'text', text: basePrompt }, breakpoint: true }],
    },
    ANALYTICS_MODEL
  );
  check('caching: tools array shape is preserved even when no breakpoint fires', toolsSmall.length === 1 && toolsSmall[0].name === 'analytics_plan');
  check(
    'caching: below the minimum, no cache_control is attached anywhere (a byte-identical request)',
    ![...toolsSmall, ...systemSmall].some((b) => b?.cache_control)
  );

  // Now with a realistic amount of tenant-vocab/schema-linking text folded in (the SAME `vocabLines`
  // parameter routes/analytics.js's own call already threads through) — enough to cross the minimum.
  const bigVocabLines = Array.from({ length: 500 }, (_, i) => `Brand${i} Model${i}-XL${i} City${i}`).join('; ');
  const bigPrompt = buildAnalyticsSystemPrompt({ vocabLines: bigVocabLines });
  // Cumulative order (planCacheBreakpoints bills tools, then system): the tool schema's own ~740
  // estimated tokens count toward the SAME running total, so the system prompt alone need not clear
  // the minimum by itself — only tools+system together must.
  check(
    'caching: tool schema + system prompt + a realistic tenant-vocab block clear the cache minimum together',
    estimateTokens({ ...ANALYTICS_TOOL, cache_control: undefined }) + estimateTokens(bigPrompt) >= minTokensFor(ANALYTICS_MODEL),
    `estimated ${estimateTokens(bigPrompt)} system tokens`
  );
  const { tools, system } = planCacheBreakpoints(
    {
      tools: [{ block: ANALYTICS_TOOL, breakpoint: true }],
      system: [{ block: { type: 'text', text: bigPrompt }, breakpoint: true }],
    },
    ANALYTICS_MODEL
  );
  check('caching: once large enough, the system block DOES get a real cache_control breakpoint', system[0]?.cache_control?.type === 'ephemeral');
  check('caching: tools array shape is still preserved (no block dropped/reordered)', tools.length === 1 && tools[0].name === 'analytics_plan');
}

/* ============================================================ 7. the actual hook (task 1): runAnalyticsQuestion's
 * call site must pass withTenant/ctxArg through to planAnalyticsQuestion, or this whole file's cap is
 * permanently skipped in production (assertDailySpend fails open with no tenant context — see its own
 * doc comment). No DB/model call needed to prove the WIRING itself: a static read of the source is
 * enough, and is exactly what would have caught this hook sitting unwired before this round. */
{
  const src = readFileSync(new URL('../api/_lib/routes/analytics.js', import.meta.url), 'utf8');
  const wired = /const plan = await planAnalyticsQuestion\(question_n,\s*\{[^}]*\bwithTenant\b[^}]*\bctxArg\b[^}]*\}\)/.test(src);
  check('wiring: runAnalyticsQuestion passes withTenant/ctxArg into planAnalyticsQuestion (spend cap is live)', wired);
}

console.log('');
console.log(failures ? `${failures} check(s) FAILED.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
