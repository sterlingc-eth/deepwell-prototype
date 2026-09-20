/**
 * Shared 429 message-building for every browser service that calls a
 * DeepWell API route (ingestClient.ts, answerService.claude.ts,
 * reviewClient.ts, documentClient.ts).
 *
 * api/_lib/rateLimit.js's send429 always answers a burst/per-day limit with
 * `{ error: "Too many requests", details, scope: "per-minute" | "per-day" }`
 * plus a `Retry-After` header (whole seconds). The daily model-spend budget
 * (sendModelBudgetExceeded) answers with just `{ error }` — no `details`,
 * no `scope` — plus a much larger Retry-After (seconds to UTC midnight).
 * Both shapes land here so a contractor sees one useful line ("Too many
 * requests — More than 30 ask units in the last minute. Try again in 12 s.")
 * instead of a bare "Too many requests" or a raw status line.
 */

export interface ErrorBody {
  error?: unknown;
  details?: unknown;
  scope?: unknown;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** `error` and `details` combined into one line when both are present and
 *  distinct; otherwise whichever one exists; otherwise `fallback`. */
function baseMessage(body: unknown, fallback: string): string {
  const b = (body ?? {}) as ErrorBody;
  const error = asNonEmptyString(b.error);
  const details = asNonEmptyString(b.details);
  if (error && details && details !== error) return `${error} — ${details}`;
  return error ?? details ?? fallback;
}

/**
 * True when a 429 body says this is a daily cap/budget rather than a
 * per-minute burst — rateLimit.js's `scope: "per-day"`, or the daily
 * model-spend budget's message (DAILY_MODEL_BUDGET_MESSAGE, which carries no
 * `scope` at all: "Daily AI budget reached — resumes tomorrow"). Either way,
 * retrying in a few seconds cannot help, so the UI should say "tomorrow",
 * not a second count.
 */
export function isDailyCap(body: unknown): boolean {
  const b = (body ?? {}) as ErrorBody;
  if (b.scope === 'per-day') return true;
  const text = `${asNonEmptyString(b.error) ?? ''} ${asNonEmptyString(b.details) ?? ''}`;
  return /\btomorrow\b|\bdaily\b/i.test(text);
}

/**
 * Parse a `Retry-After` header value per RFC 7231: either delay-seconds
 * ("120") or an HTTP-date. Returns whole seconds (>=0) measured from `now`,
 * or undefined when the header is missing or unparseable.
 */
export function parseRetryAfterSeconds(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Math.max(0, parseInt(trimmed, 10));
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - now) / 1000));
}

/** The subset of `Response` this module needs — real `fetch` Responses
 *  satisfy it, and tests can pass a plain object with no DOM. */
export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * Build the message a contractor sees for a failed API call. `fallback` is
 * whatever plain-language text the caller already falls back to when the
 * body isn't usable JSON (e.g. an HTML 500 page). Non-429 responses just get
 * `error`/`details`-or-`fallback`; a 429 also gets a wait hint appended:
 * "Try again in N s." from the `Retry-After` header (numeric seconds or an
 * HTTP-date), or "Try again tomorrow." when the body indicates a daily
 * cap/budget rather than a per-minute burst.
 */
export function messageFromResponse(res: ResponseLike, body: unknown, fallback: string): string {
  const message = baseMessage(body, fallback);
  if (res.status !== 429) return message;

  if (isDailyCap(body)) return `${message} Try again tomorrow.`;

  const seconds = parseRetryAfterSeconds(res.headers.get('Retry-After'));
  if (seconds != null) return `${message} Try again in ${seconds} s.`;

  return message;
}
