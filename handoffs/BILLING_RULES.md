# Billing gating rules (source of truth: api/_lib/plan.js)

Four billing states, computed by `planStateFor(tenantRow)`:
- **trialing** — `billing_status = 'trialing'` and `trial_ends_at` (if set) is in the future. A trial whose end date has passed is treated as `none` immediately, without waiting for a webhook.
- **active** — `billing_status = 'active'`.
- **past_due** — `billing_status = 'past_due'` (Stripe sent `invoice.payment_failed`). Split into two sub-cases by `isPastGrace()`:
  - **within grace** (≤ 7 days past `current_period_end`): full access, same as active.
  - **past grace** (> 7 days): uploads blocked, ask stays readable (read-only).
- **canceled** — `billing_status = 'canceled'` (subscription ended or Stripe status is `canceled`/`incomplete_expired`/`paused`). Uploads blocked; ask blocked.
- **none** — never subscribed, or an incomplete/abandoned checkout.

**HARD GATE (owner decision, 2026-09-21): no free preview any more.** `FREE_PREVIEW_DOCUMENTS = 0` — a `none` tenant is blocked at upload #1 and question #1, exactly like a `canceled` one. (The constant is kept at 0, not removed, so `freePreviewExhausted`/`gateUpload`/`gateAsk` don't need a separate branch.) On the client, `src/App.tsx` mirrors this by showing the signed-in user ONLY the Billing screen (plus Team/Sign out) whenever `status.status` is `'none'` or `'canceled'` — that's UI convenience; this file is the actual enforcement.

## Upload gate (`gateUpload`, enforced in `api/upload-url.js`, new-upload paths only — never `mode:'get'`)
| State | Result |
|---|---|
| none | 402 "Choose a plan to get started" |
| trialing / active / past_due-within-grace | allowed, subject to `PLAN_LIMITS[plan].pagesPerMonth` (402 "Monthly page limit reached" once `pagesThisMonth ≥ cap`) |
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
| Plan | Monthly | Annual (11×, one month free) | Technicians | Documents stored | Pages/month | Trial |
|---|---|---|---|---|---|---|
| solo  | $99  | $1,089 | 1  | 25,000  | 750   | 30-day, card required |
| shop  | $199 | $2,189 | 4  | 100,000 | 2,000 | none |
| crew  | $399 | $4,389 | 10 | 500,000 | 5,000 | none |
| fleet | $899 | $9,889 | ∞  | ∞       | 10,000| none |

Records Rescue: one-time, $0.12/page, 4,167-page minimum (~$500), enforced in code (`resolveRecordsRescueQuantity`) since Stripe prices have no built-in floor.

## Trial eligibility
Solo plan only, monthly or annual, and only when `tenants.trial_used = false`. Once a subscription for that tenant has ever reached Stripe status `trialing`, `trial_used` is set `true` permanently (webhook `customer.subscription.created|updated`) — canceling and resubscribing does not grant a second trial.
