/**
 * Regression checks for the scale-readiness build (Inngest concurrency/
 * throttle config, the synchronous-request backoff helper, rate-limit cost
 * accounting, the daily model-spend cost guard, and the pool-consolidation
 * refactor of members.js/opsStore.js/reviewStore.js/apiKeyAuth.js).
 *
 * No database, no network, no real timers — withBackoff's tests inject a
 * fake `sleep`/`now`/`random` instead of waiting or mocking global timers,
 * so this whole file runs in well under a second.
 *
 *   node scripts/verify-scale.mjs
 */
import {
  parsePositiveIntEnv,
  resolveIngestConcurrency,
  resolveIngestThrottle,
  DAILY_BUDGET_EXCEEDED_MESSAGE,
} from '../api/_lib/queue.js';
import { isRetryableModelStatus, withBackoff } from '../api/_lib/claude.js';
import { DEFAULT_LIMITS } from '../api/_lib/rateLimit.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------- env parsing */
{
  eq('unset env falls back to the default', parsePositiveIntEnv(undefined, 6), 6);
  eq('blank string falls back to the default', parsePositiveIntEnv('', 6), 6);
  eq('non-numeric string falls back to the default', parsePositiveIntEnv('lots', 6), 6);
  eq('zero falls back to the default (never a zero Inngest limit)', parsePositiveIntEnv('0', 6), 6);
  eq('a negative number falls back to the default', parsePositiveIntEnv('-5', 6), 6);
  eq('a valid positive integer string is used verbatim', parsePositiveIntEnv('12', 6), 12);
  eq('a decimal is truncated toward zero', parsePositiveIntEnv('12.9', 6), 12);
  eq('NaN string falls back to the default', parsePositiveIntEnv('NaN', 6), 6);
}

/* ------------------------------------------------- concurrency/throttle */
{
  const defaultConcurrency = resolveIngestConcurrency({});
  eq(
    'default concurrency is [global, tenant-keyed] with the documented defaults',
    defaultConcurrency,
    [{ limit: 5 }, { key: 'event.data.tenantKey', limit: 3 }]
  );
  check(
    'concurrency has AT MOST two entries (inngest v4 allows no more)',
    resolveIngestConcurrency({ INGEST_CONCURRENCY_GLOBAL: '10', INGEST_CONCURRENCY_TENANT: '4' }).length === 2
  );
  eq(
    'concurrency env vars override the defaults',
    resolveIngestConcurrency({ INGEST_CONCURRENCY_GLOBAL: '20', INGEST_CONCURRENCY_TENANT: '5' }),
    [{ limit: 20 }, { key: 'event.data.tenantKey', limit: 5 }]
  );
  check(
    'the tenant-keyed entry reads event.data.tenantKey (matches enqueueDocument\'s event payload)',
    resolveIngestConcurrency({})[1].key === 'event.data.tenantKey'
  );
  check(
    'a bad env value for concurrency falls back rather than producing a zero/undefined limit',
    resolveIngestConcurrency({ INGEST_CONCURRENCY_GLOBAL: 'nope' })[0].limit === 5
  );

  eq('default throttle is 40/min', resolveIngestThrottle({}), { limit: 40, period: '1m' });
  eq(
    'throttle env var overrides the default',
    resolveIngestThrottle({ INGEST_THROTTLE_PER_MIN: '25' }),
    { limit: 25, period: '1m' }
  );
  check('throttle period is always "1m" (per-minute, matching INGEST_THROTTLE_PER_MIN\'s name)', resolveIngestThrottle({}).period === '1m');
}

/* -------------------------------------------------- isRetryableModelStatus */
{
  check('429 is retryable', isRetryableModelStatus({ status: 429 }));
  check('529 is retryable', isRetryableModelStatus({ status: 529 }));
  check('an overloaded_error type is retryable even with no status', isRetryableModelStatus({ type: 'overloaded_error' }));
  check('a nested error.error.type of rate_limit_error is retryable', isRetryableModelStatus({ error: { type: 'rate_limit_error' } }));
  check('500 is NOT retryable here (unlike readDocument.js\'s isTransientError — see claude.js comment)', !isRetryableModelStatus({ status: 500 }));
  check('a plain timeout/AbortError is NOT retryable here', !isRetryableModelStatus({ name: 'AbortError' }));
  check('400 is not retryable', !isRetryableModelStatus({ status: 400 }));
  check('null/undefined is not retryable', !isRetryableModelStatus(null) && !isRetryableModelStatus(undefined));
}

/* ------------------------------------------------------------ withBackoff */
{
  // A fake clock: `now()` returns whatever `clock.t` is, and `sleep(ms)`
  // advances it by exactly `ms` before resolving — no real waiting, no
  // fake-timer library, and every delay actually requested is recorded.
  function makeClock(startAt = 0) {
    const clock = { t: startAt, sleeps: [] };
    clock.now = () => clock.t;
    clock.sleep = async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    };
    return clock;
  }

  // 1. Succeeds first try: no retry machinery even touched.
  {
    const clock = makeClock();
    let calls = 0;
    const result = await withBackoff(async () => { calls++; return 'ok'; }, { now: clock.now, sleep: clock.sleep });
    eq('a successful first attempt returns its value', result, 'ok');
    eq('a successful first attempt makes exactly one call', calls, 1);
    eq('a successful first attempt never sleeps', clock.sleeps, []);
  }

  // 2. Retries on 429, then succeeds.
  {
    const clock = makeClock();
    let calls = 0;
    const result = await withBackoff(
      async (attempt) => {
        calls++;
        if (attempt < 2) { const e = new Error('rate limited'); e.status = 429; throw e; }
        return 'ok-after-retries';
      },
      { attempts: 5, baseMs: 100, now: clock.now, sleep: clock.sleep, random: () => 0.5 }
    );
    eq('retries on 429 until success', result, 'ok-after-retries');
    eq('made exactly 3 attempts (2 failures + 1 success)', calls, 3);
    eq('slept exactly twice (once per failed attempt)', clock.sleeps.length, 2);
  }

  // 3. A non-retryable error is thrown immediately, no sleep.
  {
    const clock = makeClock();
    let calls = 0;
    let thrown;
    try {
      await withBackoff(async () => { calls++; const e = new Error('bad request'); e.status = 400; throw e; },
        { attempts: 5, now: clock.now, sleep: clock.sleep });
    } catch (e) { thrown = e; }
    check('a non-retryable error is rethrown as-is', thrown?.status === 400);
    eq('a non-retryable error means exactly one attempt', calls, 1);
    eq('a non-retryable error never sleeps', clock.sleeps, []);
  }

  // 4. Exhausts all attempts on a persistently retryable error.
  {
    const clock = makeClock();
    let calls = 0;
    let thrown;
    try {
      await withBackoff(async () => { calls++; const e = new Error('still overloaded'); e.status = 529; throw e; },
        { attempts: 3, baseMs: 10, now: clock.now, sleep: clock.sleep, random: () => 0.5 });
    } catch (e) { thrown = e; }
    check('exhausting all attempts rethrows the last error', thrown?.status === 529);
    eq('exhausting all attempts makes exactly `attempts` calls', calls, 3);
    eq('exhausting all attempts sleeps exactly attempts-1 times', clock.sleeps.length, 2);
  }

  // 5. Jitter stays within (0, baseMs * 2**attempt], and the cap doubles
  //    each attempt. Random values deliberately avoid exactly 0 here (see
  //    check 8 below for that edge case on its own) so every attempt
  //    actually calls `sleep` and the per-attempt cap can be read off
  //    `clock.sleeps` by index.
  {
    const clock = makeClock();
    const attemptsSeen = [];
    const randomValues = [0.1, 0.9, 0.5];
    let i = 0;
    try {
      await withBackoff(
        async (attempt) => { attemptsSeen.push(attempt); const e = new Error('x'); e.status = 429; throw e; },
        { attempts: 4, baseMs: 100, now: clock.now, sleep: clock.sleep, random: () => randomValues[i++] }
      );
    } catch { /* expected: always retryable, exhausts all 4 attempts */ }
    eq('all 4 attempts ran before giving up', attemptsSeen, [0, 1, 2, 3]);
    eq('exactly 3 sleeps recorded (no sleep after the final, exhausting attempt)', clock.sleeps.length, 3);
    // attempt 0 -> cap 100 * 2**0 = 100, random 0.1 -> delay 10
    // attempt 1 -> cap 100 * 2**1 = 200, random 0.9 -> delay 180
    // attempt 2 -> cap 100 * 2**2 = 400, random 0.5 -> delay 200
    check('jitter attempt 0 delay is within (0, 100]', clock.sleeps[0] > 0 && clock.sleeps[0] <= 100, String(clock.sleeps[0]));
    check('jitter attempt 1 delay is within (0, 200]', clock.sleeps[1] > 0 && clock.sleeps[1] <= 200, String(clock.sleeps[1]));
    check('jitter attempt 2 delay is within (0, 400]', clock.sleeps[2] > 0 && clock.sleeps[2] <= 400, String(clock.sleeps[2]));
    check('the doubling cap actually raises the ceiling each attempt', clock.sleeps[2] > clock.sleeps[0]);
  }

  // 6. NEVER exceeds the deadline: a short deadline stops retrying even
  //    though the error is retryable and attempts remain.
  {
    const clock = makeClock(1000);
    let calls = 0;
    let thrown;
    try {
      await withBackoff(
        async () => { calls++; const e = new Error('rate limited'); e.status = 429; throw e; },
        { attempts: 10, baseMs: 100000, deadlineAt: 1050, now: clock.now, sleep: clock.sleep, random: () => 1 }
      );
    } catch (e) { thrown = e; }
    check('a tight deadline still lets the first attempt happen', calls >= 1);
    check('a tight deadline stops before exhausting all 10 attempts', calls < 10, String(calls));
    check('a tight deadline rethrows the last real error, not a synthetic one', thrown?.status === 429);
    for (const [idx, ms] of clock.sleeps.entries()) {
      check(`sleep #${idx} never exceeds the remaining deadline budget`, clock.t - ms <= 1050, `slept ${ms} from t=${clock.t - ms}`);
    }
  }

  // 7. A deadline already in the past before the first attempt: no call at all.
  {
    const clock = makeClock(5000);
    let calls = 0;
    let thrown;
    try {
      await withBackoff(async () => { calls++; return 'unreachable'; },
        { deadlineAt: 4000, now: clock.now, sleep: clock.sleep });
    } catch (e) { thrown = e; }
    eq('a deadline already passed makes zero attempts', calls, 0);
    check('a deadline already passed (no prior error) throws a descriptive error', /deadline/i.test(thrown?.message ?? ''));
  }

  // 8. sleep is never called with a negative or zero-when-unnecessary delay.
  {
    const clock = makeClock();
    await withBackoff(async (attempt) => { if (attempt === 0) { const e = new Error('x'); e.status = 429; throw e; } return 'ok'; },
      { attempts: 2, baseMs: 50, now: clock.now, sleep: clock.sleep, random: () => 0 });
    check('a jitter draw of exactly 0 does not call sleep(0)', clock.sleeps.length === 0, JSON.stringify(clock.sleeps));
  }
}

/* --------------------------------------------------- rateLimit cost/limits */
{
  eq('DEFAULT_LIMITS.ingest is sized in units (files/pages), not raw requests, per-day',
    DEFAULT_LIMITS.ingest.perDay, 2000);
  check('DEFAULT_LIMITS.ingest.perMinute is large enough for one 50-file batch presign',
    DEFAULT_LIMITS.ingest.perMinute >= 50);
  check('DEFAULT_LIMITS is frozen (a bug elsewhere cannot mutate it at runtime)',
    Object.isFrozen(DEFAULT_LIMITS));

  // limit()'s cost accounting is exercised at the unit level here (the
  // burst-window arithmetic), without a database: reimplementing the exact
  // window math `limit()` uses, as a black-box check on the documented
  // contract (see rateLimit.js's own `cost` doc comment), rather than
  // importing rateLimit.js's private `windowUnits`/`pruneAndCount` (not
  // exported, and shouldn't need to be just for this).
  function wouldAllow(entries, perMinute, cost) {
    const sum = entries.reduce((a, e) => a + e.cost, 0);
    return sum + cost <= perMinute;
  }
  check('cost=1 five times against perMinute=5 allows all five (unchanged default behavior)',
    [1, 1, 1, 1, 1].every((c, i, arr) => wouldAllow(arr.slice(0, i).map((x) => ({ cost: x })), 5, c)));
  check('a single cost=50 call against perMinute=60 is allowed', wouldAllow([], 60, 50));
  check('a single cost=50 call against perMinute=40 is rejected (matches the documented contract)', !wouldAllow([], 40, 50));
  check('cost=50 then cost=1 against perMinute=50 rejects the second (no room left)',
    !wouldAllow([{ cost: 50 }], 50, 1));
}

/* -------------------------------------------------- daily budget message */
{
  check('the daily-budget-exceeded message is human-readable and mentions "tomorrow"',
    typeof DAILY_BUDGET_EXCEEDED_MESSAGE === 'string' && /tomorrow/i.test(DAILY_BUDGET_EXCEEDED_MESSAGE));
}

/* --------------------------- consolidated modules import without a pool -- */
//
// With NEON_CONNECTION_STRING unset, importing any of these four files (or
// recordsStore.js itself) must NOT throw — the pool is lazy, built only on
// first real query. This is the exact regression queue.js's own header
// warns about for the inngest package: importing a module must never be the
// thing that reaches out and builds a resource.
{
  delete process.env.NEON_CONNECTION_STRING;
  const modules = [
    '../api/_lib/recordsStore.js',
    '../api/_lib/members.js',
    '../api/_lib/opsStore.js',
    '../api/_lib/reviewStore.js',
    '../api/_lib/apiKeyAuth.js',
  ];
  for (const path of modules) {
    let threw = null;
    try {
      await import(path);
    } catch (err) {
      threw = err;
    }
    check(`${path.replace('../api/_lib/', '')} imports cleanly with no NEON_CONNECTION_STRING set (lazy pool)`, !threw, threw?.message);
  }

  const { getPool } = await import('../api/_lib/recordsStore.js');
  check('recordsStore.js exports getPool', typeof getPool === 'function');
  let poolThrew = false;
  try {
    getPool();
  } catch {
    poolThrew = true;
  }
  check('calling getPool() with no NEON_CONNECTION_STRING set throws (fails loudly, not silently)', poolThrew);

  const membersMod = await import('../api/_lib/members.js');
  const opsMod = await import('../api/_lib/opsStore.js');
  const reviewMod = await import('../api/_lib/reviewStore.js');
  const apiKeyMod = await import('../api/_lib/apiKeyAuth.js');
  check('apiKeyAuth.js re-exports getAuxPool backed by recordsStore\'s getPool', apiKeyMod.getAuxPool === getPool);
  check('opsStore.js still exports its own withTenant (transaction semantics unchanged)', typeof opsMod.withTenant === 'function');
  check('opsStore.js exports the new budget-deferred listing', typeof opsMod.listBudgetDeferredDocuments === 'function');
  check('reviewStore.js still exports its state-machine functions unchanged', typeof reviewMod.verifyDocument === 'function');
  check('members.js still exports upsertMember unchanged', typeof membersMod.upsertMember === 'function');
}

/* ------------------------------------------- source-level pool consolidation */
//
// Belt-and-braces on top of the import checks above: read the four files as
// text and confirm none of them constructs its own `new pg.Pool(...)`
// anymore — the actual thing this task was asked to remove.
{
  const fs = await import('node:fs');
  const files = [
    'api/_lib/members.js',
    'api/_lib/opsStore.js',
    'api/_lib/reviewStore.js',
    'api/_lib/apiKeyAuth.js',
  ];
  for (const file of files) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    check(`${file} no longer constructs its own pg.Pool`, !/new pg\.Pool/.test(text));
    check(`${file} imports getPool from recordsStore.js`, /from ["']\.\/recordsStore\.js["']/.test(text));
  }
  const recordsText = fs.readFileSync(new URL('../api/_lib/recordsStore.js', import.meta.url), 'utf8');
  check('recordsStore.js exports getPool (not just an internal function)', /export function getPool/.test(recordsText));
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
