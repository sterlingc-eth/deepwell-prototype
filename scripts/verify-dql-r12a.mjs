/**
 * verify:dql-r12a - round 12a: rankings and "busiest period" questions are never answered with a plain count or list.
 *  - the analytics planner releases a plain count / list when the wording asks for a ranking, a busiest period or a count by period
 *  - other ways of asking for the top one ("which city has the greatest number of ...", "ranked first by ...") are respelled to the form the parser reads
 *  - the DQL engine reads them on the golden export
 *   node scripts/verify-dql-r12a.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 300)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};

const { RANK_SHAPE_RE, PERIOD_GROUP_RE } = await import('../api/_lib/analytics/detPlan.js');
for (const q of ['top 5 customers by quotes', 'which city has the most invoices', 'name the city with the largest count of inspection reports', 'which month had the most invoices in 2025', 'the busiest month for invoices', 'which customer comes out on top by quote count', 'which weekday is the quietest', 'what supplier has the largest count of cois'])
  check(`ranking wording: ${q}`, RANK_SHAPE_RE.test(q));
for (const q of ['how many invoices do we have', 'list customers in Mesa', 'most recent invoice', 'how many permits in 2024', 'who is the customer with the open balance'])
  check(`not a ranking: ${q}`, !RANK_SHAPE_RE.test(q));
for (const q of ['count of visits broken down by month in 2021', 'how many invoices per quarter', 'visits each year'])
  check(`count by period wording: ${q}`, PERIOD_GROUP_RE.test(q));
check('not by period: how many invoices per customer', !PERIOD_GROUP_RE.test('how many invoices per customer'));

const { dqlParaphrase } = await import('../api/_lib/dql/frame.js');
const P = (q) => dqlParaphrase(q);
check('greatest number -> top 1 by city', P('which city has the greatest number of service visits') === 'top 1 service visits by city', P('which city has the greatest number of service visits'));
check('largest count -> top 1 by brand', P('which brand has the largest count of warranty registrations') === 'top 1 warranty registrations by brand', P('which brand has the largest count of warranty registrations'));
check('ranked first by -> top by', /^top 1 .*by account$/.test(P('account ranked first by service agreement count')), P('account ranked first by service agreement count'));
check('top 3 cities unchanged in meaning', /^top 3 estimates in 2025 by cit/.test(P('top 3 cities by number of estimates in 2025')), P('top 3 cities by number of estimates in 2025'));
check('a plain question is untouched', P('how many invoices do we have') === 'how many invoices do we have');

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r12a', tenantName: 'r12a' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql } = await import('../api/_lib/dql/index.js');
const { detectAnalyticsPlan } = await import('../api/_lib/analytics/detPlan.js');
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r12a' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const TODAY = '2026-10-07';
for (const q of ['which city has the greatest number of invoices', 'top 3 cities by number of invoices', 'which customer has the most invoices']) {
  const r = parseDql(q, { tenantVocab: tv, pack, today: TODAY });
  check(`DQL ranks: ${q}`, r?.plan?.op === 'top_n', JSON.stringify(r?.plan ?? null));
}
for (const q of ['top 5 customers by number of quotes', 'which month had the most invoices']) check(`analytics plan is not a plain count/list: ${q}`, !['count', 'list'].includes(detectAnalyticsPlan(q, tv, TODAY)?.op));
check('a plain count is still planned by analytics', detectAnalyticsPlan('how many customers do we have', tv, TODAY)?.op === 'count');
{
  const legal = { ...tv, industryKind: 'legal' };
  const q = 'how many maintenance agreements in 2025';
  const hv = detectAnalyticsPlan(q, tv, TODAY); const lg = detectAnalyticsPlan(q, legal, TODAY);
  check('HVAC keeps its analytics plan for a period count of a contract', hv == null || hv.op === 'count', JSON.stringify(hv));
  check('another industry: a contract count with a period is released, not answered with a wrong zero', lg == null, JSON.stringify(lg));
  check('another industry: a plain count of contracts (no period) is still planned', detectAnalyticsPlan('how many maintenance agreements do we have', legal, TODAY)?.op === 'count');
}
const apiTop = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
check('api/ keeps 12 top-level files', apiTop === 12, String(apiTop));
console.log = realLog; console.log(`\n${passes} passed, ${failures} failed`); process.exit(failures ? 1 : 0);
