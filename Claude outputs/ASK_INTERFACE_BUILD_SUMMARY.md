# Ask Interface Build — Summary
**Date:** September 12, 2026
**Implements:** `claude/PRODUCT_DECISION_ASK_INTERFACE.md` (binding decision) on top of the ingestion → review → linking flow from `claude/DEEPWELL_PRODUCT_REDESIGN_V2.md`
**Branch state:** 8 commits on `main`, delivered to Sterling's local repo for push. Build passes strict TypeScript; eval 50/50; browser e2e green.

## What changed

**Ask is the home screen.** One input ("Ask anything — an address, a serial, a name, a question…"). Every answer renders in the same order: Answer (1–3 sentences) → Linked facts (key/value grid, status pills for warranty) → Sources (document type, stage, filename, page/field). When the records don't support an answer it says so and shows the closest documents. "From N verified records" is always visible; "include unverified" is an explicit toggle and the card says how many unverified documents were held back. Suggested questions on first load, recent questions below. Serial-from-photo in field mode (capture mocked, input real).

**Ingestion is a workflow.** Intake creates named batches with a source and date range; documents move Received → Classified → Extracted → Linked → Verified and the counts are on the screen. Required fields per document type block advancement at Classified with the specific gap named. Documents that won't link land in an Unlinked inbox with a best-guess record pre-selected. Two documents that disagree produce a conflict a person resolves (who and when recorded). Duplicates are detected on intake and merged, never double-counted. Approve advances exactly as far as the issues allow; Verified stamps name and time.

**One graph.** `src/core/entityGraph.ts` is what Ask reads and what Review writes. A correction approved in review changes the next answer — proven in the browser: resolving the EQ003 serial conflict turns "SN-CAR-567898" from an honest no-answer into the unit's full story.

**Records page** shows health: documents by stage, unlinked/gaps/conflicts/duplicates, batches in progress, completeness per property ("2 units · 2/2 warranty on file · 4 events · last verified Sep 4"), and a live accuracy score — the 50-question eval runs in the browser against the current graph.

**Dashboard** is now real data (the old one showed hardcoded serials that didn't exist). Warranty expiry next-to-expire first; equipment at risk with named reasons; every row deep-links to Ask with the question pre-filled; "Prepare claim packet" builds a printable PDF listing the verified documents behind each fact.

**Entity pages** replace the hardcoded EquipmentDetail / TechnicianProfile mocks with one data-driven page for any record. **Browse** is the demoted list view with "Ask this instead".

**Brand.** Forest green #163C2C, navy #123D6B, brass #B98A4E, green-biased neutrals. Newsreader display + IBM Plex Sans/Mono. Office (light) and Field (dark, high-contrast, 18px+ body, 48px targets) share one token vocabulary; field mode is remembered per device. Verified 0 px horizontal overflow on every screen at 390 px. The UI never says "AI".

**Layer strategy.** `src/core` is domain-neutral (entities, documents, facts, sources, pipeline, Answer shape). `src/domains/hvac` is the adapter (entity types, document vocabulary, required fields, question understanding, intake rules). `AnswerCard` depends only on an `Answer` object and three callbacks, so it can be embedded in another application unchanged. Adding plumbing or fleet later is a new adapter folder, not a core change.

## What's mocked

| Mocked | Where | Real replacement |
|---|---|---|
| Answering | `src/domains/hvac/answer.ts` via `answerService.mock.ts` — deterministic question understanding over the entity graph | `answerService.claude.ts` → `api/ask.js` (already written; set `VITE_ANSWER_PROVIDER=claude`). Same `Answer` shape; server enforces sourcing. |
| Documents | `src/domains/hvac/seed.ts` — 52 documents in 3 batches with page/field locations, generated from the 15 units / 10 properties / 25 visits | Real uploads → `/api/extract` (exists) producing `ExtractedField[]` with targets |
| Classification | `classifyByFilename()` in `domains/hvac/intake.ts` | Claude classification on upload |
| Linking confidence | Seeded per document; new uploads link manually in review | Entity resolution service (serial exact → address fuzzy → name) |
| Serial from photo | `SerialCapture` picks a serial from records after a 600 ms "read" | Camera → `/api/extract` with `documentType: nameplate` |
| Persistence | Zustand in memory; reload resets to seed | Postgres for graph + provenance; object storage for originals |
| Users | "You" / "Dana R. (office)" | Auth; verifiedBy/resolvedBy become real identities |

The mock has **3 technicians**, not 12 as the brief said — the data only has service history for three, and padding to twelve would have meant technicians with no work to cite. Easy to extend in `src/mocks/data.ts` if wanted.

## Numbers

- Eval: 50/50 (`npm run eval`; `docs/EVAL_QUESTIONS.md` generated from `src/eval/questions.ts`).
- Bundle: ~94 KB gzipped first load (was 346 KB). The claim-packet export lazy-loads jspdf/html2canvas (~240 KB) only when opened. Total across all chunks ~332 KB, under the previous 359 KB.
- TypeScript: `strict` + `noUncheckedIndexedAccess`; zero `ts-nocheck` / `@ts-ignore` / `any` in `src/` (there were 13 `ts-nocheck` files before).
- Motion ≤ 240 ms, `prefers-reduced-motion` respected; framer-motion removed.

## What's next for real integration

1. **Turn on the Claude provider** for a side-by-side: `VITE_ANSWER_PROVIDER=claude` with `vercel dev`. Run the same 50 questions through `/api/ask` and publish both numbers. The mock stays as the fallback and the regression harness.
2. **Real extraction on upload.** Intake's "Add files" currently records filenames only. Wire the file bytes to `/api/extract`, map its fields to `ExtractedField[]` with `target`s using `HVAC_FIELD_ALIASES`, and let the existing review queue do the rest.
3. **Entity resolution for linking.** Replace seeded `linkConfidence` with a resolver (serial exact match → normalized address → customer name), thresholded at 0.8 to Linked, below that to the Unlinked inbox with the best guess.
4. **Persistence.** The graph's mutation set is small (`correctField`, `classifyDoc`, `linkDoc`, `approveDoc`, `resolveConflict`, `mergeDuplicate`, `createBatch`, `receiveDocs`) — each becomes an API call; the provenance model already carries what the audit trail needs.
5. **Embedding.** Export `AnswerCard` + `answerService` as a package with a `GraphSnapshot` adapter interface, so a host app can supply records and get cited answers in its own UI.

## How to test in the Vercel preview

Open the preview and walk this in order — each step depends on the previous.

1. **Ask, cited.** Home screen. Click "Is the furnace at 2847 N 24th St still under warranty?" Expect: "Yes — … until Nov 22, 2029", an Active pill, 3 sources. Click source **[1]** → the warranty registration opens with "Warranty expires" highlighted. **Esc** closes it and focus returns.
2. **Honest empty.** Ask "Is the boiler at 12 Main St under warranty?" Expect "Nothing in your records answers that" and closest documents, no invented facts.
3. **Verified vs unverified.** Ask "When were we last at 4321 S Price Rd?" Expect Apr 15, 2025 and "1 unverified held back". Tick **Include unverified** → answer changes to Jun 10, 2026.
4. **A correction changes the answer.** Ask "SN-CAR-567898" → no-answer. Go **Intake → Review queue → Conflicts**, open `IMG_4402_nameplate.jpg`, pick **SN-CAR-567898**. Back to Ask, ask it again → Carrier AC at 1523 S Alma School Rd.
5. **Fill a gap and verify.** Review queue → **Missing fields** → `IMG_4451_workorder.jpg`. Type "Maria Santos" in Technician, **Add**, link to 5600 W Camelback Rd, **Mark verified**. Records page → gaps count drops.
6. **Records health.** Check the five health tiles, the stage bar, and "Answer accuracy 100% · 50/50".
7. **Dashboard deep-links.** Click any warranty row → Ask opens with the question filled and answered.
8. **Field mode at phone width.** Toggle the moon icon; resize to ~390 px. One column, large type, no horizontal scroll. Tap the camera icon, capture, "Ask about this serial".
9. **Keyboard only.** Tab to the input, type, Enter, Tab to a source, Enter, Esc. Nothing should require a mouse.
10. **Claim packet.** Dashboard → "Prepare claim packet" → Download PDF.

Reload resets everything to the seed (in-memory state) — that's expected for the prototype.
