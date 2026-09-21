# Brand motion — Section A: Donovan v2 (hero + logo animation)

Done. Scope kept to exactly what the brief allowed: the hero canvas script
IIFE, `.well`/`.donovan-*` CSS, the hero `.well` markup, and the nav
`<svg class="mark">`. Nothing else in `index.html` was touched, and
`api/`/`src/` were not touched.

## Changed / added

- `index.html`
  - `:root` (+ dark-mode override + `[data-theme="dark"]`): added
    `--dv-rgb-*` tokens (well/mid/shallow/rim/brass/ink as `r,g,b` triples) so
    the canvas can build theme-aware `rgba()` fills without hardcoding hex.
  - `.well` / `.donovan-*` CSS: reworked for the new markup — Donovan's
    avatar (`.donovan-avatar`, a tiny version of the mark), the source chip
    (`.donovan-src`, pops in with opacity+transform), and the per-message
    rise-in (`.dv-msg.dv-in` / `@keyframes dv-rise`), all gated under
    `prefers-reduced-motion`.
  - Hero `.well` markup: added the Donovan avatar SVG and a source-chip span
    (icon + text) inside the answer row; both rows now carry `.dv-msg`.
  - Nav `<svg class="mark">`: five rings now carry `stroke-dasharray` /
    `stroke-dashoffset` with a self-contained `<style>` block (scoped to this
    element only) defining the draw-on keyframe (staggered 0/.09/.18/.27/.36s,
    500ms each, cubic-bezier(.16,1,.3,1), ~860ms total) and a hover-triggered
    ripple circle (`.dv-ripple`, animates opacity 0.8→0 and r 22→50 on
    `.brand:hover`). Both are pure CSS — no new JS for the logo.
  - The hero scene IIFE (`/* ---- Donovan's mark ... */`) was rewritten in
    full — see "What changed creatively" below.
- `public/logo-animated.svg` — new. Same five-ring mark as a standalone,
  self-contained file: SMIL `<animate>` for the draw-on (portable to
  anything that renders SVG as a document — browser tab, `<object>`,
  Playwright/video capture), plus the same CSS hover-ripple as a bonus for
  contexts that support it (harmless no-op elsewhere, e.g. email clients).

## What changed creatively (the "more advanced and creative" ask)

The old hero was a shaded sphere (radial-gradient ball) with four breathing
ring outlines and a rotating brass sweep arc — the owner's exact complaint.
v2 replaces the whole render with a **well of light seen from above**:

- The entire scene draws inside a single `scale(1, 0.72)` transform, so it
  reads as a squashed shaft/basin, not a ball — the sphere's glossy specular
  highlight is gone, replaced by a floor gradient (bright shallow → dark
  deep) and a soft light-wash along the top of the rim.
- Five concentric rings recede from rim (bright, near) to centre (dim, far),
  each carrying its own slow caustic glint that travels its circumference
  (`globalCompositeOperation:'lighter'`, low alpha) — a refraction cue, not a
  single rotating sweep.
- A field of 14 faint "document" particles (tiny rect + ink-tick fragments)
  idles at the well's edges. On `window.__donovanReading===true` they're
  pulled inward with an ease-in curve and fade as they reach the centre; new
  ones spawn at the rim afterward — the read/ingest metaphor from the brief.
- On the reading→not-reading transition (an answer lands) a single brass
  ring rises from the centre out past the rim once and fades
  (`ripples[]`, ease-out) — the "answer-line rising back out."
- Pointer-reactive: smoothed (lerp) pointer position drives (a) a small
  whole-object lean toward the cursor ("gentle magnetism") and (b) real
  per-ring parallax — rings closer to the rim move more, deeper rings lag —
  via a per-ring `lagX/lagY` translate scaled by `(1-depth)`. Ignored for
  `pointerType==='touch'`.
- Idle breathing: whole well radius pulses ±1.4% (`sin(t*0.5)`), independent
  of and calmer than the reading-state speedup.
- Theme colors are read from the new `--dv-rgb-*` CSS vars once at init and
  re-read only on an actual theme change (`MutationObserver` on
  `data-theme` + a `prefers-color-scheme` listener) — not per frame, which
  is what the old code did for `--brass`.
- Perf/lifecycle: the render loop now pauses via `IntersectionObserver`
  (off-screen) and `visibilitychange` (hidden tab), where the old version
  only paused for `prefers-reduced-motion`. `prefers-reduced-motion` now
  renders one static `render()` call with no listeners at all, and repaints
  once on resize.
- The typed Q/A loop under the hero now: gives Donovan a real avatar (a tiny
  version of the mark, inheriting `currentColor`/brass), separates each
  answer's citation into its own **source chip** ("Startup sheet · p.1",
  "Invoice + nameplate photo", etc.) that pops in after the answer finishes
  typing, and gives each new question/answer row a subtle rise-in
  (`riseIn()` toggles `.dv-in`, restarted per message via a reflow trick).

## Validate (per brief)

Ran with Playwright (`node_modules/playwright`, chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) against
`file:///home/claude/work/index.html`:

- `pageerror` listener: **zero errors** in every state below (dark, light,
  reduced-motion, 375px, 1440px). The only console noise is pre-existing
  `net::ERR_FILE_NOT_FOUND` for absolute-path assets under `file://`
  (favicon/manifest etc.) — unrelated to this change, present before it too,
  and not a `pageerror`.
- Both themes (`data-theme` + `prefers-color-scheme`): confirmed via
  screenshots — palette adapts (rings/well keep their brand greens+brass in
  both; particle "ink" color swaps from the light `--muted` rgb to the dark
  one).
- `prefers-reduced-motion: reduce`: canvas renders a single static frame
  (verified no rAF/pointer/IO listeners attached in this branch), Q/A shows
  the first exchange fully typed with its source chip already shown, caret
  blink and rise-in/chip-pop CSS animations are disabled.
- 375px and 1440px widths: hero stacks correctly at 375px (existing
  `@media (max-width:860px)` rule, untouched), well scene scales cleanly at
  both.
- Nav mark: verified in an isolated harness (extracted just the `<a
  class="brand">` markup) that (a) the draw-on is genuinely mid-animation at
  150ms and fully drawn by ~900ms, staggered centre-out, and (b) hovering
  drives the ripple's computed `opacity` 0.5→~0 while `r` grows 22→50px over
  ~700ms. Confirmed the standalone `public/logo-animated.svg` plays the same
  SMIL draw-on when opened directly (no pageerror).

### Screenshots
`/tmp/claude-0/-home-claude/f16e814e-275c-53e5-82b8-37b855355f08/scratchpad/`:
- `donovan-v2-idle-{dark,light}.png`, `donovan-v2-reading-{dark,light}.png`,
  `donovan-v2-answered-{dark,light}.png`
- `donovan-v2-reduced-motion.png`
- `donovan-v2-375w.png`, `donovan-v2-1440w.png`
- `donovan-v2-navmark-{loading,loaded,hover}.png`
- `before-hero-{dark,light}.png` — the old sphere, for comparison

## Re-render / re-verify

Nothing to "render" ahead of time — it's all live canvas/CSS/SMIL, no build
step. To re-check after a future edit:

```
node -e "require('/home/claude/work/node_modules/playwright')" # sanity
# then open file:///home/claude/work/index.html in Playwright chromium
# (executablePath: /opt/pw-browsers/chromium-1194/chrome-linux/chrome),
# check page.on('pageerror'), and screenshot .hero across themes /
# prefers-reduced-motion / 375-1440px per the brief's Validate list.
```

## Notes for the next engineer (micro-animations, section B)

- I did not touch anything outside the listed scope — no `.hero-copy`,
  `.hero-facts`, `.hero-micro`, or global `<script>` sections beyond the
  Donovan IIFE.
- `window.__donovanReading` is still the public signal other code can read;
  I only added internal edge-detection around it (I did not rename or
  repurpose it).
- The Donovan IIFE is ~11.1KB unminified on its own — worth knowing against
  the shared 40KB budget for all three sections' added JS.
- `.dv-msg`, `.dv-in`, `.dv-rise`, `.dv-r`, `.dv-ripple`, `.dv-rgb-*` are the
  new class/token names I introduced; they're namespaced enough that they
  shouldn't collide with anything section B is likely to add.
