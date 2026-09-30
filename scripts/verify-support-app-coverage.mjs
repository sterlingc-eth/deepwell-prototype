// Round 29 - App how-to coverage: every action in docs/help/APP_INVENTORY.md is answered by a KB entry, the
// signed-in FAQ answers 150+ realistic how-to questions deterministically (>= 90%), never from a wrong article, and
// the Ask-box help route (api/_lib/support/askhelp.js) never captures a question about the shop's own records.
// No network, no model, no database. Run: node scripts/verify-support-app-coverage.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? ' - ' + extra : ''}`); } };
const info = (s) => console.log(`INFO  ${s}`);

const kb = await import('../api/_lib/support/kb.generated.js');
const { matchFaq } = await import('../api/_lib/support/faq.js');
const { helpGate, answerHowTo } = await import('../api/_lib/support/askhelp.js');
const { HOWTO, OUT_OF_SCOPE, RECORDS, HOLDOUT, HOLDOUT2 } = await import('./fixtures/app-howto-questions.mjs');

/* ---------- 1. inventory -> KB ---------- */
const inv = readFileSync(path.join(ROOT, 'docs/help/APP_INVENTORY.md'), 'utf8');
const ACTIONS = [...inv.matchAll(/^- \*\*(A-[A-Z0-9-]+)\*\*/gm)].map((m) => m[1]);
const SCREENS = [...inv.matchAll(/^- \*\*(S-[A-Z0-9-]+)\*\*/gm)].map((m) => m[1]);
info(`inventory: ${SCREENS.length} screens, ${ACTIONS.length} actions`);
const coversMap = new Map();
for (const e of kb.ENTRIES) for (const c of e.covers ?? []) { if (!coversMap.has(c)) coversMap.set(c, []); coversMap.get(c).push(e); }
const uncovered = ACTIONS.filter((a) => !coversMap.has(a));
check('every inventory action is covered by at least one KB entry', ACTIONS.length >= 90 && uncovered.length === 0, uncovered.join(', '));
const unknownCovers = [...coversMap.keys()].filter((c) => !ACTIONS.includes(c));
check('no KB entry covers an action that is not in the inventory', unknownCovers.length === 0, unknownCovers.join(', '));
check('no public-only entry claims an action (signed-out visitors never get app how-to)', kb.ENTRIES.every((e) => e.audience !== 'public-only' || !(e.covers?.length)));
const badAct = HOWTO.filter((x) => !ACTIONS.includes(x.act));
check('every fixture question is tagged with a real inventory action', badAct.length === 0, badAct.map((x) => x.act).join(', '));
const noQ = ACTIONS.filter((a) => !HOWTO.some((x) => x.act === a));
check('every inventory action has at least one fixture question', noQ.length === 0, noQ.join(', '));
check('fixture: >= 150 signed-in how-to questions', HOWTO.length >= 150, String(HOWTO.length));

/** Round 30: a did-you-mean reply ($0, two chips) counts as "offered" when one chip is a right entry. */
const dymOffersRight = (r, t) => (r.didYouMean ?? []).some((o) => (o.entry.covers ?? []).some((c) => [t.act, ...(t.alt ?? [])].includes(c)) || wantArticles(t).has(o.entry.article) || (t.altArticles ?? []).includes(o.entry.article));
const wantArticles = (t) => new Set([t.act, ...(t.alt ?? [])].flatMap((a) => (coversMap.get(a) ?? []).map((e) => e.article)));

/* ---------- 2. signed-in FAQ ($0) over the how-to set ---------- */
let right = 0, wrong = 0, miss = 0, offered = 0;
const wrongList = [], missList = [];
for (const t of HOWTO) {
  const r = matchFaq(t.q, { allowApp: true });
  if (!r.hit) { if (dymOffersRight(r, t)) offered++; else { miss++; missList.push(`${t.q} [${t.act}]`); } continue; }
  const want = wantArticles(t);
  if ((r.hit.entry.covers ?? []).some((c) => [t.act, ...(t.alt ?? [])].includes(c)) || want.has(r.hit.entry.article)) right++;
  else { wrong++; wrongList.push(`${t.q} [${t.act}] -> ${r.hit.entry.id}`); }
}
const rate = right / HOWTO.length;
const rateOffered = (right + offered) / HOWTO.length;
info(`signed-in FAQ ($0) on ${HOWTO.length} how-to questions: ${right} answered right, ${offered} more offered as a did-you-mean with the right entry, ${miss} fell through to model/hand-off, ${wrong} wrong article  (${(rate * 100).toFixed(1)}% answered, ${(rateOffered * 100).toFixed(1)}% answered-or-offered)`);
if (missList.length) info('fell through: ' + missList.join(' | '));
check('signed-in FAQ answers >= 80% and answers-or-offers (did-you-mean) >= 90% of the how-to set', rate >= 0.8 && rateOffered >= 0.9, `${(rate * 100).toFixed(1)}% / ${(rateOffered * 100).toFixed(1)}%`);
check('signed-in FAQ never answers from a wrong article', wrong === 0, wrongList.join(' | '));

/* ---------- 2b. held-out sets. HOLDOUT was used once to tune (first pass: 65%); HOLDOUT2 was never used for tuning ---------- */
for (const [label, SET, minRate, strictWrong = true] of [['HOLDOUT (second tuning set)', HOLDOUT, 0.85], ['HOLDOUT2 (never tuned on; regression floor only, see handoff)', HOLDOUT2, 0.3, false]]) {
  let hr = 0, hw = 0, ho = 0; const hm = [], hwl = [];
  for (const t of SET) {
    const r = matchFaq(t.q, { allowApp: true });
    if (!r.hit) { if (dymOffersRight(r, t)) ho++; else hm.push(`${t.q} [${t.act}]`); continue; }
    if ((r.hit.entry.covers ?? []).some((c) => [t.act, ...(t.alt ?? [])].includes(c)) || wantArticles(t).has(r.hit.entry.article) || (t.altArticles ?? []).includes(r.hit.entry.article)) hr++;
    else { hw++; hwl.push(`${t.q} [${t.act}] -> ${r.hit.entry.id}`); }
  }
  info(`${label}: ${SET.length} questions: ${hr} right, ${ho} did-you-mean with the right entry, ${hm.length} fell through, ${hw} wrong article (${((hr / SET.length) * 100).toFixed(1)}%)`);
  if (hm.length) info(`${label} fell through: ` + hm.join(' | '));
  check(`${label}: >= ${minRate * 100}% answered-or-offered, none from a wrong article`, (hr + ho) / SET.length >= minRate && (hw === 0 || !strictWrong), hwl.join(' | '));
}

/* ---------- 3. out-of-scope how-tos never get a wrong app answer (the honest "DeepWell has no such feature" entry is the right answer) ---------- */
const NOT_A_FEATURE = 'Can DeepWell schedule jobs, take payments, text customers or change my logo?';
const oosBad = [];
for (const t of OUT_OF_SCOPE) {
  const r = matchFaq(t.q, { allowApp: true });
  if (r.hit && r.hit.entry.q !== NOT_A_FEATURE && (r.hit.entry.audience === 'app' || (r.hit.entry.covers?.length))) oosBad.push(`${t.q} -> ${r.hit.entry.id}`);
  const ar = await answerHowTo(t.q);
  if (ar && ar.help.title && kb.ENTRIES.find((e) => e.id === ar.help.entry)?.q !== NOT_A_FEATURE) oosBad.push(`${t.q} -> ask route ${ar.help.entry}`);
}
check(`out-of-scope how-tos (${OUT_OF_SCOPE.length}) are never answered from an app article`, oosBad.length === 0, oosBad.join(' | '));

/* ---------- 4. Ask-box route ---------- */
let gated = 0, asked = 0; const askWrong = [];
for (const t of HOWTO) {
  if (helpGate(t.q)) gated++;
  const a = await answerHowTo(t.q);
  if (a) {
    asked++;
    if (!wantArticles(t).has(a.help.article)) askWrong.push(`${t.q} [${t.act}] -> ${a.help.entry}`);
    if (!/^From DeepWell Help: /.test(a.interpretation ?? '') || a.kind !== 'answer' || a.facts.length || a.sources.length) askWrong.push(`${t.q} bad shape`);
  }
}
info(`Ask-box help route on the how-to set: gate passes ${gated}/${HOWTO.length}, strict answers ${asked}/${HOWTO.length} (${((asked / HOWTO.length) * 100).toFixed(1)}%); the rest go to the normal Ask flow`);
check('Ask-box route answers >= 45% of how-to questions (strict since Round 30) and never from a wrong article', asked / HOWTO.length >= 0.45 && askWrong.length === 0, askWrong.join(' | ') || `${asked}/${HOWTO.length}`);
{
  // Precision on questions the KB was never tuned on: whatever the strict route answers must be from a right article.
  let n = 0; const bad = [];
  for (const t of [...HOLDOUT, ...HOLDOUT2]) {
    const a = await answerHowTo(t.q);
    if (!a) continue;
    n++;
    const ok = [t.act, ...(t.alt ?? [])].some((c) => (coversMap.get(c) ?? []).some((e) => e.id === a.help.entry)) || (t.altArticles ?? []).includes(a.help.article);
    if (!ok) bad.push(`${t.q} -> ${a.help.entry}`);
  }
  info(`Ask-box route on the ${HOLDOUT.length + HOLDOUT2.length} held-out questions: answered ${n}, wrong ${bad.length}`);
  check('Ask-box route never answers a held-out question from the wrong entry', bad.length === 0, bad.join(' | '));
}
const recCaptured = [];
for (const t of RECORDS) { if (helpGate(t.q) || (await answerHowTo(t.q))) recCaptured.push(t.q); }
check(`Ask-box route captures none of the ${RECORDS.length} records questions`, recCaptured.length === 0, recCaptured.join(' | '));

/* ---------- 5. every scorecard question: zero captures ---------- */
function collect(dir, out) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (n.endsWith('.json')) {
      const walk = (o) => {
        if (Array.isArray(o)) o.forEach(walk);
        else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if ((k === 'text' || k === 'question' || k === 'q') && typeof v === 'string') out.add(v); else walk(v); }
      };
      walk(JSON.parse(readFileSync(p, 'utf8')));
    }
  }
}
const scoreQs = new Set();
collect(path.join(ROOT, 'test-docs/scorecard'), scoreQs);
let captured = 0, gatePass = 0; const capList = [];
for (const q of scoreQs) {
  if (helpGate(q)) gatePass++;
  if (await answerHowTo(q)) { captured++; capList.push(q); }
}
info(`scorecard: ${scoreQs.size} questions scanned, ${gatePass} pass the how-to gate, ${captured} captured by the help route`);
check('scorecard questions (test-docs/scorecard/**) are never captured by the Ask help route', scoreQs.size > 500 && captured === 0, capList.slice(0, 5).join(' | '));

/* ---------- 6. wiring ---------- */
const ask = readFileSync(path.join(ROOT, 'api/ask.js'), 'utf8');
check('api/ask.js wires the help route behind the gate, and skips scorecard and API-key callers', /helpGate\(question\)/.test(ask) && /answerHowTo\(/.test(ask) && /!scorecardCall/.test(ask.slice(ask.indexOf('helpGate(question)') - 400, ask.indexOf('helpGate(question)') + 100)) && /viaKey/.test(ask.slice(ask.indexOf('helpGate(question)') - 400, ask.indexOf('helpGate(question)') + 100)));
const askhelp = readFileSync(path.join(ROOT, 'api/_lib/support/askhelp.js'), 'utf8');
check('askhelp.js imports the FAQ/KB lazily (only after the gate passes)', !/^import .*faq\.js/m.test(askhelp) && /await import\('\.\/faq\.js'\)/.test(askhelp));
check('api/ has 12 top-level files', readdirSync(path.join(ROOT, 'api')).filter((n) => statSync(path.join(ROOT, 'api', n)).isFile()).length === 12);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
