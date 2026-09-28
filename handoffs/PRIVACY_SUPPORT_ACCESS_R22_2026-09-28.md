# Round 22 (S2) — privacy controls: Sentry scrubbing, log redaction, support-access grants

Owner ask: "when companies ask if we can see their data once stored, how do we defend it and ensure
privacy?" This is the S2 half of Round 22 — see `R22_CONTRACT.md` for the full split with S1/S3.

## What shipped

1. **Sentry scrubbing** (`api/_lib/telemetry.js`): `sendDefaultPii: false` pinned explicitly, plus
   `beforeSend`/`beforeBreadcrumb`/`beforeSendTransaction` hooks (`scrubSentryEvent`/
   `scrubBreadcrumb`, both pure + exported) that strip the request object, headers, query string,
   cookies, user object, and run exception/message text through redaction — on top of the existing
   `scrubContext` allowlist, which now HASHES `tenant`/`tenantId`/`userId` instead of passing them
   through raw.
2. **Log redaction helper** (`api/_lib/privacy/redact.js`): `redactText`/`hashForLog`/
   `describeForLog`/`hashTenantId`. Applied at three real call sites that were printing raw PII:
   `api/ask.js`'s two typo-correction log lines (customer/street name fragments), `api/_lib/email.js`'s
   log-only fallback (recipient addresses + subject), `api/_lib/recordsStore.js`'s skip-shop-address
   log (tenant id + address). All three are one-line call-site swaps; no behavior changed besides what
   reaches the log.
3. **Support-access grants** (`M3-config/58-support-access.sql`,
   `api/_lib/privacy/supportAccess.js`, `api/review.js`): a tenant admin can grant DeepWell staff
   time-boxed (24h/72h/7d max), revocable access; every `api/review.js` operator action that reads or
   replays a SPECIFIC tenant's own content (`learningList`, `learningReplay`,
   `learningDecide`'s capability-gap replay branch, `scorecardRun`/`Status`/`Baseline`, `examPromote`/
   `List`/`Export`) now calls `gateSupportAccess` first — denied with no grant unless the caller's
   tenant IS the founder tenant (dogfooding, exempt) or supplies an `emergencyReason` (break-glass,
   always logged + flagged). Every allowed access appends a `staff_access_log` row (who/when/action/
   record count — never content), tenant-isolated by the same forced-RLS pattern every other table
   uses. Platform-wide aggregate actions (`missDigest`, `learningGapReport`,
   `learningAutopilotStatus`) and the platform-level, no-`tenant_id` proposal-bank actions
   (`learningDecide`/`Deactivate`/`RunNow`/`Export`/`RejectAllGaps`) are exempt — each one's `case`
   block carries a `SUPPORT-ACCESS-EXEMPT` comment explaining why, and
   `scripts/verify-privacy.mjs` fails the build if a future edit drops a required gate or a stale
   exemption tag.
4. UI: Settings → **Support access** (grant/revoke, current grant expiry, duration + reason) and
   **Access log** (list), in `src/screens/TeamScreen.tsx`'s new `SupportAccessCard`, right below
   `AccountSettingsCard`. Screenshots at 1280/390, both themes: `scripts/verify-support-access-ui.mjs`
   / `scripts/support-access-harness/`.
5. `docs/SECURITY.md` — the customer-facing answer plus a verified (grepped, not assumed)
   subprocessor list and an honest "not yet done" section (no SOC 2, no per-tenant encryption keys, no
   contractual breach-notification SLA).

## SQL to paste

`M3-config/58-support-access.sql` — idempotent, FORCE RLS + tenant policy on both new tables
(`support_access_grants`, `staff_access_log`), same shape as every other migration in this directory.
Code tolerates it not being applied yet (warn once, empty/false results, never a failed request —
same convention as `ask_misses`/`donovan_promoted_tests`).

## Coordination notes (minimal edits outside my primary files)

- `api/_lib/agent/sqlGuard.js` (S1-owned): added `support_access_grants`/`staff_access_log` to
  `REAL_TABLES` (the Donovan agent's SQL-tool DENY list) — required so the agent's generic SQL tool
  can never read these two tables directly, and so `scripts/verify-agent.mjs`'s own
  migrations-vs-guard cross-check stays green. Two-line addition, not a redesign.
- `scripts/verify-ops.mjs`: updated one pre-existing assertion (`scrubContext keeps allowlisted
  keys`) to expect the now-hashed `tenantId`, since the old test asserted the raw value.
- `api/ask.js`/`api/_lib/email.js`/`api/_lib/recordsStore.js`: the three log-redaction call-site
  swaps described above (one import + a few changed lines each, no logic changes).

## Hooks for S1 / S3

- S1: if any NEW operator/founder-gated route is added to `api/**` that reads a specific tenant's
  documents/misses/learning data, it needs the same `gateSupportAccess`-style check
  (`api/_lib/privacy/supportAccess.js`'s `requireSupportAccess`) — `docs/SECURITY.md`'s "Support
  access" section and `api/review.js`'s own comments are the reference.
- S3: `docs/SECURITY.md`'s subprocessor table and "Can DeepWell see our data?" answer are the source
  of truth for the marketing Security & Privacy page's claims — please keep them in sync rather than
  re-deriving separately, and don't add a subprocessor there that isn't in this file (or grepped and
  confirmed actually used first).
- `requestId` was added to telemetry.js's `ALLOWED_CONTEXT_KEYS` allowlist (passed straight through,
  never hashed) as a hook for a future per-request correlation id — nothing in this codebase
  currently generates one, so it's inert until a call site starts passing `context.requestId`.

## Risks / known gaps

- Break-glass emergency access is trust-based (any non-empty reason is accepted) — the control is
  that it's always logged and tenant-visible, not that it's pre-approved. Documented in
  `docs/SECURITY.md`'s "not yet done".
- `missDigest`'s cross-tenant redaction only strips emails/phones from question text (pre-existing,
  not changed this round) — a technician-typed customer name in a question can still appear in that
  aggregate digest. Judged in-scope-acceptable as "platform-wide aggregate, no tenant singled out"
  per the R22 contract's own exemption language, but worth a future round's attention if the digest
  content ever gets stricter requirements.

## Tests

`node scripts/verify-privacy.mjs` (new, 115 checks) + `npm run verify:all` (full suite, all green,
offline-exam unchanged at 1220 no-model / 1183 correct / wrong 22 — exact match to the contract's
baseline). `npm run typecheck`, `typecheck:api`, `npx oxlint api scripts src` (no new warnings),
`VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build` all clean.
