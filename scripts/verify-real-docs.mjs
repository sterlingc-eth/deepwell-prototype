// npm run verify:real-docs - THE STANDING GATE for document reading (docs/QUALITY_GATE.md).
//
// Runs the real reading pipeline (scripts/real-docs/pipeline.mjs: the functions upload and Re-check call) over the ORIGINAL
// Sonoran shared-drive test documents (synthetic test data; page text in test-docs/real-docs/pages.json, built from the
// originals by scripts/real-docs/build-page-cache.mjs with the app's own readers) and compares the result with the committed
// gold file test-docs/real-docs/GOLD.json (hand-checked facts, known-wrong values, and the documents that may still need a
// person, each with its reason).
//
// FAILS on: any wrong fact (value or page differs from gold), any forbidden value coming back, any gold fact no longer
// captured, any document needing a person that gold does not list, any captured fact whose quote is not on its page (or whose
// value does not come from its quote), a broken screenshot regression, a broken grounding / cross-check spec case - and,
// FIRST, if the oracle itself does not reject three planted failures (a date shifted a day, a party swapped for the
// neighbouring line, a fact moved to the wrong page). Usage:
//   node scripts/verify-real-docs.mjs [--tree <repo root>] [--json <out.json>] [--update-needs]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPipeline, runDoc, recheckDoc, judgeDoc } from './real-docs/pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const TREE = path.resolve(arg('--tree') ?? ROOT);
const PAGES = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-docs/real-docs/pages.json'), 'utf8'));
const GOLD_PATH = path.join(ROOT, 'test-docs/real-docs/GOLD.json');
const GOLD = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8'));

const P = await loadPipeline(TREE);
let ground = null;
try { ground = await import(pathToFileURL(path.join(TREE, 'api/_lib/modelAvoidance/groundedFacts.js')).href); } catch { ground = null; }
let prose = null;
try { prose = await import(pathToFileURL(path.join(TREE, 'api/_lib/modelAvoidance/proseFacts.js')).href); } catch { prose = null; }
const normDate = (v) => P.ef.normalizeDate(String(v ?? ''), { order: 'mdy' }) ?? String(v ?? '');

const failures = [];
const fail = (kind, msg) => failures.push(`${kind}: ${msg}`);

/** Normalised comparison value for a gold key. */
function canon(key, v) {
  const s = String(v ?? '').trim();
  if (/(_date|_expires)$/.test(key)) return normDate(s);
  if (key === 'cost') { const n = P.ef.normalizeNumber(s, { money: true }); return n == null ? s : String(Math.round(Number(n) * 100)); }
  return s.replace(/\s+/g, ' ').replace(/[.,]+$/, '').toLowerCase();
}

/** The oracle: compare one document's facts with the gold facts for it. Returns {wrong, missed, forbidden} lists. */
export function compareDoc(gold, forbidden, facts) {
  const wrong = [], missed = [], bad = [];
  for (const g of gold) {
    const hits = facts.filter((f) => f.k === g.key);
    if (!hits.length) { if (g.captured !== false) missed.push(g); continue; }
    const ok = hits.some((f) => canon(g.key, f.v) === canon(g.key, g.value) && (g.page == null || f.p == null || Number(f.p) === Number(g.page)));
    if (!ok) wrong.push({ ...g, got: hits.map((f) => `${f.v} (p${f.p})`).join(' | ') });
  }
  for (const x of forbidden) if (facts.some((f) => f.k === x.key && canon(x.key, f.v) === canon(x.key, x.value))) bad.push(x);
  return { wrong, missed, forbidden: bad };
}

// ---------------------------------------------------------------- 0. oracle self-test (planted failures must be rejected)
{
  const byDoc = new Map();
  for (const g of GOLD.facts) { if (!byDoc.has(g.filename)) byDoc.set(g.filename, []); byDoc.get(g.filename).push(g); }
  const asFacts = (list) => list.map((g) => ({ k: g.key, v: g.value, p: g.page }));
  const dated = GOLD.facts.find((g) => /_date$/.test(g.key) && /^\d{4}-\d{2}-\d{2}$/.test(normDate(g.value)));
  const party = GOLD.facts.find((g) => g.key === 'customer_name' && g.neighbour);
  const paged = GOLD.facts.find((g) => g.page != null);
  const plants = [];
  if (dated) { const d = new Date(`${normDate(dated.value)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); plants.push(['date shifted by one day', dated, { ...dated, value: d.toISOString().slice(0, 10) }]); }
  if (party) plants.push(['party swapped for the neighbouring line', party, { ...party, value: party.neighbour }]);
  if (paged) plants.push(['fact taken from the wrong page', paged, { ...paged, page: Number(paged.page) + 1 }]);
  if (plants.length < 3) fail('oracle', 'gold file lacks a date, a party with a neighbour line, or a paged fact: cannot run the planted-failure self-test');
  for (const [label, orig, mutated] of plants) {
    const docGold = byDoc.get(orig.filename);
    const facts = asFacts(docGold.map((g) => (g === orig ? mutated : g)));
    const r = compareDoc(docGold, [], facts);
    const caught = r.wrong.some((w) => w.key === orig.key);
    console.log(`  oracle self-test: ${label} (${orig.filename} ${orig.key}) -> ${caught ? 'REJECTED (good)' : 'NOT CAUGHT'}`);
    if (!caught) fail('oracle', `planted failure not rejected: ${label}`);
  }
  // and the unmutated gold passes its own comparison
  for (const [fn, list] of byDoc) { const r = compareDoc(list, [], asFacts(list)); if (r.wrong.length || r.missed.length) fail('oracle', `gold does not match itself for ${fn}`); }
}

// ---------------------------------------------------------------- 1. spec cases (grounding + cross-field checks)
if (ground && prose) {
  const pages = [{ page_no: 1, text: 'The Premises are leased for a term of 60 months beginning 02/10/2023 and ending 02/09/2028.\nTotal $1,284.50' }, { page_no: 2, text: 'Total $1,248.50' }];
  const r = prose.scanProseFacts(pages, { keys: ['agreement_term', 'start_date', 'end_date'] });
  const ok = r.candidates.agreement_term?.[0]?.checks?.includes('start+term=end') && normDate(r.candidates.end_date?.[0]?.value) === '2028-02-09';
  if (!ok) fail('spec', 'T2: "term of 60 months beginning 02/10/2023 and ending 02/09/2028" must give term, start, end with the arithmetic check passed');
  const p3 = prose.scanProseFacts([{ page_no: 1, text: 'for a term of 60 months beginning 02/10/2023 and ending 02/09/2027.' }], { keys: ['agreement_term', 'end_date'] });
  if (p3.candidates.end_date || p3.candidates.agreement_term) fail('spec', 'P3: start + 60 months does not land on 02/09/2027 - must be refused');
  const p1 = ground.verifyGrounded({ field_key: 'cost', value: '1284.50', verbatim: 'Total $1,248.50', page_no: 1 }, pages);
  if (p1.ok) fail('spec', 'P1: a quote that exists only on another page must be refused');
  const p2 = ground.verifyGrounded({ field_key: 'cost', value: '1248.50', verbatim: 'Total $1,284.50', page_no: 1 }, pages);
  if (p2.ok) fail('spec', 'P2: a digit flip (quote $1,284.50, value 1,248.50) must be refused');
  // Verifier round (2026-10-22): adversarial pages through the WHOLE pipeline (every reader, not just the sentence reader).
  const run1 = (text, filename = 'Adversarial.pdf') => runDoc(P, { filename, pages: [{ page_no: 1, text }] }).fields;
  const val = (fs, k) => fs.filter((f) => f.field_key === k).map((f) => String(f.value));
  const coi = run1('CERTIFICATE OF LIABILITY INSURANCE\nCertificate Date: 2026-01-25   Insurer:   Ironwood Casualty Mutual\nGeneral Liability GL-1   Policy Effective: 2025-12-03\nPolicy Expires:   2026-12-03\nINSURED   CERTIFICATE HOLDER\nAcme Plumbing LLC   Desert Car Wash Co', 'COI - Acme 2026.pdf');
  const p4 = !val(coi, 'agreement_term').some((v) => /2026-01-25/.test(v)) && val(coi, 'start_date').includes('2025-12-03');
  if (!p4) fail('spec', `P4: a COI term must start at the policy effective date, never the Certificate Date (got term ${val(coi, 'agreement_term')}, start ${val(coi, 'start_date')})`);
  const inv = run1('INVOICE\nInvoice #: 4411   Date: 03/02/2026\nBill To: Desert Car Wash Co\nService call   1   $100.00\nSubtotal $100.00\nTax $8.00\nTotal $180.00', 'Invoice 4411.pdf');
  const p5 = !val(inv, 'cost').length;
  if (!p5) fail('spec', `P5: subtotal + tax != total must leave the amount for a person (got cost ${val(inv, 'cost')})`);
  const two = run1('LEASE AGREEMENT\nThis Lease is entered into on January 5, 2024 between Mesa Holdings LLC (Landlord) and Desert Car Wash Co (Tenant). The term begins March 1, 2024 and ends February 28, 2025.', 'Lease - Unit 9.pdf');
  const p6 = !val(two, 'start_date').includes('2024-01-05');
  if (!p6) fail('spec', `P6: a signing date in the same sentence is not the start (got start ${val(two, 'start_date')})`);
  const amd = runDoc(P, { filename: 'Lease - Unit 9 amended.pdf', pages: [{ page_no: 1, text: 'LEASE AGREEMENT\nfor a term of 12 months beginning 01/01/2025 and ending 12/31/2025.' }, { page_no: 2, text: 'AMENDMENT NO. 1\nThe parties hereby amend the Lease: the term is extended to 24 months, ending 12/31/2026.' }] }).fields;
  const p7 = !val(amd, 'agreement_term').some((v) => /^12 months/.test(v));
  if (!p7) fail('spec', `P7: an amendment page means the original term is not the current one (got ${val(amd, 'agreement_term')})`);
  console.log(`  spec cases: T2 ${ok ? 'ok' : 'FAIL'}, P1 ${p1.ok ? 'FAIL' : 'refused'}, P2 ${p2.ok ? 'FAIL' : 'refused'}, P3 ${p3.candidates.end_date ? 'FAIL' : 'refused'}, P4 ${p4 ? 'refused' : 'FAIL'}, P5 ${p5 ? 'refused' : 'FAIL'}, P6 ${p6 ? 'ok' : 'FAIL'}, P7 ${p7 ? 'refused' : 'FAIL'}`);
} else fail('spec', 'groundedFacts.js / proseFacts.js missing in this tree (no grounding, no prose reader)');

// ---------------------------------------------------------------- 2. the pipeline over every document
const results = [];
for (const d of PAGES.docs) {
  const r = runDoc(P, d);
  results.push({ filename: d.filename, route: d.route, type: r.type, needsPerson: r.needsPerson, setAside: !!r.setAside, reason: r.verdict?.reason ?? null, detail: r.verdict?.detail ?? null,
    fields: r.fields.map((f) => ({ k: f.field_key, v: f.value, p: f.page_no, q: f.verbatim ?? null, m: f.method ?? null })) });
}
const byName = new Map(results.map((r) => [r.filename, r]));

// 2a. quote integrity over the whole corpus (every fact the readers wrote)
let checkedQuotes = 0, badQuotes = 0;
if (ground) {
  for (const r of results) {
    const doc = PAGES.docs.find((d) => d.filename === r.filename);
    for (const f of r.fields) {
      if (!['label-fill', 'recheck', 'text-reread', 'reread'].includes(f.m) || !f.q) continue;
      const fromFile = f.k === 'service_address' && !doc.pages.some((p) => String(p.text).includes(f.q));
      if (fromFile) continue; // the file-name address (checked against the page by house number + street instead)
      checkedQuotes++;
      const g = ground.verifyGrounded({ field_key: f.k, value: f.v, verbatim: f.q, page_no: f.p }, doc.pages);
      if (!g.ok) { badQuotes++; if (badQuotes <= 10) fail('grounding', `${r.filename} ${f.k}=${f.v}: ${g.reason}`); }
    }
  }
  if (badQuotes > 10) fail('grounding', `${badQuotes - 10} more facts whose quote is not on the page`);
}

// 2b. gold facts and forbidden values
let wrongN = 0, missedN = 0, forbiddenN = 0, goldOk = 0;
const goldByDoc = new Map();
for (const g of GOLD.facts) { if (!goldByDoc.has(g.filename)) goldByDoc.set(g.filename, []); goldByDoc.get(g.filename).push(g); }
const forbByDoc = new Map();
for (const x of GOLD.forbidden ?? []) { if (!forbByDoc.has(x.filename)) forbByDoc.set(x.filename, []); forbByDoc.get(x.filename).push(x); }
for (const fn of new Set([...goldByDoc.keys(), ...forbByDoc.keys()])) {
  const r = byName.get(fn);
  if (!r) { fail('gold', `document not in the test set: ${fn}`); continue; }
  const c = compareDoc(goldByDoc.get(fn) ?? [], forbByDoc.get(fn) ?? [], r.fields);
  for (const w of c.wrong) { wrongN++; fail('WRONG FACT', `${fn} ${w.key}: gold "${w.value}" p${w.page ?? '?'}, got ${w.got}`); }
  for (const m of c.missed) { missedN++; fail('regression (fact no longer captured)', `${fn} ${m.key}="${m.value}"`); }
  for (const x of c.forbidden) { forbiddenN++; fail('FORBIDDEN VALUE back', `${fn} ${x.key}="${x.value}" (${x.why ?? 'known wrong'})`); }
  goldOk += (goldByDoc.get(fn) ?? []).length - c.wrong.length - c.missed.length;
}

// 2c. needs a person
const needs = results.filter((r) => r.needsPerson);
const allowed = GOLD.needs_person ?? {};
const unexpected = needs.filter((r) => !(r.filename in allowed));
const resolved = Object.keys(allowed).filter((fn) => byName.get(fn) && !byName.get(fn).needsPerson);
for (const r of unexpected.slice(0, 25)) fail('regression (now needs a person)', `${r.filename} [${r.type}] ${r.reason}${r.detail ? ': ' + r.detail : ''}`);
if (unexpected.length > 25) fail('regression (now needs a person)', `${unexpected.length - 25} more`);
const capturedTotal = results.reduce((n, r) => n + r.fields.length, 0);
if (GOLD.captured_facts_min && capturedTotal < GOLD.captured_facts_min) fail('regression (fewer facts captured)', `${capturedTotal} < ${GOLD.captured_facts_min}`);

// ---------------------------------------------------------------- 3. the live screenshots, as Re-check sees stored documents
for (const s of GOLD.recheck_cases ?? []) {
  const d = PAGES.docs.find((x) => x.filename === s.filename);
  if (!d) { fail('recheck', `missing ${s.filename}`); continue; }
  const r = recheckDoc(P, d, { storedType: s.storedType, stored: [] });
  const okType = !s.expectType || r.type === s.expectType;
  const okMissing = r.missing.length === 0;
  const okKeys = (s.expectKeys ?? []).every((k) => r.filled.some((f) => f.field_key === k));
  console.log(`  re-check (stored as ${s.storedType}): ${s.filename} -> ${r.type}${r.retyped ? ' (re-typed: ' + r.retyped.source + ')' : ''}; filled ${r.filled.map((f) => f.field_key).join(', ') || 'nothing'}; missing ${r.missing.join(', ') || 'none'}`);
  if (!okType || !okMissing || !okKeys) fail('recheck', `${s.filename}: type ${r.type}, missing [${r.missing}], filled [${r.filled.map((f) => f.field_key)}]`);
}

// ---------------------------------------------------------------- 4. degraded copies (photo, low-res scan, skew, handwriting)
let deg = null;
const DEG_PATH = path.join(ROOT, 'test-docs/real-docs/pages-degraded.json');
if (fs.existsSync(DEG_PATH) && GOLD.degraded) {
  const D = JSON.parse(fs.readFileSync(DEG_PATH, 'utf8')).docs;
  deg = { docs: D.length, correct: 0, wrong: [], missed: 0, byVariant: {} };
  for (const d of D) {
    const r = runDoc(P, d);
    const j = judgeDoc(P, r.fields, d.gold, d.partyAnyOf);
    const v = (deg.byVariant[d.variant] ??= { docs: 0, correct: 0, wrong: 0, missed: 0 });
    v.docs++; v.correct += j.correct; v.wrong += j.wrong.length; v.missed += j.missed.length;
    deg.correct += j.correct; deg.missed += j.missed.length;
    for (const w of j.wrong) deg.wrong.push(`${d.filename} ${w.key}: expected ${w.expected}, read ${w.read}`);
  }
  const known = new Set(GOLD.degraded.known_wrong ?? []);
  const fresh = deg.wrong.filter((w) => !known.has(w.split(':')[0]));
  if (fresh.length) fail('degraded', `new wrong facts on degraded copies: ${fresh.join('; ')}`);
  if (deg.wrong.length > GOLD.degraded.max_wrong) fail('degraded', `${deg.wrong.length} wrong facts on degraded copies (allowed ${GOLD.degraded.max_wrong}): ${deg.wrong.join('; ')}`);
  if (deg.correct < GOLD.degraded.min_correct) fail('degraded', `only ${deg.correct} facts correct on degraded copies (gold ${GOLD.degraded.min_correct})`);
}

// ---------------------------------------------------------------- report
const reasons = {};
for (const r of needs) { const k = `${r.reason}${r.detail ? ': ' + r.detail : ''}`; reasons[k] = (reasons[k] ?? 0) + 1; }
const byRoute = {};
for (const r of results) { const k = r.route === 'vision-standin' ? (/\.(jpe?g|png)$/i.test(r.filename) ? 'photo (tesseract stand-in)' : 'pdf (pdftotext stand-in)') : r.route; byRoute[k] ??= { docs: 0, needsPerson: 0 }; byRoute[k].docs++; if (r.needsPerson) byRoute[k].needsPerson++; }
console.log(`\nverify:real-docs  tree=${path.relative(process.cwd(), TREE) || '.'}`);
console.log(`  documents ${results.length}; need a person ${needs.length}; set aside (VOID / copies) ${results.filter((r) => r.setAside).length}; facts captured ${capturedTotal}`);
console.log(`  by reader: ${JSON.stringify(byRoute)}`);
console.log(`  gold facts ${GOLD.facts.length}: correct ${goldOk}, WRONG ${wrongN}, no longer captured ${missedN}; forbidden values back ${forbiddenN}`);
console.log(`  quotes checked on the page ${checkedQuotes}, not grounded ${badQuotes}`);
console.log(`  needs a person: ${needs.length} (gold allows ${Object.keys(allowed).length}); unexpected ${unexpected.length}; resolved since gold ${resolved.length}`);
if (deg) { console.log(`  degraded copies ${deg.docs}: facts correct ${deg.correct}, wrong ${deg.wrong.length}, not read ${deg.missed}; ${JSON.stringify(deg.byVariant)}`); for (const w of deg.wrong) console.log('    known OCR misread: ' + w); }
console.log('  by reason: ' + Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join('; '));
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ results, reasons, failures }, null, 1));
if (process.argv.includes('--update-needs') && failures.every((f) => f.startsWith('regression (now needs a person)') || f.startsWith('regression (fewer facts captured)'))) {
  GOLD.needs_person = Object.fromEntries(needs.map((r) => [r.filename, `${r.reason}${r.detail ? ': ' + r.detail : ''}`]));
  GOLD.captured_facts_min = capturedTotal;
  fs.writeFileSync(GOLD_PATH, JSON.stringify(GOLD, null, 1));
  console.log('  GOLD.json needs_person / captured_facts_min updated (review the diff before committing).');
}
if (resolved.length) console.log(`  note: ${resolved.length} gold "needs a person" documents are now complete - re-run with --update-needs after checking them.`);
if (failures.length) { console.log(`\nFAIL (${failures.length})`); for (const f of failures.slice(0, 60)) console.log('  - ' + f); process.exit(1); }
console.log('\nPASS');
