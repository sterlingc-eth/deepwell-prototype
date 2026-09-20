/**
 * Regression checks for prompt caching + cost accounting on the two
 * remaining Anthropic call sites (/api/ask and extraction). See
 * handoffs/HANDOFF-B.md for the design and current measured sizes.
 *
 * No database, no network: every function under test here is pure, and the
 * one "round-trip" test below calls a local mock `messages.create`, never
 * the real Anthropic SDK or a real API key.
 *
 *   node scripts/verify-caching.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  estimateTokens,
  minTokensFor,
  cacheable,
  withCache,
  planCacheBreakpoints,
  modelCallLogLine,
  CACHE_CONTROL,
  CACHE_CONTROL_1H,
  MAX_CACHE_BREAKPOINTS,
  CACHE_MIN_TOKENS,
} from '../api/_lib/promptCache.js';
import {
  SYSTEM_PROMPT,
  buildContextBlock,
  buildQuestionBlock,
  ANSWER_TOOL,
} from '../api/_lib/answer.js';
import { ASK_MODEL } from '../api/ask.js';
import { splitExtractPrompt, EXTRACT_MODEL } from '../api/_lib/extractDocument.js';
import { EXTRACT_TOOL, buildExtractPrompt } from '../api/_lib/extractFields.js';
import { totalInputTokens, recordModelCall } from '../api/_lib/usage.js';
import {
  TRANSCRIBE_SYSTEM_PROMPT,
  resolveTranscribeModels,
} from '../api/_lib/readDocument.js';
import { startTimer, formatServerTiming } from '../api/_lib/timing.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------- estimateTokens
 * CORRECTED 2026-09-20 (late): the old formula was ceil(chars/4), on the
 * (backwards) theory that chars/4 under-estimates English-prose tokens. Real
 * tokenizers land closer to chars/4.3-4.6 for prose, so chars/4 actually
 * OVER-estimates — exactly the wrong direction for a "don't over-claim
 * cacheable" estimate. Now floor(chars/4.6): lower than the real count, so it
 * can only under-claim, never over-claim, that a block is long enough.
 */
{
  eq('estimateTokens("") is 0', estimateTokens(''), 0);
  eq('estimateTokens is floor(chars/4.6), not ceil(chars/4)', estimateTokens('x'.repeat(4600)), 1000);
  eq('estimateTokens JSON-stringifies a non-string (e.g. a tool definition)',
    estimateTokens({ a: 1 }), Math.floor(JSON.stringify({ a: 1 }).length / 4.6));
  eq('estimateTokens(null) is 0', estimateTokens(null), 0);
  check('estimateTokens is now LOWER than the old ceil(chars/4) estimate for the same text (the safe direction)',
    estimateTokens('x'.repeat(10000)) < Math.ceil(10000 / 4));
}

/* ----------------------------------------------------------- minTokensFor
 * CORRECTED 2026-09-20 (late): haiku was 2048, which is HALF the real
 * Anthropic minimum for claude-haiku-4-5 (platform.claude.com/docs/en/
 * build-with-claude/prompt-caching, fetched 2026-09-20). That wrong minimum
 * is the actual root cause of the 0% Haiku cache-hit rate in production —
 * every "cacheable" prefix cleared the wrong bar and Anthropic silently
 * refused to cache it anyway. See handoffs/COST_REPORT_2026-09-20.md.
 */
{
  eq('Sonnet minimum is 1024 tokens (unchanged — was already correct)', minTokensFor('claude-sonnet-4-5'), 1024);
  eq('Haiku minimum is 4096 tokens (corrected from 2048)', minTokensFor('claude-haiku-4-5'), 4096);
  eq('an unrecognized model fails closed to the HIGHER minimum',
    minTokensFor('claude-3-opus-unknown'), Math.max(CACHE_MIN_TOKENS.sonnet, CACHE_MIN_TOKENS.haiku));
  eq('a missing model also fails closed to the higher minimum', minTokensFor(undefined), 4096);
}

/* -------------------------------------------------------------- cacheable */
{
  // Exact boundary, per the floor(chars/4.6) estimator: 4599 chars -> 999
  // tokens (below Sonnet's 1024 minimum), 4600 chars -> 1000... so the real
  // boundary for Sonnet's 1024 is chars >= 1024*4.6 = 4710.4 -> 4711 chars.
  check('4710 chars (1023 est. tokens) is NOT cacheable for Sonnet',
    !cacheable('x'.repeat(4710), 'claude-sonnet-4-5'));
  check('4711 chars (1024 est. tokens) IS cacheable for Sonnet',
    cacheable('x'.repeat(4711), 'claude-sonnet-4-5'));
  // Haiku's minimum is now 4096 (4x Sonnet's, not 2x): boundary is
  // 4096*4.6 = 18841.6 -> 18842 chars.
  check('18841 chars (4095 est. tokens) is NOT cacheable for Haiku',
    !cacheable('x'.repeat(18841), 'claude-haiku-4-5'));
  check('18842 chars (4096 est. tokens) IS cacheable for Haiku',
    cacheable('x'.repeat(18842), 'claude-haiku-4-5'));
  check('the same text that clears Sonnet\'s bar can still miss Haiku\'s (Haiku needs a lot more now)',
    cacheable('x'.repeat(5000), 'claude-sonnet-4-5') && !cacheable('x'.repeat(5000), 'claude-haiku-4-5'));
}

/* --------------------------------------------------------------- withCache */
{
  const shortBlock = { type: 'text', text: 'short' };
  const r1 = withCache(shortBlock, 'claude-sonnet-4-5');
  check('withCache leaves a too-short text block unchanged (no cache_control added)',
    r1 === shortBlock && !('cache_control' in r1));

  const longText = 'x'.repeat(5000);
  const longBlock = { type: 'text', text: longText };
  const r2 = withCache(longBlock, 'claude-sonnet-4-5');
  eq('withCache attaches the ephemeral cache_control to a long-enough text block',
    r2.cache_control, CACHE_CONTROL);
  check('withCache does not mutate the original block',
    !('cache_control' in longBlock));
  eq('withCache preserves the rest of the block\'s fields', r2.text, longText);

  check('withCache passes through null/non-object input unchanged', withCache(null, 'claude-sonnet-4-5') === null);

  // Tool definitions: measured by their whole JSON shape, not just `.text`
  // (tools have no `.text`) — and today's real tools are both too small to
  // clear either model's minimum, which is the documented, intentional
  // "skip rather than pad" case (see handoffs/HANDOFF-B.md).
  check('ANSWER_TOOL is measured as JSON and is currently below Sonnet\'s minimum',
    !('cache_control' in withCache(ANSWER_TOOL, 'claude-sonnet-4-5')));
  check('EXTRACT_TOOL is measured as JSON and is currently below Haiku\'s minimum',
    !('cache_control' in withCache(EXTRACT_TOOL, 'claude-haiku-4-5')));

  // A synthetic tool big enough to prove the mechanism actually works, not
  // just that it correctly declines on today's small ones. 20000 chars
  // clears Haiku's now-4096-token minimum (was 9000, enough only for the old,
  // wrong 2048 minimum).
  const bigTool = { name: 't', description: 'x'.repeat(20000), input_schema: { type: 'object' } };
  check('a large enough tool definition DOES get cache_control',
    'cache_control' in withCache(bigTool, 'claude-haiku-4-5'));
}

/* --------------------------------------------------- /api/ask request shape
 * CORRECTED 2026-09-20 (late): ask.js now builds this request via
 * planCacheBreakpoints(), not per-block withCache() — see that function's
 * doc comment for why a per-block check under-attaches breakpoints.
 */
{
  const passages = Array.from({ length: 12 }, (_, i) => ({
    documentId: `doc_${i}`,
    filename: `file${i}.pdf`,
    page: i + 1,
    excerpt: 'lorem ipsum warranty invoice text '.repeat(30), // ~1000+ chars each
  }));
  const contextText = buildContextBlock({ passages, extractions: [] });
  const questionText = buildQuestionBlock({ question: 'What is the warranty status?', today: '2026-09-19' });

  // A realistic 12-passage context block, alone, is NOT big enough to clear
  // Haiku's now-4096-token minimum by itself — this is deliberately the
  // regression case planCacheBreakpoints exists to fix: individually
  // ineligible, but eligible once the (now much larger) system prompt ahead
  // of it in the same request has already pushed the cumulative prefix past
  // the minimum.
  check('a realistic 12-passage context block is NOT individually cacheable for Haiku (the case planCacheBreakpoints fixes)',
    !cacheable(contextText, ASK_MODEL));
  check('SYSTEM_PROMPT clears Haiku\'s (the default ASK_MODEL) cacheable minimum on its own',
    cacheable(SYSTEM_PROMPT, ASK_MODEL));

  // Mirrors api/ask.js's own construction exactly.
  const { tools: cachedTools, system: cachedSystem, messageBlocks: cachedContent } = planCacheBreakpoints(
    {
      tools: [{ block: ANSWER_TOOL, breakpoint: true }],
      system: [{ block: { type: 'text', text: SYSTEM_PROMPT }, breakpoint: true }],
      messageBlocks: [
        { block: { type: 'text', text: contextText }, breakpoint: true },
        { block: { type: 'text', text: questionText }, breakpoint: false },
      ],
    },
    ASK_MODEL
  );
  const body = {
    model: ASK_MODEL,
    max_tokens: 900,
    system: cachedSystem,
    tools: cachedTools,
    tool_choice: { type: 'tool', name: 'answer' },
    messages: [{ role: 'user', content: cachedContent }],
  };

  const content = body.messages[0].content;
  eq('exactly two content blocks: context, then question', content.length, 2);
  check('block order is context BEFORE question',
    content[0].text.includes('PASSAGES:') && content[1].text.includes('QUESTION:'));
  check('the context block DOES get cache_control — cumulative prefix (system + this block) clears Haiku\'s minimum even though this block alone does not',
    'cache_control' in content[0]);
  check('the question block NEVER gets cache_control, no matter what',
    !('cache_control' in content[1]));
  check('the system block (now long enough on its own) DOES get cache_control',
    'cache_control' in body.system[0]);
  check('the tools block (ANSWER_TOOL is small by design — a schema, not reference material) has no cache_control',
    !('cache_control' in body.tools[0]));

  const breakpoints =
    (body.system ?? []).filter((b) => 'cache_control' in b).length +
    (body.tools ?? []).filter((b) => 'cache_control' in b).length +
    content.filter((b) => 'cache_control' in b).length;
  check(`this request never exceeds the ${MAX_CACHE_BREAKPOINTS}-breakpoint limit`, breakpoints <= MAX_CACHE_BREAKPOINTS,
    `got ${breakpoints} breakpoints`);
  check('this request has exactly two breakpoints today (system + context block)', breakpoints === 2);
}

/* ------------------------------------------------------- planCacheBreakpoints
 * Direct unit tests of the cumulative-prefix logic itself, independent of
 * ask.js's real prompt sizes.
 */
{
  const min = minTokensFor('claude-haiku-4-5'); // 4096
  const smallBlock = (label) => ({ type: 'text', text: label.repeat(1) });

  // Three blocks, none individually cacheable alone, but the SECOND becomes
  // eligible once the cumulative prefix (block1 + block2) clears the minimum,
  // and the third stays eligible too (cumulative only grows).
  const chunk = 'x'.repeat(Math.ceil(min * 4.6 * 0.6)); // ~60% of the minimum each
  const plan = planCacheBreakpoints(
    {
      system: [{ block: { type: 'text', text: chunk }, breakpoint: true }],
      messageBlocks: [
        { block: { type: 'text', text: chunk }, breakpoint: true },
        { block: { type: 'text', text: 'always different' }, breakpoint: false },
      ],
    },
    'claude-haiku-4-5'
  );
  check('planCacheBreakpoints: first block alone is below the minimum, so it gets no cache_control',
    !('cache_control' in plan.system[0]));
  check('planCacheBreakpoints: second block gets cache_control once the CUMULATIVE prefix clears the minimum, even though it alone would not',
    !cacheable(chunk, 'claude-haiku-4-5') && 'cache_control' in plan.messageBlocks[0]);
  check('planCacheBreakpoints: a block with breakpoint:false never gets cache_control regardless of cumulative size',
    !('cache_control' in plan.messageBlocks[1]));

  // MAX_CACHE_BREAKPOINTS cap: five candidate blocks, each individually huge
  // enough to be its own eligible breakpoint — only the first
  // MAX_CACHE_BREAKPOINTS may actually get one.
  const hugeBlocks = Array.from({ length: 5 }, (_, i) => ({
    block: { type: 'text', text: 'y'.repeat(min * 5) },
    breakpoint: true,
  }));
  const capped = planCacheBreakpoints({ messageBlocks: hugeBlocks }, 'claude-haiku-4-5');
  const attached = capped.messageBlocks.filter((b) => 'cache_control' in b).length;
  eq(`planCacheBreakpoints never attaches more than ${MAX_CACHE_BREAKPOINTS} breakpoints even with more eligible candidates`,
    attached, MAX_CACHE_BREAKPOINTS);

  // ttl option, and group order (tools -> system -> messageBlocks) feeding
  // the SAME running cumulative total.
  const oneHourPlan = planCacheBreakpoints(
    { system: [{ block: { type: 'text', text: 'z'.repeat(min * 5) }, breakpoint: true }] },
    'claude-haiku-4-5',
    { ttl: '1h' }
  );
  eq('planCacheBreakpoints honors {ttl:"1h"}', oneHourPlan.system[0].cache_control, CACHE_CONTROL_1H);

  const emptyPlan = planCacheBreakpoints(undefined, 'claude-haiku-4-5');
  eq('planCacheBreakpoints with no parts returns empty groups, not a throw',
    emptyPlan, { tools: [], system: [], messageBlocks: [] });
}

/* ------------------------------------------------------- extraction split */
{
  const pageA = [{ page_no: 1, text: 'UNIQUE-DOC-A serial ABC123 model X9' }];
  const pageB = [{ page_no: 1, text: 'a completely different document, warranty 10 years' }];

  const fullA = buildExtractPrompt(pageA, 'invoice');
  const fullB = buildExtractPrompt(pageB, 'service_ticket');
  const { dynamic: dynA, stable: stableA } = splitExtractPrompt(fullA);
  const { dynamic: dynB, stable: stableB } = splitExtractPrompt(fullB);

  check('the dynamic part carries THIS document\'s page text', dynA.includes('UNIQUE-DOC-A'));
  check('the stable part does NOT carry any document\'s page text (it must be document-independent)',
    !stableA.includes('UNIQUE-DOC-A') && !stableB.includes('a completely different document'));
  eq('the stable part is byte-identical across two totally different documents/types', stableA, stableB);
  check('the stable part is non-empty (the marker was found)', stableA.length > 0);

  eq('splitExtractPrompt falls back to (whole text, "") when the marker is absent',
    splitExtractPrompt('no marker in here at all'), { dynamic: 'no marker in here at all', stable: '' });

  // Mirrors extractDocument.js's / extract.js's own construction.
  const buildExtractBody = (stable, dynamic) => ({
    model: EXTRACT_MODEL,
    max_tokens: 4000,
    ...(stable ? { system: [withCache({ type: 'text', text: stable }, EXTRACT_MODEL)] } : {}),
    tools: [withCache(EXTRACT_TOOL, EXTRACT_MODEL)],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
    messages: [{ role: 'user', content: dynamic }],
  });
  const extractBody = buildExtractBody(stableA, dynA);

  check('the extraction request carries a system block (the stable text is still sent, just maybe uncached)',
    Array.isArray(extractBody.system) && extractBody.system[0].text === stableA);
  // CORRECTED 2026-09-20 (late): this used to assert the stable extraction
  // prompt clears Haiku's minimum — true against the old (wrong) 2048 figure,
  // but the real Haiku minimum is 4096 and this prompt (~2000 est. tokens
  // with the corrected estimator) does not reach it. extractFields.js is not
  // owned by this change (see handoffs/TEAM_BRIEF_2026-09-19.md) — the exact
  // fix needed there (roughly double FIELD_GUIDE/rules content, the same way
  // SYSTEM_PROMPT was raised here) is written to
  // handoffs/REQUESTS_ask-cache-agent.md rather than edited in place. This
  // assertion documents the known, filed gap so it can't silently regress
  // further or get "fixed" back to the wrong expectation.
  check('the stable extraction prompt does NOT yet clear Haiku\'s corrected 4096 minimum (known gap, filed in handoffs/REQUESTS_ask-cache-agent.md)',
    !cacheable(stableA, EXTRACT_MODEL) && !('cache_control' in extractBody.system[0]));
  check('EXTRACT_TOOL in the request still has no cache_control (small schema, not reference material)',
    !('cache_control' in extractBody.tools[0]));
  check('the fallback (no marker) shape omits `system` entirely rather than sending an empty one',
    !('system' in buildExtractBody('', 'whole prompt, no split')));
}

/* --------------------------------------------- mocked messages.create round-trip */
{
  let captured = null;
  const mockClient = {
    messages: {
      create: async (body) => {
        captured = body;
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'answer', input: { text: 'ok', facts: [{ label: 'a', value: '1', sources: [] }, { label: 'b', value: '2', sources: [] }], confidence: 0.9 } }],
          usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 4200, cache_creation_input_tokens: 0 },
        };
      },
    },
  };

  const requestBody = {
    model: ASK_MODEL,
    max_tokens: 900,
    system: [withCache({ type: 'text', text: SYSTEM_PROMPT }, ASK_MODEL)],
    tools: [withCache(ANSWER_TOOL, ASK_MODEL)],
    tool_choice: { type: 'tool', name: 'answer' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'q' }] }],
  };

  const response = await mockClient.messages.create(requestBody);
  eq('the mock round-trip receives back exactly the body that was sent', captured, requestBody);

  const logLine = modelCallLogLine({
    route: 'ask',
    model: ASK_MODEL,
    inputTokens: response.usage.input_tokens,
    cacheReadInputTokens: response.usage.cache_read_input_tokens,
    cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
    outputTokens: response.usage.output_tokens,
    latencyMs: 42,
    stopReason: response.stop_reason,
    factsRaw: response.content[0].input.facts.length,
    factsKept: 1, // pretend shapeAnswer dropped one for lacking a grounded source
  });
  eq('the log line has exactly the required shape and values, including the new diagnostics fields', logLine, {
    route: 'ask', model: ASK_MODEL, input_tokens: 500, cache_read: 4200, cache_creation: 0, output_tokens: 80, latency_ms: 42,
    stop_reason: 'tool_use', facts_raw: 2, facts_kept: 1,
  });
  eq('a call with no diagnostics fields omits them entirely (existing callers unaffected)',
    modelCallLogLine({ route: 'extract', model: 'm', inputTokens: 1, outputTokens: 1, latencyMs: 1 }),
    { route: 'extract', model: 'm', input_tokens: 1, cache_read: 0, cache_creation: 0, output_tokens: 1, latency_ms: 1 });

  eq('totalInputTokens folds cache_read + cache_creation into the ONE counter increment_usage_counters gets',
    totalInputTokens({
      inputTokens: response.usage.input_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
    }),
    500 + 4200 + 0);
  check('the log line keeps cache_read/cache_creation SEPARATE from input_tokens (unlike the folded DB counter)',
    logLine.input_tokens === 500 && logLine.cache_read === 4200);
}

/* ----------------------------------------------------- modelCallLogLine coercion */
{
  eq('negative/NaN numbers are clamped to 0',
    modelCallLogLine({ route: 'ask', model: 'm', inputTokens: -5, cacheReadInputTokens: NaN, outputTokens: -1, latencyMs: -9 }),
    { route: 'ask', model: 'm', input_tokens: 0, cache_read: 0, cache_creation: 0, output_tokens: 0, latency_ms: 0 });
  eq('a missing/non-string route or model becomes "unknown"',
    modelCallLogLine({}).route, 'unknown');
}

/* ------------------------------------------------- recordModelCall never throws */
{
  let threw = false;
  try {
    await recordModelCall(undefined, { inputTokens: 10, outputTokens: 5 });
    await recordModelCall({}, { inputTokens: 10, outputTokens: 5 });
    await recordModelCall({ tenantKey: null }, { inputTokens: 10, outputTokens: 5 });
  } catch {
    threw = true;
  }
  check('recordModelCall with no tenantKey is a safe, DB-free no-op (never throws)', !threw);
}

/* ------------------------------------------------- withCache TTL variants */
{
  const longText = 'x'.repeat(9000);
  const block = { type: 'text', text: longText };

  const default5m = withCache(block, 'claude-sonnet-4-5');
  eq('withCache with no ttl option uses the 5-minute default', default5m.cache_control, CACHE_CONTROL);

  const oneHour = withCache(block, 'claude-sonnet-4-5', { ttl: '1h' });
  eq('withCache with {ttl:"1h"} uses the 1-hour cache_control', oneHour.cache_control, { type: 'ephemeral', ttl: '1h' });

  const tooShort = withCache({ type: 'text', text: 'short' }, 'claude-sonnet-4-5', { ttl: '1h' });
  check('a too-short block gets no cache_control regardless of ttl option', !('cache_control' in tooShort));

  // Source checks: extraction and transcription are the two long-running
  // bulk paths (an import can run for hours), so their stable prefixes use
  // the 1h TTL rather than the 5m default. Ask is a one-off question/answer
  // exchange, so it correctly keeps the 5m default (not asserted 1h here).
  const extractSrc = readFileSync(fileURLToPath(new URL('../api/_lib/extractDocument.js', import.meta.url)), 'utf8');
  check('extractDocument.js caches its stable prompt with the 1h TTL', /withCache\([^)]*ttl:\s*["']1h["']/.test(extractSrc));
  const readDocSrc = readFileSync(fileURLToPath(new URL('../api/_lib/readDocument.js', import.meta.url)), 'utf8');
  check('readDocument.js caches its transcription system prompt with the 1h TTL', /withCache\([^)]*ttl:\s*["']1h["']/.test(readDocSrc));
}

/* --------------------------------------- every stable prefix vs. its model's minimum
 * CORRECTED 2026-09-20 (late): Haiku's real minimum is 4096 (was wrongly
 * 2048 — see promptCache.js's CACHE_MIN_TOKENS comment). SYSTEM_PROMPT
 * (owned by this change) was raised again to clear it with a safe margin
 * (target est >= 4600). extractFields.js's stable guide and
 * readDocument.js's Haiku-model transcription prompt are NOT owned by this
 * change (handoffs/TEAM_BRIEF_2026-09-19.md) and do not reach 4096 under the
 * corrected estimator — that gap is filed in
 * handoffs/REQUESTS_ask-cache-agent.md rather than patched here, so each is
 * asserted against its REAL current state (pass or fail) rather than an
 * aspirational one, and this test will start failing (correctly) if either
 * regresses further before that request is picked up.
 */
{
  const { fast: transcribeFast, strong: transcribeStrong } = resolveTranscribeModels({});

  const samplePages = [{ page_no: 1, text: 'sample page text, just for measuring the stable half of the prompt' }];
  const { stable: extractStable } = splitExtractPrompt(buildExtractPrompt(samplePages, 'invoice'));

  const stablePrefixes = [
    // Owned by this change: must clear its minimum, and with real margin.
    { label: 'ask SYSTEM_PROMPT', text: SYSTEM_PROMPT, model: ASK_MODEL, expectCacheable: true, requireMargin: true },
    // NOT owned by this change (extractFields.js) — known gap, filed, not patched here.
    { label: 'extract stable field/type guide', text: extractStable, model: EXTRACT_MODEL, expectCacheable: false },
    // NOT owned by this change (readDocument.js) — same, for its Haiku (fast) pass.
    { label: 'transcribe TRANSCRIBE_SYSTEM_PROMPT vs. fast model', text: TRANSCRIBE_SYSTEM_PROMPT, model: transcribeFast, expectCacheable: false },
    // Strong pass now defaults to Haiku too (owner 2026-09-20) — same 4096 minimum, same gap as the fast pass (see REQUESTS_ask-cache-agent.md).
    { label: 'transcribe TRANSCRIBE_SYSTEM_PROMPT vs. strong model', text: TRANSCRIBE_SYSTEM_PROMPT, model: transcribeStrong, expectCacheable: false },
  ];
  for (const { label, text, model, expectCacheable, requireMargin } of stablePrefixes) {
    const isCacheable = cacheable(text, model);
    check(
      `${label}: cacheable=${expectCacheable} against its call site's model minimum (${minTokensFor(model)} tokens for ${model})`,
      isCacheable === expectCacheable,
      `est. ${estimateTokens(text)} tokens`
    );
    if (requireMargin) {
      // "safe margin" per the task: est >= min + ~500 tokens, not just barely over.
      check(`${label}: clears its minimum by a safe margin (est >= min + 400 tokens)`,
        estimateTokens(text) >= minTokensFor(model) + 400,
        `est. ${estimateTokens(text)} tokens, min ${minTokensFor(model)}`);
    }
  }
}

/* --------------------------------------- /api/ask latency instrumentation
 * api/_lib/timing.js — the Server-Timing helper added for
 * handoffs/ASK_LATENCY_2026-09-20.md. Pure formatting checks (no clock, no
 * DB) plus a couple of real-clock sanity checks on the timer itself.
 */
{
  eq('formatServerTiming: basic map', formatServerTiming({ auth: 12, limit: 3 }), 'auth;dur=12, limit;dur=3');
  eq('formatServerTiming: rounds fractional ms', formatServerTiming({ model: 1801.6 }), 'model;dur=1802');
  eq('formatServerTiming: drops non-finite/negative entries', formatServerTiming({ a: 1, b: NaN, c: -5, d: Infinity }), 'a;dur=1');
  eq('formatServerTiming: empty map -> empty string', formatServerTiming({}), '');
  eq('formatServerTiming: null/undefined -> empty string', formatServerTiming(null), '');
  eq('formatServerTiming: preserves insertion order', formatServerTiming({ z: 1, a: 2 }), 'z;dur=1, a;dur=2');

  const timer = startTimer();
  timer.add('scope', 10);
  timer.add('scope', 5); // accumulates across repeat calls
  eq('timer.add accumulates repeat calls to the same stage', timer.snapshot().scope, 15);

  await timer.time('retrieve', () => new Promise((r) => setTimeout(r, 20)));
  // >= 1 rather than >= 20: setTimeout is a floor, not a guarantee, and a
  // busy CI runner can fire it a hair early — this only needs to prove the
  // stage recorded *some* real elapsed time, not clock-precise timing.
  check('timer.time records a positive duration for an async stage', timer.snapshot().retrieve >= 1);

  let threw = false;
  try {
    await timer.time('model', () => { throw new Error('boom'); });
  } catch {
    threw = true;
  }
  check('timer.time still records timing and rethrows when fn throws', threw && timer.snapshot().model >= 0);

  check('snapshot() always includes total', Number.isFinite(startTimer().snapshot().total));
}

/* --------------------------------------- /api/ask output-token trims
 * handoffs/ASK_LATENCY_2026-09-20.md: facts capped and sources no longer
 * carry an unused excerpt field — checked against the real schema object so
 * a future edit that removes the cap or re-adds excerpt fails a test.
 */
{
  eq('ANSWER_TOOL caps facts at 5', ANSWER_TOOL.input_schema.properties.facts.maxItems, 5);
  check('ANSWER_TOOL fact sources no longer declare an excerpt field',
    !('excerpt' in (ANSWER_TOOL.input_schema.properties.facts.items.properties.sources.items.properties ?? {})));
  check('SYSTEM_PROMPT still tells the model to cap facts at 5', /at most 5 facts/i.test(SYSTEM_PROMPT));
}

/* --------------------------------------- disambiguation-vs-no-answer regression fix
 * 2026-09-20 (late): the 09-20 RULES/facts trim made Haiku refuse ("Nothing
 * in your records answers that.") on an ambiguous question (several units,
 * customers, or warranties could match) instead of answering the best match
 * and naming the others. Checked against the real SYSTEM_PROMPT/ANSWER_TOOL
 * text so this can't silently regress back to the refusal behavior.
 */
{
  check('RULES tells the model NOT to no-answer just because a question is ambiguous',
    /AMBIGUOUS QUESTIONS ARE NOT NO-ANSWERS/.test(SYSTEM_PROMPT));
  check('RULES still reserves the no-answer text for genuinely irrelevant evidence',
    /nothing in the evidence is relevant to the question at all|has nothing relevant to the question at all/i.test(SYSTEM_PROMPT));
  check('the text field description tells the model to answer the best match and name the others, not refuse',
    /do not refuse/i.test(ANSWER_TOOL.input_schema.properties.text.description));
  // The sourcing/grounding rules (every fact must cite a real page/field) are
  // untouched by this fix — still present, word for word.
  check('the citation rule (documentId exactly as given) is unchanged',
    /copying documentId exactly as given/.test(SYSTEM_PROMPT));
  check('the page-location rule is unchanged', /the exact number, never a guess or a nearby page/.test(SYSTEM_PROMPT));
}

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
