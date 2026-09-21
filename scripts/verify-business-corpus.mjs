/**
 * Verification for the business corpus generator (scripts/synth-business.mjs)
 * at BOTH scales: the default 120-customer corpus (test-docs/business/) and
 * the cheap ~30-customer subset (test-docs/business-small/, generated with
 * `--customers 30 --out test-docs/business-small`). No database, no network,
 * no model -- pure checks against the generator's own output, regenerated
 * fresh each time this runs.
 *
 *   node scripts/verify-business-corpus.mjs
 *
 * Covers (per handoffs/DONOVAN_ANALYTICS_BRIEF_2026-09-21.md's Workstream B
 * sanity-check list, extended for the `--customers`/`--out` subset):
 *   1. Generator determinism -- running it twice (same args) produces a
 *      byte-identical answer key and the same file count/names.
 *   2. Answer-key internal consistency:
 *      - sum of county counts (AZ only) equals the AZ state total
 *      - sum of state totals equals the customer total
 *      - every document belongs to exactly one customer, or to the
 *        letterhead-only (docsWithoutCustomer) set -- never both, never
 *        neither, never twice
 *      - equipmentByBrand / warrantyStatusCounts / documentsByType totals
 *        match the customers/units/files they were tallied from
 *   3. Every question's expectedContains is derivable from the key itself
 *      (recomputed independently here, not just re-read).
 *   4. For the small subset specifically: >=3 AZ counties, >=1 out-of-state
 *      customer, all 8 brands, all 15 document types, and at least 3 of the
 *      4 warranty-status buckets all actually present in the generated data
 *      (not just "the tally is internally consistent" -- the coverage the
 *      subset exists to guarantee).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GEN = path.join(ROOT, 'scripts', 'synth-business.mjs');
const TODAY = '2026-09-21';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
/** Order-independent object comparison, for tallies where key insertion
 *  order legitimately differs between "as the generator built it" and "as
 *  freshly recomputed here" without that being a real mismatch. */
function canon(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
const eqTally = (name, got, want) => eq(name, canon(got), canon(want));

const KNOWN_TYPES = ['work-order', 'invoice', 'warranty-registration', 'startup-sheet', 'permit', 'nameplate-photo',
  'maintenance-agreement', 'service-ticket', 'dispatch-note', 'proposal-quote', 'inspection-report',
  'purchase-order', 'equipment-record', 'correspondence', 'other'];
function typeFromFilename(f) {
  // Filenames are "<seq>-<type>-<slug>.<ext>" where BOTH type and slug may
  // themselves contain hyphens ("dispatch-note-shop-truck.txt"), so this
  // matches against the actual known type ids (longest match wins) rather
  // than guessing a boundary with a single regex.
  const rest = f.replace(/^\d+-/, '').replace(/\.(pdf|txt)$/, '');
  const matches = KNOWN_TYPES.filter((t) => rest === t || rest.startsWith(`${t}-`));
  matches.sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}
const BRANDS = ['Trane', 'Carrier', 'Goodman', 'Lennox', 'Rheem', 'York', 'Daikin', 'Mitsubishi'];

/** Pulls the printed text out of a hand-rolled PDF (scripts/synth-business.mjs's
 *  buildPdf): every `(...) Tj` text-show operator, unescaped the same way
 *  escapePdfText() there escaped it. Not a general PDF text extractor --
 *  exactly matched to this generator's own (uncompressed, single-encoding)
 *  output, which is all it needs to be. */
function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  const ops = raw.match(/\((?:[^()\\]|\\.)*\)\s*Tj/g) ?? [];
  return ops.map((op) => {
    const inner = op.slice(1, op.lastIndexOf(')'));
    return inner.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
  }).join('\n');
}
function docText(outDir, filename) {
  const buf = fs.readFileSync(path.join(outDir, filename));
  return filename.endsWith('.pdf') ? extractPdfText(buf) : buf.toString('utf8');
}

/** Every MM/DD/YYYY and YYYY-MM-DD date printed in a piece of document text,
 *  as an ISO string (comparable with plain `>` since it's zero-padded). Used
 *  to catch a document dated after TODAY -- a unit's install date is allowed
 *  to be old, never in the future. */
function datesInText(text) {
  const found = [];
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) found.push(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`);
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.push(m[0]);
  return found;
}

/**
 * Runs the full check suite for one corpus.
 * @param {string} label            printed before each check, e.g. "[full]"
 * @param {string[]} genArgs        extra CLI args for synth-business.mjs (e.g. ['--customers','30','--out','test-docs/business-small'])
 * @param {string} outDirRel        output dir relative to ROOT (must match genArgs' --out, or 'test-docs/business' for the default)
 * @param {object} expect           { minCustomers, minDocuments, questionTotal, analyticsCount, lookupCount, requireAllCounties, requireOutOfState, requireAllBrands, requireAllDocTypes, requireMixedWarranty }
 */
function runChecks(label, genArgs, outDirRel, expect) {
  console.log(`\n--- ${label} (test-docs/${outDirRel.split('/').pop()}/, args: ${genArgs.join(' ') || '(default)'}) ---`);
  const outDir = path.join(ROOT, outDirRel);
  const keyPath = path.join(outDir, 'ANSWER_KEY.json');
  const p = (name, ok, detail) => check(`${label} ${name}`, ok, detail);
  const pEq = (name, got, want) => eq(`${label} ${name}`, got, want);
  const pEqTally = (name, got, want) => eqTally(`${label} ${name}`, got, want);

  /* -------------------------------------------------- 1. determinism --- */
  execFileSync('node', [GEN, ...genArgs], { cwd: ROOT, stdio: 'ignore' });
  const filesA = fs.readdirSync(outDir).sort();
  const keyA = fs.readFileSync(keyPath, 'utf8');

  execFileSync('node', [GEN, ...genArgs], { cwd: ROOT, stdio: 'ignore' });
  const filesB = fs.readdirSync(outDir).sort();
  const keyB = fs.readFileSync(keyPath, 'utf8');

  pEq('generator produces the same file list on re-run', filesB, filesA);
  p('generator produces a byte-identical ANSWER_KEY.json on re-run', keyA === keyB);

  const answerKey = JSON.parse(keyB);
  const { customers, docsWithoutCustomer, mustNotMerge, totals, equipmentByBrand, warrantyStatusCounts, documentsByType, totalDocuments, totalUnits, questions } = answerKey;

  p(`has at least ${expect.minCustomers} customers`, customers.length >= expect.minCustomers, `got ${customers.length}`);
  p(`has at least ${expect.minDocuments} documents`, totalDocuments >= expect.minDocuments, `got ${totalDocuments}`);

  /* ------------------------------------------------ 2. key consistency --- */
  const countySum = Object.values(totals.byCounty).reduce((a, b) => a + b, 0);
  pEq('sum of AZ county counts equals the AZ state total', countySum, totals.byState.AZ ?? 0);
  const stateSum = Object.values(totals.byState).reduce((a, b) => a + b, 0);
  pEq('sum of state counts equals the customer total', stateSum, totals.customers);
  pEq('totals.customers matches customers.length', totals.customers, customers.length);

  const azUnknownCounty = customers.filter((c) => c.state === 'AZ' && c.county === 'Unknown');
  p('no AZ customer resolves to an Unknown county', azUnknownCounty.length === 0,
    azUnknownCounty.map((c) => `${c.key} (${c.address})`).join('; '));

  const citySum = Object.values(totals.byCity).reduce((a, b) => a + b, 0);
  pEq('sum of city counts equals the customer total', citySum, totals.customers);

  const docOwners = new Map();
  for (const c of customers) {
    for (const f of c.docs) {
      if (docOwners.has(f)) { failures++; console.log(`FAIL  ${label} document "${f}" appears under more than one owner (${docOwners.get(f)} AND ${c.key})`); }
      docOwners.set(f, c.key);
    }
  }
  let dupInLetterheadOnly = 0;
  for (const f of docsWithoutCustomer) {
    if (docOwners.has(f)) { dupInLetterheadOnly++; console.log(`FAIL  ${label} "${f}" is both a customer document (${docOwners.get(f)}) and letterhead-only`); }
    docOwners.set(f, '(letterhead-only)');
  }
  p('no document is both a customer document and letterhead-only', dupInLetterheadOnly === 0);

  const actualFiles = fs.readdirSync(outDir).filter((f) => f.endsWith('.pdf') || f.endsWith('.txt'));
  pEq('every generated file is accounted for in the key (customer doc or letterhead-only)',
    actualFiles.filter((f) => !docOwners.has(f)).sort(), []);
  pEq('the key names no file that was not actually generated',
    [...docOwners.keys()].filter((f) => !actualFiles.includes(f)).sort(), []);
  pEq('total documents = customer docs + letterhead-only docs',
    customers.reduce((n, c) => n + c.docs.length, 0) + docsWithoutCustomer.length, totalDocuments);

  const custKeys = new Set(customers.map((c) => c.key));
  for (const [a, b] of mustNotMerge) {
    p(`mustNotMerge pair [${a}, ${b}] both exist and are distinct`, a !== b && custKeys.has(a) && custKeys.has(b));
  }

  // -- key == documents: whatever brand a document actually prints for a
  // unit must be the SAME brand the key claims for it. Greps every
  // customer's generated document text (PDF text objects via extractPdfText,
  // plain read for .txt) for that unit's serial, and where a document
  // mentions the serial, asserts it also mentions the key's brand string for
  // it -- exactly the check that would have caught the 2026-09-21 bug where
  // a post-hoc key mutation (forcing a brand/model onto a customer's KEY
  // entry to guarantee a warranty-status example) diverged from what
  // buildResidential() had already written into that customer's actual PDFs.
  let brandMismatches = 0;
  for (const c of customers) {
    for (const f of c.docs) {
      const text = docText(outDir, f);
      for (const u of c.units) {
        if (u.serial && text.includes(u.serial) && u.brand && !text.includes(u.brand)) {
          brandMismatches++;
          console.log(`FAIL  ${label} ${f} contains serial "${u.serial}" but not brand "${u.brand}" -- key says ${c.key}'s unit is ${u.brand}, document disagrees`);
        }
      }
    }
  }
  p('every document that prints a unit\'s serial also prints the key\'s brand for that unit', brandMismatches === 0);

  // -- key == documents, for NAMES this time: the same class of bug as the
  // brand check above, caught the same way a customer-facing name trap
  // (near-miss surnames) got applied to the ANSWER_KEY.json after the
  // documents had already been rendered with the customer's real, un-trapped
  // name -- so the key described "Sorensen" while every document on disk
  // still said "Donna Thornton". Two checks: (1) a customer's canonicalName
  // must appear in at least one of its own documents (not ALL of them --
  // e.g. a nameplate-photo transcript never prints a customer name at all,
  // by design, and that's fine); (2) whatever name IS printed right after a
  // "Customer:"/"Bill To:"/"Homeowner:" label, or after "Dear ... ," in
  // correspondence, must belong to that same customer -- never someone
  // else's name on someone else's letterhead.
  const NAME_LABEL_RE = /^(?:Customer|Bill To|Homeowner):\s*(.+)$/;
  const DEAR_RE = /^Dear\s+(.+),$/;
  let noNameInDocs = 0;
  let strayNamePrints = 0;
  for (const c of customers) {
    const variantList = [c.canonicalName]; // this generator never prints more than one spelling per customer
    let foundOwnName = false;
    for (const f of c.docs) {
      const text = docText(outDir, f);
      if (text.includes(c.canonicalName)) foundOwnName = true;
      for (const line of text.split('\n')) {
        const m = NAME_LABEL_RE.exec(line) ?? DEAR_RE.exec(line);
        if (!m) continue;
        const printedName = m[1].trim();
        if (!variantList.includes(printedName)) {
          strayNamePrints++;
          console.log(`FAIL  ${label} ${f} prints "${printedName}" after a Customer/Bill To/Homeowner/Dear label, but ${c.key}'s name is "${c.canonicalName}"`);
        }
      }
    }
    if (!foundOwnName) { noNameInDocs++; console.log(`FAIL  ${label} ${c.key}'s canonicalName "${c.canonicalName}" does not appear in any of its documents`); }
  }
  p('every customer\'s canonicalName appears in at least one of its own documents', noNameInDocs === 0);
  p('every name printed after a Customer/Bill To/Homeowner/Dear label belongs to that document\'s customer', strayNamePrints === 0);

  // -- no printed document date is after TODAY. maintenance-agreement is the
  // one exception: its "Agreement Period" is a contract term (e.g.
  // "01/01/2025 - 12/31/2026"), not an event date, and a contract's end date
  // is expected to be in the future -- exactly like a warranty's "Valid
  // through" date, which this generator also never treats as implausible.
  let futureDateFiles = 0;
  for (const f of actualFiles) {
    if (typeFromFilename(f) === 'maintenance-agreement') continue;
    const text = docText(outDir, f);
    const future = datesInText(text).filter((d) => d > TODAY);
    if (future.length) {
      futureDateFiles++;
      console.log(`FAIL  ${label} ${f} prints a date after today (${TODAY}): ${[...new Set(future)].join(', ')}`);
    }
  }
  p('no generated document (other than a maintenance-agreement\'s contract period) prints a date after today', futureDateFiles === 0);

  // -- every customer with a phone/email recorded in the key actually has it
  // printed on at least one of their documents -- EXCEPT the frozen small
  // corpus base (test-docs/business-small with no --contacts-topup), where
  // contact info is deliberately recorded in the key but not printed into any
  // of the 144 already-uploaded files; there, the check instead looks at the
  // sibling `${outDir}-topup/` directory the brief's --contacts-topup mode
  // writes, since that's where those same phone/email values actually get
  // printed for that corpus.
  const topupDir = `${outDir}-topup`;
  const topupDocsExist = fs.existsSync(topupDir);
  let contactPrintMisses = 0;
  for (const c of customers) {
    if (!c.phone && !c.email) continue;
    const ownDocsText = c.docs.map((f) => docText(outDir, f)).join('\n');
    let found = (c.phone && ownDocsText.includes(c.phone)) || (c.email && ownDocsText.includes(c.email));
    if (!found && topupDocsExist) {
      for (const f of fs.readdirSync(topupDir)) {
        if (!f.endsWith('.pdf') && !f.endsWith('.txt')) continue;
        const text = docText(topupDir, f);
        if ((c.phone && text.includes(c.phone)) || (c.email && text.includes(c.email))) { found = true; break; }
      }
    }
    if (!found) { contactPrintMisses++; console.log(`FAIL  ${label} ${c.key} has a phone/email in the key but it is not printed on any of its documents (or the topup dir)`); }
  }
  p('every customer with a key phone/email has it printed on at least one document (base or topup)', contactPrintMisses === 0);

  const allUnits = customers.flatMap((c) => c.units);
  pEq('totalUnits matches the sum of every customer\'s units', totalUnits, allUnits.length);
  const recomputedBrand = {};
  for (const u of allUnits) recomputedBrand[u.brand] = (recomputedBrand[u.brand] ?? 0) + 1;
  pEqTally('equipmentByBrand matches a fresh tally of customers[].units[].brand', equipmentByBrand, recomputedBrand);
  const recomputedStatus = { active: 0, expiring: 0, expired: 0, unknown: 0 };
  for (const u of allUnits) recomputedStatus[u.warrantyStatus] = (recomputedStatus[u.warrantyStatus] ?? 0) + 1;
  pEqTally('warrantyStatusCounts matches a fresh tally of customers[].units[].warrantyStatus', warrantyStatusCounts, recomputedStatus);

  const recomputedDocType = {};
  const unmatchedFiles = [];
  for (const f of actualFiles) {
    const t = typeFromFilename(f);
    if (!t) unmatchedFiles.push(f);
    else recomputedDocType[t] = (recomputedDocType[t] ?? 0) + 1;
  }
  p('every generated filename matches a known document type', unmatchedFiles.length === 0, unmatchedFiles.join(', '));
  pEqTally('documentsByType matches a fresh tally of generated filenames', documentsByType, recomputedDocType);

  /* ------------------------------------------- 3. capability coverage --- */
  if (expect.requireAllCounties) {
    const counties = new Set(customers.filter((c) => c.state === 'AZ').map((c) => c.county));
    p('all 3 of Maricopa/Pinal/Pima are present', ['Maricopa', 'Pinal', 'Pima'].every((c) => counties.has(c)),
      `got ${[...counties].join(', ')}`);
  }
  if (expect.requireOutOfState) {
    const outOfState = customers.filter((c) => c.state !== 'AZ').length;
    p('at least 1 out-of-state customer', outOfState >= 1, `got ${outOfState}`);
  }
  if (expect.requireAllBrands) {
    const brandsPresent = new Set(allUnits.map((u) => u.brand));
    p('all 8 brands are present', BRANDS.every((b) => brandsPresent.has(b)),
      `missing: ${BRANDS.filter((b) => !brandsPresent.has(b)).join(', ')}`);
  }
  if (expect.requireAllDocTypes) {
    p('all 15 document types are present', KNOWN_TYPES.every((t) => (documentsByType[t] ?? 0) > 0),
      `missing: ${KNOWN_TYPES.filter((t) => !(documentsByType[t] ?? 0)).join(', ')}`);
  }
  if (expect.requireMixedWarranty) {
    const present = ['active', 'expiring', 'expired', 'unknown'].filter((k) => (warrantyStatusCounts[k] ?? 0) > 0);
    p('at least 3 of the 4 warranty-status buckets are present (mixed tiers)', present.length >= 3, `got ${present.join(', ')}`);
  }

  /* --------------------------------------------- 4. questions derivable --- */
  p(`exactly ${expect.questionTotal} questions`, questions.length === expect.questionTotal, `got ${questions.length}`);
  p(`exactly ${expect.analyticsCount} analytics questions`, questions.filter((q) => q.type === 'analytics').length === expect.analyticsCount);
  p(`exactly ${expect.lookupCount} lookup questions`, questions.filter((q) => q.type === 'lookup').length === expect.lookupCount);
  p('every question has at least one non-empty expectedContains value',
    questions.every((q) => Array.isArray(q.expectedContains) && q.expectedContains.length > 0 && q.expectedContains.every((v) => String(v).length > 0)));

  function findQ(substr) { return questions.find((q) => q.q.includes(substr)); }

  const azCount = customers.filter((c) => c.state === 'AZ').length;
  p('"customers ... in Arizona" question matches an independent recount',
    findQ('in Arizona')?.expectedContains.includes(String(azCount)), `recount=${azCount}, key=${JSON.stringify(findQ('in Arizona')?.expectedContains)}`);

  const maricopaCount = customers.filter((c) => c.county === 'Maricopa').length;
  p('"customers ... in Maricopa County" question matches an independent recount',
    findQ('Maricopa County')?.expectedContains.includes(String(maricopaCount)));

  const expiredCount = allUnits.filter((u) => u.warrantyStatus === 'expired').length;
  p('"units ... out of warranty" question matches an independent recount',
    findQ('out of warranty')?.expectedContains.includes(String(expiredCount)));

  const traneCount = allUnits.filter((u) => u.brand === 'Trane').length;
  p('"Group equipment by brand" question mentions the independently recounted Trane total',
    findQ('Group equipment by brand')?.expectedContains.includes(String(traneCount)));

  const docAddQ = findQ('documents did we add this month');
  p('"documents did we add this month" matches the independently recounted total file count',
    docAddQ?.expectedContains.includes(String(actualFiles.length)));

  let lookupMismatches = 0;
  for (const q of questions.filter((x) => x.type === 'lookup')) {
    const addrMatch = q.q.match(/at (.+?)\?$/);
    if (!addrMatch) continue;
    const needle = addrMatch[1];
    const cust = customers.find((c) => needle.includes(c.address) || needle === c.canonicalName || needle.includes(c.canonicalName));
    if (!cust) continue;
    const known = [...cust.units.map((u) => u.serial), ...cust.units.map((u) => u.brand)];
    const ok = q.expectedContains.some((v) => known.includes(v));
    if (!ok) { lookupMismatches++; console.log(`FAIL  ${label} lookup question "${q.q}" expects ${JSON.stringify(q.expectedContains)}, not found on ${cust.key}`); }
  }
  p('every checkable lookup question\'s expected value is on the customer it names', lookupMismatches === 0);

  /* --------------------------------- score-corpus.mjs self-test agrees --- */
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'score-corpus.mjs'), '--selftest', '--key', keyPath], { cwd: ROOT, stdio: 'pipe' });
    p('scripts/score-corpus.mjs --selftest --key <this key> passes', true);
  } catch (err) {
    p('scripts/score-corpus.mjs --selftest --key <this key> passes', false, err.stdout?.toString().slice(-800) ?? String(err));
  }
}

runChecks('[full]', [], 'test-docs/business', {
  minCustomers: 100, minDocuments: 500, questionTotal: 67, analyticsCount: 31, lookupCount: 36,
  requireAllCounties: true, requireOutOfState: true, requireAllBrands: true, requireAllDocTypes: true, requireMixedWarranty: true,
});

runChecks('[small]', ['--customers', '30', '--out', 'test-docs/business-small'], 'test-docs/business-small', {
  minCustomers: 25, minDocuments: 100, questionTotal: 47, analyticsCount: 21, lookupCount: 26,
  requireAllCounties: true, requireOutOfState: true, requireAllBrands: true, requireAllDocTypes: true, requireMixedWarranty: true,
});

/**
 * --contacts-topup: the small corpus's 144 already-uploaded files must be
 * left exactly as `[small]` above just produced them, and the topup dir must
 * contain new, distinctly-numbered, non-colliding invoices for every
 * customer who has a phone/email on file.
 */
{
  const label = '[small-topup]';
  const p = (name, ok, detail) => check(`${label} ${name}`, ok, detail);
  const smallDir = path.join(ROOT, 'test-docs', 'business-small');
  const topupDir = `${smallDir}-topup`;

  const beforeFiles = fs.readdirSync(smallDir).sort();
  const beforeHashes = new Map(beforeFiles.map((f) => [f, fs.readFileSync(path.join(smallDir, f))]));

  execFileSync('node', [GEN, '--customers', '30', '--out', 'test-docs/business-small', '--contacts-topup'], { cwd: ROOT, stdio: 'ignore' });

  const afterFiles = fs.readdirSync(smallDir).sort();
  p('base dir file list is unchanged by --contacts-topup', JSON.stringify(afterFiles) === JSON.stringify(beforeFiles));
  let baseMutated = 0;
  for (const f of afterFiles) {
    const before = beforeHashes.get(f);
    const after = fs.readFileSync(path.join(smallDir, f));
    if (!before || Buffer.compare(before, after) !== 0) { baseMutated++; console.log(`FAIL  ${label} ${f} changed on disk after running --contacts-topup`); }
  }
  p('no base-dir file content changed after running --contacts-topup', baseMutated === 0);

  p('topup dir exists', fs.existsSync(topupDir));
  const topupKey = JSON.parse(fs.readFileSync(path.join(topupDir, 'TOPUP_KEY.json'), 'utf8'));
  p('TOPUP_KEY.json lists at least 1 customer', topupKey.customers.length > 0, `got ${topupKey.customers.length}`);

  const smallKey = JSON.parse(fs.readFileSync(path.join(smallDir, 'ANSWER_KEY.json'), 'utf8'));
  const withContact = smallKey.customers.filter((c) => c.phone || c.email).length;
  p('TOPUP_KEY.json has exactly one entry per customer with a phone or email in the small corpus key',
    topupKey.customers.length === withContact, `got ${topupKey.customers.length}, want ${withContact}`);

  const topupFiles = fs.readdirSync(topupDir).filter((f) => f.endsWith('.pdf') || f.endsWith('.txt'));
  p(`topup dir has ${withContact} new invoice documents`, topupFiles.length === withContact, `got ${topupFiles.length}`);

  let futureInTopup = 0;
  for (const f of topupFiles) {
    const future = datesInText(docText(topupDir, f)).filter((d) => d > TODAY);
    if (future.length) { futureInTopup++; console.log(`FAIL  ${label} ${f} prints a date after today: ${future.join(', ')}`); }
  }
  p('no topup document prints a date after today', futureInTopup === 0);

  let contactMisses = 0;
  for (const entry of topupKey.customers) {
    const text = docText(topupDir, entry.filename);
    const ok = (entry.phone && text.includes(entry.phone)) || (entry.email && text.includes(entry.email));
    if (!ok) { contactMisses++; console.log(`FAIL  ${label} ${entry.filename} does not print ${entry.key}'s phone/email`); }
  }
  p('every topup invoice prints the phone/email TOPUP_KEY.json says it should', contactMisses === 0);

  // sha256 of every topup file must not collide with anything already
  // generated (the base small corpus, nor the full corpus).
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const existingHashes = new Set();
  for (const dir of [smallDir, path.join(ROOT, 'test-docs', 'business')]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.pdf') || f.endsWith('.txt')) existingHashes.add(sha256(fs.readFileSync(path.join(dir, f))));
    }
  }
  let collisions = 0;
  for (const f of topupFiles) {
    const h = sha256(fs.readFileSync(path.join(topupDir, f)));
    if (existingHashes.has(h)) { collisions++; console.log(`FAIL  ${label} ${f}'s sha256 collides with an already-generated document`); }
  }
  p('no topup document\'s sha256 collides with the base or full corpus', collisions === 0);

  // determinism: running --contacts-topup twice produces byte-identical topup output.
  const topupHashesA = new Map(topupFiles.map((f) => [f, sha256(fs.readFileSync(path.join(topupDir, f)))]));
  execFileSync('node', [GEN, '--customers', '30', '--out', 'test-docs/business-small', '--contacts-topup'], { cwd: ROOT, stdio: 'ignore' });
  let topupDrift = 0;
  for (const [f, h] of topupHashesA) {
    const h2 = sha256(fs.readFileSync(path.join(topupDir, f)));
    if (h2 !== h) { topupDrift++; console.log(`FAIL  ${label} ${f} is not byte-identical on a second --contacts-topup run`); }
  }
  p('--contacts-topup is deterministic across two runs', topupDrift === 0);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
