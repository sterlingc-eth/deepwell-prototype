/**
 * Precomputed rollups: read side. See refresh.js's module doc comment for
 * the metrics/staleness model. Every export here is safe to call whether or
 * not migration 40 has been pasted, and whether or not a rollup has ever
 * been computed for this tenant — a miss/stale read is repaired lazily (at
 * most one recompute per call) rather than ever answered wrong.
 *
 * CALLERS (analytics.js / financials/answers.js, described — not wired,
 * those files belong to other owners): pass `{ corpusStamp }` through from a
 * request that already computed one (askCache.js's getCacheEntry does, on
 * every ask.js turn) to skip this module's own redundant recompute. Each read
 * helper returns `null` when
 * rollups are unavailable (table missing) OR when a fresh answer could not
 * be produced even after a refresh attempt (e.g. migration 22 missing for
 * open_invoices) — a `null` means "compute this the old way, live SQL",
 * EXACTLY the same contract askCache.js's isCacheHit/getCacheEntry already
 * establishes for the exact-match cache, so a caller wiring this in follows
 * a pattern it has already seen once in this codebase.
 */
import { logOnce } from '../rateLimit.js';
import { getCorpusStamp, refreshMetric, ROLLUPS_ENABLED } from './refresh.js';

let tableExists = null;
export function _resetRollupsReadStateForTests() {
  tableExists = null;
}

async function probeTable(db) {
  if (tableExists !== null) return tableExists;
  try {
    await db.raw('SAVEPOINT tenant_rollups_read_probe', []);
    await db.raw('SELECT 1 FROM tenant_rollups LIMIT 0', []);
    tableExists = true;
  } catch (err) {
    if (err?.code === '42P01') {
      await db.raw('ROLLBACK TO SAVEPOINT tenant_rollups_read_probe', []).catch(() => {});
      tableExists = false;
      logOnce('tenant_rollups_read', err);
    } else {
      throw err;
    }
  }
  return tableExists;
}

async function selectRows(db, metric, corpusStamp) {
  const { rows } = await db.raw(
    `SELECT bucket, count, sum_cents, computed_at
       FROM tenant_rollups
      WHERE metric = $1 AND corpus_stamp = $2
      ORDER BY count DESC, bucket ASC`,
    [metric, corpusStamp]
  );
  return rows;
}

/** UTC calendar date of a timestamp, 'YYYY-MM-DD'. */
function utcDateOf(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : null;
}

/**
 * @returns {Promise<{rows: {bucket:string, count:number, sumCents:number|null}[], computedAt: Date}|null>}
 */
export async function getMetricRows(db, metric, { today, autoRefresh = true, corpusStamp: precomputedStamp } = {}) {
  if (!ROLLUPS_ENABLED) return null;
  if (!(await probeTable(db))) return null;
  const day = today || new Date().toISOString().slice(0, 10);
  // A caller that already knows the corpus_stamp for this request (e.g. ask.js, right after its
  // own exact-match cache check already computed one via askCache.js) can pass it in to skip a
  // second, redundant STAMP_EXPR aggregate scan — bench finding: at 30k docs this recompute was
  // the entire gap between the rollup read (53ms) and an O(1) indexed lookup.
  const corpusStamp = precomputedStamp ?? (await getCorpusStamp(db, { today: day }));
  if (corpusStamp == null) return null;

  let rows = await selectRows(db, metric, corpusStamp);
  // warranty_status is date-sensitive even with an UNCHANGED corpus_stamp
  // (a unit crosses from 'active' into 'expiring' purely because a day
  // passed) — a same-day-computed row is trusted, anything else forces a
  // recompute regardless of how the corpus_stamp compares.
  const dateSensitiveStale = metric === 'warranty_status' && rows.length && utcDateOf(rows[0].computed_at) !== day;
  if ((!rows.length || dateSensitiveStale) && autoRefresh) {
    const ok = await refreshMetric(db, metric, { today: day });
    if (ok) rows = await selectRows(db, metric, corpusStamp);
  }
  if (!rows.length) return null;
  return {
    rows: rows.map((r) => ({ bucket: r.bucket, count: Number(r.count), sumCents: r.sum_cents == null ? null : Number(r.sum_cents) })),
    computedAt: rows[0].computed_at,
  };
}

/** {bucket: manufacturer name (or 'Unknown'), count}[] — parity with
 *  analytics.js groupBy('brand') on entity_type='equipment'. */
export async function getBrandCounts(db, opts) {
  const r = await getMetricRows(db, 'equipment_brand', opts);
  return r?.rows ?? null;
}

/** {bucket: document_type (or 'Unknown'), count}[]. */
export async function getDocTypeCounts(db, opts) {
  const r = await getMetricRows(db, 'document_type', opts);
  return r?.rows ?? null;
}

/** {bucket: city name (or 'Unknown'), count}[] — parity with deriveGeo. */
export async function getCityCounts(db, opts) {
  const r = await getMetricRows(db, 'customer_city', opts);
  return r?.rows ?? null;
}

/** {bucket: 'active'|'expiring'|'expired'|'unknown', count}[]. */
export async function getWarrantyStatusCounts(db, opts) {
  const r = await getMetricRows(db, 'warranty_status', opts);
  return r?.rows ?? null;
}

/** {count, totalCents} — global open receivable-invoice totals, or null when
 *  unavailable (migration 22/40 missing, or genuinely nothing computed). */
export async function getOpenInvoiceTotals(db, opts) {
  const r = await getMetricRows(db, 'open_invoices', opts);
  const row = r?.rows?.find((x) => x.bucket === 'total');
  if (!row) return null;
  return { count: row.count, totalCents: row.sumCents ?? 0 };
}
