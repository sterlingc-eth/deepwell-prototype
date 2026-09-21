# Brand motion — Section B: micro-animations (2026-09-21)

Engineer B deliverable from `handoffs/BRAND_MOTION_BRIEF_2026-09-21.md`. Calibrated
feel against https://reactbits.dev/c/micro (fetched once; page is JS-rendered so
only metadata came back — used the brief's own motion language instead: fluid
`cubic-bezier(.16,1,.3,1)` easing, small/subtle magnitudes, no bounce). No code
copied, no dependencies added.

Everything lives in `index.html` only, in clearly-labeled new blocks:
- New `<style>` block in `<head>`, right after the existing closing `</style>`
  (search `MICRO-ANIMATIONS — ENGINEER B`).
- A `<noscript>` fallback right after it (see "JS-off" below).
- New `<script>` block right after the existing closing `</script>` near the
  end of `<body>`, before the Vercel analytics snippet (same search string).
- A handful of `class="..."` additions on existing elements (see below) and
  two small markup insertions (marquee, pricing ticks).

**Not touched, as instructed:** the hero Donovan canvas IIFE, `.well` /
`.donovan-*` CSS, any `--dv-*` token, the nav `<svg class="mark">`, and the
existing generic reveal IIFE (`document.querySelectorAll('.dw-observe')` /
`.in-view`) — that one is reused, not modified (see below).

## What was added, and where

1. **Headline split-text reveal** — hero `<h1>` got `class="mm-headline"`.
   JS (`<script>` block, section 2) walks its child nodes on first paint and
   wraps each word in a `<span class="mm-word">` with `--mm-i` as its index;
   CSS animates each in with a 30ms-per-word stagger. Skipped entirely under
   reduced motion (JS never runs, plain text shows immediately — zero risk of
   a stuck `opacity:0`).

2. **Scroll reveal for every section header + card** — extends the site's
   *existing* fade+12px-rise pattern (already used by `.cost-card` /
   `.plan.featured`) to everything that didn't have it yet: all `.sec-head`
   elements, `.person`, `.vert`, `.founder`, `.plan` (the 3 non-featured
   tiers), `.principle`. Done by adding `dw-observe dw-once` to their class
   lists in the HTML — the pre-existing IntersectionObserver near the end of
   the file (unmodified) drives all of it, plus new nth-child stagger delays
   in CSS section 1.

3. **Stat count-up** — `.hero-facts .fact b` ("< 3 s", "< 5 min", "100%") and
   `.cost-total b` ("$1,500/yr") count up from 0 on first intersection
   (900ms, ease-out-cubic). The exact original string is restored verbatim on
   the last frame, so final content is byte-identical to before. Width is
   locked (`min-width`) for the animation's duration to guarantee no shift.

4. **Magnetic primary buttons + underline-grow secondary** — every
   `.btn-primary` translates ≤6px toward the pointer via a JS-set
   `--mm-tx/--mm-ty` pair (fine-pointer devices only); press-scale is pure
   CSS `:active`, no JS. Every `.btn-ghost` gets a CSS-only underline that
   grows from the left on hover/focus.

5. **Spotlight cards** — `.step` (platform), `.person` (who-it's-for) and
   `.plan` (pricing) get a radial highlight that follows the pointer
   (`--mm-x/--mm-y`, brass via `color-mix()`, so it always tracks the site's
   accent token rather than a hardcoded color) plus a 2px lift, both on
   hover and `:focus-within`. Touch/keyboard/reduced-motion still get a
   plain centered highlight (the custom properties default to 50%/50%).

6. **Document-type marquee** — new markup under the "Ingest everything"
   heading in `#platform`, before the three ingest/link/ask cards: a looping
   `Invoices · Warranty cards · Nameplate photos · Startup sheets · Permits ·
   Dispatch notes · Work orders · Service tickets` strip, masked at both
   edges. Pure CSS animation, gated behind the same `dw-observe`/`in-view`
   mechanism as the rest of the site's looping decorative animations (so it
   pauses off-screen and never plays under reduced motion or JS-off).

7. **Cursor glow, dark hero only** — a JS-created `.mm-glow` div, confined to
   `.hero-copy` (never the well/canvas column, so it can't sit over
   Engineer A's Donovan scene), with a 200ms-lag lerp follow. Only active
   when the effective theme is dark (checks `data-theme`, falling back to
   `prefers-color-scheme`) and only on fine-pointer devices.

8. **Nav active-section indicator** — a thin sliding bar (`.mm-nav-ind`,
   JS-created) under `.navlinks` that tracks whichever of Problem / Platform
   / What it feels like / Who it's for / Pricing is centered in the
   viewport, via one small IntersectionObserver.

9. **"Included with every plan" ticks** — the existing paragraph is kept
   as-is; a new `<ul class="mm-ticks">` under it restates its four points as
   a checklist whose checkmarks draw on (`stroke-dashoffset`) once revealed.

## Guarantees checked

- **Reduced motion**: everything CSS-only rides the site's existing global
  `@media (prefers-reduced-motion:reduce){*{animation:none!important;
  transition:none!important}}` reset. Everything JS-driven (split-text,
  count-up, magnetic, spotlight-follow, cursor glow) additionally checks
  `matchMedia('(prefers-reduced-motion: reduce)')` up front and no-ops.
- **JS-off = current static page**: the new `<noscript>` block resets
  `opacity`/`transform` to visible/neutral for every element this reveal
  system touches (including the pre-existing `.cost-card`, which had the
  same latent JS-off issue before this change). The marquee simply stays
  static (no scroll) without JS — consistent with how the site already
  freezes its other decorative loop animations when JS is off.
- **No layout shift**: only `opacity`/`transform` are animated, never
  box-affecting properties; the marquee and ticks are static markup present
  at first paint (not injected after load); count-up locks `min-width` for
  its duration.
- **IntersectionObserver-driven**: reveal, count-up, marquee, and ticks are
  all observer-gated; nothing runs purely on scroll-position polling.
- **Size**: the new `<script>` block is ~8.3 KB unminified (well under the
  25 KB budget); no external scripts, no dependencies.

## Validation (Playwright, chromium at `/opt/pw-browsers/chromium-1194`)

Ran `index.html` via `file://` across dark/light × 1440px/375px, plus a
reduced-motion pass on both theme/width combos — **zero `pageerror` events in
every run.** (Two unrelated, pre-existing `console.error` network 404s show up
in every run — `/favicon.svg` and `/_vercel/insights/script.js` — both are
absolute-path references that always fail under `file://` regardless of this
change; not caused by this work.)

Screenshots (in the scratchpad, per the task):
- `micro-headline-midreveal.png` — split-text headline mid-stagger (later
  words still fading up) + the "100%" stat mid-count-up, captured by
  deterministically pausing each word's Web Animation at `currentTime:220ms`
  (avoids a headless-rendering race where CSS animations stay pending until
  a frame is actually produced).
- `micro-spotlight-hover.png` — the first platform card with the pointer
  moved across it, showing the radial highlight.
- `micro-countup-midway.png` — the cost section's `$1,500/yr` total mid-count
  (captured at "$1,494/yr").

## How to tune

- Stagger speed: `--mm-i` step is fixed at 30ms/word in the
  `mm-word-rise` animation-delay `calc()` (CSS section 2).
- Reveal distance/duration: `translateY(12px)` / `.6s` in CSS section 1;
  per-card stagger via the `nth-child` delay rules right below it.
- Count-up duration/easing: `dur = 900` and the cubic ease in script
  section 3.
- Magnetic strength: `MAX = 6` (px) in script section 4.
- Spotlight radius/intensity: the `220px circle` / `color-mix(... 16% ...)`
  in CSS section 3.
- Marquee speed/content: `34s` loop in CSS section 6; the document-type list
  is duplicated once in the HTML for a seamless loop — edit both copies to
  change the list.
- Cursor glow size/lag/color: `280px` size and `0.18` lerp factor in script
  section 7; intensity via `color-mix(... 22% ...)` in CSS section 7.
