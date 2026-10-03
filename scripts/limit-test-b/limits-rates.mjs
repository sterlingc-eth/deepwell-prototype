/**
 * TESTER B (4): rate limits (exact Nth / N+1th, window reset, refunds), daily upload/ask/read/billing caps, the daily AI budget
 * stop (model calls), fair-use safety ceiling. Date.now is virtualised (aligned to a minute start) so windows are deterministic.
 *   flock /home/claude/work/cpu.lock npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/limits-rates.mjs
 */
import path from 'node:path';
import { boot, mkReq, mkRes, quiet } from './lib.mjs';
const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, root } = h;
const imp = (p) => import(path.join(root, p));
const RL = await imp('api/_lib/rateLimit.js');

const realNow = Date.now.bind(Date);
let off = 0;
Date.now = () => realNow() + off;
/** put the virtual clock at second :01 of a fresh minute */
const align = (extraMinutes = 0) => { const t = realNow(); off = (Math.floor(t / 60000) + 1 + extraMinutes) * 60000 + 1000 - t; };
const tenantUuid = async (k) => (await RS.getTenantContext(k, k)).id;
const units = async (k, bucket, ws) => { const r = await lite.query(`SELECT units FROM rate_limit_windows WHERE tenant_id=$1 AND bucket=$2 ${ws ? 'AND window_start=$3' : ''} ORDER BY window_start DESC LIMIT 1`, ws ? [await tenantUuid(k), bucket, ws] : [await tenantUuid(k), bucket]); return r.rows[0]?.units ?? null; };
const winStart = () => new Date(RL.minuteWindowStart(Date.now())).toISOString();
const call = async (key, bucket, { user = 'user_a', cost, viaKey = false } = {}) => { const res = mkRes(); const ok = await quiet(() => RL.limit(mkReq({}), res, { tenantId: key, orgId: key, userId: user, viaKey }, bucket, undefined, cost)); return { ok, res }; };
const mk = async (key, plan) => { await newTenant(key, plan, 'active', PLAN.PLAN_LIMITS[plan]); return key; };

/* ---------------------------------------------------------------- per-minute exactness, per plan */
setFamily('per-minute');
const MIN = { read: { solo: 120, shop: 120, crew: 120, fleet: 120 }, ingest: { solo: 60, shop: 150, crew: 360, fleet: 720 } };
for (const bucket of ['read', 'ingest']) {
  for (const plan of ['solo', 'shop', 'crew', 'fleet']) {
    const N = MIN[bucket][plan]; const key = await mk(`org_rl_${bucket}_${plan}`, plan);
    align();
    let okCount = 0, firstDenied = null;
    for (let i = 1; i <= N + 1; i++) { const r = await call(key, bucket); if (r.ok) okCount++; else { firstDenied ??= i; } }
    const lastBody = (await call(key, bucket)).res;
    check(`RM:${bucket}:${plan}`, `${bucket}/${plan}: requests 1..${N} allowed, request ${N + 1} is the first refused (HTTP 429, Retry-After 1..60, per-minute scope)`, okCount === N && firstDenied === N + 1 && lastBody.statusCode === 429 && lastBody.body?.scope === 'per-minute' && Number(lastBody.headers['Retry-After']) >= 1 && Number(lastBody.headers['Retry-After']) <= 60, `ok=${okCount} firstDenied=${firstDenied} ${JSON.stringify(lastBody.body)}`);
    const u = await units(key, bucket, winStart());
    check(`RM-refund:${bucket}:${plan}`, `${bucket}/${plan}: refused requests are REFUNDED - the window total stays at exactly ${N} (a retrying client does not pin the bucket)`, u === N, `units=${u}`);
    // window reset: next minute allows again
    align(1);
    const again = await call(key, bucket);
    check(`RM-reset:${bucket}:${plan}`, `${bucket}/${plan}: first request of the next 60s window is allowed again`, again.ok === true);
  }
}
// billing: 6/min
{
  const key = await mk('org_rl_billing', 'shop'); align();
  const r = []; for (let i = 0; i < 7; i++) r.push((await call(key, 'billing')).ok);
  check('RM:billing', 'billing bucket: requests 1-6 allowed, 7th -> 429 (6 per minute)', r.slice(0, 6).every(Boolean) && r[6] === false, JSON.stringify(r));
}
// batch cost: ingest solo 60/min: a 50-file batch costs 50; second batch of 50 refused; refund leaves 50
{
  const key = await mk('org_rl_batch', 'solo'); align();
  const a = await call(key, 'ingest', { cost: 50 }); const b = await call(key, 'ingest', { cost: 50 });
  const c = await call(key, 'ingest', { cost: 10 }); const d = await call(key, 'ingest', { cost: 1 });
  check('RB1', 'ingest/solo: a 50-file batch costs 50 units; a second batch of 50 (->100>60) refused; the refund leaves the window at 50; 10 more (=60) allowed; 1 more (=61) refused', a.ok && !b.ok && b.res.statusCode === 429 && c.ok && !d.ok && (await units(key, 'ingest', winStart())) === 60, JSON.stringify([a.ok, b.ok, c.ok, d.ok, await units(key, 'ingest', winStart())]));
  const z = await call(key, 'ingest', { cost: 0 }); const nan = await call(key, 'ingest', { cost: NaN }); 
  check('RB2', 'cost 0 / NaN is treated as 1 (cannot be used to get free requests)', z.ok === false && nan.ok === false, JSON.stringify([z.ok, nan.ok]));
}
// ask: tenant bucket + per-user fairness
setFamily('ask-fairness');
{
  const key = await mk('org_rl_ask_solo', 'solo'); align();           // tenant 20/min, per user max(6, ceil(20/2)=10)
  const A = []; for (let i = 0; i < 11; i++) A.push(await call(key, 'ask', { user: 'user_a' }));
  check('RA1', 'ask/solo: ONE user gets exactly 10 questions a minute (per-user share), the 11th -> 429 scope per-user', A.slice(0, 10).every((x) => x.ok) && !A[10].ok && A[10].res.body?.scope === 'per-user', JSON.stringify(A.map((x) => x.ok)) + JSON.stringify(A[10].res.body));
  const B = []; for (let i = 0; i < 10; i++) B.push(await call(key, 'ask', { user: 'user_b' }));
  const C = await call(key, 'ask', { user: 'user_c' });
  check('RA2', 'ask/solo: a second user can still ask 10 (total 20 = tenant limit); a third user then gets 429 scope per-minute (tenant bucket)', B.every((x) => x.ok) && !C.ok && C.res.body?.scope === 'per-minute', `${JSON.stringify(B.map((x) => x.ok))} ${JSON.stringify(C.res.body)}`);
  check('RA3', 'ask/solo: refused asks are refunded from tenant and user buckets (tenant window total == 20, user_a == 10)', (await units(key, 'ask', winStart())) === 20 && (await units(key, 'ask_u:user_a', winStart())) === 10, `${await units(key, 'ask', winStart())}/${await units(key, 'ask_u:user_a', winStart())}`);
  const keyS = await mk('org_rl_ask_shop', 'shop'); align();          // tenant 40/min (x2), per user 20
  let n = 0; for (const u of ['u1', 'u2']) for (let i = 0; i < 20; i++) if ((await call(keyS, 'ask', { user: u })).ok) n++;
  const over = await call(keyS, 'ask', { user: 'u3' });
  check('RA4', 'ask/shop: scales to 40/min (2 users x 20); the 41st -> 429', n === 40 && !over.ok, `n=${n} ${JSON.stringify(over.res.body)}`);
  const keyK = await mk('org_rl_ask_key', 'fleet'); align();          // API key: no per-user bucket
  let nk = 0; for (let i = 0; i < 121; i++) if ((await call(keyK, 'ask', { user: 'key:abc', viaKey: true })).ok) nk++;
  check('RA5', 'ask/fleet via API key: 120/min tenant bucket (6x), 121st refused', nk === 120, `${nk}`);
}

/* ---------------------------------------------------------------- daily caps (counter seeded to N-1: the exact boundary) */
setFamily('per-day');
const DAY = { read: { solo: 5000 }, ingest: { solo: 2000, shop: 5000, crew: 12000, fleet: 24000 }, ask: { solo: 3000, shop: 3000, crew: 3000, fleet: 3000 }, billing: { shop: 150 } };  // NOTE: comment in rateLimit.js says billing is 60/day; scaleDailyLimitForPlan multiplies every non-ask bucket by the plan factor (shop x2.5 = 150)
const seedDay = async (key, bucket, n) => lite.query(`SELECT increment_rate_limit_window($1,$2,$3::timestamptz,$4)`, [await tenantUuid(key), RL.dailyBucketKey(bucket), RL.utcDayStartIso(Date.now()), n]);
for (const [bucket, byPlan] of Object.entries(DAY)) {
  for (const [plan, N] of Object.entries(byPlan)) {
    const key = await mk(`org_rl_day_${bucket}_${plan}`, plan); align();
    await seedDay(key, bucket, N - 1);
    const a = await call(key, bucket, { user: 'u_day' });
    align(1);
    const b = await call(key, bucket, { user: 'u_day' });
    const expectMsg = bucket === 'ask' ? /unusually high usage on your account/ : new RegExp(`Daily limit of ${N} ${bucket} units reached`);
    const text = JSON.stringify(b.res.body);
    check(`RD:${bucket}:${plan}`, `${bucket}/${plan}: request #${N} (counter at ${N - 1}) allowed, request #${N + 1} -> 429 (${bucket === 'ask' ? 'safety-limit message, no upgrade prompt' : 'per-day scope'}), Retry-After = seconds to UTC midnight`, a.ok && !b.ok && b.res.statusCode === 429 && expectMsg.test(text) && Number(b.res.headers['Retry-After']) === RL.secondsUntilUtcMidnight(Date.now()) && (bucket !== 'ask' || !/pgrade/.test(text)), `${a.ok} ${b.ok} ${text} RA=${b.res.headers['Retry-After']}`);
    const d = await units(key, RL.dailyBucketKey(bucket));
    check(`RD-refund:${bucket}:${plan}`, `${bucket}/${plan}: the refused request is refunded from the daily counter (stays at ${N})`, d === N, `${d}`);
  }
}
{
  // daily reset at UTC midnight: yesterday's window is gone; today starts at 0
  const key = await mk('org_rl_midnight', 'solo'); align();
  const yesterday = new Date(Date.parse(RL.utcDayStartIso(Date.now())) - 86_400_000).toISOString();
  await lite.query(`SELECT increment_rate_limit_window($1,$2,$3::timestamptz,$4)`, [await tenantUuid(key), RL.dailyBucketKey('read'), yesterday, 5000]);
  const a = await call(key, 'read');
  const rows = (await lite.query(`SELECT count(*)::int n FROM rate_limit_windows WHERE tenant_id=$1 AND bucket=$2`, [await tenantUuid(key), RL.dailyBucketKey('read')])).rows[0].n;
  check('RD-reset', 'daily reset: 5,000 used yesterday does not count today (first request of the new UTC day allowed, old window cleaned up)', a.ok && rows === 1, `${a.ok} windows=${rows}`);
  check('RD-seconds', 'Retry-After math: seconds until UTC midnight at 23:59:59 = 1, at 00:00:00 = 86400', RL.secondsUntilUtcMidnight(Date.UTC(2026, 9, 3, 23, 59, 59)) === 1 && RL.secondsUntilUtcMidnight(Date.UTC(2026, 9, 3, 0, 0, 0)) === 86400);
}
{
  // usage reporting counter for a refused daily request (report-only counter, never compared to a limit)
  const key = await mk('org_rl_usage', 'solo'); align(); await seedDay(key, 'read', 5000);
  const before = (await lite.query(`SELECT COALESCE(sum(requests),0)::int n FROM usage_counters WHERE tenant_id=$1`, [await tenantUuid(key)])).rows[0].n;
  const r = await call(key, 'read');
  const after = (await lite.query(`SELECT COALESCE(sum(requests),0)::int n FROM usage_counters WHERE tenant_id=$1`, [await tenantUuid(key)])).rows[0].n;
  check('RU1', 'a request refused by the DAILY cap is not counted in usage_counters.requests (reporting counter)', !r.ok && after === before, `usage_counters.requests went ${before} -> ${after} on a refused request (report-only counter; does not affect any limit)`);
}

/* ---------------------------------------------------------------- daily AI budget stop (model calls) */
setFamily('ai-budget');
{
  const today = new Date().toISOString().slice(0, 10);
  const setCalls = async (key, n) => lite.query(`SELECT increment_usage_counters($1,$2::date,0,$3,0,0)`, [await tenantUuid(key), today, n]);
  const MSG = 'Daily AI budget reached — resumes tomorrow';
  check('AB0', 'wording constant is exactly "Daily AI budget reached — resumes tomorrow"', RL.DAILY_MODEL_BUDGET_MESSAGE === MSG);
  for (const [plan, N] of [['solo', 2000], ['shop', 5000], ['crew', 12000], ['fleet', 24000]]) {
    const key = await mk(`org_ab_${plan}`, plan); await setCalls(key, N - 1);
    const s1 = await RL.getDailyModelBudgetStatus({ tenantKey: key });
    await setCalls(key, 1);
    const s2 = await RL.getDailyModelBudgetStatus({ tenantKey: key });
    let thrown = null; try { await RL.assertModelBudget({ tenantKey: key }); } catch (e) { thrown = e; }
    check(`AB:${plan}`, `${plan}: ${N - 1} model calls today -> not exceeded (limit ${N}); ${N} -> exceeded; assertModelBudget throws ModelBudgetExceededError(429, "${MSG}")`, s1.exceeded === false && s1.limit === N && s2.exceeded === true && s2.used === N && thrown?.name === 'ModelBudgetExceededError' && thrown.status === 429 && thrown.message === MSG, JSON.stringify([s1, s2, thrown?.message]));
  }
  const key = await mk('org_ab_override', 'shop'); await newTenant(key, 'shop', 'active', { ...PLAN.PLAN_LIMITS.shop, maxModelCallsPerDay: 10 });
  await setCalls(key, 9); const o1 = await RL.getDailyModelBudgetStatus({ tenantKey: key }); await setCalls(key, 1); const o2 = await RL.getDailyModelBudgetStatus({ tenantKey: key });
  check('AB:override', 'an owner override tenants.limits.maxModelCallsPerDay=10 wins over the plan default: 9 ok, 10 exceeded', !o1.exceeded && o2.exceeded && o2.limit === 10, JSON.stringify([o1, o2]));
  const res = mkRes(); RL.sendModelBudgetExceeded(res, new RL.ModelBudgetExceededError());
  check('AB:http', 'sendModelBudgetExceeded -> HTTP 429 + Retry-After (seconds to UTC midnight) + the exact message', res.statusCode === 429 && res.body.error === MSG && Number(res.headers['Retry-After']) >= 1 && Number(res.headers['Retry-After']) <= 86400, JSON.stringify([res.statusCode, res.body, res.headers]));
  // yesterday's calls do not count today
  const k2 = await mk('org_ab_yesterday', 'solo'); const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await lite.query(`SELECT increment_usage_counters($1,$2::date,0,$3,0,0)`, [await tenantUuid(k2), y, 5000]);
  check('AB:reset', 'daily AI budget resets on the UTC date: 5,000 calls dated yesterday do not stop today', (await RL.getDailyModelBudgetStatus({ tenantKey: k2 })).exceeded === false);
}

/* ---------------------------------------------------------------- fair-use safety ceiling (hidden Donovan limit) */
setFamily('fair-use');
{
  const P = PLAN;
  const t = { plan: 'shop', billing_status: 'active', limits: {} };
  const g = (n, env = {}) => P.gateAsk(t, { documentsStored: 5, asksThisMonth: n }, new Date(), env);
  check('FU1', 'monthly safety ceiling 30,000: 29,999 asked -> allowed; 30,000 asked -> blocked 429 "Donovan is seeing unusually high usage on your account. Please contact support@deepwelltechnology.com and we\'ll get you sorted out." (no upgrade prompt)', g(29_999).allowed === true && g(30_000).allowed === false && g(30_000).status === 429 && g(30_000).error === "Donovan is seeing unusually high usage on your account. Please contact support@deepwelltechnology.com and we'll get you sorted out." && !/pgrade/.test(g(30_000).error), JSON.stringify(g(30_000)));
  check('FU2', 'the ceiling is identical on every plan (solo/shop/crew/fleet all 30,000 per month, 3,000 per day) - no plan allowance', ['solo', 'shop', 'crew', 'fleet'].every((pl) => P.gateAsk({ plan: pl, billing_status: 'active', limits: {} }, { asksThisMonth: 29_999 }).allowed && !P.gateAsk({ plan: pl, billing_status: 'active', limits: {} }, { asksThisMonth: 30_000 }).allowed) && P.DONOVAN_SAFETY.perDay === 3000 && P.DONOVAN_SAFETY.perMonth === 30000);
  check('FU3', 'env DONOVAN_SAFETY_ASKS_PER_MONTH override honoured; garbage/0/negative falls back to 30,000', P.donovanSafetyPerMonth({ DONOVAN_SAFETY_ASKS_PER_MONTH: '100' }) === 100 && P.donovanSafetyPerMonth({ DONOVAN_SAFETY_ASKS_PER_MONTH: '0' }) === 30000 && P.donovanSafetyPerMonth({ DONOVAN_SAFETY_ASKS_PER_MONTH: '-1' }) === 30000 && P.donovanSafetyPerMonth({ DONOVAN_SAFETY_ASKS_PER_MONTH: 'x' }) === 30000);
  // month counter helper: asks are counted per UTC month and reset on the 1st
  const U = await imp('api/_lib/usage.js');
  const key = await mk('org_fu_month', 'shop');
  await RS.withTenant({ tenantKey: key, tenantName: key }, async (db) => { await U.incrementAsksThisMonth(db); await U.incrementAsksThisMonth(db); });
  const n1 = await RS.withTenant({ tenantKey: key, tenantName: key }, (db) => U.getAsksThisMonth(db));
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1, 0, 0, 1));
  const n2 = await RS.withTenant({ tenantKey: key, tenantName: key }, (db) => U.getAsksThisMonth(db, nextMonth));
  check('FU4', 'asks-this-month counts 2 asks, and reads 0 in the first second of next UTC month (monthly reset)', n1 === 2 && n2 === 0, `${n1}/${n2}`);
}
Date.now = realNow;
finish();
