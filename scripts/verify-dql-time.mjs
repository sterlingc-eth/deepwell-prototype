/**
 * verify:dql-time - the time family of the Donovan Query Language (api/_lib/dql/families/time.js) on the golden export, in a real PGlite database.
 *
 * Every positive answer is checked against an INDEPENDENT reading of the export file (plain JS over the raw rows, not the engine's snapshot).
 * Also checked: honest empties and ties, the definitions an answer states (a visit, a partial year, months with nothing in them), releases
 * (a month with no year, "last" that could mean two things, a gap that runs backwards, payments, a name on file twice, a word nothing explains),
 * and that the core family keeps a plain count the time family has no business taking.
 *
 *   node scripts/verify-dql-time.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DONOVAN_DQL;
delete process.env.DONOVAN_DQL_TIME_OFF;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:dqltime', tenantName: 'dqltime' })).ctx;
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab, resetTenantVocabCacheForTests } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'dqltime' };
const pack = await packForTenant({ withTenant, ctxArg });
let tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));

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
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null);
const docs = data.documents.filter((d) => d.document_type !== 'hr-letter').map((d) => {
  const f = fieldsOf.get(d.id) ?? {};
  const fin = finOf.get(d.id);
  const sd = isoDay(f.service_date);
  const invd = isoDay(f.invoice_date) ?? isoDay(fin?.invoice_date);
  return { id: d.id, type: d.document_type, f, cust: custOfDoc.get(d.id) ?? null, sd, invd, created: isoDay(d.created_at), date: sd ?? invd ?? isoDay(d.created_at), total: fin?.total != null ? Number(fin.total) : null, hours: Number.isFinite(Number(f.labor_hours)) && f.labor_hours !== '' && f.labor_hours != null ? Number(f.labor_hours) : null, tech: f.technician ?? null, svc: f.service_type ?? null };
});
const customers = data.entities.filter((e) => e.entity_type === 'customer' && !e.merged_into).map((e) => ({ id: e.id, name: e.data.customer_name }));
const nameOf = (id) => ents.get(id)?.data.customer_name ?? null;
const units = data.entities.filter((e) => e.entity_type === 'equipment' && !e.merged_into).map((e) => ({ id: e.id, cust: e.customer_id, brand: e.data.manufacturer, serial: e.data.serial_number, install: isoDay(e.data.installation_date), reg: isoDay(e.data.warranty_registered_date), wexp: isoDay(e.data.warranty?.expires), city: null }));
const MS = 86400000;
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * MS).toISOString().slice(0, 10);
const int = (n) => n.toLocaleString('en-US');
const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const visits = docs.filter((d) => d.sd);
const invoices = docs.filter((d) => d.type === 'invoice');
const inRange = (d, a, b) => d >= a && d <= b;
const countIn = (rows, key, a, b) => rows.filter((d) => d[key] && inRange(d[key], a, b)).length;
const sumIn = (rows, a, b) => rows.filter((d) => d.date && inRange(d.date, a, b)).reduce((s, d) => s + (d.total ?? 0), 0);
const pct = (from, to) => Math.round(((to - from) / from) * 1000) / 10;
const agreements = docs.filter((d) => d.type === 'maintenance-agreement').map((d) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(d.f.agreement_term ?? ''); return { cust: nameOf(d.cust), end: m ? `${m[6]}-${m[4].padStart(2, '0')}-${m[5].padStart(2, '0')}` : null }; });

/* ------------------------------------------------------------------ harness */
async function ask(q, extra = {}) {
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, ...extra });
  if (!intent) return { intent: null, data: null };
  const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
  return { intent, data: out };
}
const text = (r) => String(r.data?.text ?? '');
const has = (r, ...parts) => parts.every((p) => text(r).includes(p));
const released = async (name, q, extra) => { const x = await ask(q, extra); check(`release :: ${name}`, x.intent === null || x.data === null || !/^tm_/.test(x.intent.plan.op), JSON.stringify(x.intent?.plan ?? null).slice(0, 200) + ' ' + text(x)); };
let r;

/* ================================================================== compare, change, year to date */
const v25 = countIn(visits, 'sd', '2025-01-01', '2025-12-31'); const v24 = countIn(visits, 'sd', '2024-01-01', '2024-12-31');
r = await ask('how did visits in 2025 compare to 2024');
check('compare :: two years of visits, both values and the difference', r.intent?.plan.op === 'tm_compare' && has(r, `2025 had ${v25}`, `2024 had ${v24}`, `higher by ${Math.abs(v25 - v24)}`), text(r));
const r25 = sumIn(invoices, '2025-01-01', '2025-12-31'); const r24 = sumIn(invoices, '2024-01-01', '2024-12-31'); const r26 = sumIn(invoices, '2026-01-01', '2026-12-31');
r = await ask('percent change in revenue 2024 to 2025');
check('change :: percent from the earlier year to the later one', r.intent?.plan.op === 'tm_compare' && has(r, `+${pct(r24, r25)}%`, usd(r24), usd(r25)), text(r));
r = await ask('percent change in revenue 2025 to 2026');
check('change :: a decrease, and the year that is not over is named', has(r, `${pct(r25, r26)}%`) && /not over yet/.test(text(r)), text(r));
r = await ask('compare Q1 and Q2 2025 visits');
check('compare :: two quarters sharing one year', has(r, `Q1 2025 had ${countIn(visits, 'sd', '2025-01-01', '2025-03-31')}`, `Q2 2025 had ${countIn(visits, 'sd', '2025-04-01', '2025-06-30')}`), text(r));
r = await ask('year to date billing vs same time last year');
check('ytd :: year to date against the same point last year (measured against today)', has(r, usd(sumIn(invoices, '2026-01-01', TODAY)), usd(sumIn(invoices, '2025-01-01', '2025-10-07'))), text(r));
r = await ask('billing in the last 30 days vs the 30 days before');
check('compare :: a rolling window against the equal one before it', has(r, usd(sumIn(invoices, '2026-09-07', TODAY)), usd(sumIn(invoices, '2026-08-08', '2026-09-06'))), text(r));
r = await ask('okay so how many visits so far this year um compared to last year');
check('ytd :: so far this year against the whole of last year, with the like-for-like figure', has(r, `${countIn(visits, 'sd', '2026-01-01', TODAY)}`, `${v25}`, `${countIn(visits, 'sd', '2025-01-01', '2025-10-07')}`), text(r));
r = await ask('how much more did we inovice in 2025 than 2024, in pecrent');
check('change :: "invoice" as a verb with "how much" means dollars, measured from the later word', has(r, `+${pct(r24, r25)}%`), text(r));
r = await ask('is revenue up or down from last year');
check('change :: up or down from last year measures from last year', has(r, `${pct(r25, r26)}%`), text(r));

/* ================================================================== peaks, seasons, weekdays */
const byKey = (rows, key, f) => { const m = new Map(); for (const d of rows) if (d[key]) m.set(f(d[key]), (m.get(f(d[key])) ?? 0) + 1); return m; };
const topOf = (m) => { const max = Math.max(...m.values()); return { max, keys: [...m].filter(([, v]) => v === max).map(([k]) => k).sort() }; };
const mo25 = new Map(); for (const d of visits) if (d.sd.startsWith('2025')) mo25.set(d.sd.slice(0, 7), (mo25.get(d.sd.slice(0, 7)) ?? 0) + 1);
r = await ask('busiest month in 2025');
check('peak :: busiest month of one year', has(r, 'March 2025', `${topOf(mo25).max} service visits`), text(r));
const yrBefore = new Map(); for (const d of visits) if (d.sd < '2026-01-01') yrBefore.set(d.sd.slice(0, 4), (yrBefore.get(d.sd.slice(0, 4)) ?? 0) + 1);
r = await ask('busiest year before 2026');
check('peak :: a tie is returned whole, never cut', topOf(yrBefore).keys.length > 1 && topOf(yrBefore).keys.every((k) => text(r).includes(k)) && /tie/.test(text(r)), text(r));
const wd = new Map(); for (const d of visits) { const k = new Date(`${d.sd}T00:00:00Z`).getUTCDay(); wd.set(k, (wd.get(k) ?? 0) + 1); }
r = await ask('which weekday has the most visits');
check('peak :: busiest weekday', has(r, 'Monday', `${topOf(wd).max} service visits`), text(r));
r = await ask('visits by day of week');
check('weekday :: every weekday listed', has(r, `Monday: ${wd.get(1)}`, `Sunday: ${wd.get(0)}`), text(r));
const moy = new Map(); for (const d of visits) { const k = d.sd.slice(5, 7); moy.set(k, (moy.get(k) ?? 0) + 1); }
r = await ask('what time of year are we busiest?');
check('season :: month of the year across all years', has(r, 'September', `${moy.get('09')} service visits across all years`), text(r));
const season = (months) => visits.filter((d) => months.includes(Number(d.sd.slice(5, 7)))).length;
r = await ask('summer vs winter visits');
check('season :: summer against winter, defined in the answer', has(r, `summer had ${season([6, 7, 8])}`, `winter had ${season([12, 1, 2])}`, 'June to August'), text(r));
const pmTickets = docs.filter((d) => d.type === 'service-ticket' && d.sd && d.svc === 'Preventive Maintenance');
r = await ask('PM tickets by month of year');
check('season :: a service type filter on tickets by month of the year', has(r, `March: ${pmTickets.filter((d) => d.sd.slice(5, 7) === '03').length}`) && /preventive maintenance/.test(text(r)), text(r));
const hoursByMonth = new Map(); for (const d of visits) if (d.hours != null) hoursByMonth.set(d.sd.slice(0, 7), (hoursByMonth.get(d.sd.slice(0, 7)) ?? 0) + d.hours);
r = await ask('most labor hours in a single month');
check('peak :: labor hours, ties kept', has(r, `${Math.max(...hoursByMonth.values())} labor hours`) && /tie/.test(text(r)), text(r));

/* ================================================================== series and rates */
r = await ask('trend in visits over the last five years');
const y21 = countIn(visits, 'sd', '2021-01-01', '2021-12-31');
check('trend :: five finished years, then the year not over, flagged', has(r, `2021: ${y21}`, `2025: ${v25}`, `2026 so far`, 'not over'), text(r));
r = await ask('show me the trend in quotes by year');
const quotes = docs.filter((d) => d.type === 'proposal-quote');
check('trend :: a year with nothing is shown as 0, not skipped', quotes.every((d) => d.date.slice(0, 4) !== '2016') && has(r, '2016: 0'), text(r));
const firstY = Math.min(...invoices.map((d) => Number(d.date.slice(0, 4)))); const lastY = Math.max(...invoices.map((d) => Number(d.date.slice(0, 4))));
r = await ask('how many invoices per year on average');
check('rate :: per year includes the years with nothing in them and says how many years', has(r, String(Number((invoices.length / (lastY - firstY + 1)).toFixed(1))), `${lastY - firstY + 1} calendar years`), text(r));
const t26 = docs.filter((d) => d.type === 'service-ticket' && d.sd && d.sd.startsWith('2026')).length;
r = await ask('on average how many tickets a month in 2026');
check('rate :: a year that is not over is divided by the months gone by', has(r, String(Number((t26 / ((days('2026-01-01', TODAY) + 1) / 30.4375)).toFixed(1)))), text(r));
const installDates = units.map((u) => u.install).filter(Boolean).sort();
r = await ask('average gap between installs');
check('rate :: average days between neighbouring installs', has(r, (days(installDates[0], installDates[installDates.length - 1]) / (installDates.length - 1)).toFixed(1)), text(r));
const byCust = new Map(); for (const d of visits) { if (!d.cust) continue; if (!byCust.has(d.cust)) byCust.set(d.cust, []); byCust.get(d.cust).push(d.sd); }
const gaps = []; for (const ds of byCust.values()) { ds.sort(); for (let i = 1; i < ds.length; i++) gaps.push(days(ds[i - 1], ds[i])); }
r = await ask('average days between visits across all customers');
check('rate :: visit gaps are taken customer by customer', has(r, `${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)}`, `${gaps.length} gaps`), text(r));

/* ================================================================== how long since the last ... */
const lastOf = (rows, key) => rows.map((d) => d[key]).filter(Boolean).sort().slice(-1)[0];
r = await ask('how many days since our last invoice');
check('since :: the last invoice by its invoice date', has(r, `${days(lastOf(invoices, 'date'), TODAY)} days`), text(r));
const holy = customers.find((c) => c.name === 'Holy Trinity Church');
const holyLast = lastOf(visits.filter((d) => d.cust === holy.id), 'sd');
r = await ask('days since last visit for Holy Trinity Church');
check('since :: the last visit of one customer', has(r, `${days(holyLast, TODAY).toLocaleString('en-US')} days`, 'Holy Trinity Church'), text(r));
const linda = customers.find((c) => c.name === 'Linda Fitzgerald');
r = await ask('how long since we last billed Linda Fitzgerald');
check('since :: last billed means the last invoice', has(r, `${days(lastOf(invoices.filter((d) => d.cust === linda.id), 'date'), TODAY).toLocaleString('en-US')} days`), text(r));
r = await ask('how many days since we last did a service call');
const lastVisit = lastOf(visits, 'sd');
check('since :: a bulk day is reported honestly (how many share the date)', has(r, `${days(lastVisit, TODAY)} days`) && new RegExp(`${visits.filter((d) => d.sd === lastVisit).length} visits share that date`).test(text(r)), text(r));
r = await ask('how many months since our last invoice');
check('since :: asked in months, answered in days and months', has(r, `${days(lastOf(invoices, 'date'), TODAY)} days`) && /months/.test(text(r)), text(r));
const gilbertUnits = []; // units in Gilbert: from the customer address in the export
const cityOfAddr = (a) => { const p = String(a ?? '').split(',').map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2] : null; };
for (const u of units) { const c = ents.get(u.cust); if (c && cityOfAddr(c.data.service_address) === 'Gilbert' && u.install) gilbertUnits.push(u.install); }
r = await ask('how long since the last install in Gilbert');
check('since :: the last installation in a city', has(r, `${days(gilbertUnits.sort().slice(-1)[0], TODAY).toLocaleString('en-US')} days`), text(r));
r = await ask('days since the last purchase order');
check('since :: a kind of paper', has(r, `${days(lastOf(docs.filter((d) => d.type === 'purchase-order'), 'date'), TODAY)} days`), text(r));

const cvd = customers.find((c) => c.name === 'Canyon View Dental');
r = await ask('when did we last invoice Canyon View Dental');
check('since :: "when did we last" gives the date and the days', has(r, 'Canyon View Dental') && new RegExp(`${days(lastOf(invoices.filter((d) => d.cust === cvd.id), 'date'), TODAY)} days ago`).test(text(r)), text(r));
r = await ask('how long has it been since we serviced Canyon View Dental');
check('since :: "since we serviced" means since the last time we did', has(r, `${days(lastOf(visits.filter((d) => d.cust === cvd.id), 'sd'), TODAY)} days`), text(r));

/* ================================================================== customers with no activity */
const lastVisitBy = new Map(); for (const [c, ds] of byCust) lastVisitBy.set(c, ds.slice().sort().slice(-1)[0]);
const neverVisited = customers.filter((c) => !lastVisitBy.has(c.id)).length;
const before = (cut) => [...lastVisitBy.values()].filter((v) => v < cut).length;
r = await ask("who hasn't been serviced in over 2 years");
check('inactive :: last visit more than two years back, never-visited named apart', text(r).startsWith(`${before('2024-10-07')} customers have had no service visit`) && (neverVisited ? has(r, `${neverVisited} more customer`, 'no service visit on file at all') : !/more customer/.test(text(r))), text(r).slice(-300));
r = await ask('how many customers have not been out to since 2025');
check('inactive :: "since 2025" is the start of 2025', has(r, `${before('2025-01-01')} customers`), text(r));
const lastInvBy = new Map(); for (const d of invoices) if (d.cust) { const v = d.date; if (!lastInvBy.has(d.cust) || v > lastInvBy.get(d.cust)) lastInvBy.set(d.cust, v); }
r = await ask("customers we haven't invoiced since 2024");
check('inactive :: invoices', has(r, `${[...lastInvBy.values()].filter((v) => v < '2024-01-01').length} customers`), text(r));
const lastInstBy = new Map(); for (const u of units) if (u.cust && u.install) { if (!lastInstBy.has(u.cust) || u.install > lastInstBy.get(u.cust)) lastInstBy.set(u.cust, u.install); }
r = await ask("which customers haven't had a new unit installed in over 10 years");
check('inactive :: installations', has(r, `${[...lastInstBy.values()].filter((v) => v < '2016-10-07').length} customers`), text(r));
r = await ask('who hasn\'t been serviced in the last year');
check('release :: "the last year" could mean last calendar year or the past twelve months', r.intent === null || !/^tm_/.test(r.intent.plan.op), text(r));

r = await ask("customers that haven't been serviced for 3 years");
check('inactive :: "for 3 years" is the last three years', text(r).startsWith(`${[...lastVisitBy.values()].filter((v) => v < '2023-10-07').length} customers have had no service visit in the last 3 years`), text(r).slice(0, 200));

/* ================================================================== warranties and agreements that end */
const wlist = (a, b) => units.filter((u) => u.wexp && inRange(u.wexp, a, b)).map((u) => u.serial).sort();
r = await ask('which warranties expire in the next 12 months');
check('expiry :: warranties ending in the next year', wlist(TODAY, addDays('2027-10-07', 0)).every((s) => text(r).includes(s)) && has(r, `${wlist(TODAY, '2027-10-07').length} warranties`), text(r));
r = await ask('any warranties expiring in the next 6 months?');
check('expiry :: an honest none, and the units with no end date are named', /^No/.test(text(r)) && /have no warranty end date on file/.test(text(r)), text(r));
r = await ask('warranties that ran out in 2025');
check('expiry :: ended in a calendar year', has(r, `${wlist('2025-01-01', '2025-12-31').length} warranties`), text(r));
const future = units.filter((u) => u.wexp && u.wexp >= TODAY).sort((a, b) => a.wexp.localeCompare(b.wexp));
r = await ask("what's the next warranty to expire");
check('expiry :: the next one, with the days to go', has(r, future[0].serial, `${days(TODAY, future[0].wexp)} days`), text(r));
r = await ask('how many warranties expire in 2035');
check('expiry :: a far year counts what the end dates say', has(r, `${wlist('2035-01-01', '2035-12-31').length} warranties`), text(r));
r = await ask('how long until the warranty on 2C100027 expires');
const u27 = units.find((u) => u.serial === '2C100027');
check('expiry :: days left on one unit', has(r, '2C100027', `${days(TODAY, u27.wexp)} days`), text(r));
r = await ask('which maintenance agreements expire this year');
const thisYr = agreements.filter((a) => a.end && a.end.startsWith('2026'));
check('expiry :: agreements ending this year, by customer', has(r, `${thisYr.length} maintenance agreements`) && thisYr.every((a) => text(r).includes(a.cust)), text(r));
check('expiry :: agreement answers cite customers (a follow-up can say who they are)', (r.data?.records ?? []).every((x) => x.type === 'customer') && r.data.records.length === thisYr.length, JSON.stringify(r.data?.records?.slice(0, 2)));
r = await ask('agreements ending in the next 60 days');
check('expiry :: an honest zero, in the owner\'s own word', /^None\. 0 agreements/.test(text(r)), text(r));
r = await ask('how many days until the agreement for Ronald Bracken runs out');
const rb = agreements.find((a) => a.cust === 'Ronald Bracken');
check('between :: days until an agreement ends', has(r, `${days(TODAY, rb.end)} days`), text(r));

/* ================================================================== days between, install to registration, age */
const po = docs.filter((d) => d.type === 'purchase-order');
const p4 = po.find((d) => d.f.po_number === 'PO-9004'); const p10 = po.find((d) => d.f.po_number === 'PO-9010');
r = await ask('how many days between PO-9004 and PO-9010');
check('between :: two numbered papers', has(r, int(days(p4.date, p10.date))), text(r));
const fz = units.find((u) => u.serial === 'F100002');
r = await ask('how long did it take to register the warranty on F100002');
check('between :: install to registration for one unit', has(r, `${days(fz.install, fz.reg)} days`), text(r));
const both = units.filter((u) => u.install && u.reg);
r = await ask('days from install to registration, average across all units');
check('between :: the average over units that have both dates', has(r, String(Number((both.reduce((s, u) => s + days(u.install, u.reg), 0) / both.length).toFixed(1))), `${both.length} units`), text(r));
r = await ask("how long after we installed did Thomas Mercer's equipment get registered");
const tmUnits = units.filter((u) => nameOf(u.cust) === 'Thomas Mercer');
check('between :: a unit that was never registered says so', tmUnits.every((u) => !u.reg) && /not registered/.test(text(r)), text(r));
r = await ask('whats the age of serial 2C100027');
check('age :: one unit, years from the installation date', has(r, ((days(u27.install, TODAY)) / 365.25).toFixed(1), 'years'), text(r));
r = await ask('what is the age of the unit with serial ZZ900001');
check('age :: a serial that is not on file is said to be missing', /Not found: no unit with serial ZZ900001/.test(text(r)), text(r));
r = await ask('whats the average age of our installed base');
check('age :: average over units with an installation date', has(r, String(Number((units.filter((u) => u.install).reduce((s, u) => s + days(u.install, TODAY) / 365.25, 0) / units.filter((u) => u.install).length).toFixed(1)))), text(r));

/* ================================================================== one period, said plainly */
r = await ask('hey how many service calls did we do uh last month');
check('window :: a word the core cannot read ("calls", "uh") still gets a plain count', has(r, `${countIn(visits, 'sd', '2026-09-01', '2026-09-30')} service visits`), text(r));
r = await ask('service tickets since the start of 2026');
check('window :: since the start of a year runs to today', has(r, `${docs.filter((d) => d.type === 'service-ticket' && d.sd && d.sd >= '2026-01-01').length} service tickets`), text(r));
r = await ask('how many repair tickets in the last 12 months');
check('window / core :: a plain count with a service type stays with the core family', r.intent?.plan.op !== 'tm_window', JSON.stringify(r.intent?.plan).slice(0, 120));

/* ================================================================== releases: never a guess */
await released('a month with no year', 'more invoices in sept than aug');
await released('"last" that could mean most recent or the one before', 'what was the previous visit date');
await released('a gap that runs backwards (quote to invoice)', 'how many days between the quote and the invoice for Thomas Mercer');
await released('a week is not a period this family reads', 'busiest week we have ever had');
await released('best month with no measure', 'our best month this year');
await released('which year did we invoice the most is dollars or a count', 'which year did we invoice the most');
await released('payments are not tracked (overdue invoices)', 'overdue invoices');
await released('payments are not tracked (what is due next month)', 'which bills are due next month');
await released('a fiscal year is not defined', 'visits in fy26 so far');
await released('a word the jargon layer rewrote (leases are not agreements)', 'leases expiring in the next 60 days');
await released('"see" in a last-time question is not "serviced"', 'when did we last see Betty Winslow');
await released('an unexplained word', 'what was our busiest month for emergencies');
await released('slowest month: zero months make it ambiguous', 'slowest month for visits');
await released('a quarter with no year', 'how many calls in q2');
await released('"completed" is a status, not a filler word', 'how many completed jobs in 2025');
await released('a purchase order carries no technician', 'days since last purchase order from Danny Ochoa');
await released('a business-wide gap between papers can be read several ways', 'average days between invoices');
await released('"jobs" could be visits or work orders', 'how many jobs this year');
await released('no way to tell the measure', 'is our work volume growing or shrinking');
await released('a second measure it cannot add up', 'average invoice total per month in 2025');
{
  r = await ask('how many visits in 2025 vs 2024 by technician');
  check('release :: compare with a breakdown it cannot give', r.intent === null || !/^tm_compare/.test(r.intent.plan.op), text(r));
}
// the core family keeps a plain count
r = await ask('how many visits last month');
check('core keeps :: a plain count in one period', r.intent?.plan.op === 'count', JSON.stringify(r.intent?.plan).slice(0, 100));
r = await ask('visits per year');
check('core keeps :: a plain per-year breakdown', r.intent?.plan.op === 'group_count', JSON.stringify(r.intent?.plan).slice(0, 100));

// a customer name on file twice: the executor abstains (the existing clarify path asks which one)
{
  const tenId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
    ['dab00000-0000-4000-8c00-000000000009', tenId, 'customer', JSON.stringify({ customer_name: 'Holy Trinity Church', service_address: '1 Dup St, Mesa, AZ 85201' }), 'C-DUP0009']);
  tv = await withTenant(ctxArg, async (db) => { resetTenantVocabCacheForTests(); return getTenantVocab(db, ctx.tenantKey, pack); });
  r = await ask('days since last visit for Holy Trinity Church');
  check('ambiguous name :: a customer name on file twice is released at run time (clarify path asks)', r.intent !== null && r.data === null, text(r));
}

// the knob
{
  process.env.DONOVAN_DQL_TIME_OFF = 'all';
  r = await ask('compare visits 2025 vs 2024');
  const offHit = r.intent && /^tm_/.test(r.intent.plan.op);
  delete process.env.DONOVAN_DQL_TIME_OFF;
  check('knob :: DONOVAN_DQL_TIME_OFF=all turns the family off', !offHit, JSON.stringify(r.intent?.plan ?? null).slice(0, 100));
}

{
  const x = parseDql('how many invoices between 2024 and now', { tenantVocab: tv, pack, today: TODAY });
  { const sp = x?.plan?.period ?? x?.plan?.time; check('range :: "between 2024 and now" covers the whole span through today', Boolean(x?.plan) && sp?.from === '2024-01-01' && sp?.to === TODAY, JSON.stringify(x?.plan ?? null).slice(0, 300)); }
  const y = parseDql('how many invoices 2024 to now', { tenantVocab: tv, pack, today: TODAY });
  check('range :: a year to "now" is never read as the first year alone', y === null || y.plan?.period?.to === TODAY, JSON.stringify(y?.plan ?? null).slice(0, 300));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
