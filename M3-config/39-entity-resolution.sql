-- ============================================================================
-- 39-entity-resolution.sql — run AFTER 08-review.sql (entities.merged_into) and
-- 15-customer-profiles.sql (customer_number). Idempotent; safe to re-run.
--
-- OPTIONAL, same "nothing breaks if this is not pasted" contract as every
-- M3-config file: api/_lib/entities/resolve.js probes for this table
-- (entityMergeTableExists) and computes clusters ON THE FLY, with no
-- persistence, when it is absent — the admin card still works, it just can't
-- remember a "rejected" decision across requests or record an undo snapshot.
--
-- ENTITY-RESOLUTION CLUSTERING (Round 11, literature review #4): candidate
-- generation (blocking) + pairwise scoring (api/_lib/entities/similarity.js)
-- + connected components groups a tenant's customer entities into clusters
-- that plausibly name the same real person/company. NEVER auto-merged — every
-- row here is a SUGGESTION an admin accepts or rejects
-- (api/_lib/routes/entity-merge.js, Team screen's DuplicateCustomersCard).
--
-- One row per cluster the scan has produced. `cluster_id` is a stable hash of
-- the cluster's entity_ids (see resolve.js's clusterId) so re-running the scan
-- upserts the SAME row for the SAME set of entities rather than piling up
-- duplicates — a cluster that already has a decision (accepted/rejected) is
-- left exactly as it is by a re-scan, never silently reset to pending.
--
-- `previous_state` is what makes "accept" reversible (Round 11 hard rule):
-- taken BEFORE the merge runs — every merged entity's pre-merge `data`/
-- `customer_number`/`merged_into`, plus the exact extraction/document-link/
-- equipment rows that pointed at each dropped entity — so undoEntityMerge can
-- put every pointer back exactly where it was, not just flip merged_into back
-- to NULL. NULL until a suggestion is accepted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS entity_merge_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL,
  entity_ids UUID[] NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  previous_state JSONB,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_merge_suggestions_tenant_status
  ON entity_merge_suggestions (tenant_id, status, score DESC);

ALTER TABLE entity_merge_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_merge_suggestions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_entity_merge_suggestions ON entity_merge_suggestions;
CREATE POLICY tenants_isolate_entity_merge_suggestions ON entity_merge_suggestions
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- proof ------------------------------------------------------------
-- Expect: one row — entity_merge_suggestions, 't', 't' (RLS enabled + forced).
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname = 'entity_merge_suggestions';

-- Expect: one row.
SELECT indexname FROM pg_indexes
 WHERE tablename = 'entity_merge_suggestions' AND indexname = 'idx_entity_merge_suggestions_tenant_status';
