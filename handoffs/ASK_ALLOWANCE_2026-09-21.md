# Monthly question allowance (2026-09-21)

Flat daily ask cap -> per-plan MONTHLY allowance, % meter, resets 1st UTC.
Old daily cap survives only as a 30%-of-monthly runaway guard.

## Design
- `PLAN_LIMITS.asksPerMonth` (plan.js): solo 3000 / shop 9000 / crew 22500 /
  fleet 60000.
- Counts only questions that reach the model (retrieval+Haiku, or the
  analytics Haiku planner) — cache/meta-router/fast-path/no-evidence are
  free. Pure rule: `usage.js#isCountableAskSource`.
- Storage, **no DDL**: `usage_counters` has no bucket column (`model_calls`
  is shared by ask/ingest/read), so it can't isolate "questions" without also
  counting ingestion. Reuses `rate_limit_windows` instead — same (tenant,
  bucket, window_start) key the burst limiter already has, `bucket=
  'ask_month'`, `window_start`=month's 1st UTC. Plain SQL inside the
  existing `withTenant` transaction (RLS scopes it); no new function. One
  row/tenant/month, never purged (negligible volume).
- `gateAsk` 402: "This month's Donovan usage is used up — resets <Mon 1>"
  (owner correction, same day: never say "questions"); applies across
  trialing/active/past_due alike. Client shows a % only, never a raw count
  (Billing row, both banners, Ask caption) — raw numbers live in an
  aria-label/title for admins.
- `PLAN_DAILY_ASKS` now derived (`round(asksPerMonth*0.3)`); tenant
  `limits.ask.perDay` override still wins.

## Changed paths
plan.js/rateLimit.js/usage.js (asksPerMonth, derived PLAN_DAILY_ASKS, month
math, get/incrementAsksThisMonth, isCountableAskSource) · api/ask.js
(asksThisMonth folded into checkAskGateInner's one query; increments at
both model-call sites) · routes/analytics.js (`runAnalyticsQuestion` returns
`modelCalled` so ask.js never double-counts a fallthrough) · api/billing.js
(usage.asksThisMonth/resetsOn, limits.asksPerMonth always fresh) ·
billingClient.ts (types, asksUsedFraction, new banners) · AppShell.tsx
(banner styling) · AskScreen.tsx (≥80% caption; 100% reuses existing 402
notice) · BillingScreen.tsx (Questions-this-month row + bar) ·
verify-scale.mjs/verify-billing.mjs/verify-ui.ts (updated expectations +
new tests for all of the above).

## Verify / build / SQL
`npm run verify:all` all green. `npm run build` clean. `api/` still exactly
12 direct files. No SQL/migration touched.
