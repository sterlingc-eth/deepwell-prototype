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

(For the full system architecture, data model, ingestion-at-scale pipeline, answer service, field mode/accessibility, dashboards, exports/integrations, accounts/onboarding, security, observability, performance, testing gates, vertical adapter contract, build order, and 16-section scaling plan, see the complete original document previously written to the Claude Project on September 12, 2026. This export captures the section 1 non-negotiables verbatim as the load-bearing summary; the full ~16-section text runs several thousand lines and is preserved in the DeepWell Claude Project under this same path for reference.)
