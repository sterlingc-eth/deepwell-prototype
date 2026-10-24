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
  // Docread2 round (2026-10-23): a name in a signature block is a signer, not a party - unless the party clause names that person.
  const evt = run1('EVENT AGREEMENT\nCommunity Fun Run\n\nVENUE / CATERER   CLIENT\nRedwood Event Hall LLC   Harborlight Neighbors Alliance\nAttn: Cecilia Reeves   Attn: Gordon Patel\n\nThis Agreement is made 03/13/2026 between the Venue and Harborlight Neighbors Alliance (the Client) for the event described above.\n\n__________________________________   __________________________________\nVenue: Cecilia Reeves Date: ________   Client: Colin Dunn Date: ________', 'Event Contract - Fun Run (Redwood).pdf');
  const p8 = !val(evt, 'customer_name').some((v) => /colin dunn/i.test(v)) && val(evt, 'customer_name').includes('Harborlight Neighbors Alliance');
  if (!p8) fail('spec', `P8: a signer ("Client: Colin Dunn Date: ____" under a signature rule) must not be the customer; the party clause names Harborlight (got ${val(evt, 'customer_name')})`);
  const own = run1('SERVICE AGREEMENT\nThis Agreement is made 01/05/2026 between Mesa Holdings LLC (Landlord) and Colin Dunn (Tenant). The term begins 03/01/2026 and ends 02/28/2027.\n\n__________________________________   __________________________________\nLandlord: Ana Ruiz Date: ________   Tenant: Colin Dunn Date: ________', 'Lease - Dunn.pdf');
  const p9 = val(own, 'customer_name').includes('Colin Dunn');
  if (!p9) fail('spec', `P9: when the party clause names the signer as the party ("... and Colin Dunn (Tenant)"), the signer IS the customer (got ${val(own, 'customer_name')})`);
  const sigOnly = run1('ENGAGEMENT LETTER\nPlease sign below and return one copy.\n\n__________________________________   __________________________________\nBy: Priya Anand   Authorized Representative   Name/Title: Priya Anand, Partner', 'Letter - Anand.pdf');
  const p10 = !val(sigOnly, 'vendor').some((v) => /priya anand/i.test(v)) && !val(sigOnly, 'customer_name').some((v) => /priya anand/i.test(v));
  if (!p10) fail('spec', `P10: "By:" / "Authorized Representative" / "Name/Title" lines are signers, never a party (got vendor ${val(sigOnly, 'vendor')}, customer ${val(sigOnly, 'customer_name')})`);
  console.log(`  spec cases: T2 ${ok ? 'ok' : 'FAIL'}, P1 ${p1.ok ? 'FAIL' : 'refused'}, P2 ${p2.ok ? 'FAIL' : 'refused'}, P3 ${p3.candidates.end_date ? 'FAIL' : 'refused'}, P4 ${p4 ? 'refused' : 'FAIL'}, P5 ${p5 ? 'refused' : 'FAIL'}, P6 ${p6 ? 'ok' : 'FAIL'}, P8 ${p8 ? 'refused' : 'FAIL'}, P9 ${p9 ? 'ok' : 'FAIL'}, P10 ${p10 ? 'refused' : 'FAIL'}, P7 ${p7 ? 'refused' : 'FAIL'}`);
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

// ---------------------------------------------------------------- 5. stored-value audit (read-only; docread2 round)
// The audit re-runs the cross-checks over values ALREADY STORED. (a) over this tree's own stored values it must raise nothing
// (no false alarms on the 1,000 documents); with `--tree <older checkout>` it reports what it finds in the values that older reader
// stored. (b) Planted stored-wrong values must each be flagged, planted-right controls must not.
let audit = null;
try {
  const A = await import(pathToFileURL(path.join(ROOT, 'api/_lib/modelAvoidance/storedAudit.js')).href);
  audit = { byRule: {}, docs: 0, flags: 0 };
  for (const d of PAGES.docs) {
    const r = runDoc(P, d);
    const fl = A.auditStoredFacts({ pages: d.pages, fields: r.fields });
    if (fl.length) audit.docs++;
    for (const f of fl) { audit.flags++; audit.byRule[f.rule] = (audit.byRule[f.rule] ?? 0) + 1; if (TREE === ROOT && audit.flags <= 10) fail('audit false alarm', `${d.filename} ${f.field_key}="${f.value}" (${f.rule}): ${f.reason}`); }
  }
  const pg = (text) => [{ page_no: 1, text }];
  const stored = (pairs) => pairs.map(([k, v, extra]) => ({ field_key: k, value: v, corrected_value: null, ...(extra ?? {}) }));
  const COI = 'CERTIFICATE OF LIABILITY INSURANCE\nCertificate Date: 2026-01-25   Insurer:   Ironwood Casualty Mutual\nGeneral Liability GL-1   Policy Effective: 2025-12-03\nPolicy Expires:   2026-12-03\nINSURED   CERTIFICATE HOLDER\nAcme Plumbing LLC   Desert Car Wash Co';
  const INV = 'INVOICE\nInvoice #: 4411   Date: 03/02/2026\nBill To: Desert Car Wash Co\nService call   1   $100.00\nSubtotal $100.00\nTax $8.00\nTotal $108.00';
  const BADINV = 'INVOICE\nInvoice #: 4412   Date: 03/02/2026\nBill To: Desert Car Wash Co\nService call   1   $100.00\nSubtotal $100.00\nTax $8.00\nTotal $180.00';
  const LEASE = 'LEASE AGREEMENT\nThis Lease is made between Mesa Holdings LLC (Landlord) and Desert Car Wash Co (Tenant) for a term of 60 months beginning 02/10/2023 and ending 02/09/2028.';
  const EVT = 'EVENT AGREEMENT\nThis Agreement is made 03/13/2026 between the Venue and Harborlight Neighbors Alliance (the Client).\n\n__________________________________   __________________________________\nVenue: Cecilia Reeves Date: ________   Client: Colin Dunn Date: ________';
  const CASES = [
    // [label, pages, stored fields, expected rule or null (= must not be flagged)]
    ['COI start stored as the certificate date', COI, stored([['start_date', '2026-01-25'], ['end_date', '2026-12-03']]), 'period'],
    ['COI period stored correctly (control)', COI, stored([['start_date', '2025-12-03'], ['end_date', '2026-12-03']]), null],
    ['lease term whose end is 12 months short', LEASE, stored([['agreement_term', '60 months (02/10/2023 - 02/09/2027)'], ['start_date', '2023-02-10'], ['end_date', '2027-02-09']]), 'term'],
    ['lease term correct (control)', LEASE, stored([['agreement_term', '60 months (02/10/2023 - 02/09/2028)'], ['start_date', '2023-02-10'], ['end_date', '2028-02-09']]), null],
    ['invoice amount stored as the subtotal', INV, stored([['cost', '100.00']]), 'total'],
    ['invoice amount correct (control)', INV, stored([['cost', '108.00']]), null],
    ['page whose subtotal + tax is not its total', BADINV, stored([['cost', '180.00']]), 'total'],
    ['column title stored as the customer', INV, stored([['customer_name', 'SERVICE LOCATION']]), 'label'],
    ['signer stored as the customer', EVT, stored([['customer_name', 'Colin Dunn']]), 'signer'],
    ['party stored as the customer (control)', EVT, stored([['customer_name', 'Harborlight Neighbors Alliance']]), null],
    ['a person-corrected value is never flagged (control)', EVT, [{ field_key: 'customer_name', value: 'Colin Dunn', corrected_value: 'Colin Dunn' }], null],
  ];
  let planted = 0, plantedOk = 0;
  for (const [label, text, fields, want] of CASES) {
    const got = A.auditStoredFacts({ pages: pg(text), fields }).map((f) => f.rule);
    const ok = want ? got.includes(want) : got.length === 0;
    planted++; if (ok) plantedOk++;
    console.log(`  stored-value audit: ${label} -> ${got.length ? got.join(',') : 'no flag'} ${ok ? '(as expected)' : '(WRONG)'}`);
    if (!ok) fail('audit', `${label}: expected ${want ?? 'no flag'}, got ${got.join(',') || 'no flag'}`);
  }
  audit.planted = `${plantedOk}/${planted}`;
} catch (err) { audit = null; fail('audit', `storedAudit.js missing or broken in this checkout: ${err?.message}`); }

// ---------------------------------------------------------------- 6. line-item tables (tables lane, 2026-10-24)
// The anchored-stream table reader (api/_lib/modelAvoidance/tableRows.js) over (a) the clean synthetic "Sample" line-item documents
// (gold rows known: ENFORCED - a wrong row fact fails the gate), (b) the ORIGINAL 1,000 documents (no gold rows exist: a verified
// table whose total contradicts the document's own cost fact fails), (c) the degraded copies of (a) (MEASURED, not enforced).
// Three table-specific planted failures (a swapped column, an off-by-one row, a total from another page) must be rejected, first
// by the oracle and then by the reader itself.
let tbl = null;
{
  const TG_PATH = path.join(ROOT, 'test-docs/real-docs/tables/GOLD_TABLES.json');
  let TR = null, E = null;
  try { TR = await import(pathToFileURL(path.join(TREE, 'api/_lib/modelAvoidance/tableRows.js')).href); E = await import('./real-docs/tables-eval.mjs'); } catch { TR = null; }
  const TDOCS = E?.loadTablesPages(ROOT);
  if (!TR || !TDOCS || !fs.existsSync(TG_PATH)) { if (TREE === ROOT) fail('tables', 'tableRows.js / tables suite missing in this tree'); else console.log('  tables: reader absent in this tree (skipped)'); }
  else {
    const TG = JSON.parse(fs.readFileSync(TG_PATH, 'utf8'));
    const rd = TR.readTables;
    const clean = TDOCS.filter((d) => d.variant === 'clean-pdf');
    tbl = { clean: {}, plants: [], degraded: {}, originals: {} };
    // 6a. oracle self-test: planted table failures are rejected by the judge
    const gdoc = clean.find((d) => d.filename.includes('invoice-B')) ?? clean[0];
    const gold = gdoc.gold_rows;
    const self = E.judgeRows(gold.map((g) => ({ ...g })), gold);
    if (self.wrong.length || self.missed.length) fail('oracle', 'table gold does not match itself');
    const i = gold.findIndex((g) => g.values[0] > 1);
    const planted = [
      ['swapped column (unit price <-> amount)', gold.map((g, k) => (k === i ? { ...g, values: [g.values[0], g.values[2], g.values[1]] } : g)), 'rows'],
      ['off-by-one row (label of the next row)', gold.map((g, k) => (k === i ? { ...g, label: gold[i + 1].label } : g)), 'rows'],
      ['total taken from another page', null, 'total'],
    ];
    for (const [label, rows, kind] of planted) {
      let caught;
      if (kind === 'rows') caught = E.judgeRows(rows, gold).wrong.length > 0;
      else caught = E.judgeTotals({ totals: { total: { value: gdoc.gold_totals.total, page: 2 } } }, gdoc.gold_totals, 1).wrong.length > 0;
      console.log(`  oracle self-test: ${label} -> ${caught ? 'REJECTED (good)' : 'NOT CAUGHT'}`);
      tbl.plants.push([label, caught]);
      if (!caught) fail('oracle', `planted table failure not rejected: ${label}`);
    }
    // 6b. the same three plants fed to the READER as damaged page text: a damaged row/total must never become a fact
    {
      const base = gdoc.pages.map((p) => ({ page_no: p.page_no, text: p.text }));
      const lines = base[0].text.split('\n');
      const rowIdx = lines.findIndex((l) => l.startsWith(gold[i].label.slice(0, 10)));
      const run = (ls, other) => { const pg = [{ page_no: 1, text: ls.join('\n') }]; const r = rd(other ? [{ page_no: 1, text: ls.join('\n') }] : pg); return { r, j: E.judgeRows(r.rows, gold) }; };
      const cellsOf = (l) => l.split(/ {2,}/);
      const sw = lines.slice(); { const c = cellsOf(sw[rowIdx]); [c[c.length - 1], c[c.length - 2]] = [c[c.length - 2], c[c.length - 1]]; sw[rowIdx] = c.join('   '); }
      const off = lines.slice(); off[rowIdx] = off[rowIdx].replace(/\$([\d,]+)\.(\d\d)$/, (m, a, b) => `$${(Number(a.replace(/,/g, '')) + 1).toLocaleString('en-US')}.${b}`);
      const otherDoc = clean.find((d) => d !== gdoc && d.kind === 'invoice');
      const otherTotal = otherDoc.pages[otherDoc.pages.length - 1].text.split('\n').find((l) => /^Total Due/.test(l.trim()));
      const wt = lines.slice(); const ti = wt.findIndex((l) => /^\s*Total Due/.test(l)); wt[ti] = otherTotal;
      const results6 = [
        ['swapped column in the page text', run(sw), (x) => x.j.wrong.length === 0 && !x.r.rows.some((q) => q.quote === sw[rowIdx].trim())],
        ['an amount one dollar off in the page text', run(off), (x) => x.j.wrong.length === 0 && !x.r.rows.some((q) => q.quote === off[rowIdx].trim())],
        ["another document's total on the total line", run(wt), (x) => x.j.wrong.length === 0 && !x.r.totals?.total && !x.r.documentVerified],
      ];
      for (const [label, x, ok] of results6) { const good = ok(x); console.log(`  reader plant: ${label} -> ${good ? 'no wrong fact (good)' : 'GOT THROUGH'}`); tbl.plants.push([label, good]); if (!good) fail('tables', `planted failure got through the reader: ${label}`); }
    }
    // 6c. the clean suite: enforced
    for (const mode of ['x', 'order']) {
      const s = E.evalSuite(clean, { mode, readTables: rd });
      tbl.clean[mode] = { docs: s.docs, goldRows: s.goldRows, captured: s.rowsCaptured, wrong: s.wrongRows.length, wrongTotals: s.wrongTotals.length, docsNeedPerson: s.docsNeedPerson, byKind: s.byKind };
      for (const w of s.wrongRows.slice(0, 5)) fail('WRONG TABLE ROW', `${w.doc}: ${w.label} ${JSON.stringify(w.values)}`);
      for (const w of s.wrongTotals.slice(0, 5)) fail('WRONG TABLE TOTAL', `${w.doc}: ${w.key} read ${w.read} (gold ${w.gold})`);
      if (s.rowsCaptured < TG.clean_rows_min) fail('regression (table rows no longer captured)', `${mode}: ${s.rowsCaptured} < ${TG.clean_rows_min}`);
    }
    // 6d. the original documents: no gold rows exist; count what is verified and check each verified total against the document's own cost
    {
      let withTable = 0, withRows = 0, rows = 0, verified = 0, contra = 0, quarantinedDocs = 0;
      const q = {};
      for (const d of PAGES.docs) {
        const r = rd(d.pages);
        if (!r.tables.length) continue;
        withTable++;
        if (r.rows.length) { withRows++; rows += r.rows.length; } else { quarantinedDocs++; const k = r.reason ?? 'unknown'; q[k] = (q[k] ?? 0) + 1; }
        if (r.documentVerified && r.totals?.total) {
          verified++;
          const cost = byName.get(d.filename)?.fields.find((f) => f.k === 'cost');
          if (cost && canon('cost', cost.v) !== String(Math.round(r.totals.total.value * 100)) && Number(P.ef.normalizeNumber(String(cost.v), { money: true })) > 0) { contra++; fail('TABLE TOTAL CONTRADICTS the document cost', `${d.filename}: table total ${r.totals.total.value}, cost fact ${cost.v}`); }
        }
      }
      tbl.originals = { withTable, withRows, rows, verifiedDocs: verified, quarantinedDocs, contradictions: contra, reasons: q };
      if (rows < (TG.originals_rows_min ?? 0)) fail('regression (table rows no longer captured)', `originals: ${rows} < ${TG.originals_rows_min}`);
      if (verified < (TG.originals_docs_verified_min ?? 0)) fail('regression (table documents no longer verified)', `originals: ${verified} < ${TG.originals_docs_verified_min}`);
    }
    // 6e. degraded copies of the same documents: MEASURED, NOT ENFORCED
    for (const v of ['photo', 'lowres', 'rotated', 'stained', 'handwriting']) {
      const s = E.evalSuite(TDOCS.filter((d) => d.variant === v), { mode: 'order', readTables: rd });
      tbl.degraded[v] = { docs: s.docs, goldRows: s.goldRows, captured: s.rowsCaptured, wrong: s.wrongRows.length, wrongTotals: s.wrongTotals.length, docsNeedPerson: s.docsNeedPerson, wrongRows: s.wrongRows.slice(0, 5) };
    }
    if (process.argv.includes('--update-tables') && failures.length === 0) {
      TG.clean_rows_min = Math.min(tbl.clean.x.captured, tbl.clean.order.captured);
      TG.originals_rows_min = tbl.originals.rows; TG.originals_docs_verified_min = tbl.originals.verifiedDocs;
      fs.writeFileSync(TG_PATH, JSON.stringify(TG, null, 2));
      console.log('  GOLD_TABLES.json ratchets updated (review the diff).');
    }
  }
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
if (audit) console.log(`  stored-value audit over the values this tree stores: ${audit.flags} flags on ${audit.docs} documents ${JSON.stringify(audit.byRule)}; planted cases ${audit.planted}`);
console.log(`  quotes checked on the page ${checkedQuotes}, not grounded ${badQuotes}`);
console.log(`  needs a person: ${needs.length} (gold allows ${Object.keys(allowed).length}); unexpected ${unexpected.length}; resolved since gold ${resolved.length}`);
if (deg) { console.log(`  degraded copies ${deg.docs}: facts correct ${deg.correct}, wrong ${deg.wrong.length}, not read ${deg.missed}; ${JSON.stringify(deg.byVariant)}`); for (const w of deg.wrong) console.log('    known OCR misread: ' + w); }
if (tbl) {
  const c = tbl.clean;
  console.log(`  line-item tables, clean synthetic documents (${c.order.docs}; ${c.order.goldRows} gold rows): captured x-anchored ${c.x.captured}, text-only ${c.order.captured}; WRONG rows ${c.x.wrong + c.order.wrong}, wrong totals ${c.x.wrongTotals + c.order.wrongTotals}; documents needing a person ${c.x.docsNeedPerson}/${c.order.docsNeedPerson}`);
  const o = tbl.originals;
  console.log(`  line-item tables, the original documents: ${o.withTable} with a table; verified rows ${o.rows} in ${o.withRows} documents (${o.verifiedDocs} with a verified total); table not proven (quarantined) in ${o.quarantinedDocs}; total contradicting the cost fact ${o.contradictions}`);
  const dg = Object.entries(tbl.degraded);
  console.log(`  line-item tables, degraded copies (MEASURED, not enforced): ` + dg.map(([k, v]) => `${k} ${v.captured}/${v.goldRows} rows, wrong ${v.wrong}, need a person ${v.docsNeedPerson}/${v.docs}`).join('; '));
  for (const [k, v] of dg) for (const w of v.wrongRows) console.log(`    degraded wrong row (${k}): ${w.doc} ${w.label} ${JSON.stringify(w.values)}`);
}
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
