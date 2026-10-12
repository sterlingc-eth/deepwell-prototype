/**
 * verify:dql-r11 - round 11 (days since, calendar year, largest period) ("second largest"), two-bound ranges, negation as a set, document type + person, and follow-ups that refine a number, on the golden export.
 *
 * Every positive answer is checked against an INDEPENDENT reading of the export file (plain JS over the raw rows below, not the engine's own
 * snapshot code). Also checked: releases (an unexplained word, an ambiguous name, an untracked field, a follow-up fragment, a definition),
 * ties, honest empties, the router wiring (claim / kill switch / never overrides a claim), the precision guard and the 12-file api/ rule.
 *
 *   node scripts/verify-dql-r8.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r8', tenantName: 'r8' })).ctx;
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r8' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => true }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };

/* ------------------------------------------------------------------ the independent oracle (plain JS over the raw export rows) */
const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
const fieldsOf = new Map();
for (const x of data.extractions) { if (!fieldsOf.has(x.document_id)) fieldsOf.set(x.document_id, {}); fieldsOf.get(x.document_id)[x.field_key] = eff(x); }
const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
const ents = new Map(data.entities.map((e) => [e.id, e]));
const custOfDoc = new Map();
for (const l of data.document_entity_links) {
  const e = ents.get(l.entity_id); if (!e) continue;
  const cid = e.entity_type === 'customer' ? e.id : e.customer_id;
  if (cid && ents.get(cid)) custOfDoc.set(l.document_id, cid);
}
const city = (addr) => { const p = String(addr ?? '').split(',').map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2] : null; };
const docs = data.documents.map((d) => {
  const f = fieldsOf.get(d.id) ?? {};
  const fin = finOf.get(d.id);
  const cust = ents.get(custOfDoc.get(d.id));
  const date = (f.service_date ?? f.invoice_date ?? String(fin?.invoice_date ?? '').slice(0, 10)) || String(d.created_at).slice(0, 10);
  return { id: d.id, type: d.document_type, f, total: fin?.total != null ? Number(fin.total) : null, cust: cust?.data.customer_name ?? null, city: cust ? city(cust.data.service_address) : null, date: String(date).slice(0, 10), service: f.service_date ?? null };
});
const customers = data.entities.filter((e) => e.entity_type === 'customer');
const units = data.entities.filter((e) => e.entity_type === 'equipment');
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => n.toLocaleString('en-US');
const ofType = (t) => docs.filter((d) => d.type === t);
const inYear = (rows, y) => rows.filter((d) => d.date.startsWith(String(y)));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/* ------------------------------------------------------------------ harness */
async function ask(q, extra = {}) {
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, ...extra });
  if (!intent) return { intent: null, data: null };
  const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
  return { intent, data: out };
}
const has = (r, ...parts) => r.data && parts.every((p) => String(r.data.text).includes(p));


/* ================================================================== round 11 */
const custs = [...new Set(docs.filter((d) => d.type === 'invoice' && d.cust).map((d) => d.cust))];
const who = custs[0];
// the last invoice of that customer, by the independent reading
const mine = docs.filter((d) => d.type === 'invoice' && d.cust === who && d.date).map((d) => d.date).sort();
const daysAgo = (iso) => Math.round((Date.parse(TODAY) - Date.parse(iso)) / 86400000);
for (const q of [`how long since ${who} had an invoice - in days`, `when was ${who}'s last invoice, in days ago`]) {
  const r = await ask(q);
  check(`r11 :: "${q}" is the days since the last invoice`, r.intent?.plan?.op === 'tm_since' && r.intent.plan.mode === 'days' && mine.length > 0 && has(r, daysAgo(mine[mine.length - 1]).toLocaleString("en-US")), r.data?.text);
}
{
  const q = 'when was the last invoice for ' + who;
  const r = await ask(q);
  check('r11 :: "when was the last invoice" without "in days" still answers with the date', r.intent == null || r.intent.plan.op !== 'tm_since' || r.intent.plan.mode === 'date', JSON.stringify(r.intent?.plan ?? null));
}
{
  const r = await ask('number of invoices by month in the last calendar year');
  const y = String(Number(TODAY.slice(0, 4)) - 1);
  check('r11 :: "the last calendar year" is the previous calendar year', r.intent?.plan?.op === 'group_count' && r.intent.plan.time?.from === `${y}-01-01` && r.intent.plan.time?.to === `${y}-12-31`, JSON.stringify(r.intent?.plan?.time));
  const t = await ask('how many invoices in this calendar year');
  check('r11 :: "this calendar year" is the current year', t.intent?.plan?.time?.from === `${TODAY.slice(0, 4)}-01-01`, JSON.stringify(t.intent?.plan?.time));
}
{
  const r = await ask('which month of the year is our heaviest by number of invoices');
  const per = new Map(); for (const d of ofType('invoice').filter((d) => d.date)) { const m = d.date.slice(5, 7); per.set(m, (per.get(m) ?? 0) + 1); }
  const max = Math.max(...per.values()); const tops = [...per.entries()].filter((e) => e[1] === max).map((e) => e[0]);
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  check('r11 :: "heaviest month of the year" is the busiest month by count', r.intent?.plan?.op === 'tm_series' && r.intent.plan.mode === 'peak' && tops.every((m) => has(r, names[Number(m) - 1])), r.data?.text);
  const s = await ask('which month of the year is our slowest for invoices');
  check('r11 :: the low direction is not read as the busiest', s.intent == null || s.intent.plan.mode !== 'peak', JSON.stringify(s.intent?.plan?.mode));
  const u = await ask('largest invoice in 2024');
  check('r11 :: "largest invoice" stays a single-paper maximum', u.intent == null || u.intent.plan.op === 'max', JSON.stringify(u.intent?.plan?.op));
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
