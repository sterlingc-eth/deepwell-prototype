-- 24-tenant-limits-plan.sql — run AFTER 23-ask-misses.sql. Idempotent.
--
-- rateLimit.js sizes the per-day ask/ingest/read caps from the plan tier it
-- finds in get_tenant_limits(). That JSON only ever carried a plan when an
-- explicit per-tenant override was written, so every ordinary Fleet/Crew/Shop
-- tenant was capped at Solo's daily numbers (the founder account hit "Daily
-- limit of 900 ask units" on 2026-09-21). Fold tenants.plan into the JSON.
-- An explicit limits.plan override still wins (right-hand side of || wins).

CREATE OR REPLACE FUNCTION get_tenant_limits(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('plan', plan)) || COALESCE(limits, '{}'::jsonb)
    FROM tenants
   WHERE id = p_tenant_id;
$$;

-- Proof (read-only): every tenant with a plan now reports it.
--   SELECT id, plan, get_tenant_limits(id)->>'plan' FROM tenants LIMIT 5;
