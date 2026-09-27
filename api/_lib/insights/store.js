/**
 * Proactive insights (R17 contract, G1) — cache read/write over
 * tenant_insights_cache (M3-config/55-insights-cache.sql), keyed by the same
 * corpus_stamp expression api/_lib/rollups/refresh.js already reuses from
 * askCache.js's STAMP_EXPR (via rollups.getCorpusStamp) — one invalidation
 * signal shared by the exact-match ask cache, the rollups, and this cache.
 *
 * Same tableExists-probe idiom as askCache.js/rollups/*.js: degrades
 * gracefully (never throws, a cold compute happens on every read) when
 * migration 55 hasn't been pasted yet.
 *
 * Budget: detect.js's own compute pass is the expensive part (several SQL
 * scans reusing existing engines); THIS module's job is to make repeat reads
 * of an unchanged tenant cheap (<150ms) by skipping that pass entirely
 * whenever the corpus hasn't moved since the last computed row.
 */
import { logOnce } from '../rateLimit.js';
import { getCorpusStamp } from '../rollups/refresh.js';

export { getCorpusStamp };

let tableExists = null;
export function _resetInsightsStoreForTests() {
  tableExists = null;
}

async function probeTable(db) {
  if (tableExists !== null) return tableExists;
  try {
    await db.raw('SAVEPOINT tenant_insights_cache_probe', []);
    await db.raw('SELECT 1 FROM tenant_insights_cache LIMIT 0', []);
    tableExists = true;
  } catch (err) {
    if (err?.code === '42P01') {
      await db.raw('ROLLBACK TO SAVEPOINT tenant_insights_cache_probe', []).catch(() => {});
      tableExists = false;
      logOnce('tenant_insights_cache', err);
    } else {
      throw err;
    }
  }
  return tableExists;
}

/**
 * @returns {Promise<{payload: object, corpusStamp: string, computedAt: Date}|null>} null when the
 *   cache is unavailable (table missing) or empty/stale for this tenant's current corpus_stamp —
 *   either way the caller recomputes.
 */
export async function getCachedInsights(db, { today } = {}) {
  if (!(await probeTable(db))) return null;
  const corpusStamp = await getCorpusStamp(db, { today });
  if (corpusStamp == null) return null;
  try {
    const { rows } = await db.raw(
      `SELECT payload, computed_at FROM tenant_insights_cache
        WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid AND corpus_stamp = $1`,
      [corpusStamp]
    );
    if (!rows.length) return null;
    return { payload: rows[0].payload, corpusStamp, computedAt: rows[0].computed_at };
  } catch (err) {
    logOnce('tenant_insights_cache_read', err);
    return null;
  }
}

/** Best-effort: a failed write just means the NEXT read recomputes too — never blocks the response. */
export async function setCachedInsights(db, corpusStamp, payload) {
  if (!(await probeTable(db))) return false;
  try {
    await db.raw(
      `INSERT INTO tenant_insights_cache (tenant_id, corpus_stamp, payload, computed_at)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2::jsonb, NOW())
       ON CONFLICT (tenant_id) DO UPDATE
         SET corpus_stamp = EXCLUDED.corpus_stamp, payload = EXCLUDED.payload, computed_at = NOW()`,
      [corpusStamp, JSON.stringify(payload)]
    );
    return true;
  } catch (err) {
    logOnce('tenant_insights_cache_write', err);
    return false;
  }
}
