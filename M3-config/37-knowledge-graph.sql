-- ============================================================================
-- 37-knowledge-graph.sql — run AFTER 22-document-financials.sql and
-- 36-job-costing.sql (edges are derived from both). Idempotent; safe to
-- re-run. OPTIONAL: api/_lib/graph/build.js and query.js probe for this table
-- first (kgEdgesTableExist(), same to_regclass-style probe every other
-- optional layer in this codebase uses) and compute the same neighborhood
-- QUERY-TIME, straight off entities/document_entity_links/extractions/
-- document_financials, when it is absent — nothing here is required for the
-- graph feature to work, only for it to be fast/incremental at scale.
--
-- DEEPWELL KNOWLEDGE GRAPH v1 (Obsidian-style second brain): every customer,
-- site/address, unit (equipment), document, technician, invoice/PO and
-- agreement is a NODE (a typed string id — 'customer:<uuid>', 'unit:<uuid>',
-- 'document:<uuid>', 'tech:<normalized name>', 'site:<address key>' — never a
-- new table per node type, so a node is just whatever entities/documents/
-- extractions row it already is) with typed, provenance-carrying EDGES
-- between them. This migration adds exactly one table to hold those edges,
-- pre-computed so a graph read is an indexed lookup instead of a live
-- derivation over every table this touches.
--
--   kg_edges — one row per directed edge. `weight` is a dollar amount or
--              confidence score depending on edge_type (never required);
--              `source` names which underlying table/derivation produced the
--              edge ('document_entity_links' | 'extractions' | 'entities' |
--              'document_financials' | 'job_key'), `source_id` is that row's
--              own id (for a targeted re-derive), and `document_id`/`page`
--              are the citation this edge is backed by — a document node's
--              own id when the edge concerns that document, else null
--              (an 'owns'/'located_at'/'has_unit' edge cites no single
--              document; it is derived from the entities rows themselves).
--
-- RLS: identical tenant policy to every other table here (30/33/36's own
-- header). Grants: none needed; 01b's ALTER DEFAULT PRIVILEGES already
-- covers new tables for deepwell_rls.
-- ============================================================================

CREATE TABLE IF NOT EXISTS kg_edges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_node   TEXT NOT NULL,
  to_node     TEXT NOT NULL,
  edge_type   TEXT NOT NULL,
  weight      NUMERIC(14,4),
  source      TEXT NOT NULL,
  source_id   UUID,
  document_id UUID,
  page        INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backlinks (query.js's getBacklinks) is "everything pointing AT this node" —
-- the (tenant_id, to_node) index is what makes that an index-only lookup
-- instead of a seq scan; (tenant_id, from_node) is the forward-traversal twin
-- getSubgraph's WITH RECURSIVE walks on every hop.
CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges (tenant_id, from_node);
CREATE INDEX IF NOT EXISTS idx_kg_edges_to   ON kg_edges (tenant_id, to_node);
-- build.js's refreshGraphBatch re-derives edges for one document at a time
-- (delete-then-reinsert, so a document that lost a link never leaves a
-- stale edge behind) — this index is what makes that delete targeted.
CREATE INDEX IF NOT EXISTS idx_kg_edges_document ON kg_edges (tenant_id, document_id) WHERE document_id IS NOT NULL;

ALTER TABLE kg_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_edges FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_kg_edges ON kg_edges;
CREATE POLICY tenants_isolate_kg_edges ON kg_edges
  USING (tenant_id = (current_setting('app.tenant_id'))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id'))::uuid);

-- ---- proof -----------------------------------------------------------------
-- Expect: one row, relrowsecurity = true and relforcerowsecurity = true.
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'kg_edges';
