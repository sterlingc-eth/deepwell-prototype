/**
 * verify:shapes-r15 - round 15: three question shapes that were answered with one half or not at all.
 *  1. two measures of the same papers ("how many invoices in 2025 and what was the total", "total and average", "how many ... and when was the first one",
 *     "how many ... and the names of the clients", "the invoice count and the permit count"): both parts or the whole question is released
 *  2. "where did that come from" / "which documents say that" / "show me the source": the previous question again, with the papers behind it named
 *  3. "no, I meant 2024" / "not Linda, Lisa" / "scratch that, letters": the previous question again with the corrected value
 *  plus: this year vs last year is this year so far against the same stretch of last year ("the whole of last year" keeps it whole);
 *  the days between the first and the last paper of one kind for one customer, and "days apart" for two numbered papers.
 *   node scripts/verify-shapes-r15.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 400)}`}`); };
delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL;
const realLog = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); }; console.warn = () => {}; console.error = () => {};

/* ---------------------------------------------------------------- pure pieces */
const { stripSourceAsk, isSourceFollowup, sourcesSentence } = await import('../api/_lib/dql/cite.js');
const { twoMeasureSignal, multiRespell, respellVersusLast } = await import('../api/_lib/dql/multi.js');
const { provenanceFollowup } = await import('../api/_lib/followup/provenance.js');
const { correctionPayload } = await import('../api/_lib/followup/correction.js');

for (const q of ['how many invoices in 2022 and what was the total', 'give me the total plus the average amount of receipts in 2024', 'how many permits in 2023 and when was the last one', 'number of receipts during 2020 plus the client with the most', 'number of invoices in 2021 and the names of the clients', 'how many invoices and how many receipts in 2022', 'Count the invoices in Q4 2023 And Give Me The Dollar Total'])
  check(`two measures asked: ${q}`, twoMeasureSignal(q));
for (const q of ['how many invoices in 2022', 'how many invoices in total', 'total of invoices in 2022', 'how many invoices have a total over 500 and were issued in 2024', 'how many invoices for Smith and Sons', 'who is the tech for INV-1001', 'average invoice in 2024'])
  check(`one measure: ${q}`, !twoMeasureSignal(q));

check('source tail is removed', stripSourceAsk('total of bills for Q4 2023 and which files that came from').cite === true && !/files/.test(stripSourceAsk('total of bills for Q4 2023 and which files that came from').q));
check('"which documents say how many" keeps the question', stripSourceAsk('which documents say how many invoices we have in 2025').q.replace(/\s+/g, ' ').trim() === 'how many invoices we have in 2025');
check('"with sources" is a source ask', stripSourceAsk('total invoices in 2024 with sources').cite);
check('a plain question has no source ask', !stripSourceAsk('how many invoices came from Mesa in 2024').cite);
for (const q of ['where did that come from', "where's that from", 'show me the source', 'what are you basing that on', 'which invoices is that from', 'show your work', 'give me the source documents as fast as you can', 'which files did that come from', 'what is the source for that please'])
  check(`source follow-up: ${q}`, isSourceFollowup(q));
for (const q of ['how many invoices came from Mesa', 'where is the Mesa office', 'which invoices were sent in 2024', 'how many invoices in 2024', 'what is the total of invoices'])
  check(`not a source follow-up: ${q}`, !isSourceFollowup(q));
{
  const turns = [{ question: 'How many invoices in 2022?' }];
  check('source follow-up becomes the earlier question plus the source ask', provenanceFollowup(turns, 'where did that come from')?.query === 'How many invoices in 2022 and which files that came from');
  check('a source follow-up with nothing before it is not rewritten', provenanceFollowup([], 'where did that come from') == null);
  check('a source follow-up after a source follow-up is not rewritten', provenanceFollowup([{ question: 'where did that come from' }], 'show me the source') == null);
}
check('sources sentence names the paper, its date and page', sourcesSentence([{ documentId: 'a', label: 'inv-1.pdf', sublabel: 'Invoice · Jan 2, 2024', page: 2 }], 1) === 'Sources: inv-1.pdf (Invoice · Jan 2, 2024, page 2).');
check('sources sentence says how many more', /and 7 more/.test(sourcesSentence(Array.from({ length: 5 }, (_, i) => ({ documentId: String(i), label: `f${i}.pdf` })), 12)));

for (const [q, want] of [['no, I meant 2024', '2024'], ['Oh wait I wanted Lakewood', 'Lakewood'], ['not Linda, Lisa', 'Lisa'], ['scratch that, letters', 'letters'], ['Oh wiat I wqnted 2019', '2019'], ['actually 2023 please', '2023']])
  check(`correction value: ${q}`, correctionPayload(q) === want, correctionPayload(q));
for (const q of ['what about 2024', 'how many invoices in 2024', 'no invoices were sent in 2024 and what is the total', 'and in Mesa?'])
  check(`not a correction: ${q}`, correctionPayload(q) == null, correctionPayload(q));
check('top customer wording is respelled', /who is the top client/.test(multiRespell('number of receipts during 2020 plus the client with the most')));
check('"this year versus last" gets its year', /versus last year/.test(respellVersusLast('count of receipts this year versus last')));

/* ---------------------------------------------------------------- the engine over the golden export */
const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:r15', tenantName: 'r15' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'r15' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));
const TODAY = '2026-10-07';
const parse = (q) => parseDql(q, { tenantVocab: tv, pack, today: TODAY });
const run = async (q) => { const i = parse(q); return i ? withTenant(ctxArg, (db) => runDql(db, i, { today: TODAY })) : null; };
const nums = (t) => [...String(t ?? '').matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0]);

{
  const cnt = await run('how many invoices in 2025'); const tot = await run('total of invoices in 2025');
  const both = await run('how many invoices in 2025 and what was the total');
  check('count + total: a multi plan', parse('how many invoices in 2025 and what was the total')?.plan?.op === 'multi');
  check('count + total: the count of the single question is in the answer', cnt?.text && both?.text && nums(cnt.text)[0] && both.text.includes(nums(cnt.text)[0]), `${cnt?.text} | ${both?.text}`);
  check('count + total: the total of the single question is in the answer', tot?.text && both?.text && both.text.includes(nums(tot.text).find((n) => n.startsWith('$'))), `${tot?.text} | ${both?.text}`);
  check('count + total: both parts are in one answer', /\$/.test(both?.text ?? '') && /\d/.test(both?.text ?? ''));
  const rev = await run('total of invoices in 2025 and how many');
  check('total + count in the other order is a multi plan too', parse('total of invoices in 2025 and how many')?.plan?.op === 'multi' && /\$/.test(rev?.text ?? ''), rev?.text);
  const avg = await run('total and average of invoices in 2025');
  check('total + average: both figures', /total/i.test(avg?.text ?? '') && /average/i.test(avg?.text ?? ''), avg?.text);
  const ext = await run('how many invoices in 2025 and when was the first one');
  check('count + first date: the count and the earliest paper', parse('how many invoices in 2025 and when was the first one')?.plan?.op === 'multi' && /earliest|first/i.test(ext?.text ?? ''), ext?.text);
  const two = await run('how many invoices and how many quotes in 2025');
  check('two kinds of paper: one count each', parse('how many invoices and how many quotes in 2025')?.plan?.op === 'multi' && (two?.text ?? '').split(/\.\s/).length >= 2, two?.text);
  check('two measures for two different kinds of paper are released', parse('how many invoices in 2025 and the total of quotes') == null);
  check('two periods for the total are not one combined figure', parse('how many invoices in 2024 and what was the total in 2025') == null);
  const src = await run('total of invoices in 2025 and which files that came from');
  check('source ask: the answer names the papers', /Sources: /.test(src?.text ?? '') && (src?.records?.length ?? 0) > 0, src?.text);
  check('source ask: the total is the same as without it', src?.text && tot?.text && src.text.startsWith(tot.text.replace(/\s+$/, '').slice(0, 30)), `${src?.text?.slice(0, 80)} | ${tot?.text?.slice(0, 80)}`);
  const yoy = await run('invoice dollars this year compared with last year');
  check('this year vs last year uses the same stretch of last year', /through Oct 7, 2025/.test(yoy?.text ?? ''), yoy?.text);
  const whole = await run('invoice dollars this year compared with the whole of last year');
  check('"the whole of last year" is never cut to the same stretch (kept whole, or released)', !whole || !/through Oct 7, 2025/.test(whole.text ?? ''), whole?.text);
}
{
  // days apart for two numbered papers: the same answer as "days between"
  const a = parse('days between INV-20075 and INV-20076'); const b = parse('how many days apart are INV-20075 and INV-20076');
  check('days apart is read like days between', JSON.stringify(a?.plan ?? null) === JSON.stringify(b?.plan ?? 1), JSON.stringify([a?.plan, b?.plan]));
}
const apiTop = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile()).length;
check('api/ keeps 12 top-level files', apiTop === 12, String(apiTop));
console.log = realLog; console.log(`\n${passes} passed, ${failures} failed`); process.exit(failures ? 1 : 0);
