# M0 Build Summary — Truth & polish

**Repo:** `deepwell-app` · **Commit:** `c702268` "M0: field mode, accessibility, string lint, focus traps" (on top of `63d6f77` Ask interface build)
**Date:** September 12, 2026 · **Gate status:** all 9 gates green (build, eval 50/50, string lint, e2e 10/10, field-mode check 14/14 combos, 390 px no horizontal scroll, keyboard, bundle, motion)

## What shipped

| REQ | Before | After | Evidence |
|---|---|---|---|
| ASK-11 No "AI" in the UI | PARTIAL (dead screen + "(simulated)") | SHIPPED | `scripts/string-lint.mjs` runs first in `npm run build`; fails on AI / LLM / Claude / simulated / vendor names in `src/**` rendered strings. `SerialCapture.tsx` copy is now "Tap to read the nameplate" / "Reading…" / "Read again". |
| ASK-12 Keyboard-only | PARTIAL (no focus trap) | SHIPPED | `src/components/useFocusTrap.ts` (`useFocusTrap(active, ref, {initialFocus, onEscape, restoreFocus})`) used by `DocumentPreview.tsx` and `SerialCapture.tsx`; focus restored on close; Enter submits during loading. |
| PLT-06 Labeled demo | MISSING | SHIPPED (interim) | `AppShell.tsx` banner `role="status"`: "Sample company · demo data · resets on reload". Stays until M3 accounts. |
| FLD-01 Field mode ≥18 px / ≥48 px | PARTIAL | SHIPPED | `index.css` `html.dark` overrides: body 18/28, caption/label/data 16/24, headings 24/32, global button/input/select `min-height: 48px`, checkbox 24 px. Dashboard warranty table and Records completeness table become stacked cards below `sm`; Intake pipeline wraps. `scripts/field-mode-check.mjs` walks 7 screens × 2 modes at 390 px and fails on any text < 18 px or target < 48 px in field mode, or any horizontal overflow. |
| FLD-03 Motion | SHIPPED | SHIPPED | page transition 240 ms (`tailwind.config.ts`), reduced-motion respected. |
| A11Y-02 / A11Y-04 | — | SHIPPED (partial toward WCAG AA) | `AnswerCard.tsx` sr-only `role=status aria-live=polite` announcement when an answer lands; every icon-only control has an `aria-label`; live regions on banner/ticker. Full axe run is an M1 CI item. |
| BR-02 Fonts | MISSING in old repo | SHIPPED | Newsreader + IBM Plex Sans/Mono loaded in `index.html`; brand tokens in `tailwind.config.ts`. |
| BR-05 Dead code | MISSING | SHIPPED | The seven unrouted screens, `searchService.ts`, `react-router-dom`, framer-motion are not in `deepwell-app`. |
| QA-04 (string lint gate) | — | SHIPPED | see ASK-11. |

## Known, accepted for M0

- Banner is not sticky — fine, it is on every screen's first viewport.
- `SerialCapture` still returns a seeded serial (real capture is M4 CAM-01/02). Keep the camera button off the external demo until then, per the traceability doc.
- Header nav spacing at 390 px is the physical minimum (4 px gaps, 48 px targets).
- The claim-packet PDF preview (lazy-loaded jspdf/html2canvas) is not covered by the field-mode check; it is an office task.
- "model" is allowed by the string lint because it is the equipment model number everywhere it appears.

## Commands

```
npm run build          # string-lint → tsc -b → vite
npm run eval           # 50/50 mock
node scripts/e2e.mjs   # Playwright, after build + vite preview
node scripts/field-mode-check.mjs
```

## Next: M1 — Real Ask

Retrieval-first streaming `/api/ask` with guard rails (ASK_ENABLED off by default, origin allow-list, per-IP and daily caps, 8 s timeout, 600 max_tokens), prose-to-facts validator, closest docs + unverified count on the real provider, real document viewer with field highlight, eval against the real provider with a ≥95% gate, CI. Summary will land in `claude/M1_BUILD_SUMMARY.md`.
