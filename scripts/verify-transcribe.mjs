/**
 * Regression checks for hybrid transcription (Haiku first, escalate to Sonnet
 * only when the cheap read is not trustworthy) in api/_lib/readDocument.js.
 *
 * No database, no network. The one place real code would call the Anthropic
 * API — callTranscribe, inside extractWithClaude — goes through a test-only
 * factory seam (__setAnthropicClientFactoryForTests) so the escalation
 * control flow (which pages re-run, the merge, the budget skip, truncation
 * handling) can be exercised against a fake `messages.create` instead.
 *
 *   node scripts/verify-transcribe.mjs
 */
import {
  shouldEscalate,
  parseEscalateThreshold,
  resolveTranscribeModels,
  remainingBudgetMs,
  INGEST_BUDGET_MS,
  MIN_ESCALATION_BUDGET_MS,
  isTransientError,
  extractWithClaude,
  __setAnthropicClientFactoryForTests,
  TRANSCRIBE_SYSTEM_PROMPT,
  PDF_MAX_TOKENS,
  IMAGE_MAX_TOKENS,
} from '../api/_lib/readDocument.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* --------------------------------------------------- shouldEscalate: good page */
{
  const decisions = shouldEscalate(
    [{ page_no: 1, text: 'Compressor model CG-4021-A replaced on 2024-03-14. Total: $412.50', confidence: 0.97 }],
    0.75
  );
  eq('a clean, high-confidence page is not escalated', decisions.map((d) => d.escalate), [false]);
  eq('a page that is not escalated carries no reasons', decisions[0].reasons, []);
}

/* -------------------------------------------------- shouldEscalate: empty page */
// 2026-09-20 cost fix ("stop early on blank pages" — see
// handoffs/COST_REPORT_2026-09-20.md): a page the model reports empty AND is
// itself confident about is trusted — re-running a genuinely blank page
// through the strong model essentially never turns up text that isn't there.
// A page that came back empty but the model was UNSURE about (low or missing
// confidence) still gets escalated — that's the real "the model gave up" case
// this heuristic exists to catch.
{
  const confidentBlank = shouldEscalate([{ page_no: 2, text: '', confidence: 0.9 }], 0.75);
  check('a confidently-blank page (empty text, confidence above threshold) is NOT escalated',
    !confidentBlank[0].escalate);
  eq('a confidently-blank page carries no reasons', confidentBlank[0].reasons, []);

  const unsureEmpty = shouldEscalate([{ page_no: 2, text: '', confidence: 0.4 }], 0.75);
  check('an empty page the model was NOT confident about is still escalated', unsureEmpty[0].escalate);
  check('the empty-page reason is reported for the unsure case',
    unsureEmpty[0].reasons.some((r) => /almost no text/.test(r)));

  const noConfidence = shouldEscalate([{ page_no: 2, text: '' }], 0.75);
  check('an empty page with NO self-reported confidence is still escalated (fails safe, missing is not confident)',
    noConfidence[0].escalate);

  const whitespaceOnlyConfident = shouldEscalate([{ page_no: 3, text: '   \n\t  ', confidence: 0.9 }], 0.75);
  check('a confidently-blank whitespace-only page is also not escalated', !whitespaceOnlyConfident[0].escalate);

  const whitespaceOnlyUnsure = shouldEscalate([{ page_no: 3, text: '   \n\t  ', confidence: 0.5 }], 0.75);
  check('a whitespace-only page the model was unsure about is still escalated', whitespaceOnlyUnsure[0].escalate);
}

/* ------------------------------------------------- shouldEscalate: garbage page */
{
  const garbageText = '~`|<>[]{}^\\~`|<>[]{}^\\~`|<>[]{}^\\'.repeat(2);
  const decisions = shouldEscalate([{ page_no: 4, text: garbageText, confidence: 0.95 }], 0.75);
  check('a page dominated by non-alphanumeric characters is escalated despite high confidence', decisions[0].escalate);
  check('the garbage-ratio reason is reported', decisions[0].reasons.some((r) => /non-alphanumeric/.test(r)));

  const shortJunk = shouldEscalate([{ page_no: 5, text: '$$$', confidence: 0.95 }], 0.75);
  check('a short string is not judged on garbage ratio alone (avoids false positives on tiny pages)',
    !shortJunk[0].reasons.some((r) => /non-alphanumeric/.test(r)));
}

/* ---------------------------------------------- shouldEscalate: repeated runs */
{
  const repeatedText = 'Invoice total: $42.00 ' + '-'.repeat(15) + ' end of page';
  const decisions = shouldEscalate([{ page_no: 6, text: repeatedText, confidence: 0.9 }], 0.75);
  check('a long run of a repeated character is escalated', decisions[0].escalate);
  check('the repeated-run reason is reported', decisions[0].reasons.some((r) => /repeated character/.test(r)));

  const shortDashes = shouldEscalate([{ page_no: 7, text: 'Model: AB-1234 -- see below', confidence: 0.9 }], 0.75);
  check('a couple of ordinary dashes does not trip the repeated-run heuristic',
    !shortDashes[0].reasons.some((r) => /repeated character/.test(r)));
}

/* ------------------------------------------------- shouldEscalate: low self-score */
{
  const decisions = shouldEscalate(
    [{ page_no: 8, text: 'Handwritten note: pump replaced, ask Dave for the invoice number', confidence: 0.4 }],
    0.75
  );
  check('a page below the confidence threshold is escalated on that basis alone', decisions[0].escalate);
  check('the low-confidence reason names the score and threshold', decisions[0].reasons.some((r) => /0\.40/.test(r) && /0\.75/.test(r)));

  const atThreshold = shouldEscalate([{ page_no: 9, text: 'Clean legible text well past the length floor for garbage checks.', confidence: 0.75 }], 0.75);
  check('confidence exactly AT the threshold is not escalated on that basis (strictly-less-than)',
    !atThreshold[0].reasons.some((r) => /self-reported confidence/.test(r)));

  const missingScore = shouldEscalate([{ page_no: 10, text: 'Clean legible text with no confidence field supplied at all here.' }], 0.75);
  check('a missing confidence field is treated as "no signal", not escalated on that basis',
    !missingScore[0].reasons.some((r) => /self-reported confidence/.test(r)));
}

/* ------------------------------------------------------------- multiple pages */
{
  const decisions = shouldEscalate(
    [
      { page_no: 1, text: 'A perfectly normal page of transcribed text right here.', confidence: 0.9 },
      { page_no: 2, text: '', confidence: 0.4 }, // empty AND unsure -> still escalates
      { page_no: 3, text: 'Another fine page with plenty of legible words in it.', confidence: 0.3 },
    ],
    0.75
  );
  eq('shouldEscalate returns one decision per page, in order', decisions.map((d) => d.page_no), [1, 2, 3]);
  eq('only the bad pages are flagged', decisions.map((d) => d.escalate), [false, true, true]);
}

/* --------------------------------------------------------- threshold env parsing */
{
  eq('unset TRANSCRIBE_ESCALATE_BELOW falls back to 0.75', parseEscalateThreshold(undefined), 0.75);
  eq('an empty string falls back to 0.75', parseEscalateThreshold(''), 0.75);
  eq('a valid value in range is used as-is', parseEscalateThreshold('0.6'), 0.6);
  eq('0 is a valid (if extreme) threshold', parseEscalateThreshold('0'), 0);
  eq('1 is a valid (if extreme) threshold', parseEscalateThreshold('1'), 1);
  eq('a value above 1 falls back to the default', parseEscalateThreshold('1.5'), 0.75);
  eq('a negative value falls back to the default', parseEscalateThreshold('-0.2'), 0.75);
  eq('a non-numeric value falls back to the default', parseEscalateThreshold('not-a-number'), 0.75);
}

/* ------------------------------------------------------- legacy TRANSCRIBE_MODEL */
{
  const legacy = resolveTranscribeModels({ TRANSCRIBE_MODEL: 'claude-sonnet-4-5-legacy-pin' });
  check('a set TRANSCRIBE_MODEL forces a single model for both fast and strong', legacy.fast === legacy.strong && legacy.fast === 'claude-sonnet-4-5-legacy-pin');
  check('a set TRANSCRIBE_MODEL disables escalation', legacy.legacy === true);

  const hybrid = resolveTranscribeModels({});
  eq('with no env set, the fast model defaults to claude-haiku-4-5', hybrid.fast, 'claude-haiku-4-5');
  eq('with no env set, the strong model defaults to claude-haiku-4-5 (owner 2026-09-20: Haiku everywhere; Sonnet is opt-in via TRANSCRIBE_MODEL_STRONG)', hybrid.strong, 'claude-haiku-4-5');
  check('with no legacy var, escalation stays enabled', hybrid.legacy === false);

  const overridden = resolveTranscribeModels({ TRANSCRIBE_MODEL_FAST: 'fast-x', TRANSCRIBE_MODEL_STRONG: 'strong-y' });
  eq('TRANSCRIBE_MODEL_FAST/STRONG are honored when set', [overridden.fast, overridden.strong], ['fast-x', 'strong-y']);

  const legacyWins = resolveTranscribeModels({
    TRANSCRIBE_MODEL: 'pinned',
    TRANSCRIBE_MODEL_FAST: 'fast-x',
    TRANSCRIBE_MODEL_STRONG: 'strong-y',
  });
  check('TRANSCRIBE_MODEL wins even if the new vars are also set (nothing breaks for an existing pin)',
    legacyWins.fast === 'pinned' && legacyWins.strong === 'pinned' && legacyWins.legacy === true);
}

/* -------------------------------------------------------------- budget check logic */
{
  const now = 1_000_000;
  eq('remainingBudgetMs is the full budget right at start', remainingBudgetMs(now, now), INGEST_BUDGET_MS);
  eq('remainingBudgetMs decreases by elapsed time', remainingBudgetMs(now, now + 10_000), INGEST_BUDGET_MS - 10_000);
  check('remainingBudgetMs goes negative once the budget is blown, rather than clamping to 0 (callers compare, not display, this)',
    remainingBudgetMs(now, now + INGEST_BUDGET_MS + 5_000) < 0);

  const comfortable = remainingBudgetMs(now, now + 5_000);
  check('plenty of budget remaining clears the minimum escalation bar', comfortable >= MIN_ESCALATION_BUDGET_MS);

  const tight = remainingBudgetMs(now, now + (INGEST_BUDGET_MS - 1000));
  check('less than the minimum escalation budget correctly fails the bar', tight < MIN_ESCALATION_BUDGET_MS);
}

/* ---------------------------------------------- transient error classification */
{
  check('a 429 status is transient', isTransientError({ status: 429 }));
  check('a 529 status (Anthropic overloaded) is transient', isTransientError({ status: 529 }));
  check('an overloaded_error type with no numeric status is still transient', isTransientError({ type: 'overloaded_error' }));
  check('a rate_limit_error type with no numeric status is still transient', isTransientError({ type: 'rate_limit_error' }));
  check('an Anthropic-SDK-shaped nested error.error.type is also read', isTransientError({ error: { type: 'overloaded_error' } }));
  check('a 500 is transient', isTransientError({ status: 500 }));
  check('a 400 is not transient', !isTransientError({ status: 400 }));
  check('a 404 is not transient', !isTransientError({ status: 404 }));
  check('null/undefined is never transient', !isTransientError(null) && !isTransientError(undefined));
}

/* --------------------------------------- extractWithClaude: escalation end-to-end */
//
// Exercises the real control flow in readDocument.js with a fake Anthropic
// client — no network, no API key needed. Each fake call records what model
// and page filter it was asked for, so the assertions can check exactly what
// extractWithClaude decided to do.
function fakeToolResponse(pages, { stopReason = 'tool_use', usage = { input_tokens: 100, output_tokens: 50 } } = {}) {
  return {
    stop_reason: stopReason,
    usage,
    content: [{ type: 'tool_use', name: 'pages', input: { pages } }],
  };
}

async function withFakeClient(handler, fn) {
  const calls = [];
  __setAnthropicClientFactoryForTests((timeoutMs) => ({
    messages: {
      create: async (req) => {
        calls.push({
          timeoutMs,
          model: req.model,
          text: req.messages[0].content[1].text,
          maxTokens: req.max_tokens,
          system: req.system,
        });
        return handler(req, calls.length);
      },
    },
  }));
  try {
    return { result: await fn(), calls };
  } finally {
    __setAnthropicClientFactoryForTests(null);
  }
}

{
  process.env.TRANSCRIBE_MODEL_FAST = 'test-fast';
  process.env.TRANSCRIBE_MODEL_STRONG = 'test-strong';
  delete process.env.TRANSCRIBE_MODEL;
  delete process.env.TRANSCRIBE_ESCALATE_BELOW;

  const { result, calls } = await withFakeClient((req, callNumber) => {
    if (callNumber === 1) {
      return fakeToolResponse([
        { page_no: 1, text: 'A clean legible page transcribed with no trouble at all.', confidence: 0.95 },
        { page_no: 2, text: '', confidence: 0.4 }, // empty AND unsure -> still escalates
      ]);
    }
    return fakeToolResponse([{ page_no: 2, text: 'Recovered text from the strong model pass.', confidence: 0.92 }]);
  }, () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now()));

  eq('two calls happen: one fast pass, one strong escalation for the bad page', calls.map((c) => c.model), ['test-fast', 'test-strong']);
  check('the escalation call asks only for the failing page number', /page\(s\) 2\b/.test(calls[1].text));
  const byPage = Object.fromEntries(result.map((p) => [p.page_no, p]));
  eq('the good page keeps the fast model\'s text and model tag', [byPage[1].text, byPage[1].model], ['A clean legible page transcribed with no trouble at all.', 'test-fast']);
  eq('the escalated page is replaced with the strong model\'s text and model tag', [byPage[2].text, byPage[2].model], ['Recovered text from the strong model pass.', 'test-strong']);
}

{
  // No page trips a heuristic -> exactly one call, no escalation.
  const { result, calls } = await withFakeClient(
    () => fakeToolResponse([{ page_no: 1, text: 'Everything on this page reads perfectly clearly end to end.', confidence: 0.98 }]),
    () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now())
  );
  eq('a fully clean document makes exactly one call', calls.length, 1);
  eq('that one call used the fast model', calls[0].model, 'test-fast');
  eq('the result is the fast pass unchanged', result[0].text, 'Everything on this page reads perfectly clearly end to end.');
}

{
  // TRANSCRIBE_MODEL set -> legacy mode -> exactly one call even with a bad page.
  process.env.TRANSCRIBE_MODEL = 'legacy-pin';
  const { result, calls } = await withFakeClient(
    () => fakeToolResponse([{ page_no: 1, text: '', confidence: 0.1 }]),
    () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now())
  );
  eq('legacy TRANSCRIBE_MODEL makes exactly one call even for a page that would otherwise escalate', calls.length, 1);
  eq('the single legacy call uses TRANSCRIBE_MODEL', calls[0].model, 'legacy-pin');
  eq('the legacy result is returned as-is, unescalated', result[0].text, '');
  delete process.env.TRANSCRIBE_MODEL;
}

{
  // Budget too tight -> escalation is skipped, fast result ships. Confidence
  // 0.4 (not 0.9): this page must actually WANT to escalate so the test
  // exercises the budget check, not the confidently-blank skip.
  const { result, calls } = await withFakeClient(
    () => fakeToolResponse([{ page_no: 1, text: '', confidence: 0.4 }]),
    () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now() - (INGEST_BUDGET_MS - 1000))
  );
  eq('escalation is skipped when the ingest budget is nearly spent, so only the fast call happens', calls.length, 1);
  eq('the fast result ships even though it would otherwise have escalated', result[0].text, '');
}

{
  // Escalation call throws -> degrade to the fast result rather than failing.
  // Confidence 0.4 so this page actually attempts escalation.
  let n = 0;
  const { result, calls } = await withFakeClient(
    () => {
      n++;
      if (n === 1) return fakeToolResponse([{ page_no: 1, text: '', confidence: 0.4 }]);
      throw Object.assign(new Error('overloaded'), { status: 529 });
    },
    () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now())
  );
  eq('a failed escalation call still leaves two calls attempted', calls.length, 2);
  eq('the fast result is kept when the escalation call itself fails', result[0].text, '');
}

{
  // A model call that returns zero pages (blank file, image with nothing
  // legible on it) must NOT throw — that's now ingestDocument's job to
  // classify as a terminal "no readable text" state via hasReadableText,
  // not callTranscribe's job to reject outright. Previously this threw a
  // plain Error (not an IngestError), which queue.js's fatal() would then
  // treat as retryable — wasting retries on a file that will never produce
  // different pages.
  const { result, calls } = await withFakeClient(
    () => fakeToolResponse([]),
    () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now())
  );
  eq('a zero-page model response does not throw, and ships as an empty array', result, []);
  eq('only the one fast call is made for an empty document (nothing to escalate)', calls.length, 1);
}

/* --------------------------------------------- image vs. PDF max_tokens cap */
// Cost cut (2026-09-20): a PDF call can legitimately return many pages of
// text in one response, so it keeps the full ceiling. A single image call is
// always exactly one page (a nameplate photo, a one-page work order), so it
// gets a lower one — see readDocument.js's callTranscribe.
{
  const { calls: pdfCalls } = await withFakeClient(
    () => fakeToolResponse([{ page_no: 1, text: 'A clean PDF page.', confidence: 0.98 }]),
    () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now())
  );
  eq('a PDF call uses the full PDF max_tokens ceiling', pdfCalls[0].maxTokens, PDF_MAX_TOKENS);

  const { calls: imageCalls } = await withFakeClient(
    () => fakeToolResponse([{ page_no: 1, text: 'A clean nameplate photo.', confidence: 0.98 }]),
    () => extractWithClaude(Buffer.from('fake-image-bytes'), 'image/jpeg', {}, Date.now())
  );
  eq('a single-image call uses the lower image max_tokens ceiling', imageCalls[0].maxTokens, IMAGE_MAX_TOKENS);
  check('the PDF ceiling is higher than the image ceiling', PDF_MAX_TOKENS > IMAGE_MAX_TOKENS);
}

/* ------------------------------------------- transcription system prompt */
{
  const { calls } = await withFakeClient(
    () => fakeToolResponse([{ page_no: 1, text: 'Clean page.', confidence: 0.98 }]),
    () => extractWithClaude(Buffer.from('%PDF-fake'), 'application/pdf', {}, Date.now())
  );
  check('every transcription call carries the shared system prompt',
    calls[0].system?.[0]?.text === TRANSCRIBE_SYSTEM_PROMPT);
  // CORRECTED 2026-09-20 (late, out-of-scope collateral fix — see
  // handoffs/COST_REPORT_2026-09-20.md "Correction" and
  // handoffs/REQUESTS_ask-cache-agent.md): api/_lib/promptCache.js's Haiku
  // minimum was wrong (2048, corrected to the real 4096) and its
  // estimateTokens formula was backwards for English prose (corrected
  // ceil(chars/4) -> floor(chars/4.6)). Under the CORRECT minimum,
  // TRANSCRIBE_SYSTEM_PROMPT (a Haiku-model call here, by default) no longer
  // clears it — this was never really cacheable in production, the old test
  // just encoded the same wrong minimum the production bug did. Raising
  // TRANSCRIBE_SYSTEM_PROMPT's content is readDocument.js's call, not this
  // agent's (see the request filed above) — this assertion now checks the
  // real, current state instead of the stale expectation, so it can't mask
  // the gap or silently regress further before that request is picked up.
  check('the system prompt does NOT yet clear Haiku\'s corrected 4096-token cache minimum (known gap, filed in handoffs/REQUESTS_ask-cache-agent.md)',
    !('cache_control' in (calls[0].system?.[0] ?? {})));
}

delete process.env.TRANSCRIBE_MODEL_FAST;
delete process.env.TRANSCRIBE_MODEL_STRONG;

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');

/* ---------------------------------------------------------- whitespace */
// Regression: the control-char scrubber once had its escapes mangled into a
// literal " -" range and deleted every space, comma, hyphen and "$" from
// transcribed text. Printable characters must survive; only C0/DEL go.
{
  const { __stripControlCharsForTests: strip } = await import('../api/_lib/readDocument.js');
  if (typeof strip === 'function') {
    const kept = 'Bill to: Margaret Henderson, 3247 Elm St — TOTAL DUE $9,127.00 (S/N 4N2119-08772)';
    check('printable text (spaces, commas, hyphens, $) survives the control-char scrub', strip(kept) === kept, strip(kept));
    check('C0 control characters and DEL are removed', strip('a\u0000b\u0007c\u001Fd\u007Fe') === 'abcde');
    check('newlines and tabs survive (page layout matters for headline excerpts)', strip('a\nb\tc') === 'a\nb\tc');
  } else {
    check('readDocument exports __stripControlCharsForTests', false, 'missing export');
  }
}
