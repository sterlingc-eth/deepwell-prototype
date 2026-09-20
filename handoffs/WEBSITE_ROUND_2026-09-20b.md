# Website round 2 — 2026-09-20b

Scope per owner brief (first pass): `index.html` only — `public/terms.html`/`public/privacy.html` untouched, neither referenced the trial, Donovan, scanning CTA, or pricing copy touched below. (A second pass below, driven by a claims audit, does touch `public/privacy.html`.) `npm run build` green throughout. No `src/` or `api/` files modified — read only, to verify copy against code.

## Changes (one line each)

1. Records Rescue CTA (`.rescue`, was ~line 1058): `/app/?screen=billing` → `mailto:hello@deepwelltechnology.com?subject=Records%20Rescue%20scanning`, plus a new line "or start your account and buy it under Billing" linking `/app/?screen=billing`.
2. Header nav CTA (~line 414): `#contact` "Get started" → `/app/?plan=solo&interval=month` "Start free trial".
3. Hero: added a mono sub-line under the CTA row — "30-day free trial on Solo, card required, cancel anytime." (new `.hero-trial` CSS rule).
4. Added `#cost` section ("The cost of missing this") directly before `#plans` — two-card breakdown (revenue left on the table; a claim denied because nobody registered) + closing line on the 90-day bell/digest and draft-outreach features. Animates in via the existing `.dw-observe`/`.dw-once` pattern (respects `prefers-reduced-motion` the same way `.step-ic` already does).
5. Ask section (`#demo`) headline/subline: "Ask the way you'd ask a coworker..." → h2 "Ask Donovan." + lede "Every answer shows its source. ..." (kept the original demo instruction text after it).
6. "How it works" (`#how-it-works`) beat 3 copy: "The question is answered from the record..." → "Donovan answers from the record..." — 2 total Donovan mentions on the page, as instructed (max 3).
7. Checked og/meta tags for an "Ask your records" tagline — none exists (current og/twitter copy is "AI answers from your HVAC records" / "One question answered right..."), so nothing to change there.
8. Solo trial badge (`.trial-badge`, "30-day free trial") was already present on the Solo pricing card from a prior round — no change needed, just verified.

## Verification

- `node -e` sanity: 21 total `id`s, **0 duplicates**; every `href="#..."` resolves to a real id; no broken internal hrefs. Full href list checked by hand — all `/app/?plan=X&interval=month` links use valid plan ids (`solo`/`shop`/`crew`/`fleet`, matching `PLAN_CATALOG` in `api/_lib/billing.js`); `/app/?screen=billing` is a valid `screen` value per `src/hooks/useDeepLink.ts`'s `SCREENS` list.
- `npm run build` → exit 0 (only the pre-existing >500KB app-chunk warning, unrelated, inside `src/`).
- Playwright, 1440×900: page height **6,999px** (was ~6,500px per the 2026-09-20 motion handoff → **+470px**, under the ~500px budget). No horizontal overflow at 1440 or 390px. The only console error is the pre-existing `/_vercel/insights/script.js` 404 (expected locally — Vercel serves it dynamically in production; not a regression, matches the prior handoff's own note on this).
- Screenshots saved to `handoffs/site-shots/`: `hero-2026-09-20b.png`, `cost-section-2026-09-20b.png`, `ask-headline-2026-09-20b.png`, `rescue-cta-2026-09-20b.png`.

## `useDeepLink.ts` — what a brand-new visitor actually gets

Read `src/hooks/useDeepLink.ts` in full. `?plan=`/`?interval=` **is** read (`parseDeepLink`, gated by `isValidPlanId`) and applied unconditionally, signed in or not:
`setPendingPlan({plan, interval})` + `setCurrentScreen('billing')`, then the URL is scrubbed. For a brand-new visitor clicking "Start free trial" (`/app/?plan=solo&interval=month`):
1. App.tsx still gates on auth/org first — they see **sign-up**, then **create-shop/org**, same as any cold visitor.
2. `currentScreen: 'billing'` and the pending plan just ride along in the store the whole time (nothing here calls Stripe or redirects early).
3. Once auth + org exist and the app has somewhere to render a screen, it opens directly on **Billing with Solo/monthly preselected** — no dead-end sign-in screen with no context, and no second click to find pricing again.

Same mechanism already applied cleanly to the "Ask about scanning" fallback link (`?screen=billing`, no plan) and to all four pricing-tier CTAs.

## Discrepancy found: "coming in this release" is wrong — the feature already ships

The owner's brief asked for the #cost section to end with "...and can draft the customer's extended-warranty offer email (**coming in this release**)." Checked `src/screens/DashboardScreen.tsx`: an `outreachDraft()` function already exists today — a plain-text (no model call, by design) extended-warranty/maintenance-agreement pitch, copied to the clipboard via a "Draft outreach" button on the attention-items list. **This is shipped, not upcoming.** Per the "copy follows code" rule, the section's closing line was written as "...and drafts the customer's extended-warranty offer email ready to send. Both ship today." instead of promising something already live. Flagging in case the owner meant a *different*, AI-generated version is what's "coming in this release" — if so, the current template-based feature and the copy should be reconciled with product before the next round.

The 90-day expiry watch (bell + daily digest) **is** accurately described as already shipping — confirmed via `WarrantyStatusBadge.tsx` (`expiring-90` state) and `api/_lib/notify.js` (`"expiring-90": "Expires within 90 days"`, digest rendering/dedupe/send logic).

## Trial copy vs. code — verified matching, no discrepancy

Read `api/_lib/billing.js` and `api/billing.js`:
- `PLAN_CATALOG.solo.trialEligible: true`; shop/crew/fleet all `false` → **trial is Solo-only**, matches copy.
- `isTrialEligible()` checks `tenantRow?.trial_used !== true` → **once per shop**, enforced server-side (not stated in the on-page copy itself, since it's a backend fairness rule rather than a customer-facing claim; no discrepancy, just noting it's silent on the page).
- `trial_period_days: 30` + `payment_method_collection: 'always'` → **card required at checkout, 30 days**, matches "card required" in both the hero line and the pricing lede.
- No code path blocks cancellation during or after the trial (standard Stripe subscription + portal) → "cancel anytime" is accurate.
- Net: copy and code agree everywhere checked. No changes needed to the pre-existing pricing-section trial sentence.

## Not touched / explicitly left as-is

- Both founder bios still read "Placeholder bio" (Sterling and Hilton) — owner hasn't supplied real copy yet. Unchanged, flagging again per instructions.
- Pricing-tier "Get started" buttons (Solo/Shop/Crew → `/app/?plan=...`, Fleet → "Contact sales") were already correct from an earlier round; left as-is.

---

## Second pass — claims audit fixes (`handoffs/WEBSITE_CLAIMS_AUDIT_2026-09-20.md` §A, A2, C; C1 ignored as a false positive per coordinator)

`index.html` + `public/privacy.html` only. `src/`/`api/` read-only (to confirm Outreach is real). Build green, 0 duplicate ids, 0 broken anchors, 0 horizontal overflow at 1440/390px throughout.

**New `.pill-soon` style** — dashed-border outline pill (mirrors the existing dashed-border `.src` convention), distinct from the solid-green `.trial-badge` so "not built yet" never looks like "already live."

Tagged "Coming soon" (kept the line, per instructions — did not delete):
- Platform/INGEST: "email intake & folder sync" (drag-and-drop kept untagged — that's real).
- Platform/ASK: "Callbacks" (split out from "Warranty & maintenance dashboards," which stays untagged — those are real) and "CSV, dispatch & accountant export."
- Owner-persona line: "which techs generate callbacks" now reads as a coming-soon clause, not a delivered capability.
- Shop plan spec: "Email intake."
- Crew plan spec: "Google Drive sync," "Branch scoping."

Reworded (not tagged — these were wording problems, not missing features):
- Hero H1 + og:description: "One $300 callback prevented" → "For example, a $300 callback avoided" (illustrative example, not a claim the app tracks/counts callbacks).
- Principle "Built for the job, not the demo": "Works when the signal drops" → "Built for the field: fast on a weak connection" (no offline claim — confirmed zero service-worker/offline code in `src/`).
- `#cost` section closing line: outreach drafting is now **true** — read `handoffs/OUTREACH_2026-09-20.md`: a real Outreach screen drafts the extended-warranty email from the same warranty-tier math as the bell; an admin reviews/approves/sends, or flips it to fully automatic; off by default, enabled per shop. Line now reads "...then drafts the customer's extended-warranty email for an admin to approve and send, or run fully automatic. Both ship today." — dropped "ready to send" (that implied a passive draft; it's an active approve/send or automatic workflow) and dropped "notifies you 90 days out" redundant restatement to keep the line's length in budget.

**privacy.html:** Stripe is live in production (`api/billing.js`, `src/screens/BillingScreen.tsx`) — fixed both stale references: the billing bullet now says Stripe "handles and stores your card details and processes payments directly; DeepWell stores your subscription/billing status and Stripe customer ID, and never your card number" (present tense, matches A2's fix instruction), and the subprocessor table row "Stripe (planned)" → "Stripe." Did **not** add a self-serve "export your data" control — `tenant-export.js` has no in-app UI trigger yet (confirmed), so the existing "contact us" language in the Retention/deletion section was left as-is, per instructions.

**C1 (tenant-delete/tenant-export admin-gating)** — per the coordinator, this is a stale false positive in the audit doc itself (both routes already call `requireRole(auth,'admin')`); no code or copy change made for it.

**Height budget: +0, held.** Text-only edits alone grew the page from 6,999px → 7,085px at 1440px (three list items and two paragraphs each picked up an extra wrapped line once a pill was added). Recovered it with small padding trims — `#platform`/`#who` section padding-block, `.step` padding, `.person` padding — landing at **6,995px** (net **-4px** vs. the pre-second-pass baseline). No copy was cut to hit this; only whitespace.

---

## Third pass — owner review (index.html only)

1. Platform bullets: split "Drag-and-drop upload" (pill removed, real) onto its own line from "Email intake & folder sync" (keeps its pill). "Warranty & maintenance dashboards" — pill and the word "Callbacks" both dropped (bullet just states what's real). "CSV, dispatch & accountant export" → pill removed, reworded to "CSV export for dispatch & accounting" (the app agent is shipping real CSV export this round, per the coordinator).
2. Moved the "Included with every account" white-glove-setup box out of `#platform` into `#plans`, directly under the plan cards, retitled "Included with every plan."
3. New `#where` section ("Where it works") inserted between "Who it's for" and "Pricing": headline "Built for your company. Built to go further."; a "Trade businesses · live today" card (HVAC, plumbing, electrical & more) plus two roadmap cards ("Property management", "Fleet & equipment rental") each tagged with a `Next` pill (same dashed-pill style as "Coming soon", different label). Built on CSS that already existed in the file (`.verts`/`.vert`, `.vert.now`) but had no HTML using it — revived and heavily compacted (padding/font trimmed) to fit the height budget.
4. Records Rescue restructured: headline → "Start with one box." Primary CTA is now a free-demo request (`mailto:hello@deepwelltechnology.com?subject=Records%20Rescue%20demo%20sample`, "Send a sample box — free demo"); the $0.12/page · $500 min full-service line stays, folded together with the existing "buy it under Billing" link.
5. Hero eyebrow "Records that answer back — for HVAC shops" → "Records that answer back." (qualifier dropped, not replaced). Also generalized `<title>`, meta description, and twitter title/description, which all said "your HVAC records" — same drop-the-qualifier treatment, no visual/height impact (head tags only). Full-page scan for other "HVAC"-as-sole-audience copy found only these plus the `#cost` section's brand-citation sentence (Heil/Tempstar/Armstrong Air/etc.), which stays — that's a sourced HVAC example inside a page that no longer claims HVAC-only audience, not a re-statement of the audience itself.
6. Reviewed `#who`'s one "Coming soon" pill (owner-persona "which techs generate callbacks") — callback tracking is still genuinely unbuilt and isn't part of this round's CSV-export work, so it stays tagged. No change.
7. `#cost` section: `(docs/HVAC_WARRANTY_RESEARCH.md)` → `(based on published manufacturer registration windows)`.
8. Founder bios untouched, as instructed.

**Verification:** build green; 22 ids, 0 duplicates; 0 broken `#anchor` hrefs; 0 horizontal overflow at 1440/390px; only console message is the same pre-existing (non-regression) `/_vercel/insights/script.js` 404. Page height 7,092px at 1440px — **+97px** vs. the 6,995px end-of-second-pass baseline, inside the +100px budget. Got there mainly by cutting the new `#where` section from an initial ~225px down to ~113px (tighter section/card padding, folding each roadmap pill onto its heading's line instead of a separate row) plus a small `.onboard` padding/margin trim, since `#platform`'s net footprint actually *shrank* this pass (onboard box moved out, bullets shortened) by more than `#where` and the `#plans` onboard-insert added back combined.
