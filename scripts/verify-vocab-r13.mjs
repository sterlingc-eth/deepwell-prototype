/**
 * verify:vocab-r13 - Donovan's reading of a company's own papers does not depend on knowing the industry.
 *
 * 13 companies (an HVAC shop plus 12 other kinds of business; scripts/golden/industries + scripts/golden/r13, trimmed from the question factory's synthetic
 * companies) are each loaded into a tenant WITH NO INDUSTRY SETTING. For every kind of paper a company stores, in that company's own words (the type id), DQL
 * must give the right count, the latest, and the total, checked against an independent reading of the export. The same holds for its people, whatever the
 * business calls them. Further cases show capabilities that used to switch on for one industry only (a company's own paper words, "jobs", the word the owner
 * used for the people) working when the industry is unknown, and honest releases for words that match nothing the company stores.
 *
 *   node scripts/verify-vocab-r13.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

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
const { arbiterAllows } = await import('../api/_lib/router/dqlArbiter.js');

const TODAY = '2026-10-07';
const FILES = {
  hvac: 'r13/hvac.json', auto: 'r13/auto.json', cleaning: 'r13/cleaning.json', dental: 'r13/dental.json', electrical: 'r13/electrical.json', hoa: 'r13/hoa.json', landscaping: 'r13/landscaping.json', plumbing: 'r13/plumbing.json',
  legal: 'industries/legal.json', medical: 'industries/medical.json', nonprofit: 'industries/nonprofit.json', property: 'industries/property.json', construction: 'industries/construction.json',
};
const PEOPLE = { hvac: 'customers', auto: 'customers', cleaning: 'customers', dental: 'patients', electrical: 'customers', hoa: 'homeowners', landscaping: 'customers', plumbing: 'customers', legal: 'clients', medical: 'patients', nonprofit: 'donors', property: 'tenants', construction: 'clients' };
const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => n.toLocaleString('en-US');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const plural = (s) => (/(?:s|x|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const human = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function company(key, industry) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', FILES[key]), 'utf8'));
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r13-${key}-${industry ?? 'none'}`, tenantName: key });
  if (industry) await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{industry}', to_jsonb($1::text)) WHERE id = $2", [industry, loaded.tenantId]);
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, loaded.ctx.tenantKey, pack));
  const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
  const fieldsOf = new Map();
  for (const x of data.extractions) { if (!fieldsOf.has(x.document_id)) fieldsOf.set(x.document_id, {}); fieldsOf.get(x.document_id)[x.field_key] = eff(x); }
  const finOf = new Map(data.financials.map((f) => [f.document_id, f]));
  const docs = data.documents.filter((d) => d.document_type !== 'hr-letter' && fieldsOf.get(d.id)?._audience !== 'internal').map((d) => {
    const f = fieldsOf.get(d.id) ?? {}; const fin = finOf.get(d.id);
    return { id: d.id, type: d.document_type, total: fin?.total != null ? Number(fin.total) : null, date: String(f.service_date ?? f.invoice_date ?? fin?.invoice_date ?? d.created_at).slice(0, 10), visit: Boolean(f.service_date), tech: f.technician ?? null };
  });
  const customers = data.entities.filter((e) => e.entity_type === 'customer');
  const ents = new Map(data.entities.map((e) => [e.id, e]));
  const custOf = new Map();
  for (const l of data.document_entity_links) { const e = ents.get(l.entity_id); if (e?.entity_type === 'customer') custOf.set(l.document_id, e.data.customer_name); }
  for (const d of data.documents) { const row = docs.find((x) => x.id === d.id); if (row) row.cust = custOf.get(d.id) ?? null; }
  const units = data.entities.filter((e) => e.entity_type === 'equipment');
  const ask = async (q) => {
    const debug = {};
    const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, debug });
    if (!intent) return { intent, data: null, why: debug.why };
    return { intent, data: await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })) };
  };
  return { key, docs, customers, units, ents, ask, tv };
}

/* ---- every company, industry unknown: every stored kind of paper, in the company's own words */
const KEYS = Object.keys(FILES);
const C = {};
for (const k of KEYS) C[k] = await company(k, null);
for (const k of KEYS) {
  const c = C[k];
  const types = [...new Set(c.docs.map((d) => d.type))];
  for (const t of types) {
    const rows = c.docs.filter((d) => d.type === t);
    const ph = plural(t.replace(/-/g, ' '));
    let r = await c.ask(`how many ${ph} do we have`);
    check(`${k} ${t} :: count in the company's own words`, r.data && r.data.text.includes(int(rows.length)), r.data?.text ?? r.why);
    const past = rows.filter((d) => d.date <= TODAY).sort((a, b) => b.date.localeCompare(a.date))[0];
    r = await c.ask(`what is the latest ${t.replace(/-/g, ' ')}`);
    check(`${k} ${t} :: latest`, !past || (r.data && r.data.text.includes(human(past.date))), r.data?.text ?? r.why);
    const withTotal = rows.filter((d) => d.total != null);
    if (withTotal.length) { r = await c.ask(`what is the total of all ${ph}`); check(`${k} ${t} :: total`, r.data && r.data.text.includes(money(sum(withTotal.map((d) => d.total)))), r.data?.text ?? r.why); }
  }
  // its people, in whatever word that business uses
  let r = await c.ask(`how many ${PEOPLE[k]} do we have`);
  check(`${k} people :: "${PEOPLE[k]}" are the customers with the industry unknown`, (r.data && r.data.text.includes(int(c.customers.length))) || (r.intent?.plain === true && r.intent.plan.entity === 'customer'), r.data?.text ?? r.why);
  if (PEOPLE[k] !== 'customers' && r.data) check(`${k} people :: the answer says the owner's own word`, new RegExp(`\\b${PEOPLE[k].replace(/s$/, '')}`).test(r.data.text), r.data?.text);
}

/* ---- capabilities that used to need the industry setting */
{
  // a company's own paper word wins over a shared phrase for a kind it does not keep: "agreements" in an office with agreement papers and no maintenance agreements
  const c = C.dental; let r = await c.ask('how many agreements do we have');
  check('unknown industry :: "agreements" are the agreement papers this company keeps', r.data && r.data.text.includes(int(c.docs.filter((d) => d.type === 'agreement').length)) && !/maintenance/.test(r.data.text), r.data?.text ?? r.why);
  check('unknown industry :: an inventory of a company-own paper word is DQL\'s, not a plain count for the older lanes', r.intent && r.intent.plain === false, JSON.stringify(r.intent?.plain));
  r = await c.ask('how many correspondences do we have');
  check('unknown industry :: the plural of a stored kind ("correspondences") is read', r.data && r.data.text.includes(int(c.docs.filter((d) => d.type === 'correspondence').length)), r.data?.text ?? r.why);
}
{
  // a head noun that names exactly one stored kind is that kind; one that names several asks for all of them
  const c = C.property; const ins = c.docs.filter((d) => /inspection/.test(d.type)).length;
  let r = await c.ask('how many inspections do we have');
  check('unknown industry :: "inspections" with only move-in / move-out inspections on file counts both', r.data && r.data.text.includes(int(ins)), r.data?.text ?? r.why);
  r = await c.ask('how many leases do we have');
  check('unknown industry :: leases are the lease papers', r.data && r.data.text.includes(int(c.docs.filter((d) => d.type === 'lease-agreement').length)), r.data?.text ?? r.why);
}
{
  // the words other kinds of business use are read for everyone (the staff noun is the person who did the work)
  const c = C.legal; const techs = new Set(c.docs.map((d) => d.tech).filter(Boolean));
  let r = await c.ask('how many different attorneys');
  check('unknown industry :: "attorneys" is the person who did the work', r.data && r.data.text.includes(int(techs.size)), r.data?.text ?? r.why);
  r = await C.hvac.ask('how many different providers');
  check('hvac, unknown industry :: "providers" is read the same way', r.data && /\d/.test(r.data.text), r.data?.text ?? r.why);
}
{
  // questions the records lane steps aside on: the Nth visit of a customer, and a company's own word for what it services
  const c = C.auto;
  const byCust = new Map(); for (const d of c.docs.filter((x) => x.visit && x.cust)) byCust.set(d.cust, [...(byCust.get(d.cust) ?? []), d.date]);
  const [name, dates] = [...byCust.entries()].find(([, v]) => new Set(v).size === v.length && v.length >= 3) ?? [];
  if (name) {
    const sorted = [...dates].sort();
    let r = await c.ask(`what was the second visit for ${name}`);
    check('ordinal :: "the second visit for X" is the second visit counting from the first', r.data && r.data.text.includes(human(sorted[1])), r.data?.text ?? r.why);
    r = await c.ask(`${name} third visit`);
    check('ordinal :: "X third visit" reads the same way', r.data && r.data.text.includes(human(sorted[2])), r.data?.text ?? r.why);
    r = await c.ask(`what was ${name}'s first visit`);
    check('ordinal :: the first visit is the earliest', r.data && r.data.text.includes(human(sorted[0])), r.data?.text ?? r.why);
  }
  const withUnit = c.units.find((u) => u.customer_id && u.data.model && c.ents.get(u.customer_id));
  if (withUnit) {
    const nm = c.ents.get(withUnit.customer_id).data.customer_name;
    const r = await c.ask(`what car models does ${nm} have`);
    check('learned word :: "car models" is the model of the vehicles this company services', r.data && r.data.text.includes(withUnit.data.model), r.data?.text ?? r.why);
    const r2 = await C.hvac.ask('what car models does anyone have');
    check('learned word :: a company that stores no vehicles is not told about cars', !r2.data, r2.data?.text);
  }
  const r3 = await C.legal.ask('which customer uses nobody@email.com');
  check('learned word :: the domain of an address is not the kind of paper "email"', !r3.data || !/correspondence|emails?\b.*on file/.test(r3.data.text), r3.data?.text);
}

{
  // words that match nothing the company stores are released, never answered with something else
  for (const [k, q] of [['dental', 'how many frobnicators do we have'], ['hvac', 'how many zorbulators do we have'], ['legal', 'what is our no-show rate'], ['property', 'what is the vacancy rate']]) {
    const r = await C[k].ask(q); check(`${k} release :: ${q}`, !r.data, r.data?.text);
  }
}
{
  // the arbiter no longer asks which industry: a non-plain question DQL fully reads is DQL's for an HVAC shop and for an unknown industry alike
  const intent = { plan: { op: 'count', entity: 'document' }, plain: false };
  for (const kind of [null, 'hvac', 'legal', undefined]) check(`arbiter :: takes a fully read question (industry ${kind})`, arbiterAllows({}, intent, { oldLabel: 'x', question: 'q', industryKind: kind }) === true);
  check('arbiter :: a plain inventory still goes to the older lanes', arbiterAllows({}, { plan: { op: 'count' }, plain: true }, { industryKind: null }) === false);
}
{
  // the same company with an industry chosen answers the same
  const c = C.dental; const tv2 = { ...c.tv, industryKind: 'dental' };
  const ctxArg = { tenantKey: 'offline:r13-dental-none', tenantName: 'dental' };
  const pack = await packForTenant({ withTenant, ctxArg });
  for (const q of ['how many service tickets do we have', 'how many receipts do we have', 'how many agreements do we have']) {
    const a = await c.ask(q);
    const i2 = parseDql(q, { tenantVocab: tv2, pack, today: TODAY });
    const b = i2 ? await withTenant(ctxArg, (db) => runDql(db, i2, { today: TODAY })) : null;
    check(`dental :: ${q} is the same with and without the industry`, a.data && b && a.data.text.replace(/\D+/g, ' ') === b.text.replace(/\D+/g, ' '), `${a.data?.text} || ${b?.text}`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
