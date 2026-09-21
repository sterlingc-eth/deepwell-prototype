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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GEN = path.join(ROOT, 'scripts', 'synth-business.mjs');

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
  minCustomers: 100, minDocuments: 500, questionTotal: 60, analyticsCount: 30, lookupCount: 30,
  requireAllCounties: true, requireOutOfState: true, requireAllBrands: true, requireAllDocTypes: true, requireMixedWarranty: true,
});

runChecks('[small]', ['--customers', '30', '--out', 'test-docs/business-small'], 'test-docs/business-small', {
  minCustomers: 25, minDocuments: 100, questionTotal: 40, analyticsCount: 20, lookupCount: 20,
  requireAllCounties: true, requireOutOfState: true, requireAllBrands: true, requireAllDocTypes: true, requireMixedWarranty: true,
});

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
