/**
 * ROUND 14: the cross-invocation half of the provider-outage flag. api/_lib/claude.js's
 * recordProviderOutage/getProviderOutage are IN-PROCESS only — fast, and enough for a single warm
 * serverless instance, but a nightly cron run and a live customer request are usually different
 * instances, and a fresh cold start remembers nothing. This file adds a best-effort, PLATFORM-level
 * (no tenant_id — an Anthropic account outage is a fact about the account, never about one shop's
 * data) persisted marker (M3-config/48-donovan-provider-status.sql) on top of it.
 *
 * TOLERANT OF THE MIGRATION NOT BEING APPLIED YET: every function here degrades to "the in-process
 * flag is all there is" (never throws, warns once) — same convention as
 * api/_lib/learning/store.js/missStore.js.
 *
 * Callers should treat claude.js's in-process getProviderOutage() as the fast path and only reach for
 * markProviderOutage/currentProviderOutage here when they need it to survive a cold start or be seen
 * by a DIFFERENT process (the nightly sweep checking whether a live request already hit an outage a
 * minute ago, or the scorecard/notifications UI showing "since" across page reloads).
 */
import { getPool } from "./recordsStore.js";
import { recordProviderOutage, clearProviderOutage, getProviderOutage, seedProviderOutage } from "./claude.js";

let warned = false;
function warnOnce(context, err) {
  if (warned) return;
  warned = true;
  console.warn(`provider-status: ${context} failed (M3-config/48-donovan-provider-status.sql may not be applied yet):`, err?.message);
}

/** Records a sighting BOTH in-process and (best-effort) in the DB. Never throws. */
export async function markProviderOutage({ reason, detail } = {}) {
  if (!reason) return;
  recordProviderOutage({ reason, detail });
  try {
    await getPool().query("SELECT provider_status_mark($1,$2)", [reason, detail ? String(detail).slice(0, 500) : null]);
  } catch (err) {
    warnOnce("provider_status_mark", err);
  }
}

/** Clears BOTH the in-process flag and the persisted marker. Never throws. */
export async function markProviderRestored() {
  clearProviderOutage();
  try {
    await getPool().query("SELECT provider_status_clear()");
  } catch (err) {
    warnOnce("provider_status_clear", err);
  }
}

/**
 * The current outage, checking the fast in-process flag first and only falling back to a DB read
 * when nothing is recorded locally (a fresh cold start, or a different process just recorded one).
 * @returns {Promise<{reason: string, detail: string|null, since: string}|null>}
 */
export async function currentProviderOutage() {
  const local = getProviderOutage();
  if (local) return { reason: local.reason, detail: local.detail, since: new Date(local.since).toISOString() };
  try {
    const { rows } = await getPool().query("SELECT * FROM provider_status_current()");
    const row = rows[0];
    if (!row) return null;
    // Seen for the first time by THIS process — warm the fast in-process flag too, from the true
    // first-sighting time the DB recorded, without resetting the TTL clock to look already-stale.
    seedProviderOutage({ reason: row.reason, detail: row.detail, since: Date.parse(row.detected_at) });
    return { reason: row.reason, detail: row.detail ?? null, since: new Date(row.detected_at).toISOString() };
  } catch (err) {
    warnOnce("provider_status_current", err);
    return null;
  }
}
