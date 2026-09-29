# Round 25 — first-client readiness (engineering + full QA)

Base: production f2c9af0. Team: reliability engineer (production errors), readiness engineer,
launch architect (audit), website QA, app QA, independent reviewer (GO; 5 nits fixed).
Full audits: docs/reports/r25-client-readiness.md, r25-website-qa.md, r25-app-qa.md.

## Fixed — production errors (from Vercel logs)
- **Stripe webhook never applied a subscription change** (billing_record_event returned boolean > 0).
  Fixed in M3-config/59 (paste!) + code works before the paste. Record+apply now one transaction, so a
  failed apply is retried by Stripe instead of dropped as a duplicate. Plan found on any subscription item.
  Pull-based reconcile on the billing status call so a missed webhook can't lock out a paying shop.
- Link-sweep SQL type error ($2::text), concurrent queries on one DB client (serialized), empty-id guards
  (clean 401 instead of SQL errors), response watchdog (honest 504 instead of platform timeout), pg SSL
  warning, friendly message when the AI provider fails (never raw JSON).

## Fixed — client-readiness
- Nightly sweep now reaches every shop (M3-config/60 — paste!; was a silent no-op under RLS).
- Delete: covers all 41 tenant tables (test fails if a new table is forgotten), cancels the Stripe
  subscription first, audit row; **new self-serve "Delete this shop" in Team → Settings** (admin, typed
  shop name). /security wording matches.
- Export: no 5,000-row cap (paged/streamed, resume token, list of original files).
- Stripe customer gets the shop name + admin email; add-on key `outreach_auto` (old key still accepted).
- `GET /api/account?action=health` for an uptime monitor (docs/OPERATIONS.md).
- Customers API paging (limit/cursor/q), backward compatible.

## Fixed — QA
- Website: placeholder founder bios replaced (review wording), pricing now shows real Donovan usage caps
  (was "Unlimited"), unmeasured claims removed, phone menu added, contrast/focus, robots.txt, legal pages.
- App (15 defects): header off-screen at 390–1100 px (blocker), onboarding contrast, Ask chips stuck on
  skeleton for new shops, raw "500 Internal Server Error" shown to owners, phantom failed uploads,
  canceled shop offered a new trial, field-theme contrast, profile Call/Email links, and more.

## Numbers
All 121 suites green (incl. new verify:prod-hardening 92, verify:readiness 184, verify:app-qa 70),
typecheck app+api, oxlint, build. Offline exam unchanged: 1426 correct / 12 wrong; p95 52 ms (was 89).

## OWNER ACTIONS before the first client (in order)
1. Push in GitHub Desktop.
2. Neon SQL editor: paste M3-config/59-billing-record-event-fix.sql, then 60-list-all-tenant-keys.sql
   (run its proof queries; next sweep log should say tenantSource "definer"). Also 58 if not yet.
3. Vercel: upgrade to Pro (Hobby is non-commercial). Add SENTRY_DSN and RESEND_API_KEY (+ SPF/DKIM).
   Neon: use the -pooler host; move off Free for backups/always-on.
4. Stripe: confirm live mode + activated account; create add-on price lookup key `outreach_auto`;
   enable receipts + failed-payment emails.
5. Clerk: confirm production instance; check org member cap vs Crew/Fleet seats; Google OAuth verification.
6. Decide: "Logins: Unlimited" on pricing vs the app's seat count (1/4/10) — which is true?
7. Contact: one professional support address (not gmail), legal entity/address, counsel review of Terms.
8. Uptime monitor on /api/account?action=health.
9. Live Donovan test with the new credits — see "Live test" below.

## Live test ($20 credits)
Dry run ($0) then real run with a $6 budget, locally (Option A in docs/LIVE_TEST_DAY.md):
  node scripts/live-test-day.mjs scripts/golden/golden-export.json --dry-run --budget=6
  node scripts/live-test-day.mjs scripts/golden/golden-export.json --budget=6
Keeps ~$14 for real client usage. Share docs/reports/live-test-day-<date>.json back for analysis.
