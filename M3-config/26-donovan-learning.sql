-- ============================================================================
-- 26-donovan-learning.sql — run AFTER 25-miss-digest.sql. Idempotent; safe to
-- re-run.
--
-- Donovan self-learning loop, Tier 2 "Donovan learns nightly", Part A
-- (handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md): storage for the LEARNING
-- ENGINE — proposed corrections (abbreviations, typo fixes, new entity
-- synonyms, few-shot planner examples, and informational capability-gap
-- notes) and the ones an operator (or an auto-approve rule, in a later part)
-- has actually approved into the live overlay. Code side:
-- api/_lib/learning/store.js (the only writer), api/_lib/learning/overlay.js
-- (the only reader, via learning_list_active()) — both tolerant of this
-- migration not having run yet, same convention as
-- M3-config/23-ask-misses.sql / api/_lib/missStore.js.
--
-- PLATFORM-LEVEL, not tenant-scoped: a learned abbreviation/typo/synonym
-- benefits every tenant equally (it's a fact about the English language and
-- this product's own domain vocabulary, never about one shop's private
-- data), so neither table below carries a tenant_id column at all — same
-- reasoning M3-config/25's own list_ask_misses_window already documents for
-- reading ask_misses across every tenant.
--
-- RLS: "deny everything to the app role except through a SECURITY DEFINER
-- function" — ENABLE + FORCE ROW LEVEL SECURITY with ZERO policies defined
-- on either table. With no policy at all, an ordinary connection (the
-- per-request deepwell_rls/deepwell_app role, which is NOBYPASSRLS) sees and
-- can write NO rows via a plain SELECT/INSERT/UPDATE — the only door in is
-- one of the five SECURITY DEFINER functions below, run as the owning
-- (migration-applying) role, the same shape 25-miss-digest.sql's own
-- cross-tenant functions already use against ask_misses/tenants.
--
--   donovan_proposals  — one row per proposed learning item, whatever its
--                        outcome. kind: 'abbreviation'|'typo'|'synonym'|
--                        'few_shot'|'capability_gap' (api/_lib/learning/
--                        proposals.js's PROPOSAL_KINDS). payload: the
--                        validated {from,to} / {entity,word} / {question,plan}
--                        / {title,example,note} shape for that kind.
--                        evidence: whatever the (future, Part B) nightly
--                        proposer used to justify it (e.g. the miss questions
--                        it was meant to fix) — opaque JSON here, never
--                        parsed by this migration. verification: the
--                        `verifyProposal()` result (api/_lib/learning/
--                        verify.js) recorded at proposal time, so a later
--                        review can see WHY it passed/failed without
--                        re-running the check. status: the proposal's
--                        current lifecycle state. reason: a human- or
--                        machine-written note (a rejection reason, an
--                        approval comment).
--
--   donovan_learned    — one row per ACTIVE (or formerly active) learned
--                        item — what getActiveOverlay() (api/_lib/learning/
--                        overlay.js) actually reads. `key` is a stable
--                        dedup/upsert key per kind (the `from` word for
--                        abbreviation/typo, "<entity>:<word>" for synonym, an
--                        md5 of the question for few_shot) — UNIQUE(kind,
--                        key) lets learning_decide() upsert idempotently
--                        rather than accumulating duplicate rows if the same
--                        item is ever approved twice. `active=false` retires
--                        an item (learning_deactivate) without losing its
--                        history, exactly like documents/entities'
--                        own soft-delete convention elsewhere in this schema.
-- ============================================================================

-- ---- 1. tables -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS donovan_proposals (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind          TEXT NOT NULL CHECK (kind IN ('abbreviation', 'typo', 'synonym', 'few_shot', 'capability_gap')),
  payload       JSONB NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification  JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'auto_rejected', 'auto_approved')),
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_donovan_proposals_status_created
  ON donovan_proposals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS donovan_learned (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind          TEXT NOT NULL CHECK (kind IN ('abbreviation', 'typo', 'synonym', 'few_shot')),
  key           TEXT NOT NULL,
  value         JSONB NOT NULL,
  proposal_id   UUID REFERENCES donovan_proposals(id) ON DELETE SET NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, key)
);

CREATE INDEX IF NOT EXISTS idx_donovan_learned_active
  ON donovan_learned (active, created_at ASC);

ALTER TABLE donovan_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_proposals FORCE  ROW LEVEL SECURITY;
ALTER TABLE donovan_learned   ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_learned   FORCE  ROW LEVEL SECURITY;
-- Deliberately no policies: zero policies + FORCE means an ordinary
-- (non-owner, non-BYPASSRLS) connection can read/write NO rows on either
-- table directly. The five functions below are the only door in.

-- ---- 2. read: the active overlay -------------------------------------------
-- Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md) widened this
-- function's own return shape to also carry `id`/`created_at` — the
-- DonovanLearningCard UI's "active learned items" list needs `id` to send
-- back to learning_deactivate, which the original {kind,key,value}-only shape
-- never carried. Postgres won't let CREATE OR REPLACE change a function's
-- return type in place, so this drops it first; both existing readers
-- (api/_lib/learning/overlay.js/store.js) already do `SELECT *` and only ever
-- destructure kind/key/value, so the two extra columns are inert for them.
DROP FUNCTION IF EXISTS learning_list_active();

CREATE FUNCTION learning_list_active()
RETURNS TABLE (id UUID, kind TEXT, key TEXT, value JSONB, created_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, kind, key, value, created_at FROM donovan_learned WHERE active = true ORDER BY created_at ASC;
$$;

-- ---- 3. write: propose ------------------------------------------------------

CREATE OR REPLACE FUNCTION learning_insert_proposal(
  p_kind TEXT, p_payload JSONB, p_evidence JSONB, p_verification JSONB, p_status TEXT, p_reason TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO donovan_proposals (kind, payload, evidence, verification, status, reason)
  VALUES (p_kind, p_payload, COALESCE(p_evidence, '{}'::jsonb), COALESCE(p_verification, '{}'::jsonb),
          COALESCE(p_status, 'pending'), p_reason)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---- 4. read: proposal queue -------------------------------------------------

CREATE OR REPLACE FUNCTION learning_list_proposals(p_status TEXT, p_limit INT)
RETURNS SETOF donovan_proposals
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM donovan_proposals
   WHERE p_status IS NULL OR status = p_status
   ORDER BY created_at DESC
   LIMIT LEAST(COALESCE(p_limit, 100), 1000);
$$;

-- ---- 4b. read: one proposal by id -------------------------------------------
-- Part B (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md): api/review.js's
-- learningDecide action must RE-VERIFY a proposal against the CURRENT routing
-- bank/vocabulary before approving it (a proposal can go stale between being
-- proposed and an operator clicking Approve) — that needs to read the stored
-- kind/payload back, which RLS otherwise blocks entirely (see this file's own
-- header). Same SECURITY DEFINER shape as every other function here.

CREATE OR REPLACE FUNCTION learning_get_proposal(p_id UUID)
RETURNS SETOF donovan_proposals
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM donovan_proposals WHERE id = p_id;
$$;

-- ---- 5. write: decide (approve/reject), atomically learning on approval ----

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

  -- capability_gap is informational only — never becomes an overlay entry,
  -- regardless of status (see api/_lib/learning/overlay.js's rowsToOverlay,
  -- which would ignore the kind anyway even if a row existed).
  IF p_status IN ('approved', 'auto_approved') AND v_kind IN ('abbreviation', 'typo', 'synonym', 'few_shot') THEN
    v_key := CASE v_kind
      WHEN 'abbreviation' THEN v_payload ->> 'from'
      WHEN 'typo'         THEN v_payload ->> 'from'
      WHEN 'synonym'      THEN (v_payload ->> 'entity') || ':' || (v_payload ->> 'word')
      WHEN 'few_shot'     THEN md5(v_payload ->> 'question')
    END;

    INSERT INTO donovan_learned (kind, key, value, proposal_id, active)
    VALUES (v_kind, v_key, v_payload, p_id, true)
    ON CONFLICT (kind, key) DO UPDATE
      SET value = EXCLUDED.value, proposal_id = EXCLUDED.proposal_id, active = true;
  END IF;

  RETURN true;
END;
$$;

-- ---- 6. write: retire a learned item ----------------------------------------

CREATE OR REPLACE FUNCTION learning_deactivate(p_learned_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE donovan_learned SET active = false WHERE id = p_learned_id;
  RETURN FOUND;
END;
$$;

-- ---- 7. grants ----------------------------------------------------------------

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_list_active() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_insert_proposal(text,jsonb,jsonb,jsonb,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_list_proposals(text,int) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_get_proposal(uuid) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_decide(uuid,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_deactivate(uuid) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 8. proof -----------------------------------------------------------------
-- Expect: rls=t, force=t for both tables.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('donovan_proposals', 'donovan_learned');

-- Expect: 0 rows — no policy exists on either table (the functions are the
-- only door in).
SELECT polname FROM pg_policy
 WHERE polrelid IN ('donovan_proposals'::regclass, 'donovan_learned'::regclass);

-- Expect: six rows, prosecdef = true for each.
SELECT p.proname, p.prosecdef FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('learning_list_active', 'learning_insert_proposal', 'learning_list_proposals',
                      'learning_get_proposal', 'learning_decide', 'learning_deactivate');
