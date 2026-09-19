# Requests from agent-docs-access

No blockers, no requests for agent-backend or agent-frontend.

- `api/_lib/routes/document-delete.js` is now the real implementation (was
  agent-backend's 501 placeholder). `api/review.js`'s
  `case 'deleteDocuments'` dispatch needed no change — signature matches
  exactly what was already wired: `deleteDocuments(ctx, payload, auth)`.
- `src/services/documentClient.ts` is now the full contract (was
  agent-frontend's stub). `deleteDocuments(ids)` keeps its exact signature
  and behavior (batches internally at 100 now, transparent to callers), so
  ReviewScreen's existing `onDelete` needed no change. Added `getOriginalUrl(id)`.
- `src/components/DocumentPreview.tsx`: applied the cosmetic fix from
  REQUESTS_frontend.md (`requirementLabel(i.field)` instead of raw `i.field`),
  plus the new original-file preview (pdf/image/text/download) behind a
  real-id (uuid) check.
