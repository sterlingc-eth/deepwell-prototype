# QA — Live website deep crawl (2026-09-21)

QA engineer 1 of 3. Live Playwright crawl of `https://deepwelltechnology.com`
(index, `/privacy.html`, `/terms.html`, `/app/`, and a synthetic 404 path).
No git used. No files changed — see "Fixes" at the bottom for why.

## Coverage matrix — errors per page/width/theme

All runs waited for the reveal/count-up animations to settle (~3s) before
sampling. "Errors" = console `error` + `pageerror` + failed/4xx-5xx network
requests, combined.

| Page | Width | Theme | Status | Console/page errors | Failed requests | Overflow |
|---|---|---|---|---|---|---|
| `/` | 375 | light | 200 | 0 | 0 | none |
| `/` | 375 | dark | 200 | 0 | 0 | none |
| `/` | 768 | light | 200 | 0 | 0 | none |
| `/` | 768 | dark | 200 | 0 | 0 | none |
| `/` | 1440 | light | 200 | 0 | 0 | none |
| `/` | 1440 | dark | 200 | 0 | 0 | none |
| `/` | 1440 | light, `prefers-reduced-motion: reduce` | 200 | 0 | 0 | none |
| `/privacy.html` | 1440 | light | 200 | 0 | 0 | none |
| `/privacy.html` | 375 | dark | 200 | 0 | 0 | none |
| `/terms.html` | 1440 | light | 200 | 0 | 0 | none |
| `/terms.html` | 375 | dark | 200 | 0 | 0 | none |
| `/nonexistent-qa-check-404` (synthetic) | 1440/375 | light/dark | **404** (correct, server-rendered, not a 200 SPA fallback) | 1 (the expected 404 resource-load message) | 1 (the request itself, expected) | none |
| `/app/` | 1440 | light | 200 | 0 | 0 | none |
| `/app/` | 375 | dark | 200 | 0 | 0 | none |

Zero unexpected console errors, page errors, or failed sub-resource requests
anywhere in the crawl. Note: Playwright's `colorScheme: light/dark` context
option has **no visible effect** on this site — see finding #4 below.

## Structural / asset checks (all PASS)

- **Anchors**: every in-page `href="#…"` (`#top #problem #platform #demo
  #who #plans #contact`) resolves to a real element id. No dead in-page
  anchors.
- **Buttons/CTAs** — destinations recorded by clicking each:
  - "Log in" → `/app/` → shows Clerk sign-in ("Sign in to DeepWell").
  - "Start free trial" → `/app/?plan=solo&interval=month` → resolves to
    `/app/`, shows Clerk sign-in. See finding #1.
  - "See pricing" → `#plans`, "See what it feels like" → `#demo` — both
    scroll correctly and the nav active-indicator updates to match.
  - Plan cards "Get started" (Solo/Shop/Crew) → `/app/?plan=<tier>&interval=month`,
    same behavior as "Start free trial" (finding #1). "Contact sales" (Fleet)
    → `/app/?plan=fleet&interval=month`, same.
  - "Send a sample box — free demo" → `mailto:hello@deepwelltechnology.com?subject=Records%20Rescue%20demo%20sample` — well-formed, opens mail client.
  - "deepwellincorporated@gmail.com" (contact) → `mailto:…?subject=Records%20audit` — well-formed.
  - "buy it under Billing" → `/app/?screen=billing` (in-app, gated by auth — expected).
- **`/app/` entry**: confirmed live — shows "Sign in to DeepWell / Continue
  with Google / Email address / Password", "Secured by Clerk". Matches spec.
- **Nav active-section indicator**: verified by scrolling to `#demo` and
  `#plans` — the underline correctly moves to "What it feels like" / "Pricing".
- **Mailto links**: both well-formed (`mailto:` + valid address + URL-encoded
  `subject=`).
- **Static assets** (HEAD/GET via Playwright's request API, all 200 with
  correct content-type): `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`,
  `og-image.jpg`, `site.webmanifest`, `robots.txt`, `sitemap.xml`,
  `logo-animated.svg`, `deepwell-logo.jpg`, `privacy.html`, `terms.html`.
  `robots.txt` correctly disallows `/app` and `/api` and points at the
  sitemap; `sitemap.xml` lists `/`, `/privacy.html`, `/terms.html`.
- **404 page** (`public/404.html`): real server-side 404 status (not a 200
  SPA catch-all), on-brand copy, "Home"/"App"/"Contact" links all resolve
  correctly.
- **SEO basics** (index): `<title>` present and descriptive, meta
  description present, `<link rel="canonical">` present and correct,
  `lang="en"`, single `<h1>`, no heading-order jumps, **zero `<img>` missing
  `alt`** across all pages checked (index/privacy/terms/app).
- **Horizontal overflow**: `scrollWidth` == `innerWidth` at 375/768/1440 on
  every page tested — no overflow anywhere.
- **Hero and pricing sections**: visually inspected at 375/768/1440 (see
  screenshots below) — no text clipping or overlap. Pricing cards stack
  correctly at 375, no horizontal scroll at 768.
- **Reduced motion**: every animation IIFE in `index.html` (hero canvas
  excluded) independently checks `matchMedia('(prefers-reduced-motion:
  reduce)')` and short-circuits to the final/static state — confirmed
  consistent (11 separate guarded blocks). With reduced motion forced, 0
  errors and no stuck-invisible elements.
- **Broken-reveal check**: scrolled the full page height in ~700px steps
  and re-scanned for elements stuck at `opacity:0`. The only zero-opacity
  elements found are intentional: a `.mm-glow` cursor-follow div (hidden
  until mouse movement) and individual paths/circles inside the animated
  flow diagram that cycle through opacity via CSS `@keyframes` (by design,
  each one is 0 for part of its own loop). No `.dw-observe`/`.reveal`/
  `.in-view`-driven element was ever stuck invisible.

## Defects found

### 1. Plan/interval query string is dropped by `/app/` before Clerk loads (real, but out of fix scope)
Every pricing CTA (`Start free trial`, and the four plan "Get started" /
"Contact sales" buttons) links to `/app/?plan=<tier>&interval=month`. Live
network trace shows the app does an immediate client-side navigation from
`/app/?plan=solo&interval=month` → `/app/` (confirmed via
`page.on('framenavigated')`), and neither `localStorage` nor
`sessionStorage` retains the plan/interval afterward. The sign-in screen
itself is correct and unaffected, but a visitor who picks "Shop $199" and
signs up has no evidence the app ever saw which plan they intended —
worth an owner/engineering decision on whether the billing screen should
default to a plan from the URL post-auth.
**Status: NOT FIXED.** This is client-side app routing behavior (React
app bundle / Clerk redirect), not `index.html` or `public/*` — outside the
file scope this pass was authorized to touch. `vercel.json`'s `/app/(.*)`
rewrite does forward query strings correctly, so the drop happens inside
the app's own JS after mount, not at the Vercel routing layer.

### 2. Founder bios are still literal placeholder copy (carried over from `WEBSITE_CLAIMS_AUDIT_2026-09-20.md` #6/#14 — still live today)
`index.html` "The Founders" section (`#team`) renders, verbatim, in
production right now:
- Sterling Chapman: "**Placeholder bio.** Years in IT infrastructure —
  systems integration, networks, and the unglamorous work of making
  records in one system reachable from another. Started DeepWell after
  watching the same filing problem repeat at every company he worked in."
- Hilton Chapman: "**Placeholder bio.** Add a couple of sentences — what he
  did before DeepWell, what he owns day to day, and one thing that makes
  him the person you'd want picking up at 7am."

Screenshot: `site-founder-bios-placeholder.png`.
**Status: NOT FIXED.** This is real, shippable copy about two named real
people (Sterling and Hilton Chapman) — fabricating biographical content
about them is not a "safe" copy fix; it needs the actual bios from the
owner (already tracked as an open owner to-do in
`handoffs/START_HERE_NEXT_CHAT.md` item 6). Flagging again here since it's
the one concrete, currently-live content defect this pass could confirm.

## Findings (not defects — no fix applied)

### 3. Automated contrast checker false positives — verified fine visually
A first-pass programmatic contrast scan (sRGB luminance ratio against each
element's own computed background) flagged two things that turned out to
be measurement artifacts, not real problems:
- The green "Active" / red "Expired" status pills in the "Ask Donovan"
  demo table — the script measured the pill's own translucent
  `rgba(…, 0.15)` fill as if it were opaque instead of compositing it
  against the page background. Visual screenshot (`site-demo-badges.png`)
  shows white-on-solid-color pills with clearly adequate contrast.
- `/app/`'s sign-in screen flagged "DeepWellTechnology" text at a 1.0
  ratio — this is a visually-hidden `alt`-style label with
  `color == background` used behind the logo image for screen readers; it
  is never visually rendered, so it's not a real contrast bug.
No change made; both are non-issues.

### 4. No light theme / no theme toggle exists on the site
The task asked to check light/dark and "the theme toggle," but
`<html data-theme="dark">` is hardcoded in the markup, there is no toggle
control anywhere in the DOM, and no JS ever sets `data-theme="light"`.
Confirmed with Playwright's `colorScheme: 'light'` context emulation —
`document.documentElement.getAttribute('data-theme')` still reads `"dark"`
and the rendered page is pixel-identical to the dark-emulated run. This
looks like an intentional product decision (the whole brand redesign this
month — see `handoffs/BRAND_MOTION_*` docs — is built around a single dark
"well" aesthetic), not a regression, so no fix was attempted. Flagging so
whoever owns the design confirms this is intended permanently, since the
task brief implied a toggle should exist.

### 5. Minor, inconclusive count-up flicker on the "100% — Answers cite the source" hero stat
Polling the DOM directly (no interference) shows the count-up always
settles to and holds "< 3 s / < 5 min / 100%" by ~900–1500ms and stays
there through 3s+. However, deliberately scrolling away from the hero and
back with `mouse.wheel` sometimes leaves the third stat transiently
reading "97%"/"99%" for a moment before self-correcting — it does **not**
get permanently stuck (the "never reaches final string" failure mode the
brief asked about did not reproduce). Root cause not isolated in the time
budget for this pass, and per the brief's instruction not to touch the
micro-animation script blocks without a proven bug, no change was made.
Also note: taking an **element-scoped** Playwright screenshot of `.hero`
itself visibly re-triggers this counter (reproducible 3/3 times) — that is
very likely a Playwright/CDP `scrollIntoViewIfNeeded` artifact of the
screenshot API rather than something a real visitor would ever trigger by
scrolling normally, since plain `window.scrollTo`/`mouse.wheel` scrolling
did not reproduce the same magnitude of reset. Recommend a human spot-check
in a real browser if this is worth chasing further; not re-flagging as a
launch blocker.

## Copy vs. product (cross-checked against `handoffs/START_HERE_NEXT_CHAT.md` and `handoffs/HARD_GATE_2026-09-21.md`)

- **Hard gate (0-doc free preview) claims: all clear.** Searched
  `index.html` for "free"/"trial"/"preview"/"no card" — every occurrence is
  either the real, still-accurate "30-day free trial on Solo, card
  required, cancel anytime" (hero + pricing section, matches
  `HARD_GATE_2026-09-21.md`'s note that this line was already correct and
  untouched), the unrelated "Records Rescue" scanning offer ("we'll digitize
  it free" — a paid-service sample, not the app's document quota), or the
  annual-prepay "one month free" perk. **No stale "no card required" or "3
  documents free" copy exists anywhere on the site.** Nothing to fix here.
- **Privacy policy Stripe wording** (flagged NOT DELIVERED-adjacent in
  yesterday's `WEBSITE_CLAIMS_AUDIT_2026-09-20.md` #2 as saying payments
  were only "planned"): re-checked today, **already fixed** —
  `public/privacy.html` now reads "Stripe, our payment processor, handles
  and stores your card details and processes payments directly," present
  tense, consistent with the live Stripe integration. No action needed.
- Deeper claim-by-claim grading of every marketing sentence against the
  codebase (callback dashboards, email intake, Drive sync, CSV export,
  etc.) was already done exhaustively in
  `handoffs/WEBSITE_CLAIMS_AUDIT_2026-09-20.md` yesterday and this pass
  found no reason to re-litigate items that aren't website-crawl-observable
  (those require code reading, which that audit already did); the founder
  bios (#2 above) is the one item from that list this live crawl could
  independently re-confirm as still outstanding today.

## Fixes applied

**None.** Every structural/technical check (anchors, buttons, mailto,
assets, SEO basics, alt text, heading order, overflow, reduced motion,
contrast on real render) came back clean — there was no broken anchor,
missing alt text, or overflow CSS to safely fix. The two real defects
found (plan-param drop, placeholder founder bios) both require changes
outside this pass's authorized scope (`index.html`/`public/*` copy or CSS
only): one lives in the React app bundle, the other requires real
biographical content from the owner that cannot be safely fabricated.
`index.html` and `public/*` were **not modified**.

## Screenshots

All under `/tmp/claude-0/-home-claude/f16e814e-275c-53e5-82b8-37b855355f08/scratchpad/`:
- `site-founder-bios-placeholder.png` — the one live content defect (#2).
- `app-check.png` — `/app/` Clerk sign-in, confirms spec.
- `site-demo-badges.png`, `site-plans-section.png`, `site-plans-375.png`,
  `site-plans-768.png` — hero/pricing visual checks, all clean (no defect,
  kept for the record).
- `site-_nonexistent_qa_check_404-1440-light.png` — 404 page render.
