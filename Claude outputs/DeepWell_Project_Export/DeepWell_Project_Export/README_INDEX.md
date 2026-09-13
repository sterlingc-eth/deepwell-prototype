# DeepWell Project Export — Index

Exported September 13, 2026 from the "DeepWell" Claude Project + the live `deepwell-app` repo, for Sterling to add to another project/reference system.

## What's in this folder

- **`project-docs/`** — the substantive markdown history from the DeepWell Claude Project (product decisions, build summaries, specs, deployment notes), mirroring their original paths (`claude/...`, `docs/...`, or root-level).
- **`current-codebase/`** — a snapshot of the live `deepwell-app` repo's source: `src/`, `api/`, `test-docs/`, `public/`, `README.md`, `package.json` (node_modules and dist excluded — run `npm install` to rebuild).

## Full document fidelity note

The Claude Project holds 70 documents. This export includes the ~26 that matter most for understanding where DeepWell is and how it got there: the binding product decisions, the current engineering spec, all M0–M3 build summaries, the ingestion/storage strategy docs, the requirements traceability scorecard, and the key early design-system history. A handful of the largest docs (`DEEPWELL_BUILD_SPEC.md`, `claude/ENGINEERING_REQUIREMENTS_SPEC.md`) are cross-referenced rather than duplicated twice since they're near-identical in substance.

**Not included** in full text here (still live in the Claude Project, retrievable anytime): the design-research documents under `docs/` (VISUAL_STYLE_GUIDE, DESIGN_STRATEGY_ROADMAP, DEEPWELL_DESIGN_VISION, PERSONA_DESIGN_PROFILES, DESIGN_SYSTEM_SPEC, COMPETITIVE_DESIGN_AUDIT, DAYS_2_3_SUMMARY, KNOWN_LIMITATIONS, DEMO_CHECKLIST, COREY_DEMO_GUIDE, INTEGRATION_TESTING), several Day-2/3 assembly and animation summaries under `claude/`, the HVAC ecosystem/workflow research docs, test-scenario and edge-case docs, the MVP feature spec, the cycle-1/3 financial and technical strategy docs, the Corey interview guide, and the two file uploads (`DeepWell_Foundation_Document.pdf`, `1000008572.png`). If you want any of these pulled into a future export, just ask and they can be fetched and added.

## Included project docs

```
project-docs/
├── DEEPWELL_BUILD_SPEC.md
├── DEPLOYMENT_CONVERSATION.md
├── DeepWell_V1.0_Session_Complete.md
├── claude/
│   ├── M0_BUILD_SUMMARY.md
│   ├── M1_BUILD_SUMMARY.md
│   ├── M2_BUILD_SUMMARY.md
│   ├── M2_PLAN.md
│   ├── M3_PLAN.md
│   ├── ENGINEERING_REQUIREMENTS_SPEC.md
│   ├── ASK_INTERFACE_BUILD_SUMMARY.md
│   ├── PRODUCT_DECISION_ASK_INTERFACE.md
│   ├── AI_INTEGRATION_PLAN.md
│   ├── CONVERSATION_V1.2_START_SUMMARY.md
│   ├── DEEPWELL_PRODUCT_REDESIGN_V2.md
│   ├── STERLING_DEPLOYMENT_GUIDE.md
│   ├── DESIGN_SYSTEM_IMPLEMENTATION_PROGRESS.md
│   ├── LEAD_ARCHITECT_BRIEF.md
│   ├── PREMIUM_DESIGN_DELIVERABLES.md
│   ├── DOCUMENT_HANDLING_AGREEMENT_DRAFT.md
│   ├── INGESTION_STRATEGY_AT_SCALE.md
│   ├── REQUIREMENTS_TRACEABILITY.md
│   └── STORAGE_COST_AND_PRIVACY_PLAN.md
└── docs/
    ├── ASK_API.md
    ├── EVAL_QUESTIONS.md
    └── INGEST_API.md
```

## Recommended reading order for a new reader

1. `claude/PRODUCT_DECISION_ASK_INTERFACE.md` — the binding product decision (Ask-first interface, ingestion discipline).
2. `claude/REQUIREMENTS_TRACEABILITY.md` — scorecard of what's shipped vs. mocked vs. missing.
3. `claude/ENGINEERING_REQUIREMENTS_SPEC.md` (or `DEEPWELL_BUILD_SPEC.md`) — the engineering blueprint.
4. `claude/M0_BUILD_SUMMARY.md` → `M1` → `M2_BUILD_SUMMARY.md` — what actually got built, in order.
5. `claude/INGESTION_STRATEGY_AT_SCALE.md` and `claude/STORAGE_COST_AND_PRIVACY_PLAN.md` — the two most recent research/strategy pieces (auto-verification tiers; Postgres+R2 storage recommendation).
6. `claude/M3_PLAN.md` — what's next and what's blocking it.
