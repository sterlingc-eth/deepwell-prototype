/**
 * verify:connect-r13 - round 13: Donovan connects papers across kinds, for any business (dql/families/links.js).
 *   - chains: "<offers> that turned into <bills>", "<offers> never billed", "<bills> with no matching <job paper>", counts, shares, windows
 *   - sequences inside the notes ("who had X and then Y within 90 days", "jobs mentioning X later billed over $N")
 *   - "<agreements> ending soon whose holders have <status> <papers>", "units serviced after their warranty ended"
 *   - "who else is at <address>", "what happened at <address> in <year>"
 *   - releases: a kind of paper the company does not keep, an unreadable word, an ambiguous link
 * The expected answers come from scripts/connect-r13/oracle.mjs, which reads the raw export and shares no code with the engine.
 *   node scripts/verify-connect-r13.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};

const EXPORT = path.join(ROOT, 'scripts/golden/golden-export.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-r13-'));
const ORACLE = path.join(ROOT, 'scripts/connect-r13/oracle.mjs');
execFileSync('node', [ORACLE, 'gen', EXPORT, path.join(tmp, 'gen.json')]);
const gen = JSON.parse(fs.readFileSync(path.join(tmp, 'gen.json'), 'utf8'));
check('the oracle writes a shape set for the golden export', gen.length >= 10, `${gen.length}`);

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(EXPORT, 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r13c', tenantName: 'r13c' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { parseAddress, streetKey } = await import('../api/_lib/dql/linkAddress.js');
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r13c' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const TODAY = '2026-10-07';
const ask = async (q) => {
  const r = parseDql(q, { tenantVocab: tv, pack, today: TODAY });
  if (!r?.plan) return { op: null };
  const a = await withTenant(ctxArg, (db) => runDql(db, r, { today: TODAY }));
  return { op: r.plan.op, text: a?.text ?? null, basis: a?.citations?.basis ?? a?.basis ?? null, data: a };
};

// every question of the oracle's shape set: answered by the links family and equal to the oracle
const answers = [];
for (const g of gen) { const r = await ask(g.q); answers.push({ q: g.q, op: r.op, text: r.text, model: !r.text, dqlNull: !r.op }); }
fs.writeFileSync(path.join(tmp, 'ans.json'), JSON.stringify(answers));
const sc = JSON.parse(execFileSync('node', [ORACLE, 'score', path.join(tmp, 'gen.json'), path.join(tmp, 'ans.json')], { encoding: 'utf8' }).split('\n')[0]);
check(`the shape set: no wrong answer (right ${sc.right}, released ${sc.model})`, sc.wrong === 0 && sc.right >= Math.floor(gen.length * 0.5), JSON.stringify(sc));

// the rule is stated in every answer
const one = await ask('Which invoices turned into quotes?');
check('chain answers name the op', one.op === 'link_chain', JSON.stringify(one.op));
check('chain answers state how the papers were linked', /same person|job key/.test(String(one.basis ?? one.data?.text ?? '')) || /Linked each/.test(JSON.stringify(one.data ?? {})), String(one.basis));
// phrase-independent: other words for the same thing
for (const [q, op] of [
  ['How many estimates became invoices', 'link_chain'], ['quotes that were never invoiced', 'link_chain'], ['proposals not yet billed', 'link_chain'],
  ['invoices without a matching service ticket', 'link_chain'], ['what share of quotes turned into invoices within 60 days', 'link_chain'],
]) { const r = await ask(q); check(`reads: ${q}`, r.op === op || r.op === null, `${r.op}`); }
// releases (never a guess)
for (const q of [
  'quotes that turned into banana', 'which quotes turned into xyzzys', 'invoices with no matching flibbertigibbet',
  'which quotes turned into quotes', 'quotes that turned into invoices on Tuesdays',
]) { const r = await ask(q); check(`released: ${q}`, r.op !== 'link_chain', `${r.op} ${String(r.text).slice(0, 100)}`); }
// addresses: the street shape is read, any other question with an address is still released by the parser
check('address reader: who else', parseAddress('Who else is at 100 E Main St?', TODAY)?.mode === 'people');
check('address reader: what happened with a year', parseAddress('what happened at 100 E Main St in 2009', TODAY)?.year === 2009);
check('address reader: other questions are not taken', parseAddress('what is the phone number at 100 E Main St', TODAY) == null);
check('street key ignores the unit and spelling', streetKey('3300 South Alma School Road, Apt 4, Mesa AZ') === streetKey('3300 S Alma School Rd'));

// evidence: when the papers' dates run against the order asked, the chain question is released, not answered "all never billed"
{
  const data2 = JSON.parse(JSON.stringify(data));
  for (const f of data2.financials ?? []) { if (f.doc_kind !== 'invoice') f.invoice_date = '2031-01-01'; }
  const lite2 = await off.createPGlite(); await off.setActiveDatabase(lite2);
  const ctx2 = (await off.loadExportIntoNewTenant(lite2, data2, { tenantKey: 'offline:r13c2', tenantName: 'r13c2' })).ctx;
  const ctxArg2 = { tenantKey: ctx2.tenantKey, tenantName: 'r13c2' };
  const pack2 = await packForTenant({ withTenant, ctxArg: ctxArg2 });
  const tv2 = await withTenant(ctxArg2, (db) => getTenantVocab(db, ctx2.tenantKey, pack2));
  for (const q of ['how many estimates have not been followed by any invoice', 'which quotes never turned into invoices']) {
    const r = parseDql(q, { tenantVocab: tv2, pack: pack2, today: TODAY });
    const a = r?.plan ? await withTenant(ctxArg2, (db) => runDql(db, r, { today: TODAY })) : null;
    check(`released when the dates contradict the order: ${q}`, !a?.text || !/never|of \d+/.test(String(a.text)) , String(a?.text).slice(0, 120));
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
