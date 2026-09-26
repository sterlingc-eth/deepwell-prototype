-- ============================================================================
-- 38-chunk-context.sql — run AFTER 31-semantic-search.sql. Idempotent; safe to
-- re-run. OPTIONAL, same "nothing breaks if this is not pasted" contract as
-- every M3-config file: the code probes for this column
-- (api/_lib/search/store.js's contextVersionReady) and behaves identically
-- without it — headers still get built and embedded (that needs no schema
-- change at all), the code just can't tell an old chunk's embedding from a
-- new one, so a re-embed backfill has no cheap way to target only what
-- changed.
--
-- CONTEXTUAL CHUNK HEADERS (round r10c, evidence: Anthropic's "Contextual
-- Retrieval" reports large drops in retrieval failures from adding chunk
-- context before embedding). Every chunk embedded from now on has a short,
-- deterministic header prepended before embedding — document type, customer,
-- site address, unit brand/model/serial, service date, technician, invoice
-- number — built from data this tenant's own extraction pipeline already
-- produced (api/_lib/search/embed.js's buildChunkContextHeader). NO MODEL
-- CALL is involved in building it; it is a plain string template.
--
-- context_version says which header generation (if any) a chunk's embedding
-- reflects:
--   0                       = no header — a chunk embedded before this
--                             feature existed, or while DONOVAN_CHUNK_CONTEXT=0
--   CURRENT_CONTEXT_VERSION = the header buildChunkContextHeader produces
--                             today (see embed.js; bumped only if the header's
--                             shape changes enough to be worth a re-embed)
--
-- semanticBackfill (api/review.js — admin/owner-only, billing-gated,
-- rate-limited, capped by the tenant's daily embedding token budget) re-embeds
-- any chunk whose context_version is behind the current one, using the SAME
-- resumable/idempotent loop it already used for "never embedded yet" pages —
-- see store.js's pagesNeedingEmbedding. The most common reason a chunk starts
-- out behind: the ingest hook embeds a document's pages right after OCR, one
-- pipeline step BEFORE that document's own extraction runs (extraction is a
-- separate, later step — see readDocument.js/extractDocument.js/queue.js), so
-- its FIRST embedding usually has no structured facts to build a header from
-- yet. The backfill is what catches it up once extraction has landed.
-- ============================================================================

ALTER TABLE page_chunks ADD COLUMN IF NOT EXISTS context_version INTEGER NOT NULL DEFAULT 0;

-- Lets the backfill find "this tenant's chunks behind the current context
-- version" without a full-table scan, tenant-first (every other page_chunks
-- index in this migration set is tenant-first for the same reason — see
-- 17-ask-cache-and-search-index.sql's own note on that).
--
-- PLAIN CREATE INDEX (no CONCURRENTLY), deliberately, same call as
-- 17-ask-cache-and-search-index.sql's own composite index and for the same
-- reason: this whole file is meant to be pasted and run together (Neon SQL
-- editor, or this repo's own migration-harness tests) as ONE transaction —
-- and CREATE INDEX CONCURRENTLY cannot run inside a transaction block at all,
-- so putting it in this file would silently roll back the ALTER TABLE above
-- along with it the moment CONCURRENTLY failed, leaving context_version
-- missing with no error surfaced anywhere but a paste that "did nothing".
-- A brief lock on page_chunks while this index builds is the same cost every
-- other migration here already accepts. If a tenant's page_chunks has grown
-- large enough that this matters in practice, rebuild it later with CREATE
-- INDEX CONCURRENTLY instead, run BY ITSELF outside any transaction (psql
-- with autocommit, one statement at a time — see 13-entity-uniqueness.sql).
CREATE INDEX IF NOT EXISTS idx_page_chunks_tenant_context_version
  ON page_chunks (tenant_id, model, context_version);

-- ---- proof ------------------------------------------------------------
-- Expect: one row — context_version, integer, not null, default '0'.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'page_chunks' AND column_name = 'context_version';

-- Expect: one row.
SELECT indexname FROM pg_indexes WHERE tablename = 'page_chunks' AND indexname = 'idx_page_chunks_tenant_context_version';
