# DeepWell — Build Handoff
**Date:** September 12, 2026 · **From:** Sr. Solutions Architect (Claude) · **To:** the DeepWell app build chat
**Repo:** `sterlingc-eth/deepwell-prototype` (marketing site at `/`, app at `/app`, functions in `/api`)

## Start here (instructions for the build chat)

1. Read, in this order, from the DeepWell project: `claude/PRODUCT_DECISION_ASK_INTERFACE.md` (the binding product decision), `claude/REQUIREMENTS_TRACEABILITY.md` (scorecard — what is shipped, mocked, partial, missing, with file:line evidence), then this document (the engineering blueprint).
2. Work the milestones in order: **M0 → M1 → M2 → M3 → M4 → M5** (defined in §15 and in the traceability doc). Do not start M2 before M1's eval gate passes on the real provider.
3. Every PR cites requirement IDs from this spec and updates the traceability rows it touches. A requirement is **SHIPPED** only when its acceptance criteria pass on real input, not seed data.
4. Before each milestone, give Sterling a short plan (files, order, risks) and wait for a go-ahead. Work in small commits; run `tsc`, the build, `npm run eval`, and the 390 px check before each commit.
5. Never mark something done that only works because the seed data was written to make it work. Never add user-facing text containing "AI", "model", "LLM", or a vendor name.
6. When you finish a milestone, write `claude/<MILESTONE>_BUILD_SUMMARY.md` to the project: what shipped (with REQ ids), what's still mocked, and exactly what to test in the Vercel preview.

Sections 1–15 are the specification. Section 16 is the scaling plan — read it before making any infrastructure choice so that what you build at 10 customers still works at 1,000.

---

# DeepWell — Engineering Requirements Specification (v1.1)
**Date:** September 12, 2026
**Author:** Sr. Solutions Architect (Claude), for Sterling Chapman
**Companion:** `claude/REQUIREMENTS_TRACEABILITY.md` (scorecard: what's shipped vs. missing). This document is the blueprint: everything the product must do to deliver what the website promises, in enough detail to build from.
**Conventions:** Requirement IDs are `AREA-nn`. **MUST** = launch-blocking for the first paying customer. **SHOULD** = Team plan. **MAY** = Enterprise/roadmap. Every requirement has acceptance criteria (AC).

---

## 1. Product scope and non-negotiables

DeepWell is a multi-tenant SaaS knowledge platform. A customer (tenant) uploads their business records — paper scans, PDFs, spreadsheets, photos, email attachments — and asks plain-English questions. Every answer is built only from that tenant's records and cites the document, page and field each fact came from. HVAC contractors are the first vertical; the core is domain-neutral and verticals are adapters.

Non-negotiables, derived from the website's "Rules we don't bend":

- **NN-1 Provenance.** No fact is stored, displayed, or spoken without a source (document, page, location). Enforced by types, database constraints, and server validation — never by convention.
- **NN-2 Isolation.** A tenant's data is never visible to, pooled with, or used to train anything for another tenant. Enforced by row-level security and per-tenant storage prefixes.
- **NN-3 Honesty.** If the records don't support an answer, the system says so and shows the closest documents. It never guesses.
- **NN-4 Field-first.** Every customer-facing screen works one-handed on a 390 px phone in sunlight or an attic, with a dropped signal, and never flashes.
- **NN-5 Measured.** Each tenant has a live accuracy number on their own question set. Below 95%, go-live is blocked and DeepWell staff keep working.
- **NN-6 Language.** No user-facing text says "AI", "model", "LLM", or a vendor name. It says records, sources, linked, verified.

---

## 2. System architecture

### 2.1 Components

| Component | Choice (v1) | Why |
|---|---|---|
| Web app | React 18 + TypeScript (strict), Vite, Tailwind; served at `/app` | Existing codebase |
| Marketing site | Static `index.html` at `/` in the same Vercel project | Existing |
| API | Vercel serverless functions (`/api/*`) for request/response; **Inngest** for durable background jobs (ingestion pipeline, alerts, eval runs) | Inngest runs on Vercel, gives retries, concurrency limits, fan-out, and step-level durability without running servers |
| Database | **Postgres 16** (Neon or Supabase) with `pgvector`, `pg_trgm`, `unaccent`; **row-level security on every tenant table** | One system for relational, provenance, full-text and vector retrieval |
| Object storage | S3-compatible (Cloudflare R2 or AWS S3), one bucket, key prefix `tenants/{tenant_id}/…`, server-side encryption, versioning on | Originals are immutable and must be retrievable forever |
| OCR | **AWS Textract** (`AnalyzeDocument` with FORMS + TABLES, `StartDocumentAnalysis` for multi-page PDFs) with **Claude vision** as fallback/verifier for handwriting and low-quality scans | Textract gives word-level bounding boxes and confidence; Claude reads what Textract can't |
| Extraction / classification / answering | Claude API: **Haiku** for classification and per-field extraction; **Sonnet** for answers; all calls tool-forced with JSON schemas | Cost/latency split |
| Auth | **Clerk** (or Auth.js) — email+password, magic link, Google; organizations = tenants; roles | Don't build auth |
| Email intake | Postmark Inbound (or SES receipt rules) → `/api/ingest/email` | Per-tenant address `records-{slug}@in.deepwell.co` |
| Folder sync | Google Drive API (watch channel) first; Dropbox second | Team plan |
| Document viewer | pdf.js for PDFs; native `<img>` for photos; XLSX rendered to HTML grid | Real originals with bbox highlight |
| Monitoring | Sentry (web + functions), Vercel Analytics, Inngest dashboard, Postgres slow-query log, UptimeRobot on `/api/health` | |
| Email/SMS out | Postmark (transactional), Twilio (optional SMS alerts) | Alerts, invites |

### 2.2 Request flow

```
Browser ──HTTPS──▶ Vercel edge ──▶ /api/* (auth via Clerk JWT → tenant_id, role)
                                   ├─ /api/ask            → retrieval (Postgres) → Claude → validator → stream
                                   ├─ /api/ingest/*       → presigned upload → document row → Inngest event
                                   ├─ /api/graph/*        → mutations (RLS-scoped) → audit_log
                                   ├─ /api/dashboard/*    → materialized views
                                   └─ /api/export/*       → CSV/PDF/ZIP (background for large)
Inngest workers ──▶ pipeline steps (classify → ocr → extract → normalize → resolve → dedupe → conflicts → index)
                    each step idempotent, retried ≤5× with backoff, dead-letter to review queue with reason
```

### 2.3 Environments
`dev` (local, `vercel dev` + Neon branch), `preview` (per PR, Neon branch, seeded sample tenant), `prod`. Secrets only in Vercel env; never in repo. Separate Claude API keys per environment with spend caps.

---

## 3. Data model

Postgres. All tenant tables carry `tenant_id uuid not null` and an RLS policy `tenant_id = current_setting('app.tenant_id')::uuid`. All timestamps `timestamptz`. All ids `uuid` (v7 for locality). Soft delete via `deleted_at` where a user can undo; hard delete via retention job.

### 3.1 Accounts

```sql
tenants(id, slug unique, name, vertical text default 'hvac', plan text check (plan in ('starter','team','enterprise')),
        status text, created_at, settings jsonb)         -- settings: timezone, brand name, field-mode defaults
users(id, email unique, name, created_at)
memberships(tenant_id, user_id, role text check (role in ('owner','office','tech','readonly','staff')),
            invited_by, accepted_at, primary key (tenant_id,user_id))
branches(id, tenant_id, name, address)                    -- Enterprise; default one branch per tenant
api_keys(id, tenant_id, name, hash, scopes text[], last_used_at, revoked_at)
```

`staff` = DeepWell employee acting inside a tenant with the owner's recorded consent (`consents` table: who, scope, expires). Every staff action is audit-logged with `acting_as_staff = true`.

### 3.2 Documents and pages

```sql
batches(id, tenant_id, name, source text check (source in ('cabinet','email','drive','truck','api','import')),
        date_from date, date_to date, created_by, created_at, closed_at,
        doc_count int, stats jsonb)                       -- stats updated by pipeline: per-stage counts, p95 latency
documents(id, tenant_id, batch_id, branch_id,
          filename, mime, bytes bigint, sha256 bytea, storage_key, page_count int,
          uploaded_by, uploaded_at, source_meta jsonb,     -- email from/subject, drive path, device
          type_id text,                                    -- from domain vocabulary; null until classified
          type_confidence numeric(4,3),
          classification jsonb,                            -- candidates [{type_id, confidence}]
          ocr_status text, extract_status text, resolve_status text,   -- per-step: pending|running|done|failed
          failure_reason text,
          verified_by, verified_at,
          duplicate_of uuid references documents(id),
          deleted_at)
create index on documents (tenant_id, sha256);
create index on documents (tenant_id, batch_id);
document_pages(id, document_id, tenant_id, page_no int, width int, height int,
               image_key text,                            -- rendered page PNG (for viewer + vision)
               ocr_text text, ocr_blocks jsonb,           -- Textract blocks: words with bbox + confidence
               tsv tsvector generated always as (to_tsvector('english', coalesce(ocr_text,''))) stored)
create index on document_pages using gin (tsv);
```

**Stage is derived, not stored:**
```
received   := document row exists
classified := type_id is not null and type_confidence >= 0.85 (or human-set)
extracted  := all required fields for type_id have an extraction with status in ('auto','confirmed')
linked     := exists link with status='linked'
verified   := verified_at is not null
```
Implemented as a SQL function `document_stage(document_id)` and a materialized view `document_stages` refreshed by the pipeline. The UI never sets a stage; it sets the underlying facts.

### 3.3 Extractions (facts with provenance)

```sql
extractions(id, tenant_id, document_id, page_no int,
            field_key text,                                -- from domain field registry, e.g. 'equipment.serial'
            value_raw text, value_norm text,               -- normalized: dates ISO, serials uppercased/stripped, money numeric
            value_type text check (value_type in ('text','date','money','serial','model','address','person','number')),
            confidence numeric(4,3),
            bbox jsonb,                                    -- {x,y,w,h} in page fraction 0..1
            extractor text, extractor_version text,        -- 'textract-forms','claude-haiku-2026-06','human'
            status text check (status in ('auto','needs_review','confirmed','rejected','superseded')),
            reviewed_by, reviewed_at, superseded_by uuid,
            created_at)
create index on extractions (tenant_id, document_id);
create index on extractions (tenant_id, field_key, value_norm);
create index on extractions using gin (value_norm gin_trgm_ops);
```

**Constraint that enforces NN-1:** an extraction must have `document_id`, `page_no`, and (`bbox` or `extractor='human'` with `reviewed_by`). `check ((bbox is not null) or (extractor = 'human' and reviewed_by is not null))`.

### 3.4 Entities and links

Generic entities + typed facts, so a second vertical adds rows to a registry, not tables.

```sql
entity_types(vertical, type_id, label, display_fields text[], key_fields text[])   -- registry seeded per vertical
field_registry(vertical, field_key primary key, label, value_type, entity_type, required_for_doc_types text[],
               aliases text[])                            -- aliases map extractor labels → field_key
entities(id, tenant_id, branch_id, type_id, canonical jsonb,   -- {serial:'…', model:'…'} projection of current facts
         display_name text, search tsvector, embedding vector(1024), created_at, merged_into uuid)
entity_facts(id, tenant_id, entity_id, field_key, value_norm, value_display,
             extraction_id references extractions(id) not null,   -- provenance: every fact points at an extraction
             status text check (status in ('current','superseded','disputed')),
             verified_by, verified_at, superseded_by)
create unique index on entity_facts (entity_id, field_key) where status='current';
entity_relations(tenant_id, from_entity, to_entity, relation text,      -- equipment→property 'installed_at', event→technician 'performed_by'
                 extraction_id, primary key (from_entity,to_entity,relation))
links(id, tenant_id, document_id, entity_id, role text,                  -- 'subject','mentions'
      confidence numeric(4,3), method text,                              -- 'serial_exact','address_norm','name_fuzzy','human'
      status text check (status in ('linked','unlinked','rejected')),
      best_guess_entity uuid, reason text, linked_by, linked_at)
conflicts(id, tenant_id, entity_id, field_key,
          candidates jsonb,                                              -- [{extraction_id, value, document_id, page, confidence}]
          status text check (status in ('open','resolved','dismissed')), resolved_value text,
          resolved_extraction_id, resolved_by, resolved_at, note text)
duplicates(id, tenant_id, document_id, duplicate_of, method text,        -- 'sha256','field_signature','page_image_phash'
           score numeric(4,3), status text, merged_by, merged_at)
```

**Materialized HVAC views** (for dashboards; refreshed on pipeline completion and every 15 min):
`hvac_equipment` (entity + serial, model, manufacturer, install_date, property_id, warranty_parts_expiry, warranty_labor_expiry, last_service_at, last_technician_id), `hvac_service_events`, `hvac_properties`, `hvac_customers`, `hvac_technicians`, `hvac_agreements` (customer, property, term_start, term_end, renewal_date, visits_included, visits_used, status), `hvac_warranty_windows`.

### 3.5 Questions, answers, evaluation

```sql
questions(id, tenant_id, user_id, text, asked_at, channel text, include_unverified bool, latency_ms int,
          answer jsonb,                                    -- the full Answer object as rendered
          kind text check (kind in ('answer','no_answer','error')), sources_count int, feedback text)
eval_sets(id, tenant_id, name, created_by, created_at, active bool)
eval_questions(id, eval_set_id, text, expected jsonb)     -- expected: {kind, entity_id?, must_contain[], must_cite[]}
eval_runs(id, tenant_id, eval_set_id, provider text, started_at, finished_at, passed int, total int, results jsonb,
          triggered_by text)                               -- 'nightly','pipeline','manual','go_live'
```

### 3.6 Operations

```sql
jobs(id, tenant_id, kind, ref_id, status, attempts, last_error, created_at, started_at, finished_at)  -- mirror of Inngest runs for UI
audit_log(id, tenant_id, actor_user_id, acting_as_staff bool, action, target_table, target_id, before jsonb, after jsonb, at, ip)
notifications(id, tenant_id, user_id, kind, payload jsonb, channel text, scheduled_for, sent_at, read_at)
alert_rules(id, tenant_id, kind text, params jsonb, channels text[], enabled bool)   -- e.g. warranty_expiring {days:[90,30]}
integrations(id, tenant_id, provider text, status, credentials_ref text, settings jsonb, last_sync_at, cursor jsonb)
exports(id, tenant_id, kind, params jsonb, status, storage_key, requested_by, created_at, expires_at)
```

### 3.7 Retention, backups, deletion
- **DB-01 MUST** Point-in-time recovery, 30 days; nightly logical dump to a second region; restore drill quarterly (documented runbook).
- **DB-02 MUST** Originals in object storage are immutable and versioned; deletes are soft for 30 days then purged.
- **DB-03 MUST** Tenant deletion: one job removes all rows (RLS-scoped) and storage prefix; produces a signed deletion certificate.
- **DB-04 MUST** "Take it all with you": full export (§8.4) available at any time, self-service.

---

## 4. Ingestion at scale

### 4.1 Channels

| Channel | Requirement | Tier |
|---|---|---|
| Drag-and-drop / file picker | ING-01 MUST. Multi-file, folders (webkitdirectory), up to 500 files or 2 GB per drop; each file ≤ 50 MB (PDF/JPG/PNG/HEIC/TIFF/XLSX/XLS/CSV/DOCX/MSG/EML); client computes sha256 and requests a presigned PUT per file; parallel uploads (6); resumable via tus or multipart for > 20 MB; progress per file and per batch. | Starter |
| Bulk import (zip / scanner output) | ING-02 MUST. Up to 5 GB zip; server unpacks in a job; preserves folder path as `source_meta.path`; creates one batch. Used by DeepWell staff during white-glove setup. | Starter |
| Truck / phone | ING-03 MUST. Camera capture (§6.3) → same upload path; fast lane priority. | Starter |
| Email intake | ING-04 SHOULD. Per-tenant inbound address; attachments become documents; email body stored as `source_meta`; sender must be an allow-listed domain or member; auto-reply with batch link. | Team |
| Folder sync | ING-05 SHOULD. Google Drive folder watch (push notifications + periodic reconcile); new/changed files ingested; deletions do not delete records. | Team |
| API | ING-06 MAY. `POST /v1/documents` with API key; same pipeline. | Enterprise |
| Integration pull | ING-07 SHOULD. Jobber/ServiceTitan jobs, customers, equipment as structured "documents" of type `integration_record` with source = the integration. | Team |

### 4.2 Limits and capacity targets

| Metric | Starter | Team | Enterprise |
|---|---|---|---|
| Documents stored | 5,000 | unlimited (fair use 250k) | unlimited |
| Pages processed / month | 10,000 | 100,000 | negotiated |
| Concurrent pipeline workers per tenant | 4 | 16 | 32 |
| Upload → searchable (p95, single doc, fast lane) | ≤ 2 min | ≤ 2 min | ≤ 2 min |
| Upload → searchable (p95, bulk batch of 1,000 pages) | ≤ 60 min | ≤ 30 min | ≤ 30 min |
| Backfill throughput (system-wide) | 20k pages/hour | | |

Per-tenant concurrency limits (Inngest `concurrency: { key: tenant_id, limit }`) so one customer's 40,000-page backfill cannot starve another's truck upload. Two queues: `fast` (single uploads, camera, email) and `bulk` (batches > 25 files). Fast preempts bulk.

### 4.3 Pipeline steps (each an idempotent Inngest step keyed by `document_id`)

1. **receive** — verify sha256 matches upload; if `(tenant_id, sha256)` exists → mark `duplicate_of`, stop (ING-10). Render pages: PDF → PNG per page at 150 dpi (max 2,000 px long edge) via `pdf-to-img`/Ghostscript; images → normalize orientation (EXIF), HEIC → JPEG; XLSX/CSV → one "page" per sheet with a text dump plus preserved cell grid JSON; DOCX → text + page images via LibreOffice headless; EML/MSG → body as page 1, attachments as child documents.
2. **classify** — Claude Haiku, vision on page 1 image + first 1,500 chars OCR text (from a quick Textract `DetectDocumentText` on page 1), tool-forced to the vertical's vocabulary with confidence and a one-line reason. If confidence < 0.85 → `needs_review` issue "Document type uncertain: warranty registration (0.62) or startup sheet (0.31)". Filename regex is a hint only.
3. **ocr** — Textract `AnalyzeDocument` (FORMS, TABLES) per page; store blocks with bbox and confidence; for pages where Textract mean word confidence < 80 or the classifier flagged `handwritten`, additionally run Claude vision transcription; keep both, prefer Textract for bbox and Claude for text when they disagree by > 20% edit distance. Store `ocr_text`, `ocr_blocks`. Born-digital PDFs with a text layer skip Textract (text + positions come from pdf.js).
4. **extract** — For the document's type, load `required_for_doc_types` + optional fields from the field registry. Claude Haiku, tool-forced, input = OCR text with block ids + page images for image-heavy types; output per field: `value_raw`, `page_no`, `block_ids[]` (server converts to bbox), `confidence`. Server rejects any field whose `block_ids` don't exist on that page (prevents hallucinated provenance). Normalize (§4.4). Status: `auto` if confidence ≥ 0.90 and normalization succeeded; `needs_review` if 0.70–0.89; dropped (< 0.70) with a "field not found" issue if the field is required.
5. **resolve** (entity resolution, §4.5) — produce candidate entities and links.
6. **dedupe** (§4.6) — near-duplicate check on field signature and page image hash; flag, don't auto-merge unless sha256-identical.
7. **conflicts** (§4.7).
8. **index** — update `entities.search` (tsvector over display fields), `entities.embedding` (Voyage or OpenAI text-embedding-3-small on a canonical sentence: "Carrier 59TP6 furnace, serial 4N2119-08772, installed 2019-03-14 at 3247 Elm St for T. Okafor"), refresh materialized views for affected entities, update batch stats.
9. **notify** — if the document produced `needs_review` issues, increment the tenant's review counter; if it fixed a gap or crossed a stage, no notification (reduce noise).

Failure handling: 5 retries with exponential backoff per step; permanent failure → `failure_reason`, document lands in Review queue under "Couldn't process" with a human-readable reason ("Page 3 is blank", "File is password-protected"); a staff dashboard lists failures across tenants. Reprocessing: any document can be re-run from any step with a new `extractor_version`; old extractions become `superseded`, never deleted.

### 4.4 Normalization rules (field registry `value_type`)
- **date**: parse US formats, handwritten variants ("3/14/19", "Mar 14 '19"), two-digit years → 2000s if ≤ current year+1 else 1900s; store ISO; ambiguous day/month → `needs_review`.
- **serial / model**: uppercase; strip spaces, hyphens are kept but a hyphenless twin is indexed; O↔0, I↔1, S↔5, B↔8 confusion classes generate alternates for matching (stored in `alternates` jsonb on the extraction).
- **address**: libpostal-style normalization (street suffix expansion, unit numbers, zip); geocode (Google/Mapbox) to lat/lng for fuzzy matching within 30 m; store components.
- **person**: "Last, First" ↔ "First Last"; initials; nickname table (Bob/Robert).
- **money**: strip `$`,`,`; negative in parentheses; store numeric(12,2).

### 4.5 Entity resolution (link or park)

For each extracted key field, find candidate entities in the tenant:

| Signal | Match rule | Score |
|---|---|---|
| Serial exact (after normalization / alternates) | equality | 1.00 |
| Serial fuzzy | Damerau-Levenshtein ≤ 1 on ≥ 8 chars | 0.85 |
| Model + property address | both match | 0.90 |
| Address normalized | components equal, or geocode ≤ 30 m and house number equal | 0.80 |
| Customer name fuzzy + address partial | trigram similarity ≥ 0.6 and street name equal | 0.70 |
| Technician name | trigram ≥ 0.8 against technicians | 0.80 (for relation only) |
| Date proximity (for events) | same property, event within ±1 day of an existing event | +0.05 |

Combine per candidate: `score = max(signals) + 0.05 * (count(signals) - 1)`, capped 1.0.
- `score ≥ 0.80` → `links.status='linked'`, method recorded. If exactly one strong candidate, create relations (equipment→property etc.).
- `0.50 ≤ score < 0.80` → `unlinked` with `best_guess_entity` and `reason` ("Serial matches 4N2119-08772 except one character; address differs").
- No candidate but the document has enough key fields (e.g., serial + model + address) → **create a new entity** with `provisional=true` and link with `method='new_entity'`; shows in review as "New equipment found — confirm". Provisional entities are answerable only with include-unverified until confirmed.
- No key fields → `unlinked`, reason "No serial, address or customer found on this document".

Unlinked inbox target: zero. The Records page shows the count; the dashboard shows it; onboarding staff must clear it before go-live. Human link (`method='human'`) always wins and is recorded in `audit_log`.

### 4.6 Dedupe
- **Exact**: `(tenant_id, sha256)` unique → hard duplicate, auto-merged (second upload records `duplicate_of`, no new pages processed). ING-10 MUST.
- **Near**: field signature = hash of (type_id, sorted key field norms); pages compared by perceptual hash (dHash, Hamming ≤ 6). Score ≥ 0.9 → `duplicates` row `status='suggested'`, shown in Review "Possible duplicates" with side-by-side; a person merges or keeps both. Photo-of-a-PDF is caught by field signature (same serial+date+total), not by image hash.
- Merge keeps the higher-quality original (more pages, higher OCR confidence) and re-points links/extractions from the loser; loser is `superseded`, never deleted.

### 4.7 Conflict detection
After resolve, for each `(entity_id, field_key)` with more than one `current`-eligible extraction whose `value_norm` differ (after alternates), create a `conflict` with all candidates. Rules: money/dates/serials → any difference is a conflict; text fields → conflict only if trigram similarity < 0.7. Resolution UI shows each candidate with its page image crop (from bbox). Resolution writes `entity_facts` (status current) with `extraction_id` = the chosen one, marks the others `disputed`, records `resolved_by/at/note`, and re-runs Ask eval questions that reference the entity (fast feedback).

### 4.8 Review queue (customer-facing; designed for an office manager)
Sections, in priority order: **Couldn't process** · **Document type uncertain** · **Missing required fields** · **Unlinked** · **Possible duplicates** · **Conflicts** · **New equipment found**. Each item: one action, one screen, page image with the relevant bbox zoomed, keyboard `J/K` next/prev, `Enter` accept best guess, `E` edit. Bulk actions for same-type items. Every action → `audit_log`. Target: an office manager clears 100 items in ≤ 20 minutes (measured in onboarding).

### 4.9 Cost budget per document (guide for pricing)
Textract ~$0.065/page (forms+tables) · Haiku classify+extract ~$0.004/page · Sonnet answer ~$0.02/question · storage ~$0.02/GB-month. A 2,000-page backfill ≈ $140 one-time; steady state Team tenant (1,500 pages/month, 3,000 questions/month) ≈ $160/month COGS.

---

## 5. Answer service (Ask)

- **ASK-01 MUST** Endpoint `POST /api/ask {question, include_unverified, context?: {entity_id?}}` streams SSE: `status` events (`reading`, `linking`, `writing`) then `answer` chunks then a final `done` with the full Answer object. Client renders the thinking ticker from real events, not timers.
- **ASK-02 MUST** Retrieval before generation. Steps: (1) entity mention detection — regex for serials, addresses (libpostal parse), names against tenant index; (2) hybrid search — BM25 over `entities.search` + `document_pages.tsv`, and vector top-20 on `entities.embedding`; reciprocal rank fusion; (3) expand top-8 entities to their `entity_facts` (current, verified unless toggle) + relations one hop + last 10 events; (4) cap context at ~6k tokens. **Never send the whole graph.**
- **ASK-03 MUST** Generation: Claude Sonnet, tool-forced `answer` schema (`answerable, answer_text, facts[{label, value, fact_id}], sources[{extraction_id, where}], confidence`). Facts may only reference `fact_id`s supplied in context; server drops anything else. `max_tokens ≤ 600`. Timeout 8 s; on timeout return a no-answer with closest documents and log.
- **ASK-04 MUST** Prose validator: split `answer_text` into sentences; each sentence must share ≥ 1 normalized value (date, serial, money, name, address token) with a cited fact, or be a hedge/no-answer sentence from an allow-list. Failing sentences are removed; if nothing remains → no-answer path. Log validator strikes for prompt tuning.
- **ASK-05 MUST** No-answer path returns `closest: [documents]` from the same retrieval (top-5 by fused score) with why ("mentions 12 Main St, no boiler on file").
- **ASK-06 MUST** Answer object includes `verified_count`, `unverified_held_back`, `latency_ms`, `retrieval_ids` (for audit).
- **ASK-07 MUST** Latency budget p95 ≤ 3.0 s end-to-end at 50k entities/tenant: retrieval ≤ 300 ms (indexes above), Claude TTFT ≤ 900 ms, full ≤ 2.5 s with streaming perceived < 1 s. Measured and stored per question; shown on the Records page as "Answer time p95 (7 days)".
- **ASK-08 MUST** Caching: identical question (normalized) within 10 minutes and no graph change for the touched entities → cached answer, flagged `cached: true`.
- **ASK-09 MUST** Question log with thumbs up/down and "wrong — the right answer is…" free text; feedback creates an eval question draft.
- **ASK-10 MUST** Rate limits: 60 questions/min/tenant, 10/min/user; 429 with retry-after.
- **ASK-11 MUST** Evaluation: each tenant has an active eval set (50 questions from onboarding, §9). `eval_runs` nightly against the production provider and on every deploy against the sample tenant; go-live requires ≥ 95%; regression alert if a tenant drops > 5 points. Results visible on the Records page with per-question pass/fail and the diff.
- **ASK-12 SHOULD** Follow-up questions keep the previous answer's entities as context ("and when was it last serviced?").
- **ASK-13 MUST** Bare entity questions (address/serial/name) return the "story" card: identity facts, warranty windows, agreements, last 5 events, all documents.

---

## 6. Field mode and accessibility

### 6.1 Standards
- **A11Y-01 MUST** WCAG 2.2 AA across the app; AAA contrast (7:1) for body text in field mode. Automated axe checks in CI with zero serious/critical; manual screen-reader pass (VoiceOver iOS, TalkBack, NVDA) per release on the Ask, Review, Entity, Records screens.
- **A11Y-02 MUST** Every interactive element has a visible focus ring (2 px brass, 3 px offset), accessible name, and role; modals trap focus and restore it; `Esc` closes; live regions announce answer arrival ("Answer ready, 4 sources") and pipeline progress.
- **A11Y-03 MUST** `prefers-reduced-motion` disables all non-essential motion; no animation > 240 ms; nothing flashes > 3 Hz ever.
- **A11Y-04 MUST** Page zoom 200% with no horizontal scroll; text-only zoom respected; all sizes in rem.

### 6.2 Field mode (the phone in the attic)
- **FLD-01 MUST** Toggle in the app bar; auto-on when installed as PWA on a phone; remembered per device; can be locked on by the office for tech accounts.
- **FLD-02 MUST** Type: body ≥ 18 px, labels ≥ 16 px, monospace data ≥ 16 px, headings ≥ 24 px; line-height ≥ 1.5. No text below 16 px anywhere in field mode (lint rule on Tailwind classes under `.field`).
- **FLD-03 MUST** Targets: ≥ 48 × 48 px for all controls, ≥ 56 px for primary actions and the Ask input; ≥ 8 px between targets; the bottom 35% of the screen holds the primary actions (thumb zone); no hover-only affordances.
- **FLD-04 MUST** Contrast: dark theme ground `#0B1613`, text `#F2F6F3` (≥ 15:1); status pills use icon + text, never color alone; an optional **glare mode** (pure white ground, near-black text, thicker borders) for direct sun.
- **FLD-05 MUST** One column at ≤ 640 px; tables become stacked cards; source lists show 3 then "show all".
- **FLD-06 MUST** Offline: PWA with service worker; caches the app shell, the last 200 answers, the entities they touched (facts + thumbnails), and the tech's assigned properties for the day; a persistent "Offline — showing saved records" banner; questions asked offline are answered from cached facts only (marked "from saved records") or queued.
- **FLD-07 MUST** Queued uploads: photos taken offline are stored in IndexedDB (≤ 200 MB) and uploaded when back online with a visible queue; retries; never lost on app close.
- **FLD-08 MUST** Network indicator and last-sync time always visible in field mode.
- **FLD-09 SHOULD** Battery: no continuous animation in field mode; canvas rings stop; polling replaced by SSE with backoff.

### 6.3 Camera capture (serial from photo)
- **CAM-01 MUST** `<input type="file" accept="image/*" capture="environment">` (native camera) with a live preview, retake, and crop guide ("fit the nameplate in the box"); client downsizes to ≤ 2,000 px long edge JPEG q85 before upload.
- **CAM-02 MUST** Upload as a document of type `nameplate-photo` on the fast lane; the response (≤ 5 s p95) returns the serial/model extraction with confidence and the bbox crop; the tech confirms or edits the serial with a large monospace field before it is used to ask.
- **CAM-03 MUST** If confidence < 0.8, show the crop and ask the tech to type it; never auto-ask from a low-confidence read.
- **CAM-04 SHOULD** Multi-shot: nameplate + unit overview + filter label in one capture flow, attached to the same event.

### 6.4 Voice (roadmap) — **MAY** dictation into the Ask box via the OS keyboard is sufficient for v1; no custom speech.

---

## 7. Dashboards (definitions, not just screens)

All dashboards read materialized views, refresh ≤ 15 min after pipeline changes, show "as of" time, and every row deep-links to Ask with the question pre-filled. Every dashboard has CSV export (§8.1).

| Dashboard | Definition / formula | Requirement |
|---|---|---|
| **Warranty** | For each equipment entity: parts and labor expiry from `entity_facts` (verified). Windows: expired, ≤ 30 d, ≤ 90 d, ≤ 365 d, ok. Sort next-to-expire first. Filters: manufacturer, branch, on-agreement. Tile counts per window. | DASH-01 MUST |
| **Equipment at risk** | Score = weighted: warranty expiring ≤ 90 d (3), no service event in > 18 months (2), ≥ 2 callbacks in 12 months (3), open conflict or gap on the unit (1), age > 15 y (1). Show top 25 with the named reasons. | DASH-02 SHOULD |
| **Callbacks** | A callback = a second service event on the **same equipment** within **30 days** of a prior event, not tagged maintenance/PM, by any tech. Per technician: callbacks / jobs in trailing 90 d and 12 m; show only techs with ≥ 10 jobs (small-sample guard); drill to the pairs of events with both work orders. Tenants can change the window (14/30/45 d). | DASH-03 SHOULD |
| **Maintenance agreements** | `hvac_agreements` entity from agreement documents and integration records: customer, properties, term, renewal date, visits included/used (events tagged PM within term). Views: renewals due ≤ 60 d, visits owed this season, expired-but-still-serviced (upsell). | DASH-04 SHOULD |
| **Records health** | Documents by stage, batches in progress with ETA (from throughput), unlinked / gaps / conflicts / duplicates / failed counts, per-property completeness, accuracy % (latest eval run), answer-time p95, review throughput (items cleared / week). | DASH-05 MUST |
| **Activity** | Questions per day, top askers, most-asked entities, no-answer rate (target < 10%), feedback. | DASH-06 SHOULD |
| **Alerts** | Rules engine (`alert_rules`): warranty expiring (90/30 d), agreement renewal (60 d), review queue > N items for > 3 days, pipeline failures, accuracy drop. Channels: in-app, email digest (daily/weekly), SMS (Team). | DASH-07 SHOULD |

---

## 8. Exports and integrations

### 8.1 CSV
- **EXP-01 MUST** Every table/dashboard and every list-type answer ("which units expire…") exports CSV: RFC 4180, UTF-8 with BOM, ISO dates, plain numbers, a `source_document` column with a signed URL per row, and a header comment row `# DeepWell export, tenant, as of`. ≤ 10k rows synchronous; larger via export job with email link (expires 7 days).

### 8.2 Warranty claim packet
- **EXP-02 MUST** Per equipment: cover page (customer, site, unit, serial, model, install date, claim reason), the verified facts with citations, and the **original pages** (not thumbnails) for each cited document, bookmarked; manufacturer-specific templates (Carrier, Trane, Lennox, Rheem) as a MAY. Generated server-side (Puppeteer/pdf-lib), not html2canvas. Blocked with a clear list if any required fact is unverified.

### 8.3 Accountant / dispatch exports
- **EXP-03 SHOULD** Invoice and cost lines CSV in QuickBooks Online import format; job list CSV in Jobber/ServiceTitan import formats.

### 8.4 Full export ("take it all with you")
- **EXP-04 MUST** Self-service zip: all originals in their batch folders, `documents.jsonl`, `extractions.jsonl`, `entities.jsonl`, `facts.jsonl`, `links.jsonl`, plus CSVs of every HVAC view and a README describing the schema. Generated as a job; link expires 7 days; audit-logged.

### 8.5 Integrations
- **INT-01 SHOULD (Team, one included)** Jobber (OAuth, GraphQL) or ServiceTitan (OAuth, REST) read sync: customers, properties, jobs, equipment → `integration_record` documents that flow through resolve/conflict like any other source, so DeepWell becomes the reconciliation layer between the FSM and the paper. Sync every 15 min with cursor; conflicts surface in the same queue.
- **INT-02 MAY** Write-back: push verified serial/model/warranty to the FSM equipment record; push "callback" tags.
- **INT-03 SHOULD** Google Drive folder sync (ingest) — see §4.1.
- **INT-04 MAY** Webhooks: `document.verified`, `conflict.opened`, `warranty.expiring`; signed with HMAC.
- **INT-05 MAY (Enterprise)** Public REST API v1 (OpenAPI spec): documents, entities, facts, ask; API keys with scopes; 600 req/min.

---

## 9. Accounts, onboarding, white-glove

- **ACC-01 MUST** Roles: `owner` (billing, members, export, delete), `office` (intake, review, dashboards, ask), `tech` (ask, capture, own events; field mode default), `readonly` (ask, dashboards), `staff` (DeepWell, consented, time-boxed).
- **ACC-02 MUST** Invite by email; magic link; Google sign-in; MFA optional (required for owner on Enterprise).
- **ACC-03 MUST** Onboarding flow (self-serve + staff): create tenant → choose vertical → name the first batch ("one box of records") → upload → while processing, the office manager records the **50 questions** they ask most (guided: 10 warranty, 10 history, 10 who/when, 10 cost, 10 free) → staff link/verify with the customer → eval run → **go-live checklist**: unlinked = 0, gaps ≤ 5, conflicts = 0, accuracy ≥ 95%, at least 3 users invited, field mode tested on one phone. Go-live button is disabled until the checklist passes; staff can override with a recorded reason.
- **ACC-04 MUST** Staff console (internal): tenant list with health, review-queue takeover, pipeline failures across tenants, reprocess, eval runner, consent log, spend per tenant.
- **ACC-05 MUST** Demo tenant: a seeded "Sample company" that any visitor can open from the site ("Open the demo"), read-only, resets nightly, banner always visible.
- **ACC-06 SHOULD** Billing via Stripe: plans, seats, page overages; usage meter on Records page.

---

## 10. Security and compliance

- **SEC-01 MUST** TLS everywhere; HSTS; CSP on the app; signed, short-lived (15 min) URLs for originals; no public buckets.
- **SEC-02 MUST** RLS on every tenant table; API sets `app.tenant_id` from the verified JWT per request; integration tests that attempt cross-tenant reads must fail.
- **SEC-03 MUST** Encryption at rest (DB, storage, backups); secrets in Vercel/Inngest env; key rotation runbook.
- **SEC-04 MUST** Audit log for every mutation and every staff access; exportable by the owner.
- **SEC-05 MUST** PII minimization in LLM calls: only the fields needed; no tenant data used for training (contractual with vendor, zero-retention endpoints where available); vendor DPA on file.
- **SEC-06 MUST** Retention: originals kept while the tenant is active; deleted tenants purged within 30 days; logs 90 days.
- **SEC-07 SHOULD** Dependency and container scanning in CI; Dependabot; annual pen test before Enterprise sales.
- **SEC-08 MAY** SOC 2 Type I readiness (policies, access reviews) in year 2; SSO/SAML for Enterprise.

---

## 11. Observability and SLOs

| SLO | Target | Alert |
|---|---|---|
| App availability | 99.9% monthly | `/api/health` fails 3× in 5 min |
| Ask p95 latency | ≤ 3 s | > 4 s for 15 min |
| Ask error rate | < 1% | > 2% for 10 min |
| Upload → searchable p95 (fast lane) | ≤ 2 min | > 5 min |
| Pipeline permanent failures | < 0.5% of documents | > 2% in a batch |
| Eval accuracy per tenant | ≥ 95% | drop > 5 points vs. prior run |
| Claude/Textract spend | within monthly budget | 80% of budget |

Instrumentation: OpenTelemetry traces from request → retrieval → Claude → validator; per-step pipeline durations in `jobs`; Sentry with tenant tag; a status page.

---

## 12. Performance targets (app)
- First load (app shell) ≤ 150 KB gzipped; route-level code splitting; Lighthouse ≥ 90 mobile.
- Entity page with 500 events renders ≤ 300 ms (virtualized lists).
- Document viewer opens page 1 ≤ 800 ms (page images pre-rendered; PDF.js for text layer lazily).
- Review queue keyboard navigation with no perceptible lag at 5,000 items (server-paged, 50 per page).

---

## 13. Testing and quality gates

- **QA-01 MUST** CI on every PR: `tsc --strict`, ESLint, unit tests (Vitest) for normalization, resolution scoring, conflict rules, validator; contract tests for `/api/*` against a Neon branch; Playwright: Ask flow keyboard-only, 390 px no horizontal scroll, field-mode type/target lint, axe zero serious.
- **QA-02 MUST** Golden ingestion set: 200 real-world HVAC documents (with owner consent, redacted) covering handwriting, faxes, phone photos, spreadsheets; CI asserts classification ≥ 95%, required-field recall ≥ 90%, link precision ≥ 97%; any regression blocks merge.
- **QA-03 MUST** Eval gate: sample tenant ≥ 95% on the production provider on every deploy.
- **QA-04 MUST** String lint: fail on `/\bAI\b|LLM|GPT|Claude|simulated|mock/i` in rendered strings under `src/`.
- **QA-05 SHOULD** Load test: 50 concurrent tenants, 10k-page backfill each, fast-lane p95 stays ≤ 2 min.
- **QA-06 MUST** Restore drill and tenant-deletion drill quarterly, documented.

---

## 14. Vertical adapter contract (so "built to go further" is true)

```ts
interface DomainAdapter {
  id: 'hvac' | 'plumbing' | 'electrical' | 'property' | 'fleet';
  entityTypes: EntityTypeDef[];            // registry rows
  documentTypes: DocumentTypeDef[];        // vocabulary + requiredFields + extraction prompt hints
  fieldRegistry: FieldDef[];               // keys, types, aliases, normalizers
  resolutionSignals: ResolutionSignal[];   // ordered matchers with weights (§4.5)
  conflictRules: ConflictRule[];           // per value_type
  questionPatterns: QuestionPattern[];     // entity mention detectors + intent hints for retrieval
  dashboards: DashboardDef[];              // SQL views + definitions (§7)
  storyCard: (entity) => StoryLayout;      // what a bare-entity answer shows
  onboardingQuestions: string[];           // the guided 50
  sample: SeedSpec;                        // demo tenant
}
```
Screens and services resolve the adapter from `tenants.vertical`; no screen imports a vertical directly (ING-13).

---

## 15. Build order (maps to `REQUIREMENTS_TRACEABILITY.md` milestones)

M0 polish → **M1 Ask (§5)** → **M2 Ingestion (§4) + viewer** → **M3 Accounts, persistence, onboarding (§3, §9, §10)** → **M4 Dashboards + exports + camera (§6.3, §7, §8)** → **M5 Integrations, offline, adapters, Enterprise (§4.1, §6.2 FLD-06/07, §8.5, §14)**.

First paying customer requires every **MUST** above. Team plan requires the **SHOULD**s. Enterprise requires the **MAY**s marked Enterprise.

---

## 16. Scaling plan — what changes as it grows

Design principle: **tenant is the unit of scale.** Every table, storage prefix, queue key, cache key and rate limit is keyed by `tenant_id`, so growth is horizontal by tenant and no single customer's load can degrade another's. The v1 stack (Vercel + Neon + R2 + Inngest) is chosen because each layer scales independently and can be replaced without touching the others.

### 16.1 Capacity stages

| Stage | Tenants | Docs stored | Pages/day | Questions/day | What must be true |
|---|---|---|---|---|---|
| **S1 Launch** | 1–25 | ≤ 500k | ≤ 20k | ≤ 5k | v1 stack as specified. Single Postgres (4 vCPU / 16 GB), one region (us-east). Inngest free/pro. |
| **S2 Traction** | 25–250 | ≤ 10M | ≤ 250k | ≤ 100k | Postgres 8–16 vCPU + **read replica** for dashboards/search; `document_pages` and `extractions` **partitioned by tenant_id hash (16 partitions)**; pgvector → HNSW indexes; materialized views refreshed per-tenant incrementally, not globally; Redis (Upstash) for answer cache, rate limits, session; CDN for page images. |
| **S3 Scale** | 250–2,500 | ≤ 100M | ≤ 2M | ≤ 1M | Pipeline workers move off serverless to a **container worker pool** (Fly.io / ECS) with Inngest still orchestrating (or SQS + workers); OCR fan-out per page; **dedicated Postgres per plan tier or shard group** (Enterprise tenants get their own database); search moves to a dedicated engine (Postgres FTS → Typesense/OpenSearch per shard, or Turbopuffer for vectors); Claude calls through a gateway with per-tenant budgets, prompt caching, and batch API for backfills. |
| **S4 Enterprise / multi-region** | 2,500+ | 100M+ | 10M+ | 5M+ | Region per data-residency need (US, CA); tenant-to-shard directory service; event bus (Kafka/Redpanda) between ingestion, indexing and analytics; warehouse (ClickHouse/BigQuery) for cross-tenant *anonymous* product metrics only (never records). |

Triggers to move a stage: Postgres CPU > 60% sustained, p95 Ask > 3 s for a week, fast-lane p95 > 2 min, or a single tenant > 5M pages.

### 16.2 Database
- **SCL-01 MUST** Every hot table has a composite index leading with `tenant_id`; no cross-tenant scans exist in application code (enforced by RLS + a query-log check in CI).
- **SCL-02 SHOULD (S2)** Declarative partitioning of `document_pages`, `extractions`, `questions`, `audit_log` by `tenant_id` hash; `audit_log` and `questions` additionally range-partitioned by month for cheap retention drops.
- **SCL-03 SHOULD (S2)** Read replica for dashboards, Records page, exports and eval runs; writes and Ask retrieval stay on primary (retrieval must see fresh facts).
- **SCL-04 SHOULD (S3)** Shard directory: `tenant_id → database_url`. Application uses one connection pool per shard; migrations run per shard via CI matrix. Enterprise tenants pinned to a dedicated shard (isolation + residency + custom backup windows).
- **SCL-05 MUST** Connection pooling from day one (PgBouncer / Neon pooler) because serverless functions open many short connections.
- **SCL-06 MUST** Large binary never in Postgres: originals, page images, OCR block dumps > 1 MB go to object storage with a pointer.

### 16.3 Storage
- **SCL-07 MUST** Lifecycle rules: page images to infrequent-access after 90 days; originals stay standard (they're the product); versions purged 30 days after soft delete.
- **SCL-08 SHOULD** Per-tenant prefix makes export, deletion and residency moves a prefix copy — no application changes.
- **SCL-09 SHOULD** CDN in front of page images with signed cookies per tenant session.

### 16.4 Pipeline and queues
- **SCL-10 MUST** Idempotency keys on every step (`document_id:step:extractor_version`) so retries, replays and region failovers never double-process or double-bill.
- **SCL-11 MUST** Per-tenant concurrency caps and two priority lanes (§4.2); global caps per external vendor (Textract TPS, Claude RPM) with a token-bucket so a burst queues rather than errors.
- **SCL-12 SHOULD (S2)** Page-level fan-out: a 300-page PDF becomes 300 OCR steps in parallel, then a join; throughput scales with worker count, not document size.
- **SCL-13 SHOULD (S3)** Backfills use the Claude **Batch API** (50% cost, hours latency) while fast lane uses real-time; the pipeline chooses by lane.
- **SCL-14 SHOULD (S3)** Workers pull from the queue on containers with autoscaling on queue depth; serverless remains for request/response only.
- **SCL-15 MUST** Dead-letter queue with reasons, and a replay tool in the staff console.

### 16.5 Answer service
- **SCL-16 MUST** Retrieval is bounded (top-K, token cap) so cost and latency are flat regardless of tenant size (§5).
- **SCL-17 SHOULD** Prompt caching for the system prompt and the per-tenant schema block; answer cache in Redis keyed `(tenant, normalized question, graph_version)` where `graph_version` bumps on any verified change to touched entities.
- **SCL-18 SHOULD (S3)** Model routing: Haiku for bare-entity "story" questions and list questions (deterministic assembly, no generation), Sonnet only for narrative questions; expected 60–70% of questions never hit Sonnet.
- **SCL-19 MUST** Per-tenant monthly LLM budget with soft (alert) and hard (degrade to no-generation story cards) limits; spend visible to staff.

### 16.6 Multi-tenancy, isolation and noisy neighbors
- **SCL-20 MUST** Rate limits per tenant and per user at the edge; per-tenant queue concurrency; per-tenant storage quotas by plan with overage metering.
- **SCL-21 SHOULD** Tenant "weight class": tenants above 1M pages get their own worker concurrency pool and, at S3, their own shard.
- **SCL-22 MUST** Every cache, index and view is tenant-scoped; there is no global cache of answers or entities.

### 16.7 Cost scaling (COGS per tenant must fall as we grow)
- Pages: Textract + Haiku ≈ $0.07/page at S1 → target $0.04 at S3 via batch API, Textract volume pricing, and skipping OCR for born-digital PDFs (text layer present → no Textract).
- Questions: ≈ $0.02 at S1 → target $0.006 via routing (§16.5) and caching.
- Storage: ≈ $0.02/GB-month, flat.
- Gross margin target: ≥ 80% on Team at S2.

### 16.8 Reliability at scale
- **SCL-23 MUST** Multi-AZ database with automated failover; RPO ≤ 5 min, RTO ≤ 30 min at S1; RPO ≤ 1 min / RTO ≤ 10 min at S3.
- **SCL-24 SHOULD (S4)** Warm standby in a second region for the database and storage replication; DNS failover; quarterly failover drill.
- **SCL-25 MUST** Graceful degradation order when a dependency is down: Claude down → Ask returns story cards + closest documents (no generation) with a banner; Textract down → pipeline queues, uploads still accepted; DB read replica down → dashboards read primary with a slower "as of".
- **SCL-26 MUST** Schema migrations are online (no table locks > 1 s), backward compatible for one release, run per shard.

### 16.9 Team and process scaling
- Trunk-based development, preview environment per PR with a seeded sample tenant, feature flags per tenant (LaunchDarkly or a `tenant_flags` table) so new pipeline steps roll out to 1 → 10 → 100 tenants.
- Runbooks: pipeline backlog, Claude outage, restore, tenant deletion, shard move, key rotation.
- On-call rotation once there are ≥ 10 paying tenants.

### 16.10 What NOT to build early
No Kubernetes, no microservices, no Kafka, no custom vector database, no multi-region before S4. The v1 stack handles S1–S2 with configuration changes only. Every item above has a trigger; build it when the trigger fires, not before.
