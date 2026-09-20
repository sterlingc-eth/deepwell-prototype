# Billing gating rules (source of truth: api/_lib/plan.js)

Four billing states, computed by `planStateFor(tenantRow)`:
- **trialing** — `billing_status = 'trialing'` and `trial_ends_at` (if set) is in the future. A trial whose end date has passed is treated as `none` immediately, without waiting for a webhook.
- **active** — `billing_status = 'active'`.
- **past_due** — `billing_status = 'past_due'` (Stripe sent `invoice.payment_failed`). Split into two sub-cases by `isPastGrace()`:
  - **within grace** (≤ 7 days past `current_period_end`): full access, same as active.
  - **past grace** (> 7 days): uploads blocked, ask stays readable (read-only).
- **canceled** — `billing_status = 'canceled'` (subscription ended or Stripe status is `canceled`/`incomplete_expired`/`paused`). Uploads blocked; ask blocked.
- **none** — never subscribed, or an incomplete/abandoned checkout. A brand-new tenant can ingest and ask about up to **3 documents** (`FREE_PREVIEW_DOCUMENTS`) with no card on file. At 3+ documents stored, both upload and ask are blocked with a 402 pointing at `/app/?screen=billing` (start-trial prompt).

## Upload gate (`gateUpload`, enforced in `api/upload-url.js`, new-upload paths only — never `mode:'get'`)
| State | Result |
|---|---|
| none, < 3 docs stored | allowed |
| none, ≥ 3 docs stored | 402 "Free preview used up — start your 30-day trial" |
| trialing / active / past_due-within-grace | allowed, subject to `PLAN_LIMITS[plan].pagesPerMonth` (402 "Monthly page limit reached" once `pagesThisMonth ≥ cap`) |
| past_due-past-grace | 402 "Subscription required" |
| canceled | 402 "Subscription required" |

`pagesThisMonth` = count of `document_pages` rows created in the trailing 30 days (`recordsStore.countPagesSince`). `documentsStored` = total `documents` rows for the tenant (`recordsStore.countDocuments`).

## Ask gate (`gateAsk`, enforced in `api/ask.js`)
Ask is read-only, so it is far more permissive than upload:
| State | Result |
|---|---|
| none, < 3 docs stored | allowed |
| none, ≥ 3 docs stored | 402 "Start your 30-day trial to keep asking questions" |
| trialing / active / past_due (either grace phase) | allowed |
| canceled | 402 "Subscription required" |

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
