-- ============================================================================
-- 48-donovan-provider-status.sql — run AFTER 26-donovan-learning.sql. Idempotent;
-- safe to re-run. OPTIONAL: every code path that uses this (api/_lib/providerStatus.js,
-- api/_lib/claude.js, api/_lib/learning/store.js) tolerates it being absent — the
-- in-process flag (claude.js's recordProviderOutage/getProviderOutage) still works
-- within one warm serverless instance without it; this migration only adds the
-- cross-invocation, cross-cron-run persistence and a couple of learning-queue
-- additions that ride along with the same round's work.
--
-- ROUND 14 (owner: "71 pending", "36% scorecard", "405 misses, 153 proposals" — all
-- traced to the Anthropic account being out of credits, so every model-needing
-- question fails and gets miscounted as a genuine product failure):
--
--   1. donovan_provider_status — PLATFORM-level (no tenant_id — an Anthropic
--      account outage is a fact about the account, not about one shop's data,
--      same reasoning 26-donovan-learning.sql's own header gives for its two
--      tables), append-only rows: one per outage SIGHTING, closed by
--      `cleared_at` once a model call succeeds again. `provider_status_current()`
--      returns the OLDEST still-open row — that is "since" for the "AI credits
--      exhausted since <time>" message, not the most recent request that
--      happened to hit it. Same "zero policies, SECURITY DEFINER only" RLS
--      shape as donovan_proposals/donovan_learned.
--
--   2. learning_decide_reason — a capability_gap proposal that auto-resolves
--      because its example question is answered now (learning/replay.js) needs
--      a human-readable note ("fixed — answered now") alongside the status
--      change; the existing learning_decide (26) never touches the `reason`
--      column. This is that same function with one more parameter, kept
--      SEPARATE (not a signature change to the widely-called learning_decide)
--      so every existing call site keeps working unmodified.
-- ============================================================================

-- ---- 1. provider status ------------------------------------------------------

CREATE TABLE IF NOT EXISTS donovan_provider_status (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reason      TEXT NOT NULL CHECK (reason IN ('credits', 'auth', 'overloaded')),
  detail      TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_donovan_provider_status_open
  ON donovan_provider_status (detected_at ASC)
  WHERE cleared_at IS NULL;

ALTER TABLE donovan_provider_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE donovan_provider_status FORCE  ROW LEVEL SECURITY;
-- Deliberately no policies — same "the five/six functions are the only door in" shape as
-- donovan_proposals/donovan_learned (26-donovan-learning.sql's own header).

-- Records one sighting. Cheap and idempotent to call often: a wide-open sighting less than 60s old is
-- reused (UPDATEd) rather than piling up a new row per failed request during one outage.
CREATE OR REPLACE FUNCTION provider_status_mark(p_reason TEXT, p_detail TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM donovan_provider_status
   WHERE cleared_at IS NULL AND reason = p_reason AND detected_at > NOW() - INTERVAL '60 seconds'
   ORDER BY detected_at DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE donovan_provider_status SET detail = COALESCE(p_detail, detail) WHERE id = v_id;
  ELSE
    INSERT INTO donovan_provider_status (reason, detail) VALUES (p_reason, p_detail);
  END IF;
  RETURN true;
END;
$$;

-- Closes every currently-open sighting (a successful model call, or an operator's "check now").
CREATE OR REPLACE FUNCTION provider_status_clear()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE donovan_provider_status SET cleared_at = NOW() WHERE cleared_at IS NULL RETURNING 1
  )
  SELECT COUNT(*)::int FROM updated;
$$;

-- The oldest still-open sighting, i.e. "since when has this been down" — or zero rows when the
-- provider is not currently marked unavailable.
CREATE OR REPLACE FUNCTION provider_status_current()
RETURNS TABLE (reason TEXT, detail TEXT, detected_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT reason, detail, detected_at FROM donovan_provider_status
   WHERE cleared_at IS NULL
   ORDER BY detected_at ASC
   LIMIT 1;
$$;

-- ---- 2. learning_decide with a reason note ----------------------------------
-- Identical body to 26-donovan-learning.sql's learning_decide, plus p_reason on the row. A NEW function
-- name (not a signature change to learning_decide) so every existing caller keeps working unmodified.

CREATE OR REPLACE FUNCTION learning_decide_reason(p_id UUID, p_status TEXT, p_decided_by TEXT, p_reason TEXT)
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
     SET status = p_status, decided_at = NOW(), decided_by = p_decided_by, reason = COALESCE(p_reason, reason)
   WHERE id = p_id
  RETURNING kind, payload INTO v_kind, v_payload;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

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

-- ---- 3. list_ask_misses_window: never feed a provider-outage row into the cross-tenant digest or the
-- learning proposer — api/_lib/missStore.js writes those rows with outcome = 'provider-unavailable'
-- (rewritten from whatever outcome the caller asked for, at insert time) specifically so they can be
-- excluded here with one WHERE clause rather than a filter duplicated in every reader.
CREATE OR REPLACE FUNCTION list_ask_misses_window(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  tenant_id            UUID,
  outcome              TEXT,
  question_normalized  TEXT,
  detected_conditions  JSONB,
  count                BIGINT,
  first_seen           TIMESTAMPTZ,
  last_seen            TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.tenant_id,
    m.outcome,
    LEFT(COALESCE(m.question_normalized, m.question), 160) AS question_normalized,
    (ARRAY_AGG(m.detected_conditions ORDER BY m.created_at DESC))[1] AS detected_conditions,
    COUNT(*) AS count,
    MIN(m.created_at) AS first_seen,
    MAX(m.created_at) AS last_seen
  FROM ask_misses m
  WHERE m.created_at >= p_from AND m.created_at < p_to
    AND m.outcome <> 'provider-unavailable'
  GROUP BY m.tenant_id, m.outcome, LEFT(COALESCE(m.question_normalized, m.question), 160)
  ORDER BY count DESC
  LIMIT 5000;
$$;

-- ---- 4. grants ----------------------------------------------------------------

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['deepwell_rls', 'deepwell_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION provider_status_mark(text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION provider_status_clear() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION provider_status_current() TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION learning_decide_reason(uuid,text,text,text) TO %I', r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION list_ask_misses_window(timestamptz,timestamptz) TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ---- 5. proof -----------------------------------------------------------------
-- Expect: rls=t, force=t.
SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'donovan_provider_status';

-- Expect: 0 rows.
SELECT polname FROM pg_policy WHERE polrelid = 'donovan_provider_status'::regclass;
