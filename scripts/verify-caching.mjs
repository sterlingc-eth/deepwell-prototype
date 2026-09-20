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
  modelCallLogLine,
  CACHE_CONTROL,
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

/* ---------------------------------------------------------- estimateTokens */
{
  eq('estimateTokens("") is 0', estimateTokens(''), 0);
  eq('estimateTokens is ceil(chars/4)', estimateTokens('x'.repeat(4093)), 1024);
  eq('estimateTokens JSON-stringifies a non-string (e.g. a tool definition)',
    estimateTokens({ a: 1 }), Math.ceil(JSON.stringify({ a: 1 }).length / 4));
  eq('estimateTokens(null) is 0', estimateTokens(null), 0);
}

/* ----------------------------------------------------------- minTokensFor */
{
  eq('Sonnet minimum is 1024 tokens', minTokensFor('claude-sonnet-4-5'), 1024);
  eq('Haiku minimum is 2048 tokens', minTokensFor('claude-haiku-4-5'), 2048);
  eq('an unrecognized model fails closed to the HIGHER minimum',
    minTokensFor('claude-3-opus-unknown'), Math.max(CACHE_MIN_TOKENS.sonnet, CACHE_MIN_TOKENS.haiku));
  eq('a missing model also fails closed to the higher minimum', minTokensFor(undefined), 2048);
}

/* -------------------------------------------------------------- cacheable */
{
  // Exact boundary, per the ~4 chars/token heuristic: 4092 chars -> 1023
  // tokens (below Sonnet's 1024 minimum), 4093 chars -> 1024 (at it).
  check('4092 chars (1023 est. tokens) is NOT cacheable for Sonnet',
    !cacheable('x'.repeat(4092), 'claude-sonnet-4-5'));
  check('4093 chars (1024 est. tokens) IS cacheable for Sonnet',
    cacheable('x'.repeat(4093), 'claude-sonnet-4-5'));
  // Haiku's minimum is double Sonnet's: 8188 chars -> 2047 tokens (below),
  // 8189 -> 2048 (at it).
  check('8188 chars (2047 est. tokens) is NOT cacheable for Haiku',
    !cacheable('x'.repeat(8188), 'claude-haiku-4-5'));
  check('8189 chars (2048 est. tokens) IS cacheable for Haiku',
    cacheable('x'.repeat(8189), 'claude-haiku-4-5'));
  check('the same text that clears Sonnet\'s bar can still miss Haiku\'s (Haiku needs more)',
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
  // just that it correctly declines on today's small ones.
  const bigTool = { name: 't', description: 'x'.repeat(9000), input_schema: { type: 'object' } };
  check('a large enough tool definition DOES get cache_control',
    'cache_control' in withCache(bigTool, 'claude-haiku-4-5'));
}

/* --------------------------------------------------- /api/ask request shape */
{
  const passages = Array.from({ length: 12 }, (_, i) => ({
    documentId: `doc_${i}`,
    filename: `file${i}.pdf`,
    page: i + 1,
    excerpt: 'lorem ipsum warranty invoice text '.repeat(30), // ~1000+ chars each
  }));
  const contextText = buildContextBlock({ passages, extractions: [] });
  const questionText = buildQuestionBlock({ question: 'What is the warranty status?', today: '2026-09-19' });

  // Mirrors api/ask.js's own construction exactly (system -> tools -> [context, question]).
  const body = {
    model: ASK_MODEL,
    max_tokens: 1500,
    system: [withCache({ type: 'text', text: SYSTEM_PROMPT }, ASK_MODEL)],
    tools: [withCache(ANSWER_TOOL, ASK_MODEL)],
    tool_choice: { type: 'tool', name: 'answer' },
    messages: [
      {
        role: 'user',
        content: [
          withCache({ type: 'text', text: contextText }, ASK_MODEL),
          { type: 'text', text: questionText },
        ],
      },
    ],
  };

  check('a realistic 12-passage context block clears Sonnet\'s cacheable minimum',
    cacheable(contextText, ASK_MODEL));
  // 2026-09-20 cost fix: SYSTEM_PROMPT now carries the HVAC glossary,
  // document-type guide, warranty-brand table and answer-style rules — real
  // reference content, not padding — specifically so it clears HAIKU's
  // (higher) 2048-token minimum, since ASK_MODEL defaults to Haiku. It clears
  // Sonnet's lower minimum too, trivially.
  check('SYSTEM_PROMPT now clears Haiku\'s (the default ASK_MODEL) cacheable minimum',
    cacheable(SYSTEM_PROMPT, ASK_MODEL));

  const content = body.messages[0].content;
  eq('exactly two content blocks: context, then question', content.length, 2);
  check('block order is context BEFORE question',
    content[0].text.includes('PASSAGES:') && content[1].text.includes('QUESTION:'));
  check('the context block (long enough) got cache_control',
    'cache_control' in content[0]);
  check('the question block NEVER gets cache_control, no matter what',
    !('cache_control' in content[1]));
  check('the system block (now long enough) DOES get cache_control',
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
  // 2026-09-20 cost fix: extractFields.js's FIELD_GUIDE now carries a worked
  // example per field (real guidance, not padding) specifically to clear
  // Haiku's 2048-token minimum, since EXTRACT_MODEL defaults to Haiku.
  check('today\'s stable extraction prompt now clears Haiku\'s 2048 minimum',
    cacheable(stableA, EXTRACT_MODEL) && 'cache_control' in extractBody.system[0]);
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
          content: [{ type: 'tool_use', name: 'answer', input: { text: 'ok', facts: [], confidence: 0.9 } }],
          usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 4200, cache_creation_input_tokens: 0 },
        };
      },
    },
  };

  const requestBody = {
    model: ASK_MODEL,
    max_tokens: 1500,
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
  });
  eq('the log line has exactly the required shape and values', logLine, {
    route: 'ask', model: ASK_MODEL, input_tokens: 500, cache_read: 4200, cache_creation: 0, output_tokens: 80, latency_ms: 42,
  });

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
 * 2026-09-20 cost fix: the whole point of raising these prefixes was to
 * clear the CACHING model's minimum (each may run under a different model —
 * Ask/Extract default to Haiku, transcription's fast pass also defaults to
 * Haiku but its escalation pass uses Sonnet). Checked here against the real,
 * exported constants so a future edit that shrinks one of these back below
 * threshold fails a test instead of silently losing its cache breakpoint.
 */
{
  const { fast: transcribeFast, strong: transcribeStrong } = resolveTranscribeModels({});

  const samplePages = [{ page_no: 1, text: 'sample page text, just for measuring the stable half of the prompt' }];
  const { stable: extractStable } = splitExtractPrompt(buildExtractPrompt(samplePages, 'invoice'));

  const stablePrefixes = [
    { label: 'ask SYSTEM_PROMPT', text: SYSTEM_PROMPT, model: ASK_MODEL },
    { label: 'extract stable field/type guide', text: extractStable, model: EXTRACT_MODEL },
    { label: 'transcribe TRANSCRIBE_SYSTEM_PROMPT vs. fast model', text: TRANSCRIBE_SYSTEM_PROMPT, model: transcribeFast },
    { label: 'transcribe TRANSCRIBE_SYSTEM_PROMPT vs. strong model', text: TRANSCRIBE_SYSTEM_PROMPT, model: transcribeStrong },
  ];
  for (const { label, text, model } of stablePrefixes) {
    check(`${label} clears its own call site's model minimum (${minTokensFor(model)} tokens for ${model})`,
      cacheable(text, model),
      `est. ${estimateTokens(text)} tokens`);
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

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
