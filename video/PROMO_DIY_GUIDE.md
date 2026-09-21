# DeepWell promo — DIY guide (free tools + the master prompt)

You have two code-rendered cuts in `video/` (v3, 60 s + 15 s). They are clean
motion graphics. To get the "Apple product film" feel you need three things
code can't give you: photoreal footage, a human voice, and real music. All of
it is doable free (or near-free) in an afternoon.

## Free tool stack (all have a no-cost tier as of Sept 2026 — check limits)

| Job | Tool | Notes |
|---|---|---|
| AI footage (b-roll) | **Google Veo 3** (Gemini app, free tier w/ daily cap) · **Runway Gen-4** (free credits) · **Kling 2** (free daily credits) · **Luma Dream Machine** | 5–8 s clips, 16:9, 1080p. Generate 2–3 takes per shot, keep the best. |
| App screen recordings | **OBS Studio** (free) or Windows Game Bar (Win+G) | Record the real app at 1920×1080, Office view, cursor visible, slow deliberate moves. Real UI beats mockups. |
| Device mockups | **Rotato** (free tier) · **Screen Studio** (paid, Mac) · **Mockuuups** | Puts the recording on a laptop/phone with lighting. |
| Voice-over | **ElevenLabs** (free 10 min/mo) | Voice: calm, mid-40s, American, unhurried. Script below. |
| Music | **Suno / Udio** (free daily generations) or **Pixabay / YouTube Audio Library** (royalty-free) | Prompt: "minimal ambient piano and low synth pad, 72 bpm, warm, cinematic, no drums until 0:40, no vocals". |
| Editing | **DaVinci Resolve** (free, pro-grade) · **CapCut desktop** (free) | Resolve for color/grain; CapCut if you want speed. |
| Captions | CapCut auto-captions or Resolve | Export .srt too (`video/deepwell-promo-v3.srt` is a starting point). |
| Logo animation | Already done: `public/logo-animated.svg` and the ring draw-on in `video/promo-v3.html` | Screen-record it, or export frames with `node video/render.mjs`. |

Total cost: $0–$30 depending on how many AI clips you regenerate.

## The master prompt (paste into any AI video tool, one shot at a time)

Keep every shot to ONE idea, ONE camera move. Append the style block to each.

**Style block (append to every shot):**
"Cinematic product film, 35mm anamorphic look, shallow depth of field, natural
golden-hour or practical light, muted greens and warm bronze tones, dark
navy shadows, no text, no logos, no visible faces, slow deliberate camera,
photoreal, 24fps, 16:9, no lens flares, no sparkles."

**Shots (5–8 s each):**
1. Dolly-in through a dim HVAC shop office at night: a desk lamp, a filing
   cabinet with one drawer half open, paper edges catching the light.
2. Close-up: a technician's gloved hand opening a service ticket binder on a
   truck's passenger seat, sunlight through the windshield.
3. Rooftop at golden hour, Phoenix skyline soft in the background, a rooftop
   AC unit in silhouette, heat shimmer, slow orbit.
4. Macro: a weathered equipment nameplate, serial number etched, dust,
   rack-focus from blur to sharp.
5. Overhead slow pan across a workbench: invoices, a warranty card, a phone
   face-down, a coffee ring.
6. A phone in a hand at a job site, screen glowing (blank — you'll composite
   the real app on it), morning light.
7. Low-angle slow push on an office chair in front of two monitors at dusk
   (you'll composite the real app on the monitors).
8. Closing: the same dark office, now the lamp is off, monitor glow only,
   slow pull back.

**Voice-over (≈ 120 words, ~55 s — ElevenLabs, "calm & confident", speed 0.95):**
"Every job leaves a trail. An invoice. A warranty card. A photo of a nameplate
nobody can find six months later. DeepWell reads all of it — and turns your
records into answers. Ask what's installed at an address. Ask who was there
last. Ask if it's still under warranty. Donovan reads your documents and
answers with the page it came from. Every customer, every unit, every visit —
linked, and one question away. In the office, or on the roof. It's the same
truth, on any device. DeepWell. Knowledge builds business."

## Assembly (Resolve or CapCut)
- Timeline: cold open (shots 1–2, VO line 1–2) → logo rings draw-on (from
  `video/promo-v3.html`, 4 s) → app sequence (real recordings on the mockups,
  shots 6–7, VO lines 3–6) → rooftop + phone (shot 3, 6; VO "In the office…")
  → close (shot 8, logo, URL, tagline).
- Cuts on the VO's natural pauses; hold each app moment 3–4 s longer than
  feels right; one crossfade max, everything else hard cut on a beat.
- Grade: lift blacks slightly, desaturate 10%, add 4–6% film grain, vignette.
- Music under VO at −18 dB, swell to −10 dB on the logo, duck under speech.
- Export: 1920×1080 H.264 20 Mbps + a 1080×1920 vertical crop of the 15 s cut.

## What to record in the app (real UI, Office view, 1080p, OBS)
1. Drag 6 PDFs into Inbox → rows appear → statuses turn "Checked".
2. Open a customer → units, documents, citation pills.
3. Ask Donovan: "What's the serial at 215 N College Ave?" → answer + chip.
4. Ask: "How many customers do we have in Maricopa County?" (new analytics).
5. Switch to Field view on a phone → same answer.
