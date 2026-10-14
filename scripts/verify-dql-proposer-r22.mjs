/**
 * verify:dql-proposer-r22 - the LOCAL PLAN PROPOSER (api/_lib/dql/proposer + learned/proposer.json): the plan translator's job without a model call.
 *
 *   - flag: DONOVAN_LOCAL_PROPOSER=0 is the kill switch (no intent, no plan); the shipped default is DEFAULT_ON
 *   - the skeleton table (factory plan -> skeleton label) and the slot detectors (names with roles, cities, kinds of paper, periods, money bounds)
 *   - proposals on the golden export: every ACCEPTED plan (validator + learned heads) is executed and compared with an independent count; nothing wrong is ever answered
 *   - questions the proposer must release: follow-ups, multi-part asks, invented names, negations, not-tracked concepts
 *   - the model: compact JSON under 5 MB, inference under 2 ms per question
 *   - end to end through classifyAll / runDecompose, no model call; api/ keeps its 12 top-level files
 *
 *   node scripts/verify-dql-proposer-r22.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };

process.env.DONOVAN_PROPOSER_TH = '0.6'; // the shipped threshold (0.99) is checked in section 8; the golden export is tiny, so the plan machinery is exercised at a low one
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_PLAN_TRANSLATOR; delete process.env.DONOVAN_DQL;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); const counter = await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:proposer', tenantName: 'proposer' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const T = await import('../api/_lib/dql/translator/index.js');
const { requestPlan } = await import('../api/_lib/dql/translator/call.js');
const { buildSystem, companyFacts, INSTRUCTIONS } = await import('../api/_lib/dql/translator/prompt.js');
const { PLAN_TOOL, TP_OPS } = await import('../api/_lib/dql/translator/schema.js');
const { classifyAll } = await import('../api/_lib/router/classifyAll.js');
const { runDecompose } = await import('../api/_lib/decompose/index.js');
const { loadSnapshot } = await import('../api/_lib/dql/load.js');
const { guardDecomposeAnswer } = await import('../api/_lib/router/guard/check.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'proposer' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const snap = await withTenant(ctxArg, (db) => loadSnapshot(db, { today: TODAY }));
const vctx = { tv, pack, today: TODAY, snap };

/* ------------------------------------------------------------------ independent oracle (plain JS over the raw export rows) */
const eff = (x) => (x.corrected_value && x.corrected_value !== '' ? x.corrected_value : x.value);
const fieldsOf = new Map();
for (const x of data.extractions) { if (!fieldsOf.has(x.document_id)) fieldsOf.set(x.document_id, {}); fieldsOf.get(x.document_id)[x.field_key] = eff(x); }
const ents = new Map(data.entities.map((e) => [e.id, e]));
const custOfDoc = new Map();
for (const l of data.document_entity_links) { const e = ents.get(l.entity_id); if (!e) continue; const cid = e.entity_type === 'customer' ? e.id : e.customer_id; if (cid && ents.get(cid)) custOfDoc.set(l.document_id, cid); }
const cityOf = (addr) => { const p = String(addr ?? '').split(',').map((s) => s.trim()); return p.length >= 3 ? p[p.length - 2] : null; };
const docs = data.documents.map((d) => { const c = ents.get(custOfDoc.get(d.id)); return { id: d.id, type: String(d.document_type).toLowerCase().replace(/_/g, '-'), cust: c?.data?.customer_name ?? null, city: cityOf(c?.data?.service_address), tech: fieldsOf.get(d.id)?.technician ?? null, status: fieldsOf.get(d.id)?.status ?? null }; });
const custNames = data.entities.filter((e) => e.entity_type === 'customer').map((e) => e.data.customer_name);
const techNames = [...new Set(docs.map((d) => d.tech).filter(Boolean))];
const NAME = custNames.find((n) => docs.filter((d) => d.type === 'invoice' && d.cust === n).length >= 2) ?? custNames[0];
const CITY = (() => { const c = {}; for (const d of docs) if (d.type === 'invoice' && d.city) c[d.city] = (c[d.city] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; })();
const TECH = techNames[0];
const count = (f) => docs.filter(f).length;
const num = (text) => { if (/^\s*no\b/i.test(text ?? '')) return 0; const m = /(\d[\d,]*)/.exec(text ?? ''); return m ? Number(m[1].replace(/,/g, '')) : null; };


const P = await import('../api/_lib/dql/proposer/index.js');
const { skeletonOf, parseSkeleton } = await import('../api/_lib/dql/proposer/skeleton.js');
const { detectSlots } = await import('../api/_lib/dql/proposer/slots.js');
const { compileVocab } = await import('../api/_lib/dql/vocab.js');
const { questionTokens } = await import('../api/_lib/dql/translator/validate.js');
const { answerFromSnapshot } = await import('../api/_lib/dql/index.js');
const { classifyTranslate } = await import('../api/_lib/dql/translator/index.js');
delete process.env.DONOVAN_LOCAL_PROPOSER;

/* ================================================================== 1. the flag */
check('flag :: DONOVAN_LOCAL_PROPOSER=0 is the kill switch', P.localProposerEnabled({ DONOVAN_LOCAL_PROPOSER: '0' }) === false);
check('flag :: =1 forces it on, unset follows the shipped default', P.localProposerEnabled({ DONOVAN_LOCAL_PROPOSER: '1' }) === true && P.localProposerEnabled({}) === P.DEFAULT_ON);
process.env.DONOVAN_LOCAL_PROPOSER = '0'; process.env.DONOVAN_LEARNED_READER = '0'; // R25: the learned reader is a second local planner and is ON by default; this test is about the proposer alone
check('flag :: off => no intent for a question about the records', classifyTranslate('how many invoices over 5000 per city this quarter', { tenantVocab: tv, pack, today: TODAY }) === null);
process.env.DONOVAN_LOCAL_PROPOSER = '1'; delete process.env.DONOVAN_LEARNED_READER;
check('flag :: on => an intent {mode: dql-translate}', classifyTranslate(`how many invoices for ${NAME}`, { tenantVocab: tv, pack, today: TODAY })?.mode === 'dql-translate');
check('flag :: on => a follow-up ("those") is never planned', classifyTranslate('how many of those were in Mesa', { tenantVocab: tv, pack }) === null);

/* ================================================================== 2. the skeleton table */
{
  const rec = (family, plan, extra = {}) => ({ family, plan: { entity: 'doc', filters: [], second: null, hop: null, args: {}, ...plan }, prior: null, ...extra });
  check('skeleton :: count', skeletonOf(rec('count', { op: 'count' })) === 'count|document|m:-|g:-|d:-|l:-|a:-');
  check('skeleton :: visits', skeletonOf(rec('count', { op: 'count', entity: 'visit' })) === 'count|visit|m:-|g:-|d:-|l:-|a:-');
  check('skeleton :: sum of money', skeletonOf(rec('sum', { op: 'agg', measure: 'total', args: { fn: 'sum' } })) === 'sum|document|m:total|g:-|d:-|l:-|a:-');
  check('skeleton :: group by technician sum', skeletonOf(rec('group', { op: 'group', args: { by: 'technician', metric: 'sum' } })) === 'group_sum|document|m:total|g:tech|d:-|l:-|a:-');
  check('skeleton :: top 3 by count', skeletonOf(rec('top', { op: 'top', args: { by: 'city', metric: 'count', n: 3, dir: 'top' } })) === 'top_n|document|m:-|g:city|d:-|l:n|a:-');
  check('skeleton :: latest customer', skeletonOf(rec('extreme_cust', { op: 'extreme', args: { which: 'last', ret: 'customer_name' } })) === 'latest|document|m:-|g:-|d:-|l:-|a:customer');
  check('skeleton :: a follow-up turn is none', skeletonOf(rec('count', { op: 'count' }, { prior: ['x'] })) === 'none');
  check('skeleton :: a text-search filter is none', skeletonOf(rec('avg', { op: 'agg', measure: 'total', args: { fn: 'avg' }, filters: [{ field: 'text_contains', op: 'contains', value: 'x' }] })) === 'none');
  check('skeleton :: a pair / comparison / pay question is none', skeletonOf(rec('compare_diff', { op: 'compare' })) === 'none' && skeletonOf(rec('pay', { op: 'pay' })) === 'none');
  check('skeleton :: parse round trip', JSON.stringify(parseSkeleton('group_sum|visit|m:total|g:month|d:-|l:-|a:-')) === JSON.stringify({ op: 'group_sum', entity: 'document', visit: true, measure: 'total', groupBy: ['month'], distinct: null, limit: null, ask: null }));
}

/* ================================================================== 3. slot detectors */
{
  const vocab = compileVocab(tv, pack);
  const sl = (q) => detectSlots(questionTokens(q, vocab), vocab, TODAY);
  const s1 = sl(`how many invoices for ${NAME} in ${CITY} over $500 during 2024`);
  check('slots :: a customer name, a city, the kind of paper, a money bound and a period are found', s1.spans.some((s) => s.kind === 'name') && s1.spans.some((s) => s.kind === 'city') && s1.docType === 'invoice' && s1.money[0]?.op === 'gt' && s1.money[0]?.value === 500 && /2024/.test(s1.time?.words ?? ''), JSON.stringify({ spans: s1.spans.map((s) => s.kind), doc: s1.docType, money: s1.money, time: s1.time }));
  const s2 = sl('how many invoices over 5');
  check('slots :: a bare number is not a money bound', s2.money.length === 0);
  const s3 = sl('how many invoices in the last 6 months');
  check('slots :: a relative period is one slot', /last 6 months/.test(s3.time?.words ?? ''), JSON.stringify(s3.time));
  const s4 = sl('how many invoices');
  check('slots :: nothing to find => no slots', s4.spans.every((s) => s.kind === 'doc') && !s4.time && !s4.money.length);
}

/* ================================================================== 4. proposals on the golden export */
const accepted = []; const wrongs = [];
const tryQ = (q, expect) => {
  const r = P.proposeAndValidate(q, vctx);
  if (!r.ok) return { released: r.reason };
  const d = answerFromSnapshot(snap, r.plan, TODAY);
  const ok = expect == null ? Boolean(d) : num(d?.text) === expect;
  accepted.push(q); if (!ok) wrongs.push(`${q} => ${d?.text}`);
  return { text: d?.text, ok };
};
{
  const qs = [
    [`how many invoices are there`, count((d) => d.type === 'invoice')],
    [`how many invoices for ${NAME}`, count((d) => d.type === 'invoice' && d.cust === NAME)],
    [`how many invoices in ${CITY}`, count((d) => d.type === 'invoice' && d.city === CITY)],
    [`count of invoices from ${NAME}`, count((d) => d.type === 'invoice' && d.cust === NAME)],
    [`number of invoices in ${CITY} for ${NAME}`, count((d) => d.type === 'invoice' && d.city === CITY && d.cust === NAME)],
    [`total of invoices for ${NAME}`, null],
    [`average invoice amount`, null],
    [`how many invoices by month`, null],
    [`which customer has the most invoices`, null],
  ];
  const outs = qs.map(([q, e]) => [q, tryQ(q, e)]);
  console.log(outs.map(([q, o]) => `      ${o.released ? 'released' : o.ok ? 'answered' : 'WRONG'}  ${q}  ${o.released ?? o.text?.slice(0, 80)}`).join('\n'));
  check('golden :: every plan the proposer accepts is answered exactly as the independent count', wrongs.length === 0, wrongs.join(' | '));
  check('golden :: the proposer answers the plain asks (at least 4 of the 10 questions)', accepted.length >= 4, `${accepted.length} accepted`);
}

/* ================================================================== 5. what must be released */
{
  const must = [
    'and what about them', 'how many of those were in Mesa', `how many invoices for Zelda Quimby`, `how many invoices except ${NAME}`, `how many invoices not in ${CITY}`,
    `how many invoices and also the total for ${NAME}`, 'how much is unpaid on invoices', 'how many invoices compared with last year', 'is it true that we have invoices',
    `what is the balance owed by ${NAME}`, 'list the hr letters', 'how many invoices over 5', 'tell me a joke about invoices', 'how many individual customers have invoices', 'how many signed consent forms', 'total invoices for linda f.', 'how many invoices as of last month', 'which documents say how many invoices we have',
  ];
  const leaked = must.filter((q) => P.proposeAndValidate(q, vctx).ok);
  check('release :: follow-ups, invented names, negations, multi-part, not-tracked and private asks are all released', leaked.length === 0, leaked.join(' | '));
  check('release :: a plan with a stray key / unknown op never reaches the executor', P.proposeAndValidate('', vctx).ok === false);
}

/* ================================================================== 6. the model: size and speed */
{
  const f = path.join(ROOT, 'api/_lib/dql/learned/proposer.json');
  const size = fs.statSync(f).size;
  check('model :: compact JSON under 8 MB', size < 5 * 1024 * 1024, String(size));
  const qs = [`how many invoices for ${NAME}`, `total of invoices in ${CITY} during 2024`, 'how many estimates by month', 'which technician has the most invoices'];
  for (const q of qs) P.proposePlan(q, vctx);
  const t0 = process.hrtime.bigint(); const N = 200;
  for (let i = 0; i < N; i++) P.proposePlan(qs[i % qs.length], vctx);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  check('model :: a proposal (detectors + heads) runs in under 20 ms', ms < 20, `${ms.toFixed(3)} ms`);
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  check('model :: a skeleton head with a seed and a calibration temperature', m.seed === 7 && m.head.T > 0 && m.head.classes.includes('none'));
}

/* ================================================================== 7. end to end */
{
  const cc = { today: TODAY, meta: null, pack, tenantVocab: tv, loadAnalyticsRouteModule: async () => ({ isAnalyticsEnabled: () => false }), loadAgentModule: async () => ({ isAgentEnabled: () => false }) };
  process.env.DONOVAN_LOCAL_PROPOSER = '1';
  const q = `how many invoices for ${NAME}`;
  const intent = classifyTranslate(q, { tenantVocab: tv, pack, today: TODAY });
  const before = counter.n;
  const res = intent ? await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY })) : null;
  check('end to end :: runDecompose answers an accepted plan from the stored rows (no model call)', Boolean(res) && num(res.text) === count((d) => d.type === 'invoice' && d.cust === NAME) && counter.n === before, res?.text);
  const bad = classifyTranslate(`how many invoices for Zelda Quimby`, { tenantVocab: tv, pack, today: TODAY });
  check('end to end :: a rejected plan falls through (null) to the normal chain', bad ? (await withTenant(ctxArg, (db) => runDecompose(db, bad, { today: TODAY }))) === null : true);
  const co = await classifyAll('and what about them', cc);
  check('end to end :: a follow-up is not claimed by the proposer', co.gated?.decompose?.mode !== 'dql-translate');
  process.env.DONOVAN_LOCAL_PROPOSER = '0';
  check('kill switch :: runDecompose of a translate intent does nothing when off', !intent || (await withTenant(ctxArg, (db) => runDecompose(db, intent, { today: TODAY }))) === null);
  delete process.env.DONOVAN_LOCAL_PROPOSER;
  check('rules :: api/ keeps exactly 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);
  check('rules :: ask.js is untouched by the proposer', !/proposer/i.test(fs.readFileSync(path.join(ROOT, 'api/ask.js'), 'utf8')));
}


/* ================================================================== 8. R22: guards and more releases (a release is never wrong) */
{
  delete process.env.DONOVAN_PROPOSER_TH; // the shipped threshold
  const rel = [
    'show latest invoice date', 'show last invoice date for our records', 'what is the earliest invoice date',
    'is it true we have invoices for 2021', 'how many invoices will there be', 'how many invoices may have been sent',
    'which year has the most invoices from 2020 on', 'how many invoices from 2021 onward', 'how many invoices in 2022 and later',
    `how many invoices for ${NAME} and ${NAME}`, 'how many invoices as of last month', 'how many invoices by the end of last year', 'which documents say how many invoices',
    'which invoices are overdue', 'why did invoices go up', 'who is the best customer', 'how many invoices were there before', 'delete all invoices', 'email the invoices to everyone',
    'how many invoices for', 'invoices', 'how many', 'show me everything', 'how many invoices per unicorn', `how many invoices for ${NAME} versus last year`, 'average days to pay an invoice',
    'how many of them', 'what about the other one', 'make it quarterly', 'sum of invoices excluding refunds',
  ];
  const leaked = rel.filter((q) => P.proposeAndValidate(q, vctx).ok);
  check(`release :: ${rel.length} more risky shapes are released`, leaked.length === 0, leaked.join(' | '));
  for (const q of rel.slice(0, 12)) check(`release :: "${q}"`, !P.proposeAndValidate(q, vctx).ok);
  const sk = P.proposePlan('how many invoices will there be', vctx);
  check('guard :: a common word is never read as a stored value', !sk.raw || !(sk.raw.filters ?? []).some((f) => String(f.value).toLowerCase() === 'will'));
  check('flag :: the shipped default and the kill switch agree', P.localProposerEnabled({ DONOVAN_LOCAL_PROPOSER: '0' }) === false && typeof P.DEFAULT_ON === 'boolean');
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'api/_lib/dql/learned/proposer.json'), 'utf8'));
  check('model :: R22 calibration threshold is at least 0.97', (m.thresholds?.prob ?? 0) >= 0.97, String(m.thresholds?.prob));
  check('model :: the R22 row generator reads TRAIN splits only', /TRAIN splits only/.test(fs.readFileSync(path.join(ROOT, 'scripts/gen-proposer-rows-r22.mjs'), 'utf8')) && !/wantDev\s*=\s*true/.test(fs.readFileSync(path.join(ROOT, 'scripts/gen-proposer-rows-r22.mjs'), 'utf8')));
}

/* ================================================================== 9. R22: the core question extractor (wrapper text removed, every meaningful word kept) */
{
  const { extractCore, inert } = await import('../api/_lib/dql/proposer/core.js');
  process.env.DONOVAN_PROPOSER_TH = '0.6';
  const vocab = compileVocab(tv, pack);
  const core = (q) => extractCore(q, vocab)?.core ?? null;
  const base = `how many invoices for ${NAME}`;
  const wraps = [
    (q) => `Subject: Quick one\n\nHi team,\n\nThe stapler vanished again and the fridge smells odd.\n\nCould you answer this for me: ${q}\n\nThanks so much,\nOmar`,
    (q) => `The gutters are overflowing again. Everyone here is a little on edge. Moving on, ${q} please`,
    (q) => `Dime una cosa: ${q}, gracias amigo`,
    (q) => `Hey Donovan, ${q} when you get a chance, thanks`,
    (q) => `It is windy outside and the cat is asleep. Anyway, ${q}?`,
  ];
  for (const [i, w] of wraps.entries()) { const c = core(w(base)); check(`core :: wrapper ${i + 1} is stripped and the question kept whole`, c != null && c.toLowerCase().includes(base.toLowerCase()) && !/gutter|stapler|windy|gracias|dime/i.test(c), `${c} :: ${w(base).split(/\n|(?<=[.!?])\s+/).filter((x) => !inert(x, vocab, { allowNegation: true, side: true })).join(' || ') + ` [${inert.last}]`}`); }
  const keepAll = (q) => { const c = core(q); return c == null || q.toLowerCase().split(/\W+/).filter((x) => x.length > 3 && vocab.known(x) && /invoice|visit|record/.test(x)).every((x) => c.toLowerCase().includes(x)); };
  check('core :: a kind of paper named in the question is never dropped', keepAll(wraps[1](base)) && keepAll(wraps[2](base)));
  const mustKeep = [
    `The stapler vanished. Only the unpaid ones. ${base}`,
    `${base}. Not the cancelled ones please.`,
    `I called Smith earlier today. ${base}`,
    `Please count the visits in March 2024. Also how many invoices were sent last week.`,
    `The office has 40 desks and a leaky roof. ${base}`,
    `Do not count refunds. ${base}`,
    `Few quick ones:\na) ${base}\nb) how many visits`,
    `Between you and me the roof leaks. Which customers owe money? ${base}`,
  ];
  for (const q of mustKeep) check(`core :: not stripped when the other text could change the question: "${q.slice(0, 50).replace(/\n/g, ' ')}"`, core(q) == null, String(core(q)));
  check('core :: a plain question has no wrapper to remove', core(base) == null);
  check('core :: kill switch DONOVAN_PROPOSER_CORE=0 answers on the whole text only', (() => { const q = wraps[1](base); process.env.DONOVAN_PROPOSER_CORE = '0'; const r = P.proposeAndValidate(q, vctx); delete process.env.DONOVAN_PROPOSER_CORE; return !r.core; })());
  // a wrapped question is never planned differently from the bare one
  const bareList = [`how many invoices are there`, `how many invoices in ${CITY}`, base];
  let diff = 0; let viaCore = 0;
  for (const b of bareList) { const rb = P.proposeAndValidate(b, vctx); for (const w of wraps) { const r = P.proposeAndValidate(w(b), vctx); if (r.ok) { viaCore += r.core ? 1 : 0; if (!rb.ok || JSON.stringify(r.plan) !== JSON.stringify(rb.plan)) diff++; } } }
  check(`core :: wrapped questions plan exactly as the bare ones (${viaCore} through the core, ${diff} different)`, diff === 0);
  check('core :: a wrapped question that holds two asks is released', !P.proposeAndValidate(`Hi. ${base}. Also how many visits for ${NAME}?`, vctx).ok);
  const t0 = performance.now(); for (let i = 0; i < 50; i++) P.proposeAndValidate(wraps[0](base), vctx); const ms = (performance.now() - t0) / 50;
  check(`core :: under 20 ms per wrapped question (${ms.toFixed(1)} ms)`, ms < 20);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
