# DeepWell Promo Video — Master Prompt
Paste everything below (from "You are producing" to the end) into a fresh Claude chat with a code sandbox / file tools enabled.

---

You are producing a **top-tier, animated promo video for DeepWell Technology** entirely with free, code-based tools. Do NOT use any paid AI video generation API (no Veo/Runway/Kling/Sora/etc.) and do not tell me to go record live-action footage — everything must be built and rendered by you, in the sandbox, from code.

## What DeepWell is (ground every frame in this — do not invent features)
DeepWell Technology is AI-powered document management + Q&A for field-service businesses, starting with HVAC (plumbing, electrical, and property management are next). The product:
- Ingests any paperwork — photos, PDFs, handwriting — of work orders, invoices, warranty cards, nameplate photos, startup sheets, permits, dispatch notes.
- Auto-sorts and links everything to the right customer and unit/equipment record.
- Surfaces warranty alerts, maintenance due dates, and invoice totals automatically.
- Lets the owner/tech **ask Donovan** (the AI) any question about the business in plain English and get an answer **with clickable citations to the exact source page** (e.g. "Startup sheet · p.1").
- Learns every night on the business's own records (self-learning, gets sharper over time).
- Works the same in the office and on a phone in the field.
- Real headline claim from the site: *"One question answered right. For example, a $300 callback avoided."* Tagline: **"Knowledge builds business."**
- Pricing tiers exist ($99/mo Solo, $199/mo Shop for 2–4 techs, $399/mo, $899+/mo) — do not dwell on pricing in the video; one quiet mention max.
- CTA URL: **deepwelltechnology.com**

## Brand system (must match exactly — read the real files first, see below)
- Colors: deep forest green `#163C2C` (well), `#245239`, `#3A6B4D`, `#5A8C6C`, `#86AE93`, light rim `#9DC4B2`; brass/bronze accent `#B98A4E` / bronze `#8C6B3E`–`#C8A67A`; navy `#123D6B` used sparingly; dark ink background `#0B1613` / `#10201A`; cream highlight `#F4EBDD`. Single warm accent only — brass/bronze, never rainbow, never neon.
- Typography: serif display headline (Newsreader), IBM Plex Mono for labels/eyebrows, IBM Plex Sans for body/UI. Load from Google Fonts.
- Donovan mark: **concentric rings inside a lit sphere — a well of light, the answer rising from depth.** It is explicitly NOT a face, not sparkles, not a badge. Three states: idle (slow breathing ripple, rings fading in sequence), reading (quicker ripple + a sweeping arc), answered (one settling pulse then still). The owner has explicitly liked fluid ring/ripple water-like animation as a reference quality bar — study that reference feel (concentric ripples, soft caustics, light refraction) and aim for that level of polish.
- Motion language: slow, weighty, precise. Easing `cubic-bezier(0.16,1,0.3,1)` (or similar "expo-out"), long holds, NO bounce, NO cartoon overshoot, no confetti/sparkle effects. Think Apple product-film pacing: one idea per shot, confident holds, hard cuts (at most one crossfade in the whole piece).

## Step 0 — Read the real product first (read-only, do not modify)
Before writing any code, actually open and read these files in the attached project/repo so the video is a faithful recreation, not a generic mockup:
1. `index.html` — hero headline/subhead, section copy, pricing card copy, color tokens (`:root` CSS vars), the existing Donovan/well SVG markup and animation keyframes.
2. `public/logo-animated.svg` and any files in `public/brand/` — the actual logo geometry and its existing draw-on animation (stroke-dashoffset ring reveal) — reuse this exact mark, do not redesign it.
3. `handoffs/BRAND_MOTION_BRIEF_2026-09-21.md` and the related `BRAND_MOTION_A/B/C*` files — the approved motion system and constraints (no sparkles, no face, pointer-reactive rings, reduced-motion fallback, etc.).
4. `video/PROMO_DIY_GUIDE.md` and `video/STORYBOARD_APPLE_STYLE.md` — earlier promo attempts, their shot lists, VO script, and the existing `video/render.mjs` / `video/promo.html` scene structure. Reuse/upgrade this rendering approach rather than starting from zero; do not reuse their live-action-footage plan (that part is out of scope here — you are doing 100% code-rendered motion graphics, no filmed footage).
5. `src/components/DonovanMark.tsx` — the production React implementation of the well/ring mark (states, ring radii, gradients) — port its visual logic faithfully into the standalone HTML/Canvas or Remotion build.
6. App screens for UI recreation reference: `src/screens/AskScreen.tsx`, `src/screens/DashboardScreen.tsx`, `src/screens/InboxScreen.tsx`, `src/screens/RecordsScreen.tsx`. Recreate these as **faithful animated vector recreations** (real layout, real component shapes, real color tokens) populated with **fictional but realistic sample data** (e.g. "Whitmore Rooftop Unit," "215 N College Ave," "Carrier 48TC," invoice totals, a warranty-expiring badge) — never real customer data, never a literal screen-recording.

If any of these files are missing or unreadable in this sandbox, ask me for them before proceeding rather than guessing at the product.

## Ask me these questions up front (with sensible defaults so you can proceed immediately if I don't answer)
1. Final logo file to use — default: `public/logo-animated.svg` as found in the repo.
2. Exact tagline/CTA line for the closing card — default: **"Knowledge builds business." → deepwelltechnology.com**
3. Which of the 3 headline options below to lead with (or write your own) — default: **Option 1**.
4. Whether to include a voice-over — default: **no VO, captions only** (music-bed hook only, see below).

## Script — 3 headline options (pick one, keep the other two in the delivered doc)
1. **"Every job leaves a trail. DeepWell turns it into answers."**
2. **"Stop calling the office. Ask Donovan."**
3. **"Your records already know. Now you can ask them."**

Closing card (all cuts): *"Knowledge builds business."* — **deepwelltechnology.com**

## Required deliverables
1. **60 s hero cut** — 1920×1080, 60 fps, H.264 (`libx264`, `-crf 18`, `-preset slow`, `-movflags +faststart`, `yuv420p`), plus a `.webm` (VP9) and a **poster frame JPG** (a strong still, e.g. mid-way through the Ask/answer scene) and a **thumbnail PNG** (1280×720, punchy, includes the mark + headline).
2. **15 s vertical social cut** — 1080×1920, same codec settings, re-composed (not just cropped) for vertical: logo → one Ask/answer beat → CTA.
3. **Optional 30 s cut** if time allows — same spec as the 60 s, tightened.
4. **Captions**: burned-in kinetic captions matching each VO/caption line, PLUS a standalone `.srt` per cut. No music track shipped by default — build the timeline with a clearly marked, empty "music bed" track/cue sheet (with timestamps and mood notes, e.g. "0:00–0:06 low pad, 0:44 swell") so a royalty-free bed can be dropped in later without re-cutting.
5. **Scene-by-scene storyboard document** (markdown) with exact timings (mm:ss.f), what's on screen, camera move, easing, and caption text for every scene, for both the 60 s and 15 s cuts.
6. **Poster frame + thumbnail** as separate exported image files.
7. All source code (HTML/CSS/SVG/Canvas or Remotion project) checked into the sandbox so the video is fully re-renderable.

## Required tech approach (free tools only)
- Build the animation as **deterministic, code-driven** scenes — either (a) a single `video/promo.html` with all scenes as absolutely-positioned layers driven by one `t` (ms) variable via `window.__seek(t)` (no `requestAnimationFrame` wall-clock dependence), matching the existing repo pattern, or (b) a **Remotion** project (`npm i remotion`) if available in the sandbox — pick whichever the sandbox supports and justify the choice in one sentence.
- Render frame-by-frame with **headless Chromium via Playwright** (or Remotion's own renderer) at the target fps, output PNG/raw frames, then **encode with ffmpeg** to the export specs above. No paid rendering service.
- Recreate the Donovan mark, the Inbox/upload flow, the customer/unit card assembly, the Ask/answer-with-citation-chip flow, and a field/phone-frame moment, all as animated SVG/Canvas — matched to the real color tokens and copy you read in Step 0.

## Suggested scene flow for the 60 s cut (adjust based on what you actually read in Step 0)
1. 0:00–0:06 — Cold open: dark screen, a single line of kinetic type posing the problem ("Where's the serial for the Elm Street unit?"). No logo yet.
2. 0:06–0:14 — Donovan mark ring draw-on (reuse `logo-animated.svg` geometry) resolving into the wordmark + chosen headline.
3. 0:14–0:30 — Ingestion: documents drop into an Inbox, extract into a fact panel, assemble into a customer/unit card with citation chips (fictional sample data).
4. 0:30–0:44 — Ask Donovan: question typed, well "reads" (ripple/sweep state), answer rises with a numbered citation chip; quick second Q&A beat (warranty expiring → outreach draft).
5. 0:44–0:52 — Same answer on a phone frame (field/light theme), showing office-to-field consistency.
6. 0:52–0:60 — Closing card: tagline, URL, one soft pricing/value line max, mark settles to idle.

## Self-review loop (required — do not skip)
After each render pass:
1. Extract key-frame stills (e.g. at each scene boundary + 2 mid-scene points) as PNGs.
2. Actually look at them (read the image files) and check: brand colors correct, no clipped/overlapping text, mark reads as rings/depth (not a face or badge), captions legible and on-sync, no jitter/aliasing, easing feels weighty not bouncy.
3. Fix any issues in the source and re-render just the affected scene range before doing a full final render.
4. Do at least one full pass of this loop before declaring the video done; state clearly what you checked and fixed.

## Output format
Be self-contained and paste-ready — don't ask clarifying questions before starting except the 4 listed above (proceed on defaults if I don't answer). Work autonomously through: read source → confirm/default answers → write storyboard doc → build code → render key-frame stills → self-review → fix → final render of all cuts → export poster/thumbnail/SRT → summarize what was produced and where the files are.

---

### Why this works
Grounding Step 0 in the actual repo files (index.html tokens, DonovanMark.tsx, the existing brand-motion brief) prevents Claude from inventing an off-brand UI or a face/sparkle mark the owner already rejected. Requiring deterministic `t`-driven rendering + Playwright + ffmpeg keeps the whole pipeline free, reproducible, and re-renderable when the product changes. The mandatory self-review loop (render stills → inspect → fix → re-render) is what separates a "good enough" AI output from a top-tier one — it catches clipped text, off-palette colors, and motion that reads as cheap before the final export. Fictional sample data lets the UI recreation be pixel-faithful without ever risking real customer records. Defaulting every open question (logo, tagline, headline, no-VO) means the founder can paste this once and get a finished deliverable, not a clarification round-trip.
