/**
 * TESTER B (5): billing states (trial / active / payment failed in grace / after grace / canceled / no plan) - what the code allows
 * and blocks - compared with the help KB (docs/help -> api/_lib/support/kb.generated.js) and the website (index.html). Stripe is
 * mocked: webhooks are TEST-SIGNED payloads (HMAC with a fixture secret) through the real /api/billing?action=webhook handler.
 *   flock /home/claude/work/cpu.lock npx tsx --import ./scripts/limit-test-b/register.mjs scripts/limit-test-b/limits-billing.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { boot, adminTok, memberTok, mkReq, mkRes, quiet } from './lib.mjs';
const { h, check, setFamily, finish } = await boot();
const { lite, RS, PLAN, newTenant, rnd, root, resetCaches } = h;
const imp = (p) => import(path.join(root, p));
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture_not_real';
const BILLING_MOD = await imp('api/billing.js');
const BILLING = BILLING_MOD.default;
const BILLING_BLOCK = (status, plan = 'shop') => BILLING_MOD.checkoutBlockedByLiveSubscription(plan, { billing_status: status });
const BL = await imp('api/_lib/billing.js');
const UP = (await imp('api/upload-url.js')).default;
const UPM = await imp('api/upload-url.js');
const ASK = (await imp('api/ask.js')).default;
const RD = (await imp('api/read-document.js')).default;
const EXTRACT = (await imp('api/extract.js')).default;
const REVIEW = (await imp('api/review.js')).default;
const ACCOUNT = (await imp('api/account.js')).default;
const V1 = (await imp('api/v1.js')).default;
const RECORDS = (await imp('api/records.ts')).default;
const SEATS = await imp('api/_lib/seats.js');
const DAY = 86_400_000;
const sha = () => crypto.randomBytes(32).toString('hex');
const now = () => Date.now();

/* ---------------------------------------------------------------- A. exact boundaries of the pure state machine */
setFamily('state-machine');
{
  const T0 = new Date('2026-10-03T12:00:00.000Z');
  const trial = (endMs) => ({ billing_status: 'trialing', trial_ends_at: new Date(endMs).toISOString() });
  const at = (ms) => new Date(T0.getTime() + ms);
  check('B1', 'trialing, ends in the future -> trialing', PLAN.planStateFor(trial(T0.getTime() + DAY), T0) === 'trialing');
  check('B2', 'trial end boundary: at trial_ends_at exactly -> still trialing (database still says trialing)', PLAN.planStateFor(trial(T0.getTime()), T0) === 'trialing');
  check('B3', 'trial end + 47h59m59.999s -> still "trialing" (R30 M4 48-hour conversion grace)', PLAN.planStateFor(trial(T0.getTime()), at(48 * 3600e3 - 1)) === 'trialing');
  check('B4', 'trial end + exactly 48h -> still trialing (rule is strictly greater than)', PLAN.planStateFor(trial(T0.getTime()), at(48 * 3600e3)) === 'trialing');
  check('B5', 'trial end + 48h + 1ms -> "none" (blocked: Choose a plan)', PLAN.planStateFor(trial(T0.getTime()), at(48 * 3600e3 + 1)) === 'none');
  const pd = (sinceMs, extra = {}) => ({ billing_status: 'past_due', limits: { _billing: { pastDueSince: Math.floor(sinceMs / 1000) } }, ...extra });
  const since = T0.getTime();
  check('B6', 'past_due 6d23h59m59s after the first failure -> inside grace (not past grace)', PLAN.isPastGrace(pd(since), at(7 * DAY - 1000)) === false);
  check('B7', 'past_due EXACTLY 7 days after the first failure -> still inside grace (comparison is strictly >)', PLAN.isPastGrace(pd(since), at(7 * DAY)) === false);
  check('B8', 'past_due 7 days + 1 second -> past grace', PLAN.isPastGrace(pd(since), at(7 * DAY + 1000)) === true);
  check('B9', 'grace clock starts at the FIRST failure (pastDueSince), not at current_period_end of a renewed period', PLAN.isPastGrace({ billing_status: 'past_due', current_period_end: new Date(T0.getTime() + 30 * DAY).toISOString(), limits: { _billing: { pastDueSince: Math.floor(since / 1000) } } }, at(8 * DAY)) === true);
  check('B10', 'legacy past_due row with no pastDueSince falls back to current_period_end', PLAN.isPastGrace({ billing_status: 'past_due', current_period_end: new Date(since).toISOString() }, at(8 * DAY)) === true && PLAN.isPastGrace({ billing_status: 'past_due', current_period_end: new Date(since).toISOString() }, at(6 * DAY)) === false);
  check('B11', 'unknown/blank statuses collapse to none (blocked)', ['', null, undefined, 'incomplete', 'weird'].every((s) => PLAN.planStateFor({ billing_status: s }, T0) === 'none'));
  check('B12', 'Stripe status mapping: trialing->trialing, active->active, past_due+unpaid->past_due, canceled/incomplete_expired/paused->canceled, incomplete->none', [['trialing', 'trialing'], ['active', 'active'], ['past_due', 'past_due'], ['unpaid', 'past_due'], ['canceled', 'canceled'], ['incomplete_expired', 'canceled'], ['paused', 'canceled'], ['incomplete', 'none']].every(([s, w]) => BL.billingStatusFromStripeStatus(s) === w));
  check('B13', 'constants: grace 7 days, trial conversion grace 48 h, free preview 0 documents', PLAN.PAST_DUE_GRACE_DAYS === 7 && PLAN.TRIAL_END_GRACE_HOURS === 48 && PLAN.FREE_PREVIEW_DOCUMENTS === 0);
}

/* ---------------------------------------------------------------- B. webhook: test-signed payloads drive the real states */
setFamily('webhook');
const sign = (raw, secret = process.env.STRIPE_WEBHOOK_SECRET, t = Math.floor(now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex')}`;
const hook = async (event, { secret, t, tamper = false } = {}) => { const raw = JSON.stringify(event); const res = mkRes(); const req = mkReq({ query: { action: 'webhook' }, headers: { 'stripe-signature': sign(raw, secret, t) }, rawBody: tamper ? raw.replace('cus_wh', 'cus_xx') : raw }); await quiet(() => BILLING(req, res)); return res; };
const tenantRow = async (org) => (await lite.query(`SELECT billing_status, plan, trial_ends_at, trial_used, limits, stripe_subscription_id, cancel_at_period_end FROM tenants WHERE clerk_org_id=$1`, [org])).rows[0];
let evSeq = 0;
const sub = (status, over = {}) => ({ id: `evt_${++evSeq}`, type: 'customer.subscription.updated', created: Math.floor(now() / 1000) + evSeq, data: { object: { id: 'sub_wh1', customer: 'cus_wh', status, cancel_at_period_end: false, current_period_end: Math.floor(now() / 1000) + 30 * 86400, trial_end: null, items: { data: [{ price: { metadata: { plan: 'solo' }, lookup_key: 'solo_monthly' } }] }, ...over } } });
{
  const ORG = 'org_wh'; await newTenant(ORG, 'solo', 'none'); await lite.query(`UPDATE tenants SET stripe_customer_id='cus_wh', plan=NULL, billing_status=NULL WHERE clerk_org_id=$1`, [ORG]); resetCaches();
  let r = await hook(sub('trialing', { trial_end: Math.floor(now() / 1000) + 30 * 86400, id: 'sub_wh1', type: undefined }));
  const trialEv = sub('trialing', { trial_end: Math.floor(now() / 1000) + 30 * 86400 }); trialEv.type = 'customer.subscription.created';
  r = await hook(trialEv);
  let t = await tenantRow(ORG);
  check('W1', 'signed customer.subscription.created (trialing, trial_end +30d) -> tenant trialing on Solo, trial_used=true, limits = Solo table', r.statusCode === 200 && t.billing_status === 'trialing' && t.plan === 'solo' && t.trial_used === true && t.limits.logins === 2 && t.limits.pagesPerMonth === 750, `${r.statusCode} ${JSON.stringify(t)}`);
  const days = (new Date(t.trial_ends_at).getTime() - now()) / DAY;
  check('W1b', 'trial_ends_at is 30 days out (site: "30-day free trial")', days > 29.9 && days < 30.01, `${days}`);
  r = await hook(sub('active'));
  t = await tenantRow(ORG);
  check('W2', 'subscription.updated active -> active', r.statusCode === 200 && t.billing_status === 'active', JSON.stringify(t));
  const pf = { id: `evt_${++evSeq}`, type: 'invoice.payment_failed', created: Math.floor(now() / 1000) + 1000 + evSeq, data: { object: { customer: 'cus_wh', subscription: 'sub_wh1' } } };
  r = await hook(pf); t = await tenantRow(ORG);
  check('W3', 'invoice.payment_failed -> past_due and the grace clock (limits._billing.pastDueSince) is stamped with the event time', r.statusCode === 200 && t.billing_status === 'past_due' && t.limits._billing?.pastDueSince === pf.created, JSON.stringify(t));
  const pf2 = { ...pf, id: `evt_${++evSeq}`, created: pf.created + 3 * 86400 };
  await hook(pf2); t = await tenantRow(ORG);
  check('W4', 'a SECOND failed retry 3 days later does NOT restart the grace clock (still the first failure)', t.limits._billing?.pastDueSince === pf.created, JSON.stringify(t.limits._billing));
  r = await hook(pf); 
  check('W5', 'replaying the same event id -> "duplicate", no change', r.body?.reason === 'duplicate' || r.body?.handled === false, JSON.stringify(r.body));
  const paid = { id: `evt_${++evSeq}`, type: 'invoice.paid', created: pf2.created + 100, data: { object: { customer: 'cus_wh', subscription: 'sub_wh1', amount_paid: 9900 } } };
  r = await hook(paid); t = await tenantRow(ORG);
  check('W6', 'invoice.paid -> back to active and the grace clock is cleared', t.billing_status === 'active' && t.limits._billing?.pastDueSince == null, JSON.stringify(t));
  const stale = { id: `evt_${++evSeq}`, type: 'invoice.payment_failed', created: pf.created - 500, data: { object: { customer: 'cus_wh', subscription: 'sub_wh1' } } };
  r = await hook(stale); t = await tenantRow(ORG);
  check('W7', 'an OLD failed-payment event arriving late does not flip an active tenant back to past_due (ordering guard)', t.billing_status === 'active' && r.body?.reason === 'ignored', `${JSON.stringify(r.body)} ${t.billing_status}`);
  const del = { id: `evt_${++evSeq}`, type: 'customer.subscription.deleted', created: paid.created + 100, data: { object: { id: 'sub_wh1', customer: 'cus_wh', status: 'canceled' } } };
  r = await hook(del); t = await tenantRow(ORG);
  check('W8', 'customer.subscription.deleted -> canceled', t.billing_status === 'canceled', JSON.stringify(t));
  const late = { id: `evt_${++evSeq}`, type: 'invoice.payment_failed', created: del.created + 50, data: { object: { customer: 'cus_wh', subscription: 'sub_wh1' } } };
  r = await hook(late); t = await tenantRow(ORG);
  check('W9', 'a failed-payment event after cancellation does not resurrect the tenant', t.billing_status === 'canceled', JSON.stringify(t));
  const bad = await hook(sub('active'), { secret: 'whsec_wrong' });
  check('W10', 'wrong signing secret -> 400 Invalid signature, tenant unchanged', bad.statusCode === 400 && (await tenantRow(ORG)).billing_status === 'canceled', `${bad.statusCode}`);
  const old = await hook(sub('active'), { t: Math.floor(now() / 1000) - 400 });
  check('W11', 'a correctly signed payload older than 5 minutes (replay) -> 400', old.statusCode === 400, `${old.statusCode}`);
  const tam = await hook(sub('active'), { tamper: true });
  check('W12', 'a payload altered after signing -> 400', tam.statusCode === 400, `${tam.statusCode}`);
  const nosig = mkRes(); await quiet(() => BILLING(mkReq({ query: { action: 'webhook' }, rawBody: '{}' }), nosig));
  check('W13', 'no Stripe-Signature header -> 400', nosig.statusCode === 400, `${nosig.statusCode}`);
  const unk = sub('active'); unk.data.object.customer = 'cus_unknown'; const ur = await hook(unk);
  check('W14', 'unknown customer -> 200 (no retry storm), nothing applied', ur.statusCode === 200 && ur.body?.handled === false, JSON.stringify(ur.body));
  const gone = await new Promise((resolve) => { const save = process.env.STRIPE_WEBHOOK_SECRET; delete process.env.STRIPE_WEBHOOK_SECRET; hook(sub('active'), { secret: save }).then((x) => { process.env.STRIPE_WEBHOOK_SECRET = save; resolve(x); }); });
  check('W15', 'webhook secret not configured -> 503, never accepts unsigned events', gone.statusCode === 503, `${gone.statusCode}`);
  const noauth = mkRes(); await quiet(() => BILLING(mkReq({ method: 'GET', query: { action: 'webhook' } }), noauth));
  check('W16', 'GET on the webhook -> 405', noauth.statusCode === 405);
  // trial eligibility + trial length via the real checkout builder with a recording Stripe fake
  const calls = []; const fakeStripe = { prices: { list: async () => ({ data: [{ id: 'price_x' }] }) }, checkout: { sessions: { create: async (p) => { calls.push(p); return { url: 'https://checkout.invalid/x' }; } } } };
  const mkCheckout = async (plan, interval, trial_used) => { calls.length = 0; await BL.createCheckoutSession(fakeStripe, { tenantRow: { trial_used }, plan, interval, tenantId: 't', customerId: 'c', successUrl: 's', cancelUrl: 'c' }); return calls[0]; };
  const s1 = await mkCheckout('solo', 'month', false), s2 = await mkCheckout('solo', 'year', false), s3 = await mkCheckout('solo', 'month', true), s4 = await mkCheckout('shop', 'month', false), s5 = await mkCheckout('crew', 'year', false), s6 = await mkCheckout('fleet', 'month', false);
  check('T1', 'Solo, never trialed: 30-day trial, card ALWAYS collected, trial ends with no card -> cancel (site/KB: "30-day free trial, card required")', s1.subscription_data?.trial_period_days === 30 && s1.payment_method_collection === 'always' && s1.subscription_data?.trial_settings?.end_behavior?.missing_payment_method === 'cancel');
  check('T2', 'Solo annual also gets the 30-day trial when never trialed', s2.subscription_data?.trial_period_days === 30);
  check('T3', 'a second trial is refused: Solo with trial_used=true -> no trial', s3.subscription_data == null);
  check('T4', 'Team, Crew, Fleet never get a trial (KB: "Team, Crew and Fleet do not have a trial")', !s4.subscription_data && !s5.subscription_data && !s6.subscription_data);
  check('T5', 'catalog prices: Solo $99, Team $199, Crew $399, Fleet $899 monthly; annual = 11 x monthly (one month free)', [['solo', 99], ['shop', 199], ['crew', 399], ['fleet', 899]].every(([p, m]) => BL.PLAN_CATALOG[p].monthly === m && BL.annualPrice(m) === 11 * m));
  check('T6', 'a tenant with a live subscription cannot start a second one (active, trialing, past_due all blocked; canceled/none allowed; Records Rescue always allowed)', ['active', 'trialing', 'past_due'].every((s) => BILLING_BLOCK(s)) && !BILLING_BLOCK('canceled') && !BILLING_BLOCK('none') && !(BILLING_BLOCK('active', 'records_rescue')));
}

/* ---------------------------------------------------------------- C. what each state allows (real handlers, member/admin sessions) */
setFamily('state-matrix');
const states = {
  'trial (10 days left)': { status: 'trialing', plan: 'solo', trialEnd: () => new Date(now() + 10 * DAY) },
  'trial ended 47h ago (inside 48h conversion grace)': { status: 'trialing', plan: 'solo', trialEnd: () => new Date(now() - 47 * 3600e3) },
  'trial ended 49h ago (no webhook arrived)': { status: 'trialing', plan: 'solo', trialEnd: () => new Date(now() - 49 * 3600e3) },
  'active': { status: 'active', plan: 'shop' },
  'payment failed, day 3 (inside grace)': { status: 'past_due', plan: 'shop', since: () => now() - 3 * DAY },
  'payment failed, 6d23h59m (last minute of grace)': { status: 'past_due', plan: 'shop', since: () => now() - 7 * DAY + 60_000 },
  'payment failed, 7d + 1 minute (past grace)': { status: 'past_due', plan: 'shop', since: () => now() - 7 * DAY - 60_000 },
  'payment failed, day 20 (past grace)': { status: 'past_due', plan: 'shop', since: () => now() - 20 * DAY },
  'canceled': { status: 'canceled', plan: 'shop' },
  'no plan (never subscribed)': { status: null, plan: null },
};
const EXPECT = { // what the KB / site promise
  'trial (10 days left)': { upload: 'ok', ask: 'ok', read: 'ok', export: 'ok', invite: 'ok', del: 'ok', model: 'ok' },
  'trial ended 47h ago (inside 48h conversion grace)': { upload: 'ok', ask: 'ok', read: 'ok', export: 'ok', invite: 'ok', del: 'ok', model: 'ok' },
  'trial ended 49h ago (no webhook arrived)': { upload: 'block', ask: 'block', read: 'ok', export: 'ok', invite: 'block', del: 'ok', model: 'block' },
  'active': { upload: 'ok', ask: 'ok', read: 'ok', export: 'ok', invite: 'ok', del: 'ok', model: 'ok' },
  'payment failed, day 3 (inside grace)': { upload: 'ok', ask: 'ok', read: 'ok', export: 'ok', invite: 'ok', del: 'ok', model: 'ok' },
  'payment failed, 6d23h59m (last minute of grace)': { upload: 'ok', ask: 'ok', read: 'ok', export: 'ok', invite: 'ok', del: 'ok', model: 'ok' },
  'payment failed, 7d + 1 minute (past grace)': { upload: 'block', ask: 'ok', read: 'ok', export: 'ok', invite: 'ok', del: 'ok', model: 'ok' },
  'payment failed, day 20 (past grace)': { upload: 'block', ask: 'ok', read: 'ok', export: 'ok', invite: 'ok', del: 'ok', model: 'ok' },
  'canceled': { upload: 'block', ask: 'block', read: 'ok', export: 'ok', invite: 'block', del: 'ok', model: 'block' },
  'no plan (never subscribed)': { upload: 'block', ask: 'block', read: 'ok', export: 'ok', invite: 'block', del: 'ok', model: 'block' },
};
const observed = {};
let n = 0;
for (const [name, st] of Object.entries(states)) {
  const ORG = `org_bm_${++n}`;
  await newTenant(ORG, st.plan ?? 'shop', st.status ?? 'none', st.plan ? PLAN.PLAN_LIMITS[st.plan] : null);
  const id = (await RS.getTenantContext(ORG, ORG)).id;
  await lite.query(`UPDATE tenants SET billing_status=$2, plan=$3, trial_ends_at=$4, limits = $5::jsonb WHERE id=$1`, [id, st.status, st.plan, st.trialEnd ? st.trialEnd().toISOString() : null, JSON.stringify({ ...(st.plan ? PLAN.PLAN_LIMITS[st.plan] : {}), ...(st.since ? { _billing: { pastDueSince: Math.floor(st.since() / 1000) } } : {}) })]);
  // one document to delete / list (inserted straight in so it exists in every state)
  await lite.query(`INSERT INTO documents (tenant_id, original_filename, sha256_hash, file_size_bytes, content_type, storage_key, stage) VALUES ($1,'keep.txt',$2,100,'text/plain',$3,'mapped')`, [id, sha(), `${id}/k/keep`]);
  resetCaches();
  const A = adminTok(ORG), M = memberTok(ORG);
  const status = async (fn) => { const res = mkRes(); await quiet(() => fn(res)); return res; };
  const up = await status((res) => UP(mkReq({ token: M, body: { filename: 'n.txt', sha256: sha(), sizeBytes: 100, contentType: 'text/plain' } }), res));
  const ask = await status((res) => ASK(mkReq({ token: M, body: { question: 'What is the warranty on the furnace at 12 Elm Street?' } }), res));
  const rd = await status((res) => RECORDS(mkReq({ token: M, body: { action: 'listDocuments', filters: {} } }), res));
  const exp = await status((res) => V1(mkReq({ method: 'GET', token: A, query: { resource: 'export', kind: 'documents' } }), res));
  SEATS._setClerkForTest({ organizations: { getOrganization: async () => ({ createdBy: 'o' }), getOrganizationMembershipList: async () => ({ data: [] }), getOrganizationInvitationList: async () => ({ data: [] }), createOrganizationInvitation: async () => ({ id: 'inv_1' }) } });
  const invr = await status((res) => BILLING(mkReq({ token: A, query: { action: 'invite' }, body: { email: 'x@example.invalid' } }), res));
  SEATS._setClerkForTest(null);
  const rdoc = await status((res) => RD(mkReq({ token: M, body: { documentId: '00000000-0000-4000-8000-000000000009', sync: true } }), res));
  const ext = await status((res) => EXTRACT(mkReq({ token: M, body: { image: 'AAAA', mimeType: 'image/png' } }), res));
  const keepId = (await lite.query(`SELECT id FROM documents WHERE tenant_id=$1 AND original_filename='keep.txt'`, [id])).rows[0].id;
  const del = await status((res) => REVIEW(mkReq({ token: A, body: { action: 'deleteDocuments', documentIds: [keepId] } }), res));
  const verdict = (r) => (r.statusCode === 402 ? 'block' : 'ok');
  observed[name] = { upload: verdict(up), ask: verdict(ask), read: verdict(rd), export: verdict(exp), invite: verdict(invr), del: verdict(del), model: [verdict(rdoc), verdict(ext)].includes('block') ? 'block' : 'ok' };
  observed[name]._detail = { up: [up.statusCode, up.body?.error?.slice?.(0, 90)], ask: [ask.statusCode, ask.body?.error?.slice?.(0, 60)], rd: rd.statusCode, exp: exp.statusCode, inv: [invr.statusCode, invr.body?.error?.slice?.(0, 40)], rdoc: rdoc.statusCode, ext: ext.statusCode, del: del.statusCode };
  for (const act of ['upload', 'ask', 'read', 'export', 'invite', 'del', 'model']) {
    check(`BM:${name}:${act}`, `[${name}] ${act}: expected ${EXPECT[name][act]}`, observed[name][act] === EXPECT[name][act], `observed ${observed[name][act]} (${JSON.stringify(observed[name]._detail)})`);
  }
}
// messages
{
  const b = observed['payment failed, day 20 (past grace)']._detail.up;
  check('BM:msg:pastgrace', 'past-grace upload message starts "Subscription required: your last payment didn\'t go through" (KB: uploads stop with "Subscription required")', b[0] === 402 && /^Subscription required: your last payment didn't go through/.test(b[1] ?? ''), JSON.stringify(b));
  const c = observed['canceled']._detail.up;
  check('BM:msg:canceled', 'canceled / no plan upload message is exactly "Choose a plan to get started" (KB quotes it)', c[0] === 402 && c[1] === 'Choose a plan to get started' && observed['no plan (never subscribed)']._detail.up[1] === 'Choose a plan to get started', JSON.stringify([c, observed['no plan (never subscribed)']._detail.up]));
  const a = observed['canceled']._detail.ask;
  check('BM:msg:ask', 'canceled ask also returns "Choose a plan to get started" (HTTP 402)', a[0] === 402 && a[1] === 'Choose a plan to get started', JSON.stringify(a));
}
console.log('\nOBSERVED MATRIX\n' + JSON.stringify(Object.fromEntries(Object.entries(observed).map(([k, v]) => { const { _detail, ...rest } = v; return [k, rest]; })), null, 1));

/* ---------------------------------------------------------------- D. promised numbers: site (index.html) / KB / code agree? */
setFamily('promises');
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, "'").replace(/\s+/g, ' ');
  const sec = text.slice(text.indexOf('Pick your plan by team size'), text.indexOf('Included with every plan'));
  const blocks = ['Solo', 'Team', 'Crew', 'Fleet'].map((nm, i, arr) => { const s = sec.indexOf(` ${nm} `, sec.indexOf('Every plan includes')); return s; });
  const pick = (nm, label) => { const i = sec.indexOf(` ${nm} `, sec.indexOf('Every plan includes')); const seg = sec.slice(i, i + 700); const m = seg.match(new RegExp(`${label}\\s+([^A-Za-z]*[0-9][0-9,+]*[A-Za-z+]*|Unlimited)`)); return m ? m[1].trim() : null; };
  const num = (s) => (s == null ? null : /unlimited/i.test(s) ? null : Number(String(s).replace(/[^0-9]/g, '')));
  const KEY = { solo: 'Solo', shop: 'Team', crew: 'Crew', fleet: 'Fleet' };
  for (const [plan, nm] of Object.entries(KEY)) {
    const L = PLAN.PLAN_LIMITS[plan];
    const sLog = pick(nm, 'Logins up to') ?? pick(nm, 'Logins'); const sDocs = pick(nm, 'Documents stored'); const sPages = pick(nm, 'New pages / month'); const sPrice = (sec.slice(sec.indexOf(` ${nm} `, sec.indexOf('Every plan includes')), sec.indexOf(` ${nm} `, sec.indexOf('Every plan includes')) + 200).match(/\$([0-9,]+)/) ?? [])[1];
    check(`PR:${plan}:logins`, `site ${nm} logins "${sLog}" == code ${L.logins ?? '11+/no cap'}`, plan === 'fleet' ? /11\+/.test(sLog ?? '') && L.logins === null : num(sLog) === L.logins, `site=${sLog} code=${L.logins}`);
    check(`PR:${plan}:docs`, `site ${nm} documents stored "${sDocs}" == code ${L.documentsStored ?? 'unlimited'}`, plan === 'fleet' ? /Unlimited/i.test(sDocs ?? '') && L.documentsStored === null : num(sDocs) === L.documentsStored, `site=${sDocs} code=${L.documentsStored}`);
    check(`PR:${plan}:pages`, `site ${nm} new pages/month "${sPages}" == code ${L.pagesPerMonth}`, num(sPages) === L.pagesPerMonth, `site=${sPages} code=${L.pagesPerMonth}`);
    check(`PR:${plan}:price`, `site ${nm} price $${sPrice}/mo == code PLAN_CATALOG ${BL.PLAN_CATALOG[plan].monthly}`, Number(sPrice) === BL.PLAN_CATALOG[plan].monthly, `site=${sPrice}`);
  }
  const kb = await imp('api/_lib/support/kb.generated.js');
  for (const [plan] of Object.entries(KEY)) {
    const P = kb.PRICES.plans[plan]; const L = PLAN.PLAN_LIMITS[plan];
    check(`PR:kb:${plan}`, `KB PRICES.${plan} (monthly ${P.monthly}, annual ${P.annual}, logins ${P.loginCap}, pages ${P.pagesRaw}) == code`, P.monthly === BL.PLAN_CATALOG[plan].monthly && P.annual === BL.annualPrice(P.monthly) && P.loginCap === L.logins && P.pagesRaw === L.pagesPerMonth, JSON.stringify(P));
  }
  check('PR:rescue', 'Records Rescue $0.12/page, $500 minimum (4,167 pages) == code', kb.PRICES.rescue.rate === '0.12' && kb.PRICES.rescue.min === 500 && kb.PRICES.rescue.minPages === 4167 && BL.RECORDS_RESCUE?.unitPriceCents === 12 && BL.RECORDS_RESCUE?.minUnits === 4167, JSON.stringify([kb.PRICES.rescue, BL.RECORDS_RESCUE]));
  check('PR:trial-site', 'site: "30-day free trial on Solo ... Card required" == code (Solo only, 30 days, card required)', /30-day free trial on Solo/.test(text) && BL.PLAN_CATALOG.solo.trialEligible && !BL.PLAN_CATALOG.shop.trialEligible);
  check('PR:api-fleet', 'site: API access only on Fleet == code hasApiAccess', PLAN.hasApiAccess('fleet') && !PLAN.hasApiAccess('crew') && !PLAN.hasApiAccess('shop') && !PLAN.hasApiAccess('solo') && /API access\s+Yes/.test(sec));
  const kbText = kb.MODEL_KB + JSON.stringify(kb.ENTRIES);
  check('PR:kb-grace', 'KB: "7-day grace period after the due date ... After that, uploads pause, but you can still read and ask" == code (7 days, uploads blocked, ask allowed) [see matrix]', /7-day grace period/.test(kbText) && PLAN.PAST_DUE_GRACE_DAYS === 7);
  check('PR:support-claim', 'site FAQ: "DeepWell staff can only look at your account if your admin grants time-limited support access." == code (platform operators can also proceed with NO grant using an emergencyReason)', !/can only look at your account if your admin grants/.test(text), 'index.html says staff can ONLY look if the admin grants; api/_lib/privacy/supportAccess.js decideAccess() allows mode "emergency" with no grant (logged). The KB (docs/help/15) discloses break-glass; the public site and security.html do not.');
}
SEATS._setClerkForTest(null);
finish();
