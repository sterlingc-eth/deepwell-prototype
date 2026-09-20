# DeepWell — Customer profiles build brief (2026-09-20)

Read handoffs/TEAM_BRIEF_2026-09-19.md HARD RULES (12 files under api/ — currently exactly 12, so NO new top-level api files; dispatch through api/v1.js `?resource=` or api/review.js `action`; no new deps; no git; migrations as M3-config/15-customer-profiles.sql, idempotent; keep typecheck/typecheck:api/build/verify:all green).

## Goal (owner's words)
"Create a customer profile per unique customer and link all documents to that customer as we continue to work with that customer; a unique customer id per customer so everything is linked correctly and organized for that one person."

## What exists (read first)
- `entities` rows with entity_type='customer' (data: name, service_address, …), created/matched by `findOrCreateCustomer` + `selectCustomerMatch` in api/_lib/recordsStore.js (name + address match; advisory-locked).
- equipment.customer_id → customer (05-customer-link.sql); `linkDocumentToCustomer` / `linkDocumentToEntity` write `document_entity_links`; `mergeEntities` in api/_lib/reviewStore.js repoints everything and sets merged_into.
- Frontend: src/screens/EntityScreen.tsx (generic record view), BrowseScreen.tsx "Search" tab lists entities; DashboardScreen alerts carry customerName/serviceAddress.

## Build

### A. Customer number (backend, migration 15)
- `ALTER TABLE entities ADD COLUMN IF NOT EXISTS customer_number TEXT;` + partial UNIQUE index (tenant_id, customer_number) WHERE entity_type='customer'.
- Per-tenant sequence without a sequence object: SECURITY DEFINER fn `next_customer_number(p_tenant_id uuid) RETURNS text` that takes `pg_advisory_xact_lock(hashtext(p_tenant_id::text||':custno'))`, computes max existing numeric suffix + 1, returns `'C-' || lpad(n::text, 5, '0')` (C-00001…). Assign in `findOrCreateCustomer` on INSERT; backfill existing customers in the migration (ordered by created_at) — SQL in the file, idempotent (only rows with NULL customer_number).
- Also add columns to customer `data` (jsonb, no DDL): phone, email, notes, billing_address — populated from new extraction fields `customer_phone`, `customer_email` (add to FIELD_SPECS in api/_lib/extractFields.js; fill-once merge like other fields).

### B. Read API (api/_lib/routes/customers.js, dispatched from api/v1.js as `resource=customers` and `resource=customer`; vercel.json rewrites `/api/v1/customers` and `/api/v1/customer` already covered by the `/api/v1/:resource` rewrite)
- `GET /api/v1/customers?q=&sort=name|recent|docs&limit=200` → `[{id, customerNumber, name, serviceAddress, city, phone, email, documentCount, equipmentCount, lastActivity (max doc created_at / service_date), warrantyAlerts (count of units with tier expired/expiring-90), mergedInto:null}]` — one SQL with lateral counts; exclude merged rows.
- `GET /api/v1/customer?id=<uuid>|number=C-00012` → `{customer:{…all fields…}, equipment:[{id, serial, model, manufacturer, installDate, warranty:{tier, expires, daysLeft}}], documents:[{id, filename, type, stage, verifiedBy, createdAt, serviceDate, via:'direct'|'equipment:<serial>'|'name-match'}], timeline:[{date, kind:'service'|'install'|'invoice'|'warranty'|'document', title, documentId}] , duplicates:[{id, customerNumber, name, serviceAddress, reason}] }`. Documents = union of (a) document_entity_links → this customer, (b) links/extractions.entity_id → equipment owned by this customer, (c) extractions customer_name ILIKE name AND service_address matches (name-match, marked lower confidence). Dedupe by document id. Duplicates = other customers with same normalized name OR same normalized address (candidates for merge).
- Both Clerk-auth or API key 'read' scope, rate bucket 'read', tenant-scoped, ≤200 rows.

### C. Write actions (api/review.js `action`s, in api/_lib/reviewStore.js): 
- `createCustomer {name, serviceAddress?, phone?, email?, notes?}` → entity + customer_number.
- `updateCustomer {customerId, patch:{name?, serviceAddress?, phone?, email?, notes?}}` (allowlisted keys; audit).
- `assignDocumentCustomer {documentId, customerId}` → document_entity_links (replace any existing customer link for that doc), forward-only stage to linked, audit; and if the doc has equipment links, set that equipment's customer_id if null.
- `mergeCustomers {keepId, dropId}` → wraps mergeEntities (customer type only) + keeps the lower customer_number on the survivor, records dropped number in data.former_numbers.
- Tests: scripts/verify-customers.mjs (pure: number formatting/next-number math, document union dedupe, duplicate detection rules, patch allowlist).

### D. Ask integration (api/ask.js meta router + retrieval)
- Questions mentioning a customer number `C-\d{5}` → resolve to the customer and restrict retrieval to that customer's documents (pass allowed document ids into searchPassages/searchExtractions — add an optional `documentIds` filter to both, tenant-scoped).
- Meta questions "show everything for C-00012" / "list customers" → model-free answers listing docs/customers with sources.

### E. Frontend
- `src/services/customerClient.ts` (list, get, create, update, assign, merge — shapes above).
- `src/screens/CustomersScreen.tsx`: table (number, name, address, docs, equipment, last activity, alerts), search box, sort, "New customer" button. Lives as a third tab "Customers" on the Records screen (BrowseScreen.tsx tabs: Documents · Customers · Search) — Records stays the nav item.
- `src/screens/CustomerProfileScreen.tsx` (route `customer`, deep link `?customer=<id|number>`): header (C-00012 · name · address · phone/email, edit inline), stat tiles (documents, equipment, next warranty expiry), tabs: **Documents** (all, with "via" chip, open → review detail), **Equipment** (cards with warranty tier badge → EntityScreen), **Timeline** (chronological service/install/invoice/warranty events), **Notes**; actions: "Ask about this customer" (prefills Ask with `C-00012: ` prefix), "Merge duplicates" panel when `duplicates` non-empty (pick keep/drop, confirm), "Assign a document" (search docs by filename → assign).
- Review detail (ReviewScreen.tsx): show the linked customer (number + name) with "Change customer…" (search existing / create new inline) — replaces the confusing equipment-only "Record to link" for serial-less docs; keep equipment link too.
- Documents table (BrowseScreen) gets a Customer column (number + name, clickable).
- Dashboard alert rows and DocumentPreview "View record" link to the customer profile when a customer exists.
- Empty states and copy in the plain-English style of UX_FLOW_SPEC. Tests in scripts/verify-ui.ts (deep-link `?customer=`, number validation, timeline sort).

## Ownership
- agent-customers-backend: M3-config/15-customer-profiles.sql, api/_lib/recordsStore.js (findOrCreateCustomer number assignment, customer read helpers, searchPassages/searchExtractions documentIds filter), api/_lib/routes/customers.js (new), api/v1.js, api/_lib/reviewStore.js + api/review.js (actions), api/_lib/extractFields.js (customer_phone/customer_email), api/ask.js (customer-scoped retrieval + meta), scripts/verify-customers.mjs (new), scripts/verify-retrieval.mjs, scripts/verify-review.mjs, package.json (verify:customers in verify:all).
- agent-customers-frontend: src/services/customerClient.ts, src/screens/CustomersScreen.tsx, CustomerProfileScreen.tsx, BrowseScreen.tsx, ReviewScreen.tsx, DashboardScreen.tsx, src/components/DocumentPreview.tsx, src/App.tsx, src/hooks/useDeepLink.ts, src/store/appStore.ts, src/screens/index.ts, src/screens/AskScreen.tsx (prefill), scripts/verify-ui.ts.
