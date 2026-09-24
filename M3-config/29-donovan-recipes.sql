-- ============================================================================
-- 29-donovan-recipes.sql — run AFTER 28-expenses.sql. Idempotent; safe to re-run.
-- OPTIONAL: every code path that uses it tolerates it being absent (warn once,
-- behave exactly as before). Without it Donovan still answers; it just cannot
-- remember worked examples ("recipes") or record what a replay of a miss found.
--
-- Two additions to the Donovan self-learning loop (26-donovan-learning.sql):
--
-- 1. 'recipe' becomes a proposal/learned KIND. A recipe is what a grounded agent
--    answer teaches: {normalized question, the successful run_query SQL, the
--    result's columns, an answer template, a result signature} (see
--    api/_lib/learning/recipes.js). Active recipes are injected into the agent's
--    prompt as worked examples, and an exact-question match is re-executed fresh
--    with no model call. Platform-level like the rest of 26 (no tenant_id): a
--    recipe carries no shop data by construction (recipes.js refuses SQL with
--    data literals and questions that name a customer/address/contact).
--    26's CHECK constraints listed the five original kinds, so they are widened
--    here, and learning_decide() learns to turn an approved recipe into a
--    donovan_learned row (key = md5 of the normalized question).
--
-- 2. ask_miss_replays: TENANT-scoped (same RLS policy as ask_misses). One row per
--    (tenant, normalized question): what happened when Donovan re-ran that miss
--    — 'answered_now' (with the answer) or 'still_failing' (with the reason) —
--    so the Misses card can say "Answered now" or "Still failing" for real.
-- ============================================================================

-- ---- 1. widen the kind CHECKs ------------------------------------------------
ALTER TABLE donovan_proposals DROP CONSTRAINT IF EXISTS donovan_proposals_kind_check;
ALTER TABLE donovan_proposals ADD CONSTRAINT donovan_proposals_kind_check
  CHECK (kind IN ('abbreviation', 'typo', 'synonym', 'few_shot', 'capability_gap', 'recipe'));

ALTER TABLE donovan_learned DROP CONSTRAINT IF EXISTS donovan_learned_kind_check;
ALTER TABLE donovan_learned ADD CONSTRAINT donovan_learned_kind_check
  CHECK (kind IN ('abbreviation', 'typo', 'synonym', 'few_shot', 'recipe'));

-- ---- 2. learning_decide: recipes become learned rows --------------------------
CREATE OR REPLACE FUNCTION learning_decide(p_id UUID, p_status TEXT, p_decided_by TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind    TEXT;
  v_payload JSONB;
  v_key     TEXT;
BEGIN
  IF p_status NOT IN ('approved', 'rejected', 'auto_rejected', 'auto_approved') THEN
    RETURN false;
  END IF;

  UPDATE donovan_proposals
     SET status = p_status, decided_at = NOW(), decided_by = p_decided_by
   WHERE id = p_id
  RETURNING kind, payload INTO v_kind, v_payload;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- capability_gap is informational only — never becomes an overlay entry.
  IF p_status IN ('approved', 'auto_approved') AND v_kind IN ('abbreviation', 'typo', 'synonym', 'few_shot', 'recipe') THEN
    v_key := CASE v_kind
      WHEN 'abbreviation' THEN v_payload ->> 'from'
      WHEN 'typo'         THEN v_payload ->> 'from'
      WHEN 'synonym'      THEN (v_payload ->> 'entity') || ':' || (v_payload ->> 'word')
      WHEN 'few_shot'     THEN md5(v_payload ->> 'question')
      WHEN 'recipe'       THEN md5(v_payload ->> 'question')
    END;

    INSERT INTO donovan_learned (kind, key, value, proposal_id, active)
    VALUES (v_kind, v_key, v_payload, p_id, true)
    ON CONFLICT (kind, key) DO UPDATE
      SET value = EXCLUDED.value, proposal_id = EXCLUDED.proposal_id, active = true;
  END IF;

  RETURN true;
END;
$$;

-- ---- 3. recipe proposal helpers ----------------------------------------------
CREATE OR REPLACE FUNCTION learning_find_recipes(p_question TEXT)
RETURNS SETOF donovan_proposals
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM donovan_proposals
   WHERE kind = 'recipe' AND payload ->> 'question' = p_question
   ORDER BY created_at DESC
   LIMIT 10;
$$;

-- A re-observation of a still-pending recipe: newer payload + evidence (seen count, signature).
CREATE OR REPLACE FUNCTION learning_update_proposal(p_id UUID, p_payload JSONB, p_evidence JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE donovan_proposals
     SET payload = COALESCE(p_payload, payload), evidence = COALESCE(p_evidence, evidence)
   WHERE id = p_id AND kind = 'recipe' AND status = 'pending';
  RETURN FOUND;
END;
$$;

-- ---- 4. ask_miss_replays (tenant-scoped) ---------------------------------------
CREATE TABLE IF NOT EXISTS ask_miss_replays (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_normalized  TEXT NOT NULL CHECK (char_length(question_normalized) <= 300),
  question             TEXT NOT NULL CHECK (char_length(question) <= 300),
  outcome              TEXT NOT NULL CHECK (outcome IN ('answered_now', 'still_failing')),
  reason               TEXT,
  answer               JSONB,
  note                 TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  trace                JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_usd             NUMERIC(8, 4) NOT NULL DEFAULT 0,
  source               TEXT,
  replayed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, question_normalized)
);

CREATE INDEX IF NOT EXISTS idx_ask_miss_replays_tenant ON ask_miss_replays (tenant_id, replayed_at DESC);

ALTER TABLE ask_miss_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_miss_replays FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolate_ask_miss_replays ON ask_miss_replays;
CREATE POLICY tenants_isolate_ask_miss_replays ON ask_miss_replays
  USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (current_setting('app.tenant_id', true))::uuid);

-- ---- 5. grants -------------------------------------------------------------------
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_decide(uuid,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_find_recipes(text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_update_proposal(uuid,jsonb,jsonb) TO %I', r);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ask_miss_replays TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 6. proof ---------------------------------------------------------------------
-- Expect: rls=t, force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'ask_miss_replays';

-- Expect: one row.
SELECT polname FROM pg_policy
 WHERE polrelid = 'ask_miss_replays'::regclass AND polname = 'tenants_isolate_ask_miss_replays';

-- Expect: both kind constraints now list 'recipe'.
SELECT conname FROM pg_constraint
 WHERE conname IN ('donovan_proposals_kind_check', 'donovan_learned_kind_check');
