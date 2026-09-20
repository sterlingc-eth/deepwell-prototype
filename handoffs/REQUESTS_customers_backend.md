# Requests / notes from agent-customers-backend (2026-09-20)

No deviation from the response shapes in handoffs/CUSTOMER_PROFILES_BRIEF_2026-09-20.md
sections B/C. Two things worth flagging, neither blocking:

## 1. `warrantyAlerts` tier definition (section B, GET /api/v1/customers)

The brief says "count of units with tier expired/expiring-90". `alertTier()`
(api/_lib/warrantyRules.js) buckets are mutually exclusive
(expired / expiring-30 / expiring-90 / expiring-365 / ok / unregistered-window-closing),
so a unit expiring in, say, 10 days has tier `expiring-30`, not `expiring-90` —
implemented `countWarrantyAlerts()` (api/_lib/routes/customers.js) literally per
the brief's two named tiers, so a unit inside its final 30 days is currently
NOT counted in this badge (it's still surfaced elsewhere via
/api/warranty-attention). If the intent was "anything inside 90 days,
including the urgent last 30", say so and I'll widen it to
`expired || expiring-30 || expiring-90` — one line.

## 2. `city` (section B) is a heuristic, not a stored fact

There is no separate city column anywhere in the schema — `service_address`
is one free-text string. `deriveCity()` (api/_lib/routes/customers.js) splits
on commas and takes the middle segment ("123 Main St, Phoenix, AZ 85001" ->
"Phoenix"); an address with no commas returns `null`. This is a display
convenience only, never a citable fact — don't wire it into search/filtering
as if it were structured data.

## Nothing else needed from another agent for this build.
