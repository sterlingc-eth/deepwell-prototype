# Donovan self-learning loop — Part B: the nightly learner + approval flow

Builds on Part A (`DONOVAN_TRAINING_PLAN_2026-09-21.md`): the schema/verify/overlay
engine already existed (`api/_lib/learning/{proposals,verify,overlay,store}.js`,
`M3-config/26-donovan-learning.sql`). This adds the pieces that actually
*produce* proposals and let an operator act on them.

## Architecture

```
missDigest.buildMissDigest()          (last 24h, cross-tenant, redacted)
        │  flattenMissGroups()
        ▼
proposer.proposeFixesForMisses()      deterministic pass (free) → remaining
        │                              groups → 1 Haiku call each, capped
        ▼
verify.verifyProposalLive()           routing bank + miss questions + negatives
        │
        ▼
policy.decidePolicyStatus()           kind × DONOVAN_AUTO_LEARN × verification.ok
        │
        ▼
store.insertProposal() / decideProposal()   → donovan_proposals (+ donovan_learned
                                               on approve/auto_approve)
```

New files (all `api/_lib/learning/`): `proposer.js`, `policy.js`, `sweep.js`.
`sweep.js` is the orchestrator with two entry points: `runLearningSweepStep()`
(cron, once/UTC day, task key `donovan-learning`) and `runLearningNow()`
(operator button, no day-guard, still skips if migration 26 isn't applied).

**Deterministic pass** (`proposer.js`): scans each miss question's words
against `nlNormalize.js`'s `VOCAB`. A token ≤4 chars that's an unambiguous
prefix of exactly one vocab word → `abbreviation`. A token ≥4 chars within
Damerau-Levenshtein ≤1 of exactly one vocab word → `typo`. Same guards as the
live corrector (single-record questions, digit-adjacent tokens, street
suffixes) plus `proposals.js`'s `STOPWORDS` set (now exported — a real gap
found by testing: "many" → "may" was schema-valid but obviously wrong).

**Model pass**: one Haiku (`DONOVAN_LEARN_MODEL`, default `claude-haiku-4-5`)
tool-use call per group the deterministic pass found nothing for, capped at
`DONOVAN_LEARN_MAX_CALLS` (default 20) per run, temperature 0, ≤300 output
tokens. Same `withBackoff`/`MODEL_TIMEOUT_MS`/`maxRetries:0` idiom as
`api/_lib/routes/analytics.js`'s planner. A question is redacted
(`missDigest.redactPII`) and re-checked before it's ever sent; if contact info
survives, that group is skipped with zero model calls spent.

**Every** candidate (deterministic or model) goes through `validateProposal`
first. Invalid ones are still inserted as `auto_rejected` (with the reason)
so an operator sees what was tried, unless the kind itself couldn't even be
parsed (logged, not inserted — the `kind` CHECK constraint would reject it).

**Decision policy** (`policy.js`, pure): verification failure → always
`auto_rejected`. Otherwise: `typo`/`abbreviation` with `tenantCount≥1` and
`count≥2` → `auto_approved` when policy isn't `off`, else `pending`.
`synonym`/`few_shot` → `auto_approved` only under `all`. `capability_gap` →
always `pending` (never becomes an overlay entry regardless — Part A's own
invariant).

**Re-verification on approve**: both the nightly auto-approve path and
`api/review.js`'s `learningDecide` action re-run `verifyProposalLive`
immediately before writing to `donovan_learned` — a proposal that verified
clean last night but wouldn't today (vocab/bank changed) is refused, never
silently applied. `learningDecide` needed a way to read one proposal's stored
kind/payload back through RLS, so migration 26 gained `learning_get_proposal`
(and `learning_list_active` was widened to also return `id`/`created_at`, via
`DROP FUNCTION IF EXISTS` + `CREATE` since Postgres won't let `CREATE OR
REPLACE` change a return shape) — both idempotent, appended to the existing
`M3-config/26-donovan-learning.sql`, not a new migration file.

## Env vars (names only)

- `DONOVAN_AUTO_LEARN` — `off` | `vocab` | `all`, default `vocab`.
- `DONOVAN_LEARN_MAX_CALLS` — model-call cap per run, default 20.
- `DONOVAN_LEARN_MODEL` — override the model, default `claude-haiku-4-5`.
- Reuses `DEEPWELL_FOUNDER_TENANT_ID` / `DEEPWELL_OPERATOR_USER_IDS` (Part A's
  `isPlatformOperator`) for the operator gate, and `CLAUDE_API_KEY` /
  `ANTHROPIC_API_KEY` for the model call.

## SQL to paste

Re-run `M3-config/26-donovan-learning.sql` in full — it's idempotent
(`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, and one
`DROP FUNCTION IF EXISTS` immediately followed by its replacement). Existing
`donovan_proposals`/`donovan_learned` rows and the RLS setup are untouched;
only `learning_list_active()`'s return shape widens and `learning_get_proposal`
is added.

## Operator workflow

Team screen → **Donovan learning** card (operator-only; invisible to a
tenant's own admin — the card probes once on mount and hides itself on the
403). Shows pending proposals (kind, payload, evidence counts, verification
numbers) with Approve/Reject, active learned items with Deactivate, and
**Run learning now** / **Export approved** buttons. Same data is reachable via
`POST /api/review` actions `learningList`, `learningDecide`, `learningDeactivate`,
`learningRunNow`, `learningExport` — all `requireOperator`-gated (403 otherwise).

The Tier 1 miss digest (email + in-app notification) now also folds in a
"Proposed fixes" section — counts by status for whatever's been proposed in
the same 24h window (`missDigest.buildMissDigest`'s new `.learning` field).

## Weekly repo-sync step (manual, by the Claude Code session)

1. Operator clicks **Export approved** (or `POST /api/review {action:'learningExport'}`).
2. For each `abbreviation`/`typo` item: add `{from: to}` into `ABBREV` in
   `api/_lib/nlNormalize.js` (or leave it live-only via `donovan_learned` if
   it's working fine as an overlay — folding into the repo is for the items
   worth hardcoding as base vocabulary).
3. For each `synonym` item: add the word to `ENTITY_SYNONYMS[entity]` in
   `api/_lib/analytics.js`.
4. For each `few_shot` item: consider adding it to
   `ANALYTICS_FEW_SHOT_BLOCK` if it's a genuinely new question shape.
5. Run `npm run verify:all`, regenerate the question bank
   (`node scripts/gen-question-bank.mjs`) if vocabulary changed, commit.
6. `capability_gap` items are read-only signal for the product backlog — never
   folded into code automatically.

## Verify

`node scripts/verify-learning.mjs` — 130/130 checks (added: deterministic
proposer candidate generation incl. the "many"→"may" false-positive fix, the
redaction gate, the full policy matrix, the once-per-day guard, and a
source-scan that all 5 operator actions call `requireOperator`).
`npm run verify:all` — 0 FAIL. `typecheck`, `typecheck:api`, `lint`, `build`
all clean. `ls api | wc -l` still 13.
