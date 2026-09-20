/**
 * Cost report: measures every STABLE prompt prefix this codebase sends to
 * Anthropic, using api/_lib/promptCache.js's own estimateTokens (no network,
 * no API key) — the same heuristic that decides whether a real call actually
 * gets a cache breakpoint. Run before/after a caching change to see the
 * effect in tokens, not just "should work".
 *
 *   node scripts/cost-report.mjs
 *
 * Output is also recorded in handoffs/COST_REPORT_2026-09-20.md.
 */
import { estimateTokens, minTokensFor, cacheable, CACHE_MIN_TOKENS } from '../api/_lib/promptCache.js';
import { SYSTEM_PROMPT as ASK_SYSTEM_PROMPT, ANSWER_TOOL, CONTEXT_TOKEN_BUDGET } from '../api/_lib/answer.js';
import { ASK_MODEL } from '../api/ask.js';
import { splitExtractPrompt, EXTRACT_MODEL } from '../api/_lib/extractDocument.js';
import { EXTRACT_TOOL, buildExtractPrompt } from '../api/_lib/extractFields.js';
import { TRANSCRIBE_SYSTEM_PROMPT, PDF_MAX_TOKENS, IMAGE_MAX_TOKENS, resolveTranscribeModels } from '../api/_lib/readDocument.js';

const { fast: TRANSCRIBE_FAST, strong: TRANSCRIBE_STRONG } = resolveTranscribeModels({});

function row(label, text, model, maxTokens) {
  const tokens = estimateTokens(text);
  const min = minTokensFor(model);
  const ok = cacheable(text, model);
  console.log(
    `${label.padEnd(38)} model=${model.padEnd(20)} est.tokens=${String(tokens).padStart(6)}  ` +
    `min=${String(min).padStart(4)}  cacheable=${ok ? 'YES' : 'no '}  max_tokens=${maxTokens}`
  );
  return { label, model, tokens, min, cacheable: ok, maxTokens };
}

console.log('=== Stable prompt prefixes vs. each model\'s cache minimum ===\n');
const results = [];

// ---- Ask ---------------------------------------------------------------
results.push(row('ask: SYSTEM_PROMPT', ASK_SYSTEM_PROMPT, ASK_MODEL, 700));
results.push(row('ask: ANSWER_TOOL', ANSWER_TOOL, ASK_MODEL, 700));

// ---- Extraction ----------------------------------------------------------
const samplePages = [{ page_no: 1, text: 'sample page text for measurement only' }];
const fullPrompt = buildExtractPrompt(samplePages, 'invoice');
const { stable: extractStable } = splitExtractPrompt(fullPrompt);
results.push(row('extract: stable field/type guide', extractStable, EXTRACT_MODEL, 4000));
results.push(row('extract: EXTRACT_TOOL', EXTRACT_TOOL, EXTRACT_MODEL, 4000));

// ---- Transcription ---------------------------------------------------------
results.push(row('transcribe: TRANSCRIBE_SYSTEM_PROMPT (fast)', TRANSCRIBE_SYSTEM_PROMPT, TRANSCRIBE_FAST, `${IMAGE_MAX_TOKENS}(img)/${PDF_MAX_TOKENS}(pdf)`));
results.push(row('transcribe: TRANSCRIBE_SYSTEM_PROMPT (strong)', TRANSCRIBE_SYSTEM_PROMPT, TRANSCRIBE_STRONG, `${IMAGE_MAX_TOKENS}(img)/${PDF_MAX_TOKENS}(pdf)`));

// ---- Reclassify (reviewStore.js — not exported as a named prompt today,
// so this measures it via a dynamic import of its module internals is not
// possible without exporting; reported from the known constant instead). ----
console.log('\n(reclassify: RECLASSIFY_SYSTEM_PROMPT is small by design — max_tokens 50,');
console.log(' capped to 20 calls/request, first 1500 chars of page text only. Not a');
console.log(' meaningful caching target; see api/_lib/reviewStore.js.)\n');

console.log(`\nAsk context token budget (post-cap): ${CONTEXT_TOKEN_BUDGET} tokens\n`);

const failing = results.filter((r) => !r.cacheable);
if (failing.length) {
  console.log(`${failing.length} prefix(es) still below their model's cache minimum:`);
  for (const f of failing) console.log(`  - ${f.label} (${f.tokens} < ${f.min})`);
} else {
  console.log('All stable prefixes above clear their model\'s cache minimum.');
}
