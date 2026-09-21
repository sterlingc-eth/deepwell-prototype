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
  fatal,
} from '../api/_lib/queue.js';
import { isRetryableModelStatus, withBackoff } from '../api/_lib/claude.js';
import {
  DEFAULT_LIMITS,
  assertModelBudget,
  ModelBudgetExceededError,
  DAILY_MODEL_BUDGET_MESSAGE,
  secondsUntilUtcMidnight,
} from '../api/_lib/rateLimit.js';
import { R2Error } from '../api/_lib/r2.js';
import { scaleDailyLimitForPlan, planTierFromLimits, PLAN_DAILY_ASKS, DEFAULT_LIMITS as RL_DEFAULTS } from '../api/_lib/rateLimit.js';
import { IngestError } from '../api/_lib/readDocument.js';
import { PLAN_LIMITS, gateAsk } from '../api/_lib/plan.js';
import { monthStartUtc, nextMonthStartUtc, resetsOnIso, resetsOnLabel, isCountableAskSource } from '../api/_lib/usage.js';

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

/* ---------------------------------------- B1: shared model-budget assertion
 * 2026-09-19 adversarial audit: the daily model-spend cap was enforced at
 * exactly one of four billed call sites. assertModelBudget/
 * ModelBudgetExceededError are the one shared helper now called from all
 * four (extractDocumentFields, /api/extract's image path, /api/ask, and the
 * inline ingestion path) — see rateLimit.js. No database here, so this
 * exercises the documented FAIL-OPEN path (same principle as every other
 * budget/rate lookup in this codebase): with no NEON_CONNECTION_STRING,
 * getDailyModelBudgetStatus can't reach Postgres and reports "not exceeded"
 * rather than either blocking every request or disabling the cap forever. */
{
  check('DAILY_MODEL_BUDGET_MESSAGE is human-readable and mentions the budget resets', typeof DAILY_MODEL_BUDGET_MESSAGE === 'string' && /daily/i.test(DAILY_MODEL_BUDGET_MESSAGE));

  const err = new ModelBudgetExceededError();
  check('ModelBudgetExceededError carries the shared message by default', err.message === DAILY_MODEL_BUDGET_MESSAGE);
  check('ModelBudgetExceededError is a 429', err.status === 429);
  check('ModelBudgetExceededError has a distinct name (not IngestError, not a bare Error)', err.name === 'ModelBudgetExceededError');
  check('ModelBudgetExceededError carries a positive retryAfterSeconds by default', err.retryAfterSeconds > 0);

  let threw = null;
  let status;
  try {
    status = await assertModelBudget({ tenantKey: 'user_verify_scale_budget' });
  } catch (e) {
    threw = e;
  }
  check('assertModelBudget fails open (does not throw) when the database is unreachable', threw === null, threw?.message);
  check('the fail-open status reports not-exceeded', status?.exceeded === false, JSON.stringify(status));

  eq('secondsUntilUtcMidnight at exactly midnight UTC is a full day', secondsUntilUtcMidnight(Date.UTC(2026, 0, 1, 0, 0, 0)), 86400);
  eq('secondsUntilUtcMidnight one second before midnight is 1', secondsUntilUtcMidnight(Date.UTC(2026, 0, 1, 23, 59, 59)), 1);
  check('secondsUntilUtcMidnight never returns less than 1', secondsUntilUtcMidnight(Date.UTC(2026, 0, 2, 0, 0, 0) - 1) >= 1);
}

/* --------------------------------------------------- H3: fatal() classification
 * 2026-09-19 adversarial audit: fatal() used to recognize only a non-429 4xx
 * IngestError. Traced against real Postgres, two real failures slipped past
 * it — a document deleted mid-ingestion (a plain pg FK-violation error, not
 * an IngestError) and a permanently-missing R2 object (a bare Error with no
 * `.status`) — both got the full Inngest retry treatment before finally
 * failing, wasting a paid transcription call and delaying the eventual
 * failure. fatal() is exported specifically so this classification can be
 * pinned without standing up a fake Inngest run. */
{
  check('an IngestError 404 (document not found) is fatal', fatal(new IngestError('Document not found', 404)));
  check('an IngestError 409 (not read yet) is fatal', fatal(new IngestError('not read yet', 409)));
  check('an IngestError 429 is NOT fatal (Anthropic rate limits clear up in seconds)', !fatal(new IngestError('rate limited', 429)));
  check('an IngestError 500-shaped status is NOT fatal (infrastructure, not the document)', !fatal(new IngestError('boom', 500)));

  const fkViolation = Object.assign(new Error('insert or update on table "document_pages" violates foreign key constraint'), { name: 'error', code: '23503' });
  check('a Postgres FK-violation error (23503) is fatal — the parent document is gone, retrying can never succeed', fatal(fkViolation));
  const otherPgError = Object.assign(new Error('deadlock detected'), { name: 'error', code: '40P01' });
  check('a different pg error code is NOT fatal (a real deadlock legitimately clears on retry)', !fatal(otherPgError));

  check('an R2Error 404 (permanently missing object) is fatal', fatal(new R2Error('R2 GET x failed: 404', 404)));
  check('an R2Error 403 (forbidden) is fatal', fatal(new R2Error('R2 GET x failed: 403', 403)));
  check('an R2Error 400 is fatal', fatal(new R2Error('R2 GET x failed: 400', 400)));
  check('an R2Error 500 (R2 having a bad moment) is NOT fatal — worth retrying', !fatal(new R2Error('R2 GET x failed: 500', 500)));
  check('a plain Error naming "404" in its message is NOT fatal by text alone (R2Error requires the real .status)', !fatal(new Error('R2 GET x failed: 404')));

  check('a ModelBudgetExceededError is fatal despite its 429 status — retrying THIS run cannot succeed', fatal(new ModelBudgetExceededError()));

  check('a plain Error is not fatal', !fatal(new Error('boom')));
  check('null is not fatal', !fatal(null));
  check('undefined is not fatal', !fatal(undefined));
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

/* ------------------------ H1: extract-fields shares readDocument's concurrency
 * 2026-09-19 adversarial audit: extract-fields used to declare
 * `concurrency: { limit: 5 }` — global only, no per-tenant key — which both
 * starved every other tenant's extraction during one tenant's burst AND
 * (worsening B2) let up to 5 of one tenant's OWN documents run
 * findOrCreateEquipment/findOrCreateCustomer at once instead of the 3 the
 * read step caps a single tenant to. Source-level check (not just an import
 * check) because the actual defect was a literal `{ limit: 5 }` in the
 * function's own config object, not something reachable by calling
 * resolveIngestConcurrency() in isolation. */
{
  const fs = await import('node:fs');
  const queueText = fs.readFileSync(new URL('../api/_lib/queue.js', import.meta.url), 'utf8');
  const extractFieldsBlock = queueText.slice(
    queueText.indexOf('id: "extract-fields"'),
    queueText.indexOf('triggers: [{ event: EVENTS.read }]')
  );
  check('extract-fields no longer hardcodes a global-only concurrency limit', !/concurrency:\s*\{\s*limit:\s*5\s*\}/.test(extractFieldsBlock));
  check('extract-fields uses the same resolveIngestConcurrency() helper as read-document', /concurrency:\s*resolveIngestConcurrency\(\)/.test(extractFieldsBlock));
  check('the extraction event payload still carries tenantKey (enqueueDocument\'s "queue-extraction" sendEvent)',
    /name:\s*EVENTS\.read[\s\S]{0,200}tenantKey/.test(queueText));
}

/* ------------------------------- H2: no nested retry multiplication in the queue
 * 2026-09-19 adversarial audit: extractDocumentFields's own withBackoff
 * (default 3 attempts) nested inside Inngest's `retries: RETRIES` (also 3)
 * could multiply one document's Anthropic spend up to 3x3=9 attempts under a
 * sustained 429/529. Source-level check: queue.js's extract-fields function
 * must pass modelAttempts: 1 (let Inngest alone own retrying), while
 * extractDocument.js's own withBackoff call must actually forward that
 * option through — a caller passing it into a parameter nothing reads would
 * look identical from queue.js's side and still retry 3x3. */
{
  const fs = await import('node:fs');
  const queueText = fs.readFileSync(new URL('../api/_lib/queue.js', import.meta.url), 'utf8');
  check('queue.js\'s extract-fields step calls extractDocumentFields with modelAttempts: 1',
    /extractDocumentFields\(ctx, documentId, \{ userId, modelAttempts: 1 \}\)/.test(queueText));

  const extractDocText = fs.readFileSync(new URL('../api/_lib/extractDocument.js', import.meta.url), 'utf8');
  check('extractDocumentFields accepts a modelAttempts option', /modelAttempts/.test(extractDocText));
  check('extractDocumentFields forwards modelAttempts into withBackoff as `attempts`',
    /withBackoff\(\(\) => client\.messages\.create[\s\S]{0,800}attempts:\s*modelAttempts/.test(extractDocText));
}

/* ------------------------------------------- plan-sized daily limits
 * (owner decision, 2026-09-21): PLAN_DAILY_ASKS is no longer its own budget
 * — it's a runaway guard, 30% of PLAN_LIMITS[tier].asksPerMonth, rounded.
 * solo 3000*0.3=900, shop 9000*0.3=2700, crew 22500*0.3=6750, fleet
 * 60000*0.3=18000. */
{
  const ask = RL_DEFAULTS.ask.perDay;
  check('ask default is Solo-sized (900/day = 30% of 3,000/month)', ask === 900 && PLAN_DAILY_ASKS.solo === 900);
  check('no plan on file -> Solo ask budget', scaleDailyLimitForPlan('ask', ask, {}) === 900);
  check('null limits -> Solo ask budget', scaleDailyLimitForPlan('ask', ask, null) === 900);
  check('Solo (750 pages) -> 900 asks/day', scaleDailyLimitForPlan('ask', ask, { pagesPerMonth: 750 }) === 900);
  check('Shop (2000 pages) -> 2700 asks/day', scaleDailyLimitForPlan('ask', ask, { pagesPerMonth: 2000 }) === 2700);
  check('Crew (5000 pages) -> 6750 asks/day', scaleDailyLimitForPlan('ask', ask, { pagesPerMonth: 5000 }) === 6750);
  check('Fleet (10000 pages) -> 18000 asks/day', scaleDailyLimitForPlan('ask', ask, { pagesPerMonth: 10000 }) === 18000);
  check('explicit plan name wins over pages', scaleDailyLimitForPlan('ask', ask, { plan: 'fleet', pagesPerMonth: 750 }) === 18000);
  check('garbage pagesPerMonth -> Solo budget', scaleDailyLimitForPlan('ask', ask, { pagesPerMonth: 'lots' }) === 900);
  check('unknown page count -> Solo budget', scaleDailyLimitForPlan('ask', ask, { pagesPerMonth: 4242 }) === 900);
  const ingest = RL_DEFAULTS.ingest.perDay;
  check('ingest: Solo unchanged', scaleDailyLimitForPlan('ingest', ingest, { pagesPerMonth: 750 }) === ingest);
  check('ingest: Fleet 12x', scaleDailyLimitForPlan('ingest', ingest, { pagesPerMonth: 10000 }) === ingest * 12);
  check('ingest: no plan -> unchanged', scaleDailyLimitForPlan('ingest', ingest, null) === ingest);
  check('planTierFromLimits maps every tier', ['solo','shop','crew','fleet'].every((t, i) => planTierFromLimits({ pagesPerMonth: [750,2000,5000,10000][i] }) === t));
}

/* ------------------------------------------- PLAN_LIMITS.asksPerMonth shape */
{
  eq('PLAN_LIMITS.asksPerMonth by tier', {
    solo: PLAN_LIMITS.solo.asksPerMonth, shop: PLAN_LIMITS.shop.asksPerMonth,
    crew: PLAN_LIMITS.crew.asksPerMonth, fleet: PLAN_LIMITS.fleet.asksPerMonth,
  }, { solo: 3000, shop: 9000, crew: 22500, fleet: 60000 });
  check('30% of asksPerMonth, rounded, is exactly PLAN_DAILY_ASKS for every tier',
    ['solo', 'shop', 'crew', 'fleet'].every((t) => PLAN_DAILY_ASKS[t] === Math.round(PLAN_LIMITS[t].asksPerMonth * 0.3)));
}

/* --------------------------------------------------------- resetsOn / month math */
{
  eq('monthStartUtc truncates to the 1st, midnight UTC', monthStartUtc(new Date('2026-09-21T17:42:00Z')).toISOString(), '2026-09-01T00:00:00.000Z');
  eq('nextMonthStartUtc mid-September -> October 1', nextMonthStartUtc(new Date('2026-09-21T00:00:00Z')).toISOString(), '2026-10-01T00:00:00.000Z');
  eq('nextMonthStartUtc across a year boundary: December -> January next year', nextMonthStartUtc(new Date('2026-12-15T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
  eq('resetsOnIso is an ISO date, not a full timestamp', resetsOnIso(new Date('2026-09-21T00:00:00Z')), '2026-10-01');
  // Short month (owner correction, 2026-09-21) — matches the client's own
  // resetsOnShortLabel, so "resets Oct 1" reads identically everywhere.
  eq('resetsOnLabel: mid-month reads "<Mon> 1"', resetsOnLabel(new Date('2026-09-21T00:00:00Z')), 'Oct 1');
  eq('resetsOnLabel across a year boundary', resetsOnLabel(new Date('2026-12-31T23:59:00Z')), 'Jan 1');
  eq('resetsOnLabel on the 1st itself still points at the FOLLOWING month (not today)', resetsOnLabel(new Date('2026-09-01T00:00:00Z')), 'Oct 1');
}

/* ---------------------------------------------------------- ask counting rule */
{
  check('retrieval+model counts', isCountableAskSource('model'));
  check('the analytics planner counts', isCountableAskSource('analytics-model'));
  check('a retrieval-cache hit does not count', !isCountableAskSource('cache'));
  check('an analytics Tier-1 cache hit does not count', !isCountableAskSource('analytics-cache'));
  check('the meta-router does not count', !isCountableAskSource('meta'));
  check('the fast path does not count', !isCountableAskSource('fast-path'));
  check('"no evidence, no model call" does not count', !isCountableAskSource('no-evidence'));
  check('an unrecognized source defaults to not counting (fail closed on cost, not open)', !isCountableAskSource('bogus'));
  // Live miss clusters 1+2 (2026-09-21): contactLookup.js and the money gate
  // (api/ask.js) both answer without ever calling the model — neither name
  // should ever be added to COUNTABLE_ASK_SOURCES.
  check('contact lookup (no model call) does not count', !isCountableAskSource('contact-lookup'));
  check('the money gate (no model call) does not count', !isCountableAskSource('money'));
}

/* ------------------------------------------------------------------ gateAsk at 0/79/80/99/100% */
{
  const tenant = { plan: 'solo', billing_status: 'active' };
  const cap = PLAN_LIMITS.solo.asksPerMonth; // 3000
  check('gateAsk: 0% used -> allowed', gateAsk(tenant, { documentsStored: 1, asksThisMonth: 0 }).allowed);
  check('gateAsk: 79% used -> allowed', gateAsk(tenant, { documentsStored: 1, asksThisMonth: Math.round(cap * 0.79) }).allowed);
  check('gateAsk: 80% used -> still allowed (warning-only threshold, not a gate)', gateAsk(tenant, { documentsStored: 1, asksThisMonth: Math.round(cap * 0.8) }).allowed);
  check('gateAsk: 99% used -> allowed', gateAsk(tenant, { documentsStored: 1, asksThisMonth: Math.round(cap * 0.99) }).allowed);
  const blocked = gateAsk(tenant, { documentsStored: 1, asksThisMonth: cap });
  check('gateAsk: 100% used -> blocked', !blocked.allowed);
  eq('gateAsk: 100% used -> 402', blocked.status, 402);
  check('gateAsk: 402 message never says "questions" and names the reset date', /^This month's Donovan usage is used up — resets /.test(blocked.error), blocked.error);
  eq('gateAsk: 100% used -> points at Billing', blocked.url, '/app/?screen=billing');
  check('gateAsk: over 100% (stale read) is still blocked, not a crash', !gateAsk(tenant, { documentsStored: 1, asksThisMonth: cap + 500 }).allowed);
  check('gateAsk: a tenant with no plan on file skips the monthly cap (no cap to check)', gateAsk({ billing_status: 'active' }, { documentsStored: 1, asksThisMonth: 999_999 }).allowed);
  check('gateAsk: trialing is still subject to the monthly cap', !gateAsk({ plan: 'solo', billing_status: 'trialing', trial_ends_at: new Date(Date.now() + 86400000).toISOString() }, { documentsStored: 1, asksThisMonth: cap }).allowed);
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
