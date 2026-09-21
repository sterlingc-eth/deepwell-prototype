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
