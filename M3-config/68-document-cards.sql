-- DONOVAN-R4 (OPTIONAL, owner runs later; Donovan works without it): a stored copy of each document's "card" (api/_lib/retrieval/cards.js), used only when
-- DONOVAN_CARDS_STORE=1. Cards are otherwise built on the fly from the same stored rows at question time, so nothing breaks if this file is never run.
-- After running it, fill it with: node scripts/build-document-cards.mjs   (reads every organization's documents, writes cards; safe to re-run).
-- Rows are per organization with the same row-level-security rule as every other table; a card holds only text derived from that organization's own rows.
BEGIN;

CREATE TABLE IF NOT EXISTS document_cards (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  card_text TEXT NOT NULL,
  card_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', card_text)) STORED,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_cards_tsv ON document_cards USING GIN (card_tsv);

ALTER TABLE document_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_cards FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_document_cards ON document_cards;
CREATE POLICY tenants_isolate_document_cards ON document_cards
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON document_cards TO %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- proof: expect one row, rls = t and force = t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'document_cards';
