# DeepWell Technology — START HERE for the next chat (written 2026-09-20)

Paste this file (or point Claude at project doc `claude/START_HERE_NEXT_SESSION.md`) at the start of the new chat.

## What DeepWell is
Cloud document management + AI Q&A for HVAC contractors. Live at https://deepwelltechnology.com (marketing) and /app (product). Owner: Sterling (scchapman94@gmail.com, Mesa AZ). Partner: Hilton.

## Stack (all live)
Vite+React+TS at `src/` · Vercel serverless JS at `api/` (**exactly 12 files — Hobby cap; new routes go in `api/_lib/routes` and dispatch via `api/v1.js ?resource=`, `api/review.js action`, `api/account.js ?action=`**) · Neon Postgres + RLS (migrations `M3-config/01..16`) · Cloudflare R2 (presigned PUT/GET, CORS set) · Inngest queue (read → extract) · Clerk **production** instance on deepwelltechnology.com (orgs enabled) · Anthropic API (Haiku 4.5 default everywhere; Sonnet only for blurry/handwritten page escalation) · Stripe live (products/prices/portal created) · Vercel Web Analytics on.

## Working rules with Sterling (keep these)
- Sterling pushes via GitHub Desktop. **Never run git in his repo.** Write files with `device_commit_files` to `C:\Users\chapman\Desktop\GitHub\deepwell-prototype`, then md5-verify via `device_bash` (svg/png get C2PA metadata injected — size differs, fine). Mirror in the session at `/home/claude/work` (re-stage from repo if a fresh session).
- **Never read, type, or paste credentials** (keys, secrets, connection strings). He pastes them into Vercel/Clerk himself.
- **Never write DDL to production Neon** — he pastes migrations in the SQL editor (paste SQL text, not filenames).
- Every build goes through the dedicated reviewer agent before it ships (GO/NO-GO). Cheapest model that works (sonnet agents; haiku in product).
- Product tone: plain English, no pipeline jargon (see `handoffs/UX_FLOW_SPEC_2026-09-19.md`). Nav is exactly Ask · Inbox · Records · Dashboard.

## What shipped (12+ reviewed rounds, ~1,700 verify checks green)
Auto-classification (15 types) + AI auto-verify · delete · Open original · Ask grounding + model-free meta router · new IA + jargon removal · API & UI break-tests · adversarial backend hardening (budget guard, advisory locks, tenant-keyed concurrency, PG rate limiter) · multi-unit extraction + month-precision dates · 20-item website launch checklist · Stripe billing (checkout/portal/webhook/gating/trial) · **customer profiles with C-00001 numbers** (list, profile page, timeline, assign/merge) · **Team screen** (Clerk org invites, seats vs plan) · **prompt caching fixed** (prefixes now above Haiku's 2048 minimum, 1h TTL on ingest) + cost cuts · **warranty notifications** (in-app bell + daily email digest via Resend, tier-transition dedupe).
Docs in repo `handoffs/`: TEAM_BRIEF, UX_FLOW_SPEC, QA_API_LIMIT_TEST, QA_UI_BREAK_TEST, ADVERSARIAL_AUDIT, WEBSITE_LAUNCH_CHECKLIST, STRIPE_BRIEF, BILLING_RULES, CUSTOMER_PROFILES_BRIEF, ORG_INVITES_AUDIT/TEST_PLAN, COST_REPORT, NOTIFICATIONS.

## Sterling's to-do (in order) — nothing else is blocking launch
1. **Push** the latest repo state (56 files from the last round + the Stripe round before it).
2. **Neon SQL editor, paste in order:** `M3-config/14-billing.sql`, `15-customer-profiles.sql`, `16-notifications.sql` (12 and 13 are applied). Then comp your own shop: `SELECT id,name,clerk_org_id FROM tenants;` → `UPDATE tenants SET plan='fleet', billing_status='active', current_period_end=now()+interval '10 years' WHERE clerk_org_id='org_…';`
3. **Vercel env:** `STRIPE_SECRET_KEY` (Stripe → Developers → API keys, live), `STRIPE_WEBHOOK_SECRET` (Stripe → Webhooks → Add endpoint `https://deepwelltechnology.com/api/billing?action=webhook`, events: checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed), `RESEND_API_KEY` (create resend.com account, verify domain via its DNS records, then key). Redeploy after.
4. **Clerk Google sign-in:** Client ID is already filled in Clerk → SSO connections → Google; paste the Client secret from Google Cloud (project "DeepWell Technology" → Clients → "DeepWell Web (Clerk)") and Save. Then test Google sign-in in incognito.
5. **Sign in to production Clerk** (email code), create the org, send me its `org_…` id → I give you one SQL line to re-point the 8 test documents to the new org (they're under the old dev org `org_3JIT4XsBtHexHbrjnnKvwfWBUNZ`).
6. **Anthropic console:** add funds + auto-reload ($1.53 left). **Vercel Pro** before real customers. Counsel pass on privacy/terms.
7. Test invites with two emails per `handoffs/ORG_INVITES_TEST_PLAN.md`.

## First things Claude should do in the new chat
1. Confirm the push deployed (`curl -sI https://deepwelltechnology.com/app/`), then live-walk: Records → Customers tab shows C-00001…; a profile page loads; bell icon; Team screen; Billing screen; Ask still 10/10 on the Desert Peak answer key (test-docs/README-ANSWER-KEY.md) **on Haiku**; burst-test /api/ask 36× → expect 429s (rate limiter).
2. Then the open items: Records/Inbox ergonomics second pass (Sterling: "the records page and inbox page maybe could fix the logical flow"), digest links should use `?customer=C-…` (needs customer_number in listWarrantyAttention), extended-warranty upsell emails, Drive sync / email intake, Records Rescue vendor, Google OAuth app verification (to remove the "unverified app" screen).

## Known non-blocking gaps
Seat cap is advisory (Clerk can't hard-block invites) · non-admin's pre-invite solo uploads aren't merged into the org · multi-unit docs cap 25 units · 429 messages now show wait time · Clerk dev-keys warning gone once prod keys deployed.
