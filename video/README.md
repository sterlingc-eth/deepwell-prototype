# DeepWell promo video

60-second promotional video, rendered entirely from code (`promo.html` +
`render.mjs`) so it can be re-rendered whenever the product changes. See
`../handoffs/BRAND_MOTION_C_2026-09-21.md` for the full engineering handoff,
including the refinement pass (v2) that fixed a dead-space complaint on the
first cut.

## Story / scene list

| Time | Scene | Content |
|---|---|---|
| 0–6s | Cold open | Dark. "Where's the serial for the Elm Street unit?" — three places (filing cabinet, shared drive, tech's phone), one question. |
| 6–14s | Logo | The DeepWell rings draw on, center-out. "Records that answer back." |
| 14–30s | Ingestion (Office, dark) | A folder of files drops into the Inbox, the five-stage pipeline counts up (Received → Verified), a document's facts extract into a fact panel, a customer record assembles with a citation chip. |
| 30–44s | Ask Donovan | The bronze-liquid "answer rising" well (ported from `index.html`'s Donovan v3 canvas scene, large — the visual centerpiece of this sequence) reads a typed question (real corpus data: "Is the Whitmore unit still under warranty?"), rises to answer with numbered citation pills, then does the same for a second question ("What refrigerant is in RTU-3 at Desert Ridge Dental?"); an outreach email draft for Whitmore's own expiring warranty appears with "Copy email". |
| 44–52s | Field view (light) | The same answer, on a phone, on the job site — light theme, larger type. |
| 52–60s | Close | Logo, "Knowledge builds business.", plans from $99/mo, deepwelltechnology.com. |

The 15-second cut (`deepwell-promo-15s.mp4`) samples three beats from the
same timeline: the logo draw-on (0–4s), the first full question-and-answer
(4–11.5s), and the closing tagline/URL (11.5–15s) — see `CUT_SEGMENTS` in
`render.mjs`.

## Files

- `promo.html` — the whole video as a deterministic scene timeline. Every
  visual is a pure function of a millisecond timestamp `t`, set by calling
  `window.__seek(t)` from outside — there is no `requestAnimationFrame`
  dependency, so the same `t` always renders the same pixels. Open it
  directly in a browser with `?live=1` appended to the URL to preview it
  playing in real time.
- `render.mjs` — drives a headless Chromium (Playwright) across the
  timeline, screenshots each frame, and encodes with `ffmpeg`.
- `deepwell-promo.mp4` — 1920×1080, 30fps, h264 (crf 18), 60s.
- `deepwell-promo.webm` — same timeline, vp9.
- `deepwell-promo-15s.mp4` — 1920×1080, 30fps, h264, the 15s social cut.
- `poster.jpg` — a still from ~42.5s (Ask Donovan, second answer risen, outreach card visible).
- `deepwell-promo.srt` — caption track (the video also carries a synthesized ambient audio bed — see below — so captions are not the only track, but no dialogue is spoken).
- `promo-contact.png` — a 6×5 contact sheet, one frame every 2s, for reviewing the whole timeline at a glance (`node render.mjs --contact-out <path>` to regenerate elsewhere).

## Audio

Both `.mp4` outputs carry a restrained synthesized ambient bed (no licensed
music, no samples): a low two-tone drone (55Hz/110Hz) with a slow tremolo
LFO, plus a soft 950Hz click every 2 seconds, mixed and brought to roughly
-18 LUFS with `loudnorm`, entirely via ffmpeg's `lavfi`/`aevalsrc` synth
filters (see `synthAmbient()` in `render.mjs`). Pass `--skip-audio` for a
silent render if that's ever preferred.

## Re-rendering

```
node video/render.mjs                 # full 1920x1080, both cuts, contact sheet, audio (~11 min)
node video/render.mjs --sd            # 1280x720 review copy (faster fallback)
node video/render.mjs --skip-cut      # only the 60s video
node video/render.mjs --skip-main     # only the 15s cut
node video/render.mjs --skip-contact  # skip the contact sheet
node video/render.mjs --skip-audio    # silent output
```

If a single `node render.mjs` call risks the shell's own timeout, run the
main video and the 15s cut as two separate calls
(`--skip-cut` then `--skip-main --skip-contact`) — this is exactly what
happened during this pass's render and both halves came out identical to a
one-shot run, since every frame and the audio bed are fully deterministic.

Requires: Playwright's Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and the system
`ffmpeg` (`/usr/bin/ffmpeg` — the Playwright-bundled ffmpeg has no libx264
encoder, matching what Engineer A found for `donovan-v3.mp4`). No new npm
dependencies; `playwright` was already present in `node_modules`.

To change the story: edit the scene markup/CSS and the per-scene
`update*(t)` functions in `promo.html`'s `<script>`, then re-run
`render.mjs`. Scene boundaries live in the `SCENES` array; the well
("answer rising") tuning constants (`BASE_LEVEL`, `RISE_DUR`, `OVERSHOOT`,
sonar `interval`/`dur`) mirror the site's Donovan v3 hero
(`handoffs/BRAND_MOTION_A3_2026-09-21.md`) so the video and the site read
as the same motion language.
