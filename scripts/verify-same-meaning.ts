/**
 * F4 - same meaning, different words. No network, no real model, PGlite golden data.
 *   tsx scripts/verify-same-meaning.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ANTHROPIC_API_KEY;
let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); if (!ok) failed++; };
const realLog = console.log;
console.log = (...a: any[]) => { if (typeof a[0] === 'string' && a[0].startsWith('{"')) return; realLog(...a); };
if (!process.argv.includes("--probe")) { console.warn = () => {}; console.error = () => {}; }

// @ts-ignore plain JS
const off: any = await import(path.join(root, 'scripts/offline-exam.mjs'));
await off.installPgHarness();
await off.installModelBlock();
// @ts-ignore
const { default: Anthropic } = await import(path.join(root, 'node_modules/@anthropic-ai/sdk/index.mjs'));
const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'x' }).messages);
const blocked = proto.create;
let modelCalls = 0;
proto.create = async function (...a: any[]) { modelCalls++; return blocked.apply(this, a); };
// @ts-ignore
const { askViaHandler } = await import(path.join(root, 'api/_lib/scorecard/askCall.js'));
// @ts-ignore
const { default: askHandler } = await import(path.join(root, 'api/ask.js'));
// @ts-ignore
const { withTenant } = await import(path.join(root, 'api/_lib/recordsStore.js'));
// @ts-ignore
const { repeatPartUnits } = await import(path.join(root, 'api/_lib/relations/connect2.js'));
// @ts-ignore
const { detectRepeatFailureInsights } = await import(path.join(root, 'api/_lib/insights/detectors/repeatFailures.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:sm', tenantName: 'sm' })).ctx;
const TODAY = '2026-10-07';
async function ask(q: string) {
  modelCalls = 0;
  const r = await askViaHandler({ handler: askHandler, auth: { tenantId: ctx.tenantKey, orgId: 'sm', userId: null }, question: q, today: TODAY });
  return { kind: r?.data?.kind as string | undefined, text: String(r?.data?.text ?? ''), model: modelCalls > 0 };
}
const truth = (sql: string, params: unknown[] = []) => withTenant({ tenantKey: ctx.tenantKey, tenantName: 'sm' }, async (db: any) => (await db.raw(sql, params)).rows);

const PROBE = process.argv.includes('--probe');
if (PROBE) {
  for (const q of process.argv.slice(3)) { const r = await ask(q); realLog(JSON.stringify({ q, ...r })); }
  process.exit(0);
}

const noModel = (r: any) => !r.model;
const num = (t: string) => Number((t.match(/(\d[\d,]*)/) ?? [])[1]?.replace(/,/g, ''));

/* ---------- 1. screenshot case: a part replaced more than once, any wording; equals the dashboard's number */
const dash: any = await withTenant({ tenantKey: ctx.tenantKey, tenantName: 'sm' }, async (db: any) => {
  const ins = await detectRepeatFailureInsights(db, { today: TODAY });
  const part = ins.find((i: any) => i.id === 'repeat-part-failures');
  const direct = await repeatPartUnits(db);
  return { dashCount: part?.count ?? 0, directCount: direct.units.length };
});
check('part-replaced: shared computation equals dashboard count', dash.dashCount === dash.directCount && dash.dashCount > 0, dash);
const PART_WORDINGS = [
  'Which units have had a part replaced more than once?',
  'which machines had a part swapped twice or more',
  'List the systems where a component was changed multiple times',
  'how many assets have had a part replaced repeatedly',
  'what equipment has had parts replaced more than one time',
];
for (const q of PART_WORDINGS) {
  const r = await ask(q);
  check(`part-replaced wording: ${q}`, r.kind === 'answer' && noModel(r) && num(r.text) === dash.dashCount, r);
}
const lst = await ask('Which units have had a part replaced more than once?');
check('part-replaced list names the units, not only a count', /'s /.test(lst.text), lst.text);

/* ---------- 2. screenshot case: documents over $500 */

const docsOver = async (cmp: string, v: number, kinds?: string[]) => (await truth(
  `SELECT count(*)::int AS n FROM document_financials f WHERE f.currency='USD' AND f.total IS NOT NULL AND f.total ${cmp} $1 AND f.doc_kind IN (${(kinds ?? ['invoice', 'credit_memo', 'statement', 'receipt', 'estimate', 'change_order', 'po', 'agreement']).map((k) => `'${k}'`).join(',')})`, [v]))[0].n;
{
  const r = await ask('Documents over $500');
  const want = await docsOver('>', 500);
  check('documents over $500: count first, no model, equals records', r.kind === 'answer' && noModel(r) && /^\d+ documents? (?:is|are) over \$500/.test(r.text) && num(r.text) === want, { r, want });
  for (const [q, cmp, v] of [['docs above $500', '>', 500], ['paperwork more than $500', '>', 500], ['documents at least $500', '>=', 500], ['papers under $100', '<', 100], ['files below $100', '<', 100], ['documents less than $100', '<', 100]] as const) {
    const a = await ask(q); const w = await docsOver(cmp, v);
    check(`threshold wording: ${q}`, a.kind === 'answer' && noModel(a) && num(a.text) === w, { a, w });
  }
  const rc = await ask('agreements over $1000'); const wc = await docsOver('>', 1000, ['agreement']);
  check('threshold takes the type from the noun (agreements)', noModel(rc) && /agreement/.test(rc.text) && num(rc.text) === wc, { rc, wc });
  const rr = await ask('receipts under $50');
  check('threshold on a type with no rows says so, never an invoice figure', noModel(rr) && !/invoice/.test(rr.text), rr);
  const ri = await ask('invoices over $500'); const wi = (await truth(`SELECT count(*)::int AS n FROM document_financials f WHERE f.direction='receivable' AND f.doc_kind='invoice' AND f.currency='USD' AND f.total > 500`))[0].n;
  check('invoice threshold unchanged', ri.kind === 'answer' && noModel(ri) && num(ri.text) === wi, { ri, wi });
}

/* ---------- 3. word classes: same meaning, different words */
const sameAs = async (a: string, b: string, label: string) => {
  const [x, y] = [await ask(a), await ask(b)];
  check(`same meaning: ${label}`, x.kind === 'answer' && noModel(x) && x.text === y.text && y.kind === 'answer', { a: x.text, b: y.text });
};
await sameAs('how many machines do we have', 'how many units do we have', 'machines = units');
await sameAs('how many contracts do we have', 'how many maintenance agreements do we have', 'contracts = maintenance agreements');
{ const [a, b] = [await ask('how many memberships'), await ask('how many maintenance agreements do we have')]; check('same meaning: memberships = maintenance agreements', a.kind === 'answer' && noModel(a) && num(a.text) === num(b.text), { a: a.text, b: b.text }); }
await sameAs('how many papers on file', 'how many documents do we have', 'papers = documents');
await sameAs('list the guys we send out', 'list technicians', 'guys we send out = technicians');
await sameAs('how many installers', 'how many technicians do we have', 'installers = technicians');
await sameAs('which customers have outstanding balances', 'which customers owe us money', 'outstanding balances = owes');
for (const [q, noun] of [['how many receipts do we have', 'receipt'], ['how many delivery tickets do we have', 'delivery'], ['how many pickup tickets', 'delivery'], ['how many price lists', 'price list'], ['how many COIs on file', 'insurance certificate'], ['how many certificates of insurance', 'insurance certificate'], ['how many HR letters', 'letter'], ['how many statements do we have', 'statement']] as const) {
  const r = await ask(q);
  check(`new document type words: ${q}`, r.kind === 'answer' && noModel(r) && new RegExp(noun, 'i').test(r.text) && /\b\d+\b/.test(r.text), r);
}

/* ---------- 4. leftover-word guard: known silent wrong answers */
const total = (await truth(`SELECT count(*)::int AS n FROM entities WHERE entity_type='customer'`).catch(() => [{ n: 120 }]))[0].n;
{
  const agree = await ask('which homeowners signed a service plan');
  const w = (await truth(`SELECT count(DISTINCT l.entity_id)::int AS n FROM document_entity_links l`).catch(() => [{ n: -1 }]))[0].n;
  check('homeowners signed a service plan is not the all-customers count', !(num(agree.text) === total && /customers\.$/.test(agree.text)) && noModel(agree), agree);
  const t = await ask('list the techs we use');
  check('list the techs we use lists technicians, not customers', /technician/i.test(t.text) && !/customers/.test(t.text) && noModel(t), t);
  const g = await ask('which homeowners signed a warranty extension');
  check('an unknown condition is never answered with the plain customer list', !/^\d+ customers\.$/.test(g.text), g);
  const same = await ask('which customers have a maintenance agreement');
  check('homeowners signed a service plan = customers with a maintenance agreement', agree.text === same.text, { agree: agree.text, same: same.text });
  void w;
  const ok = await ask('list all the customers please');
  check('plain list wording still answered', /^\d+ customers\.$/.test(ok.text) && noModel(ok), ok);
}
{
  const y = await ask('invoices 2025'); const y2 = await ask('how many invoices in 2025');
  check('invoices 2025 is a year, not $2,025', !/\$2,025/.test(y.text) && y.text === y2.text && y.kind === 'answer', { y, y2 });
  const y3 = await ask('2025 invoices');
  check('2025 invoices is a year', !/\$2,025/.test(y3.text) && y3.text === y2.text, y3);
  const m = await ask('invoice for $2025');
  check('a $ sign keeps it an amount', /\$2,025/.test(m.text), m);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
