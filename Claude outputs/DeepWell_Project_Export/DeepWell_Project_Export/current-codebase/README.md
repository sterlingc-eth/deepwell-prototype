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
npm run eval:claude  # the same 50 through the real /api/ask handler (spends money — see below)
```

Backend functions (`api/`) run under `vercel dev` and need `CLAUDE_API_KEY` in `.env.local` (see `.env.local.example`). The frontend uses the deterministic mock answer service by default; set `VITE_ANSWER_PROVIDER=claude` to route questions through `/api/ask`.

### The eval, mock and real

`src/eval/questions.ts` holds 50 questions a dispatcher, tech or owner would actually ask, with what a correct answer must contain. The clock is pinned to 2026-09-12 so relative dates are deterministic.

- **`npm run eval`** — the mock provider, scored exactly (every expected string verbatim). Must be 50/50; it runs in CI on every push.
- **`npm run eval:claude`** — the real answer path. The script imports `api/ask.js` and calls the handler in-process with the exact request body the browser sends, so retrieval, the model call, the prose validator and the guard all run for real. Prose varies, so it is scored on values (dates in any common form, `$1,850` ↔ `$1850`, names, addresses, counts) and must stay at or above 95% (48/50). The rules are spelled out in [`docs/EVAL_QUESTIONS.md`](docs/EVAL_QUESTIONS.md).
- **Cost guard.** `npx tsx scripts/eval.ts --provider claude` without `--confirm` prints the estimate (input chars ÷ 4 × $3/M + ~250 output tokens per call × $15/M — about $0.65 for the full set) and exits 2 without calling anything. `--only 1,4,7-9` runs a subset, `--verbose` shows every answer and the handler's log lines, `--json out.json` writes per-question results, `--doc` regenerates `docs/EVAL_QUESTIONS.md` after a full run. Questions run one at a time, 250 ms apart; the run sets `ASK_ENABLED=true` and a high per-IP limit for its own process only.
- In CI the real eval is a separate `eval-claude` job on `workflow_dispatch` and a nightly schedule; it skips with a notice when the `CLAUDE_API_KEY` secret is empty.

### Guard rails on `/api/ask`

Everything below runs before any model call (`api/_lib/guard.js`), and every limit returns a plain JSON status the client turns into a sentence ("The answer service is turned off for this deployment.", "Too many questions right now — try again in 30 seconds.").

| Rail | Default | Env |
|---|---|---|
| Endpoint off unless explicitly enabled → **403** | off | `ASK_ENABLED=true` (must be exactly `true`) |
| Origin allow-list → **403** for anything else; no `Origin` (curl, the eval) is allowed | same-host + localhost | `ALLOWED_ORIGINS=https://a.example,https://b.example` |
| Body size → **413** | 512 KB | — |
| Per-IP token bucket → **429** + `Retry-After` | 10 / minute | `ASK_PER_IP_PER_MINUTE` |
| Global daily cap on model calls (UTC day) → **429** | 500 | `ASK_DAILY_CAP` |
| Model call timeout → honest no-answer with the closest documents | 8 s | `ASK_TIMEOUT_MS` |
| Output ceiling | 600 tokens, temperature 0 | — |
| Counters that survive cold starts | in-memory | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (optional) |

Also: questions that retrieve nothing never reach the model or consume a daily slot; identical questions within 10 minutes are served from an in-memory cache; the prompt carries only the retrieved records (top-8 entities + one hop, ≤ ~6k tokens), never the whole export.

### Vercel environment checklist

Set these in the Vercel project (Production and Preview), then redeploy:

```
CLAUDE_API_KEY=sk-ant-…                  # server only, never VITE_-prefixed
ASK_ENABLED=true                         # anything else leaves /api/ask returning 403
ALLOWED_ORIGINS=https://<your-domain>    # comma-separated if you have more than one
ASK_DAILY_CAP=500                        # your ceiling on model calls per day
VITE_ANSWER_PROVIDER=claude              # build-time: makes the app call /api/ask instead of the mock
```

Optional: `ASK_PER_IP_PER_MINUTE`, `ASK_TIMEOUT_MS`, `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. And set a **monthly spend limit on the API key in the console** — the daily cap protects against a runaway day, the spend limit protects against a runaway month.

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

### Quality gates

- `npm run lint:strings` — fails if "AI", "LLM", "GPT", "Claude", "simulated" or "mock" appears in any JSX text or user-facing attribute under `src/` (comments, imports, identifiers, `src/eval/` and the mock provider are exempt).
- `npm run build` — runs `lint:strings`, then strict `tsc -b`, then the Vite production bundle. Any failure blocks the build.
- `npm run eval` — the 50-question acceptance set must pass 50/50 against the mock; `npm run eval:claude` must hold ≥ 48/50 against the real answer path (nightly in CI).
- `npm run test:api` — guard, retrieval, validator and SSE ordering for `/api/ask`, with a fake model call. No network.
- `.github/workflows/ci.yml` — string lint → `tsc -b` → build → mock eval → API tests → Playwright e2e → field-mode check on every push and PR to `main`.
