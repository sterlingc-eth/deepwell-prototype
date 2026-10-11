/**
 * verify:dql-sets - the sets family of the Donovan Query Language (api/_lib/dql/families/sets.js) on the golden export, in a real PGlite database.
 *
 * Every positive answer is checked against an INDEPENDENT reading of the export file (plain JS over the raw rows, not the engine's snapshot).
 * Also checked: honest empties, releases (a negation that cannot be applied, a name on file twice, an ambiguous period, a word nothing explains),
 * the definitions the answers state, and that the core family keeps what it already answered.
 *
 *   node scripts/verify-dql-sets.mjs
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
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:dqlsets', tenantName: 'dqlsets' })).ctx;
const { withTenant, getTenantContext } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab, resetTenantVocabCacheForTests } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'dqlsets' };
const pack = await packForTenant({ withTenant, ctxArg });
let tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));

/* ------------------------------------------------------------------ the independent oracle (plain JS over the raw export rows) */
const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
const fieldsOf = new Map();
for (const x of data.extractions) { if (!fieldsOf.has(x.document_id)) fieldsOf.set(x.document_id, {}); fieldsOf.get(x.document_id)[x.field_key] = eff(x); }
const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
const ents = new Map(data.entities.map((e) => [e.id, e]));
const custsOfDoc = new Map(); const unitsOfDoc = new Map();
for (const l of data.document_entity_links) {
  const e = ents.get(l.entity_id); if (!e) continue;
  if (e.entity_type === 'customer') { if (!custsOfDoc.has(l.document_id)) custsOfDoc.set(l.document_id, new Set()); custsOfDoc.get(l.document_id).add(e.id); }
  if (e.entity_type === 'equipment') {
    if (!unitsOfDoc.has(l.document_id)) unitsOfDoc.set(l.document_id, new Set()); unitsOfDoc.get(l.document_id).add(e.id);
    if (e.customer_id) { if (!custsOfDoc.has(l.document_id)) custsOfDoc.set(l.document_id, new Set()); custsOfDoc.get(l.document_id).add(e.customer_id); }
  }
}
const cityOf = (addr) => { const p = String(addr ?? '').split(',').map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2] : null; };
const docs = data.documents.map((d) => {
  const f = fieldsOf.get(d.id) ?? {};
  const fin = finOf.get(d.id);
  const sd = /^\d{4}-\d{2}-\d{2}/.test(f.service_date ?? '') ? f.service_date.slice(0, 10) : null;
  return { id: d.id, type: d.document_type, f, tech: f.technician ?? null, serviceDate: sd, total: fin?.total != null ? Number(fin.total) : null, custs: [...(custsOfDoc.get(d.id) ?? [])], units: [...(unitsOfDoc.get(d.id) ?? [])], date: (sd ?? f.invoice_date ?? String(d.created_at)).slice(0, 10), svc: f.service_type ?? null };
}).filter((d) => d.type !== 'hr-letter');
const customers = data.entities.filter((e) => e.entity_type === 'customer' && !e.merged_into).map((e) => ({ id: e.id, name: e.data.customer_name, city: cityOf(e.data.service_address), address: e.data.service_address }));
const units = data.entities.filter((e) => e.entity_type === 'equipment' && !e.merged_into).map((e) => ({ id: e.id, cust: e.customer_id, brand: e.data.manufacturer, serial: e.data.serial_number, install: String(e.data.installation_date ?? '').slice(0, 10) }));
const custsWith = (type) => new Set(docs.filter((d) => d.type === type).flatMap((d) => d.custs));
const custsVisited = new Set(docs.filter((d) => d.serviceDate).flatMap((d) => d.custs));
const visitCount = (cid) => docs.filter((d) => d.serviceDate && d.custs.includes(cid)).length;
const unitsWith = (type) => new Set(docs.filter((d) => d.type === type).flatMap((d) => d.units));
const int = (n) => n.toLocaleString('en-US');
const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const invoices = docs.filter((d) => d.type === 'invoice' && d.total != null);

/* ------------------------------------------------------------------ harness */
async function ask(q, extra = {}) {
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, ...extra });
  if (!intent) return { intent: null, data: null };
  const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
  return { intent, data: out };
}
const text = (r) => String(r.data?.text ?? '');
const namesIn = (r, names) => names.every((n) => text(r).includes(n));
const released = async (name, q, extra) => { const x = await ask(q, extra); check(`release :: ${name}`, x.intent === null || x.data === null, JSON.stringify(x.intent?.plan ?? null).slice(0, 200) + ' ' + text(x)); };

/* ================================================================== customers: has / has not (set difference, intersection, never had) */
const est = custsWith('proposal-quote'); const agr = custsWith('maintenance-agreement'); const inv = custsWith('invoice');
const names = (ids) => customers.filter((c) => ids.has(c.id)).map((c) => c.name);
let r;

const estNoAgr = new Set([...est].filter((c) => !agr.has(c)));
r = await ask('which customers have an estimate but no agreement');
check('difference :: estimate but no agreement (documents linked through the customer)', r.intent?.plan.op === 'set_select' && text(r).startsWith(`${int(estNoAgr.size)} customers`) && namesIn(r, names(estNoAgr).sort().slice(0, 12)), text(r));
check('difference :: states what "has" means in its basis', /linked to the customer/.test(r.data?.basis ?? ''), r.data?.basis);
check('difference :: cites every matching customer', r.data?.records?.length === estNoAgr.size, r.data?.records?.length);

r = await ask('how many customers have a quote but no maintenance agreement');
check('difference :: count form', text(r).startsWith(`${int(estNoAgr.size)} customers`) && !text(r).includes(':'), text(r));

const agrNoEst = new Set([...agr].filter((c) => !est.has(c)));
r = await ask('customers with a maintenance agreement but no estimate');
check('difference :: the other direction', text(r).startsWith(`${int(agrNoEst.size)} customers`) && namesIn(r, names(agrNoEst)), text(r));

const both = new Set([...est].filter((c) => agr.has(c)));
r = await ask('who has both an estimate and an agreement');
check('intersection :: both an estimate and an agreement', text(r).startsWith(`${int(both.size)} customers`) && namesIn(r, names(both)), text(r));

const reg = custsWith('warranty-registration'); const perm = custsWith('permit');
const neither = customers.filter((c) => !reg.has(c.id) && !perm.has(c.id)).length;
r = await ask('how many customers have neither a warranty registration nor a permit');
check('never had :: neither ... nor', text(r).startsWith(`${int(neither)} customers`), text(r));

const noInvoice = customers.filter((c) => !inv.has(c.id));
r = await ask('which customers have never been invoiced');
check('never had :: never invoiced', text(r).startsWith(`${int(noInvoice.length)} customer`) || (noInvoice.length === 0 && /No customers/.test(text(r))), text(r));

const noVisit = customers.filter((c) => !custsVisited.has(c.id));
r = await ask('customers with no service visits');
check('never had :: no service visit (a visit is any paper with a service date)', text(r).startsWith(`${int(noVisit.length)} customer`) || (noVisit.length === 0 && /No customers/.test(text(r))), text(r));

const noDocs = customers.filter((c) => !docs.some((d) => d.custs.includes(c.id)));
r = await ask('any customer with no documents at all');
check('never had :: no documents at all', noDocs.length ? text(r).startsWith(`${int(noDocs.length)} customer`) : /No customers/.test(text(r)), text(r));

r = await ask('customers with an invoice and a permit');
const invPerm = [...inv].filter((c) => perm.has(c)).length;
check('intersection :: two document types with "and"', text(r).startsWith(`${int(invPerm)} customers`), text(r));

r = await ask('customers with no agreement or permit');
const noAgrPerm = customers.filter((c) => !agr.has(c.id) && !perm.has(c.id)).length;
check('negation :: "no A or B" means neither', text(r).startsWith(`${int(noAgrPerm)} customers`), text(r));

/* ---- repeat customers are defined by visits (no customer has two invoices) */
const repeat = customers.filter((c) => visitCount(c.id) >= 2);
r = await ask('who are our repeat customers');
check('repeat :: two or more service visits', text(r).startsWith(`${int(repeat.length)} customers`) && /service visit/.test(text(r)) && /two or more service visits|repeat customer is one with two or more/.test(`${text(r)} ${r.data?.basis}`), text(r));
const manyInv = customers.filter((c) => docs.filter((d) => d.type === 'invoice' && d.custs.includes(c.id)).length > 1).length;
r = await ask('customers with more than one invoice');
check('repeat :: more than one invoice is an honest none when no customer has two', manyInv === 0 ? /No customers/.test(text(r)) : text(r).startsWith(`${int(manyInv)} customers`), text(r));
r = await ask('customers with 3 or more visits');
check('repeat :: N or more visits', text(r).startsWith(`${int(customers.filter((c) => visitCount(c.id) >= 3).length)} customers`), text(r));
r = await ask('what percent of customers are repeat');
check('share :: repeat customers, the base is every customer on file', text(r).includes(`${int(repeat.length)} of ${int(customers.length)} customers`), text(r));

/* ---- brands and cities */
const brandOwners = (b) => new Set(units.filter((u) => u.brand === b).map((u) => u.cust));
const ownsTrane = brandOwners('Trane'); const ownsCarrier = brandOwners('Carrier');
r = await ask('which customers have a Trane but not a Carrier');
check('difference :: owns one brand and not another', text(r).startsWith(`${int([...ownsTrane].filter((c) => !ownsCarrier.has(c)).length)} customers`), text(r));
r = await ask('who has both a Trane and a Carrier');
check('intersection :: owns both brands', text(r).startsWith(`${int([...ownsTrane].filter((c) => ownsCarrier.has(c)).length)} customer`), text(r));
const mesa = customers.filter((c) => c.city === 'Mesa');
r = await ask('customers in Mesa without an agreement');
check('difference :: a city plus a missing paper', text(r).startsWith(`${int(mesa.filter((c) => !agr.has(c.id)).length)} customers`), text(r));
const pick = mesa[0];
r = await ask(`who else lives in Mesa besides ${pick.name}`);
check('hop :: others in the same city, not counting the named customer', text(r).startsWith(`${int(mesa.length - 1)} customers`) && !new RegExp(`: .*${pick.name}`).test(text(r)), text(r));
const ph = customers.find((c) => c.city === 'Phoenix');
r = await ask(`which other customers share a city with ${ph.name}`);
check('hop :: same city as a named customer', text(r).startsWith(`${int(customers.filter((c) => c.city === 'Phoenix').length - 1)} customers`), text(r));

/* ---- technicians (customers -> documents -> technicians, both ways) */
const techs = [...new Set(docs.map((d) => d.tech).filter(Boolean))];
const servedBy = (t) => new Set(docs.filter((d) => d.tech === t).flatMap((d) => d.custs));
r = await ask(`which customers has ${techs[0]} worked with`);
check('hop :: customers a technician has worked with', text(r).startsWith(`${int(servedBy(techs[0]).size)} customers`), text(r));
r = await ask(`customers who've seen both ${techs[0]} and ${techs[1]}`);
check('intersection :: customers seen by both technicians', text(r).startsWith(`${int([...servedBy(techs[0])].filter((c) => servedBy(techs[1]).has(c)).length)} customer`), text(r));
const cust0 = customers.find((c) => docs.some((d) => d.tech && d.custs.includes(c.id)));
const techsOfC = [...new Set(docs.filter((d) => d.tech && d.custs.includes(cust0.id)).map((d) => d.tech))];
r = await ask(`which technicians have been out to ${cust0.name}`);
check('hop :: technicians who worked for a customer', text(r).startsWith(`${techsOfC.length} technician`) && namesIn(r, techsOfC), text(r));

/* ---- units (only papers tied to the unit count) */
const unitStartup = unitsWith('startup-sheet'); const unitReg = unitsWith('warranty-registration');
r = await ask('units that have a startup sheet but no warranty registration');
check('units :: a paper and a missing paper', text(r).startsWith(`${int([...unitStartup].filter((u) => !unitReg.has(u)).length)} units`), text(r));
r = await ask('how many Trane units have no startup sheet');
check('units :: brand plus a missing paper', text(r).startsWith(`${int(units.filter((u) => u.brand === 'Trane' && !unitStartup.has(u.id)).length)} units`), text(r));
const unitVisits = new Set(docs.filter((d) => d.serviceDate).flatMap((d) => d.units));
r = await ask('how many units have had zero service calls');
check('units :: zero service visits', text(r).startsWith(`${int(units.filter((u) => !unitVisits.has(u.id)).length)} unit`) || (units.every((u) => unitVisits.has(u.id)) && /No units/.test(text(r))), text(r));

/* ---- cities as the thing asked about */
const cities = [...new Set(customers.map((c) => c.city).filter(Boolean))];
const noPermitCities = cities.filter((c) => !customers.some((x) => x.city === c && perm.has(x.id)));
r = await ask('which cities have no permits');
check('cities :: cities where no customer has a permit', noPermitCities.length ? text(r).startsWith(`${noPermitCities.length} cit`) && namesIn(r, noPermitCities) : /No cities/.test(text(r)), text(r));

/* ---- shares */
r = await ask('what percent of customers have a maintenance agreement');
check('share :: customers with an agreement, base stated', text(r).includes(`${int(agr.size)} of ${int(customers.length)} customers (${Math.round((agr.size / customers.length) * 1000) / 10}%)`), text(r));
r = await ask('percentage of customers in Mesa');
check('share :: customers in a city', text(r).includes(`${int(mesa.length)} of ${int(customers.length)} customers`), text(r));
r = await ask('what percent of installs have a startup sheet');
check('share :: units with a startup sheet', text(r).includes(`${int(unitStartup.size)} of ${int(units.length)} units`), text(r));

/* ================================================================== a group measured against itself */
const avgInv = invoices.reduce((a, d) => a + d.total, 0) / invoices.length;
const aboveInv = invoices.filter((d) => d.total > avgInv).length;
r = await ask('how many invoices are above average');
check('above average :: invoices above the average invoice', text(r).startsWith(`${int(aboveInv)} invoices above the average invoice total of ${usd(Math.round(avgInv * 100) / 100)}`) && /128|\d+ invoices compared/.test(text(r)), text(r));
const tk = {}; docs.filter((d) => d.type === 'service-ticket' && d.tech).forEach((d) => { tk[d.tech] = (tk[d.tech] || 0) + 1; });
const tkAvg = Object.values(tk).reduce((a, b) => a + b, 0) / Object.keys(tk).length;
const tkAbove = Object.keys(tk).filter((t) => tk[t] > tkAvg);
r = await ask('techs who did more tickets than average');
check('above average :: technicians above the average ticket count', tkAbove.length ? text(r).startsWith(`${tkAbove.length} technician`) && namesIn(r, tkAbove) : /No technicians/.test(text(r)), text(r));
const billed = new Map(); invoices.forEach((d) => d.custs.forEach((c) => billed.set(c, (billed.get(c) ?? 0) + d.total)));
const bAvg = [...billed.values()].reduce((a, b) => a + b, 0) / billed.size;
r = await ask('which customers are above the average invoice total');
check('above average :: customers above the average billed', text(r).startsWith(`${[...billed.values()].filter((v) => v > bAvg).length} customers`), text(r));

const ranked = [...billed.entries()].sort((a, b) => b[1] - a[1]);
const target = customers.find((c) => c.id === ranked[2][0]);
const rankOf = 1 + ranked.filter(([, v]) => v > ranked[2][1]).length;
r = await ask(`where does ${target.name} rank among customers by total billed`);
check('rank :: a customer by total billed', text(r).startsWith(`${target.name} ranks ${rankOf} of ${ranked.length} customers`), text(r));
const none = customers.find((c) => !billed.has(c.id));
if (none) {
  r = await ask(`rank of ${none.name} by revenue`);
  check('rank :: a customer with no invoice has no rank (never a zero)', /no invoice total on file, so there is no rank/.test(text(r)), text(r));
}
const cityUnits = {}; units.forEach((u) => { const c = customers.find((x) => x.id === u.cust)?.city; if (c) cityUnits[c] = (cityUnits[c] || 0) + 1; });
const cuSorted = Object.entries(cityUnits).sort((a, b) => b[1] - a[1]);
r = await ask(`rank of ${cuSorted[0][0]} among cities by unit count`);
check('rank :: a city by units', text(r).startsWith(`${cuSorted[0][0]} ranks 1 of ${cuSorted.length} cities`), text(r));

const nInv = docs.filter((d) => d.type === 'invoice').length; const nEst = docs.filter((d) => d.type === 'proposal-quote').length;
r = await ask('ratio of invoices to estimates');
check('ratio :: two kinds of paper', text(r).includes(`${Math.round((nInv / nEst) * 100) / 100} to 1`) && text(r).includes(`${int(nInv)} invoices`), text(r));
const rep = docs.filter((d) => d.type === 'service-ticket' && /^repair$/i.test(d.svc ?? '')).length; const pm = docs.filter((d) => d.type === 'service-ticket' && /preventive/i.test(d.svc ?? '')).length;
r = await ask('repair to pm ratio');
check('ratio :: two service types of the same ticket', text(r).includes(`${Math.round((rep / pm) * 100) / 100} to 1`), text(r));

const nVisits = docs.filter((d) => d.serviceDate).length;
r = await ask('average visits per customer');
check('per customer :: both denominators are shown', text(r).includes(`${int(nVisits)} across ${int(customers.length)} customers`) && text(r).includes(`among the ${int(customers.filter((c) => custsVisited.has(c.id)).length)} customers who have any`), text(r));
r = await ask('average billed per customer');
check('per customer :: billed per customer', text(r).includes(usd([...billed.values()].reduce((a, b) => a + b, 0))), text(r));

/* ---- a building: several customers at one street address with different apartment numbers */
const bldg = customers.filter((c) => /3300 S Alma School Rd/.test(c.address ?? ''));
const bldgBilled = invoices.filter((d) => d.custs.some((c) => bldg.some((b) => b.id === c))).reduce((a, d) => a + d.total, 0);
r = await ask('total billed for the Alma School building');
check('building :: total billed across the apartments at one address', bldg.length > 1 && text(r).includes(usd(bldgBilled)) && text(r).includes('3300 S Alma School Rd'), text(r));
r = await ask('which apartment in the Alma School building was billed the most');
const bb = bldg.map((b) => [b, invoices.filter((d) => d.custs.includes(b.id)).reduce((a, d) => a + d.total, 0)]).sort((a, b) => b[1] - a[1]);
check('building :: the apartment billed the most', text(r).includes(bb[0][0].name) && text(r).includes(usd(bb[0][1])), text(r));
r = await ask('which apartments in the Alma School building have no maintenance agreement');
check('building :: a missing paper inside one building', text(r).startsWith(`${bldg.filter((b) => !agr.has(b.id)).length} customers`) && !text(r).includes('Mesa Customer'), text(r));
await released('a building phrase that matches no building', 'total billed for the Nowhere Plaza building');

/* ---- billing shares, a period on a dollar condition, units by technician */
const totalBilled = invoices.reduce((a, d) => a + d.total, 0);
const mesaBilled = invoices.filter((d) => d.custs.some((c) => mesa.some((m) => m.id === c))).reduce((a, d) => a + d.total, 0);
r = await ask('how much of total billing is from Mesa customers');
check('share of billing :: dollars and percent, from customers in a city', text(r).includes(usd(mesaBilled)) && text(r).includes(`${Math.round((mesaBilled / totalBilled) * 1000) / 10}%`) && r.intent?.plan.op === 'set_select', text(r));
const top5 = [...billed.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
r = await ask('what percent of our invoicing comes from the top 5 customers');
check('share of billing :: the top 5 customers', text(r).includes(usd(top5)) && text(r).includes(`${Math.round((top5 / totalBilled) * 1000) / 10}%`), text(r));
const inYear = (d, y) => d.date.startsWith(String(y));
const b2025 = new Map(); invoices.filter((d) => inYear(d, 2025)).forEach((d) => d.custs.forEach((c) => b2025.set(c, (b2025.get(c) ?? 0) + d.total)));
r = await ask('customers who spent over 1000 in 2025');
check('billed in a period :: customers billed over an amount in one year', text(r).startsWith(`${[...b2025.values()].filter((v) => v > 1000).length} customer`) || (![...b2025.values()].some((v) => v > 1000) && /No customers/.test(text(r))), text(r));
const tech0 = techs[0];
const unitsBy = new Set(docs.filter((d) => d.serviceDate && d.tech === tech0).flatMap((d) => d.units));
r = await ask(`which units has ${tech0} serviced`);
check('hop :: units a technician has serviced (a service visit by that technician, tied to the unit)', unitsBy.size ? text(r).startsWith(`${unitsBy.size} unit`) : /No units/.test(text(r)), text(r));

/* ================================================================== releases: a negation or condition that cannot be applied is never dropped */
await released('a word nothing explains', 'customers with a frobnicated agreement but no estimate');
await released('contract is not agreement (no such kind of paper)', 'clients with a contract but no invoices');
await released('units and a paper not tied to units (agreements)', 'units with no maintenance agreement');
await released('units and a paper not tied to units (nameplate photos)', 'units with no nameplate photo');
await released('one customer cannot live in two cities', 'customers in Mesa and Tucson without an agreement');
await released('"without A and B" is ambiguous', 'customers without an invoice and a permit');
await released('"in the last year" is the calendar year or twelve months', 'customers with an agreement who havent had a visit in the last year');
await released('rank by "invoices" is a count or an amount', 'rank Linda Fitzgerald by invoices');
await released('"all" is a quantifier this family cannot apply', 'customers whose units are all out of warranty');
await released('a follow-up fragment', 'and the ones without an estimate?');
await released('payment status is not tracked', 'customers who have not paid but have an estimate');
await released('a paper kind the tenant never filed', 'customers with a receipt but no estimate');
await released('hr papers are never read', 'customers with an hr letter but no estimate');
await released('a name that is two things', `customers who have seen both ${techs[0]} and ${techs[1]}`, { tenantVocab: { ...tv, customers: { ...tv.customers, phrases: [...tv.customers.phrases, techs[0]] } } });

await released('a visit in 2024 and 2025 can mean either year (only "both" makes it two conditions)', 'customers who had a visit in 2024 and 2025');
await released('a rank with a tie (shared or numbered one after another is a choice nobody made)', 'rank Trane among brands by number of units');
await released('"each customer" without "on average" is a breakdown, not an average', 'how many units does each customer have');
await released('a per-unit average counts only papers tied to units, so it is left to the other lanes', 'average visits per unit');
await released('"average invoice per customer" is the size of an invoice or the number of them', 'average invoice per customer');
await released('a unit with a paper of its own cannot be split into two conditions', 'customers with a unit with a startup sheet');
await released('a service qualifier on a paper the family cannot apply', 'customers on a maintenance agreement who have never had a service invoice');
await released('the paper asked about is not the thing selected', 'repair tickets on Trane equipment');
{
  process.env.DONOVAN_DQL_SETS_OFF = 'set_rank';
  const off = parseDql(`where does ${target.name} rank among customers by total billed`, { tenantVocab: tv, pack, today: TODAY });
  const sel = parseDql('customers with an estimate but no agreement', { tenantVocab: tv, pack, today: TODAY });
  delete process.env.DONOVAN_DQL_SETS_OFF;
  check('knob :: DONOVAN_DQL_SETS_OFF turns one kind of question off and leaves the others', off === null && sel?.plan.op === 'set_select');
}

// a customer name on file twice: the run releases it (the existing clarify path asks which one)
{
  const tenId = (await getTenantContext(ctxArg.tenantKey, ctxArg.tenantName)).id;
  const dup = mesa[1].name;
  await lite.query('INSERT INTO entities (id, tenant_id, entity_type, data, customer_number) VALUES ($1,$2,$3,$4::jsonb,$5)',
    ['dab00000-0000-4000-8c00-0000000000e1', tenId, 'customer', JSON.stringify({ customer_name: dup, service_address: '1 Dup St, Mesa, AZ 85201' }), 'C-DUP0002']);
  resetTenantVocabCacheForTests();
  tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
  const intent = parseDql(`who else lives in Mesa besides ${dup}`, { tenantVocab: tv, pack, today: TODAY });
  const out = intent ? await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })) : null;
  check('ambiguous name :: a customer on file twice is released at run time', out === null, out?.text);
  r = await ask('customers with no documents at all');
  check('duplicate names :: the answer says one name is on file twice', /on file twice/.test(text(r)) || noDocs.length === 0, text(r));
  check('duplicate names :: two customers with one name are told apart by address in a list', new RegExp(`${dup} \\(1 Dup St, Mesa, AZ 85201\\)`).test(text(r)) && new RegExp(`${dup} \\(${mesa[1].address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).test(text(r)) || (noDocs.length === 0 && /Dup St/.test(text(r))), text(r));
}

/* ================================================================== merge fixes: lapsed customers, ratio sides, year ranks, same-name notes */
{
  // "haven't invoiced since 2024": customers who WERE invoiced and then stopped; one never invoiced at all is counted apart
  const invDates = new Map();
  for (const d of docs.filter((x) => x.type === 'invoice')) for (const c of d.custs) { if (!invDates.has(c)) invDates.set(c, []); invDates.get(c).push(d.date); }
  const lapsed = [...invDates.entries()].filter(([, ds]) => !ds.some((x) => x >= '2024-01-01')).length;
  const never = customers.filter((c) => !invDates.has(c.id)).length;
  r = await ask("customers we haven't invoiced since 2024");
  check('lapsed :: counts customers who were invoiced and then stopped', text(r).startsWith(`${int(lapsed)} customer`), text(r));
  check('lapsed :: says how many were never invoiced and are left out', never === 0 || new RegExp(`${never} more (?:has|have) never had one and (?:is|are) left out`).test(text(r)), text(r));
  r = await ask("customers without an invoice in 2024");
  check('lapsed :: a plain year is not "since": every customer without one counts', !/never had one/.test(text(r)), text(r));
}
await released('a person noun beside the paper of a ratio side', 'how many units per technician startup');
await released('a year-by-year rank (part year against full years)', 'what rank is 2024 for visit count');
r = await ask('which customers have no maintenance agreement');
check('lists :: the note about the definition comes before the names', /\)?: /.test(text(r)) && text(r).indexOf(':') < 400, text(r).slice(0, 200));

/* ================================================================== QA round: blanks are not "other", a PM visit is one condition */
{
  const eq = data.entities.filter((e) => e.entity_type === 'equipment' && !e.merged_into);
  const refrig = eq.filter((u) => String(u.data.refrigerant ?? '').trim());
  const blank = eq.length - refrig.length;
  const notR410 = refrig.filter((u) => !/^r-?410a$/i.test(String(u.data.refrigerant).trim())).length;
  r = await ask('equipment other than R-410A');
  check('not X :: units with no refrigerant on file are not counted as "not R-410A"', text(r).startsWith(`${int(notR410)} unit`) && (blank === 0 || text(r).includes(`${int(blank)} more`)), text(r));
  r = await ask('customers who never had a preventive maintenance visit');
  check('never had a PM visit :: customers with no visit at all are included', !/with a service visit but/.test(text(r)) && /without a preventive maintenance ticket/.test(text(r)), text(r));
}

/* ================================================================== the core family keeps what it answered */
r = await ask('how many customers in Mesa');
check('core :: a plain count is still the core family\'s', r.intent?.plan.op === 'count', JSON.stringify(r.intent?.plan.op));
r = await ask('how many Trane units do we have');
check('core :: a brand count is still the core family\'s', r.intent?.plan.op === 'count', JSON.stringify(r.intent?.plan.op));
r = await ask('what percent of service tickets are preventive maintenance');
check('core :: a one-condition share is still the core family\'s', r.intent?.plan.op === 'share_pct', JSON.stringify(r.intent?.plan.op));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
