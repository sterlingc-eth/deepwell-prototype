# DeepWell

Ask a question. Get an answer with the documents it came from.

DeepWell is a knowledge platform for trades businesses — HVAC first. It reads each document for the facts that matter, links them to the property, unit, customer and technician they belong to, and answers plain-language questions with sources. Every answer shows its source. Nothing is answerable until it's linked; nothing counts until a person has verified it.

This repository is the working prototype: a standalone app with an embeddable core, so the same answer engine and `AnswerCard` can sit inside other applications later.

## Run it

```bash
npm install
npm run dev          # Vite on http://localhost:5173 (mock answers, no API key needed)
npm run build        # strict TypeScript + production bundle
npm run eval         # 50-question evaluation set against the mock answer service
npm run eval -- --doc  # …and regenerate docs/EVAL_QUESTIONS.md
```

Backend functions (`api/`) run under `vercel dev` and need `CLAUDE_API_KEY` in `.env.local` (see `.env.local.example`). The frontend uses the deterministic mock answer service by default; set `VITE_ANSWER_PROVIDER=claude` to route questions through `/api/ask`.

## What's in the box

| Screen | What it does |
|---|---|
| **Ask** (home) | One input. Answer → Linked facts → Sources, or an honest "Nothing in your records answers that" with the closest documents. Verified-only by default; "include unverified" is an explicit toggle. Recent and suggested questions. Serial-from-photo in field mode. |
| **Record** (entity page) | Any property, unit, technician, customer or visit: fields with the documents behind them, related records, linked documents, "Ask about this". |
| **Records** | Health: documents by stage, unlinked inbox, required-field gaps, open conflicts, batches in progress, completeness per property, live accuracy on the eval set. |
| **Intake** | Batches (name, source, date range) and the five-stage pipeline: Received → Classified → Extracted → Linked → Verified. |
| **Review queue** | What the pipeline can't decide: missing required fields, unlinked documents, conflicts between documents, duplicates. Approvals write to the entity graph, so the next answer changes. |
| **Dashboard** | Warranty expiry (next to expire first) and equipment at risk. Every row deep-links to Ask with the question pre-filled. Prepare a claim packet. |
| **Browse** | The demoted list view, for when you'd rather scan than ask. |

**Field mode** (moon/sun switch in the header) is the same UI in one column with high contrast, 18px+ body text and 48px targets. It works at 390px wide and is remembered per device.

## How it's built

```
src/
  core/            Domain-neutral: types, entity graph (Zustand), answer helpers
  domains/hvac/    The HVAC adapter: schema, seed data, question understanding, intake rules
  services/        answerService (the seam) + mock and Claude providers
  components/      AnswerCard, FactGrid, SourceList, DocumentPreview, AppShell, pills
  screens/         Ask, Entity, Records, Intake, Review, Dashboard, Browse, WarrantyExport
  eval/            The 50-question acceptance set
api/               Vercel functions: ask, search, extract (+ _lib/claude)
scripts/           eval.ts, e2e.mjs (Playwright), screenshot.mjs
```

Three rules the code enforces:

1. **No fact without a source.** `Fact.sources` is required; facts with an empty list are dropped before an answer renders. On the Claude path the server also drops any citation that isn't in the exported records.
2. **Answerability is a pipeline stage.** `isAnswerable(doc, includeUnverified)` is the single check: Verified by default, Linked-or-better with the toggle, never duplicates.
3. **One graph.** `core/entityGraph` is what Ask reads and what Review writes. Corrections, links, conflict resolutions and approvals land on entity fields with their provenance intact.

The UI never uses the word "AI". The language is "your records", "sources", "linked", "verified".

## Swapping the mock for real answers

`services/answerService.ts` picks a provider once. Both implement `AnswerProvider.ask(question, opts) => Promise<Answer>`:

- `answerService.mock.ts` → `domains/hvac/answer.ts`, deterministic, passes the eval at 50/50.
- `answerService.claude.ts` → exports the answerable records (with sources) and POSTs to `api/ask.js`, which forces the same `Answer` shape via tool use.

The screens don't know which one answered. See `claude/ASK_INTERFACE_BUILD_SUMMARY.md` in the DeepWell project for what's mocked and what's next.

## Quality bar

- TypeScript strict (`noUncheckedIndexedAccess`, no `ts-nocheck`, no `any`). `npm run build` is the gate.
- Bundle: ~94 KB gzipped on first load (main + CSS). The claim-packet export lazy-loads jspdf/html2canvas (~240 KB) only when opened.
- Motion: purposeful, ≤ 240 ms, `prefers-reduced-motion` respected globally.
- Keyboard: the whole Ask flow works with Tab / Enter / Escape; focus is visible everywhere; dialogs restore focus on close.
- `node scripts/e2e.mjs` (after a build) walks the promises above in a real browser.
