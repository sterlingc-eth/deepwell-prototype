# Round 23 — M1: mobile fluidity

Owner ask: "mobile users must have great fluidity within the app and
everything works as expected." Walked every mobile flow (launch, Ask, Docs,
Scan, Customers, tab switching, sheets, keyboard, orientation, install,
offline↔online) at 390px/375px, iPhone 13 / iPhone SE / Pixel 7 emulation,
4x CPU throttle, on the real `src/mobile/**` components via
`scripts/mobile-harness/`. Measured with a new Playwright script
(`scripts/verify-mobile-fluidity.mjs`) rather than eyeballing it.

## What I found and fixed

### 1. Ask could crash and lie about why (correctness + "error states that
   dead-end")
Asking anything that had no direct answer but whose tokens happened to match
a document's *filename* (a very ordinary "closest match" case, not an edge
case) crashed `closestDocs()` in `src/domains/hvac/answer.ts`:
`TypeError: Cannot read properties of undefined (reading 'split')` on
`d.preview.split('\n')`, whenever a document had no `preview` yet. `AskTab`'s
catch block treats any `TypeError` as a network failure, so the tech saw
**"Couldn't reach DeepWell. Check your connection and try again."** — a
dead-end that sent them checking their signal for a bug that had nothing to
do with it.
- Fix: `d.preview ?? ''` (two spots) in `closestDocs()` — a document with no
  preview yet is still matchable on its filename, exactly as before, it just
  can't crash the whole answer engine anymore.
- This file is outside `src/mobile/**` (my ownership this round) — it's the
  client-side deterministic mock/demo answer engine used as `AskTab`'s
  default provider, not `api/_lib/**` (confirmed no offline-exam/D1 script
  touches it: `grep -rl "domains/hvac/answer" scripts/*.mjs api/` = none).
  Flagging it here for review since it's a cross-boundary change, but it's a
  minimal, behavior-preserving null-guard (nothing changes except "don't
  crash"), and it directly blocks the Ask flow I was asked to walk.
- Root cause of it going unnoticed: `scripts/mobile-harness/harness-main.tsx`'s
  fixture `Doc` was itself missing the *required* `preview` field — nothing
  catches that statically (`tsconfig.app.json`'s `include` is `["src"]` only;
  `scripts/**` is transpile-only, never type-checked). Added the field to the
  fixture too, and noted why in a comment so it doesn't silently drift back.

### 2. Jank: first date format landing on the tech's first tap (measured, not
   guessed)
`scripts/verify-mobile-fluidity.mjs` flagged one real long task everywhere
except Pixel 7 (iPhone 13: 109ms, iPhone SE: 106ms, budget: 100ms @ 4x CPU) on
**DocSheet's first open**. A CPU profile (`Profiler.start/stop` over the CDP
session) pinned it: `formatDate` (`src/mobile/docUtils.ts`) — 54ms self time
for ONE call. `Date#toLocaleDateString` builds a throwaway
`Intl.DateTimeFormat` every call, and the *first* one anywhere in the page's
life pays a real, one-time ICU init cost (worse under throttling) — landing
squarely on the tech's first DocSheet tap instead of during app boot.
- Fix: one shared `Intl.DateTimeFormat` built at module scope in
  `docUtils.ts` (`DATE_FORMATTER`, reused by `CustomerSheet.tsx`'s warranty
  date too). Because `docUtils.ts` is a static import reachable from
  `MobileApp.tsx`, that one-time cost now happens during the mobile entry's
  own initial parse/eval — before any tap — instead of during the interaction.
- Result: 0 long tasks > 100ms across all three devices, all interactions.

### 3. Harness bug that would have hidden future regressions
`scripts/mobile-harness/Fixtures.tsx`'s `Shell` (the test-only stand-in for
`MobileApp.tsx`, needed because the real one hard-requires a live
`ClerkProvider`) passed plain closures for `openDoc`/`openCustomer`/`setTab`
instead of `useCallback`-memoized ones like the real `MobileApp.tsx` does.
That meant every sheet-open re-created `DocsTab`'s `onOpenDoc` prop identity
every render, defeating `DocRow`'s `React.memo` and re-rendering all 40 rows
on every unrelated state change — inflating the DocSheet-open long task above
with churn the real app doesn't have. Fixed to mirror `MobileApp.tsx` exactly,
so this harness (and any future jank test built on it) measures the real
app's re-render behavior, not the fixture's.

### 4. CLS safety: DocSheet's image preview had no reserved box
`<img>` for a photo document had `max-h-72 object-contain` but no width/height
or aspect-ratio, so its box collapses to 0 height until the image decodes —
a real layout-shift risk on sheet open for any image-type document (the
current fixture only exercises a PDF, so this wasn't caught by the CLS
budget check itself; found by code review, not the harness). Fixed: wrapped
in a fixed `aspect-[4/3]` box that reserves space regardless of the actual
image's dimensions.

## Measurements (before → after)

| Check | Before | After |
|---|---|---|
| Long task > 100ms @ 4x CPU (55 checks across iPhone 13 / SE / Pixel 7) | 2 FAIL (doc-sheet-open, 106–109ms) | 0 FAIL |
| Ask a "closest match" question | crashes → "Couldn't reach DeepWell" (misleading) | renders the real "Closest" no-answer card |
| Mobile entry chunk (`dist/assets/mobile-*.js`, gzip) | 22.44 KB | 22.43 KB (unchanged; budget in the new check is 100 KB) |
| `verify:mobile-ux` (65 checks, pre-existing) | — | 65/65 pass, no regression |
| `verify:offline-queue-ui` (27 checks, pre-existing) | — | 27/27 pass, no regression |
| Offline exam (`EXAM_TODAY=2026-09-25`) | 1220 answered-without-model / 1183 correct / 22 wrong | identical (1220/1183/22 — confirmed re-run; `src/domains/hvac/answer.ts` isn't in this pipeline) |

CLS on answer-render/sheet-open: < 0.05 on all 3 devices, all sheets, both
before and after (never regressed — the finding above was long-task, not
CLS, on DocSheet; the image-CLS fix is a hardening for a case the current
fixture doesn't exercise).

## What I did NOT find broken (walked, passed)
Cold start, Ask type/submit/suggestions/follow-ups/citation tap-through, tab
switching (all 3 tabs stay mounted, state survives), Docs list scroll (40-row
fixture, paginated server-side, `React.memo`'d rows — no virtualization
needed at that page size), DocSheet/CustomerSheet open+close, Filters sheet
open+close, keyboard open/close (tab bar hide, `useKeyboardOpen`), every
input/textarea/select ≥16px font-size (no iOS zoom-on-focus), no horizontal
overflow at 390/375px, zero console errors. Scan's camera/offline queue path
(capture → queue → auto-drain → retry → delete, 413 handling) is already
exhaustively covered by the pre-existing `verify:offline-queue-ui.mjs` (27
checks, re-run above, unchanged) — I didn't duplicate it in the new script.

## New verify script
`scripts/verify-mobile-fluidity.mjs` (`npm run verify:mobile-fluidity-ui`,
*-ui convention, **not** in `verify:all`). Devices: iPhone 13, iPhone SE,
Pixel 7 (Playwright's own `devices`). Per device: 4x CPU throttle via CDP
`Emulation.setCPUThrottlingRate` for the whole interactive walk; "Slow 4G" is
simulated as a 400ms per-response delay on the mocked API routes rather than
a real CDP `Network.emulateNetworkConditions` on the page — that dev-mode
harness serves the app as hundreds of individual unbundled ES module
requests, so throttling the actual transport makes first load take minutes
for a reason that has nothing to do with this app's code (a real regression
there would be invisible under that noise); the doc comment at the top of the
file explains this in full. Cold start's real network cost is instead bounded
by the mobile-entry bundle-size budget check. Asserts, and gates on:
1. No long task > 100ms during any interaction (tab switch, sheet open/close,
   typing, ask submit + answer render, filter sheet, keyboard open/close).
2. CLS < 0.05 on answer render and every sheet open, scoped per-interaction
   (not cumulative session CLS).
3. Mobile entry chunk (`dist/assets/mobile-*.js`) ≤ 100 KB gzip.
4. Zero console errors/pageerrors across the whole walk, every device.
5. Every visible input/textarea/select computes to ≥16px font-size (swept
   live via `getComputedStyle`, not just checking `mobile.css` exists).

Screenshots (launch / answer / DocSheet, all 3 devices) saved to the given
screenshot dir — reviewed, no visual regressions.

## Files touched
- `src/mobile/docUtils.ts` — cached `Intl.DateTimeFormat` (`DATE_FORMATTER`)
- `src/mobile/CustomerSheet.tsx` — reuse `DATE_FORMATTER`
- `src/mobile/DocSheet.tsx` — fixed-aspect box around the image preview
- `src/domains/hvac/answer.ts` — `closestDocs()` null-safety (flagged above,
  outside `src/mobile/**`)
- `scripts/mobile-harness/Fixtures.tsx` — `useCallback` on `Shell`'s handlers
- `scripts/mobile-harness/harness-main.tsx` — fixture `Doc` gets its required
  `preview` field
- `scripts/verify-mobile-fluidity.mjs` — new
- `package.json` — `verify:mobile-fluidity-ui` script (appended only)

## Finishing checklist
`typecheck` clean · `typecheck:api` clean · `oxlint api scripts src` — zero
new warnings (all pre-existing, verified by diffing against a clean run of
just my files) · `build` (`VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy`) clean,
mobile entry unchanged in size · `verify:mobile-fluidity-ui` 55/55 ·
`verify:mobile-ux` 65/65 (no regression) · `verify:offline-queue-ui` 27/27
(no regression) · offline exam unchanged (1220/1183/22, confirmed re-run,
expected since my one server-adjacent change isn't in that pipeline).

## Risks / notes for the lead
- `src/domains/hvac/answer.ts` edit is outside my file ownership — small,
  reviewed, behavior-preserving; revert is a 2-line diff if preferred, but I'd
  recommend keeping it since it fixes a live crash in the Ask flow.
- Sheets have no swipe-to-dismiss drag gesture (tap-outside/X only) — this is
  the existing design, not a regression; noted in case it's wanted later, not
  built this round (no complaint on file, and it's a UX-scope addition rather
  than a fluidity fix).
