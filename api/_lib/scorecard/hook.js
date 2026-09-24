/**
 * The in-process hook that lets the Donovan Scorecard call the /api/ask handler with the SAME code path
 * production uses, without an HTTP request, a Clerk token or a billing/allowance side effect.
 *
 * The scorecard builds a synthetic req/res and attaches `{auth, escalate}` under SCORECARD_CALL, a Symbol
 * that only exists in this process: nothing that arrives over HTTP (headers, query, JSON body) can ever set
 * a Symbol-keyed property on the request object, so this cannot be reached from outside. When present,
 * api/ask.js (1) uses the supplied auth instead of verifying a token, (2) skips the rate limiter and the
 * billing/allowance gate, (3) never increments the monthly allowance and never reads/writes the answer
 * cache, and (4) returns the operator debug trace. Model spend is still recorded and still subject to the
 * daily model budget, exactly like any other ask.
 */
export const SCORECARD_CALL = Symbol("donovan.scorecard.call");

/** The scorecard call attached to `req`, or null for every real HTTP request. */
export function takeScorecardCall(req) {
  const call = req?.[SCORECARD_CALL];
  return call && typeof call === "object" && call.auth && typeof call.auth.tenantId === "string" ? call : null;
}
