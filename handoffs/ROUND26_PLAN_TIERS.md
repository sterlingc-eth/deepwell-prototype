# Round 26 — plan tiers (logins, Donovan, API access)

## Owner decisions implemented
| Plan | Price (unchanged) | Logins (owner not counted) | Donovan | Scan pages/mo | API access |
|---|---|---|---|---|---|
| Solo | $99 | up to 2 | Unlimited | 750 | no |
| Shop | $199 | up to 5 | Unlimited | 2,000 | no |
| Crew | $399 | up to 10 | Unlimited | 5,000 | no |
| Fleet | $899+ | 11+ (no DeepWell cap) | Unlimited | 10,000 | yes |

Stripe needs **no price or product change**. No SQL to paste (nothing in `M3-config/60-*.sql`; every path works with the current schema).

## What changed
- `api/_lib/plan.js`: `PLAN_LIMITS` now `{logins, documentsStored, pagesPerMonth}` (`technicians` and `asksPerMonth` removed). New `loginCapForPlan`, `clientLimits` (API/bootstrap always report the LIVE table, never a stale `tenants.limits` snapshot), `hasApiAccess`, `DONOVAN_SAFETY`, `gateAsk` (safety ceiling only).
- `api/_lib/seats.js` (new): owner detection, seat math, Clerk sync, guarded invite.
- `api/billing.js`: `?action=seats` (admin; live usage + lazy Clerk sync), `?action=invite` (server-side guard); Clerk sync after webhook plan change / trial start and after a pull-reconcile.
- API access: `api/_lib/apiKeyAuth.js` (`verifyApiKey` refuses any tenant not on Fleet, covers every v1/ask/upload route that accepts keys) and `api/_lib/routes/keys.js` (`createApiKey` refuses non-Fleet). Both answer 403 `{"error":"API access is included on the Fleet plan"}`.
- UI: `TeamScreen` (server-computed "3 of 5 logins used (owner not counted)", banner, guarded invite form, Clerk's own invite button hidden), `BillingScreen` (logins/Donovan/API rows, Donovan meter removed), new `ApiAccessCard` (upgrade prompt below Fleet; list/create/revoke on Fleet), Donovan % meter + banners removed from Ask (desktop + mobile) and AppShell.
- Copy: `index.html` pricing (Logins up to 2/5/10/11+, Donovan Unlimited x4, API Fleet "Yes" others "—", owner note, new lede), `public/terms.html` section 6, `handoffs/BILLING_RULES.md`.
- Tests: `scripts/verify-plan-tiers-r26.mjs` (84 checks, wired into `verify:all`) plus updates to verify-billing/-scale/-apikeys/-perf/-prod-hardening/-ui/-app-qa.

## Who is "the owner" (excluded from the count)
Clerk organization `createdBy` — the user who created the shop. It is set once by Clerk, does not change with role edits, and no DeepWell column is needed. Fallback if Clerk has none: the earliest-joined admin. Extra admins count. Pending invitations count.

## Enforcement
1. UI: invite form disabled at/over cap with upgrade message and Billing link.
2. Server: `POST /api/billing?action=invite` re-counts live (members + pending, owner excluded) and refuses at `used >= cap` with a 402 upgrade message; Clerk's own invite button is hidden (`membersPageInviteButton`) so it cannot bypass this.
3. Clerk backstop: `maxAllowedMemberships = cap + 1` (Solo 3, Shop 6, Crew 11, Fleet 0 = unlimited) set on webhook plan change, trial start, reconcile, and lazily (throttled 10 min/org) when an admin opens Team. Rejections/outages are logged (`seats: could not set Clerk maxAllowedMemberships ... Clerk rejected the value`) and never fail billing.

**Grandfathering / downgrade:** nobody is removed or locked out. An over-cap org shows the admin banner and new invites are blocked until it is back under the cap. If Clerk refuses to lower the limit below the current member count, that is logged and ignored.

## OWNER ACTION — Clerk member limit
Clerk's own per-org member limit still applies underneath DeepWell's. Needed per org (owner included): Solo 3, Shop 6, Crew 11, Fleet = whatever the team size is.
- Clerk limit **5**: only Solo fits. **Shop (6) and Crew (11) are blocked** by Clerk, and Fleet too.
- Clerk limit **20**: Solo, Shop and Crew fit. Only a Fleet team above 19 logins exceeds it.
Raise the Clerk limit in the Clerk dashboard (Organizations settings) before selling Shop/Crew. Until then DeepWell's own guard (UI + invite endpoint) still enforces the caps; the Clerk write is simply logged as rejected.
Not verifiable offline: whether Clerk counts pending invitations against its own limit. DeepWell counts them either way.

## Donovan
Unlimited on every plan. Hidden safety ceiling, identical for all plans, env-overridable:
- `RATE_LIMIT_ASK_PER_DAY` (default 3000 ask requests/day/tenant; the existing per-tenant `limits.ask.perDay` override still wins) and the existing 20/min burst.
- `DONOVAN_SAFETY_ASKS_PER_MONTH` (default 30,000 model-reaching asks/month).
- Existing daily model-spend caps (`maxModelCallsPerDay`) unchanged.
Hitting a ceiling returns 429 `scope: "safety"` with: "Donovan is seeing unusually high usage on your account. Please contact support@deepwelltechnology.com and we'll get you sorted out." Never an upgrade message. The founder test tenant's `limits.ask.perDay` override (99-founder-testing-limits.sql) is unaffected.

## API access (Fleet only)
Key create refused below Fleet. Key USE refused below Fleet with the same 403 message; keys are not revoked or deleted, so they work again the moment the tenant is on Fleet. The plan is read through the 2-minute billing-row cache (a plan change takes effect within ~2 minutes); an unreadable plan fails closed (503). `list`/`revoke` stay open on every plan. **Founder/test tenants that use API keys (live test day, MMS worker, Chrome extension) must be on Fleet.**

## Verification
typecheck, typecheck:api, build, oxlint (no new warnings), verify: plan-tiers-r26, billing, apikeys, scale, perf, ui, prod-hardening, auth, security, privacy, hardening, desktop-ia, app-qa, ops, caching all pass. Offline exam (EXAM_TODAY=2026-09-25) identical to origin/main: 1426 correct / 12 wrong / accuracy 0.992. Pricing section screenshots checked at 1440 and 390 (dark and light).
