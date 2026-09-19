# Requests from agent-frontend

## agent-docs-access
- `src/services/documentClient.ts` did not exist, so I created it with only
  `deleteDocuments(ids: string[]): Promise<{deleted:number}>` (POST
  /api/review action:'deleteDocuments', same postJson/authHeader shape as
  reviewClient.ts). ReviewScreen's "Delete document" button calls it. Please
  overwrite with the full contract (also `getOriginalUrl`) — the
  `deleteDocuments` signature/behavior is already compatible, no caller
  changes needed on your side.
- Server-side `deleteDocuments` is still the 501 placeholder
  (`api/_lib/routes/document-delete.js`), so today the button surfaces
  "Document delete is not implemented yet." via the panel's inline error —
  this is expected until that lands, not a frontend bug.

- Cosmetic, your file: `src/components/DocumentPreview.tsx` line ~86 renders
  a missing-field issue's `i.field` raw. `DocumentIssue.field` now holds a
  canonical extraction field_key (possibly `a|b` alternatives, e.g.
  `"warranty_expires|warranty_term"`) instead of the old display-label
  string, so that line will show something like "Missing required field:
  warranty_expires|warranty_term". `requirementLabel` (exported from
  `src/domains/hvac/schema.ts`, re-exported from `documentTypes.ts`) turns
  that into "Warranty expires or Term" — a one-line swap:
  `{requirementLabel(i.field)}` instead of `{i.field}`.

## agent-backend
- No blockers. `api/_lib/documentTypes.js`'s shape (DOCUMENT_TYPES,
  REQUIRED_FIELDS with `a|b`, FIELD_LABELS, AI_VERIFY_MIN_CONFIDENCE,
  normalizeDocumentType) is hand-mirrored in `src/domains/hvac/documentTypes.ts`
  and asserted in sync by `scripts/verify-ui.ts` (imports your JS module via
  tsx). If you change any of those exports, re-run `npm run verify:ui` —
  it'll fail loudly if the mirror drifts.

## Note on the brief's item 6 (IntakeScreen) "when Advance is refused, show
the reason inline"
- Intake has no "Advance" control — only Review does (the footer's
  "Advance to <stage>" / "Mark verified" button). I implemented the refusal
  reason there: when blocked, the footer now lists the specific reasons
  (no type chosen / missing fields by label / not linked / a value disputed)
  instead of the previous generic "Resolve the items above."
