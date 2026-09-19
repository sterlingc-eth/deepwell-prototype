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
  check('today\'s SYSTEM_PROMPT text does NOT clear Sonnet\'s minimum (documented in HANDOFF-B)',
    !cacheable(SYSTEM_PROMPT, ASK_MODEL));

  const content = body.messages[0].content;
  eq('exactly two content blocks: context, then question', content.length, 2);
  check('block order is context BEFORE question',
    content[0].text.includes('PASSAGES:') && content[1].text.includes('QUESTION:'));
  check('the context block (long enough) got cache_control',
    'cache_control' in content[0]);
  check('the question block NEVER gets cache_control, no matter what',
    !('cache_control' in content[1]));
  check('the system block (too short today) has no cache_control',
    !('cache_control' in body.system[0]));
  check('the tools block (too short today) has no cache_control',
    !('cache_control' in body.tools[0]));

  const breakpoints =
    (body.system ?? []).filter((b) => 'cache_control' in b).length +
    (body.tools ?? []).filter((b) => 'cache_control' in b).length +
    content.filter((b) => 'cache_control' in b).length;
  check(`this request never exceeds the ${MAX_CACHE_BREAKPOINTS}-breakpoint limit`, breakpoints <= MAX_CACHE_BREAKPOINTS,
    `got ${breakpoints} breakpoints`);
  check('this request has exactly one breakpoint today (the context block only)', breakpoints === 1);
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
  check('today\'s stable extraction prompt (~600 est. tokens) does NOT clear Haiku\'s 2048 minimum (documented in HANDOFF-B)',
    !cacheable(stableA, EXTRACT_MODEL) && !('cache_control' in extractBody.system[0]));
  check('EXTRACT_TOOL in the request also has no cache_control today, same reason',
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

/* ------------------------------------------------------------------ done */

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
