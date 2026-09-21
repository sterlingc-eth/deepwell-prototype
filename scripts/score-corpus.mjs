#!/usr/bin/env node
/**
 * Pure scorer for the synthetic limit-test corpus (test-docs/synthetic/).
 * No network, no database — takes a JSON snapshot the coordinator captured
 * from the running app (see handoffs/LIMIT_TEST_PLAN_2026-09-20.md) and grades
 * it against test-docs/synthetic/ANSWER_KEY.json.
 *
 * Usage:
 *   node scripts/score-corpus.mjs --dir <snapshot-dir>   (expects
 *     customers.json, documents.json, scan.json, asks.json in that dir)
 *   node scripts/score-corpus.mjs --customers f --documents f --scan f --asks f
 *   node scripts/score-corpus.mjs --selftest   (scores the answer key against
 *     a synthetic "perfect" snapshot built in memory — should print 100%)
 *
 * Matching logic reuses the exact production rules from api/_lib/integrity.js
 * (read-only import — nothing under api/ is modified) so "does this actual
 * customer match this answer-key customer" uses the same address/name
 * normalization the app itself uses to decide duplicates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAddressKey, normalizeSurname, normalizePhoneKey, normalizeEmailKey } from '../api/_lib/integrity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ANSWER_KEY = path.join(ROOT, 'test-docs', 'synthetic', 'ANSWER_KEY.json');

/* ------------------------------------------------------------------ util */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function normName(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameTokens(s) {
  return new Set(normName(s).split(' ').filter(Boolean));
}
function nameRelated(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = nameTokens(a), tb = nameTokens(b);
  const subset = [...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t));
  if (subset) return true;
  return normalizeSurname(a) && normalizeSurname(a) === normalizeSurname(b);
}
function containsAny(haystack, needles) {
  const h = String(haystack ?? '').toLowerCase();
  return (needles ?? []).some((n) => h.includes(String(n).toLowerCase()));
}

/**
 * Analytics-question scoring: numbers must match EXACTLY, not by substring.
 * Plain `containsAny` would let an expected "5" pass against an actual
 * answer of "45" or "150" (both contain the substring "5") -- fine for a
 * lookup question's free text, wrong for a count that must be the literal
 * right number. Every purely-numeric expected value ("14") is checked as its
 * own whole number token in the answer text (so "14" matches "You have 14
 * customers" and "14 customers" alike, but not "114" or "40"); a non-numeric
 * expected value (a city/brand/customer name in a groupBy or list answer)
 * still falls back to plain substring containment, case-insensitive, same as
 * a lookup question. Only one entry in `expectedContains` needs to match.
 */
export function containsAnalyticsMatch(haystack, needles) {
  const text = String(haystack ?? '');
  const lower = text.toLowerCase();
  const numberTokens = text.match(/\d+/g) ?? [];
  return (needles ?? []).some((raw) => {
    const n = String(raw);
    if (/^\d+$/.test(n)) return numberTokens.includes(n);
    return lower.includes(n.toLowerCase());
  });
}

/* --------------------------------------------------------- customer match
 * Greedy best-match of answer-key customers to actual customer rows.
 * Scored (not just boolean) because two answer-key customers can share a
 * street (the apartment-complex trap) — address alone is not enough, name
 * relation disambiguates.
 */
function matchCustomers(expected, actualRows) {
  const actual = actualRows.map((r, i) => ({
    idx: i,
    id: r.id,
    name: r.name ?? r.data?.customer_name ?? null,
    address: r.serviceAddress ?? r.data?.service_address ?? null,
    phone: r.phone ?? r.data?.phone ?? null,
    email: r.email ?? r.data?.email ?? null,
    alerts: r.alerts ?? null,
    raw: r,
  }));
  const used = new Set();
  const matches = []; // {expectedKey, actualIdx|null, score}

  for (const exp of expected) {
    let best = null, bestScore = 0;
    for (const a of actual) {
      if (used.has(a.idx)) continue;
      const addrMatch = !!(exp.address && a.address && normalizeAddressKey(exp.address) === normalizeAddressKey(a.address));
      const phoneMatch = !!(exp.phone && a.phone && normalizePhoneKey(exp.phone) === normalizePhoneKey(a.phone));
      const emailMatch = !!(exp.email && a.email && normalizeEmailKey(exp.email) === normalizeEmailKey(a.email));
      const nameMatch = nameRelated(exp.canonicalName, a.name);
      let score = 0;
      if (addrMatch) score += 2;
      if (phoneMatch) score += 2;
      if (emailMatch) score += 2;
      if (nameMatch) score += 1;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best && bestScore >= 1) {
      used.add(best.idx);
      matches.push({ expectedKey: exp.key, actualIdx: best.idx, actual: best, score: bestScore });
    } else {
      matches.push({ expectedKey: exp.key, actualIdx: null, actual: null, score: 0 });
    }
  }
  const extraActual = actual.filter((a) => !used.has(a.idx));
  return { matches, extraActual };
}

/* --------------------------------------------------------------- scoring */
export function scoreCorpus({ answerKey, customersData, documentsData, scanData, asksData }) {
  const findings = [];
  const rank = (severity, msg, detail) => findings.push({ severity, msg, detail });

  const actualCustomerRows = customersData?.customers ?? customersData ?? [];
  const { matches, extraActual } = matchCustomers(answerKey.customers, actualCustomerRows);

  const missing = matches.filter((m) => m.actualIdx == null);
  for (const m of missing) rank('high', `Missing customer: ${m.expectedKey}`, { expectedKey: m.expectedKey });
  for (const extra of extraActual) rank('medium', `Unexpected extra customer: ${extra.name ?? extra.id}`, { actual: extra.name, id: extra.id });

  // Merge traps: two answer-key customers must NOT have matched the SAME actual row.
  const byExpectedKey = new Map(matches.map((m) => [m.expectedKey, m]));
  const mergeTrapResults = [];
  for (const [ka, kb] of answerKey.mustNotMerge ?? []) {
    const ma = byExpectedKey.get(ka), mb = byExpectedKey.get(kb);
    const merged = ma && mb && ma.actualIdx != null && ma.actualIdx === mb.actualIdx;
    mergeTrapResults.push({ pair: [ka, kb], merged });
    if (merged) rank('high', `Merge trap FAILED: "${ka}" and "${kb}" were merged into one customer`, { pair: [ka, kb] });
  }

  // "One customer, 3 name spellings" traps (the opposite of mustNotMerge): any
  // answer-key customer with more than one doc-name-variant should map to a
  // SINGLE actual customer, which matchCustomers already enforces implicitly
  // (one expected key -> one actualIdx). Nothing extra to check here beyond
  // "missing" above.

  // ---- document linkage -------------------------------------------------
  const allExpectedDocs = new Set([
    ...answerKey.customers.flatMap((c) => c.docs),
    ...(answerKey.docsWithoutCustomer ?? []),
  ]);
  const docsArray = documentsData?.documents ?? documentsData ?? [];
  const totalDocs = docsArray.length || allExpectedDocs.size;

  const unlinkedDocIds = new Set((scanData?.unlinkedDocuments ?? []).map((d) => d.documentId));
  // Match unlinked documents back to filenames when possible, so we can tell
  // "correctly left unlinked" (a docsWithoutCustomer file) from "should have
  // linked but didn't" (a real customer document).
  const docById = new Map(docsArray.map((d) => [d.id, d.original_filename ?? d.filename ?? d.id]));
  const unlinkedFilenames = [...unlinkedDocIds].map((id) => docById.get(id) ?? id);
  const wrongfullyUnlinked = unlinkedFilenames.filter((f) => !answerKey.docsWithoutCustomer?.includes(f));
  for (const f of wrongfullyUnlinked) rank('high', `Document not linked to any customer: ${f}`, { filename: f });

  const linkedDocsCount = Math.max(0, totalDocs - unlinkedFilenames.length);
  const pctDocsLinked = totalDocs ? (linkedDocsCount / totalDocs) * 100 : null;

  // Shop-only documents (letterhead address only, no customer name/address)
  // are correctly OUT of scope for isUnlinkedDocument entirely (see
  // integrity.js) — a perfect run never lists them in unlinkedDocuments at
  // all, so that list can't be used to detect this trap. The two real
  // signals are: (1) integrityScan's own dedicated detector,
  // suspectedShopAddresses, and (2) a customer record whose address IS the
  // shop's own address.
  const shopAddressLeak = (scanData?.suspectedShopAddresses ?? []).length > 0
    || actualCustomerRows.some((r) => {
      const addr = r.serviceAddress ?? r.data?.service_address;
      return addr && normalizeAddressKey(addr) === normalizeAddressKey(answerKey.shopAddress);
    });
  if (shopAddressLeak) {
    rank('high', 'Shop letterhead address leaked into a customer record', {
      suspectedShopAddresses: scanData?.suspectedShopAddresses ?? [],
    });
  }

  // ---- equipment/unit linkage --------------------------------------------
  const totalUnits = answerKey.customers.reduce((n, c) => n + c.units.length, 0);
  const unitsMissingCustomer = (scanData?.equipmentWithoutCustomer ?? []).length;
  const multiUnitUnderLinked = scanData?.multiUnitDocsUnderLinked ?? [];
  for (const m of multiUnitUnderLinked) rank('medium', `Multi-unit document under-linked: ${m.documentId}`, m);
  const pctUnitsLinked = totalUnits ? Math.max(0, ((totalUnits - unitsMissingCustomer) / totalUnits) * 100) : null;

  // ---- alerts -------------------------------------------------------------
  let alertsExpected = 0, alertsCorrect = 0;
  for (const c of answerKey.customers) {
    if (!c.expectedAlert) continue;
    alertsExpected++;
    const m = byExpectedKey.get(c.key);
    const alerts = m?.actual?.alerts ?? { expiring: 0, expired: 0 };
    const ok = c.expectedAlert === 'expiring' ? alerts.expiring > 0 : c.expectedAlert === 'expired' ? alerts.expired > 0 : false;
    if (ok) alertsCorrect++;
    else rank('high', `Alert not raised: ${c.key} expected "${c.expectedAlert}"`, { key: c.key, alerts });
  }

  // ---- ask accuracy ---------------------------------------------------------
  // A question tagged `type: 'analytics'` (Workstream B's business corpus)
  // is scored with the stricter exact-number matcher; anything else
  // (untagged, or `type: 'lookup'`) keeps the original substring matcher --
  // this is what makes this scorer backward-compatible with
  // test-docs/synthetic/ANSWER_KEY.json, which has no `type` field at all.
  const asks = asksData?.asks ?? asksData ?? [];
  const askByQ = new Map(asks.map((a) => [a.q, a]));
  let askCorrect = 0, askTotal = 0, fastCount = 0, fastTotal = 0;
  let analyticsTotal = 0, analyticsCorrect = 0, lookupTotal = 0, lookupCorrect = 0;
  for (const q of answerKey.questions ?? []) {
    askTotal++;
    const isAnalytics = q.type === 'analytics';
    const a = askByQ.get(q.q);
    if (!a) { rank('high', `No answer captured for question: "${q.q}"`, { q: q.q }); if (isAnalytics) analyticsTotal++; else lookupTotal++; continue; }
    const ok = isAnalytics ? containsAnalyticsMatch(a.answer, q.expectedContains) : containsAny(a.answer, q.expectedContains);
    if (isAnalytics) { analyticsTotal++; if (ok) analyticsCorrect++; }
    else if (q.type === 'lookup') { lookupTotal++; if (ok) lookupCorrect++; }
    if (ok) askCorrect++;
    else rank('high', `Wrong/missing answer${isAnalytics ? ' (analytics)' : ''}: "${q.q}"`, { q: q.q, got: a.answer, expectedContains: q.expectedContains });
    if (typeof a.fast === 'boolean') {
      fastTotal++;
      if (a.fast) fastCount++;
    }
  }
  const askAccuracyPct = askTotal ? (askCorrect / askTotal) * 100 : null;
  const fastPathHitRatePct = fastTotal ? (fastCount / fastTotal) * 100 : null;
  const analyticsAccuracyPct = analyticsTotal ? (analyticsCorrect / analyticsTotal) * 100 : null;
  const lookupAccuracyPct = lookupTotal ? (lookupCorrect / lookupTotal) * 100 : null;

  findings.sort((a, b) => (sevRank(b.severity) - sevRank(a.severity)));

  return {
    customers: { expected: answerKey.customers.length, actualMatched: matches.filter((m) => m.actualIdx != null).length, missing: missing.length, extra: extraActual.length },
    mergeTraps: mergeTrapResults,
    documents: { total: totalDocs, pctLinked: round1(pctDocsLinked), wrongfullyUnlinked: wrongfullyUnlinked.length },
    units: { total: totalUnits, pctLinked: round1(pctUnitsLinked), missingCustomer: unitsMissingCustomer },
    shopAddressLeak,
    alerts: { expected: alertsExpected, correct: alertsCorrect },
    asks: { total: askTotal, correct: askCorrect, accuracyPct: round1(askAccuracyPct) },
    analytics: { total: analyticsTotal, correct: analyticsCorrect, accuracyPct: round1(analyticsAccuracyPct) },
    lookups: { total: lookupTotal, correct: lookupCorrect, accuracyPct: round1(lookupAccuracyPct) },
    fastPath: { total: fastTotal, hits: fastCount, hitRatePct: round1(fastPathHitRatePct) },
    findings,
  };
}
function sevRank(s) { return s === 'high' ? 2 : s === 'medium' ? 1 : 0; }
function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }

/* --------------------------------------------------------------- printing */
export function printScorecard(score) {
  const lines = [];
  lines.push('=== Corpus Scorecard ===');
  lines.push(`Customers: ${score.customers.actualMatched}/${score.customers.expected} matched` +
    (score.customers.missing ? `, ${score.customers.missing} missing` : '') +
    (score.customers.extra ? `, ${score.customers.extra} extra` : ''));
  lines.push(`Merge traps: ${score.mergeTraps.filter((m) => !m.merged).length}/${score.mergeTraps.length} held` +
    (score.mergeTraps.some((m) => m.merged) ? ` — FAILED: ${score.mergeTraps.filter((m) => m.merged).map((m) => m.pair.join('+')).join(', ')}` : ''));
  lines.push(`Documents linked: ${score.documents.pctLinked ?? 'n/a'}% (${score.documents.total} total, ${score.documents.wrongfullyUnlinked} wrongly unlinked)`);
  lines.push(`Units linked: ${score.units.pctLinked ?? 'n/a'}% (${score.units.total} total, ${score.units.missingCustomer} missing customer)`);
  lines.push(`Shop address leak: ${score.shopAddressLeak ? 'YES' : 'no'}`);
  lines.push(`Warranty alerts correct: ${score.alerts.correct}/${score.alerts.expected}`);
  lines.push(`Ask accuracy: ${score.asks.correct}/${score.asks.total} (${score.asks.accuracyPct ?? 'n/a'}%)`);
  if (score.analytics.total) lines.push(`  - analytics: ${score.analytics.correct}/${score.analytics.total} (${score.analytics.accuracyPct ?? 'n/a'}%)`);
  if (score.lookups.total) lines.push(`  - lookups: ${score.lookups.correct}/${score.lookups.total} (${score.lookups.accuracyPct ?? 'n/a'}%)`);
  lines.push(`Fast-path hit rate: ${score.fastPath.hitRatePct ?? 'n/a'}%${score.fastPath.total ? '' : ' (no `fast` flag present in asks.json)'}`);
  lines.push('');
  lines.push(`Failures (${score.findings.length}), most severe first:`);
  for (const f of score.findings.slice(0, 50)) lines.push(`  [${f.severity}] ${f.msg}`);
  const text = lines.join('\n');
  console.log(text);
  return text;
}

/* ---------------------------------------------------------------- selftest
 * Builds a synthetic "perfect" snapshot straight from the answer key — every
 * customer resolved exactly as expected, every document and unit linked,
 * every question answered with a string containing its own expectedContains
 * terms — and scores it. Should print 100% across the board; this is the
 * regression test for score-corpus.mjs itself, not for the app.
 */
function buildPerfectSnapshot(answerKey) {
  const customers = answerKey.customers.map((c, i) => ({
    id: `cust-${i + 1}`,
    customerNumber: `C-${String(i + 1).padStart(5, '0')}`,
    name: c.canonicalName,
    serviceAddress: c.address,
    city: c.city,
    phone: c.phone ?? null,
    email: c.email ?? null,
    documentCount: c.docs.length,
    equipmentCount: c.units.length,
    alerts: { expiring: c.expectedAlert === 'expiring' ? 1 : 0, expired: c.expectedAlert === 'expired' ? 1 : 0 },
  }));

  let docSeq = 0;
  const documents = [];
  for (const c of answerKey.customers) {
    for (const f of c.docs) documents.push({ id: `doc-${++docSeq}`, original_filename: f, stage: 'verified' });
  }
  for (const f of answerKey.docsWithoutCustomer ?? []) documents.push({ id: `doc-${++docSeq}`, original_filename: f, stage: 'verified' });

  const scan = {
    unlinkedDocuments: [], // a perfect run leaves shop-only docs OUT of this list (see integrity.js's isUnlinkedDocument)
    equipmentWithoutCustomer: [],
    multiUnitDocsUnderLinked: [],
    orphanEquipment: [],
    suspectedShopAddresses: [],
    duplicateCustomers: [],
    counts: { duplicateCustomers: 0, unlinkedDocuments: 0, equipmentWithoutCustomer: 0, multiUnitDocsUnderLinked: 0, orphanEquipment: 0, suspectedShopAddresses: 0 },
  };

  const asks = (answerKey.questions ?? []).map((q) => ({ q: q.q, answer: q.expectedContains.join(' — '), fast: true }));

  return { customersData: { customers }, documentsData: { documents }, scanData: scan, asksData: { asks } };
}

/* ---------------------------------------------------------------------- cli */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') out.selftest = true;
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --key is an alias for --answerkey (either selects which ANSWER_KEY.json to
  // score against, e.g. --key test-docs/business/ANSWER_KEY.json).
  const keyArg = args.key ?? args.answerkey;
  const answerKeyPath = keyArg ? path.resolve(keyArg) : DEFAULT_ANSWER_KEY;
  const answerKey = readJson(answerKeyPath);

  if (args.selftest) {
    console.log('Running self-test: scoring ANSWER_KEY.json against a synthetic perfect snapshot...\n');
    const snapshot = buildPerfectSnapshot(answerKey);
    const score = scoreCorpus({ answerKey, ...snapshot });
    printScorecard(score);
    const perfect = score.customers.missing === 0 && score.customers.extra === 0
      && score.mergeTraps.every((m) => !m.merged)
      && score.documents.pctLinked === 100
      && score.units.pctLinked === 100
      && !score.shopAddressLeak
      && score.alerts.correct === score.alerts.expected
      && score.asks.accuracyPct === 100;
    console.log(`\nSelf-test: ${perfect ? 'PASS (100%)' : 'FAIL — see findings above'}`);
    process.exit(perfect ? 0 : 1);
  }

  const dir = args.dir ? path.resolve(args.dir) : process.cwd();
  const p = (name, flag) => (args[flag] ? path.resolve(args[flag]) : path.join(dir, name));
  const customersData = readJson(p('customers.json', 'customers'));
  const documentsData = readJson(p('documents.json', 'documents'));
  const scanData = readJson(p('scan.json', 'scan'));
  const asksData = readJson(p('asks.json', 'asks'));

  const score = scoreCorpus({ answerKey, customersData, documentsData, scanData, asksData });
  printScorecard(score);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });
