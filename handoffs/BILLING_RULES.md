# Billing gating rules (source of truth: api/_lib/plan.js)

Four billing states, computed by `planStateFor(tenantRow)`:
- **trialing** — `billing_status = 'trialing'` and `trial_ends_at` (if set) is in the future. A trial whose end date has passed keeps working for a **48-hour grace** (`TRIAL_END_GRACE_HOURS`, R30 M4) so the normal lag of the trial-to-paid conversion never shows a paying customer the paywall; after 48h it is treated as `none` without waiting for a webhook. `needsBillingReconcile` also asks Stripe as soon as an expired trial is still marked `trialing`.
- **active** — `billing_status = 'active'`.
- **past_due** — `billing_status = 'past_due'` (Stripe sent `invoice.payment_failed`). Split into two sub-cases by `isPastGrace()`:
  - **within grace** (≤ 7 days after the tenant ENTERED past_due): full access, same as active.
  - **past grace** (> 7 days): uploads blocked, ask stays readable (read-only).
  - The clock starts at `limits._billing.pastDueSince` (unix seconds), written by the webhook when the tenant transitions into past_due and cleared when it leaves (R30 M3). The old reference, `current_period_end`, is wrong for a failed renewal (Stripe has already rolled it to the next period, so "7 days" was ~37). Rows that went past_due before this shipped have no `pastDueSince` and fall back to the old reference until their next dunning event.
- **canceled** — `billing_status = 'canceled'` (subscription ended or Stripe status is `canceled`/`incomplete_expired`/`paused`). Uploads blocked; ask blocked.
- **none** — never subscribed, or an incomplete/abandoned checkout.

**HARD GATE (owner decision, 2026-09-21): no free preview any more.** `FREE_PREVIEW_DOCUMENTS = 0` — a `none` tenant is blocked at upload #1 and question #1, exactly like a `canceled` one. (The constant is kept at 0, not removed, so `freePreviewExhausted`/`gateUpload`/`gateAsk` don't need a separate branch.) On the client, `src/App.tsx` mirrors this by showing the signed-in user ONLY the Billing screen (plus Team/Sign out) whenever `status.status` is `'none'` or `'canceled'` — that's UI convenience; this file is the actual enforcement.

## Upload gate (`gateUpload`, enforced in `api/upload-url.js`, new-upload paths only — never `mode:'get'`)
| State | Result |
|---|---|
| none | 402 "Choose a plan to get started" |
| trialing / active / past_due-within-grace | allowed, subject to `PLAN_LIMITS[plan].pagesPerMonth` (402 "Monthly page limit reached" once `pagesThisMonth + pendingPages ≥ cap`). R30 M6: `pendingPages` is an estimate of documents already accepted but not read yet (stage `received`, no error, no pages, last 24h; image 1, PDF ~200 KB/page, text 6,000 chars/page), so a burst of uploads cannot slip past the cap before any page is written. The message says how many pages are still being processed. It is an estimate for gating only; nothing is billed from it. |
| past_due-past-grace | 402 "Subscription required" |
| canceled | 402 "Choose a plan to get started" |

`pagesThisMonth` = count of `document_pages` rows created in the trailing 30 days (`recordsStore.countPagesSince`). `documentsStored` = total `documents` rows for the tenant (`recordsStore.countDocuments`).

## Ask gate (`gateAsk`, enforced in `api/ask.js`)
Ask is read-only, so it is far more permissive than upload:
| State | Result |
|---|---|
| none | 402 "Choose a plan to get started" |
| trialing / active / past_due (either grace phase) | allowed |
| canceled | 402 "Choose a plan to get started" |

Every 402 body is `{ error, url: "/app/?screen=billing" }`.

## Plan catalog (api/_lib/billing.js, api/_lib/plan.js)
| Plan | Monthly | Annual (11×, one month free) | Logins (owner not counted) | Documents stored | Pages/month | Trial |
|---|---|---|---|---|---|---|
| solo  | $99  | $1,089 | 2  | 25,000  | 750   | 30-day, card required |
| shop  | $199 | $2,189 | 5  | 100,000 | 2,000 | none |
| crew  | $399 | $4,389 | 10 | 500,000 | 5,000 | none |
| fleet | $899 | $9,889 | 11+ | ∞       | 10,000| none |

Round 26: Donovan is unlimited on every plan (hidden safety ceiling only); API access is Fleet-only. See handoffs/ROUND26_PLAN_TIERS.md.

Records Rescue: one-time, $0.12/page, 4,167-page minimum (~$500), enforced in code (`resolveRecordsRescueQuantity`) since Stripe prices have no built-in floor.

## Trial eligibility
Solo plan only, monthly or annual, and only when `tenants.trial_used = false`. Once a subscription for that tenant has ever reached Stripe status `trialing`, `trial_used` is set `true` permanently (webhook `customer.subscription.created|updated`) — canceling and resubscribing does not grant a second trial.

## Stripe webhook ordering (R30 M1) and checkout (R30 M2)
State lives in `tenants.limits._billing = {eventAt, subId, pastDueSince}` (no schema change; `billing_apply` still replaces `limits` wholesale, the webhook re-includes `_billing`). Under a per-tenant advisory lock the webhook decides (`decideBillingEvent`) before applying. The event is always written to the `billing_events` ledger; an ignored one returns `200 {handled:false, reason:"ignored"}` and logs why:
- **stale**: `event.created` older than the last applied event (`eventAt`). Same-second events still apply.
- **other-subscription**: an event about a subscription that is not the tenant's current one (e.g. the old subscription's deletion) cannot cancel or change the tenant. A `subscription.created` for a live status is adopted as the new current subscription.
- **canceled-tenant**: invoice events never change a canceled tenant (a re-subscribe arrives as `subscription.created`).
- **zero-invoice-during-trial**: the $0 invoice Stripe issues when a trial starts does not turn `trialing` into `active`.
`checkout.session.completed` is not ordered. If the decision lookup itself fails, the raw patch is applied (fail open, as before).

**Checkout while subscribed**: `POST /api/billing?action=checkout` for a tenant that is active / trialing / past_due returns `{url: <Stripe customer portal>, portal: true, notice}` (the client already redirects to `url`) to change or update the existing subscription; if the portal cannot be created it returns 409 with a plain message. Never a second subscription. Records Rescue (one-time) is exempt.

## Rate-limit daily counters (R30 H2)
The daily cap is per bucket (`rate_limit_windows`, bucket `day:<bucket>`, window = UTC midnight), so asks/reads no longer consume the billing (60/day) or ingest allowance. `usage_counters.requests` is still incremented, for reporting only. New keys start at zero on deploy.

## Time zones (R30 M10)
The server's "today" for warranty windows and the digest is the tenant's local date: `tenants.settings.timezone`, else env `TENANT_DEFAULT_TZ`, else `America/Phoenix`. The app sends the device's local date; anything that is not a real `YYYY-MM-DD` in 2000-2100 is ignored (M9).
