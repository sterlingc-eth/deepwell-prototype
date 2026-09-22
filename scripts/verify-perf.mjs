/**
 * Unit checks for the 2026-09-22 API latency work
 * (handoffs/API_PERF_2026-09-22.md): the TTLCache/memoAsync primitives, the
 * billing-gate cache's TTL rule ('none'/'canceled' expires fast), the
 * batched-request-context fallback condition, the rate-limit precedence
 * math now fed by that shared context instead of its own query, and a
 * static check that the endpoints this build touches don't run an
 * unbounded chain of sequential awaits before reaching their handler.
 *
 * Pure/fake-timer only — no database, no network, no real sleeps.
 *
 *   node scripts/verify-perf.mjs
 */
delete process.env.NEON_CONNECTION_STRING;
delete process.env.DW_TIMING;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTLCache, memoAsync, timingEnabled, logStage, bustTenantCaches } from '../api/_lib/perf.js';
import { isUndefinedFunctionError, TENANT_CONTEXT_TTL_MS, bustTenantCache } from '../api/_lib/recordsStore.js';
import {
  billingCacheTtlFor,
  BILLING_ROW_TTL_MS,
  BILLING_ROW_BLOCKED_TTL_MS,
  requireActiveBilling,
  _seedBillingRowForTest,
  _peekBillingRowForTest,
  _resetBillingRowCache,
} from '../api/_lib/plan.js';
import { limitsFromTenantContext, DEFAULT_LIMITS } from '../api/_lib/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------- TTLCache ---- */
{
  const c = new TTLCache(1000, 3);
  c.set('a', 1);
  eq('get() returns a live value', c.get('a'), 1);
  eq('get() on a missing key is undefined', c.get('missing'), undefined);

  c.set('b', 2, 0); // TTL 0 -> already expired
  eq('a 0ms-TTL entry is expired immediately', c.get('b'), undefined);

  // Bounded size: cap is 3; inserting a 4th distinct key must evict the
  // oldest rather than growing unbounded.
  const bounded = new TTLCache(60_000, 3);
  bounded.set('k1', 1);
  bounded.set('k2', 2);
  bounded.set('k3', 3);
  bounded.set('k4', 4);
  check('bounded cache never exceeds maxEntries', bounded.size() <= 3, `size=${bounded.size()}`);
  eq('bounded cache evicted the oldest key (k1)', bounded.get('k1'), undefined);
  eq('bounded cache kept the newest key (k4)', bounded.get('k4'), 4);

  // Re-setting an EXISTING key must never evict anything (it isn't a new entry).
  const reset = new TTLCache(60_000, 2);
  reset.set('x', 1);
  reset.set('y', 2);
  reset.set('x', 99); // update, not insert — must not evict 'y'
  eq('updating an existing key does not evict a sibling', reset.get('y'), 2);

  c.delete('a');
  eq('delete() removes the entry', c.get('a'), undefined);
}

/* ---------------------------------------------------------- memoAsync --- */
{
  const c = new TTLCache(60_000, 10);
  let calls = 0;
  const fetcher = () => {
    calls++;
    return new Promise((resolve) => setTimeout(() => resolve(`v${calls}`), 5));
  };

  const [a, b] = await Promise.all([
    memoAsync(c, 'k', fetcher, 60_000),
    memoAsync(c, 'k', fetcher, 60_000),
  ]);
  eq('concurrent memoAsync calls for the same key share one fetch', calls, 1);
  eq('both concurrent callers got the same resolved value', [a, b], ['v1', 'v1']);

  const again = await memoAsync(c, 'k', fetcher, 60_000);
  eq('a warm cache hit does not call the fetcher again', calls, 1);
  eq('warm hit returns the cached value', again, 'v1');

  // A rejected fetch must not poison the cache — the NEXT call should retry,
  // not return (or keep throwing) the same failure forever.
  const failCache = new TTLCache(60_000, 10);
  let failCalls = 0;
  const flaky = () => {
    failCalls++;
    if (failCalls === 1) return Promise.reject(new Error('transient'));
    return Promise.resolve('recovered');
  };
  let threw = false;
  try {
    await memoAsync(failCache, 'k', flaky, 60_000);
  } catch {
    threw = true;
  }
  check('memoAsync propagates the first failure', threw, '');
  const recovered = await memoAsync(failCache, 'k', flaky, 60_000);
  eq('memoAsync retries after a failure instead of caching it', recovered, 'recovered');
  eq('the retry actually re-invoked the fetcher', failCalls, 2);
}

/* ------------------------------------------------ billing cache TTL ---- */
{
  eq('an active tenant gets the normal TTL', billingCacheTtlFor({ billing_status: 'active' }), BILLING_ROW_TTL_MS);
  eq('a trialing tenant gets the normal TTL', billingCacheTtlFor({ billing_status: 'trialing' }), BILLING_ROW_TTL_MS);
  eq(
    "a 'none' tenant gets the short TTL (a gate flip must be fast)",
    billingCacheTtlFor({ billing_status: null }),
    BILLING_ROW_BLOCKED_TTL_MS
  );
  eq(
    "a 'canceled' tenant gets the short TTL",
    billingCacheTtlFor({ billing_status: 'canceled' }),
    BILLING_ROW_BLOCKED_TTL_MS
  );
  check('the short TTL is materially shorter than the normal one', BILLING_ROW_BLOCKED_TTL_MS < BILLING_ROW_TTL_MS, '');
  check('the short TTL is at most 30s (task requirement)', BILLING_ROW_BLOCKED_TTL_MS <= 30_000, '');
  check('the tenant-context cache TTL is 5 minutes', TENANT_CONTEXT_TTL_MS === 5 * 60_000, '');
}

/* ------------------------------ Reviewer NO-GO: cache-bust on webhook -- */
{
  // "cache a tenant as active -> simulate webhook cancel -> assert refused
  // immediately in-process". No live database: seeds the cache directly
  // (as getCachedBillingRow's own successful fetch would), asserts the
  // gate reads it as allowed, then calls the exact bustTenantCache() path
  // api/billing.js's webhook now calls right after billing_apply(), and
  // asserts the stale 'active' answer is GONE from the cache immediately —
  // the next real read is forced fresh instead of serving the cancellation
  // out from under itself.
  _resetBillingRowCache();
  const tenantKey = 'org_verify_perf_test';
  _seedBillingRowForTest(tenantKey, { plan: 'shop', billing_status: 'active' }, 120_000);

  const seeded = _peekBillingRowForTest(tenantKey);
  check('seeded row reads back as active before any webhook', requireActiveBilling(seeded).allowed === true, JSON.stringify(seeded));

  // The webhook only ever has the tenant's uuid (billing_tenant_by_customer()
  // returns a uuid, never a tenantKey) — bustTenantCache() must still reach
  // the entry via the same uuid<->tenantKey mapping getTenantContext()
  // would have learned in a real request. Simulated here with a bare
  // Map rather than a live getTenantContext() call, since bustTenantCaches()
  // only ever calls .get() on whatever mapping it's handed.
  const fakeUuid = '11111111-1111-1111-1111-111111111111';
  const uuidMap = new Map([[fakeUuid, tenantKey]]);
  bustTenantCaches(fakeUuid, uuidMap);

  eq('bustTenantCaches() removed the cached row immediately (in-process)', _peekBillingRowForTest(tenantKey), undefined);

  // recordsStore.js's own bustTenantCache() wrapper is the one api/billing.js
  // actually imports and calls — exercise IT directly too, not just the
  // lower-level perf.js primitive above.
  _seedBillingRowForTest(tenantKey, { plan: 'shop', billing_status: 'active' }, 120_000);
  check('re-seeded row is active again', requireActiveBilling(_peekBillingRowForTest(tenantKey)).allowed === true, '');
  bustTenantCache(tenantKey); // the tenantKey form — what every OTHER call site in this codebase has on hand
  eq("recordsStore.js's bustTenantCache(tenantKey) also busts plan.js's cache", _peekBillingRowForTest(tenantKey), undefined);

  // A tenantKey/uuid this instance never saw must be a safe no-op, not a throw.
  let threwOnUnknown = false;
  try {
    bustTenantCache('org_never_seen_before');
    bustTenantCaches(null, uuidMap);
    bustTenantCaches(undefined);
  } catch {
    threwOnUnknown = true;
  }
  check('busting an unknown/nullish tenant identifier never throws', !threwOnUnknown, '');
}

/* --------------------------------------- batched-context fallback ------ */
{
  eq('undefined_function (42883) triggers the fallback path', isUndefinedFunctionError({ code: '42883' }), true);
  eq('a different Postgres error code does NOT trigger the fallback', isUndefinedFunctionError({ code: '23505' }), false);
  eq('an error with no code does NOT trigger the fallback', isUndefinedFunctionError(new Error('boom')), false);
  eq('a nullish error does NOT trigger the fallback', isUndefinedFunctionError(null), false);
}

/* ------------------------------------------- rate-limit precedence ----- */
{
  const base = DEFAULT_LIMITS.ask;
  eq('no tenant limits at all falls back to the env/hardcoded default', limitsFromTenantContext({}, 'ask', undefined), {
    perMinute: base.perMinute,
    perDay: Math.round(3000 * 0.3), // solo's ask allowance, scaled — see scaleDailyLimitForPlan
  });

  const tenantOverride = limitsFromTenantContext({ ask: { perMinute: 5 } }, 'ask', undefined);
  eq('a per-tenant override wins over the default', tenantOverride.perMinute, 5);

  const callerWins = limitsFromTenantContext({ ask: { perMinute: 5 } }, 'ask', { perMinute: 1 });
  eq('a caller-supplied override outranks the tenant override', callerWins.perMinute, 1);
}

/* --------------------------------------------------- logStage/DW_TIMING */
{
  eq('timingEnabled() is false with DW_TIMING unset', timingEnabled(), false);
  process.env.DW_TIMING = '1';
  eq('timingEnabled() is true with DW_TIMING=1', timingEnabled(), true);

  const lines = [];
  const origLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    logStage({ t: 'test_stage', ms: 12 });
  } finally {
    console.log = origLog;
  }
  delete process.env.DW_TIMING;
  check('logStage() emits exactly one line when DW_TIMING=1', lines.length === 1, `emitted ${lines.length}`);
  if (lines[0]) {
    let parsed = null;
    try {
      parsed = JSON.parse(lines[0]);
    } catch {
      /* handled by the check below */
    }
    check('the emitted line is valid, parseable JSON', !!parsed, lines[0]);
    check('the line carries no NEON_CONNECTION_STRING-shaped value', !lines[0].includes('postgres://'), lines[0]);
  }
}

/* ---------------------------- static: bounded pre-handler await chain -- */
{
  // The three endpoints this build fully instruments (document-status.js,
  // upload-url.js, routes/notifications.js) each wrap every stage in
  // timer.time("<stage>", ...) — see each file's own comment. Counting the
  // stages that run BEFORE "handler" is exactly "how many sequential awaits
  // does this path run before reaching its own logic", with no AST parser
  // required. review.js and warranty-attention.js are NOT owned by this
  // build (see the task's file-ownership list) and carry no timer of their
  // own; their shared stages (auth, rate limit, billing gate) are still each
  // individually timed via logStage() in auth.js/rateLimit.js/plan.js — see
  // handoffs/API_PERF_2026-09-22.md for why a single combined line isn't
  // possible there without editing those two files.
  const budgets = {
    'api/document-status.js': 1, // auth only — this route has no rate limit or billing gate
    'api/upload-url.js': 3, // auth, limit, gate
    'api/_lib/routes/notifications.js': 2, // auth, limit
  };
  for (const [rel, maxStages] of Object.entries(budgets)) {
    const file = path.join(REPO_ROOT, rel);
    const src = fs.readFileSync(file, 'utf8');
    const preHandlerStages = [...src.matchAll(/timer\.time\(\s*"(auth|limit|gate)"/g)].length;
    check(`${rel}: <= ${maxStages} sequential pre-handler stage(s)`, preHandlerStages <= maxStages, `found ${preHandlerStages}`);
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
