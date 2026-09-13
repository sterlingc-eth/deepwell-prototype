# Ingestion at scale — how DeepWell earns trust with thousands of documents

**Date:** September 13, 2026 · **Trigger:** Sterling — "if a company is trusting us with 1000s of documents, this must improve" and, directly, "95% of 10,000 leaves a lot of room for error."

That second point is the one this document exists to answer, and it's correct. 95% accuracy on 10,000 documents is 500 wrong documents. If any one of those 500 silently becomes something a technician, an owner, or a warranty claim relies on, the aggregate accuracy number was never the thing protecting the customer. **No accuracy percentage, on its own, is an acceptable safety mechanism at real volume.** This document is about what actually is.

## The wrong mental model, and the right one

The wrong model: "the pipeline is 95% accurate, so it's fine." That treats every document as equally consequential and every error as equally survivable — neither is true. A misread technician name is a shrug. A misread warranty expiration date that costs a customer a covered repair is not.

The right model, and the one M2's pipeline is already structurally built for even though this milestone didn't spell it out: **nothing DeepWell tells a customer is true because a model said so. It's true because it's Verified — either a human confirmed it, or enough independent corroborating evidence agreed.** Accuracy percentage measures how much manual work the Verified gate has to do, not whether the gate exists. The gate is what protects the customer; the percentage is an operating-efficiency number, not a safety number. This reframing changes what "improve the score" should really optimize for: not a single aggregate percentage, but the size and speed of the gap between "ingested" and "safely actionable."

## The four layers that make volume safe regardless of the aggregate accuracy number

### 1. Confidence-tiered auto-approval, not one global threshold

Today's pipeline treats ≥0.90 confidence as "auto," 0.70–0.89 as "needs review," <0.70 as "dropped." At thousands-of-documents volume this needs to become risk-tiered, not just confidence-tiered — the threshold for auto-advancing a document to "Verified" (the state Ask treats as ground truth without a caveat) should depend on what the field controls:

- **High-consequence fields** (warranty expiration, serial number used for a claim, anything an EXP-01 "prepare claim packet" export will hand to a manufacturer) — never auto-verify, regardless of confidence. Always route to human review at least once per entity, with subsequent corroborating documents able to raise confidence but never fully bypass the first human look.
- **Medium-consequence fields** (technician name, service date, cost) — today's 0.90 auto-threshold is reasonable, but should require agreement across ≥2 independent facets (e.g. the field appears with the same normalized value on two separate documents) before a first-time value auto-verifies without review, since a single misread on a single document is exactly the failure mode a 95% aggregate score hides.
- **Low-consequence fields** (freeform notes, unmapped facets shown as "unconfirmed") — current behavior (auto-index, labeled unverified, never counted as authoritative) is already correct and doesn't need to change.

**Built, September 13, 2026** — `src/core/pipeline/autoverify.ts` (new pipeline step 8, see `docs/INGEST_API.md`). Every registered field now carries a `consequence` tier (`FieldSpec.consequence` in `types.ts`, defaulting to `'medium'` when unset — the conservative default). In the HVAC schema (`src/domains/hvac/schema.ts`): `warrantyExpiry` and `serial` are `'high'` (never auto-verify — see the exact bar below); `date`, `technicianName`, `cost` are `'medium'`; `notes`/`workPerformed` are `'low'` (unchanged, always auto). A document structurally ready for `'verified'` only actually gets there once every consequential field clears its bar; otherwise it's capped at `'linked'` (still answerable as Unverified) with a `needs-verification` issue surfaced in Review, explaining which field and why. The existing Approve button always clears it — one human look satisfies both the high-consequence "at least once" requirement and the medium-consequence corroboration bar at once, by design.

One correction to this document's own earlier framing, worth being honest about: before this change, the pipeline didn't actually auto-verify anything at any confidence level — `ingestMap` computed the stage before `resolve.ts` had even run, and nothing after that ever recomputed it, so a document sat at `'extracted'` until a person opened it, regardless of confidence. So this wasn't tightening an existing 0.90/0.70 threshold (no such threshold existed in code); it was *adding* the first real auto-advancement path at all, gated correctly from day one rather than gated loosely and then tightened. The upside this unlocks is real for "fast," not just "safe": a structurally complete, low/medium-consequence, corroborated document is now answerable as Unverified immediately, and reaches full Verified without waiting on a human at all — which is exactly the load-bearing capacity a 10,000-document backlog needs.

Known, documented limitation: corroboration is only checked against documents already in the graph at the moment a given document runs the pipeline — a medium-consequence value that was the only observation at the time stays blocked even after a second, corroborating document arrives later (it isn't retroactively re-scanned, the same tradeoff `remap.ts` already makes for schema promotion). The Approve button is always available, so nothing is ever permanently stuck — it just means yesterday's under-corroborated document doesn't silently unblock itself today. A bounded follow-up (re-run `autoverify.ts` over previously-blocked documents when a new corroborating one lands) is reasonable future work, not required for this to be safe.

### 2. Mandatory statistical sampling audits, not just per-document review

Per-document review doesn't scale to thousands of documents and was never meant to catch everything — a human reviewing every flagged document still won't independently discover an error the pipeline is *confident* about but wrong on. The catch for that is a sampling audit, run automatically and continuously, not manually and occasionally:

- Every batch draws a randomized statistical sample (sized to the batch: enough to detect a 3-point accuracy swing at 95% confidence — roughly 30–60 documents depending on batch size, using a standard proportion confidence-interval calculation) of documents already marked "Verified," and a person re-checks them blind (without seeing what the pipeline extracted first).
- The measured sample accuracy becomes the tenant's **live, per-batch accuracy number** — not a one-time 50-question eval run at onboarding, but a rolling number that would have caught a systematic drift (a form layout the model started misreading, a registry field someone corrupted) long before it reached 500 wrong documents.
- A sample accuracy drop of more than a few points versus the tenant's established baseline should pause new auto-verification for that tenant (not the whole system) and alert DeepWell staff — this is a real gate, not a dashboard number nobody watches. `claude/ENGINEERING_REQUIREMENTS_SPEC.md`'s existing SLO table already lists "Eval accuracy per tenant ≥95%, alert on a >5 point drop" — this sampling mechanism is what makes that SLO actually monitored on real ongoing ingestion rather than only at go-live.

### 3. Staged rollout by volume, never a 10,000-document first batch

A company with a 10,000-document backlog should never upload all 10,000 on day one. The onboarding flow (already scoped for M3 — "account → first batch → 50-question set → accuracy report → go-live") should gate batch size the same way:

- **Pilot batch** (recommend 50–100 documents, capped): full universal-read + mapping pipeline, full review of every document regardless of confidence (yes, 100% review — the point is measuring the pipeline on this tenant's actual paperwork, not saving review time yet), producing a tenant-specific accuracy number on their own real documents, not the generic 27-document synthetic eval set.
- **Ramp batches** (10x pilot size, several rounds): confidence-tiered auto-approval per layer 1 above, continued full sampling audit per layer 2, accuracy number re-measured each round.
- **Full-volume ingestion**: unlocked only once the tenant's own measured accuracy (not DeepWell's generic eval score) has held steady across at least two ramp rounds. A tenant whose paperwork is unusually messy (bad handwriting, a form layout the model struggles with) gets caught here — before 10,000 documents, not after.
- This also bounds cost and API rate exposure automatically: no batch can be larger than what the guard rails (`INGEST_DAILY_PAGES`) and the current ramp stage allow, so a runaway upload can't itself become the incident.

### 4. Error budgets and blast-radius limits, not "try to be accurate"

However good the pipeline gets, plan for the documents it gets wrong rather than only trying to prevent them:

- **Per-tenant error budget**: track, per tenant, the running count of Verified-then-later-corrected facts (a person fixed something the pipeline had marked Verified). A rising correction rate is the earliest real signal something is systematically wrong — earlier than a sampling audit, because it's driven by the customer's own usage, not a periodic check.
- **Blast-radius limits on automation downstream of extraction**: nothing auto-triggers an external action (a warranty-claim export, an alert to a customer, a dashboard number the owner might act on financially) from a fact that isn't Verified per layer 1's rules. This is already true for Ask's `verifiedCount`/`unverifiedCount` split — it needs to hold with equal strictness for every future consumer of the data (dashboards, exports, alerts), not just the Q&A surface.
- **A visible, honest per-tenant accuracy number**, always shown, never hidden behind a marketing "99% accurate" claim on the site. `claude/REQUIREMENTS_TRACEABILITY.md`'s NN-5 requirement ("each tenant has a live accuracy number on their own question set; below 95%, go-live is blocked") already commits to this in principle — the sampling mechanism in layer 2 is what keeps that number honest after go-live, not just at go-live.

## What this means for "improve the score"

The M2 eval gates (classification, field recall, link precision, dedupe) now all pass on the 27-document synthetic test set — real fixes, not gamed, detailed in `claude/M2_BUILD_SUMMARY.md`'s second-pass update. That was worth doing: a pipeline that can't hit 95% on a controlled test set with known-messy documents has no business being trusted on an uncontrolled real backlog. But it answers a different question than "will this be safe at 10,000 documents," and conflating the two is exactly the mistake this document is arguing against. The honest chain of reasoning is:

1. The pipeline mechanics are proven correct on hard, deliberately messy synthetic cases (M2, done).
2. The pipeline needs risk-tiered auto-approval so consequence, not just confidence, decides what needs a human (layer 1 above — not yet built, real next work).
3. Trust at real volume comes from continuous statistical auditing catching drift the aggregate number can't see (layer 2 — not yet built), staged rollout that bounds exposure while a tenant's real paperwork is still being measured (layer 3 — the onboarding flow M3 already scopes, needs this batch-gating logic added), and error budgets that assume some errors will always get through and plan for them rather than pretending otherwise (layer 4 — partially exists in the Ask verified/unverified split, needs to extend everywhere).
4. **None of this works without real server-side persistence, backups, and a tenant security boundary** — M2's IndexedDB-in-one-browser storage cannot be the home for a company's 10,000 real documents regardless of how good the pipeline's accuracy is. This is why M3 needs to start now, alongside this work, not after it. See `claude/M3_PLAN.md`.

This document should be read alongside `claude/M3_PLAN.md` (the infrastructure that makes volume physically safe) and `claude/DOCUMENT_HANDLING_AGREEMENT_DRAFT.md` (what needs to be true, in writing, before a real customer commits their documents) — the three together are the actual answer to "a company is trusting us with thousands of documents," not any one of them alone.
