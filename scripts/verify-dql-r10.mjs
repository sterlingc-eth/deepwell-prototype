/**
 * verify:dql-r10 - round 10: "#2 customer", an ordinal with a trailing who-clause, "second most jobs", an OR of two amounts, "and / but" between two bounds,
 * "w/o email", the typed paper in "service tickets by month", and ordinary words / dates that are never a person.
 *
 *   node scripts/verify-dql-r10.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL;
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; if (!process.env.DQL_CLAIMS) console.error = () => {};
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(process.env.EXPORT || path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r10v', tenantName: 'r10' }); const ctx = loaded.ctx; if (process.env.FACTORY_INDUSTRY) await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{industry}', to_jsonb($1::text)) WHERE id = $2", [process.env.FACTORY_INDUSTRY, loaded.tenantId]);
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql } = await import('../api/_lib/dql/index.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const { isNotAPerson } = await import('../api/_lib/lookups/notAPerson.js');
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r10' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));

const TODAY = '2026-10-07';
const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => true }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };
const P = (q) => parseDql(q, { tenantVocab: tv, pack, today: TODAY });
const plan = (q) => P(q)?.plan ?? null;

// ordinals
for (const q of ['#2 customer by revenue', 'number 2 customer by revenue', 'No. 2 customer by revenue', 'no 2 client by revenue']) {
  const p = plan(q); check(`ordinal: ${q}`, p?.nth === 2 && p.op === 'top_n' && p.groupBy?.[0]?.by === 'customer', JSON.stringify(p));
}
{ const p = plan('No. 3 tech'); check('ordinal: No. 3 tech', p?.nth === 3 && p.groupBy?.[0]?.by === 'tech', JSON.stringify(p)); }
check('ordinal: invoice number 2 is not an ordinal', plan('invoice number 2') === null);
for (const q of ['what is the second highest invoice and who is it for', 'second highest invoice and who is it for?', 'what is the second highest invoice, and for whom', 'third largest invoice and who was it for']) {
  const p = plan(q); check(`ordinal + who clause: ${q}`, p?.rank === 'rows' && p.nth >= 2 && p.docType === 'invoice', JSON.stringify(p));
}
check('ordinal + who clause beside a customer ranking is released', plan('second biggest customer and who is it for') === null);
{ const p = plan('which tech has the second most jobs'); check('second most jobs (tech)', p?.nth === 2 && p.groupBy?.[0]?.by === 'tech', JSON.stringify(p)); }
{ const p = plan('which technician has the third most jobs'); check('third most jobs (technician)', p?.nth === 3 && p.groupBy?.[0]?.by === 'tech', JSON.stringify(p)); }
{ const o = await classifyAll('what is the second highest invoice and who is it for', cc); check('router: second highest + who is it for goes to DQL, not a compound split', o?.winner?.name === 'decompose' && o.winner.intent?.mode === 'dql' || o?.winner?.intent?.plan?.nth === 2, JSON.stringify(o?.winner?.intent?.mode ?? o?.winner?.name)); }

// amounts
{ const p = plan('invoices less than 500 or more than 5000'); const f = p?.filters?.[0]; check('OR of two bounds without a dollar sign', f?.op === 'outside' && f.value[0] === 500 && f.value[1] === 5000, JSON.stringify(p)); }
{ const p = plan('invoices under $200 or over $1,000'); const f = p?.filters?.[0]; check('OR of two bounds (union)', f?.op === 'outside' && f.value[0] === 200 && f.value[1] === 1000, JSON.stringify(p)); }
for (const q of ['invoices more than 250 but less than 1200', 'how many invoices over 1k and under 2k', 'invoices over 1.5k and under 2k', 'invoices over $250 and below $1,200', 'invoices greater than $250 and less than $1,200']) {
  const p = plan(q); const ops = (p?.filters ?? []).map((f) => f.op).sort().join(','); check(`two bounds kept: ${q}`, p && (ops === 'gt,lt'), JSON.stringify(p?.filters));
}
check('a count with an OR of non-money numbers is still released', plan('customers with under 2 or over 10 invoices') === null || !(plan('customers with under 2 or over 10 invoices')?.filters ?? []).some((f) => f.op === 'outside'));
check('one end of between is released', plan('invoices between $10,000') === null);

// negation
for (const q of ['customers w/o an email', 'customers without an email', 'customers with no email']) { const p = plan(q); check(`missing field: ${q}`, p?.op === 'missing_field' && p.fields?.[0]?.id === 'email', JSON.stringify(p)); }

// typed by time
{ const p = plan('service tickets by month'); check('service tickets by month keeps the type', p?.docType === 'service-ticket' && p.groupBy?.[0]?.by === 'month', JSON.stringify(p)); }

// ordinary words and dates are never a person
for (const s of ['Documents Other Than', 'Upcoming', 'Fourth Quarter 2025', 'Friday', 'most recent permits', 'second', 'last month', 'Q3 2025']) check(`not a person: ${s}`, isNotAPerson(s) === true);
for (const s of ['Kevin Pratt', 'Marisol Vega', 'Pat Smith', 'Friday Harbor Inc']) check(`still a person: ${s}`, isNotAPerson(s) === false);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
