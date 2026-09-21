# DeepWell — Apple-style 60s promo storyboard (2026-09-21)

A hybrid cut: real HVAC-world footage generated with an AI video tool,
inter-cut with the product UI we already render from code
(`video/promo.html` / `video/render.mjs` — scene ids `s1`–`s6`, see
`video/README.md`). Apple-style means: quiet, confident, one idea per shot,
natural light, no on-screen text or logos inside the live-action footage
(the wordmark only ever appears in the code-rendered shots, which already
draw it correctly), and no hype adjectives in the voice-over.

Every product claim below (upload → extraction → cited answers, warranty
lookups, outreach drafts, phone-in-the-field) is something the app does
today — nothing here is aspirational.

## Shot list

**Shot 1 — 0:00–0:05 (5s) · AI-generated**
- On screen: Wide establishing shot, rooftop HVAC condenser unit, golden-hour side light, long shadows. A technician (seen from a distance/behind) walks toward the unit.
- Camera: Slow push-in, handheld-smooth (gimbal), low angle looking up slightly.
- Lighting: Golden hour, warm rim light, slight haze/atmosphere.
- Generation prompt (Runway Gen-4 / Veo 3): "Photoreal wide shot of a rooftop commercial HVAC condenser unit at golden hour, warm side light, long shadows, a technician in plain workwear walking toward it from a distance, back to camera, slow gimbal push-in, cinematic, shallow depth of field, 16:9. No text overlays, no logos, no signage, no visible face, no brand names."
- VO line: "Somewhere on this roof, a compressor's been running since 2014."
- Music: Single sustained low pad, no rhythm yet — silence with air in it.

**Shot 2 — 0:05–0:09 (4s) · AI-generated**
- On screen: Close-up, a technician's gloved hands opening an electrical access panel on the unit, then resting on the corroded nameplate/data tag.
- Camera: Static macro, tight frame, hands only.
- Lighting: Hard directional sun, slight lens flare at frame edge.
- Generation prompt: "Photoreal macro close-up of a technician's hands in work gloves opening a metal access panel on a rooftop HVAC unit, then touching a weathered metal nameplate/data tag, hard sunlight, slight lens flare, static camera, shallow depth of field, 16:9. Hands and equipment only, no face, no readable text on the nameplate, no logos."
- VO line: "When it stops, someone has to know what it is, and what's supposed to happen next."
- Music: Pad continues, a single soft mallet hit on the word "stops."

**Shot 3 — 0:09–0:13 (4s) · AI-generated**
- On screen: Cluttered shop office, late afternoon light through blinds. A hand pulls open an overstuffed filing-cabinet drawer, flips through yellowed folders.
- Camera: Slow lateral dolly, eye level with the drawer.
- Lighting: Practical desk lamp + blind-slat sunlight, dusty and warm.
- Generation prompt: "Photoreal shot of a cluttered small-business office, a hand pulling open a full metal filing cabinet drawer and flipping through worn paper folders, warm afternoon light through venetian blinds, dust motes visible, slow lateral dolly, 16:9. No readable text or labels on the folders, no logos, no visible face."
- VO line: "That used to mean a filing cabinet, or a call back to the office."
- Music: Pad thins out — a beat of tension before the cut.

**Shot 4 — 0:13–0:16 (3s) · AI-generated**
- On screen: A phone face-down on a truck dashboard, engine idling, windshield view of a job site beyond.
- Camera: Static, shallow focus racking from dashboard to windshield.
- Lighting: Bright midday through the windshield, phone screen glow barely visible.
- Generation prompt: "Photoreal static shot of a smartphone lying face-down on a work truck dashboard, engine idling, blurred job site visible through the windshield beyond, focus racks from phone to background, 16:9, natural daylight. No visible screen content, no text, no logos, no faces."
- VO line: (none — held silent for one beat before the cut into the logo)
- Music: A single low string swell begins, rising into shot 5.

**Shot 5 — 0:16–0:22 (6s) · Code-rendered (`promo.html` scene `s2`, tail of `s1`)**
- On screen: The cold-open line and the DeepWell rings drawing on, center-out, settling into the wordmark and "Records that answer back."
- Camera: N/A — deterministic on-screen animation.
- Lighting: N/A — dark background, brass/forest palette per the site's design tokens.
- Source: extract from the existing render (see ffmpeg plan below) — not regenerated.
- VO line: "DeepWell reads the paperwork so your team doesn't have to remember it."
- Music: String swell resolves into a simple two-note motif — the track's identity from here on.

**Shot 6 — 0:22–0:28 (6s) · Code-rendered (`promo.html` scene `s3`, Ingestion)**
- On screen: A folder of files drops into the Inbox, the pipeline stages count up, a document's fields extract into a fact panel, a citation chip appears.
- Camera: N/A — screen capture.
- Lighting: N/A — Office (dark) theme.
- Source: extract from the existing render.
- VO line: "Upload a work order, a nameplate photo, an invoice — it finds the facts, and files them where you can find them again."
- Music: Motif continues, a light rhythmic pulse enters (still no percussion, just movement).

**Shot 7 — 0:28–0:31 (3s) · AI-generated**
- On screen: Back on the rooftop — the technician now holding a phone up, sunlight behind it, reading the screen (content not shown/implied, not composited here).
- Camera: Medium shot, slight handheld drift, over-the-shoulder framing that never reveals the screen.
- Lighting: Golden hour continues, screen glow subtle.
- Generation prompt: "Photoreal medium over-the-shoulder shot of a technician on a rooftop holding up a smartphone toward soft golden-hour light, screen not visible to camera, slight handheld drift, cinematic, 16:9. No visible screen content, no text, no logos, no clearly visible face — three-quarter back angle only."
- VO line: "Ask a plain question. Get an answer, with the page it came from."
- Music: Pulse steadies — a held anticipatory note into the UI cut.

**Shot 8 — 0:31–0:38 (7s) · Code-rendered (`promo.html` scene `s4`, Ask Donovan — first cycle)**
- On screen: The bronze "answer rising" well reads a typed question ("Is the Whitmore unit still under warranty?"), rises to answer with numbered citation pills.
- Camera: N/A — screen capture.
- Lighting: N/A — the well's own bronze/forest lighting.
- Source: extract from the existing render.
- VO line: "Warranty status. Refrigerant type. The technician who was there last time."
- Music: Motif peaks gently — the calmest, most confident point in the track, not louder, just clearer.

**Shot 9 — 0:38–0:43 (5s) · Code-rendered (`promo.html` scene `s4`, second cycle + outreach draft)**
- On screen: A second question answers ("What refrigerant is in RTU-3 at Desert Ridge Dental?"), then an outreach email draft for an expiring warranty appears with "Copy email."
- Camera: N/A — screen capture.
- Lighting: N/A.
- Source: extract from the existing render.
- VO line: "Same records, same shop — answered in seconds."
- Music: Motif holds, a soft second layer (warm pad) joins under it.

**Shot 10 — 0:43–0:47 (4s) · AI-generated**
- On screen: The technician back at the truck, pocketing the phone, a small nod of confirmation, then walking back toward the unit — problem solved, moving on.
- Camera: Medium-wide, slow tracking shot following from the side.
- Lighting: Late golden hour, warmer and lower now.
- Generation prompt: "Photoreal medium-wide tracking shot of a technician pocketing a smartphone beside a work truck, then walking back toward a rooftop or job site, late golden-hour light, warm tones, slow lateral tracking camera, cinematic, 16:9. No visible face close-up (side or back angle only), no text, no logos, no signage."
- VO line: "From the truck. From the roof. Whenever the question comes up."
- Music: Warm pad layer settles, track begins its gentle resolve.

**Shot 11 — 0:47–0:52 (5s) · Code-rendered (`promo.html` scene `s5`, Field view)**
- On screen: The same answer shown on a phone, in the app's light "Field view" theme — larger type, on the job site.
- Camera: N/A — screen capture.
- Lighting: N/A — light theme.
- Source: extract from the existing render.
- VO line: (none — let the visual carry it, one beat of quiet)
- Music: Track thins back toward the opening pad, mirroring shot 1.

**Shot 12 — 0:52–0:60 (8s) · Code-rendered (`promo.html` scene `s6`, Close)**
- On screen: Logo, "Knowledge builds business.", plans from $99/mo, deepwelltechnology.com.
- Camera: N/A — screen capture.
- Lighting: N/A.
- Source: extract from the existing render.
- VO line: "DeepWell. Knowledge builds business."
- Music: Final two-note motif resolves to the sustained pad from shot 1, fades under the tail.

## Full voice-over script (ElevenLabs-ready, ~118 words)

> Somewhere on this roof, a compressor's been running since 2014.
> When it stops, someone has to know what it is, and what's supposed to happen next.
> That used to mean a filing cabinet, or a call back to the office.
> DeepWell reads the paperwork so your team doesn't have to remember it.
> Upload a work order, a nameplate photo, an invoice — it finds the facts, and files them where you can find them again.
> Ask a plain question. Get an answer, with the page it came from.
> Warranty status. Refrigerant type. The technician who was there last time.
> Same records, same shop — answered in seconds.
> From the truck. From the roof. Whenever the question comes up.
> DeepWell. Knowledge builds business.

Delivery notes for ElevenLabs: calm, low-mid pace (~130 wpm), a real person
thinking out loud, not narrating an ad — falling intonation at the end of
each line, a full breath's pause between paragraph breaks above (they mark
the shot boundaries), no vocal emphasis on "DeepWell" beyond a natural
brand-name stress. A warm, unhurried male or female voice in the 35–50 age
range reads as most credible for this audience; avoid anything bright or
"announcer."

## What to generate — checklist and estimated cost

| # | Item | Tool | Qty | Est. cost |
|---|---|---|---|---|
| 1 | Shots 1, 2, 3, 4, 7, 10 (live-action b-roll, 5–8s generated per shot to allow trimming/crossfade slack) | Runway Gen-4 (Turbo) or Google Veo 3 | 6 shots × 2 takes each (pick best) = 12 generations, ~8s avg | Runway Gen-4 Turbo ≈ $0.05–0.10/sec → ~$5–10 per generation, ~$60–120 total for 12 takes. Veo 3 ≈ $0.10–0.40/sec depending on tier → ~$8–32 per generation, ~$100–380 total. **Prices move often — check the tool's current per-second/credit rate before budgeting.** |
| 2 | Shots 5, 6, 8, 9, 11, 12 (code-rendered UI) | Existing `video/render.mjs` output (already rendered) | 0 new renders needed — extract from `video/deepwell-promo.mp4` | $0 (compute already spent; re-run `render.mjs` only if a scene needs to change first) |
| 3 | Voice-over | ElevenLabs (existing plan or pay-per-character) | 1 read, ~120 words / ~700 characters, generate 2–3 takes for delivery choice | Effectively $0 on an existing paid plan (well under any monthly character allowance); pay-per-character tiers run a few cents for this length |
| 4 | Music bed | Reuse `promo.html`'s existing synthesized ambient bed (`render.mjs`'s `synthAmbient()`, ffmpeg-only, no license needed) or a licensed calm/minimal track (Epidemic Sound, Artlist) | 1 track, ~60s | $0 if reusing the synth bed; ~$10–20/mo subscription-amortized if licensing something more melodic |
| 5 | Review/QA pass | Human (owner) | 1 pass watching the assembled cut against this storyboard | $0 (time only) |

Total estimated spend, generating 2 takes of each of the 6 AI shots:
**roughly $60–120 on Runway Gen-4, or $100–380 on Veo 3**, plus a few cents
of ElevenLabs usage. Generating only 1 take per shot (no A/B pick) roughly
halves the AI-video figure.

## ffmpeg assembly plan

Clip naming convention: `video/shots/01.mp4` … `video/shots/12.mp4`,
numbered in final-cut order (matching the shot list above), each already
trimmed to its target duration, 1920×1080, 30fps, h264, no audio track (the
VO and music are mixed on afterward, once, over the whole assembled video —
not per clip).

**1. Pull the six code-rendered shots out of the existing render** (no
re-render needed; adjust the in/out seconds by eye once you scrub the
source — these starting points come straight from the scene table in
`video/README.md`):

```bash
SRC=video/deepwell-promo.mp4
mkdir -p video/shots

ffmpeg -y -i "$SRC" -ss 3.0  -to 12.0 -c:v libx264 -crf 18 -an video/shots/05.mp4   # s1 tail + s2 (logo)
ffmpeg -y -i "$SRC" -ss 16.0 -to 22.0 -c:v libx264 -crf 18 -an video/shots/06.mp4   # s3 (ingestion)
ffmpeg -y -i "$SRC" -ss 30.0 -to 37.0 -c:v libx264 -crf 18 -an video/shots/08.mp4   # s4 (Q&A #1)
ffmpeg -y -i "$SRC" -ss 37.0 -to 42.0 -c:v libx264 -crf 18 -an video/shots/09.mp4   # s4 (Q&A #2 + outreach)
ffmpeg -y -i "$SRC" -ss 44.0 -to 49.0 -c:v libx264 -crf 18 -an video/shots/11.mp4   # s5 (field view)
ffmpeg -y -i "$SRC" -ss 52.0 -to 60.0 -c:v libx264 -crf 18 -an video/shots/12.mp4   # s6 (close)
```

**2. Normalize the six AI-generated clips** (whatever resolution/fps the
tool exports) to match, and drop them in as `01.mp4`…`04.mp4`, `07.mp4`,
`10.mp4`:

```bash
for f in video/shots/ai-*.mp4; do
  out="video/shots/$(basename "$f")"
  ffmpeg -y -i "$f" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30" \
    -c:v libx264 -crf 18 -pix_fmt yuv420p -an "$out"
done
```

**3. Concatenate with hard cuts** (guaranteed to land at exactly 60s —
do this pass first, watch it, then add crossfades only if the cuts feel
abrupt):

```bash
cat > video/shots/list.txt <<'EOF'
file '01.mp4'
file '02.mp4'
file '03.mp4'
file '04.mp4'
file '05.mp4'
file '06.mp4'
file '07.mp4'
file '08.mp4'
file '09.mp4'
file '10.mp4'
file '11.mp4'
file '12.mp4'
EOF

ffmpeg -y -f concat -safe 0 -i video/shots/list.txt -c:v libx264 -crf 18 -pix_fmt yuv420p \
  video/deepwell-apple-60s-silent.mp4
```

**4. Optional 0.4s crossfades instead of hard cuts** — every clip needs to
be generated/rendered ~0.4s *longer* than its listed duration first, so the
overlap doesn't shorten the final runtime below 60s. With that padding in
place, chain `xfade` filters pairwise (offsets below assume the padded
12-clip chain; recompute if you change any duration):

```bash
ffmpeg -y \
  -i video/shots/01.mp4 -i video/shots/02.mp4 -i video/shots/03.mp4 -i video/shots/04.mp4 \
  -i video/shots/05.mp4 -i video/shots/06.mp4 -i video/shots/07.mp4 -i video/shots/08.mp4 \
  -i video/shots/09.mp4 -i video/shots/10.mp4 -i video/shots/11.mp4 -i video/shots/12.mp4 \
  -filter_complex "\
  [0][1]xfade=transition=fade:duration=0.4:offset=4.6[v1]; \
  [v1][2]xfade=transition=fade:duration=0.4:offset=8.2[v2]; \
  [v2][3]xfade=transition=fade:duration=0.4:offset=11.8[v3]; \
  [v3][4]xfade=transition=fade:duration=0.4:offset=14.4[v4]; \
  [v4][5]xfade=transition=fade:duration=0.4:offset=20.0[v5]; \
  [v5][6]xfade=transition=fade:duration=0.4:offset=25.6[v6]; \
  [v6][7]xfade=transition=fade:duration=0.4:offset=28.2[v7]; \
  [v7][8]xfade=transition=fade:duration=0.4:offset=34.8[v8]; \
  [v8][9]xfade=transition=fade:duration=0.4:offset=39.4[v9]; \
  [v9][10]xfade=transition=fade:duration=0.4:offset=43.0[v10]; \
  [v10][11]xfade=transition=fade:duration=0.4:offset=47.6[vout]" \
  -map "[vout]" -c:v libx264 -crf 18 -pix_fmt yuv420p video/deepwell-apple-60s-silent.mp4
```

**5. Mix in the voice-over and music bed** (VO at full presence, music
ducked under it; `-shortest` trims to whichever track is shortest, which
should be the ~60s video):

```bash
ffmpeg -y -i video/deepwell-apple-60s-silent.mp4 -i voiceover.wav -i music.wav \
  -filter_complex "[2:a]volume=0.22[music_low];[1:a][music_low]amix=inputs=2:duration=first:dropout_transition=2[aout]" \
  -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -shortest \
  video/deepwell-apple-60s-final.mp4
```

If reusing `promo.html`'s existing synthesized ambient bed instead of a
separate `music.wav`, pull its audio straight out of `video/deepwell-promo.mp4`
first (`ffmpeg -i video/deepwell-promo.mp4 -vn -acodec copy music.m4a`) and
pass that in as the third input above.
