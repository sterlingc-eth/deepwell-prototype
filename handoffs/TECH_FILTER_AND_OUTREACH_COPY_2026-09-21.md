# Tech filter + outreach draft-to-copy — 2026-09-21

## REQUEST 1 — per-technician "My work / Everyone"

Changed/added:
- `M3-config/20-document-uploaded-by.sql` — new migration (paste below).
- `api/_lib/recordsStore.js` — `documentsHaveUploadedBy()` probe; `createDocument` guarded two-branch INSERT writing `uploaded_by`.
- `api/upload-url.js` — passes `uploaded_by: auth.userId` into `createDocument`.
- `src/core/types.ts` — `Doc.uploadedBy?: string`.
- `src/hooks/usePostgresSync.ts` — reads `row.uploaded_by` onto `Doc`.
- `src/core/workFilter.ts` (new) — pure: `docTechnicianName`, `technicianNameMatches`, `isMineDoc`, `filterDocsForWork`, `defaultWorkFilterChoice`.
- `src/core/memberNames.ts` (new) — `memberDisplayName`, extracted out of `TeamScreen.tsx` so it's shared.
- `src/screens/TeamScreen.tsx` — now imports `memberDisplayName` instead of defining it locally.
- `src/hooks/useMemberDirectory.ts` (new) — Clerk `useOrganization`/`useAuth` → `{userId, displayName, isAdmin, hasShop, nameByUserId}`.
- `src/hooks/useWorkFilter.ts` (new) — wires the pure filter to Clerk identity + per-user `localStorage` persistence + one-time hint flag.
- `src/components/WorkFilterControl.tsx` (new) — the segmented "My work / Everyone" control + hint line.
- `src/screens/ReviewScreen.tsx` (Inbox → "Needs a person") — control rendered above the queue-filter tabs; queue/counts filtered by work scope; uploader chip on each row when viewing Everyone.
- `src/screens/BrowseScreen.tsx` (Records → Documents tab) — same control, `rows` filtered by work scope, uploader chip under each filename when viewing Everyone.
- `scripts/verify-work-filter.mjs` (new, run via `tsx`) — mine-by-uploader, mine-by-technician (case-insensitive, last-name-only match), everyone, default-choice rules (admin/solo/fresh-account → Everyone).
- `package.json` — added `verify:workfilter`, wired into `verify:all`.

Migration to paste (`M3-config/20-document-uploaded-by.sql`):
```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by TEXT;
CREATE INDEX IF NOT EXISTS documents_tenant_uploaded_by_idx
  ON documents (tenant_id, uploaded_by);
```

Decisions: the control lives on Inbox's "Needs a person" queue (not the "Add files" upload tab, where whose-work doesn't apply) and on Records' Documents tab — matching the owner's "Inbox and Records" wording to where a technician actually scans a work list. No new endpoint — `technician` was already flowing to the client via the existing extraction sync. Ask/Donovan is untouched (never filtered).

## REQUEST 2 — outreach: draft-to-copy by default, auto-send as add-on

Changed/added:
- `M3-config/21-outreach-shop-fields.sql` — new migration (paste below).
- `api/_lib/outreach.js` — `renderOutreachEmail` takes `shopPhone`/`senderName`/`signature` (all optional, backward-compatible defaults); new pure `assertModeAllowed(mode, hasEntitlement)` gate.
- `api/_lib/plan.js` — `hasOutreachAutoEntitlement(tenantRow)` reading `tenants.limits.outreachAuto` (reuses the existing `limits` jsonb column `billing_apply()` already writes — no new table).
- `api/_lib/billing.js` — `OUTREACH_AUTO_ADDON_LOOKUP_KEY` constant (the named config point for the add-on's Stripe price — **no Stripe product/price created**, that's the owner's step); `patchForEvent` folds `outreachAuto` into `patch.limits` when a subscription item's `price.lookup_key` matches, byte-identical to before when it doesn't (verified against the existing billing test).
- `api/_lib/routes/outreach.js` — `tenant_outreach_settings` gets `shopName`/`shopPhone`/`signature` (guarded `outreachSettingsHaveShopFields()` probe, same idiom as `recordsStore.js`); `settings`/`saveSettings` responses carry `outreachAutoEntitled`; `saveSettings` refuses `mode:'auto'` with 402 when not entitled; nightly sweep re-checks entitlement per tenant and degrades `auto`→`review` if it was revoked since the setting was saved.
- `src/services/outreachClient.ts` — `OutreachSettings` gains `shopName`/`shopPhone`/`signature`/`outreachAutoEntitled`.
- `src/screens/OutreachScreen.tsx` — "Copy email" and "Open in your mail app" buttons on every draft/approved row (no email provider needed); new Shop name/Shop phone/Signature fields (shop name placeholder prefilled from the Clerk org name); Automatic mode card replaced with an "Auto-send is an add-on · See plans" card when not entitled; header/mode copy updated to "Donovan drafts → you copy/send → (optional add-on) Donovan sends for you".
- `scripts/verify-outreach.mjs` — added cases: template renders shop phone/sender/signature (and falls back exactly as before when unset); `assertModeAllowed` review-always-allowed / auto-refused-without-entitlement; `hasOutreachAutoEntitlement` truthiness cases.

Migration to paste (`M3-config/21-outreach-shop-fields.sql`):
```sql
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
```

Not done / open:
- The add-on entitlement is only merged into `tenants.limits` when a Stripe subscription event also resolves a base plan; a webhook that reports the add-on line item alone (no plan item) isn't handled — rare (Stripe reports the whole subscription's items on every update), flagged in `billing.js`'s comment.
- No Stripe product/price for the add-on — intentionally left to the owner; `OUTREACH_AUTO_ADDON_LOOKUP_KEY` is where to point it once created.

## Verify summary
`npm run typecheck && npm run typecheck:api && npm run lint && npm run verify:all` — all green: **2693 PASS / 0 FAIL** (includes the two new suites above). `npm run build` succeeds.
