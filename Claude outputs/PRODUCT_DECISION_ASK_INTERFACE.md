# Product Decision: "Ask" is the primary interface — and ingestion is a workflow
**Date:** September 12, 2026
**Decided by:** Sterling Chapman
**Status:** Binding for the next build cycle

## The decision

DeepWell's primary way of finding anything is a single plain-language question box that returns a **cited answer**, not a keyword/fuzzy search over fields.

Sterling, reviewing the website demo (Sept 12): *"The way you have the natural sample questions is how I would want the software to be able to be used to search for items."*

This replaces the current prototype's `OnSiteSearchScreen` model (fuzzy match on address / serial / technician / date, returning a list of result cards).

**Corollary (same day):** *"People should be able to ingest documentation in an orderly fashion. I don't want this to become some information dump and poor retrieval."* Retrieval quality is decided at intake. Ingestion is a pipeline with a visible "done" state, not a drop zone. See "Ingestion discipline" below.

## What the interaction is

One box. The user types the way they would ask a coworker:

- "Is the furnace at 3247 Elm still under warranty?"
- "What did Marcus do at the Henderson job last fall?"
- "Serial 4N2119-08772 — what is it and where is it?"
- "Which Carrier units we installed expire in the next 90 days?"

The response is always the same shape:

1. **Answer** — one to three sentences in plain English, directly answering the question.
2. **Linked facts** — a key/value grid of the records the answer is built from (equipment, serial, address, customer, dates, warranty status pills, amounts).
3. **Sources** — every document the facts came from, with the location on the page (e.g. "Work order #19-0412, page 2, serial field"), one tap to open the original.
4. **Honesty** — if the records don't support an answer, say so and show the closest documents. Never guess.

A bare address, serial, or name is still a valid "question" — it should resolve to that entity's full story (the third example above).

Answers draw only on **Linked + Verified** documents by default. The answer card says so ("From 6 verified records") and offers "include unverified" as an explicit toggle.

## Ingestion discipline

Every document moves through a visible pipeline and cannot "fall in":

**Received → Classified → Extracted → Linked → Verified**

Nothing is answerable until Linked; nothing counts toward accuracy until Verified.

- **Intake is deliberate.** Uploads go into a named batch ("Elm St 2019 cabinet", "March invoices") with a source (cabinet / email / drive / truck) and a date range. Batches, not loose files, are the unit of work.
- **Classify on arrival.** Every document gets a type from a fixed vocabulary: work order, invoice, warranty registration, startup sheet, permit, nameplate photo, maintenance agreement, other. Type decides which fields are required.
- **Required fields per type.** A work order isn't Extracted until it has address, date, and technician; a warranty registration needs serial, model, and expiry. Missing required fields block the pipeline and land in the review queue with the specific gap named.
- **Link or park.** A document must attach to at least one entity (property, equipment, customer, technician). Below the linking confidence threshold it goes to an **Unlinked inbox** the office is expected to empty; the count is on the dashboard. Zero unlinked is the target state.
- **Dedupe on intake.** The same document uploaded twice (or a photo of a PDF already in the system) is detected and merged, not double-counted.
- **Conflicts are resolved, not averaged.** If two documents disagree (serial on nameplate vs. serial on invoice), surface the conflict with both sources and make a person choose. Record who chose and when.
- **Record health is always visible.** A Records page shows documents by stage, batches in progress, unlinked count, required-field gaps, open conflicts, and per-entity completeness ("3247 Elm: equipment ✓ warranty ✓ service history 4 events, last verified Nov 2025").

## Company positioning (also confirmed Sept 12)

- DeepWell is a **SaaS platform**, not a consultancy. HVAC is the first vertical; plumbing/electrical, property management, and fleet/equipment are the planned expansion.
- White-glove setup by the DeepWell team is **included with every account** — a differentiator, not the business model.
- Public copy never says "AI." The language is "knowledge platform," "reads each document for the facts that matter," "every answer shows its source."
- Brand follows the new logo: forest green (#163C2C) + navy (#123D6B), heavy serif wordmark, tagline "Knowledge builds business." This supersedes the navy + copper palette in `docs/DESIGN_SYSTEM_SPEC.md` for public-facing work; a single brass accent (#B98A4E) is the only warm color.

## Implications for the prototype (next build)

- Replace `OnSiteSearchScreen` with an `AskScreen`: one input, answer card (answer / facts / sources), recent questions list. It is the home screen.
- `searchService.ts` becomes `answerService.ts`: question → entity resolution → linked-record assembly → answer text + sources. Mock deterministically first, then wire to the Claude API per `claude/AI_INTEGRATION_PLAN.md`. Every fact carries a source reference; no fact without a source.
- `DocumentIngestionScreen` becomes a batch-based intake with the five-stage pipeline; `ExtractionReviewScreen` becomes the review queue (required-field gaps, unlinked inbox, conflicts). Approved corrections feed the entity graph the answerService reads from.
- New `RecordsScreen` for record health. Dashboard rows deep-link to Ask with the question pre-filled.
- The answer card is the same component on desk and phone; field view is the same data with larger type.
- Seed the mock with 3 batches in different stages, ~5 unlinked docs, 2 conflicts, and a handful of required-field gaps so the workflow is visible on first load.
- Evaluation: a 50-question set (`docs/EVAL_QUESTIONS.md`) from the mock data is the acceptance test. Publish accuracy to the customer; below 95%, keep working before go-live.

## Reference

- Website (live artifact, Sept 12): hero, Platform (Ingest / Link / Ask), interactive Ask demo with typed input, Where it works, Plans, Rules we don't bend.
- Demo data used on the site lives in the page's `DEMO` array and can seed the prototype's mock `answerService`.
- Full build prompt for the next session was given to Sterling in chat on Sept 12 (sections A–E + quality bar + process).
