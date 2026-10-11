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
check('model :: JSON under 4 MB', size < 4.0e6, size);
check('model :: round-2 format (hashed heads, word clusters)', model.version === 2 && model.hash?.bits === 22 && model.clusters?.length === 2, JSON.stringify(model.hash));
check('model :: all heads, the verify gate and thresholds present', ['op', 'measure', 'entity', 'doc', 'group'].every((h) => model.heads[h]?.classes?.length && model.heads[h].T > 0) && model.tok && model.verify?.platt && model.thresholds?.verify >= 0.85 && model.thresholds?.tok >= 0.8);
const ph = L.predictHeads(['how', 'many', '<s>', 'in', '<n>']);
check('model :: heads classify "how many <s> in <n>" as a count of documents', ph.op.label === 'count' && ph.entity.label === 'document', JSON.stringify(ph));
const CLU = model.clusters.map((o) => new Map(Object.entries(o)));
check('model :: probabilities are a distribution', (() => { const r = LIN.classify2(model.heads.op, FE.hashIds(FE.headFeats2(['top', '<n>', '<s>'], CLU))); return Math.abs([...r.p].reduce((a, b) => a + b, 0) - 1) < 1e-9; })());
check('model :: group head reads "by city"', L.predictHeads(['average', '<s>', 'by', 'city']).group.label === 'city');


/* ---- round 2: hashed features (the trainer's feature function and the runtime's must agree bit for bit) */
check('features2 :: crc32 of a known string', FE.crc32('hello') === 0x3610a686 && FE.crc32('') === 0, FE.crc32('hello'));
{
  const f2 = FE.headFeats2(['how', 'many', '<s>', 'tallys'], CLU);
  check('features2 :: word n-grams, skip-grams, char n-grams, cluster n-grams and length are all there', f2.has('b:how many') && f2.has('t:^ how many') && f2.has('sk:how_<s>') && f2.has('sk3:how_tallys') && f2.has('hc: ho') && f2.has('hc:allys') && [...f2].some((x) => x.startsWith('ka2:')) && [...f2].some((x) => x.startsWith('kb1:')) && f2.has('len:4'), [...f2].slice(0, 12).join('|'));
  check('features2 :: placeholders get no char grams', ![...FE.headFeats2(['<s>', '<n>'], CLU)].some((x) => x.startsWith('hc:')));
}
const par = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/learned-parity.json'), 'utf8')).rows;
check('features2 :: bucket ids match the Python trainer on recorded views', par.every((r) => { const ids = [...FE.hashIds(FE.headFeats2(r.v, CLU))].sort((a, b) => a - b); return ids.length === r.n && ids.reduce((a, b) => a + b, 0) === r.sum && r.first.every((x, i) => x === ids[i]); }));
check('clusters :: synonyms the corpus itself shows share a cluster (average / avg, invoices / bills, latest / newest)', ['average|avg', 'invoices|bills', 'latest|newest'].every((p) => { const [a, b] = p.split('|'); return CLU[0].get(a) !== undefined && CLU[0].get(a) === CLU[0].get(b); }));
check('clusters :: the table is small', JSON.stringify(model.clusters).length < 250000);
const pw = (q) => L.predictHeads(q.split(' '));
check('heads :: "<n> <s> in <n>" style telegraphic wording still reads as a count', pw('how many <s> in <n>').op.label === 'count' && pw('number of <s> <s> in <n>').op.label === 'count');
check('heads :: indirect asks and persona padding still read as a count', pw('could you tell me how many <s> there were in <n>').op.label === 'count' && pw('my accountant is asking me how many <s> we had in <n>').op.label === 'count');
check('heads :: operator synonyms read as their operator (tally up -> count, mean -> avg)', pw('tally up <s> <s> for <n>').op.label === 'count' && pw('whats the mean <s> total for <s> <s>').op.label === 'avg');
check('heads :: sum wording with a money measure', (() => { const p = pw('what is the total dollar amount of <s> in <n>'); return p.op.label === 'sum' && p.measure.label === 'money'; })());
check('heads :: an untracked concept reads as a decline', pw('what is our <s> margin').op.label === 'decline' || pw('what is our profit margin').op.label === 'decline');
check('speed :: head inference under 1 ms', (() => { const v = 'i was wondering how many <s> <s> did we do in <n> for the accountant'.split(' '); L.predictHeads(v); const t0 = process.hrtime.bigint(); for (let i = 0; i < 300; i++) L.predictHeads(v); return Number(process.hrtime.bigint() - t0) / 1e6 / 300 < 1; })());

/* ---- hook B: supplying the missing operator word (api/_lib/dql/learned supplyOp) */
{
  const mk = (over = {}) => ({ raw: 'x', orig: ' tickets in 2025 ', rest: '                  ', left: [], feat: { trig: {}, flags: {}, dims: [], ...over.feat }, debug: {}, ...over });
  const out = (o) => L.supplyOp(o);
  check('hook B :: refuses when the parser has an operator trigger of its own', out(mk({ feat: { trig: { howMany: true }, flags: {}, dims: [] } })) === null);
  check('hook B :: refuses a grouped question, a set question and a time-window question', out(mk({ feat: { trig: {}, flags: {}, dims: ['year'] } })) === null && out(mk({ feat: { trig: {}, flags: {}, dims: [], sets: {} } })) === null && out(mk({ feat: { trig: {}, flags: {}, dims: [], timeq: {} } })) === null);
  check('hook B :: refuses while words are still unexplained', out(mk({ left: ['tally'], orig: ' tally of invoices ', rest: ' tally           ' })) === null);
  check('hook B :: refuses a negation or a second clause even when the heads are sure', out(mk({ raw: 'invoices and also which customers', orig: ' invoices and also which customers ', rest: '                                  ' })) === null);
  process.env.DONOVAN_DQL_HOOKB = '0';
  check('hook B :: kill switch', out(mk()) === null);
  delete process.env.DONOVAN_DQL_HOOKB;
  check('hook B :: supply table covers count, sum, avg, median, max, min, exists, latest, first', ['count', 'sum', 'avg', 'median', 'max', 'min', 'exists', 'latest', 'first'].every((k) => typeof L.SUPPLY[k] === 'string'));
}

/* ---- the gate on recorded real cases (scripts/learned-fixtures.json: words the parser left over on factory questions, with the plan's own reading) */
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/learned-fixtures.json'), 'utf8'));
const vth = model.thresholds.verify;
const decide = (c) => {
  const g = L.leftoverGate({ raw: c.q, orig: c.orig, rest: c.rest, left: c.left, debug: {} });
  if (!g) return { open: false, why: 'guard/tok' };
  const p = L.verifyScore(g, c.dh);
  return { open: p !== null && p >= vth, p };
};
for (const c of fx.open) { const d = decide(c); check(`gate opens :: ${c.q.slice(0, 70)} [${c.left.join(' ')}]`, d.open, JSON.stringify(d)); }
for (const c of fx.shut) { const d = decide(c); check(`gate releases :: ${c.q.slice(0, 70)} [${c.left.join(' ')}]`, !d.open, JSON.stringify(d)); }
process.env.DONOVAN_DQL_LEARNED = '0';
check('kill switch :: DONOVAN_DQL_LEARNED=0 never opens the gate', fx.open.every((c) => L.leftoverGate({ raw: c.q, orig: c.orig, rest: c.rest, left: c.left, debug: {} }) === null));
delete process.env.DONOVAN_DQL_LEARNED;
check('no leftover words :: nothing to decide', L.leftoverGate({ raw: 'x', orig: ' a ', rest: '   ', left: [], debug: {} }) === null);
check('verify gate :: a plan the heads contradict is released', (() => { const g = L.leftoverGate({ raw: fx.open[0].q, orig: fx.open[0].orig, rest: fx.open[0].rest, left: fx.open[0].left, debug: {} }); return g && L.verifyPlan({ ...g, pending: false }, { op: 'top_n', entity: 'customer', groupBy: [{ by: 'city' }] }) === false; })());

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
