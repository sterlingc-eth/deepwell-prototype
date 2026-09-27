# Promoted tests (misses → permanent exam)

Each `<tenant-slug>.json` file here is one shop's own **promoted** exam questions — resolved
production misses an operator kept as permanent regression tests via the Donovan learning card
(`api/review.js`'s `examPromote`/`examList`/`examExport` actions, `api/_lib/learning/examPromote.js`).
Same `{id, text, category, shape, cmp, oracle}` question shape as
`test-docs/scorecard/generalization/*.json`, plus a top-level `tenantKey`:

```json
{
  "version": "2026-09-26.promoted-acme-hvac",
  "tenantKey": "acme-hvac",
  "category": "promoted",
  "questions": [
    { "id": "promoted-acme-hvac-3f9a1c2b0e",
      "text": "what's the model on the unit at 100 E Main St",
      "category": "field-lookup", "shape": "address-lookup", "cmp": "value",
      "oracle": { "sql": "SELECT value AS v FROM extractions WHERE document_id = $1::uuid AND field_key = $2 ORDER BY confidence DESC NULLS LAST LIMIT 1",
                  "params": ["<document-id>", "model"],
                  "requires": { "sql": "SELECT count(*)::int AS n FROM extractions WHERE document_id = $1::uuid AND field_key = $2", "params": ["<document-id>", "model"] } },
      "citationRequired": true }
  ]
}
```

## Why tenant-scoped

Unlike `generalization/*.json` (hand-written, tenant-agnostic), a promoted question's oracle SQL is
real production data — it names one shop's own `document_id`/`field_key` (and sometimes
`entity_id`). Grading it against a DIFFERENT tenant's export would be meaningless at best (rows that
don't exist there — the oracle's own `requires` guard SKIPS rather than fails, so it's safe, just
useless) and misleading at worst. `scripts/offline-exam.mjs`'s `loadPromotedCategoryQuestions` only
ever merges a file whose own `tenantKey` equals the export's `tenantKey` — every other run (no
tenant, or a different one) skips it silently, same as this directory being empty.

## How a file gets here (weekly repo-sync step, manual, same pattern the self-learning loop's
## vocabulary export already uses — handoffs/DONOVAN_SELF_LEARNING_2026-09-22.md)

1. In production, an operator opens the Donovan learning card (Team screen) and clicks **Keep as
   test** on a miss that now replays `answered_now` (or types the expected answer directly for one
   that doesn't reduce to a single cited field lookup — the one documented "operator supplies it"
   exception). This calls `POST /api/review {action: "examPromote", ...}`, which builds the
   candidate (`examPromote.js`) and upserts it into that tenant's own `donovan_promoted_tests` row
   (migration 56) — nothing here yet, still live-DB-only.
2. The operator clicks **Export promoted** (`POST /api/review {action: "examExport"}`), which returns
   the tenant's promoted set in the exact JSON shape above.
3. A Claude Code session (or the operator) saves that JSON as
   `test-docs/scorecard/promoted/<tenant-slug>.json` in this repo and commits it.
4. From then on, every `node scripts/offline-exam.mjs <export-for-that-tenant.json>` run (the nightly
   offline-exam loop, and `npm run verify:offline-exam`) merges that tenant's promoted questions
   automatically — no code change needed per promoted question, only per new tenant's first file.

A promoted test never needs re-generating by hand: re-running `examPromote` for the same question is
an upsert (same deterministic id), so exporting again after promoting more misses just grows the same
tenant's file.
