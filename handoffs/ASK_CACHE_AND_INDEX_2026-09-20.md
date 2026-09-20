# /api/ask answer cache + tenant-first search indexes — 2026-09-20

## What

1. **Per-tenant answer cache.** `api/_lib/askCache.js` (new) + `api/ask.js`.
   Key: `hashQuestion(normalizeQuestion(question))` (both already existed in
   ask.js, now exported). On the non-meta path, `retrieveEvidence()` fetches
   the tenant's `corpus_stamp` and any matching cache row in the SAME query,
   inside the SAME `withTenant` transaction retrieval already opens — one
   round trip, no new connection. A hit skips `searchPassages`/
   `searchExtractions` AND the Anthropic call entirely; response carries
   `cached: true`. A miss proceeds as before; the post-response bookkeeping
   (already async, after `res.json()`) upserts the row. `ASK_CACHE=0` (Vercel
   env) disables the whole thing with zero DB calls added.
2. **Tenant-first composite indexes.** `document_pages (tenant_id, tsv)` and
   `extractions (tenant_id, value gin_trgm_ops)`, both GIN via `btree_gin`.
   Old single-column indexes kept.

Migration: `M3-config/17-ask-cache-and-search-index.sql` (idempotent).

## Invariant

A cached row is reused only if **all** hold: `corpus_stamp` matches the
tenant's current stamp, `today` matches exactly (SQL predicate, not JS —
date-relative answers like "days left" can't leak past midnight), and the
row is <24h old (JS, so the TTL rule stays pure/testable). `corpus_stamp` is
`md5()` of four tenant-scoped aggregates:

| table | signal | catches |
|---|---|---|
| documents | count, count(stage='verified'), max(updated_at) | ingest, delete (count), verify/unverify (stage count), classifyDocument (new `updated_at` bump — the one write path with no other signal) |
| extractions | count, max(coalesce(corrected_at, created_at)) | field correction, (re)extraction |
| document_entity_links | count, max(created_at) | link/unlink/assignDocumentCustomer (always delete+insert, never in-place) |
| entities | count, max(updated_at) | merge, customer/equipment field fills |

`documents` had no `updated_at` before this — added via the migration and
bumped only in `reviewStore.js`'s `classifyDocument` (one line); every other
write path already touched one of the columns above.

Missing-table safety: `getCacheEntry`/`upsertCacheEntry` probe once per warm
instance (a `SAVEPOINT` around the combined query, so a 42P01 can't poison
the shared retrieval transaction), memoize the result, and skip the
`SAVEPOINT` round trip forever after — so this costs nothing once the
migration is applied, and never breaks `/api/ask` before it is.

## Apply (owner, by hand)

Paste `M3-config/17-ask-cache-and-search-index.sql` into the Neon SQL editor
for the production database and run it. Idempotent — safe to re-run. No
`CONCURRENTLY` (tables are small; the file says how to redo it later if that
changes).

## Verify the index is used

In a Neon SQL editor session with `app.tenant_id` set the way an
authenticated request sets it, run the `EXPLAIN (ANALYZE, BUFFERS)` query at
the bottom of the migration file. Expect `Bitmap Index Scan on
document_pages_tenant_tsv_idx`, not the old `document_pages_tsv_idx` alone
and not a `Seq Scan`.

## Expected savings

A cache hit skips both DB search queries and the one Anthropic call per
question — the two most expensive parts of `/api/ask` per
`handoffs/ASK_LATENCY_2026-09-20.md`. Anywhere the same question (or a
same-normalized rephrasing) is asked twice in a day with no answer-changing
write in between, the second ask returns in one Server-Timing `cache` stage
instead of `retrieve` + `model`. The composite indexes shrink the query
inside `retrieve` itself on a cache miss, though at today's per-tenant corpus
size (a handful of documents) the difference is not yet visible in wall time.

## Files

- `api/_lib/askCache.js` (new) — cache lookup/upsert, corpus_stamp, TTL.
- `api/ask.js` — wires the cache into `retrieveEvidence` + post-response bookkeeping; exports `normalizeQuestion`.
- `api/_lib/reviewStore.js` — `classifyDocument` bumps `documents.updated_at`.
- `api/_lib/rateLimit.js` — exported `logOnce` for askCache.js's missing-table log throttle.
- `M3-config/17-ask-cache-and-search-index.sql` (new) — `documents.updated_at`, `ask_answer_cache` table+RLS+grants, composite indexes.
- `scripts/verify-ask-cache.mjs` (new) — pure tests; added to `verify:all`.
