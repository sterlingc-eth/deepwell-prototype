/**
 * Lightweight per-request wall-clock timing, built for /api/ask's latency
 * work (handoffs/ASK_LATENCY_2026-09-20.md) but generic enough for any
 * handler that wants a Server-Timing header without a profiler.
 *
 * Stages can run CONCURRENTLY (ask.js overlaps the billing gate check with
 * retrieval) so this measures each named stage's own start-to-finish wall
 * time, not "time since the last mark" off a single shared pointer — two
 * stages that overlap in real time both report their real cost, and their
 * sum can legitimately exceed `total`. That is intentional: it is exactly
 * what shows a reader this endpoint overlapped work rather than only ever
 * running serially. `total` (added by snapshot()) is the one number that
 * always matches actual elapsed time, since it is just now-minus-start.
 */

/**
 * @returns {{add: Function, time: Function, snapshot: Function}}
 */
export function startTimer() {
  const t0 = Date.now();
  const marks = Object.create(null);

  return {
    /** Add `ms` to stage `name`. Accumulates across repeat calls (e.g. a
     *  "bookkeeping" stage made of two separate best-effort writes). Silently
     *  ignores a non-finite or negative value rather than corrupting the map. */
    add(name, ms) {
      if (typeof name !== "string" || !name) return;
      if (!Number.isFinite(ms)) return;
      marks[name] = (marks[name] ?? 0) + Math.max(0, ms);
    },

    /** Run `fn` (sync or async), recording its own wall-clock time under
     *  `name` whether it resolves or throws, and returning/rethrowing
     *  whatever `fn` does. */
    async time(name, fn) {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        this.add(name, Date.now() - start);
      }
    },

    /** {stage: ms, ..., total: ms-since-startTimer()}. Safe to call more than
     *  once (e.g. once for the response header, again after background
     *  bookkeeping finishes for a debug log). */
    snapshot() {
      return { ...marks, total: Date.now() - t0 };
    },
  };
}

/**
 * Pure: {auth: 12.4, limit: 3} -> "auth;dur=12, limit;dur=3" — a
 * Server-Timing header value (https://www.w3.org/TR/server-timing/). Rounds
 * to whole milliseconds (sub-ms precision buys nothing here), drops any
 * entry that isn't a finite, non-negative number rather than emitting a
 * malformed header, and returns "" (never write the header) for an empty or
 * all-invalid input.
 */
export function formatServerTiming(timingsMs) {
  return Object.entries(timingsMs ?? {})
    .filter(([, v]) => Number.isFinite(v) && v >= 0)
    .map(([name, v]) => `${name};dur=${Math.round(v)}`)
    .join(", ");
}
