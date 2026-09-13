# M3 Plan — Real persistence, security, and tenancy

**Date:** September 13, 2026 · **Trigger:** Sterling — "if a company is trusting us with 1000s of documents, we need a proper ingestion strategy" → this milestone is the infrastructure half of that answer (`claude/INGESTION_STRATEGY_AT_SCALE.md` is the process half).

**Why now, not after further M2 polish:** M2's pipeline is real and, as of this update, passes its accuracy gates. But everything it produces lives in `indexedDB` inside one person's one browser — no server, no backup, no encryption-at-rest guarantee, no boundary between one company's documents and another's. A company cannot be honestly told their thousands of documents are safe with DeepWell until that changes. This was always the plan (`claude/M2_PLAN.md`'s "Not in M2" list explicitly deferred accounts/tenancy/server persistence), and the architecture for it was already designed before M0 even started — `claude/ENGINEERING_REQUIREMENTS_SPEC.md` §2–3 and `DEEPWELL_BUILD_SPEC.md` §2–3 lay out the exact stack. This plan adapts that existing design for M2's open-schema (v2) data (facets, proposals, versioned registry) which didn't exist when the original spec was written, and turns it into a concrete build order.

**Storage vendor choice, researched:** `claude/STORAGE_COST_AND_PRIVACY_PLAN.md` is the current-pricing research behind the Neon+R2 recommendation below — what "private" actually requires regardless of vendor, why R2's zero-egress model fits how documents actually get re-opened, and why this data doesn't need a vector database. Read that document for the reasoning; this section is the resulting account checklist.

## What blocks starting: accounts only you can create

I can write every line of the M3 code, but five external accounts have to exist first, because they're billing relationships and identity/ownership decisions no one but you can make. Here's exactly what's needed, in the order you'll hit them:

| # | Service | What it's for | What I need from you | Cost at launch scale (S1: ≤25 tenants, ≤500k docs — see spec §16) |
|---|---|---|---|---|
| 1 | **Postgres host** — Neon (recommended) or Supabase | The real database: entities, documents, facets, extractions, proposals, registry, audit log | Create the account, create one project/database, give me the connection string (I'll never see your login) | Neon free tier covers early dev; ~$19–69/mo at S1 production |
| 2 | **Object storage** — Cloudflare R2 (recommended, no egress fees) or AWS S3 | Original uploaded files and rendered page images, stored immutably | Create the account/bucket, give me an access key scoped to that one bucket | R2: ~$0.015/GB/mo storage, no egress fee — a few dollars/mo at this scale |
| 3 | **Auth provider** — Clerk (recommended) or Auth.js | Real login, sessions, and organizations-as-tenants, so I'm not hand-rolling authentication | Create the account, give me the API keys | Clerk free tier covers up to 10,000 monthly active users |
| 4 | **Background jobs** — Inngest | Runs the ingestion pipeline durably (retries, per-step tracking) instead of hoping a browser tab stays open | Create the account, give me the API key | Free tier covers S1 volume |
| 5 | **Error/uptime monitoring** — Sentry + a simple uptime check (UptimeRobot or similar) | So a failure page is discovered by us, not by a customer calling in | Create the account, give me the DSN | Sentry free tier covers this scale |

Optional, can wait until closer to a real customer: **AWS Textract** (OCR with word-level bounding boxes — Claude vision alone, which M2 already uses, is a reasonable v1 without it) and **Postmark** (transactional email for invites/alerts — needed once real accounts and warranty-expiry alerts exist).

None of these require a credit card commitment beyond free tiers to start building against — I can build and test the entire M3 layer on free-tier accounts, and the cost table above only matters once there's a real paying tenant.

## What M3 actually builds

### 1. Data model (extends the existing spec's tables with M2's v2 concepts)

The original spec (§3.2–3.3) already designs `tenants`, `documents`, `document_pages`, `extractions` for a closed-schema model. M2 added an open schema on top of that — this needs three new tables and one column addition, not a redesign:

```sql
-- New: facets are first-class, citable, whether or not they're ever mapped
facets(id, tenant_id, document_id, page_no, segment_id,
       label_raw, value_raw, value_type_guess, bbox jsonb, confidence numeric(4,3),
       mapped_entity_type text, mapped_field_key text, mapping_confidence numeric(4,3),
       mapping_method text check (mapping_method in ('registry','synonym','learned','human')),
       schema_version_at_mapping int, proposal_id uuid references proposals(id),
       linked_entity_ids uuid[])
create index on facets (tenant_id, document_id);
create index on facets using gin (to_tsvector('english', label_raw || ' ' || value_raw)); -- the facet index (index #3 from the storage model doc)

-- New: schema-growth proposals, human-confirmed or auto-promoted
proposals(id, tenant_id, kind text check (kind in ('document_type','aspect','field','entity_type','relation','synonym','enum_value')),
          label text, target_entity_type text, target_field_key text,
          evidence jsonb, status text check (status in ('pending','confirmed','rejected')),
          created_at, resolved_at, resolved_by)

-- New: every registry change is a versioned, auditable row (tenant-scoped above tier 0)
schema_versions(id, tenant_id, version int, change_kind text, description text, created_at, created_by)

-- Extend the existing field-registry concept (tier 0 shipped, 1 discovered, 2 confirmed, 3 shared) with per-tenant columns
-- on whatever table holds field specs per domain — tier, synonyms text[], observation_count, added_in_schema_version
```

`extractions` (already in the original spec) gains `schema_version` and `mapping_method` columns to match M2's client-side `IngestMapMatch` shape exactly — this keeps the migration mechanical: M2's `RecordsStore` interface (`src/core/recordsStore.ts`) was deliberately designed so the pipeline code never talks to IndexedDB directly, only to that interface. **The migration is: implement the same `RecordsStore` interface against Postgres+R2 instead of IndexedDB, and none of `src/core/pipeline/*.ts`'s eight step functions change.** This was the whole point of that abstraction in M2 — it's paying off now.

### 2. Security and tenancy (non-negotiable before any real customer document lands here)

Straight from the existing spec §10, unchanged because it was already right:
- Row-level security on every tenant table (`tenant_id = current_setting('app.tenant_id')`), with a CI test that tries a cross-tenant read and asserts it fails — not just a code review promise.
- TLS everywhere, encryption at rest on the database/storage/backups, short-lived (15 min) signed URLs for original documents, no public buckets.
- Full audit log for every mutation and every DeepWell-staff access, exportable by the tenant owner — this is also what makes the "your corrections make the system sharper" promise (ING-08) and the ingestion-strategy doc's error-budget tracking auditable rather than just claimed.
- PII minimization in every model call (only the fields the call actually needs), and — this one needs action, not just code — **a signed Data Processing Agreement with Anthropic on file before real customer PII goes through the API in production**, plus using zero-data-retention API endpoints where available. See `claude/DOCUMENT_HANDLING_AGREEMENT_DRAFT.md` for how this gets disclosed to your customers as a subprocessor.

### 3. Backups and the "take it all with you" promise

Point-in-time recovery (30 days) plus a nightly logical dump to a second region, with a quarterly restore drill that's actually run and documented, not assumed to work. Self-service full export at any time (already partially promised as EXP-04). A tenant-deletion job that removes every row (RLS-scoped, so it can't accidentally touch another tenant) and produces a signed deletion certificate — this is the kind of thing that turns into a real problem the first time a customer asks for it and it doesn't exist yet.

### 4. Onboarding flow, wired to the staged-rollout gates in the ingestion strategy doc

Account creation → first (capped) pilot batch → tenant-specific accuracy measurement against the customer's own real documents (not the generic 27-doc eval) → ramp batches with confidence-tiered auto-approval → full-volume unlock. This is where `claude/INGESTION_STRATEGY_AT_SCALE.md`'s layer-3 staged rollout stops being a policy on paper and becomes an actual gate in the product — a tenant literally cannot upload their full 10,000-document backlog until the ramp stages have passed.

### 5. Observability

`/api/health`, Sentry on both the web app and the serverless functions, the Inngest dashboard for pipeline job status, and the SLO table already defined in the original spec §11 (availability, Ask latency, pipeline failure rate, per-tenant eval accuracy, spend) wired to real alerts, not just a table in a document.

## Build order

1. Provision the five accounts above (your action) → confirm connectivity with a trivial round-trip from a throwaway script.
2. Postgres schema (tenants/users/memberships, documents/pages, extractions, **facets/proposals/schema_versions** per above), RLS policies, migration tooling.
3. `RecordsStore` Postgres+R2 implementation matching `src/core/recordsStore.ts`'s existing interface exactly — the pipeline steps should need zero changes.
4. Auth (Clerk) wired to `tenant_id`/role on every request; replace the current no-auth demo shell.
5. Background jobs (Inngest) running the same eight pipeline steps durably, replacing "runs in the browser tab" with real retries and dead-lettering to the review queue on repeated failure.
6. Backups, audit log export, tenant deletion job — tested with an actual restore drill before this milestone is called done, not assumed.
7. Onboarding flow with the staged-rollout batch gates.
8. Independent verification pass (same pattern as M0–M2): fresh environment, real tenant created end to end, cross-tenant read attempt confirmed to fail, restore drill actually run, real documents ingested through the full pipeline on server-side storage.

## Definition of done

Matches the existing spec's MUST-level bar for "first paying customer" (§15, §10 SEC-01 through SEC-06): a real tenant's documents are stored encrypted, backed up, isolated from every other tenant by an enforced (not just coded) boundary, deletable on request with proof, and the onboarding flow will not let a tenant's full document volume in until their own measured accuracy has held steady across staged ramp batches. Until this is true, "a company is trusting us with thousands of documents" is a claim the product can't yet honestly support — this milestone is what makes it true.
