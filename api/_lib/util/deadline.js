/**
 * Response watchdog: guarantees the CALLER gets a clean, honest JSON answer
 * before Vercel hard-kills the function at `maxDuration`.
 *
 * Production logs showed "Task timed out after 60/300 seconds" on /api/review,
 * /api/ask and /api/account. A platform kill runs no catch block: the browser
 * just sees a dropped/500 response and nothing is recorded. This arms a timer a
 * few seconds under the platform ceiling; if the handler has not answered by
 * then it writes a 504 with a plain message (or, for an already-streaming
 * NDJSON response, a final `{type:'final',success:false}` event), then makes
 * every later write from the still-running handler a harmless no-op so it can
 * not throw ERR_HTTP_HEADERS_SENT. The timer is unref'd and cleared when the
 * response finishes, so it never keeps an instance alive or fires late.
 *
 * It does NOT cancel the running work (JS cannot); real per-phase deadlines
 * (cron-sweep, agent loop, reclassify) remain the primary defence.
 */

export const TIMEOUT_MESSAGE =
  'This is taking longer than expected, so we stopped waiting for it. Nothing was answered incorrectly, but part of the work may still have completed — check before trying again, or narrow the request.';

/**
 * @param {import('http').ServerResponse & {status?: Function, json?: Function}} res
 * @param {number} ms  how long to wait before answering 504 (platform maxDuration minus ~10s)
 * @param {{message?: string, onFire?: () => void}} [opts]
 * @returns {() => void} disarm
 */
export function armResponseDeadline(res, ms, opts = {}) {
  // Only real ServerResponse objects (have once()): in-process mock responses (scorecard/tests) are never armed.
  if (!res || typeof res.once !== 'function' || !Number.isFinite(ms) || ms <= 0) return () => {};
  const message = opts.message ?? TIMEOUT_MESSAGE;
  let timer = setTimeout(() => {
    timer = null;
    if (res.writableEnded) return;
    try { opts.onFire?.(); } catch { /* observability only */ }
    try {
      if (!res.headersSent) {
        res.status(504).json({ error: message, code: 'timeout' });
      } else {
        // Streaming NDJSON (ask.js): the client is waiting for a final event.
        res.write(`${JSON.stringify({ type: 'final', success: false, error: message, code: 'timeout' })}\n`);
        res.end();
      }
    } catch { /* the client may already be gone */ }
    // Neutralize late writes from the handler that is still running.
    const noop = function noop() { return res; };
    for (const m of ['status', 'json', 'send', 'end', 'write', 'setHeader', 'writeHead']) {
      try { res[m] = m === 'write' ? () => true : noop; } catch { /* non-writable */ }
    }
  }, ms);
  timer.unref?.();
  const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
  res.once('close', disarm);
  res.once('finish', disarm);
  return disarm;
}
