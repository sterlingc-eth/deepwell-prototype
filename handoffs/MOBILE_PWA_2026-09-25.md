# DeepWell Mobile (lite PWA) — 2026-09-25

Owner decision: PWA first for techs and managers; improve/go native as we scale.

## What it is
- URL: `/m/` (e.g. deepwelltechnology.com/m). Installable: Android shows an
  Install button; iPhone shows "Share → Add to Home Screen" tip.
- Three tabs: **Ask** (Donovan, same `/api/ask`), **Scan** (camera / photos /
  PDFs → same ingest path as the Inbox), **Docs** (search + filters: All,
  My work, Warranties, Needs info → detail sheet with key fields + Open original).
- Same Clerk session, tenant scoping, billing hard gate and API as `/app`.
  No new API routes (api/ still 12 files), no SQL.

## Scan details
- Photos are downscaled to 2200 px and re-encoded as JPEG on the phone
  (HEIC-safe, fast on LTE, under the 24 MB read limit).
- Several photos default to "Pages of one document" → one multi-page PDF
  (jspdf, lazy-loaded). Toggle off to upload separately.
- Tabs stay mounted, so an upload keeps running while the tech switches tabs.

## Files
- `m/index.html`, `src/mobile/*`, `public/m/{manifest.webmanifest,sw.js,icon-*.png}`
- `vite.config.ts` (new `mobile` input), `vercel.json` (/m rewrites + no-cache).
- Service worker scope `/m/` only; never caches `/api/*`; page is network-first.

## Verified
typecheck, typecheck:api, oxlint, build, all verify:* except the pre-existing
verify:business-corpus failure (fails identically without this change).
390 px layout checked in a harness. Reviewer: GO (nits applied).

## Still to do on a real phone
1. iPhone: sign in, Add to Home Screen, sign in inside the installed app.
2. Scan a 2–3 page work order with the camera → shows in Docs after reading.
3. Ask a question → tap a source → Open original.

## Next ideas (not built)
Push notifications for missing-info follow-ups, offline queue for uploads
with no signal, nameplate quick-capture (reuse src/services/plateCapture.ts),
customer lookup tab.

## Round 2 (same day) — speed, any screen, uncluttered, full Donovan
Team: perf engineer, responsive/UX engineer (13 viewports), Donovan QA
(answer-shape parity), QA re-test (12 viewports), reviewer (GO, nits fixed).

Speed
- Phone first load ~112 KB gzip (was ~123) while adding features: the demo
  seed and mock answer engine no longer ship in production bundles
  (usePostgresSync imports hvac/schema directly; mock provider is lazy).
  Desktop /app bundle shrinks too.
- The heavy records sync is deferred on mobile (idle, or when Docs / a doc
  opens) and skips the link sweep — Ask is usable immediately.
- /api/ask: 60 s timeout with Retry, "still working" hint at 8 s, session
  token warmed on focus. /assets/* now cached immutable (vercel.json).
- Service worker: 3 s network race then last good page (weak signal), 5xx
  fallback, asset cache trimmed.
- Composer owns its own text state (typing doesn't re-render answers);
  Docs search uses useDeferredValue.

Any screen
- Centered column on tablet/desktop; sheets become centered dialogs ≥768 px.
- Landscape phones: compact header + side-by-side nav (`short:` variant =
  max-height 520 px, tailwind.config.ts plugin).
- Tab bar hides while typing (keyboard up). Every tap target ≥44 px.
- Verified no horizontal overflow at 320→1920 wide, landscape, 150% text.

Uncluttered
- Answer = headline + at most one key fact; Details / Records / Sources are
  one row of toggles (one open at a time). Scan has one primary button and a
  pinned Upload bar with a horizontal page strip. Fewer borders everywhere.

Donovan parity (nothing dropped, only folded)
- Status pills, "calculated" tag on computed facts, interpretation caption,
  breakdown group chips + "Showing N of M", no-answer shows "Closest" (never
  as sources), feedback thumbs → learning loop, usage % at ≥80%, tap-to-call
  / email, customer records open a Customer card (contact, map, equipment
  with warranty status, recent docs) via customerClient.getByRef.

Known limit (same as desktop): Docs lists the newest 500 documents
(recordsStore LIMIT 500); the list says so and points to Ask for older ones.
