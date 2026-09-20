/**
 * Anthropic prompt-caching helpers, shared by /api/ask and
 * /api/_lib/extractDocument.js (+ /api/extract.js's inline image path).
 *
 * NEW FILE, not in agent B's originally-listed ownership (api/ask.js,
 * api/_lib/answer.js, api/_lib/extractDocument.js, api/extract.js) — added
 * because both call sites need the exact same minimum-length decision and a
 * third copy of it was the wrong way to keep that true. It is not a
 * serverless function (nothing directly under /api), so it does not count
 * against the 12-function Hobby ceiling. See handoffs/HANDOFF-B.md.
 *
 * Why this exists as pure functions rather than inline `if` checks at each
 * call site: scripts/verify-caching.mjs asserts the exact breakpoint
 * placement and the minimum-length rule with no network and no SDK call, and
 * that's only possible if the decision is a pure function of (text, model).
 */

/** The only cache type Anthropic supports today. Default TTL is 5 minutes. */
export const CACHE_CONTROL = { type: "ephemeral" };

/** 1-hour TTL variant — for a stable prefix reused across a long bulk run
 * (extraction, transcription during a multi-hour import) where the default
 * 5-minute window would expire between documents. Costs more per cache
 * WRITE (Anthropic bills a 1h write higher than a 5m write) but that is paid
 * once per hour, not once per document — a clear win once a prefix is reused
 * more than a couple of times inside that hour, which a bulk import always is. */
export const CACHE_CONTROL_1H = { type: "ephemeral", ttl: "1h" };

/** At most 4 cache breakpoints per request — an Anthropic API hard limit. */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Minimum cacheable prompt length, in tokens, per model family. Below this,
 * Anthropic will not cache the block at all — attaching cache_control to a
 * too-short block wastes a breakpoint (the 4-per-request budget) for zero
 * benefit, so callers must not do it.
 *
 * CORRECTED 2026-09-20 (late): haiku was 2048. Per the current Anthropic docs
 * (platform.claude.com/docs/en/build-with-claude/prompt-caching, fetched
 * 2026-09-20), the real minimum for claude-haiku-4-5 is **4096** tokens —
 * double what this file assumed. Sonnet's 1024 was already correct. This is
 * the actual reason prompt caching never fired for Haiku in production: every
 * "cacheable" stable prefix cleared the wrong (too-low) bar, so cache_control
 * was attached to blocks Anthropic itself still refused to cache — see
 * handoffs/COST_REPORT_2026-09-20.md's "Correction" section.
 */
export const CACHE_MIN_TOKENS = {
  sonnet: 1024,
  haiku: 4096,
};

/**
 * CORRECTED 2026-09-20 (late): the old comment here claimed chars/4
 * under-estimates real BPE token counts for English prose. That was
 * backwards. For ordinary English prose, real tokenizers land closer to
 * chars/4.3-4.6 (common words and whitespace batch into fewer, longer
 * tokens); chars/4 OVERESTIMATES a token count for prose, which is exactly
 * backwards for a "don't claim cacheable when it isn't" estimate — a
 * 9,377-char prompt that this used to report as ~2,345 tokens is really
 * closer to 2,050-2,150.
 *
 * Not a real tokenizer — a real count would need to either call the API's
 * token-counting endpoint (a network call this file deliberately avoids) or
 * vendor a tokenizer, either of which is more machinery than a
 * fail-safe-toward-"don't cache" estimate justifies. Using chars/4.6,
 * FLOORED (never rounded up), keeps the bias in the safe direction: this
 * estimate is now, if anything, LOWER than the real token count, so it can
 * under-claim a block is long enough to cache but never over-claim it —
 * exactly the direction that wastes nothing (worst case: a cacheable block
 * misses a breakpoint) rather than the direction that silently attaches
 * cache_control to something Anthropic will refuse to cache anyway.
 */
export function estimateTokens(text) {
  const s = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  return Math.floor(s.length / 4.6);
}

/** "claude-sonnet-4-5" / "claude-haiku-4-5" (or any string containing one of
 * those family names) -> its minimum. An unrecognized model name gets the
 * HIGHER of the two minimums, so an unknown model fails closed (skips
 * caching) rather than under-caching a model this file has never heard of. */
export function minTokensFor(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("haiku")) return CACHE_MIN_TOKENS.haiku;
  if (m.includes("sonnet")) return CACHE_MIN_TOKENS.sonnet;
  return Math.max(CACHE_MIN_TOKENS.sonnet, CACHE_MIN_TOKENS.haiku);
}

/**
 * Pure: would Anthropic actually cache a block holding this text, for this
 * model? `text` is whatever will be billed as that block's tokens — a plain
 * string for a text block, or the tool definition object for a tool block
 * (estimateTokens JSON-stringifies anything that isn't already a string).
 */
export function cacheable(text, model) {
  return estimateTokens(text) >= minTokensFor(model);
}

/**
 * Pure: return `block` with `cache_control` attached IFF it's long enough to
 * be worth a breakpoint for `model`; otherwise return it unchanged (same
 * object identity — no-op, not a stripped copy).
 *
 * `block` is a content block ({type:"text", text} or {type:"tool_use"/...})
 * or an Anthropic tool definition ({name, description, input_schema}). The
 * text billed for a tool is its whole JSON shape, not just `description`, so
 * a tool block is measured by JSON-stringifying it (minus any cache_control
 * that might already be on it) rather than by one field.
 *
 * @param {{ttl?: '1h'}} [opts] ttl: '1h' uses CACHE_CONTROL_1H instead of the
 *   5-minute default — pass this for a prefix reused across a long-running
 *   bulk operation (extraction, transcription). Anything else (omitted, '5m')
 *   keeps the default.
 */
export function withCache(block, model, opts = {}) {
  if (!block || typeof block !== "object") return block;
  const measured = typeof block.text === "string" ? block.text : { ...block, cache_control: undefined };
  if (!cacheable(measured, model)) return block;
  return { ...block, cache_control: opts?.ttl === "1h" ? CACHE_CONTROL_1H : CACHE_CONTROL };
}

/**
 * Pure: decide cache breakpoints the way Anthropic actually bills them —
 * off the CUMULATIVE estimated prefix up to and including each block, in the
 * exact order Anthropic bills a request (tools, then system, then message
 * content) — not off each block measured in isolation the way `cacheable()`/
 * `withCache()` do.
 *
 * CORRECTED 2026-09-20 (late): a per-block check under-attaches breakpoints.
 * Once one earlier block (say, `system`) has already pushed the cumulative
 * prefix past the model's minimum, EVERY later block in the same request is
 * already past it too (the cumulative sum only grows) — so a later block
 * that is individually too short to cache on its own (a small context block
 * behind an already-large system prompt) is still a perfectly valid
 * breakpoint. `withCache()` measuring each block alone can never see that.
 *
 * @param {{tools?: {block:object, breakpoint?: boolean}[],
 *           system?: {block:object, breakpoint?: boolean}[],
 *           messageBlocks?: {block:object, breakpoint?: boolean}[]}} parts
 *   Each entry pairs a real tool/content block with whether the CALLER wants
 *   a breakpoint there if it turns out eligible (e.g. never true for a
 *   question block that changes every call). Arrays are concatenated in
 *   Anthropic's own billed order: tools -> system -> messageBlocks.
 * @param {string} model
 * @param {{ttl?: '1h'}} [opts] see withCache's opts.
 * @returns {{tools: object[], system: object[], messageBlocks: object[]}}
 *   the same blocks (new objects where a breakpoint was added; the original
 *   object where it wasn't), grouped back the way they came in.
 */
export function planCacheBreakpoints({ tools = [], system = [], messageBlocks = [] } = {}, model, opts = {}) {
  const min = minTokensFor(model);
  const ttl = opts?.ttl === "1h" ? CACHE_CONTROL_1H : CACHE_CONTROL;
  const groups = { tools, system, messageBlocks };
  const out = { tools: [], system: [], messageBlocks: [] };

  let cumulative = 0;
  let breakpointsUsed = 0;
  for (const groupName of ["tools", "system", "messageBlocks"]) {
    for (const entry of groups[groupName] ?? []) {
      const block = entry?.block;
      const measured =
        block && typeof block === "object"
          ? typeof block.text === "string"
            ? block.text
            : { ...block, cache_control: undefined }
          : block;
      cumulative += estimateTokens(measured);

      const eligible =
        entry?.breakpoint &&
        block &&
        typeof block === "object" &&
        breakpointsUsed < MAX_CACHE_BREAKPOINTS &&
        cumulative >= min;

      if (eligible) {
        out[groupName].push({ ...block, cache_control: ttl });
        breakpointsUsed++;
      } else {
        out[groupName].push(block);
      }
    }
  }
  return out;
}

/**
 * Pure: shape the one structured log line each Anthropic call site emits
 * (via `console.log(JSON.stringify(...))`) so Vercel logs show cache hit
 * rates. Deliberately just {route, model, input_tokens, cache_read,
 * cache_creation, output_tokens, latency_ms} — no question text, no page
 * text, no field values, no tenant id. A caller that has none of the cache
 * fields (a response with no cache_control anywhere in the request) still
 * gets a valid line with those two fields at 0, which is itself meaningful:
 * 0/0 on every call for a route says its prompts never reached the caching
 * minimum, which is exactly the fact handoffs/HANDOFF-B.md needs Vercel logs
 * to be able to show later, without anyone having to read source to learn it.
 */
export function modelCallLogLine({
  route,
  model,
  inputTokens = 0,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
  outputTokens = 0,
  latencyMs = 0,
  // Optional: a stage->ms map (api/_lib/timing.js's timer.snapshot()) — e.g.
  // /api/ask's {auth, limit, gate, scope, retrieve, budget, model, total}.
  // Folded in as `timings_ms` only when actually given, so every existing
  // caller (extractDocument.js) that never passes it gets the exact same
  // line as before.
  timingsMs,
  // Diagnostics added 2026-09-20 (late), /api/ask only for now — counts and a
  // short enum, never content: `stopReason` is the Anthropic response's own
  // `stop_reason` ("tool_use", "max_tokens", ...) so a Vercel-log reader can
  // tell a genuine no-answer apart from a truncated one; `factsRaw` is how
  // many facts the model's tool_use returned before grounding, `factsKept` is
  // how many survived shapeAnswer's citation check — the gap between them is
  // exactly how often the model cites something retrieval never returned.
  // Each is folded in only when actually given, same as timingsMs above, so
  // no other caller's line shape changes.
  stopReason,
  factsRaw,
  factsKept,
} = {}) {
  const n = (v) => Math.max(0, Math.trunc(v) || 0);
  const line = {
    route: typeof route === "string" ? route : "unknown",
    model: typeof model === "string" ? model : "unknown",
    input_tokens: n(inputTokens),
    cache_read: n(cacheReadInputTokens),
    cache_creation: n(cacheCreationInputTokens),
    output_tokens: n(outputTokens),
    latency_ms: n(latencyMs),
  };
  if (timingsMs && typeof timingsMs === "object") {
    const timings_ms = {};
    for (const [k, v] of Object.entries(timingsMs)) {
      if (Number.isFinite(v)) timings_ms[k] = Math.round(v);
    }
    line.timings_ms = timings_ms;
  }
  if (typeof stopReason === "string" && stopReason) line.stop_reason = stopReason;
  if (Number.isFinite(factsRaw)) line.facts_raw = n(factsRaw);
  if (Number.isFinite(factsKept)) line.facts_kept = n(factsKept);
  return line;
}
