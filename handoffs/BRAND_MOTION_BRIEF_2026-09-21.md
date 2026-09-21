# Brand motion brief — Donovan v2, micro-animations, logo, promo video (2026-09-21)

Owner feedback on the first Donovan pass (a shaded sphere with brass rings + typed
Q/A under it): "I like the attempt. I'd need something more advanced and creative."
Reference for motion quality: https://reactbits.dev/c/micro (micro-interactions:
magnetic buttons, split-text reveals, count-up numbers, shiny/hover text, cursor
glow, scroll reveals, marquee, spotlight cards).

Brand: DeepWell Technology. Mark = concentric rings (a well seen from above).
Palette: forest greens (#163C2C well, #245239, #3A6B4D, #5A8C6C, #86AE93,
#9DC4B2 light accent), brass (#B98A4E, #D9B57A, #E8D1A8), navy focus (#123D6B),
stone neutrals. Fonts already loaded on the site: a serif display (headline),
IBM Plex Mono for labels. Tone: quiet, precise, trade-professional. Never
cartoonish, never "AI sparkles". Donovan is the AI that reads a shop's records
and answers with the page it came from.

Site is a single static `index.html` (vanilla JS, no framework, no build step,
~1400 lines) with `public/` assets. The app (`src/`, React) has its own
DonovanMark (src/components/DonovanMark.tsx) — the owner is happy with that
one; this brief is the WEBSITE + video.

## Deliverables (three parallel engineers, one reviewer)

### A. Donovan v2 for the website hero + logo animation
Replace the hero `<canvas id="well">` scene with something that reads as a
presence with depth and intent, not a badge:
- Canvas 2D or WebGL (raw, no library). Ideas that fit the brand: a well of
  concentric light seen from above with real parallax depth (rings recede,
  respond to pointer tilt); a field of faint "document" particles (small
  rectangles / glyph fragments) drifting at the edges that get drawn into the
  well while Donovan reads, and a single brass answer-line rising back out;
  subtle refraction/caustic shimmer on the rings; a slow idle breath.
- States driven by `window.__donovanReading` (already used by the typed Q/A
  loop): idle / reading / answered, with distinct motion in each.
- Pointer-reactive (tilt/parallax, gentle magnetism), touch-safe, DPR-aware,
  60fps on a mid laptop, pauses off-screen and when the tab is hidden,
  static single frame under prefers-reduced-motion. Light AND dark theme
  (site has `[data-theme]` + prefers-color-scheme; read CSS vars).
- Logo animation: the nav `<svg class="mark">` rings draw on at load (stroke
  dashoffset, staggered from the centre out, ~900ms, once) and ripple once on
  hover; also export the same as a standalone `public/logo-animated.svg`
  (SMIL or CSS inside the SVG) for use elsewhere (email signature, video).
- Keep the typed Q/A loop under the hero, but restyle it as a real exchange
  (avatar dot for Donovan = a tiny version of the mark, subtle rise-in per
  message, source chip "Startup sheet · p.1" that pops in after the answer).

### B. Micro-animations across the site (reactbits-style, vanilla)
Implement in `index.html` (a `<script>` block + CSS), no dependencies, all
behind `prefers-reduced-motion`, IntersectionObserver-driven, no layout shift:
- Headline: split-text reveal (words rise/fade with 30ms stagger) on first paint.
- Scroll reveal for every section header + card (fade + 12px rise, once).
- Stats ("< 3 s", "< 5 min", "100%", the cost section numbers): count-up when
  scrolled into view; keep the exact final strings.
- Buttons (primary CTAs): magnetic hover (translate toward pointer ≤ 6px) +
  press scale; secondary: underline grow.
- Cards (platform / who-it's-for / pricing): spotlight hover (radial highlight
  following the pointer) + 2px lift; pricing "Included with every plan" ticks
  draw on when revealed.
- A slow marquee of document types ("Invoices · Warranty cards · Nameplate
  photos · Startup sheets · Permits · Dispatch notes …") somewhere it earns
  its place (e.g. under "Ingest everything").
- Cursor glow on the dark hero only (soft radial follow, 200ms lag), off on touch.
- Nav: active-section indicator that slides between links on scroll.
- Everything must degrade to the current static page with JS off.

### C. Promotional video (45–60 s, 1920×1080, MP4 + WebM + poster)
Rendered entirely from code so it can be re-rendered when the product changes:
- Build `video/promo.html`: a timeline of scenes as absolutely positioned
  layers with CSS/canvas animation driven by a single `t` (ms) you set from
  outside (`window.__seek(t)` renders frame at t deterministically — no
  requestAnimationFrame timing dependence).
- Capture with Playwright (node_modules/playwright, chromium at
  /opt/pw-browsers/chromium) at 30 fps → PNG frames → ffmpeg (installed) →
  `video/deepwell-promo.mp4` (h264, crf 18) + `.webm` (vp9) + `poster.jpg`.
  Script: `video/render.mjs` (`node video/render.mjs` does everything).
- Story (tighten as needed; keep it honest — nothing the product can't do):
  0–6s   Dark. A phone rings in a shop office (sound optional — deliver silent
         with a caption track; a `.srt` alongside). Text: "Where's the serial
         for the Elm Street unit?" Filing cabinet, shared drive, tech's phone
         — three places, one question.
  6–14s  The DeepWell logo rings draw on. "Records that answer back."
  14–30s The app, real screens rebuilt in HTML from the actual UI (Office
         view dark): drag a box of PDFs in → Inbox fills → a document opens
         with facts extracted → customer card assembles (name, address,
         units) → citations chips.
  30–44s Ask Donovan: question typed, Donovan mark reads, answer lands with
         "Startup sheet · p.1" chip; second question about a warranty
         expiring; Outreach draft appears with Copy email.
  44–52s Field view (light) on a phone frame: the same answer on a job site.
  52–60s "Knowledge builds business." Pricing line, URL, logo.
- Motion language: fluid easing (cubic-bezier(0.16,1,0.3,1)), long holds,
  no bounce, brass as the only warm accent. Use the site's fonts (link Google
  Fonts or reuse the site's font links).
- Also deliver a 15 s cut (`deepwell-promo-15s.mp4`) for social: logo → one
  Q/A → URL.

### Constraints for all three
- No git. No new npm dependencies. Do not touch `api/` or `src/` (the app);
  this is `index.html`, `public/`, and a new `video/` folder.
- `index.html` must remain a single file that works from `file://` and on
  Vercel; total added JS ≤ 40 KB unminified; no external scripts.
- Validate: load `index.html` in Playwright (pageerror = fail), both themes,
  reduced-motion, 375px and 1440px widths; screenshot each state to
  `/tmp/claude-0/.../scratchpad/` for the reviewer.
- Write a short handoff `handoffs/BRAND_MOTION_<A|B|C>_2026-09-21.md` listing
  changed/added paths and how to re-render.
