/**
 * verify:dql-wrapped-r23 - ONE question wrapped in chatter (api/_lib/dql/unwrap.js, parse.js parseDql retry).
 *
 *   - a plain question and the same question inside greetings, context paragraphs, urgency, thanks, sign-offs, an email shell, Spanish openers/closers
 *     and double-negative throat clearing must read the SAME plan (the chatter never changes the answer)
 *   - wrappers that carry a condition (a digit, a name, a negation that narrows, a word of the company, a second question, a bulleted list) are never
 *     unwrapped silently: the result is a release, or a plan that differs from the plain question's plan
 *   - the kill switch DONOVAN_DQL_UNWRAP=0 gives the old behaviour
 *   - unit checks of the phrase lists and the meta-clause test
 *
 *   node scripts/verify-dql-wrapped-r23.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };

delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL; delete process.env.DONOVAN_DQL_UNWRAP;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:wrapped', tenantName: 'wrapped' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql } = await import('../api/_lib/dql/index.js');
const { compileVocab } = await import('../api/_lib/dql/vocab.js');
const U = await import('../api/_lib/dql/unwrap.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'wrapped' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const ask = (q, extra = {}) => parseDql(q, { tenantVocab: tv, pack, today: TODAY, original: q, ...extra });
const planOf = (q, extra) => { const r = ask(q, extra); return r && !r.plain ? JSON.stringify(r.plan) : null; };

/* ---------- 1. the same plan, wrapped or plain */
const BASES = [
  'show me the biggest invoice',
  'how many customers are in Phoenix',
  'what is the average invoice amount',
  'what is the total amount of invoices by year',
  'what is the smallest estimate',
  'what is the median invoice amount',
  'how many invoices have no amount',
  'what is the highest estimate',
];
const baseplan = {};
for (const b of BASES) { baseplan[b] = planOf(b); check(`plain question is answered: ${b}`, baseplan[b] != null); }
const WRAPS = [
  (q) => `Hola, por fa: ${q}, es urgente, mil gracias`,
  (q) => `Ey, quick question pero urgente: ${q}, gracias eh`,
  (q) => `The break room fridge smells like fish and the printer is jammed again. Back to business: ${q} when you get a sec thanks`,
  (q) => `Subject: Quick one\n\nHi Donovan,\n\nThe thermostat is stuck and my chair squeaks. ${q}\n\nThanks,\nSam`,
  (q) => `I can't not ask this: ${q}`,
  (q) => `It would be a mistake to not get this right: ${q}, appreciate it`,
  (q) => `Buenas, necesito algo: Never say I didn't ask: ${q} cuando puedas, saludos`,
  (q) => `Everyone here is a little on edge, and the neighbors are doing construction and it is loud. It has been one of those stretches. Back to business: ${q}. Best regards`,
];
let n = 0;
for (const b of BASES) {
  for (const [wi, w] of WRAPS.entries()) {
    if ((n++ % 3) !== 0 && wi > 1) continue; // a spread over the base x wrapper grid (about 30 cases)
    const q = w(b); const p = planOf(q);
    check(`wrapped (${wi}) reads the plain plan: ${b}`, p != null && p === baseplan[b], p == null ? 'released' : 'plan differs');
  }
}

/* ---------- 2. wrappers that carry a condition are never dropped silently */
const COND = [
  ['only the cancelled ones, what is the average invoice amount', 'what is the average invoice amount'],
  ['Hi, not the Phoenix ones please. What is the average invoice amount', 'what is the average invoice amount'],
  ['For Carlos Mendez only: what is the average invoice amount', 'what is the average invoice amount'],
  ['I need this for March 2023 - what is the average invoice amount', 'what is the average invoice amount'],
  ['Thanks! Exclude anything under $500. What is the average invoice amount', 'what is the average invoice amount'],
  ['Hola, ignore the estimates. Show me the biggest invoice', 'show me the biggest invoice'],
  ['Hello. What is the average invoice amount? Also what is the median invoice amount?', 'what is the average invoice amount'],
  ['Quick question:\n- what is the average invoice amount\n- what is the median invoice amount\nthanks', 'what is the average invoice amount'],
  ['Hi, only the big ones. Show me the biggest invoice', 'show me the biggest invoice'],
  ['I never want the unpaid ones. What is the average invoice amount. Thanks', 'what is the average invoice amount'],
  ['Between us, the customers in Phoenix are the ones I care about, but what is the average invoice amount', 'what is the average invoice amount'],
  ['Sorry to bother you, the invoices from last week matter most, what is the average invoice amount', 'what is the average invoice amount'],
];
for (const [q, base] of COND) {
  const p = planOf(q); const bp = planOf(base);
  check(`condition kept or released: ${q.slice(0, 70).replace(/\n/g, ' / ')}`, p == null || p !== bp, p === bp ? 'chatter swallowed a condition' : '');
}

/* ---------- 3. releases that must stay releases (cores that are not provably one question) */
const REL = [
  'What is the average invoice amount? And what is the median estimate? Thanks',
  'Hi!\n1. what is the average invoice amount\n2. what is the median estimate',
  'Hola, por fa: list the customers in Phoenix, mil gracias',
  'Hi, how many invoices will we get next month? Thanks',
  'how many invoices will we get next month',
  'Hola! What will revenue be next month, gracias',
  'Thanks, and by the way the printer is jammed. What? Which? Who?',
  'asdf qwer zxcv invoices zxcv in the 2024 thanks por fa',
];
for (const q of REL) check(`released: ${q.slice(0, 60).replace(/\n/g, ' / ')}`, planOf(q) == null);
check('R24: a plain count with a year and its wrapped form read the same plan (counts with a period are now safe once unwrapped)', planOf('how many invoices in 2024') != null && planOf('Hola, por fa: how many invoices in 2024, mil gracias') === planOf('how many invoices in 2024'));

/* ---------- 4. the kill switch and the unit helpers */
process.env.DONOVAN_DQL_UNWRAP = '0';
check('kill switch: wrapped question is released again', planOf(WRAPS[0](BASES[0])) == null);
delete process.env.DONOVAN_DQL_UNWRAP;
check('kill switch off: wrapped question answered', planOf(WRAPS[0](BASES[0])) === baseplan[BASES[0]]);
const vocab = compileVocab(tv, pack);
check('metaClause: speech-act negation', U.metaClause("I can't not ask this") && U.metaClause("I won't say I'm not curious"));
check('metaClause: a clause that names something is not meta', !U.metaClause('Not the cancelled ones') && !U.metaClause("I don't want the vendors") && !U.metaClause('no invoices in 2023'));
check('stripPhrases: closer', U.stripPhrases('how many invoices in 2024, por fa, es urgente, mil gracias', vocab) === 'how many invoices in 2024');
check('stripPhrases: opener', U.stripPhrases('Oiga, hola, how many invoices in 2024', vocab) === 'how many invoices in 2024');
check('stripPhrases: a company word is never stripped', U.stripPhrases('how many invoices', vocab) === 'how many invoices');
check('unwrapQuestion: two questions are not unwrapped', U.unwrapQuestion('Hi, how many invoices? And how many estimates?', vocab) == null);
check('unwrapAllows: safe kinds only', U.unwrapAllows({ op: 'max' }) && U.unwrapAllows({ op: 'count', filters: [] }) && U.unwrapAllows({ op: 'tm_compare' }) && !U.unwrapAllows({ op: 'group_count' }) && !U.unwrapAllows(null));
check('unwrapQuestion: digits in a side sentence block it', U.unwrapQuestion('Only 2023 please. Hi there. what is the average invoice amount', vocab) == null);
check('unwrapQuestion: plain question has nothing to strip', U.unwrapQuestion('what is the average invoice amount', vocab) == null);
check('api/ keeps its 12 top-level files', fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile()).length === 12);

realLog(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
