/**
 * Demo mode checks (VITE_DEEPWELL_DEMO): the industry demo page at /demo/ and its synthetic sample workspaces.
 *   1. every industry in the picker has a workspace that loads, with the agreed first five in order
 *   2. the sample data is plainly fictional (invented names, 555-01xx phones, example.com e-mail) and marked synthetic
 *   3. ingestion: every document goes Uploaded -> Reading pages -> Fields found -> Matched, and the dashboard adds up
 *   4. Donovan: every suggested question, asked of the real reader (api/_lib/dql/reader-v2) over that industry's records, gives the
 *      answer the demo shows, and that answer holds the gold value worked out from the records; the "did you mean" example offers the right name
 *   5. isolation: the demo page uses no sign-in, API, store or database code; api/ still has 12 top-level files; the page is built only with the switch on
 *   npm run verify:industry-demo                       all industries
 *   npx tsx scripts/verify-industry-demo.ts --only realty,electrical   some industries (step 4 is the slow one)
 *   npx tsx scripts/verify-industry-demo.ts --skip-reader              steps 1-3 and 5 only
 * Needs no network, no key, no model call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askDemo, dashboardOf, demoFlagOn, ingestPlan, nearName, stagesAfter, INGEST_STAGES, type DemoFixture, type DemoIndex } from '../src/demo/engine';
// @ts-expect-error plain JS module
import { SURNAMES, FIRST, PLACES, STREETS, goldMatches, polish } from './demo/demoData.mjs';
// @ts-expect-error plain JS module
import { CORE } from './demo/industries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'src', 'demo', 'fixtures'); const REC = path.join(ROOT, 'scripts', 'fixtures', 'industry-demo');
const argv = process.argv.slice(2); const argOf = (k: string) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const only = argOf('only')?.split(','); const skipReader = argv.includes('--skip-reader');
let passed = 0; const failures: string[] = [];
const ok = (c: unknown, name: string) => { if (c) passed++; else failures.push(name); };

/* ---------------------------------------------------------------- 1. index + fixtures */
const index = JSON.parse(fs.readFileSync(path.join(FX, 'index.json'), 'utf8')) as DemoIndex;
const coreSlugs = (CORE as Array<{ slug: string }>).map((c) => c.slug);
ok(JSON.stringify(index.industries.slice(0, 5).map((i) => i.slug)) === JSON.stringify(coreSlugs), 'picker starts with realty, property management, plumbing & HVAC, electrical, general contractor');
ok(index.industries.filter((i) => i.core).length === 5, 'exactly five featured industries');
ok(new Set(index.industries.map((i) => i.slug)).size === index.industries.length, 'industry slugs are unique');
const list = index.industries.filter((i) => !only || only.includes(i.slug));
const fixtures: DemoFixture[] = [];
for (const i of list) {
  const f = path.join(FX, `${i.slug}.demo.json`); const r = path.join(REC, `${i.slug}.records.json`);
  ok(fs.existsSync(f) && fs.existsSync(r), `[${i.slug}] workspace and records files exist`);
  if (!fs.existsSync(f)) continue;
  const fx = JSON.parse(fs.readFileSync(f, 'utf8')) as DemoFixture; fixtures.push(fx);
  const t = `[${i.slug}]`;
  ok(fx.slug === i.slug && fx.label === i.label && fx.company === i.company, `${t} index entry matches the workspace`);
  ok(fx.synthetic === true, `${t} marked synthetic`);
  ok(fx.documents.length >= 12 && fx.documents.length <= 30, `${t} 12-30 sample documents (${fx.documents.length})`);
  ok(new Set(fx.documents.map((d) => d.typeLabel)).size >= 4, `${t} at least 4 kinds of document`);
  ok(fx.questions.length >= 4 && fx.questions.length <= 8, `${t} 4-8 suggested questions (${fx.questions.length})`);
  ok(new Set(fx.questions.map((q) => q.q.toLowerCase())).size === fx.questions.length, `${t} suggested questions are distinct`);
  ok(!!fx.didYouMean, `${t} has a "did you mean" example`);
  const ids = new Set(fx.documents.map((d) => d.id));
  for (const q of fx.questions) for (const id of q.answer.docs) ok(ids.has(id), `${t} "${q.q}" cites a document in the workspace`);
  for (const d of fx.documents) ok(d.pages.length >= 1 && d.pages.every((p) => p.trim().length > 20), `${t} ${d.name} has page text`);

  /* ------------------------------------------------------------ 2. plainly fictional */
  const surn = new Set(SURNAMES as string[]), first = new Set(FIRST as string[]);
  const isPerson = (n: string) => { const w = n.split(' '); return w.length === 2 && first.has(w[0]!) && surn.has(w[1]!); };
  const isOrg = (n: string) => (PLACES as string[]).some((p) => n.startsWith(p + ' '));
  ok(fx.customers.every((c) => isPerson(c.name) || isOrg(c.name)), `${t} every ${fx.customerNoun} name is from the invented lists`);
  ok(fx.staff.every(isPerson), `${t} every staff name is from the invented list`);
  ok((PLACES as string[]).some((p) => fx.company.startsWith(p)), `${t} company name is invented (${fx.company})`);
  ok(fx.customers.every((c) => /@([a-z0-9-]+\.)*example\.com$/.test(c.email) && /\(480\) 555-01\d\d$/.test(c.phone)), `${t} e-mail at example.com, phones 555-01xx`);
  ok(fx.customers.every((c) => (STREETS as string[]).some((s) => c.address.includes(s))), `${t} street names are invented`);
  const named = new Set([...fx.customers.map((c) => c.name), ...fx.staff]);
  const lines = fx.documents.flatMap((d) => d.pages.join('\n').split('\n')).map((l) => /^(?:[A-Z][a-z ]+): (.+)$/.exec(l)).filter(Boolean).map((m) => m![1]!);
  const partyLines = fx.documents.flatMap((d) => d.pages.join('\n').split('\n').filter((l) => new RegExp(`^${fx.customerNoun}: `, 'i').test(l)).map((l) => l.replace(/^[^:]+: /, '')));
  ok(partyLines.every((n) => named.has(n)), `${t} every party named on a document is a demo ${fx.customerNoun}`);
  ok(lines.length > 0, `${t} documents carry labelled fields`);

  /* ------------------------------------------------------------ 3. ingestion + dashboard */
  const plan = ingestPlan(fx);
  ok(plan.length === fx.documents.length * INGEST_STAGES.length, `${t} every document gets all ${INGEST_STAGES.length} processing steps`);
  ok(stagesAfter(fx, 0).size === 0, `${t} nothing is processed before the upload starts`);
  const all = stagesAfter(fx, plan.length); ok(fx.documents.every((d) => all.get(d.id) === 'Matched'), `${t} after the upload every document is matched`);
  const half = stagesAfter(fx, Math.floor(plan.length / 2)); ok(half.size > 0 && [...half.values()].some((s) => s !== 'Matched'), `${t} processing is visible part-way`);
  const dash = dashboardOf(fx);
  ok(dash.documents === fx.documents.length && dash.byType.reduce((s, x) => s + x.count, 0) === fx.documents.length, `${t} dashboard counts every document once`);
  ok(dash.customers >= 3 && dash.recent.length > 0, `${t} dashboard shows customers and recent documents`);
  const billed = fx.documents.filter((d) => d.kind === 'invoice' && d.direction === 'receivable').reduce((s, d) => s + (d.total ?? 0), 0);
  ok(Math.abs(dash.billed - billed) < 0.005 && dash.openBalance <= dash.billed + 0.005, `${t} billed and open balance add up`);

  /* ------------------------------------------------------------ demo ask logic */
  for (const q of fx.questions) { const r = askDemo(fx, q.q); ok(r.kind === 'answer' && r.question.id === q.id, `${t} "${q.q}" finds its own answer`); }
  for (const q of fx.questions) { const r = askDemo(fx, q.q.toLowerCase().replace(/\?$/, '')); ok(r.kind === 'answer' && r.question.id === q.id, `${t} lower-case, no question mark: "${q.q}"`); }
  if (fx.didYouMean) {
    const dy = fx.didYouMean; const n = nearName(fx, dy.q); const base = fx.questions.find((q) => q.id === dy.answerOf);
    ok(n?.suggestion === dy.suggestion && n?.corrected === dy.corrected, `${t} misspelled "${dy.typed}" is offered back as ${dy.suggestion}`);
    ok(!!base && base.q === dy.corrected, `${t} the corrected question is a suggested question`);
    const r = askDemo(fx, dy.q); ok(r.kind === 'did-you-mean', `${t} asking with the misspelled name shows "Did you mean"`);
    const r2 = askDemo(fx, dy.corrected); ok(r2.kind === 'answer' && r2.question.id === dy.answerOf, `${t} tapping the suggestion answers it`);
  }
  ok(askDemo(fx, 'what is the weather tomorrow').kind === 'try-suggested', `${t} an unrelated question points to the suggestions`);
  ok(fx.questions.every((q) => nearName(fx, q.q) === null), `${t} no suggested question is mistaken for a misspelling`);
}

/* ---------------------------------------------------------------- 4. the real reader answers every suggested question */
if (!skipReader && fixtures.length) {
  const { loadReaderV2, buildIndex } = await import('../api/_lib/dql/reader-v2/index.js' as string);
  const { decide } = await import('../api/_lib/dql/reader-v2/pipeline.js' as string);
  const R = await loadReaderV2(); const log = console.log;
  for (const fx of fixtures) {
    const records = JSON.parse(fs.readFileSync(path.join(REC, `${fx.slug}.records.json`), 'utf8'));
    ok(records.tenantName === fx.company && records.documents.length === fx.documents.length, `[${fx.slug}] records match the workspace`);
    const ix = buildIndex(records, 'demo-' + fx.slug); const types = [...new Set(records.documents.map((d: { document_type: string }) => d.document_type))];
    const gold = (fx as unknown as { gold: Record<string, unknown> }).gold;
    for (const q of fx.questions) {
      console.log = () => {}; let g: { answered: boolean; text: string; docs: string[] };
      try { g = await decide(ix, q.q, R.M); } finally { console.log = log; }
      ok(g.answered, `[${fx.slug}] Donovan answers "${q.q}"`);
      ok(polish(g.text, types) === q.answer.text, `[${fx.slug}] "${q.q}" gives the answer the demo shows`);
      ok(goldMatches(gold[q.id], g.text, g.docs), `[${fx.slug}] "${q.q}" is correct against the records`);
    }
  }
}

/* ---------------------------------------------------------------- 5. isolation + switch */
ok(demoFlagOn({ VITE_DEEPWELL_DEMO: 'true' }) && !demoFlagOn({}) && !demoFlagOn({ VITE_DEEPWELL_DEMO: 'false' }) && !demoFlagOn({ VITE_DEEPWELL_DEMO: true }) && !demoFlagOn(undefined), 'switch is on only for the exact string "true"');
const demoSrc = fs.readdirSync(path.join(ROOT, 'src', 'demo')).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => fs.readFileSync(path.join(ROOT, 'src', 'demo', f), 'utf8')).join('\n');
ok(!/from ['"](?:\.\.\/)+(?:services|store|hooks)\//.test(demoSrc) && !/@clerk\//.test(demoSrc) && !/\bfetch\(/.test(demoSrc) && !/['"`]\/api\//.test(demoSrc), 'demo page uses no sign-in, API, store or data-sync code');
ok(!/localStorage|sessionStorage|indexedDB/.test(demoSrc), 'demo page saves nothing in the browser');
const appSrc = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'demo' ? [] : appSrc(path.join(dir, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []);
ok(appSrc(path.join(ROOT, 'src')).every((f) => !/demo\/fixtures|from ['"][./]*demo\//.test(fs.readFileSync(f, 'utf8'))), 'the signed-in app never imports the demo workspaces');
const apiTop = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((e) => e.isFile());
ok(apiTop.length === 12, `api/ has 12 top-level files (${apiTop.length})`);
const vite = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
ok(/VITE_DEEPWELL_DEMO[\s\S]{0,120}=== 'true'[\s\S]{0,90}demo\/index\.html/.test(vite), 'the /demo/ page is built only when VITE_DEEPWELL_DEMO is "true"');
ok(/\/src\/demo\/main\.tsx/.test(fs.readFileSync(path.join(ROOT, 'demo', 'index.html'), 'utf8')), 'demo/index.html loads the demo page');

console.log(`verify:industry-demo  ${passed} passed, ${failures.length} failed  (${fixtures.length} industries${skipReader ? ', reader step skipped' : ''})`);
for (const f of failures.slice(0, 40)) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
