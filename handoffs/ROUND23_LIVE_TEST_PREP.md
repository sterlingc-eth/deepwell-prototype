# Round 23 — T1, live-credit test day prep

Owner context: tomorrow the owner (Sterling) loads real Anthropic credits and runs a "huge major test" of
Donovan. This round's job: make that one command, safe, and maximally informative — and prove it works
TODAY, with zero credits and zero real network calls, so a bug in the live path is found here, not while
he's watching.

## What was built

1. **`scripts/lib/mockAnthropicClient.mjs`** (new) — a mocked Anthropic client that patches the same
   shared `Anthropic.prototype.messages.create` seam `scripts/offline-exam.mjs`'s own `installModelBlock`
   uses, but returns realistic, schema-valid tool_use responses and usage numbers DERIVED from the real
   request (`promptCache.js`'s own `estimateTokens`) instead of throwing. Scenarios: `answer` (normal,
   with a configurable `wrongRate`/`declineRate` to exercise CONFIDENT-WRONG counting), `flaky` (first N
   calls 529, then succeeds — exercises `withBackoff`'s real retry), `overloaded` (every call 529 —
   exhausts retries), `creditsOut` (400, credit-balance shape), `authError` (401), `slow` (artificial
   per-call latency, for timeout testing). `scripts/lib/rng.mjs` is a tiny shared seedable PRNG used by
   both this and `live-test-day.mjs`'s sampling, for reproducible test assertions.

2. **`scripts/live-test-day.mjs`** (new) — the one-command test day script. Four stages, one total $
   budget (default $25, `--budget=`) split into per-stage sub-budgets:
   - (a) stratified needs-model sample across exam.json + field-phrasing 1–4 + a dialogue-turn pool
     (harvested standalone from `dialogues-1/2.json` — see LIMITS below);
   - (b) every CURRENT rules-only-wrong id (computed fresh every run, never hardcoded — R23_CONTRACT's
     "KNOWN lists shrink-only"), re-asked with the model allowed — empirically confirms these are
     deterministic-layer bugs the model cannot reach (ask.js's pre-router answers before the model is ever
     consulted), so this stage costs ~$0 in practice;
   - (c) A/B — rules-only ($0) vs. rules+model on a SEPARATE stratified sample across every
     category/status, so the rules-only side has a real accuracy number too;
   - (d) Haiku vs. Sonnet on a small slice, toggling the existing `DONOVAN_RESEARCH_AGENT` env var around
     two calls — no answer-logic change.

   Crash-safety: a synchronous, atomic (`temp-then-rename`) checkpoint file written after EVERY completed
   question, never batched — `--resume` picks up exactly where a crash left off, refuses a mismatched
   resume (different export/budget/sample) unless `--force-resume`. Budget is a hard stop checked BEFORE
   every dispatch. Concurrency and a per-question timeout are both explicit, orchestrator-level controls
   (a small worker pool + `runScorecard`'s own `deadlineAt`/pageSize:1 pattern, reused rather than
   reimplemented). Report: accuracy, CONFIDENT-WRONG (matching `model-ab.mjs`'s own definition, exported
   and shared as `isNewConfidentWrong` so the two tools never define it two different ways) PLUS the
   stricter `confidentFabricationCount` (a true "stated as fact and wrong", excluding an honest decline
   that merely grades wrong), honest-decline rate, citation presence/support, latency p50/p95, $/question
   by category and model, every wrong answer (question/expected/got/route/cost), and a
   `.learning-candidates.json` of model-answered WINS in `exportMisses`' `{text, suggestedRoute}` shape
   (extended with context) for D1 to distill into deterministic rules later — never written into the
   `ask_misses` table (that's for misses, not wins).

   `--mode=production` is a separate, intentionally UNGRADED smoke test against the real deployed
   `/api/ask` (an existing `dw_live_...` API-key path, scope `"ask"` — no Clerk token needed, no DB
   credential ever given to this script).

3. **`docs/LIVE_TEST_DAY.md`** (new) — plain-language guide: PowerShell commands for both modes, how to
   set `ANTHROPIC_API_KEY` in the current shell only (never a file), the safe browser-console way to mint
   a scoped API key for the production smoke test, the pre-flight checklist (dry run first; raise the
   per-tenant daily $ caps in `planner/spend.js`/`escalation.js` before a bigger PRODUCTION run — local
   mode's synthetic tenant never hits them, which is itself called out), what "good" looks like, and how
   to hand the report back to Claude.

4. **`scripts/verify-live-test-day.mjs`** (new, wired into `verify:all`) — 50 checks, in-process, zero
   real network: pure helpers (sampling, budget split, checkpoint round-trip, report shape), then the REAL
   pipeline under the mock — budget hard stop mid-run, retries/429/overload with real backoff, a
   persistent-outage scenario asserted to never fabricate, a concurrency-limit check, a per-question
   timeout that doesn't block the whole run, a simulated-crash-then-`--resume` that proves no completed
   result is lost, a refused-resume-on-mismatch check, and — via the same mock — `model-ab.mjs`'s own
   `--live` path exercised for the first time (previously "written, not exercised"; its own header comment
   updated accordingly). Runs in ~3 minutes (the $0 rules-only baseline pass over the full exam +
   dialogues, computed once and reused across scenarios, dominates).

## Small, additive edits to files T1 owns

- `scripts/model-ab.mjs`: exported `dryRunWithExport` and `liveRun` (were file-private — needed so
  `live-test-day.mjs`'s `--dry-run` and the verify suite could call them); extracted the inline "new
  confident-wrong" filter into an exported, documented `isNewConfidentWrong(before, result)` so both tools
  share one definition.

## Measured (honest, labeled)

- Baseline offline exam, unchanged, confirmed after all edits: **1220/1183/22** (answered-without-model /
  correct / wrong) — matches R23_CONTRACT.md's stated baseline exactly, no regression.
- `npm run verify:live-test-day`: **50/50 passed**, ~3 min, zero real network calls.
- Dry-run cost ceiling (`--dry-run`, real numbers, $0 spent): 1504 questions, 234 need the model,
  estimated **$9.79** to ask every one of them at real prices — `live-test-day.mjs`'s actual run only
  samples a subset of that 234 (default caps: 60 for stage a, 40 for stage c), so a real run costs
  noticeably less than $9.79, well inside the $25 default budget.
- All simulated $/accuracy numbers seen during development (mock `wrongRate`/`declineRate` runs) are from
  the MOCK, not a real model — never presented as real performance, only as "the mechanism reacts
  correctly to a fabricated wrong answer / a retried 429 / a persistent outage", which is what those tests
  check.

## For D1 (observation, not a fix — outside T1's ownership)

`scripts/model-ab.mjs`'s `dryRunWithExport` occasionally logs "1 model call(s) were attempted during the
rules-only pass" on a full-exam dry run (`installModelBlock` catching an attempted call that should not
have happened) — pre-existing, not introduced this round, worth a look when convenient.

## Exact commands for tomorrow

```powershell
# 1. dry run — $0, always first
node scripts/live-test-day.mjs scripts/golden/golden-export.json --dry-run --budget=25

# 2. the real run
node scripts/live-test-day.mjs scripts/golden/golden-export.json --budget=25

# if it stops for any reason, resume exactly where it left off:
node scripts/live-test-day.mjs scripts/golden/golden-export.json --budget=25 --resume
```

Full walkthrough (including the production-smoke-test option): `docs/LIVE_TEST_DAY.md`.

## Finishing checklist

- `npm run typecheck` — clean.
- `npm run typecheck:api` — clean (scripts/** are plain `.mjs`, outside `tsconfig.api-check.json`'s
  `api/**/*.ts` scope).
- `npx oxlint api scripts src` — zero new warnings (checked new files individually with zero output, and
  the full repo's existing warnings are unchanged, all in files this round never touched).
- `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build` — clean.
- `npm run verify:agent verify:agent-v2 verify:scorecard verify:citations verify:knowledge verify:relations
  verify:graph verify:financials verify:job-costing verify:r7-guardrails verify:r7-search
  verify:r10-retrieval verify:offline-exam verify:model-ab verify:spend-control` — all pass (unchanged).
- `npm run verify:live-test-day` (new) — 50/50 pass.
- Offline exam baseline — 1220/1183/22, unchanged.
- `api | wc -l` — unchanged (T1 made no `api/` edits this round beyond none; `api/_lib/planner/spend.js`
  was read-only this round, no bug found).
- No push. No `.env`/secrets read. No real Anthropic/Voyage calls anywhere in this round's own tests.
