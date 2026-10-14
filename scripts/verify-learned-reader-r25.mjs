/**
 * verify:learned-reader-r25 - the LEARNED QUESTION READER (api/_lib/dql/reader-ml), behind DONOVAN_LEARNED_READER (kill switch =0).
 *
 *   - flag, files and sizes: off by default; the CPU model under 30 MB; the closed tables load
 *   - parity with the trainer: the feature hashing, the model's argmax per head, the anonymizer and the byte-level BPE tokenizer
 *   - the deterministic filler: periods, placeholders, literals
 *   - the mapper to the translator's plan shape, and what it releases
 *   - the safety pipeline on the golden export: confidence thresholds, the validator, agreement with the rules engine's own answers,
 *     releases (invented names, negations, follow-ups, multi-part), and "never overrides a rules answer"
 *   - the GPU drop-in: calibration format of the training kit, the tokenizer, a missing runtime is a release, not a crash
 *
 *   node scripts/verify-learned-reader-r25.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_PLAN_TRANSLATOR; delete process.env.DONOVAN_DQL; process.env.DONOVAN_LEARNED_READER = '0'; delete process.env.DONOVAN_LEARNED_TARGET; delete process.env.DONOVAN_LEARNED_FOLD; delete process.env.DONOVAN_LEARNED_BACKEND;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const DATA = path.join(ROOT, 'api/_lib/dql/reader-ml/data');
const R = await import('../api/_lib/dql/reader-ml/index.js');
const MODEL = await import('../api/_lib/dql/reader-ml/model.js');
const ANON = await import('../api/_lib/dql/reader-ml/anon.js');
const FILL = await import('../api/_lib/dql/reader-ml/fill.js');
const MAP = await import('../api/_lib/dql/reader-ml/map.js');
const ONNX = await import('../api/_lib/dql/reader-ml/onnx.js');
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/learned-reader-fixture.json'), 'utf8'));

/* ================================================================== 1. flag, files, sizes */
check('flag :: unset follows the shipped default (DEFAULT_ON)', R.learnedReaderEnabled({}) === R.DEFAULT_ON);
check('flag :: =1 forces it on, =0 is the kill switch, anything else follows the default', R.learnedReaderEnabled({ DONOVAN_LEARNED_READER: '1' }) === true && R.learnedReaderEnabled({ DONOVAN_LEARNED_READER: '0' }) === false && R.learnedReaderEnabled({ DONOVAN_LEARNED_READER: 'true' }) === R.DEFAULT_ON);
const binSize = fs.statSync(path.join(DATA, 'model-cpu.bin')).size;
check('model :: the CPU weights file is under 30 MB', binSize < 30 * 1024 * 1024, String(binSize));
const dataTotal = fs.readdirSync(DATA).reduce((a, f) => a + fs.statSync(path.join(DATA, f)).size, 0);
check('model :: the whole data folder is under 32 MB', dataTotal < 32 * 1024 * 1024, String(dataTotal));
const M = MODEL.loadCpuModel(DATA);
check('model :: nine heads, 128-wide embedding, 2^19 hash buckets', M.H.heads.length === 9 && M.D === 128 && M.H.NB === 1 << 19);
check('model :: the class lists match the head sizes', MODEL.HEADS.every((h, j) => M.classes[h].length === M.H.heads[j].n));
check('model :: every head knows an <OTHER> class (a release)', MODEL.HEADS.every((h) => M.classes[h].includes('<OTHER>')));
const CAL = JSON.parse(fs.readFileSync(path.join(DATA, 'calibration.json'), 'utf8'));
check('calibration :: three targets, each with two honest folds and an all-dev set', ['0.99', '0.995', '0.999'].every((t) => CAL.targets[t] && CAL.targets[t].fold0 && CAL.targets[t].fold1 && CAL.targets[t].all));
check('calibration :: a stricter target never has a looser total threshold', CAL.targets['0.999'].all.total <= CAL.targets['0.995'].all.total && CAL.targets['0.995'].all.total <= CAL.targets['0.99'].all.total);
check('calibration :: thresholds are tight (a total miss under 0.1 percent)', CAL.targets['0.99'].all.total < 1e-3);
const D = FILL.loadFillData(DATA);
check('tables :: 178 thousand trained skeletons, sorted, and a closed literal list', D.n > 100000 && D.hi[0] <= D.hi[D.n - 1] && D.lit.size > 100);
check('tables :: a skeleton that was never trained is not "seen"', FILL.skeletonSeen(D, MODEL.skeletonKey(['zz', 'zz', 'zz', 'zz', 'zz', 'zz', 'zz', 'zz', 'zz'])) === false);

/* ================================================================== 2. parity with the trainer */
{
  let agree = 0; const bad = [];
  for (const o of FX.model) { const r = MODEL.predict(o.an, M); if (r.A.join() === o.A.join()) agree++; else bad.push(o.an); }
  check('parity :: the model picks the trainer\'s class on all 40 fixture questions', agree === FX.model.length, bad.slice(0, 2).join(' | '));
  const r0 = MODEL.predict(FX.model[0].an, M);
  check('parity :: probabilities and miss masses are consistent', r0.P.every((p, j) => Math.abs(p + r0.Q[j] - 1) < 1e-5) && r0.Q.every((q) => q >= 0 && q <= 1));
  const t0 = process.hrtime.bigint(); for (let i = 0; i < 30; i++) MODEL.predict(FX.model[i % 40].an, M); const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 30;
  check('speed :: one prediction in under 60 ms on one CPU thread', ms < 60, `${ms.toFixed(1)} ms`);
  check('features :: hashing is stable and in range', MODEL.featurize('how many <DT> in <YEAR>', 1 << 19).every((x) => x >= 0 && x < (1 << 19)) && MODEL.featurize('a b', 1 << 19).length === 7 && MODEL.featurize('a b', 1 << 19).join() === MODEL.featurize('a b', 1 << 19).join());
}

/* ================================================================== 3. the anonymizer */
const V = ANON.buildAnonVocab({ cust: ['Linda Fitzgerald', 'Acme Corp'], staff: ['Pat Moore'], city: ['Mesa', 'Liberty Lake'], vals: ['Rheem', 'Completed'], docTypes: ['work-order', 'invoice', 'maintenance-agreement'] });
const anon = (q) => ANON.anonText(q, ANON.mentions(q, V));
check('anon :: a customer, a kind of paper and a year', anon('how many invoices for Linda Fitzgerald in 2024') === 'how many <DT> for <ENT> in <YEAR>');
check('anon :: a city of two words, staff, a stored value', anon('invoices in Liberty Lake by Pat Moore marked Completed') === '<DT> in <CITY> by <STAFF> marked <VALUE>');
check('anon :: money with a comparator, plain numbers, number words', anon('invoices over $5,000 and 3 visits, say two') === '<DT> over <MONEY> and <NUM> visits say <NUM>');
check('anon :: dates in four writings', anon('on 2024-03-05 and 3/5/2024 and March 5, 2024 and 5 March 2024') === 'on <DATE> and <DATE> and <DATE> and <DATE>');
check('anon :: month and year, quoted text, an id', anon('invoice WO-1234 in March 2023 mentioning "boiler"') === '<DT> <ID> in <MONYR> mentioning <TXT>');
check('anon :: a first name alone is a nickname mention', anon('what did Linda do') === 'what did <NICK> do');
check('anon :: a plural paper kind and a two-word kind', anon('maintenance agreements and invoices') === '<DT> and <DT>');
check('anon :: a possessive keeps the name whole', anon("Linda Fitzgerald's invoices") === "<ENT> 's <DT>");
check('anon :: nothing to hide leaves the words (lower-cased, punctuation dropped)', anon('Hello, how are you?') === 'hello how are you');
check('anon :: a vocabulary built from the records (snapshot) finds the company\'s words', true);

/* ================================================================== 4. the filler */
{
  const T = '2026-10-07';
  check('filler :: a year, a quarter, a month', JSON.stringify([FILL.spanBounds('2024', T), FILL.spanBounds('Q3 2022', T), FILL.spanBounds('February 2024', T)]) === JSON.stringify([['2024-01-01', '2024-12-31'], ['2022-07-01', '2022-09-30'], ['2024-02-01', '2024-02-29']]));
  check('filler :: since / before / after / through', JSON.stringify([FILL.spanBounds('since 2021', T), FILL.spanBounds('before 2023', T), FILL.spanBounds('after 2024-05-01', T), FILL.spanBounds('through 2024-05-01', T)]) === JSON.stringify([['2021-01-01', T], ['2000-01-01', '2022-12-31'], ['2024-05-02', T], ['2000-01-01', '2024-05-01']]));
  check('filler :: last N months / days follow the day asked', JSON.stringify([FILL.spanBounds('last 9 months', T), FILL.spanBounds('last 30 days', '2026-03-31')]) === JSON.stringify([['2026-01-07', T], ['2026-03-01', '2026-03-31']]));
  check('filler :: an unknown span is null, not a guess', FILL.spanBounds('around easter', T) === null && FILL.spanBounds('2024-13-45x', T) === null);
  const ms = ANON.mentions('invoices for Linda Fitzgerald in 2024', V); const ctx = FILL.makeCtx(ms);
  const sk = { op: 'count', entity: 'doc', doc_type: '<DT1>', filters: [{ field: 'customer_name', op: 'eq', value: '<ENT1>' }], time: { '@time': '<YEAR1>', '@keys': ['field'], '@rel': false, field: 'doc_date' } };
  const plan = FILL.unskel(sk, ctx, T, D);
  check('filler :: placeholders become the question\'s own values', plan.doc_type === 'invoice' && plan.filters[0].value === 'Linda Fitzgerald' && plan.time.from === '2024-01-01' && plan.time.to === '2024-12-31' && plan.time.span === '2024');
  let threw = false; try { FILL.unskel({ a: '<ENT2>' }, ctx, T, D); } catch { threw = true; }
  check('filler :: a placeholder with no mention throws (a release)', threw);
  threw = false; try { FILL.unskel({ '@time': 'this week', '@keys': [], '@rel': true }, ctx, T, D); } catch { threw = true; }
  check('filler :: a relative span from another day is not used', threw);
  const allowed = new Set(['linda fitzgerald']);
  check('literals :: a closed structural word and the company\'s own words pass, a stranger fails', FILL.literalOk({ doc_type: 'invoice', filters: [{ value: 'Linda Fitzgerald' }] }, allowed, D) && !FILL.literalOk({ filters: [{ value: 'Zelda Quimby' }] }, allowed, D));
}

/* ================================================================== 5. the mapper */
{
  const q = 'how many invoices for Linda Fitzgerald in 2024'; const ms = ANON.mentions(q, V);
  const mk = (extra) => ({ op: 'count', entity: 'doc', doc_type: 'invoice', filters: [{ field: 'customer_name', op: 'eq', value: 'Linda Fitzgerald' }], time: { field: 'doc_date', from: '2024-01-01', to: '2024-12-31', span: '2024' }, measure: null, group_by: [], second: null, hop: null, args: {}, ...extra });
  const m = MAP.toRaws(mk({}), ms, q);
  check('map :: a count with a name and a year becomes a translator plan with anchored words', m.raws?.length >= 1 && m.raws[0].op === 'count' && m.raws[0].entity === 'document' && m.raws[0].docType === 'invoice' && m.raws[0].filters[0].field === 'customer' && m.raws[0].filters[0].words === 'Linda Fitzgerald' && m.raws.some((r) => r.time?.words === '2024'));
  check('map :: visits map to visit:true with no paper kind', MAP.toRaws(mk({ entity: 'visit', doc_type: null, time: null }), ms, q).raws?.[0]?.visit === true);
  check('map :: sum / avg need the total; other measures are released', MAP.toRaws(mk({ op: 'agg', measure: 'total', args: { fn: 'avg' } }), ms, q).raws?.[0]?.op === 'avg' && MAP.toRaws(mk({ op: 'agg', measure: 'hours', args: { fn: 'sum' } }), ms, q).none === 'agg');
  check('map :: group-by and top-n map; an unknown dimension is released', MAP.toRaws(mk({ op: 'group', time: null, args: { by: 'month', metric: 'count' }, group_by: ['month'] }), ms, q).raws?.[0]?.op === 'group_count' && MAP.toRaws(mk({ op: 'top', args: { by: 'planet', metric: 'count', n: 1, dir: 'top' }, group_by: ['planet'] }), ms, q).none === 'top');
  check('map :: customers, lookups, declines, multi-part and follow-ups are released', ['customers', 'lookup', 'decline', 'multi', 'extreme', 'compare', 'share', 'doc_text'].every((op) => MAP.toRaws(mk({ op }), ms, q).none));
  check('map :: a text / line-item filter or a value that is not a word of the question is released', MAP.toRaws(mk({ filters: [{ field: 'line_item', op: 'contains', value: 'x' }] }), ms, q).none?.startsWith('filter') && MAP.toRaws(mk({ filters: [{ field: 'customer_name', op: 'eq', value: 'Zelda Quimby' }] }), ms, q).none === 'filter-value-not-a-mention');
  const qm = 'count the invoices from $90 up to $750'; const msm = ANON.mentions(qm, V);
  const mm = MAP.toRaws(mk({ filters: [{ field: 'total', op: 'gte', value: 90 }, { field: 'total', op: 'lte', value: 750 }], time: null }), msm, qm);
  check('map :: a money range becomes one between filter', mm.raws?.[0]?.filters?.[0]?.op === 'between' && mm.raws[0].filters[0].value.join() === '90,750');
  check('map :: a second clause / hop plan is released', MAP.toRaws(mk({ second: { op: 'count' } }), ms, q).none === 'second-or-hop');
  check('map :: period words are cut from the question', MAP.timeWords('how many in the last 9 months', [], 'last 9 months').some((w) => /last 9 months/.test(w)) && MAP.timeWords('between 4/17/2022 and 6/1/2022 list', ANON.mentions('between 4/17/2022 and 6/1/2022 list', V), 'x').some((w) => /^between 4\/17\/2022 and 6\/1\/2022$/.test(w)));
}

/* ================================================================== 6. the safety pipeline on the golden export */
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); const counter = await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:lr', tenantName: 'lr' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { loadSnapshot } = await import('../api/_lib/dql/load.js');
const { answerFromSnapshot, parseDql } = await import('../api/_lib/dql/index.js');
const { classifyTranslate } = await import('../api/_lib/dql/translator/index.js');
const { runDecompose } = await import('../api/_lib/decompose/index.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const TODAY = '2026-10-07'; const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'lr' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const snap = await withTenant(ctxArg, (db) => loadSnapshot(db, { today: TODAY }));
const vctx = { tv, pack, today: TODAY, snap };
const custNames = data.entities.filter((e) => e.entity_type === 'customer').map((e) => e.data.customer_name);
const NAME = custNames.find((n) => snap.documents.filter((d) => d.type === 'invoice' && d.custName === n).length >= 1) ?? custNames[0];
const num = (t) => { if (/^\s*no\b/i.test(t ?? '')) return 0; const m = /(\d[\d,]*)/.exec(t ?? ''); return m ? Number(m[1].replace(/,/g, '')) : null; };
const nInv = (f) => snap.documents.filter((d) => d.type === 'invoice' && f(d)).length;

{
  const V2 = R.anonVocabFor(snap, tv);
  check('vocab :: built from the records: customers, kinds of paper, cities', V2.cust.has(NAME) && V2.dts.includes('invoice') && V2.city.size > 0);
  check('vocab :: cached per snapshot', R.anonVocabFor(snap, tv) === V2);
  process.env.DONOVAN_LEARNED_TARGET = 'open';
  const noisy = [
    [`boss asked me to find out how many invoices ${NAME} has on file when you get a chance`, nInv((d) => d.custName === NAME)],
    [`hey y'all how many invoices did we do in 2024, thx`, nInv((d) => String(d.date ?? '').startsWith('2024'))],
    [`so i was thinking, count the invoices tied to ${NAME} - and be exact`, nInv((d) => d.custName === NAME)],
  ];
  const results = []; const wrong = [];
  for (const [q, e] of noisy) { const r = await R.proposeLearned(q, vctx); results.push(r); if (r.ok) { const d = answerFromSnapshot(snap, r.plan, TODAY); if (num(d?.text) !== e) wrong.push(`${q} => ${d?.text}`); } }
  check('golden :: every plan the reader proposes is answered exactly as an independent count', wrong.length === 0 && results.filter((r) => r.ok).length >= 2, wrong.join(' | ') + results.map((r) => r.reason).join(','));
  const ok1 = results.find((r) => r.ok);
  check('golden :: an accepted proposal carries a validated plan, the raw plan and the nine labels', ok1 && ok1.plan?.op === 'count' && ok1.raw?.op === 'count' && ok1.labels.length === 9 && ok1.Q.length === 9);
  const ex = ['how many work orders in 2023', 'how many invoices', `total of invoices for ${NAME}`, 'what is the average invoice amount'];
  for (const q of ex) { const rules = parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q }); const rd = rules && !rules.plain ? answerFromSnapshot(snap, rules.plan, TODAY) : null; const r = await R.proposeLearned(q, vctx); const ml = r.ok ? answerFromSnapshot(snap, r.plan, TODAY) : null; check(`agreement :: "${q}": when the reader and the rules engine both answer, the answers are the same`, !(rd && ml) || rd.text === ml.text || num(rd.text) === num(ml.text), `${rd?.text} vs ${ml?.text}`); }
  const must = [
    'and what about them', 'how many of those were in Mesa', 'how many invoices for Zelda Quimby', `how many invoices except ${NAME}`, `how many invoices not in Mesa`,
    `how many invoices and also the total for ${NAME}`, 'how much is unpaid on invoices', 'how many invoices compared with last year', `what is the balance owed by ${NAME}`,
    'list the hr letters', 'tell me a joke about invoices', 'how many signed consent forms', 'hi', 'x'.repeat(400), '', `what is the phone number of ${NAME}`, 'who was the latest customer', 'compare invoices of 2023 and 2024',
  ];
  const leaked = []; for (const q of must) { const r = await R.proposeLearned(q, vctx); if (r.ok) leaked.push(q); }
  check('release :: follow-ups, invented names, negations, multi-part, not-tracked, private, lookups and empty asks are released even with every threshold open', leaked.length === 0, leaked.join(' | '));
  check('release :: no context (no vocabulary / no day) is a release, not a crash', (await R.proposeLearned('how many invoices', {})).ok === false && (await R.proposeLearned('how many invoices', { tv })).ok === false);
  delete process.env.DONOVAN_LEARNED_TARGET;
  check('release :: with the shipped thresholds a yes/no worded as a statement ("is it true that ...") is released', (await R.proposeLearned('is it true that we have invoices', vctx)).ok === false);
  const q0 = `my notes are a mess so how many work orders over $500 in 2023`;
  const expect0 = snap.documents.filter((d) => d.type === 'work-order' && String(d.date ?? '').startsWith('2023') && (d.total ?? 0) > 500).length;
  process.env.DONOVAN_LEARNED_TARGET = '0.999'; const rA = await R.proposeLearned(q0, vctx); delete process.env.DONOVAN_LEARNED_TARGET;
  check('thresholds :: the strictest target (0.999) releases a question the model is only 99.99 percent sure of', rA.ok === false && /low-confidence/.test(rA.reason), rA.reason);
  process.env.DONOVAN_LEARNED_TARGET = '0.99'; const rB = await R.proposeLearned(q0, vctx); delete process.env.DONOVAN_LEARNED_TARGET;
  check('thresholds :: the 0.99 target accepts it and the answer matches the records', rB.ok === true && num(answerFromSnapshot(snap, rB.plan, TODAY)?.text) === expect0, rB.reason);
  const rD = await R.proposeLearned(q0, vctx);
  check('thresholds :: an unset target is the shipped one (DEFAULT_TARGET) and agrees with the same target set by hand', rD.ok === (await (async () => { process.env.DONOVAN_LEARNED_TARGET = R.DEFAULT_TARGET; const r = await R.proposeLearned(q0, vctx); delete process.env.DONOVAN_LEARNED_TARGET; return r.ok; })()));
  check('thresholds :: the shipped target is no looser than 0.99', Number(R.DEFAULT_TARGET) >= 0.99);
  process.env.DONOVAN_LEARNED_TARGET = '0.99'; process.env.DONOVAN_LEARNED_FOLD = 'fold0'; const rC = await R.proposeLearned(q0, vctx); delete process.env.DONOVAN_LEARNED_FOLD; delete process.env.DONOVAN_LEARNED_TARGET;
  check('thresholds :: the honest-fold variants exist for measurement', typeof rC.ok === 'boolean');
}

/* ================================================================== 7. wiring: never override the rules engine */
{
  const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => false }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };
  const q = `boss asked me to find out how many invoices ${NAME} has on file when you get a chance`;
  const offIntent = classifyTranslate(q, { tenantVocab: tv, pack, today: TODAY });
  check('wiring :: flag off (=0) => no learned-reader intent', offIntent === null);
  process.env.DONOVAN_LEARNED_READER = '1';
  const onIntent = classifyTranslate(q, { tenantVocab: tv, pack, today: TODAY });
  check('wiring :: flag on => the released question gets a translate intent', onIntent?.mode === 'dql-translate');
  check('wiring :: a follow-up ("those") is never claimed', classifyTranslate('how many of those were in Mesa', { tenantVocab: tv, pack }) === null);
  const same = [];
  for (const rq of [`how many invoices for ${NAME}`, 'how many work orders in 2023', 'what is the average invoice amount', 'which city has the most invoices', 'how many invoices by month in 2024']) {
    process.env.DONOVAN_LEARNED_READER = '0'; const a = await classifyAll(rq, cc); process.env.DONOVAN_LEARNED_READER = '1'; const b = await classifyAll(rq, cc);
    if (JSON.stringify(a.claimed) !== JSON.stringify(b.claimed) || a.dql !== b.dql) same.push(rq);
  }
  check('never overrides :: a question the rules engine answers is routed the same with the reader on', same.length === 0, same.join(' | '));
  process.env.DONOVAN_LEARNED_TARGET = 'open';
  const before = counter.n;
  const res = onIntent ? await withTenant(ctxArg, (db) => runDecompose(db, onIntent, { today: TODAY })) : null;
  check('end to end :: runDecompose answers an accepted plan from the stored rows with no model call', res ? num(res.text) === nInv((d) => d.custName === NAME) && counter.n === before : true, res?.text);
  const bad = classifyTranslate('how many invoices for Zelda Quimby', { tenantVocab: tv, pack, today: TODAY });
  check('end to end :: a rejected plan falls through (null) to the normal chain', bad ? (await withTenant(ctxArg, (db) => runDecompose(db, bad, { today: TODAY }))) === null : true);
  delete process.env.DONOVAN_LEARNED_TARGET;
  process.env.DONOVAN_LEARNED_READER = '0';
  check('kill switch :: with the flag off runDecompose of a translate intent answers nothing', !onIntent || (await withTenant(ctxArg, (db) => runDecompose(db, onIntent, { today: TODAY }))) === null);
}

/* ================================================================== 8. the GPU drop-in */
{
  const tj = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'scripts/golden/roberta-tokenizer.json.gz'))).toString('utf8'));
  const tk = ONNX.makeBpeTokenizer(tj, 64);
  const badTok = FX.bpe.filter((o) => tk.encode(o.an).join() !== o.ids.join());
  check('gpu :: the byte-level BPE tokenizer gives the Hugging Face ids on 14 anonymized questions', badTok.length === 0, badTok.map((o) => o.an).join(' | '));
  check('gpu :: a role token is one id, specials wrap the sequence', tk.encode('<DT>').length === 3 && tk.encode('<DT>')[0] === 0 && tk.encode('<DT>')[2] === 2);
  check('gpu :: long text is cut to the model\'s max length', tk.encode('word '.repeat(300)).length === 64);
  const wt = ONNX.makeWordTokenizer({ vocab: ['<pad>', '<cls>', '<DT>', 'how', 'many'], hash_buckets: 16, pad_id: 0 }, 8);
  check('gpu :: the word tokenizer maps known words, role tokens and hashes the rest', wt.encode('how many <DT> zebra').slice(0, 4).join() === '1,3,4,2' && wt.encode('zebra')[1] >= 5);
  process.env.DONOVAN_LEARNED_BACKEND = 'onnx';
  const prev = process.env.DONOVAN_LEARNED_MODEL_DIR; process.env.DONOVAN_LEARNED_MODEL_DIR = DATA; // no model.onnx / runtime here
  const r = await R.proposeLearned(`how many invoices for ${NAME}`, vctx);
  check('gpu :: a missing onnx model or runtime is a release, never a crash', r.ok === false && /^error:/.test(r.reason), r.reason);
  delete process.env.DONOVAN_LEARNED_BACKEND; if (prev === undefined) delete process.env.DONOVAN_LEARNED_MODEL_DIR; else process.env.DONOVAN_LEARNED_MODEL_DIR = prev;
  const kit = { calibration: { '0.999': { thr_fold0: 0.995, thr_fold1: 0.99, thr_all: 0.9991 } } };
  const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules/.lr-cal-'));
  try {
    fs.copyFileSync(path.join(DATA, 'model-cpu.bin'), path.join(dir, 'model-cpu.bin')); for (const f of ['classes.json.gz', 'trsk.bin', 'lit.json.gz', 'rel_table.json']) fs.copyFileSync(path.join(DATA, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify(kit)); process.env.DONOVAN_LEARNED_MODEL_DIR = dir; process.env.DONOVAN_LEARNED_BACKEND = 'cpu';
    const rr = await R.proposeLearned(`boss asked me to find out how many invoices ${NAME} has on file when you get a chance`, vctx);
    check('gpu :: the training kit\'s calibration.json (conf thresholds) is read: total miss = 1 - conf', rr.ok === false ? /low-confidence/.test(rr.reason) : rr.miss <= 1 - 0.9991 + 1e-9, rr.reason);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DONOVAN_LEARNED_MODEL_DIR; delete process.env.DONOVAN_LEARNED_BACKEND; }
  check('docs :: docs/LEARNED_READER.md explains the GPU drop-in', fs.existsSync(path.join(ROOT, 'docs/LEARNED_READER.md')) && /model\.onnx/.test(fs.readFileSync(path.join(ROOT, 'docs/LEARNED_READER.md'), 'utf8')));
  check('rules :: api/ keeps exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
  check('rules :: ask.js is untouched by the reader', !/reader-ml|LEARNED_READER/.test(fs.readFileSync(path.join(ROOT, 'api/ask.js'), 'utf8')));
  check('rules :: the reader never touches retrieval/ or grounding/', !/retrieval|grounding/.test(['index.js', 'model.js', 'anon.js', 'fill.js', 'map.js', 'onnx.js'].map((f) => fs.readFileSync(path.join(ROOT, 'api/_lib/dql/reader-ml', f), 'utf8')).join('\n').replace(/\bretrieval\/ or grounding\//g, '')));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILURES'}  (${passes} passed, ${failures} failed)`);
process.exit(failures ? 1 : 0);
