/**
 * Donovan Scorecard - call the REAL /api/ask handler in-process.
 *
 * Decision (vs. extracting an `answerQuestion` core out of api/ask.js): the handler is ~1000 lines whose
 * stages (meta -> fast path -> contact lookup -> doc lookup -> money gate -> analytics -> retrieval+model ->
 * agent) share closures with its `send`/timing/bookkeeping. Splitting that to make it callable would be a
 * large refactor of the file two other engineers are also editing, with real risk of changing behaviour.
 * Instead the handler is called with a synthetic req/res carrying an in-process-only Symbol (hook.js) that
 * supplies the auth and turns off the rate limiter, billing gate, allowance counting and answer cache. That
 * is the same code, byte for byte, that answers a customer.
 *
 * The call runs inside a usage meter (usage.js), so its true model spend - planner, retrieval answer, agent,
 * escalated agent, whichever ran - is reported without those call sites knowing about the scorecard.
 */
import { SCORECARD_CALL } from "./hook.js";
import { createUsageMeter, runWithUsageMeter } from "../usage.js";

function makeRes() {
  const res = {
    statusCode: 200, headers: {}, headersSent: false, body: undefined,
    setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; },
    getHeader(k) { return res.headers[String(k).toLowerCase()]; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; res.headersSent = true; return res; },
    end() { res.headersSent = true; return res; },
  };
  return res;
}

/**
 * @param {{handler: Function, auth: {tenantId: string, orgId?: string, userId?: string}, question: string, today?: string,
 *   escalate?: boolean, deadlineAt?: number}} p
 * @returns {Promise<{status: number, data: object|null, error: string|null, latencyMs: number, usage: object, debug: object|null}>}
 */
export async function askViaHandler({ handler, auth, question, today, escalate = false, deadlineAt }) {
  const req = {
    method: "POST", headers: {}, query: {},
    body: { question, ...(today ? { today } : {}), debug: true },
    [SCORECARD_CALL]: { auth, escalate, ...(deadlineAt ? { deadlineAt } : {}) },
  };
  const res = makeRes();
  const meter = createUsageMeter();
  const started = Date.now();
  let thrown = null;
  try {
    await runWithUsageMeter(meter, () => handler(req, res));
  } catch (err) {
    if (err?.name === "ModelBudgetExceededError") throw err;
    thrown = String(err?.name ?? "error");
  }
  const body = res.body ?? null;
  const data = body?.success ? body.data ?? null : null;
  const debug = data?.debug ?? null;
  if (data && "debug" in data) delete data.debug;
  return {
    status: res.statusCode, data, debug, usage: meter.snapshot(), latencyMs: Date.now() - started,
    error: thrown ?? (data ? null : String(body?.error ?? `http-${res.statusCode}`).slice(0, 160)),
  };
}
