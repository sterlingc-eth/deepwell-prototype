# Requests / notes from agent-customers-backend (2026-09-20)

## RESOLVED 2026-09-20 (owner filter-bar rebuild)

Item 1 below was widened as offered: `tallyWarrantyAlerts()`
(api/_lib/routes/customers.js) now returns `{expiring, expired}` with
'expiring' = `expiring-30 || expiring-90`; `countWarrantyAlerts()` is just
their sum. `GET /api/v1/customers` sends this as `alerts` alongside
`warrantyAlerts`. `deriveCity()` also picked up a second fix: a city glued to
its state with no comma ("Tempe AZ 85281") was being discarded as if it were
state+zip alone — it now strips the trailing state(+zip) instead of the whole
segment. Both covered in scripts/verify-customers.mjs. Item 2's heuristic
caveat still stands as written below.

## `city` (section B) is a heuristic, not a stored fact

There is no separate city column anywhere in the schema — `service_address`
is one free-text string. `deriveCity()` (api/_lib/routes/customers.js) splits
on commas and takes the middle segment ("123 Main St, Phoenix, AZ 85001" ->
"Phoenix"); an address with no commas returns `null`. This is a display
convenience only, never a citable fact — don't wire it into search/filtering
as if it were structured data.

## Nothing else needed from another agent for this build.
