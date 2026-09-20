# Customer-linking root cause — 2026-09-20

Owner report: documents that clearly print the customer's name/address (example:
Henderson's Carrier warranty registration — `customer_name` "Margaret Henderson" 99%,
`service_address` "3247 Elm St, Mesa, AZ 85204" 99%, serial `4N2119-08772`) still show
in Inbox → "Needs a person" / "assign a document", and on Review as "Not linked to a
customer yet" — even though the equipment IS linked.

## Root causes found (4), in the order the ticket asked to trace

### 1. Ingest path — `findOrCreateCustomer` had no address-only path
`api/_lib/recordsStore.js:1233` (now 1236) — `findOrCreateCustomer(facts)` returned
`null` outright whenever `facts.customer_name` was blank, **even when
`facts.service_address` was present**. A permit, dispatch note, or nameplate photo
that names an address but never a person therefore got NO customer, ever — nothing
revisits an already-extracted document to try again.

Separately: `extractDocument.js`'s own linking (`extractDocument.js:296-378`) was
**already correct** going into this task — the earlier "Bug B" fix made
`linkDocumentToCustomer` unconditional (runs whether or not an equipment entity was
also found). That part of the brief's ask was already done; the gap was one level
down, inside `findOrCreateCustomer` itself, and in the fact that nothing ever
retried an old document once extracted.

**Fix**: `recordsStore.js` — `findOrCreateCustomer` now branches on name presence:
- name + address, no match by name → checks for an **address-only placeholder**
  customer at the same address (`data.name_source === 'address'`) and **upgrades**
  it with the real name (`recordsStore.js:1288-1315`, the "upgrade-by-fuller-name"
  path — a straight overwrite, not `preferFullerName`, since a placeholder is never
  a name worth keeping).
- no name, address present → new `findOrCreateCustomerByAddress` (`recordsStore.js:379-437`):
  exact-address match against existing customers (ambiguous = refuse, same
  "don't guess" rule as `selectCustomerMatch`), or **creates** a customer named
  `"Customer at <address>"` with `data.name_source = 'address'`
  (`api/_lib/integrity.js`'s new `addressOnlyCustomerName`/`isAddressOnlyCustomer`).
- no name, no address → still `null` (truly nothing to go on — say so plainly, per
  the owner's rule, rather than fabricate a name from nothing).

### 2. Verification/AI-verify path — two bugs
- **`api/_lib/reviewStore.js`'s `aiVerifyDocument`** (`:530-552`) only attempted the
  customer-link repair when `!rows.some((r) => r.entity_id)` — i.e. only for a
  document with **no equipment link at all**. Henderson's document already had an
  equipment link (serial matched), so this repair never even looked, even though
  the document had zero DIRECT customer links. **Fixed**: the gate now checks for an
  actual direct `document_entity_links → customer` row (`reviewStore.js:544-550`)
  and repairs whenever that's missing, regardless of the equipment-link state.
- `documentTypes.js`'s "linked to at least one entity" (`recordsStore.js`'s
  `verifyByAi`, `:505-518`) already counts a customer-only `document_entity_links`
  row as sufficient — that part needed no change; it was never equipment-only.

### 3. Sync/display — the actual "Not linked" bug on screen
`src/screens/BrowseScreen.tsx` already had a fallback (added 2026-09-20, comment:
*"most rows showed '—' although the document is linked to a unit that belongs to a
customer"*): if no direct customer link, fall back to the linked equipment's
`customer_id`. **`src/screens/ReviewScreen.tsx`'s `customerEntityFor` never had that
fallback** — it only checked a direct link. Same document, same data, two screens,
two different answers: Browse showed the customer (via the equipment fallback),
Review said "Not linked to a customer yet." This alone reproduces the exact
production symptom even for documents where the backend link was actually fine.

`src/components/DocumentPreview.tsx` had the SAME missing fallback, plus a second,
independent bug: its name-match fallback compared `e.fields.name` — but a synced
customer entity's field is `customer_name` (`usePostgresSync.ts`'s `toEntity`
passes non-equipment `data` through as-is), so `e.fields.name` was always
`undefined` and that fallback never matched anything.

`listEntities()` (`recordsStore.js:603-605`, called with no `type` arg from
`usePostgresSync.ts:327`) already fetches every entity type including `'customer'`
— confirmed no filter excludes customers.

**Fix**: new `src/core/customer.ts` — `customerForDocument(doc, entities)`: direct
link → linked unit's customer → `null`. Used in `BrowseScreen.tsx:148`,
`ReviewScreen.tsx:563`, `DocumentPreview.tsx:216` (and its name-match fallback fixed
to read `customer_name`). `CustomerProfileScreen.tsx` needed no change — its
document list comes from the server (`api/_lib/routes/customers.js`'s
`listCustomerDocumentLinks`), which already walks the equipment→customer path
correctly in SQL.

Also fixed the analogous backend definition mismatch that let this go undetected:
`api/_lib/routes/integrity.js`'s `loadUnlinkedCandidates` (`:56-89`) used to treat a
document as "linked to a customer" if its EQUIPMENT's `entities.customer_id` was
set — even with no direct `document_entity_links` row to the customer. That is
**more lenient** than what the UI actually reads (`customerForDocument` only trusts
`doc.linkedEntityIds`, which never includes a transitive `customer_id`), so any
document in Henderson's exact shape (equipment linked, `customer_id` set, no direct
link) was invisible to `integrityScan`, the nightly cron sweep, and "Fix
everything" alike — every automated repair path agreed the document was already
fine while the screens disagreed. Removed the two lenient UNION branches; now only
a direct link counts, matching the frontend exactly.

### 4. Existing data — repair now runs where it's cheap, not just where it's rare
- `integrityFixDocument` (`api/_lib/routes/integrity.js:485-502`, called after every
  extraction — unchanged) and `applyIntegrityFix`'s `linkDocuments` /
  `linkEquipmentCustomers` actions (`:352-390`) now call `findOrCreateCustomer`
  (can create an address-only placeholder) instead of the read-only
  `suggestCustomer`, except in `dryRun` mode (which must never write, so it still
  previews with `suggestCustomer`).
- `integrityFix`'s admin gate (`:462-471`) now only requires admin when `apply`
  includes `'mergeDuplicates'` — the only destructive action in the list.
  `linkDocuments`/`linkEquipmentCustomers`/`createMissingUnits`/
  `healMergedSurvivors` only add links or fill blanks (`ON CONFLICT DO NOTHING`,
  fill-only) and no longer require an admin role, per the owner's explicit
  instruction.
- `src/hooks/usePostgresSync.ts:404-427` — new `runInboxLinkSweep`: one
  `integrityFix(['linkDocuments','linkEquipmentCustomers'])` call, fired after a
  successful Inbox load, debounced to once per tenant per page load (module-level
  guard, not re-run on manual `refresh()`). If anything got linked, it re-syncs the
  graph so the screen reflects it immediately instead of waiting for the next
  visit or the nightly cron.

## Decision table (document type × facts → links created)

| Document type | customer_name | service_address | serial | model | Customer link created? |
|---|---|---|---|---|---|
| warranty-registration | yes | yes | yes | yes | **Yes, direct** (unconditional since Bug B; not required for type-completeness, but always attempted) |
| warranty-registration | yes | yes | yes | **no** | Direct link still attempted; type is INCOMPLETE (`missing: ['model']`) → correctly surfaced as "Needs a person" for the missing field, not the customer |
| dispatch-note | yes | no | — | — | Yes (name-based `findOrCreateCustomer`) |
| permit | **no** | yes | — | — | Yes — **new**: address-only `findOrCreateCustomerByAddress`, creates `"Customer at <address>"` if nothing matches |
| correspondence | yes | no | — | — | Yes |
| equipment-record | no | no | yes | yes | **No customer link** — correctly: names nobody, nothing to link. `isUnlinkedDocument` returns `false`. |
| maintenance-agreement | **no** | yes | — | — | Type INCOMPLETE (`missing: ['customer_name']`) — a real gap, correctly surfaced |
| work-order | no | yes | — | — | Yes, address-only |
| startup-sheet | no | no | yes | — | No customer link (names nobody); equipment link only |
| invoice | no | yes | — | — | Yes, address-only |

Encoded as executable fixtures (10 documents, matching this table) in
`scripts/verify-linking.mjs`, asserted against the real pure functions
(`completenessFor` server+client, `isUnlinkedDocument`, `recomputeIssues`+
`isAttention`) — not hand-verified prose.

## Message precision (item 2)
`ReviewScreen.tsx`'s Customer panel (`:207-219`) now shows one of three states,
never a bare "not linked":
- a name, when linked (via `customerForDocument`).
- *"Names a customer but hasn't linked yet — use the suggestion below or search."*
  when `customer_name`/`service_address` was extracted but no link exists yet — this
  is the bug case, and after the fixes above it should be rare/self-healing (the
  Inbox-load sweep or `aiVerifyDocument` fixes it within one page load), but the
  copy no longer implies it's a task the document is missing.
- *"This document doesn't state a customer or service address."* only when
  genuinely true (`hasCustomerFacts` false) — the owner's "say so plainly" case.

## What to expect after this push
- The Henderson-shaped case (equipment linked, customer resolved server-side but
  no direct link row) is fixed on the NEXT Inbox load for every existing tenant —
  no manual "Fix everything" click required, and no admin role required for it.
- A brand-new address-only document (no customer name at all) gets a real,
  visible "Customer at <address>" record instead of sitting owner-less forever;
  the next document naming the real person at that address upgrades it in place.
- Inbox "Needs a person" should drop to documents with an actual gap: a missing
  required field, a genuine conflict, or a document that names literally nobody
  can't be turned into "gap" — none of those are link-repair bugs.
- Review and Browse can no longer disagree about who a document belongs to.

## Shop-address guard (reviewer follow-up, same day)
The address-only create path above has one failure mode: a document with no
separate service address but a printed company letterhead could turn the
CONTRACTOR'S OWN address into a "customer". Fixed with a pure decision
function plus per-tenant signal:
- `api/_lib/integrity.js`'s `isLikelyShopAddress(addrKey, { tenantAddressKey,
  letterheadCounts })` — true when `addrKey` matches the tenant's own address
  on file, OR was ever extracted as `shop_address`, OR appears as
  `service_address` on ≥3 distinct documents naming ≥3 distinct customer
  names (`SHOP_ADDRESS_DOC_FLOOR`/`SHOP_ADDRESS_CUSTOMER_FLOOR`).
- `api/_lib/extractFields.js` — new document-scoped `shop_address` field, and
  `service_address`'s guide now explicitly tells the model not to use the
  contractor's own letterhead address for it.
- `api/_lib/recordsStore.js`'s `computeShopAddressContext(db, tenantId)`
  aggregates `tenants.settings->>'address'` (if set) and the letterhead
  signal from `extractions` in one pass; `findOrCreateCustomerByAddress` and
  `findOrCreateCustomer(facts, shopContext)` refuse to create/link a shop
  address (log `integrity.skip_shop_address`), leaving the document to read
  "doesn't state a customer" for a human instead of gaining a fake owner.
  `loadShopAddressContext()` lets a bulk loop (the fix actions below)
  compute the signal once instead of per row.
- `api/_lib/routes/integrity.js` — `integrityScan` now reports
  `suspectedShopAddresses`; a new admin-only, dry-run-by-default
  `retireShopCustomers` fix action unlinks documents from an address-only
  placeholder whose address turned out to be a shop address and marks it
  `merged_into: null, data.retired: true` (never a hard delete).
- Tests: `scripts/verify-linking.mjs` — Desert Peak letterhead (5 docs / 3
  distinct customer names) -> shop; a real customer address (5 docs / 1 name)
  -> not shop; plus the tenant-address and single-`shop_address`-tag cases.

## Rate limit + cross-tab dedupe (reviewer follow-up, same day)
`integrityScan`/`integrityFix` can each walk up to ~1000 rows; nothing
stopped a stuck tab or a runaway effect from looping either.
- `api/review.js` now calls the existing `limit(req, res, auth, 'write')`
  helper (same one v1 routes use) for those two actions only, before dispatch.
- `api/_lib/routes/integrity.js` adds a 10-minute per-tenant debounce for a
  LINK-ONLY sweep (`linkDocuments`+`linkEquipmentCustomers` alone, exactly
  what `usePostgresSync.ts`'s Inbox-load auto-fix sends): a compare-and-swap
  `UPDATE tenants SET settings...integrity_last_link_sweep...` when that
  falls back to a module-level `Map` on any DB error. Debounced calls return
  `{ skipped: true, reason: 'recent' }` instead of running — never an error.
  Other `apply` combinations (e.g. the admin "Fix everything" button, which
  always includes `mergeDuplicates`) are never debounced.
- `src/services/reviewClient.ts` — `IntegrityFixResult` is now a union
  (`IntegrityFixApplied | IntegrityFixDebounced`) with an `isIntegrityFixDebounced`
  narrowing helper, since the debounced shape's `skipped: true` is a different
  type from the applied shape's `skipped: {documentId, reason}[]`.
  `usePostgresSync.ts`'s sweep and `IntegrityPanel.tsx` both narrow before
  reading fields. Client keeps its existing once-per-tab guard on top.

## Verification
- `npm run typecheck`, `npm run typecheck:api`, `npm run build`, `npm run verify:all`
  — all green (`scripts/verify-linking.mjs`, run via `tsx`, added to `verify:all`,
  including the shop-address decision-table tests above).
- No DDL. No new `api/` files (all changes in `api/_lib/**`). No new dependencies.

## Files touched
- `api/_lib/recordsStore.js` — `findOrCreateCustomer` address-only path +
  placeholder upgrade; new `findOrCreateCustomerByAddress`; new
  `computeShopAddressContext`/`loadShopAddressContext` for the shop-address guard.
- `api/_lib/integrity.js` — new `addressOnlyCustomerName`, `isAddressOnlyCustomer`,
  `isLikelyShopAddress` (+ its two floor constants).
- `api/_lib/extractFields.js` — new `shop_address` field; `service_address`
  guide rewritten to exclude the contractor's own letterhead.
- `api/_lib/documentTypes.js` / `src/domains/hvac/documentTypes.ts` — `shop_address` label (kept in parity).
- `api/_lib/routes/integrity.js` — `loadUnlinkedCandidates`'s stricter
  "linked to customer" definition; `linkDocuments`/`linkEquipmentCustomers`/
  `integrityFixDocument` use `findOrCreateCustomer` (can create, shop-address-
  aware); admin gate now `ADMIN_ONLY_ACTIONS` (`mergeDuplicates`,
  `retireShopCustomers`); new `loadSuspectedShopAddresses`,
  `loadShopCustomersToRetire`, `retireShopCustomers` fix action; 10-minute
  link-sweep debounce.
- `api/review.js` — rate-limits `integrityScan`/`integrityFix` via the
  existing `limit()` helper.
- `api/_lib/reviewStore.js` — `aiVerifyDocument`'s repair gate now keys off a
  direct customer link, not "any entity_id".
- `src/core/customer.ts` (new) — `customerForDocument`, the single source of truth.
- `src/screens/ReviewScreen.tsx`, `src/screens/BrowseScreen.tsx`,
  `src/components/DocumentPreview.tsx` — use `customerForDocument`; ReviewScreen's
  Customer panel copy made precise; DocumentPreview's `e.fields.name` typo fixed
  to `e.fields.customer_name`.
- `src/hooks/usePostgresSync.ts` — `runInboxLinkSweep`, fired once per tenant per
  Inbox load; now narrows the debounced response shape.
- `src/services/reviewClient.ts` — `suspectedShopAddresses` on the scan result;
  `IntegrityFixResult` split into `IntegrityFixApplied | IntegrityFixDebounced`
  with `isIntegrityFixDebounced`; `retireShopCustomers` added to
  `IntegrityApplyAction`.
- `src/components/IntegrityPanel.tsx` — narrows the fix-result union before
  reading fields.
- `scripts/verify-linking.mjs` (new + shop-address tests), `package.json`
  (`verify:linking` in `verify:all`).
