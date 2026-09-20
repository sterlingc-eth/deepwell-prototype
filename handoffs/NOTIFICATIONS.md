# Warranty-expiration notifications

Built by agent-notify. Bell icon in the app + a daily digest email, driven by
the same tier logic `api/warranty-attention.js` already computes.

## What Sterling needs to do

1. **Apply the migration** — paste the SQL below into Neon (or run
   `M3-config/16-notifications.sql` the way the other M3-config files are
   applied). Idempotent; safe to re-run.
2. **Create a Resend account** at https://resend.com.
3. **Verify the sending domain** `deepwelltechnology.com`: Resend → Domains →
   Add Domain → add the TXT/DKIM/MX records it shows to the domain's DNS →
   wait for Resend to mark it verified (usually minutes, can take longer
   depending on the DNS provider's propagation).
4. **Add `RESEND_API_KEY` to Vercel** (Project Settings → Environment
   Variables, Production + Preview) with a key minted from Resend →
   API Keys. Until this is set, the system runs "log-only": in-app
   notifications still work, no email is sent, and every send is logged as
   `channel: 'in-app'`.
5. Optional: set `APP_URL` (defaults to `https://deepwelltechnology.com`) if
   the digest's outreach links should point somewhere else (e.g. a preview
   deployment).

Nothing else is required — the nightly cron (`vercel.json`, already hits
`/api/account?action=sweep` at 09:17 UTC) now also runs the notification
sweep as one more step in that same request.

## Migration SQL (M3-config/16-notifications.sql)

Paste the full contents of `M3-config/16-notifications.sql` into Neon's SQL
editor and run it. The file is idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP
POLICY IF EXISTS` + recreate, `CREATE OR REPLACE FUNCTION`), so re-running it
after a partial apply is safe. It adds:

- `notifications_sent` — dedupe ledger, one row per (tenant, unit, tier) ever
  sent, `UNIQUE (tenant_id, unit_id, tier)`.
- `notifications` — what the bell icon shows (`id, tenant_id, kind, title,
  body, link, created_at, read_at`).
- `list_notification_eligible_tenants()` — SECURITY DEFINER, cross-tenant
  read of active/trialing tenants only (same NOBYPASSRLS problem
  `opsStore.js`'s `listTenantKeys()` already documents; this is the fix for
  the notification sweep specifically).
- `record_warranty_notification(...)` — SECURITY DEFINER, the cron-path
  writer: does the dedupe insert and, only if it was new, the in-app
  `notifications` insert, atomically.
- `mark_tenant_digest_sent(...)` — SECURITY DEFINER, stamps
  `tenants.settings.lastDigestSentAt` so at most one digest goes out per
  tenant per day. Only called after an email actually sent to ≥1 recipient —
  a failed send or a zero-admin org doesn't burn the day's one digest.
- `mark_tenant_notified(...)` — SECURITY DEFINER, stamps
  `tenants.settings.lastNotifiedAt` every time the sweep visits a tenant
  (regardless of outcome) — the fairness marker `list_notification_eligible_
  tenants()` sorts by, oldest/never-visited first, so a tenant skipped by the
  shared deadline leads the next run instead of being starved.

Both tables carry `ENABLE`/`FORCE ROW LEVEL SECURITY` and a
`tenants_isolate_*` policy, same as every other tenant-scoped table in this
schema.

## How it works

- **Engine** (`api/_lib/notify.js`): `computeWarrantyNotifications(tenantCtx,
  today)` reuses `getWarrantyAttention()` (no warranty math duplicated) and
  keeps only the four urgent tiers — `expired`, `expiring-30`, `expiring-90`,
  `unregistered-window-closing` (`expiring-365`/`ok` show on the Dashboard
  but don't page anyone).
- **Dedupe**: a unit is notified once per `(unit, tier)`. A tier change
  (`expiring-90` → `expiring-30` → `expired`) is a *different* tier value, so
  it's a new row and a new notify event — no extra "did it change" check
  needed, the SQL unique constraint + `ON CONFLICT DO NOTHING` in
  `record_warranty_notification` already is that rule.
- **Cron hook** (`api/_lib/routes/cron-sweep.js`): after its existing stuck-
  document recovery, calls `runWarrantyNotificationSweep({ deadlineAt })` with
  ONE shared deadline (45s from the start of the request — `api/account.js`'s
  `maxDuration` is 60s total for every `?action=`). Defaults: 8 tenants/run,
  3s/tenant. If the tenant list would cross the deadline, the sweep stops and
  reports how many tenants it skipped rather than overrunning; skipped
  tenants aren't lost — `mark_tenant_notified` stamps every tenant it DOES
  visit (success or failure) with `settings.lastNotifiedAt`, and
  `list_notification_eligible_tenants()` orders by that ascending, NULLS
  FIRST, so a skipped tenant leads the very next run. Continues past any one
  tenant's error/timeout; folds a summary (incl. `skipped`) into the sweep's
  JSON response and its telemetry line.
- **Email** (`api/_lib/email.js`): `sendEmail()` POSTs to
  `https://api.resend.com/emails` via `fetch` (no new dependency) when
  `RESEND_API_KEY` is set; otherwise logs and returns `{sent:false,
  channel:'in-app'}`. From address: `alerts@deepwelltechnology.com`
  ("DeepWell Technology"). At most one digest per tenant per day
  (`mark_tenant_digest_sent`). Recipients: org admins via
  `@clerk/backend`'s `organizations.getOrganizationMembershipList`, filtered
  to the admin role, capped at 10.
- **Settings**: `tenants.settings.emailDigest` (boolean, default **on**).
  Admin-only toggle on the Team screen ("Notifications" card): "Email me
  warranty digests".

## API — `GET/POST /api/account?action=notifications`

Clerk session required (same auth as every other `/api/account` action).

**`GET`** →
```json
{
  "items": [
    { "id": "uuid", "kind": "warranty", "title": "Expired: Jane Doe",
      "body": "Trane XR16 (#SN123) — Offer an extended warranty or maintenance agreement.",
      "link": "/app/?entity=<unit-uuid>", "createdAt": "2026-09-20T09:17:03Z", "readAt": null }
  ],
  "unreadCount": 3,
  "emailDigest": true
}
```
Unread items first, then newest-first; capped at 50.

**`POST`** — one of:
```json
{ "markRead": ["id1", "id2"] }        -> { "updated": 2 }
{ "all": true }                        -> { "updated": 5 }
{ "settings": { "emailDigest": false } } -> { "settings": { "emailDigest": false, ... } }
```
`settings` requires the admin role in a shop tenant (403 otherwise); `markRead`/`all` work for any signed-in member.

## Frontend

- `src/services/notifyClient.ts` — typed client + pure helpers
  (`unreadBadgeLabel`, `parseNotificationLink`), tested in `scripts/verify-ui.ts`.
- `src/components/NotificationsPanel.tsx` — bell + dropdown, polls every 5
  minutes while the tab is visible, click navigates in-app via
  `appStore.openEntity` (no reload).
- `src/components/AppShell.tsx` — bell mounted next to Billing.
- `src/screens/TeamScreen.tsx` — "Notifications" card, admin-only.

## Tests

- `scripts/verify-notify.mjs` (`npm run verify:notify`, in `verify:all`):
  tier-transition dedupe (`isNewTierEvent`), digest rendering (subject
  pluralization, HTML escaping, per-unit links), recipient cap/dedupe, the
  once-per-day gate, the log-only email fallback, and the shared-deadline
  scheduler (`sweepWithDeadline`: a 20-tenant/3s-each list halts at exactly
  15 processed under a 45s budget, the other 5 report as skipped not
  dropped, and `orderByLastNotified` puts those 5 first for the next run).
- `scripts/verify-ui.ts`: unread badge math, notification-link parsing.

## Known gap

The digest's "Draft outreach" link points at `/app/?entity=<unit-uuid>`
(opens the unit directly) rather than a customer-number link
(`/app/?customer=C-00012`) — `api/_lib/recordsStore.js`'s
`listWarrantyAttention` doesn't currently join through to `customer_number`
and this build doesn't touch that file (owned elsewhere). Whoever owns
`recordsStore.js`/`warranty-attention.js` next could add `customer_number`
to that query's SELECT and this file's `computeWarrantyNotifications` would
pick it up with a one-line change to `renderDigest`'s link construction.
