# DeepWell — "Nothing unclassified, nothing blocked" build — team brief

Repo: /home/claude/work (Vite+React+TS at src/, Vercel serverless JS at api/, Neon Postgres, Cloudflare R2, Inngest, Clerk).
Live: https://deepwelltechnology.com/app/

## HARD RULES (all agents)
- **Vercel Hobby cap: exactly 12 files directly under api/. NEVER add a file under api/. New server code goes in api/_lib/** and is dispatched from an existing handler (api/review.js `action`, api/v1.js `?resource=`, api/account.js `?action=`, api/document-status.js, api/upload-url.js).**
- No new npm dependencies.
- Do NOT run `git` commands. Do NOT touch .env*, secrets, or Neon directly. Any DDL goes in a NEW file `M3-config/12-<name>.sql` (idempotent: IF NOT EXISTS / DO $$ blocks) — the owner applies it by hand. Prefer solutions that need no DDL.
- Use the cheapest model that works for any new model call (claude-haiku-4-5 via api/_lib/claude.js helpers); keep prompts cacheable (api/_lib/promptCache.js).
- Keep `npm run typecheck`, `npm run typecheck:api`, `npm run build`, and `npm run verify:all` green. Add/extend a scripts/verify-*.mjs for anything you build (pure-function tests, no DB).
- Only edit the files you OWN (listed per agent). If you need a change in another agent's file, write the exact request into handoffs/REQUESTS_<yourname>.md and stub around it.
- Terse code comments. No essays.

## The problem, as the owner sees it
- Documents show "Unclassified"; the AI must set a document type for every document. If nothing fits, add a type.
- Extracted fields (service_address, customer_name, warranty_term, technician, service_date, …) exist at 95–100% confidence but the "required fields" for the type (labels like 'Service address', 'Customer', 'Term') are blank → "Blocked at Classified — required fields missing". Everything sits Unverified.
- The AI should VERIFY documents itself when it is confident; humans only review what the AI is unsure about.
- Records health tiles say "0 / Clear" while docs are actually blocked (issues never recomputed on sync).
- No way to delete documents. "Open original" shows only "2 page(s) read." with no content.
- A zip dropped on the old "Add files" zone is ingested as one document instead of being unpacked.
- Ask box doesn't clear after submit (questions concatenate). "How many documents are in the system?" is unanswerable.
- Warranty: need brand warranty knowledge + alerts (expiring, expired, extended-warranty upsell).

## Root causes already identified (read these files first)
- Backend document_type values are `warranty | invoice | service_ticket | install_record | equipment_record | document` (api/_lib/extractDocument.js `inferDocumentType`) but the browser schema (src/domains/hvac/schema.ts) knows `work-order | invoice | warranty-registration | startup-sheet | permit | nameplate-photo | maintenance-agreement | other`. Mismatch → "Unclassified".
- src/domains/hvac/schema.ts `requiredFields` are display labels; extraction rows use snake_case `field_key`s (see api/_lib/extractFields.js for the full key list). src/core/entityGraph.ts `maxStageFor`/`recomputeIssues` compare names literally → always missing.
- src/hooks/usePostgresSync.ts builds Doc with `issues: []` and never calls recomputeIssues → health tiles read 0.
- Backend stages: received/read/mapped/linked/verified (STAGE_MAP in usePostgresSync.ts). Browser stages: received/classified/extracted/linked/verified. Backend `verifyDocument` (api/_lib/reviewStore.js) requires stage 'linked' + a document_entity_links row.

## CANONICAL DOCUMENT TYPES (single source of truth — everyone uses these ids)
```
work-order, invoice, warranty-registration, startup-sheet, permit, nameplate-photo,
maintenance-agreement, service-ticket, dispatch-note, proposal-quote, inspection-report,
purchase-order, equipment-record, correspondence, other
```
Legacy backend ids map: warranty→warranty-registration, service_ticket→service-ticket, install_record→invoice (if cost/invoice_number) else startup-sheet, equipment_record→equipment-record, document→other.

## CANONICAL REQUIRED FIELDS (extraction field_keys, not labels)
```
work-order:            service_address, service_date, technician
service-ticket:        service_address, service_date, work_performed
invoice:               service_address, cost           (invoice_number nice-to-have)
warranty-registration: serial_number, model, warranty_expires|warranty_term
startup-sheet:         serial_number, service_date
permit:                service_address, permit_number
nameplate-photo:       serial_number, model
maintenance-agreement: service_address, customer_name, warranty_term|agreement_term
dispatch-note:         customer_name|service_address, service_date
proposal-quote:        customer_name|service_address, cost
inspection-report:     service_address, service_date
purchase-order:        vendor|customer_name, cost
equipment-record:      serial_number|model
correspondence:        customer_name
other:                 (none)
```
`a|b` = either satisfies. Display labels come from a FIELD_LABELS map (service_address→"Service address", customer_name→"Customer", warranty_term→"Term", etc.).

## AI VERIFICATION CONTRACT
After extraction (api/_lib/extractDocument.js), compute `completeness = { type, required:[...], present:[...], missing:[...], minConfidence }`.
- If missing.length === 0 AND minConfidence ≥ 0.85 AND the document is linked to at least one entity → stage 'verified', verified_by = 'ai', verified_at = NOW(). (Add a `verifyByAiTx`-style function in reviewStore.js or recordsStore.js — forward-only, guarded in SQL.)
- Else leave stage as-is; the browser shows it in "Needs a person" with the exact missing keys / low-confidence fields.
- Browser shows "AI verified" (verified_by === 'ai') distinctly from a human verification; a human can still correct a field (which un-verifies, existing behavior).

## DELETE CONTRACT
- Server: `POST /api/review` with `{ action: 'deleteDocuments', documentIds: string[] }` (≤100). Deletes extractions, facets, document_pages, document_entity_links, review rows, then documents rows (tenant-scoped), then best-effort R2 deleteObject for each stored key. Admin role required when the tenant is a Clerk org (`hasShop(auth)` → `requireRole(auth,'admin')` pattern from api/_lib/routes/keys.js). Audit-log each. Returns `{ deleted: n, failedStorage: [...] }`.
- Client: `src/services/documentClient.ts` exporting `deleteDocuments(ids: string[]): Promise<{deleted:number}>` and `getOriginalUrl(id: string): Promise<{url:string, contentType:string, filename:string}>`.
- UI: delete on each Review detail (confirm), multi-select + "Delete selected" and "Empty this shop's documents" (typed confirm) on a Browse → Documents tab.

## OPEN ORIGINAL CONTRACT
- Server: `POST /api/upload-url` with `{ mode: 'get', documentId }` → `{ url, contentType, filename, expiresIn }` (presigned R2 GET, 15 min, tenant-scoped lookup of the document's storage key). Existing presign() in api/_lib/r2.js supports 'GET'.
- UI: src/components/DocumentPreview.tsx fetches it and renders: pdf → `<iframe>`; image → `<img>`; text → fetched text in `<pre>`; otherwise a download link. Loading/error states.

## OWNERSHIP
- **agent-backend**: api/_lib/extractFields.js, api/_lib/extractDocument.js, api/_lib/recordsStore.js, api/_lib/reviewStore.js, api/review.js (add deleteDocuments + listCompleteness if needed), api/_lib/documentTypes.js (NEW: canonical types, required fields, legacy map, FIELD_LABELS, `completenessFor(type, fields)`), api/document-status.js (include document_type, verified_by, completeness), scripts/verify-doctypes.mjs (NEW), scripts/verify-extract.mjs, scripts/verify-review.mjs.
- **agent-frontend**: src/domains/hvac/schema.ts, src/core/types.ts, src/core/entityGraph.ts, src/hooks/usePostgresSync.ts, src/screens/ReviewScreen.tsx, src/screens/RecordsScreen.tsx, src/screens/IntakeScreen.tsx, src/screens/AskScreen.tsx, src/services/reviewClient.ts, src/services/ingestClient.ts, src/components/StagePill.tsx, scripts/verify-ui.ts.
- **agent-docs-access**: api/upload-url.js, api/_lib/r2.js, api/_lib/routes/document-delete.js (NEW, called from api/review.js — coordinate: agent-backend adds the one-line dispatch `case 'deleteDocuments'` importing from routes/document-delete.js), src/services/documentClient.ts (NEW), src/components/DocumentPreview.tsx, src/screens/BrowseScreen.tsx, scripts/verify-docaccess.mjs (NEW).
- **agent-warranty**: api/_lib/warrantyRules.js, api/_lib/warrantyBrands.js (NEW if useful), api/warranty-attention.js, api/_lib/routes/v1-warranty.js, src/screens/DashboardScreen.tsx, src/components/WarrantyStatusBadge.tsx, scripts/verify-warranty.mjs, docs/HVAC_WARRANTY_RESEARCH.md (NEW).

## Definition of done (per agent) — report back with:
1. What you changed (file list + 1 line each).
2. Commands run and their results (typecheck/build/verify).
3. Anything you need from another agent (also written to handoffs/REQUESTS_<you>.md).
4. Any DDL you added (file name) and why it was unavoidable.
