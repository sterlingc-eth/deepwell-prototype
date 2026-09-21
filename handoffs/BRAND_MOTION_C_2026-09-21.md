# Brand motion — Section C: promo video (2026-09-21)

**v2 refinement pass** (same day, after coordinator review of v1's frames):
the 33s frame showed a bare app window with an empty ask box and ~80% dead
space. Addressed with a full pass — see "Refinement pass (v2)" below for
what changed; the sections after it describe v1 and mostly still apply
(story beats, palette, motion language) except where v2 superseded them.

Engineer C deliverable from `handoffs/BRAND_MOTION_BRIEF_2026-09-21.md`, built
against the current visual language from `BRAND_MOTION_A3_2026-09-21.md`
(bronze-liquid "answer rising" Donovan, sonar-cadence reading state,
`easeOutExpo` rise / single-hump overshoot / `easeInOutExpo` settle, no
sparkle) and `BRAND_MOTION_B_2026-09-21.md` (fluid `cubic-bezier(.16,1,.3,1)`
motion language, brass/bronze as the only warm accent).

**Owner reference video** (https://x.com/aschapire/status/1559112525614141443/video/1):
tried `WebFetch` once — refused with `ROBOTS_DISALLOWED` (x.com's robots.txt
blocks fetchers). Proceeded without it, on the brief's own motion language
(fluid expo easing, long holds, no bounce) and the two hero handoffs' concept
work instead, per the task's own fallback instruction.

## Refinement pass (v2)

Five changes, all in `video/promo.html` and `video/render.mjs`:

1. **Contact sheet audit.** `render.mjs` now renders a frame every 2s (30
   frames) and tiles them 6×5 into `video/promo-contact.png`
   (`node video/render.mjs --contact-out <path>`, or it's produced
   automatically on every run unless `--skip-contact`). Reviewed the full
   v1 timeline this way and confirmed the fix below — every 2s sample now
   has something landing or in motion; nothing is a bare shell.
2. **The well is now the literal site scene, ported large.** Scene 4's
   small DOM-based liquid mock was replaced with a direct port of
   `index.html`'s actual Donovan v3 canvas code (`dvDrawWall`/`dvDrawLiquid`/
   `dvDrawReflections`/`dvDrawCaustics`/`dvDrawDocs`/`dvDrawRings`/
   `dvDrawMeniscus`/`dvDrawAnswerBar`/`dvRenderScene`/`dvParamsFor` in
   `promo.html`) — same math, palette hardcoded instead of read from CSS
   vars (no live theme to react to here), pointer/dpr/resize/reduced-motion
   handling dropped (fixed 320×320 canvas, driven only by `__seek`). It's
   ~2.7× the old element's size and sits as the literal centerpiece of the
   Ask sequence, animating continuously through idle/reading/rising/
   overshoot/hold. The video's own phase timeline (`buildCycle()`) is
   computed from the actual question strings' lengths, so editing the copy
   retimes the whole cycle automatically.
3. **App scenes tightened + real corpus data.** The app card grew (888→940
   tall) to remove the outer black margin and give the taller well room
   without clipping the outreach card. Scene 3's second panel became a
   genuine multi-row "In this batch" list (matching `IntakeScreen`'s real
   batch/stage-pill structure) using four real customers from
   `test-docs/synthetic/ANSWER_KEY.json`: **Nguyen** (215 N College Ave,
   Tempe — the doc-panel's extraction, using the *exact* corpus filename
   `06-startup-sheet-nguyen.pdf` and serial `F2006123`/Trane
   `4TTR4036L1000AA`), **Castillo**, **Desert Ridge Dental**, and
   **Whitmore** — the same four names the coordinator called out, and the
   same ones the site's own Donovan Q&A loop (`index.html`'s `qa` array)
   already uses, so the video and the site now cite identical facts. Scene
   4's two questions are lifted verbatim from that same `qa` array
   ("Is the Whitmore unit still under warranty?" / "What refrigerant is in
   RTU-3 at Desert Ridge Dental?") and the outreach card pays off Whitmore's
   own answer (60 days from expiry) rather than a generic name.
4. **A typography beat opens every scene.** Added a shared `.headline`
   pattern: build-time word-splitting (`.hw` spans) plus a per-frame
   `updateHeadline()` that staggers each word in (90ms/word, 320ms rise)
   and holds it — "One question. No answer." (S1), the existing tagline
   split the same way (S2/S6), "Nothing falls through." (S3), "Ask
   anything. Get proof." (S4), "Same truth, any device." (S5, replacing the
   old static field-view caption). The S1 cold open also gained a `.dot-tex`
   layer — a CSS radial-gradient dot grid, the promo's equivalent of the
   site's `.dw-topo` pattern (the site's own texture is a dot grid, not
   literal topo lines) — behind the typed quote instead of flat black.
5. **Camera push + two-plane parallax**, all still pure functions of `t`
   (via `applyCam()`): every scene's `.cam-fg` layer scales 1.00→1.04–1.07
   over the scene's duration; scenes 3/4 additionally give their `.cam-bg`
   dot-texture layer a slower 1.00→1.02 scale plus a drifting
   `background-position`, so the app window reads as sitting in front of a
   slower-moving backdrop instead of everything moving as one flat plane.
6. **Ambient audio bed.** Both `.mp4` outputs now carry a synthesized bed —
   a 55/110Hz two-tone drone with a slow tremolo LFO plus a soft 950Hz
   click every 2s, built entirely from ffmpeg `lavfi`/`aevalsrc` filters
   (`synthAmbient()` in `render.mjs`, no samples/licensing exposure),
   limited and `loudnorm`-ed to ≈ -18 LUFS, muxed in as AAC (mp4) / Opus
   (webm). `deepwell-promo.srt` is unchanged and still ships alongside —
   there's no dialogue, so it's not a burden the audio makes redundant.
   `--skip-audio` still produces a silent file if ever wanted.

Re-verified after: zero `pageerror`s on a fresh smoke pass across the whole
timeline (including the fixed clipping check at the old trouble spot,
t=43s), no visual clipping of the outreach card against the taller app
card, and the contact sheet confirms every 2s sample has visible motion or
a landing beat. Full 1080p render (main + 15s cut + contact sheet + audio)
took **≈10m50s** total this pass, split across two `render.mjs` invocations
(`--skip-cut` then `--skip-main --skip-contact`) after the first combined
run hit this session's own 10-minute command timeout mid-way through the
15s cut — noted in the README since it's a re-render caveat, not a bug (all
frames and the audio bed are fully deterministic either way).

## What was built (v1)

Everything lives under `video/`, new, nothing else touched:

- `video/promo.html` — the entire video as one deterministic scene timeline.
  A `#stage` div authored at a fixed 1920×1080 is scaled by `?w=`/`?h=` to
  fill whatever real viewport `render.mjs` opens (so 1080p and a 720p
  review copy share one set of coordinates). Every animated value is
  computed as a pure function of a millisecond timestamp inside
  `window.__seek(t)` — nothing depends on `requestAnimationFrame` or wall
  clock time, so calling `__seek(12345)` twice in a row (or a year apart)
  produces byte-identical pixels. An optional `?live=1` rAF loop exists only
  for manual preview in a real browser; the render path never uses it.
- `video/render.mjs` — headless Chromium (Playwright, already in
  `node_modules` — no new dependency) at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, screenshotting one
  PNG per frame at 30fps by calling `__seek`, then the **system** `ffmpeg`
  (`/usr/bin/ffmpeg`) to encode — the Playwright-bundled ffmpeg has no
  libx264 encoder, the same finding Engineer A recorded for `donovan-v3.mp4`.
- Outputs (all under `video/`): `deepwell-promo.mp4` (1920×1080, 30fps,
  h264 crf 18, 60.0s, AAC ambient bed), `deepwell-promo.webm` (same
  timeline, vp9 + Opus), `deepwell-promo-15s.mp4` (1920×1080, 30fps, h264,
  15.0s social cut, AAC), `poster.jpg`, `deepwell-promo.srt` (caption
  track), `promo-contact.png` (30-frame review sheet), `README.md`
  (story/scene table + re-render commands).

Render performance (v1, silent, no contact sheet): the full 1920×1080
render (1800 main frames + 450 cut frames, screenshot + both encodes) took
**8m47s** in one shot. With the v2 additions (contact sheet + audio
synthesis/muxing) the combined run runs past this session's own 10-minute
per-command limit, so it's split into two invocations — see "Refinement
pass (v2)" above for the exact commands and total time. The 1080p file
remains the primary deliverable; `render.mjs --sd` still exists for a
faster 1280×720 review copy if ever needed.

## Story (kept honest — only what the product does today)

| Time | Scene |
|---|---|
| 0–6s | Dark cold open. "Where's the serial for the Elm Street unit?" — filing cabinet, shared drive, tech's phone: three places, one question. |
| 6–14s | DeepWell's rings draw on (center-out, matching the site's nav-mark reveal). "Records that answer back." |
| 14–30s | Office view (dark), rebuilt from the real `IntakeScreen`/`InboxScreen` chrome: a folder of files drops into the "Add files" dropzone, the five pipeline-stage tiles (Received → Classified → Extracted → Linked → Verified — the exact stage names from `src/core/types.ts`/`StagePill.tsx`) count up, Nguyen's startup sheet extracts into a fact panel, and a lively four-row "In this batch" list fills in with Nguyen/Castillo/Desert Ridge Dental/Whitmore. |
| 30–44s | `AskScreen` recreation, now centered on the large ported Donovan v3 canvas well: "Is the Whitmore unit still under warranty?" types in, the well reads (fixed-cadence sonar rings absorbing into the liquid) and rises to answer (`easeOutExpo` + single-hump overshoot, no bounce) with a `FactGrid`-style numbered bronze citation pill per row; "What refrigerant is in RTU-3 at Desert Ridge Dental?" gets the same treatment; an `OutreachScreen`-style draft card then pays off Whitmore's own 60-days-out warranty with "Copy email" — matching that screen's real copy ("Copy it or open it in your own mail app to send it — no email account needed"). |
| 44–52s | Field view (light theme, larger type, per `src/index.css`'s `.field`/no-`.dark` tokens) on a phone frame: Nguyen's serial lookup, the identical answer, on the job site. |
| 52–60s | Close: logo, "Knowledge builds business." (the real `AppShell` footer line), "Plans from $99/mo" (the real Solo tier price in `index.html`'s pricing section — not the illustrative "$1,500/yr unclaimed" cost-of-inaction figure, which isn't DeepWell's own price), `deepwelltechnology.com`. |

Nothing shown is invented functionality: the pipeline stages, the fact
grid's numbered citation pills, the "Copy email"/"Open in mail" outreach
flow, the Office/Field theme split, and the four-item primary nav
(Ask · Dashboard · Inbox · Records) all match the current app source
(`AppShell.tsx`, `AskScreen.tsx`, `AnswerCard.tsx`, `FactGrid.tsx`,
`IntakeScreen.tsx`, `OutreachScreen.tsx`, `CustomersScreen.tsx`) and the
real pricing/tagline in `index.html`. As of v2, the *data* isn't invented
either — every name, address, serial, model, and Q&A pair in scenes 3–5
comes from `test-docs/synthetic/ANSWER_KEY.json` and `index.html`'s own
Donovan `qa` array, not placeholder text.

## Visual language decisions

- Palette: forest greens for structure/chrome, bronze (`#8C6B3E`/`#A67C52`/
  `#C8A67A`) as the only warm "answer" accent inside the well, brass
  (`#B98A4E`/`#D9B57A`) for citation pills elsewhere in the UI, navy focus
  ring color left unused decoratively (form-only in the real app) — matches
  the brief's "bronze as the only warm accent" instruction for the hero
  motion, brass kept for the app-chrome citation chips exactly as
  `FactGrid.tsx` renders them today.
- Motion: `easeOutExpo` for rises, a closed-form `1 + sin(π·x)·amount`
  single-hump overshoot (never a multi-bounce), `easeInOutExpo` for the
  settle back to idle, a fixed 650ms sonar interval while "reading" — all
  copied in spirit (not code) from `BRAND_MOTION_A3_2026-09-21.md`'s
  `paramsFor`/`liveParams` design, reimplemented natively for this
  timeline rather than reusing the site's IIFE.
- Fonts: the same Google Fonts stack as the site (Newsreader display serif,
  IBM Plex Sans body, IBM Plex Mono labels/data) via the same `<link>`.
- No sparkle: every effect is a flat gradient, a stroked ring, or a solid
  chip — no particles, no glow/flare.

## Validation

- `page.on('pageerror', …)` attached for every render and smoke-test run,
  v1 and v2 — **zero pageerrors** throughout, at both 1280×720 (smoke) and
  the final 1920×1080 renders.
- v2: re-checked the exact spot the coordinator flagged (t=33s) plus the
  whole timeline via `__seek`, including the new taller app card's edges
  (t=43s, where the outreach card had been clipping before the 888→940
  height fix — confirmed clean after).
- v2's `promo-contact.png` (6×5, every 2s) reviewed end-to-end: no frame is
  a bare/empty shell — every sample has the well animating, a counter
  ticking, a row landing, a headline mid-stagger, or a full held beat.
- `ffprobe` confirms `deepwell-promo.mp4` is 1920×1080, 30fps, h264,
  60.000s, AAC audio; `deepwell-promo-15s.mp4` is 1920×1080, 15.000s, AAC.

## Outputs

- `video/promo.html`, `video/render.mjs`, `video/README.md`
- `video/deepwell-promo.mp4`, `video/deepwell-promo.webm`
- `video/deepwell-promo-15s.mp4`
- `video/poster.jpg` (refreshed for v2 — ~42.5s, second Q&A risen + outreach)
- `video/deepwell-promo.srt`
- `video/promo-contact.png` — the 6×5, every-2s contact sheet, also copied
  to `/tmp/claude-0/-home-claude/f16e814e-275c-53e5-82b8-37b855355f08/scratchpad/promo-contact.png`
- 6 representative frames (v2) saved to the scratchpad as
  `promo-frame-{3,9,21,34,42,47}s.png`

## How to re-render

```
node video/render.mjs                 # 1920x1080, both cuts, contact sheet, audio
node video/render.mjs --sd            # 1280x720 review copy — faster fallback
node video/render.mjs --skip-cut      # only the 60s video
node video/render.mjs --skip-main     # only the 15s cut
node video/render.mjs --skip-contact  # skip the contact sheet
node video/render.mjs --skip-audio    # silent output
```

A single combined run took ≈9 min for v1 (silent, no contact sheet); v2's
full combined run (contact sheet + audio synthesis + both cuts) runs past
a 10-minute single-command budget, so it's split as
`node video/render.mjs --skip-cut` then
`node video/render.mjs --skip-main --skip-contact` — ≈10m50s total across
the two calls this pass.

No git, no new npm dependencies (`playwright` was already installed, ffmpeg
synth filters need nothing extra); `api/`, `src/`, and `index.html` were
not touched.
