-- ============================================================================
-- 21-outreach-shop-fields.sql — run AFTER 20-document-uploaded-by.sql.
-- Idempotent; safe to re-run.
--
-- Draft-to-copy outreach (owner brief 2026-09-21, TECH_FILTER_AND_OUTREACH_COPY):
-- "Donovan uses their information to draft the emails." The draft template
-- (api/_lib/outreach.js's renderOutreachEmail) needs the shop's own name,
-- phone number and a sign-off line distinct from `from_name`/`offer_text`
-- (M3-config/18-outreach.sql), so this adds three columns to the existing
-- per-tenant settings row rather than a new table.
--
-- Code guards these columns' absence: api/_lib/routes/outreach.js's
-- outreachSettingsHaveShopFields() (same memoized information_schema-probe
-- idiom as recordsStore.js's documentsHaveUpdatedAt) picks the INSERT/UPDATE
-- column list at write time, and every read already goes through
-- shapeSettings(), which coalesces a missing column to null. A deploy that
-- lands before this migration is pasted just can't persist these three
-- fields yet — nothing else breaks.
--
-- list_outreach_enabled_tenants() (18-outreach.sql) is widened here to also
-- return the three new columns, so the nightly cron sweep's drafts carry
-- them too. Re-running this file is safe: CREATE OR REPLACE FUNCTION is
-- idempotent, and this ALTER TABLE always runs first in the same file.
-- ============================================================================

ALTER TABLE tenant_outreach_settings ADD COLUMN IF NOT EXISTS shop_name  TEXT;
ALTER TABLE tenant_outreach_settings ADD COLUMN IF NOT EXISTS shop_phone TEXT;
ALTER TABLE tenant_outreach_settings ADD COLUMN IF NOT EXISTS signature  TEXT;

CREATE OR REPLACE FUNCTION list_outreach_enabled_tenants()
RETURNS TABLE(tenant_id uuid, tenant_key text, tenant_name text, mode text, lead_days int,
              from_name text, reply_to text, offer_text text,
              shop_name text, shop_phone text, signature text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.clerk_org_id, t.name, s.mode, s.lead_days, s.from_name, s.reply_to, s.offer_text,
         s.shop_name, s.shop_phone, s.signature
    FROM tenant_outreach_settings s
    JOIN tenants t ON t.id = s.tenant_id
   WHERE s.enabled = true
     AND t.clerk_org_id IS NOT NULL
     AND t.billing_status IN ('active', 'trialing')
   ORDER BY s.updated_at ASC NULLS FIRST
   LIMIT 500;
$$;

-- No new column for the outreach-auto-send entitlement: it is stored as
-- tenants.limits->>'outreachAuto' (the same jsonb column billing_apply()
-- already writes PLAN_LIMITS into — see api/_lib/plan.js's
-- hasOutreachAutoEntitlement and api/_lib/billing.js's
-- OUTREACH_AUTO_ADDON_LOOKUP_KEY), so nothing to add here.
