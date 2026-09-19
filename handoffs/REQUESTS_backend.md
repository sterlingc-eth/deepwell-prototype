# Requests from agent-backend

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
    `reclassify` ({ documentIds: string[] ≤100 }, no model call, skips
    already-canonical types), and `deleteDocuments` (see above — not
    functional yet).
  - AI-verified documents show `stage: 'verified'` with `verified_by: 'ai'`
    (vs a human's display-label string) — same field, different value, no
    schema change needed on your side beyond checking `verified_by === 'ai'`.
