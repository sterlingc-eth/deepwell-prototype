# DeepWell operations notes

Short runbook items for the owner. Security posture lives in `docs/SECURITY.md`.

## Uptime monitor (UptimeRobot, Better Stack, ...)

- **URL:** `https://deepwelltechnology.com/api/account?action=health`
- **Method:** GET (HEAD also works). No authentication, no headers needed.
- **Healthy:** HTTP 200 and body `{"ok":true,"db":true,"time":"2026-09-28T09:17:00.000Z"}`.
- **Unhealthy:** HTTP 503 and `{"ok":false,"db":false,...}` — the database did not answer `SELECT 1` within
  3 seconds. A plain "HTTP status must be 200" monitor is enough; a keyword monitor on `"ok":true` also works.
- **Interval:** 1 to 5 minutes. The endpoint caches its database ping for 5 seconds per warm instance, so a
  short interval cannot load the database. A cold Neon compute (scale-to-zero) can take ~1 second to answer;
  set the monitor to alert after 2 consecutive failures to avoid one-off cold-start noise.
- The body deliberately contains nothing but those three fields. It does not report AI-provider status,
  queue depth or per-shop health.
- Also monitor `https://deepwelltechnology.com/` for the marketing site / app shell.

## Nightly sweep

`GET /api/account?action=sweep` (Vercel Cron, `CRON_SECRET`) recovers stuck and budget-deferred documents,
runs data-integrity repair, dossier catch-up and the knowledge-report jobs for every shop. It finds the shops
through `list_all_tenant_keys()` (`M3-config/60-list-all-tenant-keys.sql`). The sweep's JSON summary now
includes `tenantSource`:

- `"definer"` — normal (migration 60 pasted, every shop visited).
- `"fallback"` or `"none"` — migration 60 is missing (or its owner cannot bypass row-level security): the sweep
  visited **no** shops. Paste the migration, or run the check queries at the bottom of that file.
- `"body"` — a manual run with an explicit `{"tenants": [...]}` list.

## Stripe

- Subscription state normally arrives by webhook. If a webhook is ever missed, the app's own billing status
  call (made on every load and while polling after checkout) asks Stripe directly for a customer whose state
  is still `none` and applies it, so a paying customer is not locked out.
- Add-on price: create the auto-send add-on in Stripe with lookup key **`outreach_auto`** (the older name
  `outreach_auto_addon_monthly` is still accepted). `scripts/stripe-setup.mjs` does not create it.
- Deleting a shop's data (`POST /api/tenant-delete`) cancels its Stripe subscription immediately.
