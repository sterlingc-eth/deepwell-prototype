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
 */
export const CACHE_MIN_TOKENS = {
  sonnet: 1024,
  haiku: 2048,
};

/**
 * ~4 characters per token. This is the rough heuristic the task calls for,
 * not a real tokenizer — a real count would need to either call the API's
 * token-counting endpoint (a network call this file deliberately avoids) or
 * vendor a tokenizer, either of which is more machinery than a
 * fail-safe-toward-"don't cache" estimate justifies. Because the real
 * (BPE) token count for English prose is normally BELOW chars/4 (short
 * common words often are a single token even at 5-6 characters), this
 * heuristic is if anything pessimistic — it under-estimates tokens less
 * often than it over-estimates them — so it defaults toward skipping a cache
 * breakpoint on a block that would have just barely qualified, never toward
 * claiming a too-short block is cacheable.
 */
export function estimateTokens(text) {
  const s = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  return Math.ceil(s.length / 4);
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
  return line;
}
