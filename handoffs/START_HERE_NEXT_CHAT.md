# DeepWell Technology — START HERE for the next chat (updated 2026-09-20, late)

Paste this file (or point Claude at project doc `claude/START_HERE_NEXT_SESSION.md`) at the start of the new chat.

## What DeepWell is
Cloud document management + AI Q&A ("Donovan") for HVAC contractors. Live at https://deepwelltechnology.com (marketing) and /app (product). Owner: Sterling (scchapman94@gmail.com, Mesa AZ). Partner: Hilton.

## Stack (all live)
Vite+React+TS `src/` · Vercel serverless JS `api/` (**exactly 12 files — Hobby cap; new routes go in `api/_lib/routes` and dispatch via `api/v1.js ?resource=`, `api/review.js action`, `api/account.js ?action=`**) · Neon Postgres **Launch plan, scale-to-zero OFF, 0.25→2 CU** + RLS (migrations `M3-config/01..18`, ALL applied) · Cloudflare R2 · Inngest queue · Clerk **production** (orgs; Sterling's org `org_3JZNNONccwrYbVGY5wTekSRN6YZ`, admin login chapman.sterlingc@gmail.com; scchapman94 is a separate prod user — invite it via Team) · Anthropic Haiku 4.5 everywhere (prompt caching WORKS since tonight: min is 4096 tokens for Haiku) · Stripe live objects created (keys NOT yet in Vercel → Billing shows "not configured") · Vercel Fluid compute on, region iad1.

## Working rules with Sterling (keep these)
- Sterling pushes via GitHub Desktop. **Never run git in his repo.** Write files with `device_commit_files` to `C:\Users\chapman\Desktop\GitHub\deepwell-prototype`, then md5-verify via `device_bash`. Mirror at `/home/claude/work` (re-stage from repo in a fresh session).
- **Never read, type, or paste credentials.** He pastes into Vercel/Clerk/Stripe himself.
- **Never write DDL to production Neon** — he pastes migrations in the SQL editor (paste SQL text, not filenames).
- Every build goes through the reviewer agent (GO/NO-GO). Cheapest model that works (sonnet agents; Haiku in product). Be efficient; don't narrate.
- Product tone: plain English (handoffs/UX_FLOW_SPEC_2026-09-19.md). Nav is exactly Ask · Dashboard · Inbox · Records. Office view = dark (default), Field view = light + larger type.

## What shipped today (all reviewed GO, all in repo — last push pending for the fast-path round)
Ask latency: Server-Timing header, round-trip cuts, per-tenant answer cache (never caches no-answers; invalidated by PROMPT_VERSION + corpus stamp), tenant-first GIN indexes (M3-config/17), prompt caching fixed (SYSTEM_PROMPT ~4.6K tokens with HVAC reference), ambiguity rule, **model-free fast path** (api/_lib/fastPath.js: 22 intents, 181 phrasings + 23 adversarial negatives; answers field lookups in ~0.3 s, defers when unsure) · Donovan naming · Office/Field view · Customer outreach (M3-config/18; screen via Dashboard; off by default; needs RESEND_API_KEY) · website: Get started → Solo trial, Records Rescue mailto, missed-warranty cost section, Donovan, "Coming soon" tags on unbuilt claims (Drive sync, email intake, folder sync, CSV export, branch scoping, callback dashboards) · privacy.html Stripe wording · sign-up/create-org redirect to /app/ · View record fix in DocumentPreview.
Docs: handoffs/ASK_LATENCY, ASK_CACHE_AND_INDEX, FAST_PATH, OUTREACH, WEBSITE_CLAIMS_AUDIT, WEBSITE_ROUND_2026-09-20b, COST_REPORT (correction section).

## Measured (2026-09-20 late)
Cached question ~0.3 s · fast-path (once deployed) ~0.3 s · model question 1.5–3.5 s (model is 85%+; DB ~0.2 s) · cache_read ~9K tokens/question.

## Sterling's to-do (in order)
1. **Push** the fast-path round (7 files).
2. **Vercel env**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (endpoint `https://deepwelltechnology.com/api/billing?action=webhook`, events checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed), `RESEND_API_KEY`. Redeploy. Then Billing screen stops saying "not configured".
3. Team → invite scchapman94@gmail.com as admin. Delete the empty extra org later (Clerk dashboard).
4. Anthropic console: add funds (was $1.53). Vercel Pro before real customers. Founder bios (2 sentences each) for the website.
5. Confirm `DATABASE_URL`/`NEON_CONNECTION_STRING` host contains `-pooler`.

## Next for Claude (in order)
1. Live-verify the fast path on production (Server-Timing `fast`, log `fast_hit`) against test-docs/README-ANSWER-KEY.md; tune phrasings from real misses (log line has fast_intent).
2. Synthetic test corpus: generate ~300 realistic HVAC documents (PDF/JPG, templates, no model needed) into test-docs/synthetic/, then limit-test upload/ingest/Ask (extraction cost ≈ $0.01/doc — needs Anthropic funds first). Sterling asked for this explicitly.
3. Live break-test the app screens (audit Part B never ran — Chrome was down): billing checkout (once keys set), customers, team invites (needs 2nd email), notifications, outreach.
4. Streaming answers (perceived speed), then two-phase response.
5. Decide build-vs-cut for the "Coming soon" website claims; Google OAuth app verification; Records/Inbox ergonomics pass.

## How signup → paying works (for Sterling's question)
Website "Start free trial" → `/app/?plan=solo&interval=month` → Clerk sign-up → create shop (org) → Billing screen opens with Solo preselected → "Start 30-day free trial" → Stripe Checkout (card required, $0 today) → webhook sets tenant plan=solo, status=trialing → day 30 Stripe charges $99 unless canceled. Without a subscription a new shop can upload 3 documents free (no card); beyond that uploads are blocked with a link to Billing. All of this is in code; only the two Stripe env vars are missing.
