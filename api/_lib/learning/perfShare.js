/**
 * Opt-in Donovan performance sharing (owner ask, 2026-10-10): "we dont need to truly see their data though. just to
 * run scores on donovans performance."
 *
 * WHAT IS SHARED (only when a tenant admin switches "Share Donovan performance scores with DeepWell" on; OFF by default):
 *   shape        a coarse label for the KIND of question ("count", "list", "money", ...), derived from a FIXED vocabulary
 *                of words. The question text is read once to pick a label and is never stored, logged or returned.
 *   length       "short" | "medium" | "long" (word-count bucket)
 *   outcome      "answered_from_records" | "declined" | "ai_fallback" | "marked_wrong"
 *   latencyMs    number (clamped), costUsd number (clamped)
 *   tenant       a one-way hash of the tenant id (so trends can be counted per tenant without naming anyone)
 * NEVER shared: question text, answer text, document content, names, addresses, anything free-form. sanitizeMetric() is
 * the single gate: it rebuilds the record from enumerated fields only, so extra properties a caller passes are dropped.
 *
 * STORAGE (no migration): the audit_log table every deploy already has.
 *   - the tenant's own setting   -> audit_log row 'donovan.score_sharing' in the tenant (newest row wins; none = off)
 *   - the shared score rows      -> audit_log rows 'donovan.perf_metric' written into the DEEPWELL FOUNDER tenant
 *     (DEEPWELL_FOUNDER_TENANT_ID), which is why the operator view needs no cross-tenant read and RLS stays untouched.
 *   - opt-in/opt-out events      -> audit_log rows 'donovan.perf_optin' in the founder tenant (hash + on/off only)
 * If the founder tenant id is not configured, nothing is recorded (fail closed).
 *
 * Every write is best-effort and never throws, never delays an answer (callers do not await the shared write).
 */
import { withTenant, getTenantContext } from "../recordsStore.js";
import { hashTenantId } from "../privacy/redact.js";
import { TTLCache } from "../perf.js";

export const SETTING_ACTION = "donovan.score_sharing";
export const METRIC_ACTION = "donovan.perf_metric";
export const OPTIN_ACTION = "donovan.perf_optin";

export const OUTCOMES = Object.freeze(["answered_from_records", "declined", "ai_fallback", "marked_wrong"]);
export const SHAPES = Object.freeze(["count", "money", "list", "lookup", "date", "compare", "status", "other"]);
const LENGTHS = ["short", "medium", "long"];

/* Fixed vocabulary only. The label comes from WHICH of these words appear, never from any other word. */
const SHAPE_WORDS = [
  ["count", /\b(how many|count|number of|total number)\b/],
  ["money", /\b(how much|cost|price|paid|revenue|spend|spent|invoice|invoices|balance|owe|owed|dollar|amount|profit)\b/],
  ["compare", /\b(compare|versus|vs|more than|less than|most|least|highest|lowest|top|best|worst|average)\b/],
  ["date", /\b(when|date|due|expire|expires|expiring|expired|warranty|overdue|renewal|installed|today|yesterday|tomorrow|week|month|year)\b/],
  ["status", /\b(status|open|closed|pending|active|inactive|complete|completed|missing|unpaid|approved)\b/],
  ["list", /\b(list|show|which|who|all|every|what are)\b/],
  ["lookup", /\b(what|where|whose|phone|email|address|model|serial|contact)\b/],
];

/** PURE. Coarse kind of question from the fixed vocabulary above. The text itself is never returned. */
export function shapeOf(question) {
  const q = String(question ?? "").toLowerCase();
  for (const [label, re] of SHAPE_WORDS) if (re.test(q)) return label;
  return "other";
}

/** PURE. Word-count bucket. */
export function lengthOf(question) {
  const n = String(question ?? "").trim().split(/\s+/).filter(Boolean).length;
  return n <= 6 ? "short" : n <= 14 ? "medium" : "long";
}

const clampNum = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.round(n * 10000) / 10000) : null;
};

/** PURE. Map an ask source (api/ask.js's own labels) to an outcome. */
export function outcomeForSource(source) {
  const s = String(source ?? "");
  if (s === "model" || s === "analytics-model" || s === "agent") return "ai_fallback";
  if (s === "no-answer" || s === "declined") return "declined";
  return "answered_from_records";
}

/** PURE. Map a miss-log outcome code (missStore.MISS_OUTCOMES) to an outcome, or null when it must not be shared
 *  (synthetic exam runs, provider outages: neither says anything about how Donovan did for the customer). */
export function outcomeForMiss(missOutcome) {
  const o = String(missOutcome ?? "");
  if (o === "user-marked-wrong") return "marked_wrong";
  if (o === "scorecard-fail" || o === "provider-unavailable" || !o) return null;
  return "declined";
}

/**
 * PURE. THE privacy gate: build the shareable record from enumerated fields only. `question` is used to derive
 * shape/length and is then dropped; no other free-form input can reach the result. Returns null for an unknown outcome.
 */
export function sanitizeMetric({ question, outcome, latencyMs, costUsd, tenantHash } = {}) {
  if (!OUTCOMES.includes(outcome)) return null;
  return {
    t: typeof tenantHash === "string" ? tenantHash.replace(/[^a-z0-9:()\s-]/gi, "").slice(0, 40) : null,
    shape: shapeOf(question),
    len: lengthOf(question),
    outcome,
    latencyMs: clampNum(latencyMs, 600000),
    costUsd: clampNum(costUsd, 100),
  };
}

/* ---------------------------------------------------------------- opt-in setting */

const settingCache = new TTLCache(60 * 1000, 500);

function founderCtx() {
  const key = process.env.DEEPWELL_FOUNDER_TENANT_ID;
  return key ? { tenantKey: key, tenantName: "DeepWell" } : null;
}

const SETTING_SQL = `SELECT changes FROM audit_log WHERE action = '${SETTING_ACTION}' AND tenant_id = (current_setting('app.tenant_id', true))::uuid ORDER BY created_at DESC LIMIT 1`;

/** Is sharing on for the tenant behind `db` (already tenant-scoped)? Default and every failure: false. */
export async function sharingEnabledFromDb(db) {
  try {
    const { rows } = await db.raw(SETTING_SQL, []);
    return rows?.[0]?.changes?.enabled === true;
  } catch { return false; }
}

/** Is sharing on for this tenant? Cached 60 s per tenant. Default and every failure: false. */
export async function getSharing(ctx) {
  const key = ctx?.tenantKey;
  if (!key) return false;
  const hit = settingCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const on = await withTenant(ctx, (db) => sharingEnabledFromDb(db));
    settingCache.set(key, on);
    return on;
  } catch { return false; }
}

/** Admin turns sharing on/off. Records the change in the tenant and (hash + on/off only) in the founder tenant. */
export async function setSharing(ctx, enabled, clerkUserId) {
  const on = enabled === true;
  await withTenant(ctx, (db) => db.logAction({ action: SETTING_ACTION, resource_type: "donovan", clerk_user_id: clerkUserId, changes: { enabled: on } }));
  settingCache.set(ctx.tenantKey, on);
  const f = founderCtx();
  if (f) {
    try {
      const tenantUuid = (await getTenantContext(ctx.tenantKey, ctx.tenantName)).id;
      await withTenant(f, (db) => db.logAction({ action: OPTIN_ACTION, resource_type: "donovan", changes: { t: hashTenantId(tenantUuid), enabled: on } }));
    } catch { /* best-effort */ }
  }
  return on;
}

export function resetPerfShareForTests() { settingCache.map.clear(); }

/* ---------------------------------------------------------------- recording */

async function writeMetric(metric) {
  const f = founderCtx();
  if (!f || !metric) return false;
  try {
    await withTenant(f, (db) => db.logAction({ action: METRIC_ACTION, resource_type: "donovan", changes: metric }));
    return true;
  } catch { return false; }
}

/** Record one score IF the tenant opted in. Never throws. Callers should not await it on the answer path. */
export async function shareScore(ctx, { question, outcome, latencyMs, costUsd } = {}) {
  try {
    if (!(await getSharing(ctx))) return false;
    return await writeMetric(sanitizeMetric({ question, outcome, latencyMs, costUsd, tenantHash: hashTenantId((await getTenantContext(ctx.tenantKey, ctx.tenantName)).id) }));
  } catch { return false; }
}

/** api/ask.js hook (call after the response is sent): `source` is the answer's source label. */
export function shareAskScore(ctx, { question, source, latencyMs, costUsd } = {}) {
  return shareScore(ctx, { question, outcome: outcomeForSource(source), latencyMs, costUsd });
}

/** missStore hook: same as shareScore but from inside an existing tenant transaction (`db`), keyed by the tenant uuid. */
export async function shareMissFromDb(db, { question, missOutcome } = {}) {
  try {
    const outcome = outcomeForMiss(missOutcome);
    if (!outcome) return false;
    if (!(await sharingEnabledFromDb(db))) return false;
    const { rows } = await db.raw("SELECT current_setting('app.tenant_id', true) AS t", []);
    const metric = sanitizeMetric({ question, outcome, tenantHash: hashTenantId(rows?.[0]?.t ?? "") });
    void writeMetric(metric); // not awaited: never delays the caller's transaction
    return true;
  } catch { return false; }
}

/* ---------------------------------------------------------------- operator aggregate */

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const pctile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

/** PURE. rows = [{changes, created_at}] of METRIC_ACTION; optinRows likewise for OPTIN_ACTION. */
export function aggregateScores(rows, optinRows = []) {
  const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const shapes = {};
  const days = {};
  const tenants = new Set();
  const lat = [];
  let cost = 0;
  let total = 0;
  for (const r of rows ?? []) {
    const c = r.changes ?? {};
    if (!OUTCOMES.includes(c.outcome)) continue;
    total++;
    byOutcome[c.outcome]++;
    if (c.t) tenants.add(c.t);
    const sh = SHAPES.includes(c.shape) ? c.shape : "other";
    const s = (shapes[sh] ??= { n: 0, answered_from_records: 0, declined: 0, ai_fallback: 0, marked_wrong: 0 });
    s.n++; s[c.outcome]++;
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    const d = (days[day] ??= { day, n: 0, answered_from_records: 0, declined: 0, ai_fallback: 0, marked_wrong: 0, latSum: 0, latN: 0, costUsd: 0 });
    d.n++; d[c.outcome]++;
    if (typeof c.latencyMs === "number") { lat.push(c.latencyMs); d.latSum += c.latencyMs; d.latN++; }
    if (typeof c.costUsd === "number") { cost += c.costUsd; d.costUsd += c.costUsd; }
  }
  lat.sort((a, b) => a - b);
  // newest opt-in event per tenant hash wins
  const latestOptin = new Map();
  for (const r of [...(optinRows ?? [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    if (r.changes?.t) latestOptin.set(r.changes.t, r.changes.enabled === true);
  }
  return {
    total,
    tenantsReporting: tenants.size,
    tenantsOptedIn: [...latestOptin.values()].filter(Boolean).length,
    rates: Object.fromEntries(OUTCOMES.map((o) => [o, pct(byOutcome[o], total)])),
    byOutcome,
    byShape: Object.entries(shapes).map(([shape, v]) => ({ shape, ...v, answeredRate: pct(v.answered_from_records, v.n) })).sort((a, b) => b.n - a.n),
    trend: Object.values(days).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({
      day: d.day, n: d.n, answeredRate: pct(d.answered_from_records, d.n), declinedRate: pct(d.declined, d.n),
      aiRate: pct(d.ai_fallback, d.n), wrongRate: pct(d.marked_wrong, d.n),
      avgLatencyMs: d.latN ? Math.round(d.latSum / d.latN) : null, costUsd: Math.round(d.costUsd * 10000) / 10000,
    })),
    latencyMs: { p50: pctile(lat, 0.5), p95: pctile(lat, 0.95) },
    costUsd: Math.round(cost * 10000) / 10000,
  };
}

/** Operator view: aggregate of all shared scores in the last `days` days (default 30, max 90). Reads only the founder tenant. */
export async function loadScores({ days } = {}) {
  const f = founderCtx();
  const n = Math.max(1, Math.min(90, Number(days) || 30));
  if (!f) return { configured: false, days: n, ...aggregateScores([], []) };
  try {
    return await withTenant(f, async (db) => {
      const q = (action) => db.raw(
        `SELECT changes, created_at FROM audit_log WHERE action = $1 AND tenant_id = (current_setting('app.tenant_id', true))::uuid AND created_at > NOW() - ($2 || ' days')::interval ORDER BY created_at DESC LIMIT 20000`,
        [action, String(n)],
      );
      const [m, o] = await Promise.all([q(METRIC_ACTION), db.raw(`SELECT changes, created_at FROM audit_log WHERE action = $1 AND tenant_id = (current_setting('app.tenant_id', true))::uuid ORDER BY created_at DESC LIMIT 5000`, [OPTIN_ACTION])]);
      return { configured: true, days: n, ...aggregateScores(m.rows, o.rows) };
    });
  } catch {
    return { configured: true, days: n, unavailable: true, ...aggregateScores([], []) };
  }
}
