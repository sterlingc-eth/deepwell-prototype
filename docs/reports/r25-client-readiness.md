# DeepWell first-paying-client readiness audit (2026-09-28)

Scope: main = production (f2c9af0), read-only review of /home/claude/dw (api/**, src/**, M3-config/*.sql, vercel.json, package.json, public/*.html, handoffs/*.md, docs/SECURITY.md). No files edited, no secrets read or printed. Vercel MCP was used only to list the team (name "chappy", slug chappy420; no plan/billing field returned).

Legend: status = have / partial / missing. Type = CODE (engineers can do now) or OWNER (dashboard, account, legal). Effort: S <= half day, M ~1-2 days, L > 2 days.

Confidence notes: things I verified in code are cited file:line-ish. Things about Clerk/Stripe/Vercel/Neon dashboards or vendor policy are from code comments, handoff docs, or my own knowledge and are marked UNVERIFIED where I could not confirm them.

---

## A. RANKED MUST-HAVES BEFORE HOSTING A PAYING CLIENT

### M1. Vercel plan = Pro (commercial use) -- OWNER, S
- Status: missing (as far as the owner to-do list says). Owner to-dos still list "Vercel Pro". Code comments claim Pro (`api/account.js` "maxDuration 300 (Vercel Pro, 2026-09-25)", `api/ask.js:238` maxDuration 300), yet handoffs/START_HERE_NEXT_CHAT.md says "Exactly 12 files directly under api/ (Vercel Hobby)". Team slug `chappy420` looks like the auto-created personal (Hobby) team. UNVERIFIED which plan is live.
- Why: Vercel's Hobby plan terms restrict it to non-commercial, personal use. Taking money for a SaaS on Hobby is a terms violation and Vercel can pause the project without notice. I am confident of the rule, less sure of the exact current wording (check vercel.com/docs/limits/fair-use-guidelines). Pro also gives 800s max duration vs 300s, more concurrency, spend management, team seats, and log retention.
- Also affects: cron on Hobby is once/day and timing is imprecise (vercel.json has one daily cron `17 9 * * *`, fine); 300s function durations were only available on Hobby with Fluid Compute, so the `maxDuration: 300` values may already be silently clamped if Fluid is off. Check the project's Fluid Compute setting and plan.

### M2. Stripe webhook is the only path from "paid" to "unlocked", and it is not atomic -- CODE, M (+ OWNER check)
- Evidence: `api/billing.js` handleWebhook: `billing_record_event()` (idempotency insert) runs, then `billing_apply()` runs as a separate query on the pool with no transaction. If apply throws (this is exactly the SQL bug currently in production), the event is already recorded as "seen", Stripe retries, and the retry returns `reason: "duplicate"` with 200. The tenant is never updated.
- Hard gate compounds it: `plan.js` `requireActiveBilling` blocks every model/storage path for `none`/`canceled`, and `App.tsx` shows only Billing. A customer who paid but whose webhook failed is locked out of a product they paid for.
- Fix: (a) wrap record+apply in one transaction, or delete the ledger row on apply failure; (b) add pull-based reconciliation: on `?billing=success` (App.tsx polling loop already exists) and in the nightly sweep, call `stripe.subscriptions.list({customer})` and apply the same `patchForEvent` mapping; (c) owner: confirm in the Stripe dashboard that the endpoint subscribes to exactly `WEBHOOK_EVENTS` (`billing.js:~end`) and that failed deliveries alert by email; (d) add an owner-visible "tenants paid but status none" check.
- Related: event ordering is not handled (no `event.created` comparison), so an older `subscription.updated` delivered late can overwrite a newer one. Low probability, cheap to guard.

### M3. Stripe live mode activated, live keys, live webhook, live prices -- OWNER, S-M
- Evidence: code reads only `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (`api/_lib/billing.js:getStripe`), no publishable key is used (Checkout and Portal are plain redirects, `docs`/R22 audit confirms no `@stripe/stripe-js`). So there is no `pk_` pattern to inspect. The Vercel facts say both vars exist "production only", which is the right scoping, but nothing in the repo tells me whether they are `sk_live_` or `sk_test_`. Prices are found by `lookup_key` (`solo_monthly`, `solo_annual`, `shop_*`, `crew_*`, `fleet_*`, `records_rescue_page`) and the plan is read from `price.metadata.plan` (`planFromSubscriptionItem`), which `scripts/stripe-setup.mjs` sets. Live mode needs `stripe-setup.mjs` run against the live key (products/prices/portal config do not copy from test mode) or `plan` will resolve to null and `limits` will never be written.
- Checklist: Stripe account activation (business details, bank, identity), live prices with lookup keys and `metadata.plan`, live webhook endpoint with a live `whsec_`, Customer Portal configured in live mode, statement descriptor, receipt emails ON (Dashboard > Settings > Emails), Smart Retries + failed-payment emails ON, run one real $ charge and refund it.
- Add-on mismatch (CODE, S): `OUTREACH_AUTO_ADDON_LOOKUP_KEY = 'outreach_auto_addon_monthly'` (`billing.js`) but owner notes and START_HERE say the price is named `outreach_auto`. If the owner creates the price with the name in the notes, the add-on never grants entitlement. Pick one and write it in the owner checklist.
- Cosmetic (CODE, S): `findOrCreateCustomer` names the Stripe customer with the Clerk org id (`name: auth.orgId`), and passes no email, so invoices and receipts will read "org_2abc..." instead of the shop name. Pass the org name and the admin's email.
- Tax: `automatic_tax: { enabled: false }` on every session. OWNER decision with an accountant: B2B SaaS in AZ is generally not taxable, but other states differ (some tax SaaS). Not a day-one blocker for one AZ client; decide before client #2 outside AZ.

### M4. Clerk production instance confirmed end to end -- OWNER, S (verify) -- CODE none
- Evidence: `src/main.tsx` reads `VITE_CLERK_PUBLISHABLE_KEY` only from env, nothing hardcoded. Circumstantial evidence it is already production: `vercel.json` CSP allows `https://clerk.deepwelltechnology.com` (a custom Frontend API domain only production instances have), and handoffs/CONVERSATION_EXPORT_2026-09-20.md documents creating the production instance and swapping keys on 2026-09-20. But the CSP also keeps `*.clerk.accounts.dev` (dev domain) and every build-time verify uses `pk_test_dummy`, so I cannot prove the deployed bundle has `pk_live_`. Verify by loading /app and checking the console for the "Clerk has been loaded with development keys" warning, or the Vercel env var prefix (read the first 8 chars in the dashboard).
- Google sign-in: production needs your own OAuth client (CONVERSATION_EXPORT lines ~1281-1284). Until Google verification finishes, either hide the Google button in Clerk or accept the "unverified app" screen (100-user cap for unverified external apps). Scopes are only email/profile, so verification is normally quick but needs the privacy policy URL, a verified domain, and a real homepage.
- Clerk org membership cap: UNVERIFIED, but Clerk's default max members per organization is small (I recall 5). Crew (10 techs) and Fleet would hit it. Check Clerk Dashboard > Organizations > Settings and raise it.

### M5. Data protection: backups and a real restore window -- OWNER, S
- Evidence: handoffs/CONVERSATION_EXPORT_2026-09-20.md ~1769 records that Neon Free has 6-hour history retention (Launch up to 7 days, Scale 30) and scales to zero (0.5-1s cold start). The advice then was "upgrade at the first paying customer". I cannot see the current Neon plan. `docs/DEEPWELL_BUILD_SPEC.md` DB-01 says 30-day PITR + nightly logical dump to a second region, which is a spec, not reality.
- Do: upgrade Neon to Launch or above before the client's first upload (7-day PITR, always-on), confirm the `-pooler` host is in `NEON_CONNECTION_STRING` (code warns at `recordsStore.js:83` if not), take one manual `pg_dump` and test-restore it once. R2 has no versioning or backup configured in anything I read: enable R2 object versioning or a lifecycle rule, or accept that a bad delete (`document-delete`, `tenant-delete`) is permanent.
- Free tier also caps storage at 512 MB; at ~3-5 KB per page a real shop import will reach that fast (`page_chunks` embeddings add more).

### M6. Tenant delete is incomplete and contradicts the published claims -- CODE, M
- Evidence: `api/_lib/opsStore.js` `DELETE_ORDER` covers 12 tables (extractions, facets, document_pages, documents, proposals, schema_versions, entities, audit_log, users, api_keys, usage_counters, document_entity_links). The `tenants` row is deliberately kept, so `ON DELETE CASCADE` from `tenants` never fires. Tables that only reference `tenants` (not documents) survive a "delete all my data": `ask_misses` (question text), `ask_answer_cache`, `ask_semantic_cache` (cached answers can hold customer names/phones), `dossiers`, `kg_edges`, `knowledge_reports`, `notifications`, `notifications_sent`, `outreach_messages` (customer email addresses), `tenant_outreach_settings`, `tenant_rollups`, `tenant_insights_cache`, `entity_merge_suggestions`, `intake_field_inferences`, `embedding_usage`, `rate_limit_windows`, `support_access_grants`, `staff_access_log`, `donovan_learned_tenant`, `donovan_promoted_tests`, `donovan_scorecard_*`. (`page_chunks`, `document_financials*`, `intake_needs_info` cascade from documents and are fine.) `scripts/verify-ops.mjs:111` asserts "exactly the twelve tables", so the test enforces the gap.
- Contradictions: `docs/SECURITY.md` says delete "wipes every tenant-scoped table"; `public/security.html` says you can delete "your account entirely, at any time, from account settings"; `public/privacy.html` says removal on request. Delete also does not cancel the Stripe subscription (no Stripe call anywhere in `tenant-delete.js`) and does not delete the Clerk org, so a customer who "deletes everything" keeps being billed.
- Fix: generate the delete list from `information_schema` (all tables with a `tenant_id` column except `tenants` and `tenant_deletions`), cancel the Stripe subscription in the same route, document that the Clerk org is removed separately (or call the Clerk backend API), and update verify-ops to compare against the schema instead of a hardcoded list.

### M7. Export is capped, metadata-only -- CODE, M
- Evidence: `opsStore.js:164` `EXPORT_ROW_CAP = 5000` per table, with a `truncated` flag; `storage_key` excluded and no file bytes are returned, so the export is JSON of extracted text/fields, not the customer's original PDFs and photos. A 20k-document shop gets a truncated file with no originals.
- Why it matters: "you own your data / export anytime" is a headline promise (terms s.4, security.html) and the first serious client will ask. Also `maxDuration: 60` on the export route will time out for large tenants.
- Fix: paginated/streamed export (or an async job that writes a zip to R2 and emails a presigned link), including original files via 15-minute presigned GETs. Until then say "metadata export; originals on request" honestly on the pages.

### M8. Nightly cron only works for the notification/outreach subset in production -- CODE, M
- Evidence: `cron-sweep.js` loops over `listTenantKeys()` for stuck-document recovery, budget-deferred retries, integrity repair, dossier catch-up, knowledge reports. `opsStore.js:145` documents (and its own comment admits) that under FORCE RLS as `deepwell_rls` this "returns an empty array every time" in production, and the request-body fallback needs someone to POST tenant keys. Only the warranty-notification, outreach, and follow-up steps use SECURITY DEFINER listings (`list_notification_eligible_tenants`, M3-config/16, 18). handoffs/NOTIFICATIONS.md line 42 confirms the pattern was a workaround, not a fix.
- Consequence: the message the customer sees, "Daily processing limit reached -- resumes tomorrow" (`queue.js DAILY_BUDGET_EXCEEDED_MESSAGE`), is not literally true in production: nothing re-attempts those documents overnight. A bulk import that hits the daily model cap leaves documents parked until someone re-uploads. Stuck-doc recovery is also effectively off.
- Fix: one SECURITY DEFINER `list_all_tenants()` (id, clerk_org_id, name, billing_status) mirroring the notification one; point `listTenantKeys()` at it. SQL to paste plus a small code change. Also make the sweep report its own health (see M10).

### M9. Blind operations: no error monitoring, no alerts, no owner email -- OWNER + CODE, S-M
- Evidence: no `SENTRY_DSN` (per Vercel facts); `telemetry.js` then only writes a structured `console.error`. No `RESEND_API_KEY`: `email.js` returns `{sent:false, channel:'in-app'}` and only logs a hash. `DEEPWELL_OWNER_ALERT_EMAILS` is set but useless without Resend (`missDigest.js:440`). Nothing pages the owner when: the webhook fails, Anthropic credits run out (there is a persisted provider-outage marker, `providerStatus.js`, but nothing sends it anywhere), the cron fails, or Inngest runs fail. The browser has no error reporter at all (backend-only `@sentry/node`).
- Do (OWNER, S): create a Sentry project and set `SENTRY_DSN` (the scrubbing pipeline in `telemetry.js` is already built and tested); create a Resend account, verify `deepwelltechnology.com` (SPF/DKIM) so `alerts@deepwelltechnology.com` can send, set `RESEND_API_KEY`; set Vercel spend-management alerts; set Anthropic console usage alerts and auto-recharge; add an external uptime monitor (Better Stack / UptimeRobot free) on `/` and a health URL; add Stripe and Inngest failure email notifications; enable Vercel Log Drain or at least know the runtime-logs URL.
- Do (CODE, S-M): a tiny `/api/v1?resource=health` (or account action) that does `SELECT 1` and reports provider outage state; send an owner email (through Resend) when `markProviderOutage` fires, when the sweep summary has `errors.length`, and when the webhook returns 500. Add an Inngest failure handler (`onFailure`) that calls `captureException`.
- Privacy pages list Sentry and Resend as subprocessors while neither is active. Not wrong (forward-looking), but `docs/SECURITY.md` is the only place that admits "no DSN" -- align wording or turn them on before signing the client.

### M10. Bulk import of existing paperwork collides with the plan page caps -- CODE (policy) + OWNER (pricing), M
- Evidence: plan caps in `plan.js` PLAN_LIMITS: pagesPerMonth Solo 750, Shop 2,000, Crew 5,000, Fleet 10,000, enforced in `gateUpload` (`api/upload-url.js`) on a trailing-30-day count of `document_pages`. A shop's backlog is typically thousands to tens of thousands of pages. The first import will 402 with "Monthly page limit reached" after a fraction of it, on day one, for the first client. The only sold answer is Records Rescue ($0.12/page, 4,167-page minimum, `billing.js RECORDS_RESCUE`), but that is a payment-mode Checkout with no fulfillment code: `patchForEvent` ignores it beyond storing the customer id, and nothing grants an import allowance. `handoffs/QA...` and the corpus tests show the mechanics work (browser zip/folder import with backoff, `bulkImport.ts`, batches of 50 presigned files, 24 MB per PDF/photo, 20 MB per text file, 100 MB hard cap, `MAX_BATCH_FILES = 50`, per-tenant ingest 60 units/min and 2,000/day, Inngest throttle 40/min, daily model-call cap 2,000).
- Throughput and cost numbers: median ~6 s per document to "extracted" under load (CONVERSATION_EXPORT round 5); 40/min throttle means ~2,400 docs/hour theoretical, ~1,000 docs/day practical under the 2,000 model-calls/day cap (transcribe + extract = about 2 calls/doc). Cost: about $0.012 per PDF and $0.006 per text file on Haiku (BUSINESS_CORPUS line 165-171; 604-doc corpus about $7), roughly $0.02-0.03 per document in the live limit test (61 docs about $1-2). Multi-page scans cost more per document. Rule of thumb: $12-25 of Anthropic spend per 1,000 documents, plus Voyage embeddings (small).
- Gaps: uploads run in the browser tab (close it and it stops; no server-side resume); the "resumes tomorrow" path is broken by M8; the customer has no visible import progress across days.
- Do: (CODE) a per-tenant one-time "onboarding import allowance" (e.g. `tenants.limits.importPages` consumed before the monthly cap, granted manually or by the Rescue purchase); (OWNER) decide what the first client is told: "your first import is free up to N pages" vs Rescue; (CODE) make the daily-cap resume real (M8).

### M11. Support and legal surfaces are placeholders -- OWNER (+ tiny CODE), S-M
- Evidence: `index.html:762` and `:771` still ship "Placeholder bio" text for both founders on the live marketing site. Contact is a personal Gmail (`deepwellincorporated@gmail.com` in index.html, privacy.html, terms.html, security.html) plus `hello@deepwelltechnology.com` on the Records Rescue button (no evidence the mailbox exists). No `support@`, no in-app Help/Contact/Feedback anywhere in `src` (grep found only mailto links for customer emails), no status page, no docs/help center. All three legal pages carry an HTML comment "Template prepared for DeepWell -- review with counsel before relying on it". `terms.html` s.6 refund text was a placeholder in the 2026-09-19 checklist (now filled, but never counsel-reviewed). The footer `tel:` placeholder `+10000000000` was flagged 2026-09-19; verify it is gone.
- Missing legal items: DPA (the first B2B client with customer PII in work orders will ask), breach-notification commitment (`docs/SECURITY.md` says none published), post-cancellation retention period ("how long do you keep my data after I cancel?" is not answered anywhere), auto-renewal disclosure, uptime/SLA disclaimer, subprocessor-change notice. Entity: pages say "DeepWell Inc." -- confirm the entity really exists (Arizona filing, EIN, business bank account that Stripe pays into).
- Do: real founder bios (OWNER, S); `support@deepwelltechnology.com` mailbox + a "Help / Contact support" link in the AppShell account area and in the mobile app (CODE, S); one-page DPA template and a retention sentence (OWNER with counsel, M); lawyer review of terms/privacy (OWNER, M, ~ $500-1,500 flat-fee).

### M12. Dry-run the whole first-client path on live production with a real card -- OWNER + CODE, S-M
- Path as coded: marketing pricing CTAs link to `#contact` (mailto), not sign-up (WEBSITE_LAUNCH_CHECKLIST item 20; `?plan=` survives sign-up per QA_WEBSITE); sign-up (Clerk) -> `OnboardingScreen` (create shop via Clerk `CreateOrganization`, or join by invite) -> hard gate shows only Billing (`App.tsx:351`) -> Checkout redirect (`SUCCESS_URL https://deepwelltechnology.com/app/?billing=success`) -> polling until webhook flips status -> first upload -> first answer. Solo trial is 30 days, card required (`billing.js createCheckoutSession`); Shop/Crew/Fleet have no trial and charge immediately.
- Risks to rehearse: webhook lag/failure (M2); the tenant name stored as the Clerk org id; new-user first load on a cold Neon (Free tier scale-to-zero, M5); Google button state (M4); an invitee accepting an invite; the card-required trial failing SCA/3DS; the customer closing the Checkout tab (CANCEL_URL toast "nothing was charged").
- Run it once with the owner's own card in live mode using a throwaway org, then refund.

---

## B. FULL CHECKLIST BY AREA

### 1. Onboarding
| Item | Status | Evidence / notes | Type / effort |
|---|---|---|---|
| Sign-up -> create shop -> plan -> checkout | partial | OnboardingScreen, hard gate, Checkout redirect all exist (see M12). No guided first-run beyond redirect to upload when empty (`App.tsx:166-173`). | CODE S (welcome checklist) |
| Team invites and roles | have (UI), partial (enforcement) | Clerk `OrganizationProfile` for admins; roles collapse to admin/member (`auth.js normalizeOrgRole`); admin-only routes gated. Seat cap is advisory only: `handoffs/ORG_INVITES_AUDIT.md` s.4 admits it, and no `technicians` check exists server-side (grep of api/ finds none). Clerk's own org member cap may block larger shops (M4). | CODE S (server check on upsertMember) + OWNER (Clerk setting) |
| Invite email delivery | have (Clerk sends) | Clerk sends invite emails from its own domain; branding/sender is a Clerk dashboard setting. | OWNER S |
| Bulk import | partial | See M10. Limits: 50 files per presign batch, 24 MB PDF/photo, 20 MB text, 100 MB ceiling, 60 ingest units/min, 2,000/day, 40 concurrent-per-minute Inngest throttle, zip walked client-side in the browser. "Add files" 429 retry was fixed (LIMIT_TEST_FIXES). | see M10 |
| First upload -> first answer | have | Median 6 s per document, 61-doc limit test 27/30 ask accuracy, 12/12 customers, merge traps held. Offline exam 1,426/1,704 correct with $0 model spend (ROUND24). | none |
| Tech-facing "getting started" doc | missing | No help content in repo beyond `public/get/index.html` (mobile install). | CODE S / OWNER (write it) |

### 2. Billing correctness
| Item | Status | Evidence / notes | Type / effort |
|---|---|---|---|
| Live vs test mode | unknown | Only `STRIPE_SECRET_KEY` is used; no publishable key in code. Cannot tell mode from repo. See M3. | OWNER S |
| Price lookup | have | lookup_key scheme `${plan}_monthly|annual`, `records_rescue_page`; missing price throws a clear error. Plan derived from `price.metadata.plan`; live setup script must be re-run. | OWNER S |
| Webhook events | have (6 events) | checkout.session.completed, subscription created/updated/deleted, invoice.paid, invoice.payment_failed. Not handled: `customer.subscription.trial_will_end` (no reminder email), `invoice.payment_action_required`, refunds/disputes, `customer.updated`. Signature verified with 300 s tolerance (`verifyStripeSignature`), fail-closed without secret. Non-atomic record/apply (M2). | CODE M |
| Trials | have | Solo only, 30 days, card required, `missing_payment_method: 'cancel'`, `trial_used` set permanently. An expired trial reads as `none` immediately (`planStateFor`). | none |
| Failed payment / dunning | partial | `invoice.payment_failed` -> `past_due`; 7-day grace then uploads blocked, ask stays read-only (`plan.js`). Grace is measured from `current_period_end` (`isPastGrace`), but on a renewal failure Stripe has already advanced `current_period_end` to the NEXT period, so effective grace is likely about 37 days, not 7. UNVERIFIED against a live failed renewal; test with a Stripe test clock. Dunning emails themselves are Stripe dashboard settings (Smart Retries, failed payment emails). App banner exists (`AppShell` past_due). | CODE S + OWNER S |
| Cancellation | have | Portal with `subscription_cancel: at_period_end`; `cancel_at_period_end` mirrored; `customer.subscription.deleted` -> canceled -> hard gate. No data-retention clock after cancel (M11). | CODE S (retention job) |
| Proration | have (Stripe) | Portal `subscription_update` with `proration_behavior: create_prorations`, price changes only. Plan limits update on the following `subscription.updated`. | none |
| Receipts / invoices | partial | Stripe-hosted; Portal shows invoice history. Customer name = Clerk org id, no email set on the customer (M3). | CODE S + OWNER S |
| Tax | missing (decision) | `automatic_tax` off everywhere. | OWNER (accountant) |
| Add-on price | partial | Lookup key mismatch (M3). | CODE S |
| Records Rescue | partial | Payment Checkout only; no fulfillment/tracking; the 4,167-page floor is enforced in code. | OWNER (process) |
| Rate limit on checkout/portal | have | `billing` bucket 6/min, 60/day (R22). | none |

### 3. Tenant isolation and security
| Item | Status | Evidence | Type / effort |
|---|---|---|---|
| RLS on every table | have (on paper) | 50+ tenant tables in M3-config all ENABLE+FORCE with `app.tenant_id` policy; app role `deepwell_rls` NOSUPERUSER NOBYPASSRLS (`01b-app-role.sql`). Platform-level tables (donovan_learned, donovan_proposals, provider_status) have FORCE with zero policies (deny-all, accessed via SECURITY DEFINER). Live proof needs one query: `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class ...` across all public tables plus `SELECT rolbypassrls FROM pg_roles WHERE rolname='deepwell_rls'` -- there is no evidence in the repo that this was run against production after migrations 24-58. | OWNER S (run query) |
| Migration 58 (support access) | partial | Not pasted in production per owner notes. Code tolerates its absence, but then the Settings > Support access card and access log will show empty/false, and `docs/SECURITY.md`/`security.html` describe that feature as live. Paste before the client sees the security page. | OWNER S |
| API auth on every route | have | `scripts/verify-security.mjs` route-auth inventory fails the build if a route lacks auth; R22 audit found 0 critical. Webhook uses signature; cron uses `CRON_SECRET` fail-closed; Inngest execution fails closed without `INNGEST_SIGNING_KEY` (introspection GET open, accepted). Tenant derives only from verified Clerk claims. | none |
| R2 presigned URLs scoped by tenant | have | Object key `tenantId/sha[:2]/sha`, presign minted server-side after `withTenant` check; GET 15 min (upload-url.js), PUT 15 min. `docs/SECURITY.md` says 120 s read / 60 s delete in `r2.js`; upload-url.js uses 900 s. Doc and code disagree; fix the doc or the TTL. | CODE S |
| Rate limits | partial | Postgres-backed per-tenant per-minute/day buckets (ask 20/min 900/day; ingest 60/min 2,000/day; read 120/min 5,000/day; billing 6/min). QA noted the burst limiter was "effectively decorative" before Postgres backing (fixed round 5). Limiter fails open on lookup failure by design. No per-IP limit for unauthenticated routes (few exist). No WAF/Vercel Firewall rules in vercel.json. | OWNER S (Vercel firewall rules) |
| CSP / headers | have | Full CSP, HSTS, nosniff, frame-ancestors (R22). `script-src` still needs `'unsafe-inline'` (inline scripts in index.html and app/index.html). HSTS in vercel.json lacks `preload` while the checklist said preload; harmless. | CODE M (later) |
| Support-access audit | have (code), unverified (live) | `support_access_grants`, `staff_access_log`, gates on operator actions, `scripts/verify-privacy.mjs` 115 checks. Break-glass is trust-based (documented). | see migration 58 |
| Dependency vulns | partial | `npm audit`: 1 critical, 6 high, all transitive under devDependency `@vercel/node`; postcss fixed. `package-lock.json` is out of sync so `npm ci` fails (Vercel uses `npm install`). | CODE S |
| Secrets rotation | partial | Earlier handoffs note secrets appeared in screenshots and rotation was owner-side ("rotate Neon/R2/Clerk secrets", CONVERSATION_EXPORT line 128). Confirm done. | OWNER S |
| Founder bypass | check | `DEEPWELL_FOUNDER_TENANT_ID` exempts the founder tenant from support-access gating and `99-founder-testing-limits.sql`/`35-test-account-limits.sql` lift limits. Confirm those migrations only touch the founder/test tenants and not a default. | CODE S (review) |

### 4. Data protection
| Item | Status | Evidence | Type / effort |
|---|---|---|---|
| Backups / PITR | missing (as of last known Neon plan) | M5. | OWNER S |
| Export | partial | M7. | CODE M |
| Delete | partial | M6. | CODE M |
| Retention policy | missing | No stated retention after cancel; no job that purges canceled tenants. Privacy page says deletion "within our normal processing cycle" without defining it. | OWNER + CODE S |
| Privacy/terms/security page accuracy | partial | Inaccurate or unproven: "delete your account entirely from account settings" (M6); Inngest "job identifiers only" (privacy.html) vs SECURITY.md "document content passes through" (verify what `queue.js` puts in events); Sentry/Resend listed though inactive; support-access described as live before migration 58; export claims originals-level "your data". Template comments say "review with counsel". Sub-processor tables agree with each other after R22 fix. | OWNER + CODE S |
| DPA | missing | M11. | OWNER |
| Breach notification | missing | SECURITY.md "not yet done". | OWNER |
| /security page | have | public/security.html, last reviewed 2026-09-28. | none |

### 5. Reliability and operations
| Item | Status | Evidence | Type / effort |
|---|---|---|---|
| Error monitoring | missing | M9. | OWNER S |
| Alerting to owner | missing | M9 (Resend absent). The nightly miss digest email also never leaves the building. | OWNER S |
| Uptime/status page | missing | Nothing in repo. | OWNER S |
| Cron health | partial | One daily cron (`17 9 * * *`), `CRON_SECRET` auth, shared 45 s deadline inside a 60-300 s function; sweep result only goes to `captureMessage` (console with no DSN). M8 for the empty tenant list. No "last successful run" visible anywhere. | CODE S |
| Inngest failures | partial | Retries and per-tenant concurrency configured (`queue.js`); `retries` semantics documented; no failure alerting; Inngest dashboard alerts are an owner setting. Queue disabled without INNGEST keys (they are set). | OWNER S + CODE S |
| Cost controls per tenant | have | Daily model-call cap 2,000 (`rateLimit.js DEFAULT_MAX_MODEL_CALLS_PER_DAY`, override in `tenants.limits.maxModelCallsPerDay`); monthly ask allowance per plan (3,000/9,000/22,500/60,000) with UI meter; per-question token caps; per-tenant daily $ caps for Sonnet ($2 default), research ($10), retrieval ($5), analytics ($1) via `DONOVAN_*_DAILY_USD` (unset in prod, so defaults apply); learning loop $0.25/tenant, $10/platform per night. `verify:spend-control` exists. | none |
| Global AI spend cap | missing | The `_DAILY_USD` caps are per-tenant (`escalation.js` buckets keyed by tenant), and the only platform-wide cap is the nightly learning loop. There is no global daily ceiling across all tenants and no hard stop on the Anthropic account. Set an Anthropic monthly spend limit in the console and low-balance alert (OWNER S). | OWNER S |
| Credits run out again | have (graceful) | `classifyProviderError` (claude.js) detects credits/auth/overloaded and sets an outage flag persisted in `donovan_provider_status` (migration 48); Ask returns an honest "provider unavailable" instead of a wrong answer; `verify:provider-outage`. But no one is told (M9) and ingestion during an outage needs the M8 retry to recover. | see M9 |
| Neon connections / cold starts | partial | Pooled endpoint check and pool max 3 per instance (`recordsStore.js:116`), aux pool for usage. Production error "concurrent pg queries" being fixed separately. Free-tier scale-to-zero adds 0.5-1 s cold start (M5). | OWNER S |
| Function durations | partial | ask/review/account 300 s, read-document/extract/inngest/v1 60 s, billing 30 s. 60 s per Inngest step is the ceiling for a big scanned PDF (24 MB cap). Requires Pro (M1) for anything above 60 s on non-Fluid; verify. | OWNER S |
| Vercel Hobby vs Pro | see M1 | | |

### 6. Email
| Item | Status | Evidence | Type / effort |
|---|---|---|---|
| Team invites | have | Clerk-sent, independent of Resend. | none |
| Password reset / verification | have | Clerk-sent. Production Clerk email templates and sender domain are dashboard settings. | OWNER S |
| Warranty digests, outreach, follow-ups, miss digest | missing in prod | All go through `sendEmail`, which without `RESEND_API_KEY` logs only and reports `channel:'in-app'`. In-app bell still works (`notify.js`). Outreach defaults to "draft to copy" so nothing customer-facing is emailed unless a tenant opts into the paid add-on. Digest opt-in needs a working sender. | OWNER S (Resend + domain DNS) |
| Deliverability | missing | `alerts@deepwelltechnology.com` needs SPF/DKIM/DMARC on the domain in Cloudflare. | OWNER S |

### 7. Support and owner admin tools
| Item | Status | Evidence | Type / effort |
|---|---|---|---|
| In-app help / contact | missing | M11. | CODE S |
| Onboarding docs | missing | | OWNER/CODE |
| Owner view of a client's health | partial | Operator actions exist in `api/review.js` (missDigest, learning, scorecard) and per-tenant billing/usage shown to the tenant (`/api/billing?action=status`: docs, pages, asks, AI cost estimate). No owner-facing tenant list (which tenants, plan, last activity, spend today, failed docs). `listTenantKeys` cannot enumerate tenants (M8). Any look at a client's content requires their support-access grant (by design), so health metrics must be aggregate-only. | CODE M |
| Refund / manual plan override | missing | No admin tool; done in Stripe dashboard and raw SQL only. | OWNER |

### 8. Donovan
| Item | Status | Evidence | Type / effort |
|---|---|---|---|
| Honest failure modes | have | Deterministic fast paths, honest fallbacks ("I can count X, but can't filter by Y"), money questions never fabricate, typo-name chips instead of guessing (ROUND24), provider outage message, daily budget message. Terms s.5 has the AI disclaimer. | none |
| Per-plan allowances | have | See cost controls. UI never says "questions" by owner decision. | none |
| Latency | have | Offline exam p50 28 ms, p95 89 ms for no-model answers; model answers depend on Anthropic (ask maxDuration 300 s, agent deadline 240 s default). | none |
| Accuracy claims | have (guarded) | START_HERE: do not publish an accuracy percent for business questions until measured live at >= 97%. Keep that rule on the marketing page. | none |
| Learning loop across tenants | partial | Autopilot runs per tenant nightly under caps; but `listTenantKeys`-style enumeration may not reach tenants (M8) and the miss digest aggregates redacted text across tenants (documented residual in PRIVACY doc: names can still appear). Tell the client in the DPA that anonymized aggregates are used, or opt tenants out. | OWNER + CODE S |

### 9. Mobile PWA
| Item | Status | Evidence | Type / effort |
|---|---|---|---|
| Install | have | `public/m/manifest.webmanifest` (standalone, scope /m/, 192/512/maskable icons, shortcuts), `sw.js` never caches /api, `/get` install page + QR, `InstallGuide.tsx`. Testing was emulation (iPhone 13/SE/Pixel 7 in CDP, ROUND23_MOBILE), not real devices. | OWNER S (install on a real iPhone and Android, upload a camera photo, go offline) |
| Offline queue | have | `src/mobile/offline`, `verify:offline-queue`. | none |
| Camera permission | have | Permissions-Policy `camera=(self)`. | none |

### 10. Legal and business
| Item | Status | Type / effort |
|---|---|---|
| Vercel Hobby prohibits commercial use | risk (M1). Confident about the rule; verify current wording. | OWNER S |
| Clerk production instance | likely done, verify (M4) | OWNER S |
| Google OAuth verification | pending per owner list; consent screen needs privacy/terms/homepage on the verified domain | OWNER M (days of Google review) |
| Stripe activation | unknown (M3) | OWNER S-M |
| Anthropic terms and tier | Anthropic account credits ran out once; check tier and enable auto-recharge; confirm commercial API terms (they are the default for API accounts) | OWNER S |
| Business entity, bank, sales tax, insurance | not evidenced anywhere; "DeepWell Inc." used on legal pages | OWNER |
| Terms/privacy counsel review | template comments still in the files | OWNER M |
| Refund policy | present in terms s.6; keep consistent with Stripe Portal behavior | OWNER S |

---

## C. SHOULD-HAVE IN THE FIRST 30 DAYS
1. Owner tenant-health dashboard: list of tenants (plan, status, docs, pages, asks, today's model calls and $, failed/stuck docs, last activity), built on the SECURITY DEFINER tenant list from M8. CODE, M.
2. Server-side seat enforcement against `PLAN_LIMITS.technicians` (upsertMember or a Clerk webhook). CODE, S-M.
3. Trial-ending and payment-failed emails from our side (`customer.subscription.trial_will_end`, `invoice.payment_failed` -> owner + tenant admin). CODE, S.
4. Stripe test-clock run for: trial -> paid, failed renewal (verify the real grace length), cancel at period end, upgrade proration. CODE/OWNER, S.
5. Event-order guard on webhook (`event.created` vs stored `billing_updated_at`) and stripe reconciliation cron. CODE, S.
6. Async export to zip with originals via presigned links; emailed. CODE, M-L.
7. Post-cancel retention job (for example export offer at day 0, purge at day 60) and stated policy. CODE M + OWNER.
8. Purge and lifecycle for R2: object versioning, orphan cleanup after `tenant-delete` failures (`failedObjects` is recorded but nothing retries). CODE S.
9. Status page (Better Stack/Instatus) and a public incident email address. OWNER S.
10. Browser error reporting (Sentry browser SDK with the same scrubbing, plus CSP `connect-src`). CODE S-M.
11. Nonce/hash CSP to drop `'unsafe-inline'`. CODE M.
12. Vercel Firewall rules (rate-limit /api by IP, bot protection on sign-up); Cloudflare Turnstile is already allowed by CSP. OWNER S.
13. Help center: 6-8 short pages (first import, invite a tech, install the mobile app, what Donovan can/cannot answer, billing FAQ). OWNER/CODE M.
14. In-app "Report a problem" that posts a redacted context blob to a support inbox (Resend). CODE S.
15. Upgrade path for bulk import: server-side resumable import (sweep-driven) so closing the tab does not stop it; progress banner across days. CODE M-L.
16. Dependency upgrade round (`@vercel/node` major, lockfile sync, `npm ci` green). CODE S-M.
17. Per-tenant `maxModelCallsPerDay` sized per plan (currently one default of 2,000 for all plans) and a global daily $ ceiling. CODE S.
18. Verify RLS live with a scripted probe: create two orgs, upload to A, try IDOR from B across every route (verify-tenant-isolation exists but ran against fixtures/local; run it on preview against production-like data). CODE S.
19. Review the founder/test-limit migrations (35, 99) to be sure they cannot leak lifted limits to real tenants. CODE S.
20. Decide sales-tax/Stripe Tax and add to Checkout when the first out-of-state client appears. OWNER S.

---

## D. QUICK REFERENCE: what to tell the first client honestly
- Support is by email (once support@ exists); no status page yet; no SOC 2; no per-tenant encryption keys; break-glass support access is logged but not pre-approved (all from `docs/SECURITY.md`).
- Export today is metadata-first (JSON, capped at 5,000 rows/table) and originals are provided on request until M7 ships.
- Donovan answers cite sources and decline rather than guess; AI can be wrong (terms s.5).
