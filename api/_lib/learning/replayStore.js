/**
 * Donovan learning - tenant-scoped store for MISS REPLAYS (M3-config/29-donovan-recipes.sql,
 * ask_miss_replays; OPTIONAL - every function here returns an empty/false result instead of
 * throwing when the table is missing, same warn-once idiom as missStore.js).
 *
 * One row per (tenant, normalized question): what happened when Donovan re-ran that miss.
 * Read/write through withTenant, so row-level security scopes it to the caller's shop exactly like
 * ask_misses. The `answer` column holds that shop's own answer, never shown to another shop.
 */
import { withTenant } from "../recordsStore.js";

const TENANT_SQL = "tenant_id = (current_setting('app.tenant_id', true))::uuid";
const OPEN_MISS_OUTCOMES_EXCLUDED = ["money-fallback"]; // gated on purpose, nothing to replay

let warned = false;
function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  console.warn(`donovan-replay: ${context} failed (M3-config/29-donovan-recipes.sql may not be applied yet):`, err?.message);
}

const clip = (s, n) => String(s ?? "").slice(0, n);

/** Upserts the outcome of one replay. Never throws. Returns true when written. */
export async function upsertReplay(ctxArg, { question, questionNormalized, outcome, reason, answer, note, trace, costUsd, source }) {
  if (outcome !== "answered_now" && outcome !== "still_failing") return false;
  try {
    await withTenant(ctxArg, (db) => db.raw(
      `INSERT INTO ask_miss_replays (tenant_id, question_normalized, question, outcome, reason, answer, note, trace, cost_usd, source, replayed_at)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, NOW())
       ON CONFLICT (tenant_id, question_normalized) DO UPDATE
         SET question = EXCLUDED.question, outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, answer = EXCLUDED.answer,
             note = EXCLUDED.note, trace = EXCLUDED.trace, cost_usd = EXCLUDED.cost_usd, source = EXCLUDED.source, replayed_at = NOW()`,
      [
        clip(questionNormalized, 300), clip(question, 300), outcome, reason ? clip(reason, 200) : null,
        answer ? JSON.stringify(answer) : null, note ? clip(note, 300) : null, JSON.stringify(trace ?? {}),
        Math.min(9999, Number(costUsd) || 0), source ? clip(source, 40) : null,
      ]));
    return true;
  } catch (err) {
    warnOnce("upsert", err);
    return false;
  }
}

/** Map<normalized question, {outcome, reason, answer, replayedAt, note}> for the given keys. */
export async function listReplays(ctxArg, keys) {
  const out = new Map();
  const wanted = [...new Set((keys ?? []).filter(Boolean))].slice(0, 500);
  if (!wanted.length) return out;
  try {
    const rows = await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT question_normalized, outcome, reason, answer, note, replayed_at FROM ask_miss_replays
        WHERE ${TENANT_SQL} AND question_normalized = ANY($1::text[])`, [wanted])).rows);
    for (const r of rows) {
      out.set(r.question_normalized, { outcome: r.outcome, reason: r.reason ?? null, answer: r.answer ?? null, note: r.note ?? null, replayedAt: r.replayed_at instanceof Date ? r.replayed_at.toISOString() : String(r.replayed_at) });
    }
  } catch (err) {
    warnOnce("list", err);
  }
  return out;
}

/**
 * This shop's distinct missed questions, newest first: {question, normalized, outcome, lastAt, count,
 * replay?: {outcome, replayedAt}}. Never throws (empty when ask_misses is missing).
 */
export async function listOpenMisses(ctxArg, { limit = 60 } = {}) {
  let rows = [];
  try {
    rows = await withTenant(ctxArg, async (db) => (await db.raw(
      `SELECT question, question_normalized, outcome, created_at FROM ask_misses
        WHERE ${TENANT_SQL} ORDER BY created_at DESC LIMIT 500`, [])).rows);
  } catch (err) {
    warnOnce("open-misses", err);
    return [];
  }
  const byKey = new Map();
  for (const r of rows) {
    const key = String(r.question_normalized || r.question || "").trim();
    if (!key || OPEN_MISS_OUTCOMES_EXCLUDED.includes(r.outcome)) continue;
    const at = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
    const e = byKey.get(key);
    if (e) { e.count += 1; continue; }
    byKey.set(key, { question: r.question, normalized: key, outcome: r.outcome, lastAt: at, count: 1 });
  }
  const items = [...byKey.values()].slice(0, Math.max(1, Math.min(200, limit)));
  const replays = await listReplays(ctxArg, items.map((i) => i.normalized));
  return items.map((i) => ({ ...i, ...(replays.has(i.normalized) ? { replay: replays.get(i.normalized) } : {}) }));
}
