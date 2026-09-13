# DeepWell — Storage & Retrieval Model (v2: open schema with governance)

**Why this document exists.** Poor retrieval is almost always a storage problem. If documents go in as blobs of text and come out via "find similar text," answers drift, sources get vague, and nothing composes. DeepWell stores **facts about things**, not documents as text. Documents are evidence; the unit of storage and retrieval is the *entity fact with provenance*.

**v2 change (Sterling, Sept 12):** the schema is **open, not closed**. The pipeline reads *everything* on a document, maps what it can to the known model, and turns what it can't into *proposals* that grow the model over time — while nothing unmapped is ever lost or made invisible to retrieval. Governance (confidence, promotion rules, human confirmation) is what keeps an open schema from degrading into noise.

## 1. Four layers, each with one job

```
Layer 4  ANSWER      Ask → resolve entities → gather facts + facets → compute → phrase → validate
Layer 3  KNOWLEDGE   entities · relations · entity_facts (current value per field, with provenance)
Layer 2  EVIDENCE    documents · pages · segments · facets · extractions (raw, page, bbox, confidence, status)
Layer 1  ORIGINALS   the bytes (sha256-addressed), never modified, never deleted
```

A question is answered from Layer 3 (plus Layer 2 facets when the question needs them), proven by Layer 2, traceable to Layer 1.

## 2. Reading a document: the universal pass, then the mapping pass

**Pass 1 — Understand everything (schema-free).** For every page the model produces a complete structured reading, independent of what the registry knows: `segments` (header, party block, line-item table, terms, signature block, handwritten note, stamp, photo region — each with a bbox), `facets` (every label→value pair, table cell, checkbox, date, amount, identifier, name, address, free-text note, each with bbox and confidence), `mentions` (people, companies, places, equipment, identifiers), and `aspects` — a document can be several things at once (an invoice that is also a work order that also states warranty terms). Output: a *document reading* stored verbatim in Layer 2. Nothing is filtered at this stage.

**Pass 2 — Map to the model (schema-aware).** Each facet is matched to the registry: by field key, by known synonyms ("S/N", "Serial No.", "Ser#"), by value type + position context, and by learned mappings from previous confirmations in this tenant. Matched facets become `extractions` on entities exactly as before (provenance rule unchanged). Unmatched facets stay as **facets** — first-class, searchable, boxed, attached to the document and to any entity the document is linked to — and become **proposals** (below).

The vocabulary the classifier sees is therefore *the current registry*, and a document that fits none of it is classified into a **proposed type** ("Refrigerant recovery log?", confidence, reason) rather than forced into "unclassified".

## 3. The registry is layered and versioned

```
tier 0  core       vertical schema shipped by DeepWell (HVAC v1: types, entities, fields, relations)
tier 1  discovered promoted automatically from proposals (see §4); marked "discovered" in the UI
tier 2  confirmed  a person confirmed / renamed / merged a proposal; treated like core for that tenant
tier 3  shared     confirmed categories that recur across tenants graduate into the next vertical release
```

Every registry change is a versioned row (`schema_versions`): who/what added it, from which examples, when. Extractions record the `schema_version` they were produced under. Promotion triggers a targeted **re-map** (not re-OCR): facets already stored are re-run through Pass 2 against the new registry, so the model gets sharper on documents it has already seen. That is the "continue to isolate and build" loop.

## 4. Proposals: how new categories, fields and entity kinds appear

The pipeline continuously clusters unmapped things into `proposals` with `kind` ∈ {document_type, aspect, field, entity_type, relation, synonym, enum_value}, plus evidence: example facets (with boxes), count of documents, count of batches, distinct value-type signature, and a suggested name/normalizer.

Promotion rules (defaults, tunable per tenant):
- **Synonym** ("Ser#" → `serial`): auto-promote at 2 consistent occurrences; risk is low and reversible.
- **Field** on a known type: auto-promote to *discovered* when seen on ≥3 documents across ≥2 batches with a consistent value type (e.g., `refrigerant_charge_oz: number`); remains `needs_review` for answering until a person confirms or it accumulates ≥10 consistent observations.
- **Document type / aspect**: propose after ≥3 documents cluster together (same segment structure + facet signature); a person confirms with one click in Review ("New document type found: Refrigerant log — 4 documents"). Until confirmed, those documents are fully retrievable via facets; they just carry the proposed type.
- **Entity type** (e.g., `vehicle`, `thermostat`, `zone`): always human-confirmed, because it changes the graph shape. The proposal arrives with the relations it would need ("thermostat *controls* equipment") pre-drafted.
- **Enum values** (equipment types, service categories): auto-add as discovered; merge suggestions when two values look like spelling variants.

Every promotion, rename, merge and rejection is audit-logged and reversible (demoting a field turns its extractions back into facets; nothing is deleted). Rejected proposals are remembered so the same noise isn't proposed again.

## 5. What a fact — and a facet — carries

Extraction rows (mapped): `entity_id`, `field_key`, `value_raw`, `value_norm`, `document_id`, `page_no`, `bbox`, `confidence`, `status` (`auto` · `needs_review` · `verified` · `disputed` · `superseded`), `extractor_version`, `schema_version`, `mapping_method` (registry | synonym | learned | human), timestamps and actor for human actions.

Facet rows (unmapped or not-yet-mapped): `document_id`, `page_no`, `segment_id`, `label_raw`, `value_raw`, `value_type_guess`, `bbox`, `confidence`, `proposal_id?`, `linked_entity_ids[]` (inherited from the document's links). Facets are searchable and citable; an answer built on a facet is labeled "from an unconfirmed field" and counts as unverified for the toggle.

`entity_facts` holds the **current** value per (entity, field) pointing at the winning extraction; conflicts, disputes and supersession work as before. Human decisions always win.

## 6. Indexes, used in order

1. **Identifier index (exact).** Serials with confusable alternates, models, normalized addresses, names. Deterministic; no model involved.
2. **Structured index (typed).** Dates, money, enums, relations — over *both* registry fields and discovered fields with a resolved value type. Windows and totals are computed, not retrieved.
3. **Facet index (key/value + text).** Label→value pairs and free text from every document, including unmapped ones; lexical now, embeddings in M3, with one canonical sentence per entity and one per document reading. This is what makes "what did the tech write about the noise at Thunderbird" or "which docs mention R-410A" answerable before anyone defined a field for it.

Retrieval = resolve mentions (1) → expand one hop over relations → current facts (verified by default; linked+ and discovered with the toggle) → computations (2) → facet hits only when the question's terms aren't covered by facts (3) → cap context. The model phrases; it does not remember.

## 7. Quality gates in the store

- No fact or facet without document, page and a box that falls on that page.
- Below-threshold → `needs_review`; discovered-but-unconfirmed → unverified for Ask by default.
- Exact duplicate by bytes; near duplicate by field signature *or* facet signature; conflicts on any (entity, field) with two current-eligible values.
- Pipeline stage derived from the rows. Completeness per entity computed against required fields of its type *as currently defined*.
- **Schema health** on the Records page: proposals awaiting confirmation, discovered fields and their observation counts, mapping coverage (% of facets mapped), and the re-map backlog. Coverage rising over time is the visible sign the model is learning; a person can see exactly what it learned and undo any of it.

## 8. Tenancy

Every row — including proposals and registry rows above tier 0 — carries `tenant_id`. One tenant's discovered categories never leak into another's; tier 3 promotion is an explicit DeepWell release decision.

## 9. What this rules out on purpose

No free-form chunks as the retrieval unit. No answer from OCR text directly (facets are structured label/value/box rows, not raw text). No silently invented field keys — new keys enter via proposals with evidence and can always be traced to the documents that caused them. No auto-merge except identical bytes. No model call that sees the whole graph. No fact without a box on a page.
