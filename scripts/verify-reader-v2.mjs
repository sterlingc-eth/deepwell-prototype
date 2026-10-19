/**
 * verify:reader-v2 - Donovan Reader V2 (api/_lib/dql/reader-v2/).
 *   1. bundle integrity: every data file matches the sha256 recorded in data/bundle.json
 *   2. PARITY: the JS port against the Python pipeline of the training loop (the loop's own code and the v002 recipe), over fresh synthetic
 *      companies (scripts/fixtures/reader-v2/): same answer, same documents, same release, question for question. Expected = 0 mismatches.
 *   3. switches: with both switches unset nothing changes; the hook never replaces an answer and answers only a released question
 *   4. (PGlite, when installed) the tenant-scoped reads: only the asking organization's documents are used, private papers are left out
 * node scripts/verify-reader-v2.mjs            companies of the first set (2,847 questions) + the switch/database checks
 * node scripts/verify-reader-v2.mjs --full     every company (6,202 questions)
 * node scripts/verify-reader-v2.mjs --stamp    with --full: when 0 mismatches, write the parity stamp into data/bundle.json
 * Needs no network, no key, no model call. Synthetic documents only.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'scripts', 'fixtures', 'reader-v2');
const DATA = path.join(ROOT, 'api', '_lib', 'dql', 'reader-v2', 'data');
const FULL = process.argv.includes('--full') || process.argv.includes('--stamp');
const STAMP = process.argv.includes('--stamp');
const SKIP_PARITY = process.argv.includes('--skip-parity') && !STAMP;    // developer shortcut: only the switch and database checks
let failures = 0, passes = 0;
const check = (name, ok, detail = '') => { if (ok) passes++; else failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };
const realLog = console.log;
const quiet = async (fn) => { const l = console.log; console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"route"')) return; l(...a); }; try { return await fn(); } finally { console.log = l; } };

/* ---------------------------------------------------------------- 1. bundle integrity */
const B = JSON.parse(fs.readFileSync(path.join(DATA, 'bundle.json'), 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA, f))).digest('hex');
for (const [k, m] of Object.entries(B.models)) check(`bundle file ${m.file} matches its recorded sha256`, sha(m.file) === m.sha256, k);
check('bundle names the code and recipe it was exported from', Boolean(B.loop_code_hash_at_promotion && B.recipe_hash && B.recipe_json_sha256));
check('bundle carries the measured scores of this exact version (main / wild / realty / hard / fresh)', ['main', 'wild', 'realty', 'hard', 'fresh'].every((k) => B.measured?.metrics?.[k]?.overall?.cov != null));

/* ---------------------------------------------------------------- 2. parity */
const { loadReaderV2, buildIndex } = await import('../api/_lib/dql/reader-v2/index.js');
const { decide } = await import('../api/_lib/dql/reader-v2/pipeline.js');
const R = await loadReaderV2();
const expected = zlib.gunzipSync(fs.readFileSync(path.join(FX, 'expected.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const keys = [...new Set(expected.map((e) => e.key))];
const firstSet = keys.filter((k) => k.startsWith('pf_'));
const useKeys = SKIP_PARITY ? [] : FULL ? keys : firstSet;
let n = 0, mism = 0, answeredBoth = 0; const bad = []; const t0 = Date.now();
for (const key of useKeys) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, 'companies', `${key}.json.gz`))).toString('utf8'));
  const ix = buildIndex(d, key);
  for (const e of expected.filter((x) => x.key === key)) {
    n++;
    let got;
    try { got = await quiet(() => decide(ix, e.q, R.M)); } catch (err) { got = { answered: false, text: '', docs: [], reason: 'error:' + String(err.message).slice(0, 60), cands: 0 }; }
    const ans = got.answered ? 1 : 0;
    let same = ans === e.a;
    if (same && ans) { same = got.text === e.t && JSON.stringify(got.docs) === JSON.stringify(e.d); answeredBoth++; }
    if (same && !ans) { const reason = got.cands === 0 ? 'base' : got.reason; same = reason === e.r; }
    if (!same) { mism++; if (bad.length < 8) bad.push({ id: e.id, expected: e.a ? e.t.slice(0, 70) : `release:${e.r}`, got: got.answered ? got.text.slice(0, 70) : `release:${got.reason}` }); }
  }
}
realLog(`      ${n} questions over ${useKeys.length} fresh synthetic companies in ${Math.round((Date.now() - t0) / 1000)}s: ${answeredBoth} answered identically, ${mism} mismatches`);
for (const b of bad) realLog('      ' + JSON.stringify(b));
if (!SKIP_PARITY) check(`parity: at least 2,000 fresh questions compared`, n >= 2000, `n=${n}`);
if (!SKIP_PARITY) check(`parity: the JS port and the Python pipeline give identical answers and releases (mismatches = ${mism})`, mism === 0);
if (STAMP) {
  if (mism === 0 && n >= 6000) {
    B.parity = { questions: n, companies: useKeys.length, mismatches: 0, answeredIdentically: answeredBoth, against: 'training-loop Python pipeline (lib code + v002 recipe, determinism patches disclosed in the report)', stampedAt: new Date().toISOString().slice(0, 10) };
    fs.writeFileSync(path.join(DATA, 'bundle.json'), JSON.stringify(B, null, 1) + '\n');
    realLog('      parity stamp written to data/bundle.json');
  } else realLog('      parity stamp NOT written (needs a clean --full run)');
}
check('bundle parity stamp is present and says 0 mismatches over at least 2,000 questions', B.parity?.mismatches === 0 && B.parity?.questions >= 2000, JSON.stringify(B.parity ?? null));

/* ---------------------------------------------------------------- 3. switches */
const G = await import('../api/_lib/dql/reader-v2/gate.js');
const A = await import('../api/_lib/dql/reader-v2/app.js');
const saved = { v2: process.env.DONOVAN_READER_V2, sh: process.env.DONOVAN_READER_V2_SHADOW };
delete process.env.DONOVAN_READER_V2; delete process.env.DONOVAN_READER_V2_SHADOW;
check('both switches unset: the reader is not wanted', G.readerV2Wanted() === false && A.readerV2Wanted() === false);
{
  const body = { success: true, data: { kind: 'no-answer', text: 'x', sources: [] } };
  check('both switches unset: the hook sends the very same body', (await A.readerV2Hook({ withTenant: () => { throw new Error('must not be called'); }, ctxArg: {}, question: 'q', today: '2026-10-19' }, body)) === body);
}
process.env.DONOVAN_READER_V2 = '1';
{
  const ans = { success: true, data: { kind: 'answer', text: 'An existing answer', sources: [] } };
  let called = 0;
  const out = await A.readerV2Hook({ withTenant: () => { called++; throw new Error('must not be called'); }, ctxArg: {}, question: 'q', today: '2026-10-19' }, ans);
  check('switch on: an existing answer is never replaced and the reader is not even asked', out === ans && called === 0);
}
for (const k of ['DONOVAN_READER_V2', 'DONOVAN_READER_V2_SHADOW']) { if (saved[k === 'DONOVAN_READER_V2' ? 'v2' : 'sh'] === undefined) delete process.env[k]; else process.env[k] = saved[k === 'DONOVAN_READER_V2' ? 'v2' : 'sh']; }
{
  const asked = fs.readFileSync(path.join(ROOT, 'api', 'ask.js'), 'utf8');
  check('api/ask.js: the hook is wired through send() behind readerV2Wanted()', /readerV2Ctx && status === 200 && readerV2Wanted\(\)/.test(asked));
  const top = fs.readdirSync(path.join(ROOT, 'api'), { withFileTypes: true }).filter((d) => d.isFile()).length;
  check('api/ keeps exactly 12 top-level files', top === 12, `found ${top}`);
}

/* ---------------------------------------------------------------- 4. database-backed (PGlite) */
let PGlite; const contrib = {};
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  for (const key of ['uuid_ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']) contrib[key] = (await import(`@electric-sql/pglite/contrib/${key}`))[key];
} catch (err) { realLog(`SKIP  database-backed checks: PGlite is not installed (${err?.message})`); PGlite = null; }
if (PGlite) await (await import('./lib/reader-v2-db-checks.mjs')).run({ ROOT, FX, PGlite, contrib, check, eq: (n, g, w) => check(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`), R, expected, keys });

realLog(failures ? `${failures} check(s) FAILED, ${passes} passed.` : `${passes} checks passed.`);
process.exit(failures ? 1 : 0);
