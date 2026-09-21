# Brand motion — Donovan v3: "the answer rising" (2026-09-21)

Owner direction (paraphrased): make the hero scene "the answer rising" for
idle / reading / answered — think creation, not decoration. No sparkle.
Professional, futuristic, business. Green/navy/cream, bronze as the accent.
Motion precise.

## Research (10 min, 4 searches) — techniques used

1. **Liquid level / meniscus rise in a vessel.** GSAP's "Liquid Fill Reveal"
   and the CodeFronts liquid-progress-meter pattern both model a value as a
   rising fill level with a curved highlight where the liquid meets the
   container wall — the mental model for v3's whole scene: the well isn't a
   ball or a badge, it's a vessel with a level.
2. **Sonar/radar concentric-ring cadence.** shadcn's "Sonar Background" and
   the common CSS ripple/ping pattern (`codefronts` ripple set, the
   `leishman` sonar-pinger gist) all use fixed-interval ring emission, not
   randomized pulses — cadence reads as "listening" precisely because it's
   regular. v3's reading-state rings use a hard 650ms interval for exactly
   this reason.
3. **Liquid-metal / restrained specular movement, not sparkle.** The
   Paper/21st.dev "Liquid Metal" shader family and Cult UI's Hero Liquid
   Metal component get a premium, futuristic read from slow, low-contrast
   moving highlight bands on a surface — no particles. v3's caustics are two
   soft, clipped radial-gradient blobs drifting on the liquid disc (navy,
   low alpha, `globalCompositeOperation:'lighter'`), never point sparkles.
4. **Single damped overshoot, no bounce.** Linear/Vercel-style product
   motion (referenced via the "Popular Web Designs" Stripe/Linear/Vercel
   collection) favors a settle with exactly one overshoot hump over an
   elastic multi-bounce. Implemented as a closed-form
   `1 + sin(pi·x)·amount` — one hump by construction, never repeats.
5. **Expo/cubic-bezier(0.16,1,0.3,1)-family easing throughout**, long holds,
   no linear motion — the brief's own instruction, confirmed as the house
   style across the referenced sites; used for the rise (`easeOutExpo`) and
   the return-to-idle (`easeInOutExpo`).

Sources: reallygooddesigns.com/web-design-trends-2026,
awwwards.com (hero-animation inspiration), 21st.dev (liquid-metal-stripes),
cult-ui.com/docs/components/hero-liquid-metal, shadcn.io/background/sonar,
codefronts.com (ripple + liquid-fill component sets).

## Concept

The hero canvas is now a **well seen from above containing a bronze liquid**,
not a badge or a sphere:

- **Idle** — the liquid sits low (34% of the well's radius) and calm; the
  whole well breathes (±1% radius, slow sine); a single faint ring
  occasionally descends from the rim into the liquid and is absorbed (every
  ~7s) — Donovan listening.
- **Reading** — sonar rings descend from the rim on a fixed 650ms cadence,
  absorbed into the liquid on contact; the liquid surface gets a small
  deterministic stir-wobble; eight document fragments (thin rectangles)
  sink from the rim toward the liquid on a staggered, repeating schedule and
  dissolve the instant they touch it.
- **Answered** — the liquid rises cleanly to the rim (`easeOutExpo`, 500ms),
  overshoots once by 4.5% (`sin(pi·x)`, 250ms, no bounce), settles; a cream
  meniscus ring appears at the liquid/rim boundary as it nears the top; a
  single crisp bronze line lifts out of the centre and holds for the
  `window.__donovanAnswered` window (~1.2s); then everything eases back to
  idle over 4s (`easeInOutExpo`).

Palette used **only in this scene**: greens for the well's structure and the
sonar rings (existing `--dv-rgb-well/mid/rim`), bronze for the liquid itself
and the answer line (new `--dv-bronze[-mid/-hi]` / `--dv-rgb-bronze*`, e.g.
`#8C6B3E` / `#A67C52` / `#C8A67A` — replacing `--brass` in the Donovan
avatar dot and caret too, so the whole scene reads bronze, not brass), navy
for faint surface caustics (new `--dv-rgb-navy`, `#123D6B`), cream for the
meniscus highlight (new `--dv-rgb-cream`, `≈#F4EBDD`). No particles, no
glow/flare — every surface effect is a flat gradient or a thin stroked ring.

**No sparkle check:** the only "small dot" elements are the 8 document
fragments (flat 6×8px rectangles, opacity ≤0.45, deterministic positions)
and the ring strokes — nothing twinkles, nothing is additive-blended except
the two caustic blobs (soft, large, low-alpha).

## Determinism (why it's exactly reproducible)

Every visual value is a **pure function of elapsed phase time** —
`paramsFor(phase, elapsedMs)` — with no mutable particle/ripple arrays.
Rings and document fragments use a stateless "which repetition am I in"
formula (`Math.floor(elapsed/interval)`) instead of push/splice queues. That
made `window.__donovanSeek(ms)` trivial: it just walks the same fixed phase
durations (`reading 2000 / rising 500 / overshoot 250 / hold 1200 / settle
4000`) and calls the identical render path the live loop uses — so the seek
preview and the live behaviour can never visually diverge.

## Files changed

- `index.html`
  - `:root`: added `--dv-bronze`, `--dv-bronze-mid`, `--dv-bronze-hi` and
    their `--dv-rgb-*` triples, plus `--dv-rgb-navy` and `--dv-rgb-cream`.
    Constant across themes (this accent doesn't shift with light/dark).
  - `.donovan-who-d` and `#donovan-a::after` (caret): now `var(--dv-bronze)`
    instead of `var(--brass)` — the only two brass references inside the
    Donovan scene; the site's global `--brass` token is untouched.
  - The hero scene IIFE (`/* ---- Donovan's mark v3: ... */`, ~14.6KB
    unminified, well under the 18KB budget): fully rewritten per the concept
    above. Declares `window.__donovanAnswered=false` alongside the existing
    `window.__donovanReading=false`, adds `window.__donovanSeek(ms)`.
  - The typed Q/A loop: minimal edit — after the answer finishes typing, sets
    `window.__donovanAnswered=true`, waits 1200ms, sets it back to `false`,
    then keeps the same 4200ms pause before the next question (long enough
    for the 4s ease-back to fully finish before the next "reading" begins).
    Nothing else in the loop changed; Q/A block, avatar and source chip are
    untouched.
- Nothing outside the hero `.well` scene, `.donovan-*` CSS and the listed
  `:root` tokens was touched. `api/`/`src/` untouched. No new dependencies.

## Validate

Playwright (`node_modules/playwright`, chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) against
`file:///home/claude/work/index.html`, `pageerror` listener attached:

- **Zero pageerrors** in every run below.
- Dark + light themes, both idle/reading/answered states (state confirmed
  via `window.__donovanReading`/`__donovanAnswered` read back before each
  screenshot, not just a timed guess).
- `prefers-reduced-motion: reduce` (Playwright `reducedMotion: 'reduce'`
  context option): renders one static `renderScene` call, no rAF/pointer/IO
  listeners attached.
- 375px and 1440px viewport widths.
- Scene code size: 14,577 bytes unminified (18KB budget).

### Screenshots
`/tmp/claude-0/-home-claude/f16e814e-275c-53e5-82b8-37b855355f08/scratchpad/`:
- `donovan-v3-idle-{dark,light}.png`
- `donovan-v3-reading-{dark,light}.png`
- `donovan-v3-answered-{dark,light}.png`
- `donovan-v3-reduced-motion.png`
- `donovan-v3-375w.png`, `donovan-v3-1440w.png`
- `donovan-v3-before-dark.png` — the v2 hero, for comparison

### Video
`donovan-v3.mp4` — a deterministic 6s/30fps (180 frame) capture of the
reading → rising → overshoot → hold → settle sequence, produced by calling
`window.__donovanSeek(ms)` for `ms = 0, 33, 67, … 5967` and screenshotting
`#well` at each step, then encoded with the system `/usr/bin/ffmpeg`
(h264, crf 18, even-dimension scale filter — the Playwright-bundled ffmpeg
build has no libx264 encoder, so the system one was used instead). Frame
PNGs are in `scratchpad/frames/` if a different codec/cut is wanted later.

## Refinement pass (owner critique on the v3 stills)

Same scope/constraints, five fixes:

1. **Answered no longer fills the whole ellipse.** `LIQUID_MAX=0.90` caps the
   liquid radius at 90% of the rim regardless of `level`, so the green wall
   always stays visible as a lip. The wall (`drawWall`) is now a directional
   linear gradient (lit upper-left / darker lower-right) clipped to the
   liquid↔rim annulus, not a flat radial fill, and an inner-shadow gradient
   sits just inside the liquid edge where it meets the wall.
2. **Bronze re-based.** `#A67C52` (was the "mid" tone) is now the dominant
   fill color; `#8C6B3E` is only the darker edge/shadow tone; the highlight
   is an offset radial gradient centered upper-left (a lit surface), not a
   centered glow. Added faint concentric surface reflections
   (`drawReflections`) and reshaped the navy caustics into flattened,
   rotated "bands" (`ctx.scale(1,0.3)` on the gradient) instead of round
   blobs. Meniscus stroke trimmed to 1.3px, alpha capped at 0.75.
3. **The answer is now a horizontal bar**, not a hairline. `drawAnswerBar`
   draws a 2px, `Rb*0.8`-wide bronze/cream bar with a soft (non-sparkly)
   underline glow, rising from the rim into dedicated headroom above it
   with `easeOutExpo` (decelerating), holding while lifted, then receding
   with the liquid. `renderScene` now reserves that headroom explicitly:
   `HEADROOM=0.12` of canvas height, with `cy` computed from `topMargin` so
   the rim's top edge is pinned exactly there every frame (previously `cy`
   was just `h/2` and the old vertical line frequently drew off-canvas —
   that was the "not legible" bug).
   Both `renderScene`'s and `__donovanSeek`'s and the live loop's calls were
   unaffected structurally — only the drawing functions changed.
4. **Reading rings/fragments**: cadence was already 650ms; fragments are
   now explicitly tied to that same cadence loop (`drawDocs` reuses the
   ring's `INTERVAL=0.65` cycle math) and spawn only 2 per cycle instead of
   an 8-fragment continuous stream.
5. **Light-theme rim bleed fixed.** The rim light-wash stroke previously
   extended slightly past the well's outer radius (`Rb*1.07` at its widest),
   bleeding a soft green wash onto the page background — barely visible on
   the dark theme's near-black ground, more noticeable as a washed-out edge
   on the light theme's cream ground. It's now clipped to `arc(0,0,Rb)`
   before stroking, so nothing ever paints outside the well's own disc.

Re-validated: 0 pageerrors across dark/light/reduced-motion/375px/1440px.
Scene code: 17,130 bytes unminified (still under the 18KB budget).

New screenshots (same paths, overwritten) + a re-rendered `donovan-v3.mp4`
in `scratchpad/`.

## How to tune

- **Idle liquid level / calm-ness**: `BASE_LEVEL` (0.34) and the idle
  `breath` amplitude (`Math.sin(t*0.5)*0.01`) in `renderScene`.
- **Sonar cadence / feel**: `INTERVAL`/`DUR` inside `drawRings` (reading:
  0.65s/0.9s; idle: 7s/2.6s).
- **Rise/overshoot timing**: `RISE_DUR`, `OVER_DUR`, `OVERSHOOT` constants
  near the top of the IIFE. Overshoot shape is `1 + sin(π·x)·OVERSHOOT` —
  raising `OVERSHOOT` makes the bulge more visible; it will always be a
  single hump, never a bounce, by construction.
- **Hold length**: currently tied to how long the Q/A loop keeps
  `window.__donovanAnswered` true (1200ms, set in the loop). Change both the
  loop's `wait(1200)` and, if a longer visual hold under `paramsFor('hold', …)`
  is wanted independent of the flag, extend the safety logic in `liveParams`.
- **Ease-back duration**: the `4000` in `paramsFor('settle', …)`. The Q/A
  loop's trailing `wait(4200)` should stay ≥ this so the next "reading"
  never interrupts an in-progress ease-back.
- **Palette**: the six `--dv-*` tokens added to `:root`. Bronze/navy/cream
  are theme-constant by design (an "answer accent" shouldn't shift with the
  page theme) — add dark-mode overrides only if that's wanted later.
- **Re-render the video**: re-run the two-step Playwright(`__donovanSeek`
  frame capture) → `ffmpeg` process described above; no state to reset
  between runs since every frame is fully determined by its `ms` argument.
