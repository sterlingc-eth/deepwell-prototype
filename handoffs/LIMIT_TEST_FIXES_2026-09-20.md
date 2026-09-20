# Limit-test fixes (2026-09-20) — defects A–E

Fixes the 5 defects in `handoffs/LIMIT_TEST_RESULTS_2026-09-20.md`. No DDL run,
no new migration file (existing columns/JSONB only — `document_entity_links
.linked_by` repurposed for Fix D's provenance marker). `api/` still has
exactly 12 files. No git used.

## Files changed

- `api/_lib/extractFields.js` — shop_phone/shop_email FIELD_SPECS; customer_
  phone/email descriptions+prompt rule warn off the contractor's own number (A).
- `api/_lib/documentTypes.js`, `src/domains/hvac/documentTypes.ts` — FIELD_
  LABELS for shop_phone/shop_email (server + client mirror).
- `api/_lib/integrity.js` — `damerauLevenshteinDistance`, `SURNAME_FUZZY_MIN_
  LENGTH`/`MAX_DISTANCE`, `compareNamesStrict`'s new `surname-fuzzy` (B);
  `SHOP_CONTACT_ADDRESS_FLOOR`, `buildContactAddressCounts`, `isLikelyShopPhone`/
  `Email`; `buildMatchEvidence`/`evaluateCustomerMatch`/`findDuplicateCustomerPairs`
  take optional `ctx` that zeroes out a likely-shop phone/email on both sides (A).
- `api/_lib/recordsStore.js` — `computeShopAddressContext` also returns tenant
  phone/email keys; new `loadTenantContactKeys`; `findOrCreateCustomer` strips
  incoming phone/email matching the doc's own shop_phone/email or tenant
  contact (A); widened candidate query to same-address rows (B); `select
  CustomerMatch`'s exact-address shortcut now also requires name compatibility
  (equal/subset/surname — C); new `matchBasis` return so callers know a link
  was name-only (D); `linkDocumentToCustomer` takes `linkedBy`.
- `api/_lib/extractDocument.js`, `api/_lib/reviewStore.js` — pass `linkedBy:
  'ai:name-only'` when `matchBasis === 'name-only'`.
- `api/_lib/routes/integrity.js` — admin-gated `stripShopContact`,
  `relinkMismatchedNames`; scan helpers `buildContactCtx`/`findShopContactLeaks`/
  `loadMismatchedDirectLinks`/`loadSplitLinkDocuments`/`loadAmbiguousNameOnlyLinks`;
  `integrityScan` returns all 4 new lists+counts; `relinkMismatchedNameDocument`
  fix (unlink → re-match → link → move equipment introduced only by that doc);
  `stripShopContact` fix removes the leaked field from `entities.data`.
- `api/_lib/routes/cron-sweep.js` — nightly sweep also runs both new fixes,
  with their own summary counters.
- `src/services/ingestClient.ts` — `IngestStatus` gains `'waiting'`;
  `IngestHttpError` carries `retryAfterSeconds`; new `isDailyCapIngestError`,
  `isRetryableIngestStatus`, `IngestRateGate` (shared 15/30/60s backoff, honors
  `Retry-After`); `ingestFile` retries up to 3x through the gate; `ingestFiles`
  shares one gate across its 3 workers (E). Concurrency unchanged.
- `src/screens/IntakeScreen.tsx` — `UPLOAD_LABEL.waiting` copy.
- `src/services/reviewClient.ts`, `src/components/IntegrityPanel.tsx` — types/
  UI for the 4 new scan lists + 2 new fix actions.
- `src/core/types.ts` — new `DocumentIssue` variant `ambiguous-name-link`.
- `src/hooks/usePostgresSync.ts` — client `clientNormalizeSurname` +
  `addAmbiguousNameLinkIssues`: flags a doc linked `ai:name-only` whose
  customer's surname now matches ≥2 non-merged customers (D, no extra round trip).
- `src/screens/ReviewScreen.tsx`, `src/components/DocumentPreview.tsx` — render
  the ambiguous-link warning, reusing the existing "Change customer…" control.

## Verify

- `scripts/verify-integrity.mjs` — Damerau-Levenshtein; shop phone/email
  detection (3 vs 2 addresses); veto-ignores-shop-phone (score unaffected,
  tier demoted from auto to suggest); surname-fuzzy scoring; castro/castillo
  stays separate.
- `scripts/verify-customer-link.mjs` — different-name-same-address → null (C);
  misspelled-surname-same-address → null (B); single-candidate name-only link
  already covered by an existing case.
- `scripts/verify-bulk.mjs` — `isDailyCapIngestError`/`isRetryableIngestStatus`
  parity with bulkImport's own checks; `IngestRateGate` shared-window +
  Retry-After behavior (small ms delays so the suite stays fast).
- Incidental fixes surfaced along the way: a TS strict-mode error
  (`split(',')[0]` possibly undefined) in the new client helper; a
  constructor-parameter-property syntax Node's type-stripping can't parse, in
  `IngestRateGate`; one unused import (`customerMatchScore`) in routes/
  integrity.js.

**Result**: `npm run typecheck && npm run typecheck:api && npm run lint &&
npm run verify:all` all green; `npm run build` also run since UI files
changed — succeeded.

## Not done / scoped down

- Fix D's server-side `ambiguousNameOnlyLinks` scan is fully implemented and
  surfaced in the integrity panel, but the document-review banner is computed
  client-side from already-synced data instead of a dedicated round trip —
  deliberate, to keep this change's blast radius down.

## Review fixes (reviewer NO-GO, 2 blocking + 1 non-blocking)

1. **relinkMismatchedNames could unlink a human-chosen link.**
   `api/_lib/routes/integrity.js`'s `loadMismatchedDirectLinks` now joins
   `documents` and only selects `linked_by IN ('ai','ai:name-only')` (an
   allow-list, so it fails closed on any value it doesn't recognize — the
   real human path is `linked_by = 'human'`, written by
   `assignDocumentCustomer`, not `'You'`) and excludes `verified_by IS NOT
   NULL` or `stage = 'verified'`. Added exported pure `isEligibleForRelink`
   pinning the same rule (reviewStore.js's own "check the SQL against a plain
   function" pattern), applied again in JS as defense in depth. New verify
   cases in `scripts/verify-integrity.mjs`.
2. **Dry-run default for the two destructive fixes.**
   `applyIntegrityFix` now gives `stripShopContact` and `relinkMismatchedNames`
   their own `dryRun !== false` gate (same as `retireShopCustomers`) instead
   of sharing `effectiveDryRun`. `relinkMismatchedNames` is removed from
   `ALL_INTEGRITY_FIXES` (`src/services/reviewClient.ts`) — `stripShopContact`
   stays, since it's safe by construction. `IntegrityPanel.tsx` gets its own
   "Relink N documents Donovan is sure about" action, reading the scan's
   `mismatchedNameLinks` list and calling `integrityFix(['relinkMismatchedNames'],
   false)` explicitly. `cron-sweep.js` now makes two calls: the safe additive
   fixes + `stripShopContact` with `dryRun: false`, and a separate
   `relinkMismatchedNames` call with `dryRun: true` — logged as
   `integrityNamesRelinkable` (a count of what an admin could apply), not
   applied.
3. **Non-blocking: `issueSummary()` in `src/screens/IntakeScreen.tsx`** now
   has an `'ambiguous-name-link'` case ("Two customers share this name —
   confirm which one").

Additional changed paths: `api/_lib/routes/integrity.js`,
`api/_lib/routes/cron-sweep.js`, `src/services/reviewClient.ts`,
`src/components/IntegrityPanel.tsx`, `src/screens/IntakeScreen.tsx`,
`scripts/verify-integrity.mjs`.

**Result**: `npm run typecheck && npm run typecheck:api && npm run lint &&
npm run verify:all` all green again; `npm run build` re-run — succeeded.
