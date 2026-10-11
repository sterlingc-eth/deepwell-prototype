/**
 * verify:dql-learned - Donovan's learned planner (api/_lib/dql/learned): the plan-vocabulary table, the feature view, the guards (condition-word
 * releases), the shipped model file, the gate on recorded real cases (scripts/learned-fixtures.json: words the parser left over on factory
 * questions, with the outcome of ignoring them), the kill switch, and the wiring in parseDql on the golden export.
 *   node scripts/verify-dql-learned.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 300)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL_LEARNED; delete process.env.DQL_LEARNED_FORCE; delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const L = await import('../api/_lib/dql/learned/index.js');
const PM = await import('../api/_lib/dql/learned/planmap.js');
const FE = await import('../api/_lib/dql/learned/features.js');
const LIN = await import('../api/_lib/dql/learned/linear.js');
const modelPath = path.join(ROOT, 'api/_lib/dql/learned/model.json');
const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

/* ---- plan vocabulary table (factory -> DQL) */
const fh = (family, plan = {}, expect = { kind: 'number' }) => PM.factoryHeads({ family, plan, expect });
check('planmap :: count family', fh('count', { op: 'count', entity: 'doc', doc_type: 'invoice' }).op === 'count' && fh('count', { entity: 'doc', doc_type: 'invoice' }).doc === 'one');
check('planmap :: minmax follows args.fn', fh('minmax', { op: 'agg', args: { fn: 'min' } }).op === 'min' && fh('minmax', { op: 'agg', args: { fn: 'max' } }).op === 'max');
check('planmap :: top vs bottom', fh('top', { args: { dir: 'bottom', by: 'city' } }).op === 'bottom' && fh('top', { args: { dir: 'top', by: 'city' } }).group === 'city');
check('planmap :: first vs latest', fh('extreme_date', { args: { which: 'first' } }).op === 'first' && fh('extreme_date', { args: { which: 'last' } }).op === 'latest');
check('planmap :: untracked is a decline with an untracked measure', fh('untracked', { op: 'decline' }, { kind: 'decline' }).op === 'decline' && fh('pay', {}, { kind: 'decline' }).measure === 'untracked');
check('planmap :: money measure and dims', fh('sum', { op: 'agg', measure: 'total', args: { fn: 'sum' } }).measure === 'money' && fh('pivot', { args: { rowDim: 'month', colDim: 'quarter' } }).group === 'two' && fh('group', { args: { by: 'technician' } }).group === 'tech');
check('planmap :: customers entity and ratio pair', fh('cust_count', { entity: 'customer' }).entity === 'customer' && fh('ratio', { args: { a: 'invoice', b: 'receipt' } }).doc === 'pair');
check('planmap :: DQL plans read into the same labels', PM.dqlHeads({ op: 'group_avg', entity: 'document', docType: 'invoice', measure: { field: 'total', unit: 'money', agg: 'avg' }, groupBy: [{ by: 'city' }] }).group === 'city'
  && PM.dqlHeads({ op: 'top_n', entity: 'document', groupBy: [{ by: 'customer' }] }).op === 'top' && PM.dqlHeads({ op: 'tm_window', measure: { agg: 'count', entity: 'document', docType: 'permit' } }).doc === 'one'
  && PM.dqlHeads({ op: 'count', entity: 'customer', filters: [] }).entity === 'customer');
check('planmap :: HVAC patterns', PM.hvacHeads({ pattern: 'group_sum', plan: { entity: 'financial', measure: 'total', group_by: ['year(service_date)'] } }).group === 'year' && PM.hvacHeads({ pattern: 'decline_untracked', plan: {}, answerable: 'untracked' }).op === 'decline');

/* ---- feature view */
const w = FE.classifyWords(' tlel me how many permits there are ', '  tlel me                  there are ', ['tlel']);
check('features :: E / F / L classes', w.map((t) => t.k).join('') === 'LFEEEFF', w.map((t) => t.k).join(''));
const v = FE.viewTokens(w, new Set(['how', 'many']));
check('features :: names become slot placeholders, operator words stay', v.join(' ') === 'tlel me how many <s> there are', v.join(' '));
check('features :: numbers become a number placeholder', FE.viewTokens([{ w: '2024', k: 'E' }], new Set())[0] === '<n>');
check('features :: head feature set has unigrams, bigrams and trigrams', (() => { const f = FE.headFeats(['a', 'b']); return f.has('w:a') && f.has('b:a b') && f.has('t:^ a b'); })());

/* ---- guards: condition-like words release */
const g = (...ws) => L.guardReason('how many invoices ' + ws.join(' '), ws.map((x) => ({ w: x, k: 'L' })));
for (const [word, kind] of [['not', 'negation'], ['without', 'negation'], ['never', 'negation'], ['should', 'modality'], ['wanted', 'modality'], ['next', 'future'], ['upcoming', 'future'], ['per', 'scope'], ['each', 'scope'],
  ['over', 'condition'], ['under', 'scope'], ['oldest', 'condition'], ['average', 'condition'], ['overdue', 'condition'], ['unpaid', 'condition'], ['payment', 'noun'], ['balance', 'noun'], ['those', 'deictic'], ['2024', 'number'], ['$500', 'number']]) {
  check(`guard :: "${word}" releases (${kind})`, (g(word) ?? '').startsWith(kind), g(word));
}
check('guard :: plain filler words do not trip a guard', g('chek') === null && g('bought') === null && g('mentioned') === null);
check('guard :: soft words are left to the calibrated models', g('number') === null && g('repair') === null);
check('guard :: second clause releases', L.guardReason('how many invoices and also which customers', [{ w: 'also', k: 'L' }]) === 'second-clause');
check('guard :: a negation left standing in the question releases', (L.guardReason("how many invoices aren't from Bob", [{ w: 'bob', k: 'L' }]) ?? '').startsWith('negation'));

/* ---- the shipped model */
const size = fs.statSync(modelPath).size;
check('model :: JSON under 2.5 MB', size < 2.5e6, size);
check('model :: all heads and thresholds present', ['op', 'measure', 'entity', 'doc', 'group'].every((h) => model.heads[h]?.classes?.length && model.heads[h].T > 0) && model.tok && model.gate?.platt && model.thresholds?.gate >= 0.9);
const ph = L.predictHeads(['how', 'many', '<s>', 'in', '<n>']);
check('model :: heads classify "how many <s> in <n>" as a count of documents', ph.op.label === 'count' && ph.entity.label === 'document', JSON.stringify(ph));
check('model :: probabilities are a distribution', (() => { const r = LIN.classify(model.heads.op, FE.headFeats(['top', '<n>', '<s>'])); return Math.abs([...r.p].reduce((a, b) => a + b, 0) - 1) < 1e-9; })());
check('model :: group head reads "by city"', L.predictHeads(['average', '<s>', 'by', 'city']).group.label === 'city');

/* ---- the gate on recorded real cases */
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/learned-fixtures.json'), 'utf8'));
for (const c of fx.open) {
  const r = L.leftoverGate({ raw: c.q, orig: c.orig, rest: c.rest, left: c.left, debug: {} });
  check(`gate opens :: ${c.q.slice(0, 70)} [${c.left.join(' ')}]`, Boolean(r?.clear));
}
for (const c of fx.shut) {
  const r = L.leftoverGate({ raw: c.q, orig: c.orig, rest: c.rest, left: c.left, debug: {} });
  check(`gate releases :: ${c.q.slice(0, 70)} [${c.left.join(' ')}]`, r === null);
}
process.env.DONOVAN_DQL_LEARNED = '0';
check('kill switch :: DONOVAN_DQL_LEARNED=0 never opens the gate', fx.open.every((c) => L.leftoverGate({ raw: c.q, orig: c.orig, rest: c.rest, left: c.left, debug: {} }) === null));
delete process.env.DONOVAN_DQL_LEARNED;
check('no leftover words :: nothing to decide', L.leftoverGate({ raw: 'x', orig: ' a ', rest: '   ', left: [], debug: {} }) === null);

/* ---- wiring in parseDql on the golden export */
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:learned', tenantName: 'learned' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql } = await import('../api/_lib/dql/parse.js');
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'learned' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const ask = (q, extra = {}) => { const debug = {}; const r = parseDql(q, { tenantVocab: tv, pack, today: '2026-10-07', debug, ...extra }); return { r, debug }; };
check('parse :: a plain question is untouched by the learned planner', ask('how many invoices do we have').r?.plan.op === 'count');
check('parse :: a follow-up reference is never guessed ("which brands were those")', ask('which brands were those').r === null);
check('parse :: a negation is released', ask('how many invoices not from Acme').r === null);
check('parse :: an unknown concept word is released', ask('how many invoices did we send to the moon').r === null);
process.env.DQL_LEARNED_FORCE = '1';
const forced = ask('how many invoices do we have maybe');
delete process.env.DQL_LEARNED_FORCE;
check('parse :: the gate is the only thing between a leftover word and an answer (forced open => answered)', forced.r?.plan.op === 'count' && forced.debug.learned?.forced === true, JSON.stringify(forced.debug.why));
check('parse :: without the force the same question still releases', ask('how many invoices do we have maybe').r === null);
process.env.DONOVAN_DQL_LEARNED = '0';
check('parse :: kill switch leaves the deterministic parse as it was', ask('how many invoices do we have maybe').r === null);
delete process.env.DONOVAN_DQL_LEARNED;

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
