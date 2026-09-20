# Data integrity build — 2026-09-20 (backend)

Contracts published early per the brief. Backend owner: recordsStore.js,
reviewStore.js, extractDocument.js, routes/customers.js, routes/cron-sweep.js,
NEW routes/integrity.js + _lib/integrity.js, NEW routes/export-csv.js,
scripts/verify-integrity.mjs. Frontend: do not touch these; consume the
contracts below.

## Root causes (owner findings, 2026-09-20)

**A. Duplicate customers (Castillo).** `findOrCreateCustomer`'s candidate
query only fetched customers whose `customer_name` matched the incoming name
**exactly** (case-insensitive). "Castillo" and "Ray & Linda Castillo" never
even became candidates for `selectCustomerMatch`, so two rows were created for
one household. Fixed: the candidate query now ALSO fetches by a normalized
surname (ILIKE), and `selectCustomerMatch` accepts `{name, address}` and adds
a fuzzy path via the new `customerMatchScore` (api/_lib/integrity.js) —
address normalized to a street-line key (house number + street name, suffix
stripped, unit/city/state/zip dropped) plus surname/substring name matching.
Still fill-only, still refuses on a genuine ambiguity (ports the same
"fail toward more rows, never a false merge" rule).

**B. Equipment linked, customer not (Margaret Henderson).**
`extractDocumentFields` only called `linkDocumentToCustomer` in the `else`
branch of `if (entity?.id) {...} else if (customer?.id) {...}` — i.e. a
document that resolved BOTH an equipment entity and a customer got a
`document_entity_links` row for neither the customer (only `entities.customer_id`
on the equipment row, via `setEquipmentCustomer`, which the review/customer
screens don't read for "is this document linked to a customer"). Fixed:
customer linking now runs unconditionally whenever `customer?.id` is
truthy, regardless of whether an equipment entity was also found.
`linkDocumentToCustomer`'s signature dropped the `entityId` gate — it now
always attempts the insert (idempotent via `ON CONFLICT DO NOTHING`) and the
forward-only stage bump.

**C. Multi-unit under-linked (Plaza Dental, 3 serials -> 1 equipment).** The
current extraction pipeline (extractFields.js's `groupFieldsByUnit` +
extractDocument.js's per-unit loop) already handles this correctly for any
document extracted or re-extracted under this build. The production document
in question predates that fix. `setEquipmentCustomer` was also only ever
called for the FIRST unit, not units 2+ — fixed so every unit's equipment gets
`customer_id` set. For documents extracted before multi-unit support existed,
there is no way to recover units 2/3's serials from already-written
`extractions` rows if the original write only ever kept one serial — the fix
for THOSE is `integrityFix`'s `createMissingUnits`, which flags a document
whose stored extractions carry >=2 distinct `serial_number` values but fewer
linked equipment entities, and creates the missing per-unit equipment from
whatever per-unit facts are already on file (best-effort field pairing when
counts don't line up 1:1). **No SQL needed** — see "Backfill" below.

## Response shapes

### GET /api/v1/customers

Was a bare array. Now:
```json
{ "customers": [ ...same shape as before... ], "duplicates": [ { "keepId": "uuid", "dropId": "uuid", "score": 0.97, "reason": "same address, matching name" } ] }
```
`duplicates` is every pair scoring >= 0.9 among the customers returned by this
call (same `q`/limit scoping). Frontend: read `.customers` instead of the
response itself; both old bare-array consumers and this shape can coexist
during rollout since the array is still there, just nested.

### POST /api/review — new actions

`{ action: 'integrityScan' }` -> 
```json
{
  "duplicateCustomers": [{ "keepId": "uuid", "dropId": "uuid", "score": 0.97, "reason": "..." }],
  "unlinkedDocuments": [{ "documentId": "uuid", "hasCustomerName": true, "hasAddress": true, "hasSerial": false, "suggestedCustomerId": "uuid|null" }],
  "equipmentWithoutCustomer": [{ "equipmentId": "uuid", "suggestedCustomerId": "uuid|null" }],
  "multiUnitDocsUnderLinked": [{ "documentId": "uuid", "unitsExtracted": 3, "unitsLinked": 1 }],
  "orphanEquipment": [{ "equipmentId": "uuid" }],
  "counts": { "duplicateCustomers": 1, "unlinkedDocuments": 4, "equipmentWithoutCustomer": 2, "multiUnitDocsUnderLinked": 1, "orphanEquipment": 0 }
}
```

`{ action: 'integrityFix', apply: ['mergeDuplicates','linkDocuments','linkEquipmentCustomers','createMissingUnits'], dryRun: false }` ->
```json
{
  "dryRun": false,
  "merged": [{ "keepId": "uuid", "dropId": "uuid", "score": 0.97 }],
  "documentsLinked": [{ "documentId": "uuid", "customerId": "uuid" }],
  "equipmentLinked": [{ "equipmentId": "uuid", "customerId": "uuid" }],
  "unitsCreated": [{ "documentId": "uuid", "equipmentId": "uuid", "serial": "..." }],
  "skipped": [{ "documentId": "uuid", "reason": "score below threshold" }]
}
```
Only score >= 0.9 merges are ever applied by `integrityFix`, whatever `apply`
requests (mirrors `selectCustomerMatch`'s own bar). Every action is
idempotent — running it twice with the same `apply` list is a no-op the
second time. Every applied action is audit-logged as `integrity.<verb>`.
Admin-only when the tenant is a Clerk org (same `hasShop`/`requireRole`
pattern as `deleteDocuments`).

### GET /api/v1/export?kind=documents|customers|equipment

Auth: session or API key with `read` scope. Streams `text/csv` with a
`Content-Disposition: attachment; filename="..."` header, RFC4180-ish
quoting, capped at 10,000 rows. Columns per the brief (documents: id,
filename, type, stage, customer number/name, service address, service date,
serials, verified_by, created_at; customers: number, name, address, phone,
email, doc count, equipment count, last activity; equipment: serial, model,
manufacturer, install date, warranty expiry/tier, customer number/name,
address).

## Nightly sweep (cron-sweep.js)

Runs `integrityFix` per tenant inside the shared 45s deadline, auto-applying
only score >= 0.95 merges plus all link fixes (`linkDocuments`,
`linkEquipmentCustomers`, `createMissingUnits`); lower-score duplicate pairs
are left as suggestions (surfaced via `GET /api/v1/customers`'s `duplicates`).
Also runs for the just-extracted document at the end of
`extractDocumentFields`, so a new document never sits unlinked waiting for the
nightly pass.

## Backfill

None needed for the linking/merge fixes. `integrityFix` (run by the owner
from the Customers screen, or by the nightly sweep) repairs existing data in
place — no manual SQL.

## DDL: M3-config/19-extraction-unit-index.sql (paste after 18-outreach.sql)

One column, idempotent: `extractions.unit_index SMALLINT` +
`(tenant_id, document_id, unit_index)` index. Corrects a follow-up finding —
`extractions.unit_index` never existed (no prior migration added it, neither
insert path wrote it); the model's per-unit tag was only ever used in-memory
during one extraction request (extractFields.js's `groupFieldsByUnit`), never
persisted, so a document's stored rows couldn't be re-grouped by unit later
without re-extracting. Both insert paths in recordsStore.js
(`createExtraction`, `replaceDocumentFields`) and every read that returns
extraction rows for the browser (`listExtractionsByDocuments`,
`listExtractionsByDocument` via `SELECT *`, `documentTypes.js`'s
`toCompletenessFields`) are guarded by a memoized
`extractionsHaveUnitIndex(db)` probe (same pattern as `documentsHaveUpdatedAt`)
— a deploy that lands before this file is pasted degrades to "always NULL",
never a 42703. `integrityFix`'s `createMissingUnits` also backfills
unit_index onto EXISTING rows (a document with >=2 distinct serial_number
values but none tagged) by order of appearance — done in application code
(api/_lib/integrity.js's `unitIndexBackfillPlan`, pure + tested), not SQL.
