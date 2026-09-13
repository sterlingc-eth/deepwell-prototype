# Where customer documents actually live — storage research

**Date:** September 13, 2026 · Companion to `claude/M3_PLAN.md` (which already named Postgres+R2 as the recommendation) and `claude/DOCUMENT_HANDLING_AGREEMENT_DRAFT.md` (§2–3, the retention/security promises this has to make true). This document is the research behind that recommendation — real, current pricing and tradeoffs, not just a name — plus how "private" and "cheap but fast to retrieve" actually get built, not just promised.

## The short answer

Two stores, doing two different jobs, exactly as `claude/M3_PLAN.md` already scoped:

1. **Postgres (Neon)** holds everything DeepWell actually queries — entities, facets, extractions, the registry, proposals, the audit log. This is what makes retrieval fast: an indexed database row, not a search through files.
2. **Object storage (Cloudflare R2)** holds the original uploaded files and rendered page images — the "evidence," fetched by document id only when someone clicks "Open original" or when Ask cites a page image. Not something Ask queries directly.

Splitting it this way is what makes "cheap but fast" not a contradiction: the thing accessed on every question (facets, extracted fields) lives in the fast, more expensive-per-GB store, but there isn't much of it (a few KB of text per document). The thing that's actually large (page images, original PDFs) lives in the cheap store, and it's fine that it's not the fastest thing in the system, because it's fetched by exact key, on demand, for one document at a time — never scanned or searched.

## What "private" actually requires — this determines vendor choice as much as price does

"Cheap" and "fast" are vendor-comparison questions. "Private" is a design requirement that has to be true regardless of vendor, and it's the one a company handing over thousands of documents will actually ask about:

- **Encryption in transit and at rest** — table stakes; every option below provides both by default.
- **Tenant isolation enforced at the database layer, not just in application code** — Postgres row-level security (`tenant_id = current_setting('app.tenant_id')`), tested with a CI check that a cross-tenant read actually fails. This is a Postgres feature, not a vendor feature — it's true on Neon, Supabase, or self-hosted Postgres alike. Already scoped in `claude/M3_PLAN.md` §2.
- **Short-lived, signed URLs for original documents, never a public bucket** — an original document (an HVAC invoice with a customer's name and address on it) should never be reachable by a guessed or leaked URL that doesn't expire. Both R2 and S3 support this the same way (presigned URLs, default private buckets).
- **No training on customer data** — this is a subprocessor/contract question, not a storage-vendor question. It matters for the model API (Anthropic — see `claude/DOCUMENT_HANDLING_AGREEMENT_DRAFT.md` §5), not for where bytes are stored. Neon/R2/S3/Supabase don't train on customer data merely by storing it; that's a red herring in this specific decision.
- **A real deletion story** — when a tenant leaves, every row and every original file need to actually be gone, provably, within a stated window (`claude/M3_PLAN.md` §3's "tenant-deletion job" + signed deletion certificate). This is an engineering commitment DeepWell has to build, not something a vendor provides out of the box — true on every option below equally.

None of the four storage options compared below differ on the privacy questions that matter — they all support encryption, private-by-default buckets, and access control adequate for this design. The real differentiators are cost and how retrieval is architected, which is what the rest of this document is about.

## Object storage: where the actual documents (not the data extracted from them) live

| | Storage | Egress (downloading it back out) | Notes |
|---|---|---|---|
| **Cloudflare R2** (recommended) | $0.015/GB-month standard, $0.01/GB-month for infrequent-access | **$0** — R2's entire pitch is zero egress fees | 10 GB storage + 1M write + 10M read operations free every month |
| AWS S3 Standard | $0.023/GB-month (first 50 TB, us-east-1) | First 100 GB/month free, then $0.09/GB (first 10 TB), stepping down at higher volume | The default a lot of engineers reach for; egress is the real cost driver here, not storage |
| Backblaze B2 | $6.95/TB-month (≈ $0.0068/GB) — cheapest raw storage of the three | Free up to 3x what's stored monthly, then $0.01/GB; **free unlimited egress through partner CDNs** (Cloudflare among them) | Cheapest sticker price on storage; the free-egress-via-partner-CDN model works well specifically if fronted by Cloudflare anyway |
| Supabase Storage | Bundled into Supabase's own plan pricing (backed by S3-compatible storage under the hood) | Bundled/metered, less transparent per-GB than the others | Only worth it if already committing to Supabase for Postgres too — see below |

**Why R2, concretely, not just "recommended" as a holdover:** the retrieval pattern here — a customer opens a document, or Ask cites a page image, and the bytes get downloaded once — is exactly what egress fees charge for on S3. At real volume (thousands of documents, opened repeatedly during onboarding review and ongoing use), egress is the cost that actually grows with usage, not storage. Zero egress isn't a nice-to-have here, it's the line item that would otherwise scale unpredictably with how much customers actually use the product — the opposite of what a predictable SaaS cost structure needs. Backblaze's raw storage price is lower still, and its Cloudflare-fronted free egress deal is a real, valid alternative if there's ever a reason to move off R2 — worth keeping in mind as a fallback, not a reason to delay building against R2 now.

**A concrete number, at `claude/M3_PLAN.md`'s own S1 launch tier (≤25 tenants, ≤500k documents):** assume ~3 rendered page images per document plus the original file, averaging roughly 900 KB/document all-in (a real, if rough, planning number — actual figures should be measured against real customer documents once M3's onboarding pilot batches start running, not assumed from this estimate). 500,000 × 900 KB ≈ 450 GB. On R2: **450 GB × $0.015 ≈ $6.75/month storage, $0 egress**, plus operation costs that round to a few dollars a month at this call volume. On S3 Standard: same storage cost is close (≈$10.35/month), but repeated document opens during review and ongoing use would add a real, usage-scaling egress line that R2 simply doesn't have. This is a small enough number at launch scale that it's not the reason to choose either vendor — the egress *shape* (flat vs. scaling with usage) is the reason, and it holds at 10x or 100x this volume too.

## Postgres: where everything DeepWell actually retrieves lives

| | Storage | Compute | Notes |
|---|---|---|---|
| **Neon** (recommended) | $0.35/GB-month on paid plans (storage effectively unlimited, billed for what's used) | Metered per compute-hour ($0.106–$0.222/CU-hour depending on plan), scales to zero when idle | Free tier: 0.5 GB storage + 100 compute-hours/project — enough to build and test M3 against before any real tenant exists. Branching (a full copy-on-write clone of the database) is genuinely useful for a staging environment that mirrors production schema without copying real tenant data into it. |
| Supabase | Plans start ~$25/month (Pro) bundling Postgres + auth + storage together | Bundled into the plan tier rather than metered standalone | Attractive specifically because it *also* offers auth and storage in one bill — a real alternative to "Neon + Clerk + R2" as three separate vendors, at the cost of being locked into one vendor's version of all three instead of picking the best-fit tool for each. |
| Self-hosted Postgres (e.g. on a VM) | Cheapest at very large scale, but the least "free tier to start on" of any option | Requires DeepWell to own patching, backups, failover | Not recommended at this stage — the whole point of M3 is to get real persistence built and tested quickly; managed Postgres removes an entire category of operational risk (a missed patch, a botched manual backup) exactly when there's no dedicated ops person yet. |

**Why the entity/facet/extraction data belongs in Postgres, not something like a NoSQL or vector store:** DeepWell's retrieval model (`claude/STORAGE_AND_RETRIEVAL_MODEL.md`) is structured and typed — entities with typed fields, facets with a full-text index, exact identifier lookups — not similarity search over embeddings. There's no RAG/vector-database need here; a GIN full-text index on `facets.label_raw || facets.value_raw` (already scoped in `claude/M3_PLAN.md`'s SQL) gives fast facet search directly in Postgres, and typed columns give exact/range queries (a warranty expiring "in the next 90 days") without a second system to keep in sync. Adding a vector database would be solving a retrieval problem DeepWell doesn't have, at the cost of a second store to keep private, backed up, and consistent with the first.

**Same S1 scale estimate:** entities, facets, extractions, proposals, and the audit log for 500,000 documents is measured in low tens of GB, not hundreds — this data is small, structured records, not the documents themselves. At $0.35/GB-month that's single-digit dollars a month in storage; compute is the bigger of the two Postgres cost lines, and it's genuinely usage-driven (scales with how many Ask questions and ingestion pipeline runs happen, which is a fair cost to scale with, unlike egress on a document a person just wants to look at again).

## What this means combined, and what's still a real estimate rather than a fact

At the S1 launch tier, total storage infrastructure (R2 + Neon, both storage and a conservative compute estimate) lands in the same "tens of dollars a month" range `claude/M3_PLAN.md`'s cost table already gave — this document adds the reasoning and current vendor pricing behind that number, it doesn't change the recommendation. The one thing worth being honest about: the 900 KB/document and "low tens of GB of structured data" estimates above are planning numbers, not measurements. `claude/INGESTION_STRATEGY_AT_SCALE.md`'s staged-rollout pilot batch (50–100 real documents, fully reviewed) is also the first point real per-document storage size can be measured against an actual tenant's paperwork instead of assumed — that's worth tracking explicitly as part of M3's onboarding flow, not left as a one-time guess in this document.

## What doesn't change based on this research

The vendor choice already in `claude/M3_PLAN.md` (Neon + R2) holds up under this pricing/architecture comparison — this wasn't a case of picking wrong and needing to redirect Sterling's account-creation effort. The two things worth carrying forward from this research specifically:

1. **R2's zero-egress model is the reason, not just "no egress fees is nice"** — it's what keeps a customer opening their own documents repeatedly from ever becoming a cost surprise, which matters more the more a customer actually uses the product.
2. **No vector database, no second retrieval system** — DeepWell's structured facet/entity model is a genuinely better fit for Postgres full-text + typed columns than for embeddings, and every extra system is one more thing to keep private, backed up, and correct. Worth stating explicitly so a future "should we add a vector DB for search" suggestion gets weighed against what's actually being solved, not added by default.

Sources: [Neon pricing](https://neon.com/pricing) · [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [AWS S3 pricing](https://aws.amazon.com/s3/pricing/) · [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing) · [Supabase pricing](https://supabase.com/pricing) — all fetched September 13, 2026; pricing changes over time and should be re-checked before finalizing account setup.
