/**
 * Offline checks for the R13H1 sentence-citations module (api/_lib/citations/sentences.js) — build spec
 * item 1 (Anthropic Citations / Perplexity / NotebookLM pattern: every sentence shows which document
 * supports it). No DB, no model, no network — drives the pure functions directly and, for the
 * quote-extraction path, an in-memory fake `fetchSourceText` (same shape claims/check.js's tests use).
 *
 *   node scripts/verify-sentence-citations.mjs
 */
import { splitSentences } from '../api/_lib/claims/split.js';
import {
  computeSentenceCitations,
  attachSentenceCitationsSync,
  attachSentenceCitations,
  extractQuote,
  locateClaimInText,
} from '../api/_lib/citations/sentences.js';

let failures = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOT_UUID = 'doc-local-not-synced-yet';
const src = (documentId, page) => ({ documentId, location: page ? { page } : {} });

function fakeFetcher(pages) {
  const calls = [];
  const fn = async (documentId, location) => {
    calls.push({ documentId, location });
    return pages?.[documentId]?.[location?.page] ?? null;
  };
  fn.calls = calls;
  fn.prefetchCalls = 0;
  fn.prefetch = async (sources) => { fn.prefetchCalls++; fn.prefetchedSources = sources; };
  return fn;
}

/* ================================================================== sentence splitting (R13H1 fix) */
{
  eq('splitSentences: "Mr." does not end the sentence', splitSentences('Mr. Smith paid the invoice today.'), ['Mr. Smith paid the invoice today.']);
  eq('splitSentences: "No." (model reference) does not end the sentence',
    splitSentences('See Model No. 2000.5 for details. It was replaced last year.'),
    ['See Model No. 2000.5 for details.', 'It was replaced last year.']);
  eq('splitSentences: decimal money is never split', splitSentences('The balance is $1,240.50 as of today.'), ['The balance is $1,240.50 as of today.']);
  eq('splitSentences: two abbreviations, two real sentences',
    splitSentences('Dr. Lee approved the work order. The tech was Mr. Ortiz.'),
    ['Dr. Lee approved the work order.', 'The tech was Mr. Ortiz.']);
  eq('splitSentences: a bare initial ("J.") does not end the sentence',
    splitSentences('J. Smith signed the work order. It was witnessed by K. Lee.'),
    ['J. Smith signed the work order.', 'It was witnessed by K. Lee.']);
  eq('splitSentences: an ordinary number before a period still ends the sentence (no regression)',
    splitSentences('It found 14 customers. Next steps are up to you.'),
    ['It found 14 customers.', 'Next steps are up to you.']);
}

/* ================================================================== computeSentenceCitations (sync) */
{
  const answer = {
    kind: 'answer',
    text: "Dana Reyes has a $420.00 balance due on invoice 48219. The unit is still under warranty. Thanks for checking.",
    facts: [
      { label: 'Balance due', value: '$420.00', kind: 'money', sources: [src(DOC, 1)] },
      { label: 'Warranty status', value: 'Active', sources: [src(DOC2, 1)] },
    ],
    sources: [src(DOC, 1), src(DOC2, 1)],
  };
  const out = computeSentenceCitations(answer);
  check('computeSentenceCitations: one entry per sentence', out.length === 3, `got ${out.length}`);
  check('computeSentenceCitations: money sentence cross-matches the Balance due fact\'s OWN source',
    out[0].citations.length === 1 && out[0].citations[0].documentId === DOC, JSON.stringify(out[0]));
  check('computeSentenceCitations: cross-matched citation scores high (specific)', out[0].citations[0].score >= 0.8, String(out[0].citations[0].score));
  check('computeSentenceCitations: warranty sentence cross-matches the Warranty status fact',
    out[1].citations.length === 1 && out[1].citations[0].documentId === DOC2, JSON.stringify(out[1]));
  check('computeSentenceCitations: a pure connective sentence with 2+ candidate documents is left uncited',
    out[2].citations.length === 0 && out[2].supported === false, JSON.stringify(out[2]));
  check('computeSentenceCitations: supported === citations.length > 0', out[0].supported === true && out[1].supported === true, '');
  check('computeSentenceCitations: no quote is invented without source text', out.every((s) => s.citations.every((c) => c.quote === undefined)), '');
}

{
  // A single-document answer: even a connective sentence with no claim gets that one document — no
  // ambiguity to guess about.
  const answer = {
    kind: 'answer',
    text: 'The warranty on this furnace is active. It expires in 2029.',
    facts: [{ label: 'Warranty status', value: 'Active', sources: [src(DOC, 3)] }],
    sources: [src(DOC, 3)],
  };
  const out = computeSentenceCitations(answer);
  check('computeSentenceCitations: single-document fallback covers a connective sentence', out[1].citations.some((c) => c.documentId === DOC), JSON.stringify(out[1]));
  check('computeSentenceCitations: fallback citation is low-confidence, never claimed as specific', out[1].citations.every((c) => c.score <= 0.5), JSON.stringify(out[1]));
}

/* ================================================================== reviewer fix: same-value facts */
/* across DIFFERENT entities/documents must never be attributed to the wrong one (or guessed at all). */
{
  const DOC3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  // Two different customers, two different documents, the SAME fact value ("$100.00") — the sentence
  // itself names which customer it's talking about, so each should cite ONLY its own document.
  const answer = {
    kind: 'answer',
    text: 'Maria Lopez has a $100.00 balance due. Carlos Diaz also has a $100.00 balance due.',
    facts: [
      { label: 'Customer name', value: 'Maria Lopez', entityId: 'cust-a', sources: [src(DOC, 1)] },
      { label: 'Balance due', value: '$100.00', kind: 'money', entityId: 'cust-a', sources: [src(DOC, 1)] },
      { label: 'Customer name', value: 'Carlos Diaz', entityId: 'cust-b', sources: [src(DOC3, 1)] },
      { label: 'Balance due', value: '$100.00', kind: 'money', entityId: 'cust-b', sources: [src(DOC3, 1)] },
    ],
    sources: [src(DOC, 1), src(DOC3, 1)],
  };
  const out = computeSentenceCitations(answer);
  check(
    "disambiguation: a sentence naming Maria Lopez cites HER document, not Carlos's (same $ value)",
    out[0].citations.length === 1 && out[0].citations[0].documentId === DOC,
    JSON.stringify(out[0])
  );
  check(
    "disambiguation: a sentence naming Carlos Diaz cites HIS document, not Maria's (same $ value)",
    out[1].citations.length === 1 && out[1].citations[0].documentId === DOC3,
    JSON.stringify(out[1])
  );
}
{
  const DOC3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  // Same ambiguous value across two customers, but the sentence names NEITHER — must never guess.
  const answer = {
    kind: 'answer',
    text: 'Two customers each have a $100.00 balance due.',
    facts: [
      { label: 'Customer name', value: 'Maria Lopez', entityId: 'cust-a', sources: [src(DOC, 1)] },
      { label: 'Balance due', value: '$100.00', kind: 'money', entityId: 'cust-a', sources: [src(DOC, 1)] },
      { label: 'Customer name', value: 'Carlos Diaz', entityId: 'cust-b', sources: [src(DOC3, 1)] },
      { label: 'Balance due', value: '$100.00', kind: 'money', entityId: 'cust-b', sources: [src(DOC3, 1)] },
    ],
    sources: [src(DOC, 1), src(DOC3, 1)],
  };
  const out = computeSentenceCitations(answer);
  check(
    'disambiguation: ambiguous value across two customers with neither named → no citation, never a guess',
    out[0].citations.length === 0 && out[0].supported === false,
    JSON.stringify(out[0])
  );
}
{
  const DOC3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  // Pronoun-continuation: the SECOND sentence repeats an ambiguous "under warranty" claim and names no
  // one itself, but the sentence right before it does — the "nearest preceding sentence" fallback.
  const answer = {
    kind: 'answer',
    text: "Maria Lopez's furnace is under warranty. It has been under warranty since 2021.",
    facts: [
      { label: 'Customer name', value: 'Maria Lopez', entityId: 'cust-a', sources: [src(DOC, 1)] },
      { label: 'Warranty status', value: 'Active', entityId: 'cust-a', sources: [src(DOC, 1)] },
      { label: 'Customer name', value: 'Carlos Diaz', entityId: 'cust-b', sources: [src(DOC3, 2)] },
      { label: 'Warranty status', value: 'Active', entityId: 'cust-b', sources: [src(DOC3, 2)] },
    ],
    sources: [src(DOC, 1), src(DOC3, 2)],
  };
  const out = computeSentenceCitations(answer);
  check(
    'disambiguation: sentence 0 (names Maria directly) cites her document',
    out[0].citations.length === 1 && out[0].citations[0].documentId === DOC,
    JSON.stringify(out[0])
  );
  check(
    "disambiguation: sentence 1 (names no one) is resolved via sentence 0's name, not left ambiguous",
    out[1].citations.length === 1 && out[1].citations[0].documentId === DOC,
    JSON.stringify(out[1])
  );
}

{
  // Ambiguity: two documents, no claim in the connective sentence — never guess which one.
  const answer = {
    kind: 'answer',
    text: 'Two units are on file here. Model details are below.',
    facts: [
      { label: 'Model', value: 'Carrier XR16', sources: [src(DOC, 1)] },
      { label: 'Model', value: 'Trane XV18', sources: [src(DOC2, 1)] },
    ],
    sources: [src(DOC, 1), src(DOC2, 1)],
  };
  const out = computeSentenceCitations(answer);
  check('computeSentenceCitations: never invents a citation when 2+ documents are equally plausible', out[0].citations.length === 0 && out[1].citations.length === 0, JSON.stringify(out));
}

{
  // A source with a non-synced (non-UUID) document id must never be cited.
  const answer = {
    kind: 'answer',
    text: 'The balance due is $50.00.',
    facts: [{ label: 'Balance due', value: '$50.00', kind: 'money', sources: [src(NOT_UUID, 1)] }],
    sources: [src(NOT_UUID, 1)],
  };
  const out = computeSentenceCitations(answer);
  check('computeSentenceCitations: a non-UUID (unsynced) document id is never cited', out[0].citations.length === 0, JSON.stringify(out));
}

/* ================================================================== locateClaimInText / extractQuote */
{
  const text = 'Invoice 48219 total is $620.00, paid $200.00, balance due $420.00 as of Jun 2, 2025.';
  const moneyClaim = { kind: 'money', raw: '$420.00' };
  const loc = locateClaimInText(text, moneyClaim);
  check('locateClaimInText: finds the money token\'s real position', Array.isArray(loc) && text.slice(loc[0], loc[1]) === '$420.00', JSON.stringify(loc));
  const q = extractQuote(text, moneyClaim);
  check('extractQuote: returns a quote', typeof q === 'string' && q.length > 0, String(q));
  const stripped = q.replace(/^…/, '').replace(/…$/, '');
  check('extractQuote: the quote (ellipses aside) is a VERBATIM substring of the source', text.includes(stripped), `${JSON.stringify(stripped)} not in source`);
  check('extractQuote: caps at 200 chars (plus ellipses)', q.length <= 202, String(q.length));
  check('extractQuote: contains the actual claimed amount', q.includes('$420.00'), q);
}
{
  const text = 'Some long unrelated passage that never mentions the figure being asked about at all, page filler.';
  const q = extractQuote(text, { kind: 'money', raw: '$999.00' });
  check('extractQuote: undefined (never fabricated) when the claim is not actually in the text', q === undefined, String(q));
}
{
  const text = 'This furnace is under warranty until March 2029, per the registration on file.';
  const q = extractQuote(text, { kind: 'status', value: 'active' });
  check('extractQuote: status claim locates its synonymous phrase ("under warranty" for "active")', typeof q === 'string' && q.toLowerCase().includes('under warranty'), String(q));
}
{
  const text = 'Service was performed by Jonathon Smith on the outdoor condenser.';
  const q = extractQuote(text, { kind: 'name', value: 'Jonathan Smith', raw: 'Jonathan Smith' });
  check('extractQuote: name claim locates a fuzzy-matched word in the source', typeof q === 'string' && q.includes('Smith'), String(q));
}

/* ================================================================== attachSentenceCitationsSync */
{
  const answer = {
    kind: 'answer',
    text: 'The balance due is $75.00.',
    facts: [{ label: 'Balance due', value: '$75.00', kind: 'money', sources: [src(DOC, 1)] }],
    sources: [src(DOC, 1)],
  };
  attachSentenceCitationsSync(answer);
  check('attachSentenceCitationsSync: attaches .sentences', Array.isArray(answer.sentences) && answer.sentences.length === 1, JSON.stringify(answer.sentences));
  check('attachSentenceCitationsSync: attribution only, no quote (no DB in this path)', answer.sentences[0].citations.every((c) => c.quote === undefined), '');
  check('attachSentenceCitationsSync: additive — original fields untouched', answer.text === 'The balance due is $75.00.' && answer.facts.length === 1, '');

  const already = { kind: 'answer', text: 'x', facts: [], sources: [], sentences: [{ text: 'x', citations: [], supported: false }] };
  const before = already.sentences;
  attachSentenceCitationsSync(already);
  check('attachSentenceCitationsSync: idempotent — never overwrites an existing .sentences', already.sentences === before, '');

  const noAnswer = { kind: 'no-answer', text: 'Nothing on file.', facts: [], sources: [], closest: [] };
  attachSentenceCitationsSync(noAnswer);
  check('attachSentenceCitationsSync: a no-answer is left alone (nothing to cite)', noAnswer.sentences === undefined, '');
}

/* ================================================================== attachSentenceCitations (async, real quotes) */
{
  const answer = {
    kind: 'answer',
    text: 'The balance due is $420.00. The unit is under warranty.',
    facts: [
      { label: 'Balance due', value: '$420.00', kind: 'money', sources: [src(DOC, 1)] },
      { label: 'Warranty status', value: 'Active', sources: [src(DOC2, 4)] },
    ],
    sources: [src(DOC, 1), src(DOC2, 4)],
  };
  const fetcher = fakeFetcher({
    [DOC]: { 1: 'Invoice total $620.00, balance due $420.00 as of Jun 2, 2025.' },
    [DOC2]: { 4: 'This furnace is under warranty per the registration on file.' },
  });
  await attachSentenceCitations(answer, { fetchSourceText: fetcher });
  check('attachSentenceCitations: batches ONE prefetch call regardless of citation count', fetcher.prefetchCalls === 1, String(fetcher.prefetchCalls));
  check('attachSentenceCitations: real quote attached for the money sentence', answer.sentences[0].citations[0]?.quote?.includes('$420.00'), JSON.stringify(answer.sentences[0]));
  check('attachSentenceCitations: real quote attached for the warranty sentence', answer.sentences[1].citations[0]?.quote?.toLowerCase().includes('under warranty'), JSON.stringify(answer.sentences[1]));
  check('attachSentenceCitations: every quote is a verbatim substring of its own source text',
    answer.sentences.every((s) => s.citations.every((c) => {
      if (!c.quote) return true;
      const stripped = c.quote.replace(/^…/, '').replace(/…$/, '');
      const page = c.documentId === DOC ? 1 : 4;
      const source = fetcher.calls.find((call) => call.documentId === c.documentId && call.location?.page === page);
      return source && String((c.documentId === DOC ? 'Invoice total $620.00, balance due $420.00 as of Jun 2, 2025.' : 'This furnace is under warranty per the registration on file.')).includes(stripped);
    })), '');

  const noFetch = { kind: 'answer', text: 'The balance due is $10.00.', facts: [{ label: 'Balance due', value: '$10.00', kind: 'money', sources: [src(DOC, 1)] }], sources: [src(DOC, 1)] };
  await attachSentenceCitations(noFetch, {});
  check('attachSentenceCitations: falls back to attribution-only with no fetchSourceText given', Array.isArray(noFetch.sentences) && noFetch.sentences[0].citations.every((c) => c.quote === undefined), '');
}

/* ================================================================== latency */
{
  const bigFacts = Array.from({ length: 12 }, (_, i) => ({ label: `Fact ${i}`, value: `$${100 + i}.00`, kind: 'money', sources: [src(i % 2 ? DOC : DOC2, (i % 5) + 1)] }));
  const bigText = Array.from({ length: 12 }, (_, i) => `Item ${i} costs $${100 + i}.00 as billed.`).join(' ');
  const bigAnswer = { kind: 'answer', text: bigText, facts: bigFacts, sources: [src(DOC, 1), src(DOC2, 1)] };
  const iterations = 200;
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) computeSentenceCitations(bigAnswer);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6 / iterations;
  check(`latency: computeSentenceCitations averages <20ms on a 12-sentence/12-fact answer (got ${elapsedMs.toFixed(2)}ms)`, elapsedMs < 20, `${elapsedMs.toFixed(2)}ms`);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
