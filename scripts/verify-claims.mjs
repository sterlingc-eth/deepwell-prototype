/**
 * Offline checks for the R11 claim-check module (api/_lib/claims/**), build spec item 3
 * (FActScore-style, deterministic). No DB, no model, no network — every check here either exercises the
 * pure split/check/policy functions directly or drives them with an in-memory fake `fetchSourceText`
 * (the same `(documentId, location) => Promise<string|null>` shape verify.js's real
 * createDbSourceFetcher returns, with an optional `.prefetch(sources)`).
 *
 *   node scripts/verify-claims.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Builds a fetchSourceText from a plain {docId: {page: text}} map, with a `.prefetch` that just
 *  records what it was asked to batch (so tests can assert the batching actually happened). */
function fakeFetcher(pages) {
  const calls = [];
  const fn = async (documentId, location) => {
    calls.push({ documentId, location });
    return pages?.[documentId]?.[location?.page] ?? null;
  };
  fn.calls = calls;
  fn.prefetchedSources = null;
  fn.prefetch = async (sources) => { fn.prefetchedSources = sources; };
  return fn;
}

const { splitSentences, extractClaims, splitIntoClaims } = await import('../api/_lib/claims/split.js');
const { checkClaims, deriveStatusSupport } = await import('../api/_lib/claims/check.js');
const { applyClaimPolicy } = await import('../api/_lib/claims/policy.js');
const { verifyAnswerClaims, checkAnswerClaimsSync, MAX_CLAIMS } = await import('../api/_lib/claims/index.js');
const { normalizeAmount, amountsEqual, boundedLevenshtein, namesMatch, amountTokenIn, wordTokenIn, fuzzyWordIn } = await import('../api/_lib/claims/normalize.js');
const { parseDateLoose, toIsoDate, datesEqual, daysBetween, deriveStatus } = await import('../api/_lib/claims/dates.js');

/* ================================================================== normalize.js (pure) */
{
  eq('normalizeAmount: strips $ and commas', normalizeAmount('$1,250.00'), 1250);
  eq('normalizeAmount: bare number', normalizeAmount('1250'), 1250);
  check('normalizeAmount: no digits -> null', normalizeAmount('abc') === null);
  check('amountsEqual: $1,250.00 == 1,250 == 1250', amountsEqual('$1,250.00', '1,250') && amountsEqual('1250', '1,250.00'));
  check('amountsEqual: $1,250 != $1,300', !amountsEqual('$1,250', '$1,300'));
  eq('boundedLevenshtein: identical strings', boundedLevenshtein('smith', 'smith', 2), 0);
  eq('boundedLevenshtein: one substitution', boundedLevenshtein('jonathan', 'jonathon', 2), 1);
  check('boundedLevenshtein: early-out beyond cap', boundedLevenshtein('abc', 'xyz', 1) > 1);
  check('namesMatch: exact', namesMatch('Smith', 'smith'));
  check('namesMatch: one-letter typo tolerated (<=8 chars)', namesMatch('Jonathan', 'Jonathon'));
  check('namesMatch: a different name is rejected', !namesMatch('Smith', 'Jones'));
  check('amountTokenIn: finds a differently-formatted amount', amountTokenIn('total balance due is 1250.00 as of today', '$1,250.00'));
  check('amountTokenIn: does not find an absent amount', !amountTokenIn('total balance due is 1250.00', '$1,300.00'));
  check('wordTokenIn: word-bounded match', wordTokenIn('the unit is expired now', 'expired'));
  check('wordTokenIn: no substring-only match', !wordTokenIn('unexpired coverage', 'expired'));
  check('fuzzyWordIn: tolerates a typo', fuzzyWordIn('serviced by jonathon smith yesterday', 'Jonathan'));
}

/* ================================================================== dates.js (pure) */
{
  eq('parseDateLoose: ISO', parseDateLoose('2027-03-15'), { y: 2027, m: 3, d: 15 });
  eq('parseDateLoose: US slash', parseDateLoose('3/15/2027'), { y: 2027, m: 3, d: 15 });
  eq('parseDateLoose: month name, comma', parseDateLoose('March 15, 2027'), { y: 2027, m: 3, d: 15 });
  eq('parseDateLoose: day month year', parseDateLoose('15 March 2027'), { y: 2027, m: 3, d: 15 });
  eq('toIsoDate', toIsoDate({ y: 2027, m: 3, d: 5 }), '2027-03-05');
  check('datesEqual: same day, three different formats', datesEqual('2027-03-15', '3/15/2027') && datesEqual('2027-03-15', 'March 15, 2027'));
  check('datesEqual: different days -> false', !datesEqual('2027-03-15', '2027-03-16'));
  eq('daysBetween', daysBetween('2026-01-01', '2026-01-11'), 10);
  eq('deriveStatus: warranty, expiry in the past -> expired', deriveStatus('warranty', '2025-01-01', '2026-09-25'), 'expired');
  eq('deriveStatus: warranty, expiry in the future -> active', deriveStatus('warranty', '2027-01-01', '2026-09-25'), 'active');
  eq('deriveStatus: invoice, due date in the past -> overdue', deriveStatus('invoice', '2026-01-01', '2026-09-25'), 'overdue');
  eq('deriveStatus: invoice, due date in the future -> current', deriveStatus('invoice', '2027-01-01', '2026-09-25'), 'current');
  check('deriveStatus: unparseable date -> null, never a guess', deriveStatus('warranty', 'whenever', '2026-09-25') === null);
}

/* ================================================================== split.js: sentence splitting */
{
  eq('splitSentences: two plain sentences', splitSentences('Unit is under warranty. Balance due is $0.'), ['Unit is under warranty.', 'Balance due is $0.']);
  eq('splitSentences: a decimal amount does not split the sentence', splitSentences('Balance due is $1,250.00 as of today.'), ['Balance due is $1,250.00 as of today.']);
  eq('splitSentences: empty text', splitSentences(''), []);
  eq('splitSentences: headline is sentence 0', splitSentences('13 customers have equipment under warranty. One is expiring soon.')[0], '13 customers have equipment under warranty.');
}

/* ================================================================== split.js: claim extraction */
{
  const claims = extractClaims('Balance due is $1,250.00 for invoice #4821.', { origin: 'text', sentenceIndex: 0, sources: [] });
  check('extractClaims: money claim found', claims.some((c) => c.kind === 'money' && c.value === 1250));
  check('extractClaims: money digits are not ALSO claimed as a bare number', claims.filter((c) => c.kind === 'number' && c.value === 1250).length === 0);

  const countClaims = extractClaims('14 customers have equipment under warranty.', { origin: 'headline', sentenceIndex: 0, sources: [] });
  check('extractClaims: count claim ("14 customers")', countClaims.some((c) => c.kind === 'count' && c.value === 14 && c.meta.noun === 'customers'));

  const dateClaims = extractClaims('Warranty expires: 2027-03-15', { origin: 'fact', factIndex: 0, sources: [] });
  check('extractClaims: date claim from a fact span', dateClaims.some((c) => c.kind === 'date' && c.value === '2027-03-15'));

  const statusClaims = extractClaims('Warranty status: Expired', { origin: 'fact', factIndex: 0, sources: [] });
  check('extractClaims: status claim (expired/warranty family)', statusClaims.some((c) => c.kind === 'status' && c.value === 'expired' && c.meta.family === 'warranty'));

  const overdueClaims = extractClaims('Payment status: Overdue', { origin: 'fact', factIndex: 0, sources: [] });
  check('extractClaims: status claim (overdue/invoice family)', overdueClaims.some((c) => c.kind === 'status' && c.value === 'overdue' && c.meta.family === 'invoice'));

  const nameClaims = extractClaims('Customer: Jonathan Smith', { origin: 'fact', factIndex: 0, sources: [], labelHint: 'Customer', rawValue: 'Jonathan Smith' });
  check('extractClaims: a name-labeled fact yields a name claim', nameClaims.some((c) => c.kind === 'name' && c.value === 'Jonathan Smith'));

  const yn = extractClaims('Yes, this unit is under warranty.', { origin: 'text', sentenceIndex: 0, sources: [] });
  check('extractClaims: leading Yes is its own claim', yn.some((c) => c.kind === 'yesno' && c.value === true));
  check('extractClaims: the status claim in the same sentence is still separately extracted', yn.some((c) => c.kind === 'status' && c.value === 'active'));
}

/* ================================================================== policy.js: applyClaimPolicy directly */
{
  const answer = { kind: 'answer', text: 'Sentence one. Sentence two.', facts: [] };
  const split = { claims: [], sentences: splitSentences(answer.text) };
  const fakeClaimA = { kind: 'number', raw: '1', origin: 'text', sentenceIndex: 0 };
  const fakeClaimB = { kind: 'number', raw: '2', origin: 'text', sentenceIndex: 1 };
  const results = [{ claim: fakeClaimA, supported: true, reason: 'source-match' }, { claim: fakeClaimB, supported: false, reason: 'source-mismatch' }];
  const { data, removedCount, claimCheck } = applyClaimPolicy(answer, split, results, { agentWritten: true });
  eq('applyClaimPolicy: only the sentence with the unsupported claim is dropped', data.text, 'Sentence one (one or more claims could not be confirmed and were left out).');
  eq('applyClaimPolicy: removedCount reflects the one dropped sentence', removedCount, 1);
  eq('applyClaimPolicy: rate is 1 unsupported / 2 checked', claimCheck.rate, 0.5);

  const flagOnly = applyClaimPolicy(answer, split, results, { agentWritten: false });
  eq('applyClaimPolicy: flag-only policy never touches text', flagOnly.data.text, answer.text);
}

/* ================================================================== check.js: numbers, supported + unsupported */
{
  const fetcher = fakeFetcher({ [DOC]: { 1: 'Rated at 45 amps continuous duty per the nameplate.' } });
  const answer = {
    kind: 'answer', text: 'The unit is rated correctly.',
    facts: [
      { label: 'Amperage', value: '45 amps', sources: [{ documentId: DOC, location: { page: 1 } }] },
      { label: 'Amperage', value: '99 amps', sources: [{ documentId: DOC, location: { page: 1 } }] },
    ],
  };
  const { claims } = splitIntoClaims(answer);
  const results = await checkClaims(claims, answer, { fetchSourceText: fetcher });
  const byFact = (i) => results.filter((r) => r.claim.factIndex === i);
  check('number claim: 45 amps IS on the cited page -> supported', byFact(0).every((r) => r.supported), JSON.stringify(byFact(0)));
  check('number claim: 99 amps is NOT on the cited page -> unsupported', byFact(1).some((r) => r.supported === false), JSON.stringify(byFact(1)));
}

/* ================================================================== check.js: money with $ and commas */
{
  const fetcher = fakeFetcher({ [DOC]: { 4: 'Total balance due is 1250.00 as of today.' } });
  const answerOk = { kind: 'answer', text: 'x', facts: [{ label: 'Balance due', value: '$1,250.00', sources: [{ documentId: DOC, location: { page: 4 } }] }] };
  const answerBad = { kind: 'answer', text: 'x', facts: [{ label: 'Balance due', value: '$1,300.00', sources: [{ documentId: DOC, location: { page: 4 } }] }] };
  const okRes = await checkClaims(splitIntoClaims(answerOk).claims, answerOk, { fetchSourceText: fetcher });
  const badRes = await checkClaims(splitIntoClaims(answerBad).claims, answerBad, { fetchSourceText: fetcher });
  check('money: $1,250.00 vs "1250.00" (no $, no comma) on the page -> supported', okRes.every((r) => r.supported), JSON.stringify(okRes));
  check('money: $1,300.00 vs a page that says 1250.00 -> unsupported', badRes.some((r) => r.supported === false), JSON.stringify(badRes));
}

/* ================================================================== check.js: dates in different formats */
{
  const fetcher = fakeFetcher({ [DOC]: { 2: 'The warranty on this unit expires March 15, 2027 per the manufacturer.' } });
  const answerOk = { kind: 'answer', text: 'x', facts: [{ label: 'Warranty expires', value: '2027-03-15', sources: [{ documentId: DOC, location: { page: 2 } }] }] };
  const answerBad = { kind: 'answer', text: 'x', facts: [{ label: 'Warranty expires', value: '2027-03-16', sources: [{ documentId: DOC, location: { page: 2 } }] }] };
  const okRes = await checkClaims(splitIntoClaims(answerOk).claims, answerOk, { fetchSourceText: fetcher });
  const badRes = await checkClaims(splitIntoClaims(answerBad).claims, answerBad, { fetchSourceText: fetcher });
  check('date: ISO claim matches a month-name-formatted source date -> supported', okRes.every((r) => r.supported), JSON.stringify(okRes));
  check('date: off-by-one-day claim vs the same source -> unsupported', badRes.some((r) => r.supported === false), JSON.stringify(badRes));
}

/* ================================================================== check.js: names with typos */
{
  const fetcher = fakeFetcher({ [DOC]: { 3: 'Service performed for Jonathon Smith at the Gilbert address.' }, [DOC2]: { 3: 'Service performed for Patricia Nguyen at the Mesa address.' } });
  const answerOk = { kind: 'answer', text: 'x', facts: [{ label: 'Customer', value: 'Jonathan Smith', sources: [{ documentId: DOC, location: { page: 3 } }] }] };
  const answerBad = { kind: 'answer', text: 'x', facts: [{ label: 'Customer', value: 'Jonathan Smith', sources: [{ documentId: DOC2, location: { page: 3 } }] }] };
  const okRes = await checkClaims(splitIntoClaims(answerOk).claims, answerOk, { fetchSourceText: fetcher });
  const badRes = await checkClaims(splitIntoClaims(answerBad).claims, answerBad, { fetchSourceText: fetcher });
  check('name: "Jonathan Smith" fuzzy-matches a page that says "Jonathon Smith" -> supported', okRes.every((r) => r.supported), JSON.stringify(okRes));
  check('name: "Jonathan Smith" vs a page about a different customer -> unsupported', badRes.some((r) => r.supported === false), JSON.stringify(badRes));
}

/* ================================================================== check.js: derived statuses (no DB needed) */
{
  const today = '2026-09-25';
  const expiredOk = { kind: 'answer', text: 'x', facts: [{ label: 'Warranty expires', value: '2025-01-01', sources: [] }, { label: 'Warranty status', value: 'Expired', sources: [] }] };
  const expiredBad = { kind: 'answer', text: 'x', facts: [{ label: 'Warranty expires', value: '2025-01-01', sources: [] }, { label: 'Warranty status', value: 'Active', sources: [] }] };
  const overdueOk = { kind: 'answer', text: 'x', facts: [{ label: 'Invoice due date', value: '2026-01-01', sources: [] }, { label: 'Payment status', value: 'Overdue', sources: [] }] };
  const resOk = await checkClaims(splitIntoClaims(expiredOk).claims, expiredOk, { today });
  const resBad = await checkClaims(splitIntoClaims(expiredBad).claims, expiredBad, { today });
  const resOverdue = await checkClaims(splitIntoClaims(overdueOk).claims, overdueOk, { today });
  check('status: expiry in the past + claimed "Expired" -> supported (derived-from-date, no DB)', resOk.some((r) => r.claim.kind === 'status' && r.supported && r.reason === 'derived-from-date'), JSON.stringify(resOk));
  check('status: expiry in the past + claimed "Active" -> unsupported (derived-mismatch)', resBad.some((r) => r.claim.kind === 'status' && r.supported === false && r.reason === 'derived-mismatch'), JSON.stringify(resBad));
  check('status: due date in the past + claimed "Overdue" -> supported (invoice family)', resOverdue.some((r) => r.claim.kind === 'status' && r.supported && r.reason === 'derived-from-date'), JSON.stringify(resOverdue));
  eq('deriveStatusSupport: exported directly for the sync (no-DB) hook', deriveStatusSupport(splitIntoClaims(expiredOk).claims.find((c) => c.kind === 'status'), splitIntoClaims(expiredOk).claims, today), true);
}

/* ================================================================== check.js + build spec item 5: count vs records mismatch */
{
  const mismatch = { kind: 'answer', text: '14 customers have equipment under warranty.', facts: [1, 2, 3].map((i) => ({ label: 'Customer', value: `c${i}` })), recordsTotal: 13, records: [1, 2, 3].map((i) => ({ type: 'customer', id: String(i), label: `c${i}` })) };
  const match = { kind: 'answer', text: '3 customers have equipment under warranty.', facts: [1, 2, 3].map((i) => ({ label: 'Customer', value: `c${i}` })), recordsTotal: 3, records: [1, 2, 3].map((i) => ({ type: 'customer', id: String(i), label: `c${i}` })) };
  const rMis = await checkClaims(splitIntoClaims(mismatch).claims, mismatch, {});
  const rMatch = await checkClaims(splitIntoClaims(match).claims, match, {});
  check('count: stated 14 vs recordsTotal 13 -> unsupported (records-mismatch), no DB call needed', rMis.some((r) => r.claim.kind === 'count' && r.supported === false && r.reason === 'records-mismatch'), JSON.stringify(rMis));
  check('count: stated 3 vs recordsTotal 3 -> supported (records-match)', rMatch.some((r) => r.claim.kind === 'count' && r.supported && r.reason === 'records-match'), JSON.stringify(rMatch));
}

/* ================================================================== policy.js + index.js: agent answer rewrite behavior */
{
  const fetcher = fakeFetcher({ [DOC]: { 1: 'The unit is under warranty through 2027.' } });
  const answer = {
    kind: 'answer',
    text: 'The unit is under warranty. It was serviced 14 times last year.',
    facts: [], sources: [{ documentId: DOC, location: { page: 1 } }],
  };
  const { data, claimCheck, removedCount } = await verifyAnswerClaims(structuredClone(answer), { fetchSourceText: fetcher, agentWritten: true });
  check('agent rewrite: the unsupported sentence ("serviced 14 times") is removed from `text`', !/14 times/.test(data.text), data.text);
  check('agent rewrite: the supported sentence ("under warranty") survives', /under warranty/.test(data.text), data.text);
  check('agent rewrite: a note is appended when something was left out', /could not be confirmed/.test(data.text), data.text);
  check('agent rewrite: removedCount > 0', removedCount > 0);
  check('agent rewrite: claimCheck is attached with policy "agent"', data.claimCheck?.policy === 'agent' && claimCheck.policy === 'agent');

  // Same input, deterministic (flag-only) policy: text must be BYTE-IDENTICAL, only claimCheck differs.
  const { data: detData } = await verifyAnswerClaims(structuredClone(answer), { fetchSourceText: fetcher, agentWritten: false });
  eq('deterministic policy: text is never rewritten, even with the same unsupported claim', detData.text, answer.text);
  check('deterministic policy: the claim is still flagged in claimCheck', detData.claimCheck.unsupported.length > 0, JSON.stringify(detData.claimCheck));
  eq('deterministic policy: removedSentences/removedFacts are always 0', [detData.claimCheck.removedSentences, detData.claimCheck.removedFacts], [0, 0]);

  // Every fact whose ALL sources are unsupported gets dropped for the agent policy.
  const factAnswer = {
    kind: 'answer', text: 'Details are below.',
    facts: [
      { label: 'Amperage', value: '99 amps', sources: [{ documentId: DOC, location: { page: 1 } }] }, // not on the page -> unsupported
      { label: 'Warranty', value: 'active', sources: [{ documentId: DOC, location: { page: 1 } }] }, // "warranty" appears -> supported
    ],
  };
  const { data: factOut } = await verifyAnswerClaims(structuredClone(factAnswer), { fetchSourceText: fetcher, agentWritten: true });
  eq('agent rewrite: an unsupported fact is dropped from `facts`', factOut.facts.map((f) => f.label), ['Warranty']);
}

/* ================================================================== no false removals on correct answers (precision over recall) */
{
  // A fully-supported answer: nothing should be touched.
  const fetcher = fakeFetcher({ [DOC]: { 1: 'Balance due is $500.00. Warranty is active through 2028.' } });
  const goodAnswer = { kind: 'answer', text: 'Balance due is $500.00. Warranty is active.', facts: [], sources: [{ documentId: DOC, location: { page: 1 } }] };
  const { data: goodOut, removedCount: goodRemoved } = await verifyAnswerClaims(structuredClone(goodAnswer), { fetchSourceText: fetcher, agentWritten: true });
  eq('precision over recall: a fully-supported answer is untouched', goodOut.text, goodAnswer.text);
  eq('precision over recall: nothing removed', goodRemoved, 0);

  // A claim with NO source to check (fetchSourceText returns null / no citation at all) must fail OPEN,
  // never be removed just because it could not be confirmed.
  const uncheckable = { kind: 'answer', text: 'Roughly 40 customers called in about this last year.', facts: [], sources: [] };
  const { data: uncheckedOut, removedCount: uncheckedRemoved } = await verifyAnswerClaims(structuredClone(uncheckable), { agentWritten: true });
  eq('precision over recall: an unsourced/uncheckable claim is kept, not removed', uncheckedOut.text, uncheckable.text);
  eq('precision over recall: removedCount is 0 when nothing could be confirmed either way', uncheckedRemoved, 0);

  // A DB error on fetch must also fail open (same rule verify.js documents).
  const throwing = async () => { throw new Error('boom'); };
  const flaky = { kind: 'answer', text: 'x', facts: [{ label: 'Amperage', value: '45 amps', sources: [{ documentId: DOC, location: { page: 9 } }] }] };
  const { data: flakyOut } = await verifyAnswerClaims(structuredClone(flaky), { fetchSourceText: throwing, agentWritten: true });
  eq('precision over recall: a source-fetch error fails open (fact kept)', flakyOut.facts.length, 1);
}

/* ================================================================== index.js: sync (no-DB) variant for the deterministic hook */
{
  const answer = { kind: 'answer', text: '3 customers have equipment under warranty.', facts: [1, 2, 3].map(() => ({ label: 'x', value: 'y' })), recordsTotal: 3 };
  const out = checkAnswerClaimsSync(structuredClone(answer), { today: '2026-09-25' });
  check('checkAnswerClaimsSync: matches the async count check with no DB handle at all', out.claimCheck.policy === 'deterministic' && out.claimCheck.unsupported.length === 0, JSON.stringify(out.claimCheck));
  eq('checkAnswerClaimsSync: never mutates text', out.text, answer.text);

  const mismatch = { kind: 'answer', text: '14 customers have equipment under warranty.', facts: [1, 2, 3].map(() => ({ label: 'x', value: 'y' })), recordsTotal: 3 };
  const out2 = checkAnswerClaimsSync(structuredClone(mismatch), {});
  check('checkAnswerClaimsSync: flags a count mismatch without any fetchSourceText', out2.claimCheck.unsupported.some((u) => u.kind === 'count'), JSON.stringify(out2.claimCheck));
  eq('checkAnswerClaimsSync: still flag-only (text untouched)', out2.text, mismatch.text);
}

/* ================================================================== index.js: prefetch is used, MAX_CLAIMS is respected */
{
  const fetcher = fakeFetcher({ [DOC]: { 1: 'ok' } });
  const answer = { kind: 'answer', text: 'x', facts: [{ label: 'Amperage', value: '45 amps', sources: [{ documentId: DOC, location: { page: 1 } }] }] };
  await verifyAnswerClaims(structuredClone(answer), { fetchSourceText: fetcher, agentWritten: false });
  check('verifyAnswerClaims: batches every claim source through .prefetch before checking any of them', Array.isArray(fetcher.prefetchedSources) && fetcher.prefetchedSources.length === 1, JSON.stringify(fetcher.prefetchedSources));

  const manyFacts = Array.from({ length: 80 }, (_, i) => ({ label: 'Amperage', value: `${i} amps`, sources: [] }));
  const bigAnswer = { kind: 'answer', text: 'x', facts: manyFacts };
  const { claimCheck } = await verifyAnswerClaims(bigAnswer, {});
  check('verifyAnswerClaims: MAX_CLAIMS bounds a pathological answer instead of checking everything', claimCheck.checked <= MAX_CLAIMS, claimCheck.checked);
}

/* ================================================================== structural: the agent-path hook is actually wired */
{
  const loopSrc = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'agent', 'loopV2.js'), 'utf8');
  check('loopV2.js imports verifyAnswerClaims from the claims module', /import\s*\{\s*verifyAnswerClaims\s*\}\s*from\s*"\.\.\/claims\/index\.js"/.test(loopSrc));
  check('loopV2.js calls verifyAnswerClaims with agentWritten: true (build spec item 3 policy)', /verifyAnswerClaims\(shaped\.data,\s*\{[^}]*agentWritten:\s*true/.test(loopSrc));
  check('loopV2.js runs the claim check BEFORE citeAgentData (so citations are computed on the final, post-removal answer)',
    loopSrc.indexOf('verifyAnswerClaims(shaped.data') < loopSrc.indexOf('citeAgentData({'));

  const citeCheckSrc = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'scorecard', 'citationCheck.js'), 'utf8');
  check('citationCheck.js: existing citationPrecision/claimSupportedByText/checkCitationPrecision are untouched (additive only)',
    /export function significantTokens/.test(citeCheckSrc) && /export function claimSupportedByText/.test(citeCheckSrc)
    && /export function citationPrecision/.test(citeCheckSrc) && /export async function checkCitationPrecision/.test(citeCheckSrc));
  check('citationCheck.js: adds claimPrecision/checkClaimPrecision additively', /export async function claimPrecision/.test(citeCheckSrc) && /export async function checkClaimPrecision/.test(citeCheckSrc));

  const askSrc = fs.readFileSync(path.join(ROOT, 'api', 'ask.js'), 'utf8');
  check('ask.js was NOT edited by this module (per R11_RULES.md ownership) — finalizeCitations call site is exactly as before', /try \{ finalizeCitations\(body\.data\); \}/.test(askSrc));
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
