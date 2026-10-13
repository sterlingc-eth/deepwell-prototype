/**
 * verify:unseen-r20 - questions about papers whose date and number fields are named by the company itself.
 *
 * For companies Donovan has never seen (a gym, a storage site) the end date of a waiver, a lease or an insurance proof sits under the company's own key
 * (cert_expires, rental_term "start - end", insurance_ends), and a paper's own number under its own key (billing_ref, rent_ref). The card finds them; the answers are
 * checked against counts made straight from the stored fields here. Also: pictures and lead-ins round a question, "and the sum of them".
 *
 *   node scripts/verify-unseen-r20.mjs
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

const { dqlFrame, dqlParaphrase } = await import('../api/_lib/dql/frame.js');
// chatter round a question: pictures, new lead-ins and tails
check('a picture before the question is dropped', dqlFrame('🤔 First week here, where is Pat Lee located') === 'where is Pat Lee located', dqlFrame('🤔 First week here, where is Pat Lee located'));
check('"i am not sure," is dropped', !/not sure/i.test(dqlFrame("I'm not sure, any booking contract numbers used twice")));
check('"cheers" tail is dropped', !/cheers/i.test(dqlFrame('how many service tickets in 2022 cheers')));
check('"and the sum of them" reads as "and the total"', /and the total$/i.test(dqlParaphrase(dqlFrame('how many supply order papers we had and the sum of them when you can'))), dqlParaphrase(dqlFrame('how many supply order papers we had and the sum of them when you can')));
check('"and what they total" reads as "and the total"', /and the total$/i.test(dqlParaphrase('how many tuition receipts for Ryan Murphy in 2025 and what they total')));
check('a condition word is not dropped with the picture', /not/i.test(dqlFrame('🙏 invoices not paid in 2022')));

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');

const TODAY = '2026-10-07';
const load = async (key) => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'r16', `${key}.json`), 'utf8'));
  const loaded = await off.loadExportIntoNewTenant(lite, data, { tenantKey: `offline:r20-${key}`, tenantName: key });
  await lite.query("UPDATE tenants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{industry}', to_jsonb($1::text)) WHERE id = $2", ['other', loaded.tenantId]);
  const ctxArg = { tenantKey: loaded.ctx.tenantKey, tenantName: key };
  const pack = await packForTenant({ withTenant, ctxArg });
  const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, loaded.ctx.tenantKey, pack));
  const type = new Map(data.documents.map((d) => [d.id, d.document_type]));
  const rows = (ty, field) => data.extractions.filter((e) => e.field_key === field && type.get(e.document_id) === ty).map((e) => ({ id: e.document_id, v: String(e.value) }));
  const ask = async (q) => { const intent = parseDql(dqlFrame(q), { tenantVocab: tv, pack, today: TODAY, original: q }); if (!intent || intent.plain) return null; return withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY })); };
  return { data, rows, ask };
};
const yearOf = (v) => { const t = v.includes(' - ') ? v.split(' - ').pop() : v; const m = /(\d{4})/.exec(t); return m ? m[1] : null; };

{ // a gym: a single end date (cert_expires) and a "start - end" term (commit_term)
  const g = await load('gym');
  const n19 = g.rows('injury-waiver', 'cert_expires').filter((r) => yearOf(r.v) === '2019').length;
  let a = await g.ask('how many injury waivers expire in 2019?');
  check(`gym: injury waivers expiring in 2019 = ${n19}`, a != null && new RegExp(`\\b${n19}\\b`).test(a.text), a?.text);
  const t19 = g.rows('membership-agreement', 'commit_term').filter((r) => yearOf(r.v) === '2019').length;
  a = await g.ask('Hey Donovan, how many membership agreements end in 2019 thanks?');
  check(`gym: membership agreements ending in 2019 = ${t19}`, a != null && new RegExp(`\\b${t19}\\b`).test(a.text), a?.text);
  // a kind with no end field is not answered with a made-up one
  a = await g.ask('how many class pass receipts expire in 2019?');
  check('gym: a kind with no end date is released', a == null, a?.text);
  // numbers used twice under the company's own key
  const refs = g.rows('membership-agreement', 'billing_ref'); const seen = new Map(); for (const r of refs) seen.set(r.v.toLowerCase(), (seen.get(r.v.toLowerCase()) ?? 0) + 1);
  const dup = [...seen].filter(([, c]) => c > 1).map(([k]) => k);
  a = await g.ask("I'm not sure, any membership agreement numbers used twice?");
  check(`gym: repeated membership agreement numbers (${dup.join(', ')}) are named`, a != null && dup.length > 0 && dup.every((k) => a.text.toLowerCase().includes(k)), a?.text);
  // two papers by number, days apart (the dates sit under billed_date)
  const dd = (x) => new Date(`${x}T00:00:00Z`).getTime();
  const find = (ty, ref) => { const r = g.rows(ty, 'billing_ref').find((x) => x.v === ref); return r ? g.rows(ty, 'billed_date').find((x) => x.id === r.id)?.v : null; };
  const d1 = find('monthly-dues-statement', 'MD-1642'); const d2 = find('class-pass-receipt', 'CP-1564');
  a = await g.ask('how many days apart are monthly dues statement MD-1642 and class pass receipt CP-1564?');
  const days = d1 && d2 ? Math.abs(Math.round((dd(d1) - dd(d2)) / 86400000)) : null;
  check(`gym: MD-1642 and CP-1564 are ${days} days apart`, a != null && days != null && new RegExp(`\\b${days}\\b`).test(a.text), a?.text);
}
{ // a storage site: a lease term and an insurance proof end date
  const s = await load('storage');
  const n = s.rows('tenant-insurance-proof', 'insurance_ends').filter((r) => yearOf(r.v) === '2019').length;
  const a = await s.ask('count the tenant insurance proofs ending in 2019 please');
  check(`storage: insurance proofs ending in 2019 = ${n}`, a != null && new RegExp(`\\b${n}\\b`).test(a.text), a?.text);
  const refs = s.rows('monthly-rent-bill', 'rent_ref'); const seen = new Map(); for (const r of refs) seen.set(r.v.toLowerCase(), (seen.get(r.v.toLowerCase()) ?? 0) + 1);
  const dup = [...seen].filter(([, c]) => c > 1).map(([k]) => k);
  const b = await s.ask('any rent bill numbers used twice');
  check(`storage: repeated rent bill numbers (${dup.join(', ')}) are named`, b != null && dup.length > 0 && dup.every((k) => b.text.toLowerCase().includes(k)), b?.text);
}
console.log = realLog;
console.log(`verify:unseen-r20 ${failures ? 'FAILED' : 'ok'}: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
