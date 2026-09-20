# Website motion + density pass — 2026-09-20

Single file touched: `/home/claude/work/index.html`. No new dependencies, no ids/anchors/pricing/legal/analytics tags removed. `npm run build` verified green after every round of edits.

## 1. How-it-works animation speed

- Added `--dwflow-dur:9.5s` as a CSS custom property on `:root`.
- `.dwflow-sig` and `.dwflow-glow` now use `animation-duration:var(--dwflow-dur)` instead of the hardcoded `18s`. All keyframe percentages are untouched (they're proportional), so the same beat sequence (record arrives → splits → vault/index → question → answer → back to source) now completes in 9.5s instead of 18s. Change the one variable to retune.
- Verified via Playwright: `getComputedStyle(.dwflow-sig).animationDuration === "9.5s"`.
- `prefers-reduced-motion: reduce` still forces the diagram to a complete static end-state (pre-existing rule, unaffected).

## 2. New animated illustrations (CSS/SVG only, no libraries)

All decorative motion is gated by a single shared IntersectionObserver (`.dw-observe` → toggles `.in-view`; elements marked `.dw-once` keep it once earned instead of re-toggling). Under `prefers-reduced-motion: reduce`, the observer just adds `.in-view` immediately and the page's existing global rule (`*{animation:none!important;transition:none!important}`) removes all motion, leaving each piece in a sensible static frame.

- **Hero**: existing canvas rings already pulse/ripple outward (untouched, working as intended). Added a small inline-SVG "document → arrow → answer" micro-loop next to the eyebrow line (`.hero-micro`), a 4s loop: the document glows, the arrow draws, the answer checkmark lights up, repeat. Reduced motion shows the arrow fully drawn (fixed a bug where it defaulted to its hidden keyframe-start state — see below).
- **Problem section**: new inline-SVG line-art (`.prob-art`) — a leaning stack of pages that cross-fades into a searchable list + magnifying glass, 4s loop, pauses when scrolled off-screen.
- **Platform section**: each of the three steps (INGEST / LINK / ASK) now has a small line-icon that fades/rises in the first time its card scrolls into view (`.step-ic`, one-time reveal via `dw-once`).
- **Demo ("What it feels like")**: clicking a sample question now types it into the input field (~18ms/char, skipped instantly under reduced motion) before the answer renders; the answer, key/value grid and sources then rise in with a short stagger (`.demo-reveal` + `--i` per-row delay).
- **Pricing**: the "Shop · most popular" card gets a single soft diagonal highlight sweep the first time it scrolls into view (`::after`, `animation: ... forwards`, runs once, not distracting).

## 3. Background — third ambient layer

Added `.dw-topo`: a fixed, full-bleed inline SVG dot pattern (`<pattern>`, 28×28 cell, 1px dots) layered under the two existing drift blobs, opacity `.04`, animated only via `transform: translate3d(...)` on a slow 80s linear/alternate cycle (GPU-friendly, no per-frame JS). Disabled under reduced motion alongside the existing blobs.

**Contrast check** (`python3` script sampling the worst-case composited background — both drift blobs at peak overlap, `--muted` text `#A9BBB2`):

| sample | bg (approx) | contrast vs `--muted` |
|---|---|---|
| blobs only (pre-existing) | rgb(37,78,75) | 4.60 : 1 |
| + topo dots, realistic ~0.4% pixel coverage | rgb(38,78,75) | 4.60 : 1 (no measurable change) |

Realistic dot coverage moves contrast by <0.01 — imperceptible. (A synthetic "topo tinted 100% of the area" stress test — which never happens with a dot pattern — dips to ~4.1:1; opacity was already trimmed from .05 to .04 for extra margin against that unrealistic case.) No regression to the pre-existing 4.60:1 floor, which itself was already the site's tightest muted-text contrast before this change.

## 4. Reduced spacing / page height

- `section{padding-block}`: `clamp(48px,6vw,80px)` → `clamp(36px,5vw,64px)` (as specified), plus follow-on tightening of `.sec-head` margins, hero padding, and per-section internal padding/gaps (steps, founder cards, ledger cards, person cards, demo box, plan cards, onboard callout) to actually hit the height target rather than just the one rule.
- Hero-to-first-section gap tightened (`.hero .wrap` padding-block reduced; hero-micro folded inline with the eyebrow instead of stacking a new line).
- How-it-works: `.dwflow-grid` changed `align-items:start` → `center` (diagram and the three numbered steps now sit vertically centered against each other instead of the diagram floating in dead space), and the diagram itself was resized down (`.dwflow-stage` 430px → 300px max-width) since at full size it alone was ~800px tall on desktop — the single biggest contributor to that section's height.
- Principles collapsed into a compact band sitting flush against the footer: 2×2 grid → single 4-across row, icons and copy shrunk, `border-top` removed between it and the footer, padding cut roughly in half. All four principle statements are still present verbatim.
- Also (beyond the literal instructions, needed to hit the ≥20% target without cutting approved copy): heading scale trimmed modestly — `h1` `clamp(2.2rem,4.6vw,3.6rem)`→`clamp(2.1rem,4vw,3.2rem)`, `h2` `clamp(1.9rem,3.6vw,2.8rem)`→`clamp(1.7rem,3vw,2.35rem)`. Same font family/weight/color, just less oversized; several section headlines were wrapping to 3 lines at the old size, which was a real driver of "extra space." No copy removed anywhere.
- No empty spacer divs were found in the source (checked).

**Measured page height** (Playwright, 1920×1080, `document.documentElement.scrollHeight`):

| | height |
|---|---|
| Before | 8190px |
| After | 6529px |
| **Drop** | **20.3%** (target ≥20%) |

## 5. Verification

- `npm run build` — green throughout (tsc -b && vite build), no new warnings introduced.
- Playwright screenshots saved to `/home/claude/work/handoffs/site-shots/`:
  - `deepwell-1440.png`
  - `deepwell-390.png`
- Horizontal overflow at both widths: **0px** (also fixed a pre-existing 49px overflow at 390px width, caused by the footer link row not wrapping — `footer .wrap>div:last-child` is now itself `flex-wrap:wrap`).
- Console: one pre-existing `ERR_FILE_NOT_FOUND` when loaded via `file://` (absolute-path assets like `/favicon.svg`, `/deepwell-logo.jpg`, the Vercel insights script — these resolve fine once served over HTTP by Vite/Vercel from `public/`; confirmed identical on the pre-edit file, not a regression).
- Flow animation: computed `animation-duration` on `.dwflow-sig` = `9.5s`, matching `--dwflow-dur`.
- Reduced motion: `.dwflow-sig`/`.ambient span`/`.dw-topo` all compute `animation-name: none`; found and fixed one gap (the hero micro-loop's arrow defaulted to its hidden keyframe-start stroke-dashoffset under reduced motion) — now forced fully-drawn.
- Functional spot-checks (Playwright): demo typing effect completes and renders the correct answer; platform step icons and the pricing sweep correctly flip to `.in-view` on scroll and stay (`dw-once`); the Problem-section illustration correctly toggles `.in-view` off again when scrolled away (pause-when-off-screen confirmed) and back on when revisited.

## Size

Added CSS + inline SVG markup ≈ 8.7KB (file grew from 63.7KB → 72.4KB). Well under the ~40KB budget and nowhere near the 16MB artifact ceiling.
