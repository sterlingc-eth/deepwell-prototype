# START HERE — next chat(s) (written 2026-09-21, end of the long session)

Owner: Sterling. Product: DeepWell (deepwelltechnology.com, app at /app).
AI is named Donovan. Haiku everywhere. Be efficient — cheapest model, no wasted actions.

## Standing rules (never break)
- Never run git in the owner's repo. Write files with device_commit_files to
  `C:\Users\chapman\Desktop\GitHub\deepwell-prototype`, verify md5 on the
  device, then ask him to push in GitHub Desktop.
- Never read/type/paste secrets. Never run DDL on Neon — he pastes
  `M3-config/NN-*.sql` in the SQL editor; code must tolerate the column missing.
- Exactly 12 files directly under `api/` (Vercel Hobby). New routes go in
  `api/_lib/routes/*` behind `api/v1.js ?resource=`, `api/review.js action`,
  `api/account.js ?action=`.
- Every build: reviewer agent GO/NO-GO before commit. `npm run typecheck &&
  npm run typecheck:api && npm run lint && npm run verify:all` (2693 PASS / 0
  FAIL at last run).
- Owner's data rules: every document linked to someone; strict merges (name +
  address + phone + email must agree; near-misses are "Needs your review",
  never auto); keep the fuller name.

## State of production (all pushed unless noted)
- Limit test (61 synthetic docs, `handoffs/LIMIT_TEST_RESULTS_2026-09-20.md`,
  fixes in `LIMIT_TEST_FIXES_2026-09-20.md` rounds 1–4): 12/12 customers,
  3/3 merge traps held, 100% docs + units linked, alerts 2/2, Ask 27/30.
  Defects found and fixed: shop phone leak (now learned per tenant +
  stripped + re-derived), different-business-same-address absorb, misspelled
  surname dup, name-only wrong link flag, "Add files" 429 backoff.
- Committed, awaiting owner push + SQL paste (do this first in the new chat):
  `M3-config/20-document-uploaded-by.sql`, `M3-config/21-outreach-shop-fields.sql`
  (paste in Neon), plus `19-extraction-unit-index.sql` if not yet confirmed.
- Then run on live data (signed-in browser tab, `POST /api/review`
  `{action:'integrityFix', apply:[...ALL_INTEGRITY_FIXES], dryRun:false}` or the
  Customers → Check records → Fix everything button) and re-score the corpus
  (`handoffs/LIMIT_TEST_PLAN_2026-09-20.md`; in-browser scorer recipe in the
  session transcript — or just re-run the plan's steps).
- New this session: per-tech "My work / Everyone" filter (Inbox, Records),
  uploader attribution; Outreach = draft-to-copy by default, auto-send is a
  paid add-on (`outreachAuto` entitlement, Stripe lookup key `outreach_auto`
  — owner creates the price); citation chips show doc type; Donovan mark in
  the app (src/components/DonovanMark.tsx); website hero = Donovan v2
  (`handoffs/BRAND_MOTION_A_2026-09-21.md`) + animated nav logo +
  `public/logo-animated.svg`.

## Done later on 2026-09-21 (all committed; owner pushes)
- Hard billing gate (handoffs/HARD_GATE_2026-09-21.md): no free preview; every
  model/storage path 402s for 'none'/'canceled', cron + Inngest worker gated.
- Tech follow-ups (handoffs/TECH_FOLLOWUPS_2026-09-21.md), Team → Follow-ups.
- Website micro-animations (BRAND_MOTION_B), Donovan hero REVERTED to the
  original rings at owner request (v3 code preserved in BRAND_MOTION_A3).
- QA crawl (QA_WEBSITE, QA_APP_API): pricing ?plan= now survives sign-up.
- Donovan analytics (DONOVAN_ANALYTICS_A): "how many customers in Maricopa
  County / Arizona / Gilbert", "which customers have Trane units", counts by
  brand/warranty/document type/month. One Haiku planner call, whitelisted
  SQL, ZIP→county table api/_lib/geo/zip-county.json.
- 604-document business corpus (BUSINESS_CORPUS): `node scripts/synth-business.mjs
  && node scripts/build-bundle.mjs test-docs/business`, then
  scripts/browser-ingest.js in the signed-in app console; score with
  `node scripts/score-corpus.mjs --dir <snap> --key test-docs/business/ANSWER_KEY.json`.
  NOT YET UPLOADED — owner's app session expired; ≈ $7 Haiku.
- Industry expansion (INDUSTRY_EXPANSION): order electrical → plumbing →
  property; website Industries dropdown + public/industries/*.html; domain
  scaffolds src/domains/{electrical,plumbing,property} (inert).
- Promo: video/deepwell-promo-v3*.mp4 (code-rendered), video/PROMO_DIY_GUIDE.md
  (free tools + master prompt), video/STORYBOARD_APPLE_STYLE.md.

## Open requests from the owner (split across new chats)
1. **Website micro-animations** — section B of
   `handoffs/BRAND_MOTION_BRIEF_2026-09-21.md` (reactbits.dev/c/micro style,
   vanilla, reduced-motion safe). Edit `index.html` only after A's changes
   (already in). Reviewer, then commit.
2. **Promo video** — section C of the same brief (Playwright frame capture →
   ffmpeg, 60 s + 15 s cuts, `video/`). Owner reference for the feel:
   https://x.com/aschapire/status/1559112525614141443/video/1 (a fluid
   ring/ripple animation — study it first if the URL is reachable; if not,
   ask the owner to describe or attach it).
3. **Missing-info automation** — owner: "for documents that are missing
   information, there needs to be some kind of automation sent out to that
   technician to get it resolved or find the missing information." Design:
   when a document lands in Needs-attention with `missing-field` issues, the
   nightly sweep (api/_lib/routes/cron-sweep.js) + an on-demand action builds a
   per-technician task list (tech = uploader `uploaded_by` or extracted
   technician name → Clerk member), drafts a short message ("3 documents need
   the serial / install date — open Inbox → My work"), delivers as in-app
   notification (api/_lib/notify.js bell) and optional email (same Resend
   path as outreach; copy/mailto fallback), with a deep link
   `/app/?screen=inbox&work=mine`. Keep it deterministic (no model cost).
   Put it behind Team settings (off by default, admin toggles).
4. **Better Donovan prompt guidance** (owner asked how to prompt for a better
   Donovan): describe (a) the metaphor (a well of light / depth / the answer
   rising), (b) the states (idle / reading / answered), (c) what it must NOT
   be (a face, sparkles, a badge), (d) material & light (brass on forest,
   soft caustics), (e) motion adjectives (slow, weighty, precise), (f) a
   reference clip. v2 is live now; iterate from a screenshot + one sentence
   of what's wrong.
5. Customer-journey walkthrough of every screen (never completed).
6. Owner to-dos: RESEND_API_KEY (only for auto-send), invite
   scchapman94@gmail.com via Team, founder bios, Google OAuth verification,
   Vercel Pro, create Stripe add-on price `outreach_auto`.

## Cost notes
Anthropic spend for the whole limit test ≈ $1–2 (Haiku). Agents: use sonnet;
one implementation agent + one reviewer per round; avoid re-reading big files.

## Late 2026-09-21 — Donovan accuracy program (all committed; deploy-0921n..q)
- Monthly Donovan usage allowance (ASK_ALLOWANCE): Solo 3,000 / Shop 9,000 /
  Crew 22,500 / Fleet 60,000 model-calling asks per month, UI shows "% used ·
  resets <Month 1>" only (never "questions"). Daily safety cap 900, 20/min.
- Analytics fixes: month resolution in code (service_date), hasEmail/hasPhone
  filters, brand-aware labels, honest fallback ("I can count X, but I can't
  filter by Y yet") whenever the plan dropped a condition the question named.
- Question bank: `npm run gen:bank` → test-docs/question-bank/bank.json
  (3,224 entries, $0), `node scripts/verify-question-bank.mjs` (99.4% routing).
  Normalizer api/_lib/nlNormalize.js runs before classifier + planner (typos,
  abbreviations, filler); cache keys use normalized text.
- Live 270-question sample on the founder account: $0.95, 25/26 dup cache hits,
  ~89% correct after removing scorer artifacts. Misses fixed in deploy-0921q:
  contact lookup by customer name (api/_lib/contactLookup.js, no model call),
  money questions → honest fallback (never "$0.00 across N documents"),
  maintenance-due synonyms → fallback, street-name typo correction from the
  tenant's own addresses (api/_lib/streetVocab.js). Re-run the 20 misses live
  after push (~$0.05). Oracle recipe: export?kind=customers|equipment CSV in
  the browser, compute expected counts, compare to /api/ask.
- Training plan: handoffs/DONOVAN_TRAINING_PLAN_2026-09-21.md (≈$4 total).
  Day 2 still open: few-shot examples in the planner prompt, miss-loop logging
  (log fallthrough + "can't filter by" answers, weekly review).
- Financials layer DESIGN only: handoffs/FINANCIALS_DESIGN_2026-09-21.md
  (document_financials tables = M3-config/22, extraction extension ~$0.001/doc,
  backfill <$0.30, invoices/bills entities, AR aging, trust UI; 3 phases
  ~3.5 days). Owner has not yet said go.
- Do NOT claim an accuracy % for business questions on the website until the
  bank is measured live at ≥97%; document lookup keeps its measured claim.

## 2026-09-22 — bank expansion, self-learning loop, Tier 3 lookups (deploy-0922a..d)
- Bank: 724 base / 5,968 entries incl. 314 HVAC persona questions
  (test-docs/question-bank/hvac-personas.mjs; owner/office/tech/bookkeeper);
  offline routing 100%; routing-bank.json is the compact copy the API uses to
  verify learning proposals.
- Tier 1: nightly cross-tenant miss digest (api/_lib/missDigest.js, M3-config/25)
  → email via Resend (DEEPWELL_OWNER_ALERT_EMAILS) + founder bell; operator-only
  "Send digest now". Migration 25 was corrected (notifications has no unit_id).
- Tier 2: self-learning (handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md,
  api/_lib/learning/*, M3-config/26): nightly proposer (deterministic typo/abbrev
  + ≤20 Haiku calls) → every proposal verified against the full routing bank +
  negatives → auto-approve only typo/abbrev (DONOVAN_AUTO_LEARN=vocab default),
  synonyms/few-shot pending for operator approve on the Team screen; learned
  overlay applied at request time (10-min cache); weekly repo sync via
  learningExport → gen-question-bank / vocab. Operator gate before rate limit.
- Tier 3: api/_lib/docLookup.js (documents by customer/address + type, honest
  zero), last-visit/history + unit facts in the contact card, deterministic
  condition overrides (email/phone/brand/geo), extended time windows (week,
  quarter, YTD, last N days, since <year>), cross-doc hasDocType/lacksDocType,
  honest-zero wording for retrieval misses. Money still parked (financials).
- Live persona sample before Tier 3: 32/68 scorable (many scorer artifacts:
  key vs live doc counts differ after top-up). Rerun after deploy-0922d push.
- Known data issue: Donna Thornton's contact sits on a duplicate customer —
  run Customers → Check records → Fix everything, then merge.
- Rate limits: migration 24 makes daily caps plan-sized; 99 lifts the founder
  tenant's caps for testing.

## 2026-09-22 (evening) — owner-found defects, reminders, perf, expenses (deploy-0922f..j)
- Shop records: reclassify + integrity `classifyShopRecords` file customer-less memos
  (parts counts, truck notes) as 'internal', SQL-guarded so a linked doc can't be.
- Customers: sortable column headers; alert tooltip; possible-duplicate pairs
  (same address, different name) now surfaced with Merge / Keep separate, never
  auto-merged; add-customer warns at an existing address; alerts dismissable with
  undo (audit_log alert.dismissed) and profile shows plain warranty status;
  clicking a document on a customer opens in place; Inbox customer scope chip;
  uploader chip always visible; shop records tech chip + hide toggle.
- Reminders (handoffs/REMINDERS_2026-09-22.md): memo/dispatch reminder fields,
  link by named customer, open/done via audit_log, profile strip, "Find reminders"
  backfill (≤20 model calls), Donovan "any reminders for X".
- API perf (handoffs/API_PERF_2026-09-22.md): tenant-context/billing/limits caches
  with webhook bust, pooled keepAlive, batched notifications, client dedupe;
  optional M3-config/27-request-context.sql. Owner: use Neon pooled host + keep
  compute awake (paid tier) for the last 1–2 s.
- Expenses (handoffs/EXPENSES_2026-09-22.md): owners-only screen (operator gate),
  M3-config/28-expenses.sql, receipt extract, CSV export, seed button with the
  three Anthropic receipts. public/expense-tracker.html now redirects.
- PROCESS CHANGE: every UI round gets a live click-through of the real app before
  it's called done (owner found a navigation bug code review missed).
- Neon paste list still open for the owner: 25 (corrected), 26, 27, 28.
