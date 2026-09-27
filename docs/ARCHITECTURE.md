# DeepWell / Donovan architecture map

A from-the-top orientation to where things live, written for whoever opens
this repo cold. It describes the SHAPE of the system, not its history — for
"why does X work this way" or a round-by-round build log, see `handoffs/`
(one file per topic/round, newest dated `2026-09-2x`) and `R11_RULES.md` /
`R18_CONTRACT.md`-style contracts at the repo root for the ground rules each
round worked under. This file is kept behavior-neutral: it explains what
exists, not what changed this round.

## The one-line version

`POST /api/ask` (`api/ask.js`) answers a question by running it through a
chain of cheap, deterministic, no-model "pre-routers" first, in order, each
of which can answer confidently or fall through to the next. Only if
*nothing* deterministic can answer does the question reach the Sonnet
research agent, which can call read-only tools against the same database.
No step ever calls a model unless it has to, and the routers are ordered
cheapest/most-certain first.

## The answer pipeline (api/ask.js), in order

Each stage below is a numbered comment block inside `api/ask.js` itself
(`grep -n '^\s*// ---- ' api/ask.js` reproduces this list with line numbers).
A stage either returns an answer or returns `null`/falls through — a stage
must never guess.

| # | Stage | Lives in | What it's for |
|---|-------|----------|----------------|
| 0 | Meta-question pre-router | inline in `ask.js` (`classifyMetaQuestion`) | "what can you answer", "who are you" — no model, no retrieval |
| 0.35 | Relations engine | `api/_lib/relations/**` | Structural/graph-shaped questions (who's related to whom, timelines) — DB only |
| 0.4 | Deterministic history router | `api/_lib/deterministicRouter.js` | Closed-vocabulary "has X changed / when did Y happen" questions; delegates multi-condition filters to `compose.js` |
| 0.42 | Query decomposition | `api/_lib/decompose/**` | Splits a multi-clause question into parts before routing each; also calls into `compose.js` (`decompose/entitySets.js`) |
| 0.5 | Fast-path pre-router | `api/_lib/fastPath.js`, `fastPathQuery.js` | High-frequency literal lookups (serials, addresses) |
| 0.6 | Contact-lookup pre-router | `api/_lib/contactLookup.js` | "who is the contact for..." |
| 0.62 | Doc-lookup pre-router | `api/_lib/docLookup.js` | "find the document that..." |
| 0.63 | Content-count pre-router | `api/_lib/contentCount.js`, `api/_lib/content/**` | "how many documents/records..." |
| 0.65 | Money gate | `api/_lib/financials/**` | Anything touching an invoice/balance/payment number — a single, deterministic source of truth for money so two answers never disagree |
| 0.7 | Analytics pre-router | `api/_lib/analytics.js`, `api/_lib/analytics/**`, `api/_lib/routes/analytics.js` | One Haiku tool-use call to plan a filter/aggregate query *before* retrieval, still no free-form generation |
| 1 | Retrieval | `api/_lib/search/**` (chunking/embeddings/rerank via Voyage) | Only reached if nothing above answered or the cache missed |
| 2 | Ask (the research agent) | `api/_lib/agent/loopV2.js` (loop), `tools.js` (read-only DB tools it can call), `shape.js` (turns its final tool call into the response shape), `verify.js` (re-checks each fact against its own cited source before it ships) | The one place a full Sonnet call happens; only reached when every deterministic stage above returned null |
| 3 | Enforce sourcing | `api/_lib/citations/**`, `api/_lib/claims/**` | Every factual answer must carry citations traceable to what the tools actually returned — this stage drops anything that doesn't |
| 4 | Bookkeeping | `api/_lib/usage.js`, `missStore.js`, `askCache.js` | Post-response only (the user already has their answer): usage counters, cache writes, miss logging for the learning loop |

Cutting across all of the above:
- **Caching**: `api/_lib/askCache.js` (exact) and `api/_lib/cache/semanticCache.js`
  (semantic, tried only on an exact-cache miss) can short-circuit the whole
  chain before stage 0 even runs.
- **Conversation / follow-ups**: `api/_lib/conversation.js` +
  `api/_lib/followup/**` resolve "what about last month" style follow-ups
  against the prior turn before the question re-enters the chain above.
- **Router telemetry / precedence**: `api/_lib/agent/router.js` and
  `api/_lib/router/classifyAll.js` log which stage answered (or didn't) so
  regressions in routing order show up in the exam, not just in prod.
- **Learning loop**: `api/_lib/learning/**` (recipes, overlay, gap promotion)
  turns exam misses into new deterministic recipes/few-shots, gated by
  `api/_lib/scorecard/**`'s exam re-run so nothing is promoted that
  regresses another category.
- **Knowledge graph**: `api/_lib/graph/{build,query,rank}.js` (+ `kg_edges`
  table) — a separate structural index the relations engine and the agent's
  tools can both query.
- **Industry vocabulary**: `api/_lib/industry/**`, `api/_lib/vocab/**`,
  `documentTypes.js` — the tenant-specific brand/doc-type/synonym vocabulary
  every stage above reads from, so nothing here is HVAC-hardcoded at the
  string level.

## Shared low-level helpers

- `api/_lib/util/escape.js` — regex/SQL-LIKE string escaping, used across
  most of the modules above. Consolidated here in R18 P3 house cleaning from
  several byte-identical local copies; a couple of files keep their own
  (documented at the top of that file) because they're owned by a different
  engineer this round or their copy wasn't byte-equivalent.
- `api/_lib/scope.js` — shared address/tenant-SQL helpers used by several
  pre-routers.

## Everything else at a glance

- **api/*.js / api/records.ts** — one Vercel serverless function per
  top-level file (`/api/ask`, `/api/records`, `/api/billing`, ...); `api/
  _lib/**` is shared code, never a route by itself.
- **src/** — the React app. Three entry points, one per Vite build target
  in `vite.config.ts`: `src/main.tsx` (the desktop/tablet app, `/app/`),
  `src/mobile/main.tsx` (the installable field PWA, `/m/`, service worker at
  `public/m/sw.js`), `src/expenses/main.tsx` (the standalone founders'
  expense tracker, `/expenses/`, unrelated to Donovan). `src/domains/hvac/`
  is the one live vertical; `src/domains/{electrical,plumbing,property}/`
  and `src/domains/registry.ts` are documented, intentionally-unwired
  scaffolding for a future multi-industry switch (see
  `handoffs/INDUSTRY_EXPANSION_2026-09-21.md` and that file's own header) —
  not dead code, don't delete them.
- **scripts/** — one file per offline check (`verify-*.mjs`/`.ts`, wired into
  `npm run verify:<name>` and mostly into `verify:all`), a few Playwright
  UI/UX harness pairs (`scripts/<name>-harness/` + `scripts/verify-<name>-ui.mjs`),
  and a handful of manually-run generators/tools (`gen-*.mjs`,
  `build-bundle.mjs`, `synth-business.mjs`, ...) documented at the top of
  each file plus in whichever `handoffs/*.md` introduced them.
- **test-docs/scorecard/** — the exam (`exam.json`) and its oracle/grader;
  never edited by house cleaning or by any engineer without the exam
  explicitly assigned. **test-docs/business{,-small}/** — a synthetic
  120/30-customer corpus regenerated fresh by `scripts/synth-business.mjs`
  (gitignored — only the `*_KEY.json` specs are committed).
- **M3-config/** — one `NN-*.sql` migration per round, applied by hand
  against Neon (`node M3-config/run-migration-v2.js`, see
  `M3-config/MIGRATION_SETUP.md`) — there is no migration framework, order is
  the filename order.

## Ground rules that shape all of the above

See `R11_RULES.md` (shared rules) and the current round's `R*_CONTRACT.md`
for the constraints every file above was built under: no model call may be
required for a feature to work (models are optional, capped, flagged), every
factual answer needs citations, schema changes are additive SQL migrations
only, and accuracy beats coverage — a stage returns `null` rather than guess.
