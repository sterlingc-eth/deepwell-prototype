/**
 * Precomputed rollups (R11 literature #10): write side. Table: M3-config/
 * 40-rollups-and-semantic-cache.sql (tenant_rollups). Degrades gracefully —
 * every function here is a no-op (never throws) when the table doesn't
 * exist yet, same tableExists-probe idiom as api/_lib/askCache.js.
 *
 * ONE STAMP FOR BOTH CACHES: corpus staleness is decided by calling
 * api/_lib/askCache.js's own getCacheEntry with a synthetic question_hash
 * that will never collide with a real cached answer, reusing its
 * STAMP_EXPR (documents/extractions/links/entities aggregates) rather than
 * re-deriving a second, potentially-drifting "has the data changed" query.
 * A fixed promptVersion keeps this file's own stamp independent of
 * ask_answer_cache's PROMPT_VERSION (which reacts to prompt/tool-schema
 * changes that have nothing to do with rollup correctness).
 *
 * METRICS this file knows how to compute (see read.js for the read side):
 *   equipment_brand      — count of equipment entities by manufacturer
 *   document_type        — count of documents by document_type
 *   warranty_status       — count of equipment entities by warranty tier
 *                           (active/expiring/expired/unknown) — date-
 *                           sensitive, so read.js ALSO checks computed_at's
 *                           calendar date, not just corpus_stamp.
 *   customer_city        — count of customer entities by derived city
 *   open_invoices         — single 'total' bucket: count + sum(open_balance)
 *                           of unpaid/partial receivable invoices (global,
 *                           no customer filter — the one hot aggregate;
 *                           requires migration 22 too, else skipped)
 *
 * Every bucket value is produced EXACTLY the way api/_lib/analytics.js's own
 * groupBy already buckets the live-SQL path (UNKNOWN_BUCKET, deriveGeo,
 * warrantyStatusOf are imported and reused, never reimplemented) — see
 * scripts/verify-rollups.mjs's parity checks.
 */
import { logOnce } from '../rateLimit.js';
import { getCacheEntry } from '../askCache.js';
import { UNKNOWN_BUCKET, deriveGeo, warrantyStatusOf } from '../analytics.js';
import { buildViewsSql } from '../agent/tools.js';
import { extractionsHaveUnitIndex } from '../recordsStore.js';
import { financialsTableExists } from '../financials/store.js';

export const ROLLUPS_ENABLED = process.env.DONOVAN_ROLLUPS !== '0';
export const METRICS = Object.freeze(['equipment_brand', 'document_type', 'warranty_status', 'customer_city', 'open_invoices']);

/** Fixed, rollup-private prompt version: never reacts to ask_answer_cache's
 *  own PROMPT_VERSION churn (a prompt wording tweak does not change whether
 *  a brand count is stale). Bump this string only if a bug in one of THIS
 *  file's own bucket computations needs every existing rollup dropped. */
const ROLLUP_STAMP_EPOCH = 'rollups-v1';

let tableExists = null;
export function _resetRollupsStateForTests() {
  tableExists = null;
}

async function probeTable(db) {
  if (tableExists !== null) return tableExists;
  try {
    await db.raw('SAVEPOINT tenant_rollups_probe', []);
    await db.raw('SELECT 1 FROM tenant_rollups LIMIT 0', []);
    tableExists = true;
  } catch (err) {
    if (err?.code === '42P01') {
      await db.raw('ROLLBACK TO SAVEPOINT tenant_rollups_probe', []).catch(() => {});
      tableExists = false;
      logOnce('tenant_rollups', err);
    } else {
      throw err;
    }
  }
  return tableExists;
}

/**
 * The tenant's current corpus_stamp, reusing askCache.js's own aggregate
 * expression (see module doc comment above) — one signal, two caches.
 * @returns {Promise<string|null>} null only if ask_answer_cache's own table
 *   is unreachable/missing AND that codepath's stamp-only fallback failed
 *   too (getCacheEntry never throws either way, per its own contract).
 */
export async function getCorpusStamp(db, { today } = {}) {
  const day = today || new Date().toISOString().slice(0, 10);
  const { corpusStamp } = await getCacheEntry(db, {
    questionHash: '__rollups_freshness_probe__',
    today: day,
    promptVersion: ROLLUP_STAMP_EPOCH,
  });
  return corpusStamp ?? null;
}

async function replaceMetricRows(db, metric, corpusStamp, buckets) {
  await db.raw('DELETE FROM tenant_rollups WHERE metric = $1 AND tenant_id = (current_setting(\'app.tenant_id\', true))::uuid', [metric]);
  for (const b of buckets) {
    await db.raw(
      `INSERT INTO tenant_rollups (tenant_id, metric, bucket, count, sum_cents, corpus_stamp, computed_at)
       VALUES ((current_setting('app.tenant_id', true))::uuid, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (tenant_id, metric, bucket) DO UPDATE
         SET count = EXCLUDED.count, sum_cents = EXCLUDED.sum_cents,
             corpus_stamp = EXCLUDED.corpus_stamp, computed_at = NOW()`,
      [metric, b.bucket, b.count, b.sumCents ?? null, corpusStamp]
    );
  }
}

async function computeEquipmentBrand(db) {
  const { rows } = await db.raw(
    `SELECT COALESCE(NULLIF(trim(data->>'manufacturer'), ''), $1) AS bucket, count(*)::bigint AS count
       FROM entities
      WHERE entity_type = 'equipment' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid
      GROUP BY 1`,
    [UNKNOWN_BUCKET]
  );
  return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
}

async function computeDocumentType(db) {
  const { rows } = await db.raw(
    `SELECT COALESCE(NULLIF(trim(document_type), ''), $1) AS bucket, count(*)::bigint AS count
       FROM documents
      WHERE tenant_id = (current_setting('app.tenant_id', true))::uuid
      GROUP BY 1`,
    [UNKNOWN_BUCKET]
  );
  return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
}

/** JS-side grouping (not SQL) so this is GUARANTEED to bucket identically to
 *  the live analytics path — deriveGeo/warrantyStatusOf are the SAME pure
 *  functions api/_lib/routes/analytics.js's shapeEquipmentRow/
 *  shapeCustomerRow call, imported (never re-implemented) — see the module
 *  doc comment. Cheap at refresh time even for a large tenant: one column
 *  fetched, one pass in memory, no model/network call. */
async function computeCustomerCity(db) {
  const { rows } = await db.raw(
    `SELECT data->>'service_address' AS address
       FROM entities
      WHERE entity_type = 'customer' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid`,
    []
  );
  const counts = new Map();
  for (const r of rows) {
    const city = deriveGeo(r.address).city || UNKNOWN_BUCKET;
    counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  return [...counts.entries()].map(([bucket, count]) => ({ bucket, count }));
}

async function computeWarrantyStatus(db, today) {
  const { rows } = await db.raw(
    `SELECT data->'warranty' AS warranty
       FROM entities
      WHERE entity_type = 'equipment' AND merged_into IS NULL AND tenant_id = (current_setting('app.tenant_id', true))::uuid`,
    []
  );
  const counts = new Map();
  for (const r of rows) {
    const status = warrantyStatusOf(r.warranty, today) || UNKNOWN_BUCKET;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([bucket, count]) => ({ bucket, count }));
}

/** Global (no customer filter) open-invoice totals — the EXACT predicate
 *  api/_lib/financials/answers.js's receivables() uses for the unfiltered
 *  case (direction='receivable', doc_kind='invoice', currency='USD',
 *  status IN ('unpaid','partial'), open_balance > 0), computed via the same
 *  `financials` CTE (buildViewsSql) so a correction or a status edit is
 *  reflected exactly like the live path — this rollup is a cached RESULT of
 *  that query, never a re-derivation of its business rules. */
async function computeOpenInvoices(db) {
  if (!(await financialsTableExists(db))) return null;
  const hasUnitIndex = await extractionsHaveUnitIndex(db);
  const views = buildViewsSql({ hasUnitIndex, hasFinancials: true });
  const { rows } = await db.raw(
    `WITH ${views}
     SELECT count(*) FILTER (WHERE f.status IN ('unpaid','partial') AND f.open_balance IS NOT NULL AND f.open_balance > 0)::bigint AS n,
            COALESCE(sum(f.open_balance) FILTER (WHERE f.status IN ('unpaid','partial') AND f.open_balance > 0), 0) AS total
       FROM financials f
      WHERE f.direction = 'receivable' AND f.doc_kind = 'invoice' AND f.currency = 'USD'`,
    [JSON.stringify({ c: [], e: [] })]
  );
  const row = rows[0] ?? { n: 0, total: 0 };
  return [{ bucket: 'total', count: Number(row.n), sumCents: Math.round(Number(row.total) * 100) }];
}

const COMPUTE = {
  equipment_brand: (db) => computeEquipmentBrand(db),
  document_type: (db) => computeDocumentType(db),
  customer_city: (db) => computeCustomerCity(db),
  warranty_status: (db, { today }) => computeWarrantyStatus(db, today),
  open_invoices: (db) => computeOpenInvoices(db),
};

/**
 * Recompute ONE metric for the current tenant and replace its rows. Never
 * throws: a failure (missing table, missing migration 22 for open_invoices,
 * a transient error) is caught, logged at most once per 10 min, and leaves
 * whatever rollup rows already existed untouched — a stale-but-present
 * rollup is still better than none, and read.js's own freshness check will
 * simply keep trying on the next read.
 */
export async function refreshMetric(db, metric, { today } = {}) {
  if (!ROLLUPS_ENABLED || !METRICS.includes(metric)) return false;
  if (!(await probeTable(db))) return false;
  const day = today || new Date().toISOString().slice(0, 10);
  try {
    await db.raw('SAVEPOINT rollup_refresh', []);
    const corpusStamp = await getCorpusStamp(db, { today: day });
    if (corpusStamp == null) {
      await db.raw('ROLLBACK TO SAVEPOINT rollup_refresh', []).catch(() => {});
      return false;
    }
    const buckets = await COMPUTE[metric](db, { today: day });
    if (buckets == null) {
      // e.g. open_invoices without migration 22 — nothing to store, not an error.
      await db.raw('ROLLBACK TO SAVEPOINT rollup_refresh', []).catch(() => {});
      return false;
    }
    await replaceMetricRows(db, metric, corpusStamp, buckets);
    return true;
  } catch (err) {
    await db.raw('ROLLBACK TO SAVEPOINT rollup_refresh', []).catch(() => {});
    logOnce(`tenant_rollups:${metric}`, err);
    return false;
  }
}

/**
 * Recompute every known metric for the current tenant. This is the function
 * an ingest hook should call — see "INGEST HOOK" below — but it is also
 * exactly what read.js's own lazy-refresh-on-stale-read calls, so nothing
 * ever depends on the hook actually being wired up: a rollup left stale by
 * a missed hook call is simply refreshed the next time anyone asks for it.
 */
export async function refreshAllRollups(db, { today } = {}) {
  const results = {};
  for (const metric of METRICS) results[metric] = await refreshMetric(db, metric, { today });
  return results;
}

/* ================================================================ INGEST HOOK
 *
 * Wherever a document finishes ingestion and is linked/verified (the ingest
 * pipeline's own owner should place this — likely api/_lib/queue.js's
 * link/verify step, or reviewStore.js's verifyDocument, whichever runs LAST
 * per document), call:
 *
 *   import { refreshAllRollups } from './rollups/refresh.js';
 *   await refreshAllRollups(db, { today: todayIso() }); // fire-and-forget is fine
 *
 * inside that same tenant transaction. This is deliberately OPTIONAL — see
 * refreshAllRollups's own doc comment: read.js recomputes lazily on any
 * stale read regardless, so skipping this hook only means the FIRST ask
 * after a data change pays the live-SQL cost once (exactly what already
 * happens today with no rollups at all) rather than the ingest step paying
 * it eagerly.
 */
