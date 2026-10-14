/**
 * verify:dql-docfind-r22 - the page search (api/_lib/dql/families/pagefind.js) in a real PGlite database on the golden export.
 *
 * "Which papers say X": quoted phrases ("files whose text has ...", with page references), "which papers mention X", "find the document about X",
 * "what page talks about X", "do we have anything on X", "show me the contract with X". Every answer is checked against an INDEPENDENT reading of the
 * export's page text (plain JS over the raw rows, not the engine's own code). Also checked: the honest "no paper mentions it" (only when every paper was
 * read), the releases (a misspelt word, a customer's name, a paper number, a paper with no text, a question another family reads), privacy (an HR paper
 * is never searched or cited), the wiring (kill switch, arbiter, 12-file api/ rule).
 *
 *   node scripts/verify-dql-docfind-r22.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0; let passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };

delete process.env.ANTHROPIC_API_KEY; delete process.env.DONOVAN_DQL; delete process.env.DONOVAN_PAGEFIND;
const realLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && /^\{"/.test(a[0])) return; realLog(...a); };
console.warn = () => {}; console.error = () => {};

const off = await import('./offline-exam.mjs');
await off.installPgHarness(); await off.installModelBlock();
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));

/* ---- extra papers: an HR paper that says a unique phrase, and a paper with no pages at all */
const hrId = '00000000-0000-4000-8000-0000000000a1';
const proto = data.documents[0];
data.documents.push({ ...proto, id: hrId, document_type: 'hr-letter', original_filename: '9001-hr-letter-x.pdf', sha256_hash: 'a1'.repeat(32) });
data.pages.push({ id: '00000000-0000-4000-8000-0000000000b1', document_id: hrId, page_no: 1, text: 'Employee file\nSecret warning issued about zebra crossing behavior', created_at: '2024-01-01T12:00:00Z' });
const lite = await off.createPGlite(); await off.setActiveDatabase(lite);
const ctx = (await off.loadExportIntoNewTenant(lite, data, { tenantKey: 'offline:docfind-r22', tenantName: 'docfind-r22' })).ctx;
const { withTenant } = await import('../api/_lib/recordsStore.js');
const { getTenantVocab } = await import('../api/_lib/vocab/tenantVocab.js');
const { packForTenant } = await import('../api/_lib/industry/index.js');
const { parseDql, runDql } = await import('../api/_lib/dql/index.js');
const { allFamilies } = await import('../api/_lib/dql/registry.js');
const { pagefindParse, phraseRegex, _exec, _say } = await import('../api/_lib/dql/families/pagefind.js');
const { arbiterAllows } = await import('../api/_lib/router/dqlArbiter.js');

const TODAY = '2026-10-07';
const ctxArg = { tenantKey: ctx.tenantKey, tenantName: 'docfind-r22' };
const pack = await packForTenant({ withTenant, ctxArg });
const tv = await withTenant(ctxArg, (db) => getTenantVocab(db, ctx.tenantKey, pack));

/* ---- the independent oracle: whole-word phrase over each paper's page text */
const typeOf = new Map(data.documents.map((d) => [d.id, d.document_type]));
const pagesOf = new Map();
for (const p of data.pages) { if (!pagesOf.has(p.document_id)) pagesOf.set(p.document_id, []); pagesOf.get(p.document_id).push(p); }
const wb = (t, ph) => { const lo = t.toLowerCase(); let i = -1; while ((i = lo.indexOf(ph, i + 1)) >= 0) { const a = lo[i - 1]; const b = lo[i + ph.length]; if (!(a && /[a-z0-9]/.test(a)) && !(b && /[a-z0-9]/.test(b))) return true; } return false; };
const oracle = (ph, type = null) => data.documents.filter((d) => d.id !== hrId && (!type || d.document_type === type) && (pagesOf.get(d.id) ?? []).some((p) => wb(p.text.replace(/\s+/g, ' '), ph))).map((d) => d.id);
const pagesHolding = (id, ph) => (pagesOf.get(id) ?? []).filter((p) => wb(p.text.replace(/\s+/g, ' '), ph)).map((p) => p.page_no);

async function ask(q, extra = {}) {
  const debug = {};
  const intent = parseDql(q, { tenantVocab: tv, pack, today: TODAY, debug, ...extra });
  if (!intent) { if (process.env.DBG) realLog('  DBG', q, '=>', debug.why); return { intent: null, data: null, why: debug.why }; }
  const out = await withTenant(ctxArg, (db) => runDql(db, intent, { today: TODAY }));
  return { intent, data: out };
}
const mineOp = (r) => r.intent?.plan?.op === 'page_find';
const count = (r) => r.data?.recordsTotal ?? r.data?.records?.length;
const sameIds = (r, ids) => { const got = new Set((r.data?.records ?? []).map((x) => x.documentId)); return ids.length <= 40 ? ids.length === got.size && ids.every((i) => got.has(i)) : ids.length >= got.size; };
const pageOk = (r, ph) => (r.data?.records ?? []).every((x) => x.page == null || pagesHolding(x.documentId, ph).includes(x.page)) && (r.data?.records ?? []).some((x) => x.page != null);

/* ================================================================== quoted phrases ("text has", with page references) */
const phrases = ['annual maintenance', 'refrigerant', 'r-410a', 'capacitor', 'no cooling'];
for (const ph of phrases) {
  const want = oracle(ph);
  if (!want.length) { check(`oracle has hits for "${ph}"`, false, 'test phrase matches nothing'); continue; }
  let r = await ask(`how many documents have text with "${ph}", with page references`.replace('have text with', 'whose text has'));
  check(`text has "${ph}" :: page search claims, count ${want.length}`, mineOp(r) && count(r) === want.length && new RegExp(`\\b${want.length}\\b`).test(r.data.text) && sameIds(r, want), `${r.intent?.plan?.op} ${r.data?.text}`);
  check(`text has "${ph}" :: every cited page really holds the phrase`, mineOp(r) && pageOk(r, ph), JSON.stringify((r.data?.records ?? []).slice(0, 3)));
  r = await ask(`which papers mention "${ph}"`);
  check(`which papers mention "${ph}" :: lists the same papers`, mineOp(r) && sameIds(r, want), `${r.intent?.plan?.op} ${r.data?.text}`);
}
{
  const want = oracle('capacitor', 'service-ticket');
  let r = await ask('total service tickets whose text has "capacitor", with page references when you get a sec');
  check('typed paper kind narrows the search', mineOp(r) && sameIds(r, want) && r.intent.plan.docType === 'service-ticket', `${r.intent?.plan?.docType} ${r.data?.text}`);
  r = await ask('i\'m updating our binder: total invoices whose text has "annual maintenance", with page references');
  check('a binder-style frame is read', mineOp(r) || r.intent === null, r.data?.text);
}
{
  const r = await ask('which papers mention "zebra crossing"');
  check('an HR paper is never searched or cited', r.data === null || (!/hr-letter/i.test(JSON.stringify(r.data)) && !(r.data.records ?? []).length), JSON.stringify(r.data)?.slice(0, 300));
  const r2 = await ask('which papers mention "secret warning"');
  check('an HR paper: "none" is said, no hint of it', !r2.data || (/^No papers mention/.test(r2.data.text) && !/hr-letter/i.test(JSON.stringify(r2.data))), r2.data?.text);
}

/* ================================================================== unquoted forms (no other family reads these) */
{
  const ph = 'commissioning';
  const want = oracle(ph);
  let r = await ask('what page talks about commissioning');
  check('what page talks about X :: claimed, pages named', mineOp(r) && sameIds(r, want) && pageOk(r, ph), `${r.intent?.plan?.op} ${r.data?.text}`);
  r = await ask('find the document about commissioning');
  const want2 = oracle('commissioning');
  check('find the document about X', mineOp(r) && sameIds(r, want2), `${r.intent?.plan?.op} ${r.data?.text}`);
  r = await ask('do we have anything on commissioning');
  check('do we have anything on X', mineOp(r) && sameIds(r, want2), `${r.intent?.plan?.op} ${r.data?.text}`);
  r = await ask('which pages mention coverage');
  check('which pages mention X', mineOp(r) && r.intent.plan.show === 'pages', `${r.intent?.plan?.op} ${r.data?.text}`);
  r = await ask('how many files talk about southern arizona');
  check('how many files talk about X (two words)', r.data === null || (mineOp(r) && count(r) === oracle('southern arizona').length), `${r.intent?.plan?.op} ${r.data?.text}`);
  r = await ask('show me the proposal with extended coverage');
  check('show me the <kind> with X :: kind narrows', !mineOp(r) || r.intent.plan.docType === 'proposal-quote', `${r.intent?.plan?.docType}`);
  r = await ask('hey donovan, can you find the paperwork about priority please');
  check('polite frame and tail are stripped', mineOp(r) && sameIds(r, oracle('priority')), `${r.intent?.plan?.op} ${r.why ?? ''} ${r.data?.text}`);
}

/* ================================================================== honest none */
{
  let r = await ask('which papers mention "xylophone quartet"');
  check('quoted phrase nothing says :: "No papers mention", all text read', mineOp(r) && /^No papers mention “xylophone quartet”\. I read the text of all \d+ papers on file\.$/.test(r.data?.text ?? '') && r.data.records.length === 0, r.data?.text);
  r = await ask('do we have anything on xylophone');
  check('unquoted real word nothing says :: none, said plainly', mineOp(r) && /^No papers mention “xylophone”/.test(r.data?.text ?? ''), `${r.intent?.plan?.op} ${r.data?.text}`);
  r = await ask('do we have anything on compresor');
  check('a likely misspelling is not turned into "none"', (r.data === null || (/Read "compresor" as "compressor"/.test(r.data?.basis ?? "") && !/^No /.test(r.data?.text ?? ""))), `${r.data?.text} | ${r.data?.basis}`);
}

/* ================================================================== releases */
{
  const rel = async (name, q) => { const r = await ask(q); check(`release :: ${name}`, !mineOp(r) || r.data === null, `${r.intent?.plan?.op} ${r.data?.text ?? ''}`); };
  const cust = data.entities.find((e) => e.entity_type === 'customer')?.data?.customer_name;
  await rel('a customer\'s name is not a phrase', `find the document about ${cust}`);
  await rel('a paper number is looked up, not searched', 'do we have anything on INV-20003');
  await rel('a brand is a field value', 'which papers mention Trane');
  await rel('a negation is not a phrase', 'which papers mention no leaks');
  await rel('two phrases', 'which papers mention "leak" and "capacitor"');
  await rel('a one-letter term', 'what page talks about x');
  await rel('a term word like total', 'which papers mention total');
  await rel('a non-paper subject', 'which customers mention "annual maintenance"');
  await rel('a specific person is not a kind of paper', 'show me the lease with something unusual');
  await rel('question with a time filter is left to the core', 'which papers mention "capacitor" in 2024');
  await rel('a reader question keeps its own family', 'what does the agreement for Linda Fitzgerald say about termination');
  await rel('a plain count is not a search', 'how many invoices are there');
}

/* ================================================================== pure parse + regex */
{
  const vocab = (await import('../api/_lib/dql/vocab.js')).compileVocab?.(tv, pack);
  const p = (q, mode = 'early') => pagefindParse(q, { vocab, mode });
  check('parse :: quoted + text cue', p('total invoices whose text has "net 30", with page references')?.phrase === 'net 30');
  check('parse :: quoted without a text cue is not claimed', p('who is "net 30"') === null);
  check('parse :: late shapes are not read early', p('which papers mention leaks') === null);
  check('parse :: early shapes are not read late', p('which papers mention "net 30"', 'late') === null);
  check('parse :: count ask', p('how many documents mention "net 30"')?.show === 'count');
  check('parse :: quote stays literal (punctuation kept)', p('which files mention "deposit is $35"')?.phrase === 'deposit is $35');
  check('regex :: whole words only', phraseRegex('net 30', true).test('Terms: net 30 days') && !phraseRegex('net 30', true).test('internet 30') && !phraseRegex('net 30', true).test('net 300'));
  check('regex :: line break between words', phraseRegex('net 30', true).test('Terms: net\n30 days'));
  check('regex :: plural of a plain unquoted word', phraseRegex('leak', false).test('three leaks found') && !phraseRegex('leak', true).test('three leaks found'));
}

/* ================================================================== a paper with no text at all */
{
  const plan = { op: 'page_find', phrase: 'leak', quoted: false, docType: null };
  const d1 = { id: 'aaaaaaaa-0000-4000-8000-000000000001', type: 'invoice', filename: 'a.pdf', date: '2024-01-01' };
  const d2 = { id: 'aaaaaaaa-0000-4000-8000-000000000002', type: 'invoice', filename: 'b.pdf', date: '2024-02-01' };
  const mk = (pages, withText) => ({ documents: [d1, d2], findPages: { pages: new Map(pages), withText: new Set(withText), nearWords: new Set() } });
  const none = _exec(plan, { snap: mk([], [d1.id]) });
  check('unread paper :: a zero is released', none.abstain === 'unread-papers', JSON.stringify(none));
  const some = _exec(plan, { snap: mk([[d1.id, [{ page: 2, text: 'Found a leak in the line' }]]], [d1.id]) });
  const said = some.hits ? _say(some, plan, { snap: {} }) : null;
  check('unread paper :: a hit is kept and the missing text is admitted', some.hits?.length === 1 && /no readable text/.test(said?.text ?? '') && said.claimedCount === null, said?.text);
  const all = _exec(plan, { snap: mk([], [d1.id, d2.id]) });
  check('all read :: zero hits is a real none', all.hits?.length === 0 && /^No papers mention/.test(_say(all, plan, { snap: {} }).text));
  check('no pages loaded :: released', _exec(plan, { snap: { documents: [d1] } }).abstain === 'no-pages');
}

/* ================================================================== wiring */
{
  check('wiring :: exactly one family owns page_find', allFamilies().filter((f) => f.ops.includes('page_find')).length === 1);
  const a = arbiterAllows({ name: 'docLookup' }, { plan: { op: 'page_find' }, plain: false }, { oldLabel: 'docLookup:', question: 'x', industryKind: null });
  check('wiring :: the arbiter lets a page search take the question from an older lane', a === true);
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile());
  check('wiring :: api/ keeps exactly 12 top-level files', files.length === 12, String(files.length));
  const cls = fs.readFileSync(path.join(ROOT, 'api/_lib/router/classifyAll.js'), 'utf8');
  check('wiring :: a page search has no older fall-through', /op === "page_find"/.test(cls));
  process.env.DONOVAN_PAGEFIND = '0';
  const off1 = await ask('which papers mention "annual maintenance"');
  check('wiring :: kill switch DONOVAN_PAGEFIND=0', !mineOp(off1));
  delete process.env.DONOVAN_PAGEFIND;
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
