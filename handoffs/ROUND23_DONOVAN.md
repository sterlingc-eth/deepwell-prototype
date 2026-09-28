# Round 23 (D1) — Donovan accuracy

Branch: `r23d1`. Scope per `R23_CONTRACT.md`: `api/_lib/**`, `api/ask.js`,
`scripts/verify-golden.mjs`, `verify-dialogues.mjs`, `test-docs/scorecard/**`, router snapshots.

## Headline numbers (EXAM_TODAY=2026-09-25, `scripts/offline-exam.mjs` against
`scripts/golden/golden-export.json`)

| Stage | total | answeredWithoutModel | correct | wrong |
|---|---|---|---|---|
| Contract baseline (r23base) | 1504 | 1220 | 1183 | 22 |
| After item 1 (known-wrong root causes) + item 2 (isTeamScopedQuestion) | 1504 | 1220 | 1194 | 11 |
| After item 3 (needsModel clusters) | 1504 | 1264 | 1238 | 11 |
| After item 4 (field-phrasing-5.json, +200 fresh blind questions) | 1704 | 1387 | 1352 | 16 |

`needsModel` fell 234 → 190 → (with fp-5's own 267 new questions added to the pool) 267 total
remaining. `KNOWN_WRONG_IDS` (verify-golden.mjs) shrank from 22 to 11 ids, then grew back to 16
only because field-phrasing-5.json's own fresh measurement is 200 *brand-new* questions — see
"Item 4" below for exactly which 5 of those are new, documented gaps (never a regression on any
pre-existing id — verified directly, see that section).

All of `verify:golden`, `verify:precision-guard`, `verify:router` (snapshot refreshed twice,
intentionally, for this round's routing changes), `verify:dialogues`, `verify:fastpath`,
`verify:analytics`, `verify:doclookup`, `verify:lookups-r19`, `verify:financials`,
`verify:followups`, `verify:field-phrasing` through `-5`, and the R11_RULES baseline suite
(`agent`, `agent-v2`, `scorecard`, `citations`, `knowledge`, `relations`, `graph`, `financials`,
`job-costing`, `r7-guardrails`, `r7-search`, `r10-retrieval`, `offline-exam`) pass. `typecheck`,
`typecheck:api`, `oxlint` (zero new warnings in any file this round touched), and `build` (with
`VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy`) all pass. `ls api | wc -l` is still 13 (12 top-level
`.js` files + `_lib`).

## Item 1 — known-wrong root causes (11 of 22 fixed, 4 confirmed not fixable safely)

- **h140 / i188 / i195** (compareSet ISO-date grading): `compareSet`/`itemPresent` do plain
  normalized-token matching, not date-aware comparison like `compareValue` does. A multi-unit
  install-date list rendered as "November 6, 2023" never matched an oracle expecting the literal
  ISO token. Fixed with a new `formatDateHumanWithIso(ymd)` (fastPath.js) — `"November 6, 2023
  (2023-11-06)"` — applied ONLY at the ~3 call sites that feed a `set`-graded date list
  (`unitFieldFact`, `fetchOneMultiField`, the multi-unit install-date builder in
  `deterministicRouter.js`), never touching the many other `formatDateHuman` callers used for
  `value`-graded single answers.
- **i063/i065/i066/i067/i069/i070/i072** (dispatch_history compound "who + what"): "who was the
  last tech and what did they do" silently dropped the "what" half. Added `LAST_TECH_WHAT_RE`
  (deterministicRouter.js) — when it matches, the answer now also states every `work_performed`
  row for that visit, cited, following the exact precedent already established for the
  installer+date compound shape (g149/g153/h163).
- **j055** ("over the last week, how many service visits have we logged"): `resolveExtendedTimeRange`
  (analytics.js) treated any "last week" substring as the closed prior Mon–Sun calendar week.
  "over the last week" is the same rolling trailing-7-days idiom "over the last quarter" already
  gets — added a dedicated check ahead of the bare "last week" one. Verified directly: the closed
  calendar week has 0 visits at this harness's pinned today, the trailing 7 days has the oracle's
  own 27.
- **NOT fixed, documented instead** (all in `KNOWN_WRONG_IDS`, with full root-cause writeups
  in-place in `verify-golden.mjs`):
  - `breadth-content-019`, `breadth-semantic-001/002/003` — the bug is in the EXAM'S own oracle
    regex (an unanchored `ice `/`loud` substring matching "Serv**ice** Address:" and
    "amanda@i**cloud**.com"), not in this codebase. Loosening this codebase's own word-boundary
    matching to agree with the exam's buggy oracle would introduce real production false
    positives far worse than 4 measured wrong ids.
  - `h115`, `j141`, `j142`, `j143` — two different exam-generation rounds left genuinely
    conflicting oracles for the same real-world question (age-threshold via calendar year vs.
    day-precise install date; "lowest job count" via a bare GROUP BY vs. one joined to
    service_date). Reconciling either pair in favor of the minority oracle regressed 17+ other
    long-pinned ids in earlier attempts (see `resolveAgeFilter`'s own doc comment) — left open as
    an acknowledged, unresolved two-oracle conflict rather than trading a small cluster for a
    larger regression.

## Item 2 — `isTeamScopedQuestion` narrowing (fastPath.js)

`TEAM_SCOPED_RE` required only `for (?:the )?(?:team|techs?|technicians|dispatch|crew)` — "for
Crew Electric", "for Dispatch Solutions Inc", "for Team Fitness Gym" (real business names) would
all have falsely triggered team-only document scoping. Now requires the article: `for\s+the\s+
(?:...)`. All existing pinned positives already used "the", so nothing regressed; 5 own
paraphrases confirm every genuine phrasing still matches, 5 own negatives confirm the business-name
collision is gone (`scripts/verify-lookups-r19.mjs`, 112/112 passing).

## Item 3 — needsModel clusters closed (234 → 190 before item 4; net +44 correct, 0 new wrong)

- **Cluster A — untracked equipment/job fields** (`contactLookup.js`, `isUntrackedFieldQuestion`):
  a closed list of fields this schema has NO column or extraction key for at all (BTU rating, duct
  size, thermostat brand, capacitor/breaker size, energy-star rating, decibel rating, condenser
  location, filter brand, GPS coordinates, start-up amperage, unit paint color, equipment
  financing) — verified none of these terms ever appear in `golden-export.json`'s document text,
  so a model call could never have found a real answer either. Explicitly excludes `seer`/
  `filter_size` (`NO_FIELD_INTENTS`), which DO sometimes appear in free document text and must
  keep deferring to the model.
- **Cluster B — off-topic/trivia** (`contactLookup.js`, 11 new `OUT_OF_DOMAIN_PATTERNS`): weather,
  poems, arithmetic, sports trivia, jokes, password resets, "nearest gas station", state capitals,
  singing, "favorite customer", timers.
- **Cluster C1 — internal/team memo with no internal document on file** (`docLookup.js`,
  `isInternalMemoQuestion` + `countInternalDocuments`): "any memos for Kevin Pratt this week",
  "what did dispatch broadcast to the crew", "any internal-only documents at all". This golden
  corpus has zero internal-audience documents (same COUNT the field-phrasing-3 i142-i157 oracle
  uses: `documents.audience='internal'` + the pre-migration `_audience` extraction marker) —
  declines honestly when the count is 0, defers to the model when it's nonzero (no generalized
  "search internal documents by keyword/date" builder exists yet). Guards against a business's own
  name colliding with the bare "memo(s)" noun (case-sensitive bare-word match + no possessive
  apostrophe) the same way item 2's fix guards "crew"/"dispatch". Wired through both
  `parseDocLookupQuestion` (so the router's `docLookupIntent` gate sees it — this shape names no
  document TYPE, so it would never reach `DOCTYPE_WORD_RE` otherwise) and `runDocLookup` (the async
  COUNT itself). 20 own paraphrases + negatives in `scripts/verify-doclookup.mjs`.
- Router snapshot (`scripts/golden/router-precedence-snapshot.json` /
  `router-multi-claimed.json`) refreshed with `UPDATE_ROUTER_SNAPSHOT=1` — all 44 winner changes
  verified to be `null → claimed` (previously unrouted, now correctly answered), zero changes to
  any pre-existing question's winner.
- **Not attempted this round** (documented, not chased): Cluster C2 (real-time dispatch/schedule
  status questions) and the remaining ~136 non-honest-zero needsModel questions (set/value/number/
  yesno/rubric shapes) were not clustered/analyzed — a real follow-up hook for a future round.

## Item 4 — `field-phrasing-5.json` (200 new blind questions)

Written and **committed to disk before measuring** how any of this round's own code changes route
it (see that file's own header comment and `scripts/gen-field-phrasing-5.mjs`'s), grounded only in
live queries against `golden-export.json` — never keyed to any earlier exam's question text.
Sections: casual/filler single-field phrasing, compound two-field asks, document-existence yes/no,
warranty status read from the stored `warranty.expires` date, internal/team-memo paraphrases (own,
not copied from field-phrasing-3), off-topic/trivia paraphrases, untracked-field paraphrases,
technician totals/comparisons, relative-time phrasing not used in any earlier blind set (year-to-
date, last 2 months, past 6 months, last 45 days, last 2/8 weeks), adversarial traps, and
portfolio-wide coverage (`scripts/verify-field-phrasing-5.mjs`: 15/15 checks, all 200 oracles run
clean with zero skips/errors against the golden tenant).

**Measuring it caught 3 real, root-cause bugs — all fixed, all with their own paraphrase+negative
test coverage:**
1. `fastPath.js`'s `model_and_serial` trigger required the literal word "and"; "whats the model
   plus serial for X" fell through to the standalone `serial` trigger and silently dropped the
   model half — a confident-but-incomplete answer. Added "plus" as a synonym conjunction.
2. "has X's warranty expired yet" matched the DATE-only `warranty_expires` trigger (any "expir*"
   after "warranty") instead of the yes/no `warranty_out` intent, so a future expiry date came back
   as a bare "Expires <date>" with no explicit yes/no. Added a new `warranty_out` trigger for
   "has/had ... warranty ... expired" (past tense only, so "when **does** the warranty **expire**"
   — a genuine date question — is never mis-routed; caught and fixed via `verify-fastpath.mjs`'s
   own pinned corpus when an earlier draft used `expired?` with an optional "d").
3. `analytics.js`'s relative-time resolver required digits; "in the past six months"/"in the last
   two weeks" (spelled-out numbers) fell through with **no time filter at all**, returning the
   all-time total instead of either the intended window or a graceful defer-to-model. Extended to
   accept one..twelve spelled out.

**5 real, pre-existing analytics gaps were found and documented (not fixed this round — out of
this round's assigned clusters, and not safe to rush under this round's time budget)**, added to
`KNOWN_WRONG_IDS` in both `verify-golden.mjs` and `verify-precision-guard.mjs` with full
writeups: a technician head-to-head comparison that only works for asymmetric pairs (fails on a
tie), a "fewest jobs" ranking that counts a different thing than the plain per-technician total on
the same tenant, and no generic "distinct value" metric for an arbitrary field (technician count,
manufacturer/technician lists fall back to a generic enumeration instead of a plain DISTINCT list).

Confirmed via a direct re-classification of every pre-fp-5 question against the router snapshot
that none of these fixes (or the residual gaps) changed the winner for any pre-existing id — only
the 200 new k-ids appear in the snapshot diff.

## Files touched

- `api/_lib/fastPath.js` — `formatDateHumanWithIso`, `TEAM_SCOPED_RE` narrowing, `model_and_serial`
  "plus", new `warranty_out` "has...expired" trigger.
- `api/_lib/fastPathQuery.js` — ISO-date formatting at the 2 `set`-graded call sites.
- `api/_lib/deterministicRouter.js` — `LAST_TECH_WHAT_RE` + work_performed enrichment; ISO-date
  formatting for the multi-unit install-date builder.
- `api/_lib/analytics.js` — "over the last week" rolling window; spelled-out-number relative-time
  support.
- `api/_lib/contactLookup.js` — 11 new out-of-domain patterns; `isUntrackedFieldQuestion` +
  `buildUntrackedFieldAnswer`.
- `api/_lib/docLookup.js` — `isInternalMemoQuestion` + `countInternalDocuments`, wired into
  `parseDocLookupQuestion`/`runDocLookup`.
- `scripts/verify-golden.mjs` — `KNOWN_WRONG_IDS` shrunk 22→11 then to 16 (200 new questions, 5
  new documented ids), floors raised each step (final: correct ≥ 1345, answeredWithoutModel ≥
  1380, wrong floor = 16 via `KNOWN_WRONG_IDS.size`).
- `scripts/verify-precision-guard.mjs` — same 5 new ids added to its own mirrored baseline.
- `scripts/verify-lookups-r19.mjs`, `scripts/verify-doclookup.mjs`, `scripts/verify-fastpath.mjs`,
  `scripts/verify-analytics.mjs` — new paraphrase+negative coverage for every fix above.
- `scripts/gen-field-phrasing-5.mjs`, `scripts/verify-field-phrasing-5.mjs`,
  `test-docs/scorecard/generalization/field-phrasing-5.json` — new.
- `scripts/golden/router-precedence-snapshot.json`, `router-multi-claimed.json` — refreshed twice
  (item 3's clusters, then item 4's fixes), verified zero regressions on any pre-existing id both
  times.
- `package.json` — added `verify:field-phrasing-5`, wired into `verify:all`.

## SQL to paste

None. No schema changes this round.

## Hooks for other engineers

- `isTeamScopedQuestion` still has two diverging implementations — the narrowed one in
  `fastPath.js` (this round) and a separate, narrower copy in `analytics.js` (~line 3375, never
  touched — out of this round's stated scope). Worth unifying.
- Cluster C2 (real-time dispatch/schedule status questions, needsModel) and the ~136 remaining
  non-honest-zero needsModel questions (set/value/number/yesno/rubric shapes) are unclustered —
  next round's biggest opportunity for more no-model coverage.
- The 5 fp-5-documented analytics gaps (`KNOWN_WRONG_IDS`, see above) are a concrete, scoped
  follow-up: a real "distinct value" metric for technician/manufacturer, and fixing the technician
  ranking/comparison paths to agree with the plain per-technician total on ties.

## Risks

- The `warranty_out` "has...expired" trigger is deliberately past-tense-only and excludes "does"
  from its leading-verb list specifically to avoid mis-routing "when does the warranty expire"
  (a genuine date question) — any future edit to this trigger should re-run `verify-fastpath.mjs`'s
  pinned corpus, which caught this exact collision once already.
- `isInternalMemoQuestion`'s bare "memo(s)" match is case-sensitive by design (to avoid colliding
  with a capitalized business name mid-sentence) — a sentence-initial "Memos..." is handled by
  lowercasing only the first character before matching; any new trigger word added to that list
  should consider the same collision class.

Commit: see `git log -1` on branch `r23d1` for the SHA (committed after this handoff).
