# Requests from agent-backend

## whoever owns api/extract.js
- UPDATE 2026-09-19 (limit-test fix pass): `api/upload-url.js`,
  `api/_lib/readDocument.js`/`api/read-document.js`, and
  `api/_lib/extractDocument.js` now validate `documentId` is uuid-shaped
  before it reaches any `::uuid`-cast SQL (a malformed id was turning into an
  uncaught 500 "invalid input syntax for type uuid" instead of a clean 400).
  `api/extract.js` has the same gap: it only checks
  `typeof documentId !== "string" || !documentId` before calling
  `extractDocumentFields`. That function is out of my edit scope for this
  task (not one of my owned files), so I didn't fix it — but it's the same
  vulnerability class. Suggested fix: import `isValidDocumentId` from
  `api/_lib/readDocument.js` (already exported) and return `400
  { error: 'documentId must be a uuid' }` before calling
  `extractDocumentFields`, same as the other endpoints.

## agent-docs-access
- `api/_lib/routes/document-delete.js` did not exist when I finished, and
  `api/review.js` statically imports it for `case 'deleteDocuments'` — a
  missing module fails that import for the WHOLE `/api/review` function, not
  just delete. I created a MINIMAL PLACEHOLDER there (`deleteDocuments`
  throwing a 501 "not implemented yet") purely so the endpoint keeps working.
  Please replace it with the real implementation per the brief's DELETE
  CONTRACT — the placeholder documents the expected signature and behavior at
  the top of the file. Nothing else in that file depends on your other work.

## agent-frontend
- New canonical document types, required fields, and per-document
  `completeness` are now live in the API:
  - `api/_lib/documentTypes.js`: `DOCUMENT_TYPES`, `REQUIRED_FIELDS`,
    `FIELD_LABELS`, `normalizeDocumentType`, `completenessFor`,
    `AI_VERIFY_MIN_CONFIDENCE` (0.85) — this is the single source of truth
    the brief calls for; please import ids/labels from here (or mirror
    exactly) rather than re-deriving them in `src/domains/hvac/schema.ts`.
  - `POST /api/document-status` response rows now also include
    `document_type` (already normalized to canonical), `verified_by`,
    `stage`, and `completeness: { type, required, present, missing,
    minConfidence, complete }`.
  - `POST /api/review` gained three actions: `aiVerify` ({ documentId }),
    `reclassify` ({ documentIds: string[] ≤100 }, and `deleteDocuments` (see
    above — not functional yet).
  - AI-verified documents show `stage: 'verified'` with `verified_by: 'ai'`
    (vs a human's display-label string) — same field, different value, no
    schema change needed on your side beyond checking `verified_by === 'ai'`.
  - UPDATE 2026-09-19 (bug-fix pass): `reclassify` no longer skips 'other' —
    it was being treated as an already-canonical, already-decided type, which
    is why real docs got stuck as "other" forever. It now ALSO makes up to 20
    cheap Haiku calls per request (only for docs its filename/fact heuristic
    still can't place) and returns `{ changes, remaining }` — `remaining` is
    how many documents still need another pass (still 'other' after this
    one). Please loop "Reclassify & verify all" while `remaining > 0`,
    calling with the SAME still-'other' documentIds each time, same as you'd
    already do for a >100-doc batch. Response shape for each entry in
    `changes` is unchanged ({ documentId, from, to }). A human's own
    classification (via `classifyDocument`) is still never overwritten.
  - `POST /api/document-status` rows now also include `fields:
    [{field_key, value, confidence}]` (corrected_value applied), reusing the
    extractions batch already fetched. This was silently missing before —
    the response object never had a `fields` key at all, so any client
    default of `[]` was masking it.
