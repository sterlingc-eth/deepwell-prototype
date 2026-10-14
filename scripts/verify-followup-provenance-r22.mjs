#!/usr/bin/env node
/**
 * verify:followup-provenance-r22 - "where did that come from" follow-ups, round 22.
 *
 * A follow-up that only asks where the previous answer came from ("which document says that", "what's your source", "show me the page",
 * "where'd you get that number", "point me to the spot in the paper", with chatter and typos around it) becomes the earlier question again:
 *   - a "what does the paper say" question is asked again word for word, so the reader answers with the file, date and page it read;
 *   - any other earlier question gets "and which files that came from" added, so the answer names the real papers behind it.
 * Nothing is remembered between turns: the sources are recomputed from the records the person may see, so a private paper is never named and a
 * source is never invented. A new question that merely contains source words (a name, a number, another paper) is not a source follow-up.
 *
 * PART A: pure follow-up resolution (multi-turn). PART B: real /api/ask handler on the golden export (PGlite), models blocked.
 *   node scripts/verify-followup-provenance-r22.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passes = 0; let fails = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${String(detail).slice(0, 500)}`}`); };
delete process.env.ANTHROPIC_API_KEY;

const { validateConversationContext } = await import('../api/_lib/conversation.js');
const { resolveFollowup } = await import('../api/_lib/followup/index.js');
const { readerFollowup, sourceCore, isSourceAsk } = await import('../api/_lib/followup/readerfu.js');

const T = (...qs) => qs.map((question) => ({ question, askedAt: '2026-10-07T10:00:00.000Z' }));
const resolve = (turns, q) => resolveFollowup(validateConversationContext({ turns }), q);
const REASK = (turns, q) => { const r = resolve(turns, q); return r.isFollowup ? r.query : null; };

// ---------------------------------------------------------------- A1: noisy "point me to the spot" asks re-ask the paper question word for word
const paperQs = [
  'what does the lease for Joyce Ward say about late fees',
  'Hey Donovan, what damage repair is written in the termite bond for Alexander Spencer on 5/22/2021 when you get a sec?',
  'Check the dockage statement dated Jul 5 2023 for Lisa Weaver and tell me the payment terms - trying to settle something in the office',
  'Quote guest count sentence in run for Charles Barrett dated 9/7/2018',
  'pull the weight from the visit record for Sandra Martinez dated 2025-07-15',
];
const pageAsks = [
  'can you point me to the spot in the paper',
  'My bookkeeper is asking: can you point me to the spot in the paper',
  'necesito saber can you point me to the spot in the paper gracias',
  'Me puedes decir can u point me to the spot in the paper - from the documents we have',
  'Can you help me? can you pont me to the spot in the pper asp',
  'necEsitO sabEr can yOu poInt ME tO THe Spot in thE paPer GrAcIas 👍',
  'which page is that on',
  'show me the exact line',
];
for (const p of paperQs) for (const a of pageAsks.slice(0, 6)) {
  const got = REASK(T(p), a);
  check(`reask: "${a.slice(0, 40)}" after "${p.slice(0, 30)}"`, got != null && (got.replace(/[?.!\s]+$/, '') === p.replace(/[?.!\s]+$/, '') || (/\bcount\b/i.test(p) && got === `${p} and which files that came from`)), got);
}
for (const a of pageAsks.slice(6)) check(`reask: "${a}" after a paper question`, REASK(T(paperQs[0]), a) === paperQs[0]);

// ---------------------------------------------------------------- A2: the generic wordings after a count / lookup name the papers behind it
const countQ = 'how many invoices did we send in 2022';
const generic = ['which document says that', "what's your source", 'show me the page', "where'd you get that number", 'where did that come from', 'which page is that on', 'what file is that from', 'can you cite that', 'give me the page number', 'show me where it says that', 'source?', 'which documents did you use'];
for (const a of generic) check(`sources: "${a}" after a count`, REASK(T(countQ), a) === `${countQ} and which files that came from`, REASK(T(countQ), a));
for (const a of ['Can you help me? what is your source asap', 'necesito saber show me the page gracias']) check(`sources: noisy "${a}" after a count`, REASK(T(countQ), a) === `${countQ} and which files that came from`, REASK(T(countQ), a));

// ---------------------------------------------------------------- A3: chains
{
  const t = T(paperQs[0], 'who signed it');
  check('chain: source ask after "who signed it" rebuilds that question', REASK(t, 'where did that come from') === 'who signed the lease for Joyce Ward');
  check('chain: noisy page ask after "who signed it" still stays on the paper', REASK(t, 'necesito saber can you point me to the spot in the paper gracias') === 'who signed the lease for Joyce Ward');
  const t2 = T('pull the weight from the visit record for Sandra Martinez dated 2025-07-15', 'point me to the spot in the paper');
  { const g = REASK(t2, 'which page is that on'); check('chain: a second page ask goes back to the same root question', g === 'pull the weight from the visit record for Sandra Martinez dated 2025-07-15' || g === 'pull the weight from the visit record for Sandra Martinez dated 2025-07-15 and which files that came from', g); }
  const t3 = T(countQ, 'where did that come from');
  check('chain: a second source ask after a source ask is not stacked', REASK(t3, 'show me the page') === null || !/and which files that came from.*and which files that came from/.test(REASK(t3, 'show me the page')));
}

// ---------------------------------------------------------------- A4: releases (these must NOT become a source follow-up)
const rel = (name, turns, q, lax) => check(`release: ${name}`, !readerFollowup(turns, q) && (lax || (!(resolve(turns, q).isFollowup && /which files that came from/.test(resolve(turns, q).query)) && !isSourceAsk(q))), `${JSON.stringify(resolve(turns, q))}`);
rel('a new question naming a customer and a paper', T(paperQs[0]), 'show me the page for the lease of Bob Jones');
rel('a question with a number', T(countQ), 'where did the 2023 number come from');
rel('a different ask that only has source words', T(countQ), 'what is the source of the water damage at 14 Oak Street');
rel('a count prior never gets a "spot in the paper" re-ask (it names the files instead)', T(countQ), 'point me to the spot in the paper', true);
rel('a total prior never gets a page re-ask (it names the files instead)', T('what is the total of all invoices'), 'which page is that on', true);
rel('a long story is not a source ask', T(paperQs[0]), 'long story short my partner thinks we did better than i do and the bank wants numbers: point me to the spot in the paper');
check('release: a source ask with no earlier question stays a fresh question', !resolve([], 'where did that come from').isFollowup);
rel('a page ask with a new customer named', T(paperQs[1]), 'point me to the spot in the paper for Dana Smith');
check('release: a spot ask that names a paper is not the noisy-core path', sourceCore('point me to the spot in the lease') === null);
check('sourceCore: plain wording passes', sourceCore('can you point me to the spot in the paper') === 'can you point me to the spot in the paper');
check('sourceCore: a digit is a new question', sourceCore('point me to the spot in the paper on page 3') === null);
check('sourceCore: an unknown word is a new question', sourceCore('point me to the spot in the paper for Dana') === null);

// ---------------------------------------------------------------- B: real handler (golden export)
let pg = true; try { await import('@electric-sql/pglite'); } catch { pg = false; }
if (!pg) console.log('\nSKIP  Part B: @electric-sql/pglite not installed. Run npm ci.');
else {
  console.log('\n-- Part B: multi-turn through the REAL /api/ask handler (golden export, PGlite) --');
  process.env.NEON_CONNECTION_STRING ||= 'postgres://harness:harness@localhost:5432/harness';
  process.env.CLAUDE_API_KEY ||= 'sk-ant-r22-disabled';
  const { installPgHarness, installModelBlock, createPGlite, setActiveDatabase, loadExportIntoNewTenant } = await import(path.join(ROOT, 'scripts/offline-exam.mjs'));
  const { SCORECARD_CALL } = await import(path.join(ROOT, 'api/_lib/scorecard/hook.js'));
  const { default: askHandler } = await import(path.join(ROOT, 'api/ask.js'));
  await installPgHarness();
  const counter = await installModelBlock();
  const lite = await createPGlite(); await setActiveDatabase(lite);
  const exportData = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/golden/golden-export.json'), 'utf8'));
  const { ctx } = await loadExportIntoNewTenant(lite, exportData, { tenantKey: 'verify-followup-prov-r22', tenantName: 'Verify Provenance R22' });
  const auth = { tenantId: ctx.tenantKey, orgId: ctx.tenantName ?? ctx.tenantKey, userId: null };
  const files = new Set(exportData.documents.map((d) => d.original_filename));
  const makeRes = () => { const r = { statusCode: 200, headers: {}, headersSent: false, body: undefined }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; }; r.getHeader = (k) => r.headers[k.toLowerCase()]; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; r.headersSent = true; return r; }; r.end = () => r; return r; };
  async function ask(question, turns) {
    const req = { method: 'POST', headers: {}, query: {}, body: { question, today: '2026-09-26', ...(turns?.length ? { conversationContext: { turns } } : {}) }, [SCORECARD_CALL]: { auth, escalate: false } };
    const res = makeRes(); counter.n = 0;
    try { await askHandler(req, res); } catch { /* released */ }
    return { data: res.body?.success ? res.body.data ?? null : null, model: counter.n > 0 };
  }
  const turn = (q, d) => ({ question: q, askedAt: new Date().toISOString(), ...(d?.records?.some((r) => r.type === 'customer') ? { resolvedEntities: d.records.filter((r) => r.type === 'customer').slice(0, 5).map((r) => ({ type: 'customer', id: r.id, label: r.label })) } : {}) });
  const named = (text) => [...String(text ?? '').matchAll(/[\w.-]+\.pdf/g)].map((m) => m[0]);

  for (const [kind, q1] of [['invoices', 'how many invoices do we have'], ['quotes', 'how many quotes do we have'], ['permits', 'how many permits do we have']]) {
    const d1 = await ask(q1);
    for (const a of ["where did that come from", "what's your source", "show me the page", "which document says that", "where'd you get that number"]) {
      const d2 = await ask(a, [turn(q1, d1.data)]);
      const f = named(d2.data?.text);
      if (d1.data?.kind !== 'answer' || !(Number((d1.data.text.match(/\d+/) ?? [])[0]) > 0)) { check(`e2e ${kind}/"${a}": earlier answer is a count (skipped otherwise)`, true); continue; }
      check(`e2e ${kind}/"${a}": answers without a model and names real papers`, !d2.model && d2.data?.kind === 'answer' && f.length > 0 && f.every((x) => files.has(x)), JSON.stringify(d2.data?.text));
      check(`e2e ${kind}/"${a}": the count in the answer is the earlier count`, (d2.data?.text ?? '').includes(d1.data.text.match(/\d[\d,]*/)[0]), `${d1.data.text} || ${d2.data?.text}`);
    }
  }
  // a question the engine cannot answer has no sources to name: released, not invented
  { const q1 = 'why is the sky blue'; const d1 = await ask(q1); const d2 = await ask('where did that come from', [turn(q1, d1.data)]); check('e2e: an answer with no recorded source never names a paper', named(d2.data?.text).length === 0, d2.data?.text); }
  { const d2 = await ask('where did that come from'); check('e2e: a source ask with no earlier answer names no paper', named(d2.data?.text).length === 0, d2.data?.text); }
  // reader chain: a paper question, then the page ask (with chatter)
  { const q1 = 'what is the payment terms on invoice INV-20000'; const d1 = await ask(q1); const d2 = await ask('my bookkeeper is asking: can you point me to the spot in the paper', [turn(q1, d1.data)]);
    check('e2e reader: the page ask is not answered with a count or a list', !/\bdocuments? — showing\b/.test(d2.data?.text ?? '') && !/^\d+ /.test(d2.data?.text ?? ''), d2.data?.text);
    if (d1.data?.kind === 'answer' && d2.data?.kind === 'answer') check('e2e reader: same file in both answers', named(d1.data.text).length === 0 || named(d2.data.text).some((x) => named(d1.data.text).includes(x)), `${d1.data.text} || ${d2.data.text}`); }
  console.log('\nPart B complete.');
}
const top = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => fs.statSync(path.join(ROOT, 'api', f)).isFile());
check('api/ keeps 12 top-level files', top.length === 12, String(top.length));
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
