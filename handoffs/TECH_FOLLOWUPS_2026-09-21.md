# Missing-info follow-ups — 2026-09-21

Owner request (START_HERE_NEXT_CHAT.md item 3): nudge the technician when a
document is missing required info. No model call, no new DDL, no new dep.

## Added
- `api/_lib/followups.js` (pure) — missing-field detection (reuses
  `documentTypes.js`'s `completenessFor`), `technicianNameMatches` (mirrors
  `src/core/workFilter.ts`'s rule, own copy — no frontend TS in backend),
  uploader-id -> technician-name -> admin grouping, message rendering (cap
  20 docs/message, 50 messages/run), 24h-per-technician debounce (cap 200).
- `api/_lib/routes/followups.js` — `settings`/`saveSettings`/`run` ops
  (`run` dry-run by default, `apply:true` sends). In-app via `notifications`
  (`kind:'followup'`, tenant-wide with the tech's name in the title — no
  per-user target column exists). Email via the same Resend path outreach
  uses, gated on `settings.email` AND `RESEND_API_KEY`. `runFollowupsSweep()`
  for cron. Settings + debounce ledger live in `tenants.settings` jsonb
  (`followups`, `followupsLastSent`) — no migration needed.
- `src/hooks/useDeepLink.ts` — `?screen=inbox` alias for `review`; new
  `?work=mine` -> `pendingWorkFilter`.
- `src/store/appStore.ts` — `pendingWorkFilter`/setter/clearer (one-shot).
- `src/hooks/useWorkFilter.ts` — consumes `pendingWorkFilter` first, so the
  follow-up link actually preselects "My work".
- `src/services/followupsClient.ts`, `src/components/FollowupsCard.tsx` —
  admin-only Team card: enabled/email toggles (off by default; email
  disabled with a hint when `emailAvailable` is false), "Check now"/"Send
  now", per-technician "Copy message"/"Open in mail app" (mirrors
  OutreachScreen).
- `scripts/verify-followups.mjs` (63 checks: grouping, rendering+caps,
  debounce+cap, disabled -> no-op) — wired into `verify:all`.
- `scripts/verify-ui.ts` — 4 new `parseDeepLink` cases (`screen=inbox`,
  `work=mine`).

## Changed
- `api/account.js` — registered `followups` action.
- `api/_lib/routes/cron-sweep.js` — runs `runFollowupsSweep` after outreach,
  same shared 45s deadline, logged in the summary line.
- `src/screens/TeamScreen.tsx` — renders `<FollowupsCard />` for admins.

## SQL to paste
None. Reuses `tenants.settings` jsonb and the already-applied
`list_notification_eligible_tenants()` (M3-config/16) for cron's cross-tenant
listing — a solo (no-org) tenant isn't visited by the nightly sweep; the
on-demand admin action still works for any signed-in user.

## Verify summary
`npm run typecheck && npm run typecheck:api && npm run lint && npm run
verify:all` — all green, **2757 PASS / 0 FAIL** (2693 + 64 new). `npm run
build` succeeds. Exactly 12 files remain directly under `api/`.

## Not done
- No per-user in-app target (table limitation) — every teammate sees every
  `kind:'followup'` notification, titled with the tech's name.
- Bell dropdown doesn't visually distinguish a followup notification.
- Not tested against live Postgres/Clerk — pure-function suite only.
