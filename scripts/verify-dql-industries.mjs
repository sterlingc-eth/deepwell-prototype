/**
 * verify:dql-industries - the DQL engine on businesses that are not an HVAC shop: a law office, a medical office, a nonprofit, a property manager and a
 * construction contractor (scripts/golden/industries/*.json, trimmed from the question factory's synthetic companies), each loaded into its own tenant of one
 * PGlite database.
 *
 * Each positive answer is checked against an independent reading of the export file (plain JS over the raw rows below, not the engine's snapshot code), using
 * the words that kind of business uses: client / patient / donor / tenant, attorney / provider / coordinator / foreman, appointment / event, engagement letter /
 * copay receipt / pledge / lease / bid / change order. Also checked: releases (untracked topics, payment status, staff headcount, definitions, an ambiguous
 * word, a name on file twice, an unknown word) and that one company's words never leak into another's answers.
 *
 *   node scripts/verify-dql-industries.mjs
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
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');

const TODAY = '2026-10-07';
const KEYS = ['legal', 'medical', 'nonprofit', 'property', 'construction'];
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => n.toLocaleString('en-US');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/* ------------------------------------------------------------------ one company: data, an independent oracle, and an ask() */
async function company(key) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden/industries', `${key}.json`), 'utf8'));
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:ind-${key}`, tenantName: key });
  const ctx = loaded.ctx;
  // the business kind chosen at sign-up
  await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{industry}', to_jsonb($1::text)) WHERE id = $2", [key === 'medical' ? 'medical-admin' : key, loaded.tenantId]);
  const ctxArg = { tenantKey: ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
  const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
  const fieldsOf = new Map();
  for (const x of data.extractions) { if (!fieldsOf.has(x.document_id)) fieldsOf.set(x.document_id, {}); fieldsOf.get(x.document_id)[x.field_key] = eff(x); }
  const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
  const ents = new Map(data.entities.map((e) => [e.id, e]));
  const custOf = new Map();
  for (const l of data.document_entity_links) { const e = ents.get(l.entity_id); if (e?.entity_type === 'customer') custOf.set(l.document_id, e); }
  const city = (a) => { const p = String(a ?? '').split(',').map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2] : null; };
  const docs = data.documents.filter((d) => d.document_type !== 'hr-letter' && fieldsOf.get(d.id)?._audience !== 'internal').map((d) => {
    const f = fieldsOf.get(d.id) ?? {}; const fin = finOf.get(d.id); const c = custOf.get(d.id);
    const date = String(f.service_date ?? f.invoice_date ?? fin?.invoice_date ?? d.created_at).slice(0, 10);
    return { id: d.id, type: d.document_type, f, total: fin?.total != null ? Number(fin.total) : null, cust: c?.data.customer_name ?? null, city: c ? city(c.data.service_address) : null, date, visit: Boolean(f.service_date), tech: f.technician ?? null };
  });
  const customers = data.entities.filter((e) => e.entity_type === 'customer');
  const ask = async (q) => {
    const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY });
    if (!intent) return { intent, data: null };
    const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
    return { intent, data: out };
  };
  return { key, data, docs, customers, ask, ofType: (t) => docs.filter((d) => d.type === t), inYear: (rows, y) => rows.filter((d) => d.date.startsWith(String(y))), city };
}
const C = {};
for (const k of KEYS) C[k] = await company(k);

const has = (r, ...parts) => r.data && parts.every((p) => String(r.data.text).includes(p));
const released = async (c, name, q) => { const r = await c.ask(q); check(`${c.key} release :: ${name}`, !r.intent || !r.data || (/on file (?:twice|\d+ times)/.test(r.data.text) && /Which one do you mean\?/.test(r.data.text)), r.data?.text); };

/* ------------------------------------------------------------------ the customer noun of each business is the customer entity */
const NOUN = { legal: 'clients', medical: 'patients', nonprofit: 'donors', property: 'tenants', construction: 'clients' };
for (const k of KEYS) {
  const c = C[k]; const r = await c.ask(`how many ${NOUN[k]} do we have`);
  const n = c.customers.length;
  check(`${k} count :: ${NOUN[k]} are the customers`, r.data && (has(r, int(n)) || r.intent?.plain), r.data?.text ?? 'plain/none');
}

/* ------------------------------------------------------------------ legal */
{
  const c = C.legal; let r;
  const visits23 = c.inYear(c.docs.filter((d) => d.visit), 2023).length;
  r = await c.ask('how many appointments in 2023'); check('legal count :: appointments are the papers with a service date', has(r, int(visits23), '2023'), r.data?.text);
  const attorneys = [...new Set(c.docs.map((d) => d.tech).filter(Boolean))];
  r = await c.ask('how many different attorneys'); check('legal distinct :: attorneys are the technician field', has(r, int(attorneys.length)), r.data?.text);
  const agreements = c.ofType('agreement').length;
  r = await c.ask('how many engagement letters'); check('legal count :: engagement letters are agreements', has(r, int(agreements)), r.data?.text);
  const over = c.ofType('invoice').filter((d) => d.total != null && d.total > 2500).length;
  r = await c.ask('invoices over $2,500'); check('legal count :: invoices over an amount', has(r, int(over)), r.data?.text);
  const tuc = c.customers.filter((e) => c.city(e.data.service_address) === 'Tucson').length;
  r = await c.ask('how many clients in Tucson'); check('legal count :: clients by city', has(r, int(tuc), 'Tucson'), r.data?.text);
  const inv22 = c.inYear(c.ofType('invoice'), 2022).filter((d) => d.total != null);
  r = await c.ask('total of invoices in 2022'); check('legal sum :: invoices in a year', has(r, money(sum(inv22.map((d) => d.total)))), r.data?.text);
  const past = c.docs.filter((d) => d.date <= TODAY && d.type === 'correspondence').sort((a, b) => b.date.localeCompare(a.date))[0];
  r = await c.ask('latest letter'); check('legal latest :: letters are correspondence, a paper dated after today is not recent', r.data && past && String(r.data.text).includes(new Date(`${past.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })), r.data?.text);
  const byTech = new Map(); for (const d of c.docs.filter((x) => x.visit && x.tech)) byTech.set(d.tech, (byTech.get(d.tech) ?? 0) + 1);
  const top = [...byTech.entries()].sort((a, b) => b[1] - a[1]);
  r = await c.ask('which attorney has the most appointments');
  check('legal rank :: the attorney with the most appointments', r.data && (top.length < 2 || top[0][1] === top[1][1] || has(r, top[0][0])), r.data?.text);
  await released(c, 'retainer balance is not tracked', 'what is the retainer balance for Natalie Morales');
  await released(c, 'billable hours are not tracked', 'how many billable hours in 2024');
  await released(c, 'overdue invoices (payment status)', 'how many invoices are past due');
  await released(c, 'staff headcount', 'headcount of employees');
  await released(c, 'a definition', 'what is a retainer agreement');
  await released(c, 'a client on file twice', 'how many invoices for Natalie Morales');
  await released(c, 'an unknown word', 'how many frobnicators in 2024');
}

/* ------------------------------------------------------------------ medical */
{
  const c = C.medical; let r;
  const v24 = c.inYear(c.docs.filter((d) => d.visit), 2024).length;
  r = await c.ask('how many appointments in 2024'); check('medical count :: appointments', has(r, int(v24)), r.data?.text);
  const provs = [...new Set(c.docs.map((d) => d.tech).filter(Boolean))];
  r = await c.ask('how many different providers'); check('medical distinct :: providers', has(r, int(provs.length)), r.data?.text);
  r = await c.ask('how many copay receipts'); check('medical count :: copay receipts are receipts', has(r, int(c.ofType('receipt').length)), r.data?.text);
  r = await c.ask('how many insurance cards'); check('medical count :: insurance cards are insurance certificates', has(r, int(c.ofType('insurance-certificate').length)), r.data?.text);
  const bills = c.ofType('invoice').filter((d) => d.total != null); const avg = sum(bills.map((d) => d.total)) / bills.length;
  r = await c.ask('patient bills above the average amount - how many'); check('medical sets :: patient bills above the average', has(r, int(bills.filter((d) => d.total > avg).length), 'patient bill'), r.data?.text);
  const phx = c.customers.filter((e) => c.city(e.data.service_address) === 'Phoenix').length;
  r = await c.ask('how many patients in Phoenix'); check('medical count :: patients by city', has(r, int(phx)), r.data?.text);
  r = await c.ask('headcount of patients'); check('medical count :: a headcount of patients is the customers, not staff', r.data ? has(r, int(c.customers.length)) : !r.intent || r.intent.plain === true, r.data?.text);
  await released(c, 'diagnosis codes are not tracked', 'how many diagnosis codes did we record');
  await released(c, 'patient balance due', 'which patients have a balance due');
  await released(c, 'no-show rate', 'what is our no-show rate');
  await released(c, 'a patient on file twice', 'how many appointments for Andrew Carlson');
  await released(c, 'staff headcount', 'what is our staff headcount');
}

/* ------------------------------------------------------------------ nonprofit */
{
  const c = C.nonprofit; let r;
  const d24 = c.inYear(c.ofType('receipt'), 2024).length;
  r = await c.ask('how many donations in 2024'); check('nonprofit count :: donations are receipts', has(r, int(d24)), r.data?.text);
  r = await c.ask('how many pledges'); check('nonprofit count :: pledges are agreements', has(r, int(c.ofType('agreement').length)), r.data?.text);
  const ev = c.docs.filter((d) => d.visit).length;
  r = await c.ask('how many events'); check('nonprofit count :: events are the dated papers', has(r, int(ev)), r.data?.text);
  const coords = [...new Set(c.docs.map((d) => d.tech).filter(Boolean))];
  r = await c.ask('how many different coordinators'); check('nonprofit distinct :: coordinators', has(r, int(coords.length)), r.data?.text);
  r = await c.ask('how many donor statements'); check('nonprofit count :: donor statements are statements', has(r, int(c.ofType('statement').length)), r.data?.text);
  const tot = sum(c.ofType('receipt').filter((d) => d.total != null).map((d) => d.total));
  r = await c.ask('total of donation receipts'); check('nonprofit sum :: donation receipts', has(r, money(tot)), r.data?.text);
  r = await c.ask('how many donors'); check('nonprofit count :: donors are the customers', has(r, int(c.customers.length)), r.data?.text);
  await released(c, 'volunteer hours are not tracked', 'how many volunteer hours did we log');
  await released(c, 'pledge balance outstanding', 'what is the pledge balance outstanding');
  await released(c, 'donor retention rate', 'what is our donor retention rate');
  await released(c, 'a donor on file twice', 'how many donations from Katherine McDaniel');
}

/* ------------------------------------------------------------------ property management */
{
  const c = C.property; let r;
  r = await c.ask('how many leases'); check('property count :: leases are lease agreements, not maintenance contracts', has(r, int(c.ofType('lease-agreement').length)), r.data?.text);
  r = await c.ask('how many move-in inspections'); check('property count :: a hyphenated kind of paper', has(r, int(c.ofType('move-in-inspection').length)), r.data?.text);
  r = await c.ask('how many tenant charges'); check('property count :: tenant charges are invoices (the phrase keeps its customer word)', has(r, int(c.ofType('invoice').length)), r.data?.text);
  r = await c.ask('how many work orders'); check('property count :: work orders', has(r, int(c.ofType('work-order').length)), r.data?.text);
  const techs = [...new Set(c.docs.map((d) => d.tech).filter(Boolean))];
  r = await c.ask('how many different maintenance techs'); check('property distinct :: maintenance techs', has(r, int(techs.length)), r.data?.text);
  const l25 = c.inYear(c.ofType('lease-agreement'), 2025).length;
  r = await c.ask('lease agreements in 2025'); check('property list :: lease agreements in a year', has(r, int(l25), '2025') || (l25 === 0 && /No|0/.test(r.data?.text ?? '')), r.data?.text);
  await released(c, 'rent roll occupancy', 'what is the rent roll occupancy');
  await released(c, 'vacancy rate', 'what is our vacancy rate');
  await released(c, 'security deposit balance', 'how much security deposit balance do we hold');
  await released(c, 'late rent (payment status)', 'which tenants are behind on rent');
}

/* ------------------------------------------------------------------ construction */
{
  const c = C.construction; let r;
  r = await c.ask('how many bids'); check('construction count :: bids are quotes', has(r, int(c.ofType('proposal-quote').length)), r.data?.text);
  r = await c.ask('how many work orders'); check('construction count :: work orders', has(r, int(c.ofType('work-order').length)), r.data?.text);
  r = await c.ask('how many permits'); check('construction count :: permits', has(r, int(c.ofType('permit').length)), r.data?.text);
  const fore = [...new Set(c.docs.map((d) => d.tech).filter(Boolean))];
  r = await c.ask('how many different foremen'); check('construction distinct :: foremen', has(r, int(fore.length)), r.data?.text);
  const bids = c.ofType('proposal-quote').filter((d) => d.total != null).length;
  r = await c.ask('how much did we bid in total'); check('construction sum :: bids add up from their totals', r.data ? has(r, money(sum(c.ofType('proposal-quote').filter((d) => d.total != null).map((d) => d.total)))) || bids === 0 : true, r.data?.text);
  r = await c.ask('how many contracts'); check('construction count :: contracts are agreements (the only contract kind this company has)', has(r, int(c.ofType('agreement').length)), r.data?.text);
  await released(c, 'retainage held', 'how much retainage is held');
  await released(c, 'job profit margin', 'what is the job profit margin');
  await released(c, 'unpaid invoices', 'show unpaid invoices');
  await released(c, 'a client on file twice', 'how many invoices for Carol Lucas');
}

/* ------------------------------------------------------------------ dates per kind of paper, extremes, groupings */
{
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const c = C.property; let r;
  const coi = c.data.documents.filter((d) => d.document_type === 'certificate-of-insurance');
  const exp = (id) => (c.data.extractions.find((x) => x.document_id === id && x.field_key === 'coi_expires') ?? {}).value;
  const in90 = coi.filter((d) => { const e = exp(d.id); return e && e >= TODAY && e <= addDays(TODAY, 90); }).length;
  r = await c.ask('how many COIs expire in the next 90 days'); check('property expiry :: certificates of insurance run out on their own date', has(r, int(in90)), r.data?.text);
  const leases = c.data.documents.filter((d) => d.document_type === 'lease-agreement');
  const endOf = (id) => (c.data.extractions.find((x) => x.document_id === id && x.field_key === 'lease_end_date') ?? {}).value;
  const ending = leases.filter((d) => { const e = endOf(d.id); return e && e >= TODAY && e <= addDays(TODAY, 120); });
  r = await c.ask('which tenants have leases ending within the next 120 days');
  check('property expiry :: leases ending soon, by tenant', r.data && has(r, int(ending.length)) && ending.every((d) => { const l = c.data.document_entity_links.find((x) => x.document_id === d.id); const e = c.data.entities.find((x) => x.id === l?.entity_id); return !e || String(r.data.text).includes(e.data.customer_name); }), r.data?.text);
  const gone = leases.filter((d) => { const e = endOf(d.id); return e && e < TODAY; }).length;
  r = await c.ask('how many lease agreements are expired'); check('property expiry :: leases already ended', has(r, int(gone)), r.data?.text);
}
{
  const c = C.legal; let r;
  const inv = c.ofType('invoice').filter((d) => d.date >= '2019-01-01' && d.date <= TODAY);
  const byY = new Map(); for (const d of inv) byY.set(d.date.slice(0, 4), (byY.get(d.date.slice(0, 4)) ?? 0) + 1);
  const best = [...byY.entries()].sort((a, b) => b[1] - a[1]);
  r = await c.ask('busiest year for invoices since 2019'); check('legal peak :: "since 2019" runs to today, not to the end of 2019', best.length > 1 && best[0][1] !== best[1][1] ? has(r, best[0][0], int(best[0][1])) : Boolean(r.data), r.data?.text);
  const lastInv = c.ofType('invoice').filter((d) => d.date <= TODAY).sort((a, b) => b.date.localeCompare(a.date));
  const tiedLast = lastInv.filter((d) => d.date === lastInv[0].date);
  r = await c.ask('name the client with the latest invoice'); check('legal pick :: the client on the latest invoice', tiedLast.length !== 1 || (r.data && has(r, tiedLast[0].cust)), r.data?.text);
  const firstInv = c.ofType('invoice').filter((d) => d.total != null).sort((a, b) => a.date.localeCompare(b.date));
  const tiedFirst = firstInv.filter((d) => d.date === firstInv[0].date);
  r = await c.ask('how much was the first invoice'); check('legal pick :: the amount of the earliest invoice', tiedFirst.length !== 1 || (r.data && has(r, money(tiedFirst[0].total))), r.data?.text);
  const lineSum = (r2) => r2;
  await released(c, 'change orders are not recorded at a law office', 'how many change orders');
  await released(c, 'donations are not recorded at a law office', 'what were donations received last month');
}
{
  const c = C.medical; let r;
  const rc22 = c.inYear(c.ofType('receipt'), 2022).length;
  r = await c.ask('receipts in 2022 by month and day of the week');
  check('medical group :: two groupings are both kept (month and weekday)', rc22 === 0 || (r.data && has(r, `${int(rc22)} receipts by month and day of the week`)), r.data?.text);
  r = await c.ask('how many hours were billed by provider this month'); check('medical release :: labor hours are not recorded here (no zero is made up)', !r.data, r.data?.text);
}
{
  const { arbiterAllows } = await import('../api/_lib/router/dqlArbiter.js');
  const intent = { plan: { op: 'avg' }, plain: false };
  check('arbiter :: an organization that chose another kind of business takes DQL for any question it fully reads', arbiterAllows({ name: 'analytics' }, intent, { oldLabel: 'analytics:zzz', question: 'x', industryKind: 'legal' }) === true);
  check('arbiter :: no industry setting (or HVAC) takes DQL for any question it fully reads, like every other company (R13)', arbiterAllows({ name: 'analytics' }, intent, { oldLabel: 'analytics:zzz', question: 'x', industryKind: null }) === true && arbiterAllows({ name: 'analytics' }, intent, { oldLabel: 'analytics:zzz', question: 'x', industryKind: 'hvac' }) === true);
  process.env.DONOVAN_DQL_ALLOWLIST = '1';
  check('arbiter :: the legacy allowlist can be switched back on for a comparison run', arbiterAllows({ name: 'analytics' }, intent, { oldLabel: 'analytics:zzz', question: 'x', industryKind: null }) === false);
  delete process.env.DONOVAN_DQL_ALLOWLIST;
  check('arbiter :: a plain inventory question is never taken', arbiterAllows({ name: 'analytics' }, { plan: { op: 'count' }, plain: true }, { oldLabel: 'analytics:count', question: 'x', industryKind: 'legal' }) === false);
}

/* ------------------------------------------------------------------ words do not leak between companies, private papers stay private */
{
  const r = await C.legal.ask('how many patients'); check('isolation :: a legal client is also a customer, so "patients" is read as customers there (same entity)', !r.intent || has(r, int(C.legal.customers.length)), r.data?.text);
  const hr = C.medical.data.documents.filter((d) => d.document_type === 'hr-letter').length;
  const r2 = await C.medical.ask('how many documents');
  const shown = C.medical.docs.length;
  check('privacy :: HR letters are never counted', hr > 0 && (!r2.data || has(r2, int(shown))) && !(r2.data && String(r2.data.text).includes(int(shown + hr))), r2.data?.text);
  const r3 = await C.medical.ask('how many hr letters'); check('privacy :: HR letters are not answered at all', !r3.data, r3.data?.text);
}

/* ------------------------------------------------------------------ round 8: a lease is a lease; the same word for the people a business bills */
{
  let r = await C.property.ask('how many lease agreements do we have');
  check('property count :: lease agreements are the lease papers', r.data && has(r, int(C.property.ofType('lease-agreement').length), 'lease'), r.data?.text);
  for (const k of ['nonprofit', 'legal', 'medical', 'construction']) {
    r = await C[k].ask('how many lease agreements do we have');
    check(`${k} count :: no lease papers is "none", never the agreements it does keep`, r.data && /^No lease agreements on file\.$/.test(r.data.text), r.data?.text);
  }
  r = await C.nonprofit.ask('how many gifts do we have');
  check('nonprofit count :: gifts are the donation receipts', r.data && has(r, int(C.nonprofit.ofType('receipt').length), 'gifts'), r.data?.text);
  r = await C.nonprofit.ask('do we have an invoice dated January 1st, 2030');
  check('nonprofit exists :: a period after today says none on file with no computed zero attached', r.data && /on file\.$/.test(r.data.text) && (r.data.facts ?? []).length === 0, JSON.stringify(r.data?.facts));
  r = await C.nonprofit.ask('invoices dated in 2027');
  check('nonprofit count :: invoices dated after today are counted when they exist', r.data && /^\d+ invoices?\b/.test(r.data.text) && !/future date/.test(r.data.text), r.data?.text);
  r = await C.medical.ask('how many patients are not in Phoenix or Mesa');
  check('medical count :: "not in X or Y" reads once', !r.data || !/not in [A-Za-z ]+ not in/.test(r.data.text), r.data?.text);
}


console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
