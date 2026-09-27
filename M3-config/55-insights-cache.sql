-- ============================================================================
-- 55-insights-cache.sql — run AFTER 40-rollups-and-semantic-cache.sql. Idempotent;
-- safe to re-run.
--
-- PROACTIVE INSIGHTS (R17 contract, G1): one row per tenant holding the last
-- computed "Needs attention" list (api/_lib/insights/**), keyed by the SAME
-- corpus_stamp expression api/_lib/rollups/refresh.js already reuses from
-- askCache.js's STAMP_EXPR (via rollups.getCorpusStamp) — one invalidation
-- signal shared by the exact-match ask cache, the rollups, and this table.
--
-- NOTHING BREAKS IF THIS IS NOT PASTED: api/_lib/insights/store.js probes for
-- the table the same tableExists idiom as askCache.js/rollups — every read
-- simply recomputes the insights list on demand (still bounded by this
-- file's own compute budget) instead of reading a cached row.
--
-- One row per tenant (not one row per insight) because the whole "Needs
-- attention" list is small (single-digit cards) and always read/written as
-- one unit — no reason to pay N round trips for N cards.
--
-- RLS: identical tenant policy to every other per-tenant table in this repo
-- (08-review.sql, 17, 31, 40, ...).
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_insights_cache (
  tenant_id     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  corpus_stamp  TEXT NOT NULL,
  payload       JSONB NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_insights_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_insights_cache FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_tenant_insights_cache ON tenant_insights_cache;
CREATE POLICY tenants_isolate_tenant_insights_cache ON tenant_insights_cache
  USING      (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_insights_cache TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- proof -------------------------------------------------------------
-- Expect: one row, rls=t and force=t.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname = 'tenant_insights_cache';
