# Site clicks report, 2026-10-27

Scope: every clickable element on the public marketing site (homepage, /who.html, /industries/ hub + 47 industry pages, /get, legal/status pages, patch notes), at 1440 and 390 px, served with the vercel.json redirects and rewrites.

## Root causes (what was dead)
1. **"Try it" went to the wrong place.** The shared nav link "Try it" (every page) and the "Try a question" buttons on /who.html and four industry pages pointed at `#demo` or `/#demo`, the homepage's inline canned sample. That sample only shows canned answers and dead-ends. 107 Try links were affected.
2. **The nav dropdown "Any Business, One App" listed only 9 pages** (3 role links, a hub link, 8 old industry pages). It looked like a short, partly-empty list while the owner has 43 active industries. Nothing was greyed out in code (the `.tag.soon` style exists in the CSS but no item used it); it was simply incomplete.
3. The homepage hero had no "Try the demo" button at all. The only one was in the "Find your industry" section.
4. /demo/ itself works. Live check: https://deepwelltechnology.com/demo/ returns 200 and its bundle contains `VITE_DEEPWELL_DEMO:"true"`. **The demo page only exists in a build when the Vercel env var `VITE_DEEPWELL_DEMO` is `true`** (vite.config.ts). It is set in production today; do not remove it or /demo returns 404 and every Try button dies. verify-site-clicks checks the rewrite, demo/index.html and the vite gate, and loads /demo/ for real when run with `--dist`.

## Decisions
- **Homepage "Try it / Ask Donovan a question" block REMOVED entirely** (owner correction): industry chips, Ask box, example question chips, Answer card with sources, Example documents, plus its JSON data (`tryit-data`), its JS (~135 lines) and its dedicated CSS. No teaser kept.
- **Kept:** the following block "One system. Three views." (front desk / in the field / owner). It now sits in `<section id="views">` (was inside `#demo`). The owner may remove it.
- **Homepage funnel:** hero now has a primary **Try the demo** (-> /demo/), then Start free trial, then See how it works (hidden at phone width only, so the "Find your industry" tiles stay on the first screen, which verify:site-placement requires). Nav "Try it" -> /demo/. "Find your industry" section left as the other engineer built it (Try the demo -> /demo/, See all industries -> /industries/).
- Industry pages: nav "Try it" -> /demo/; each generated page already had "Try the <industry> demo" -> /demo/?industry=<slug>. "Try a question" on contractors / nonprofits -> /demo/?industry=general-contractor / nonprofit; offices and any-business -> /demo/ (no matching demo slug). /who.html "Try a question" per industry -> matching slug where one exists, else /demo/.
- **Dropdown "Any Business, One App"** now lists: By role (3), By industry: All 43 industries (hub, first), Every industry one app, Any business, then the same 7 groups as the hub with all 43 industries each linking to its /industries/<page>, then More guides (Offices, Fleet and equipment rental, Plumbing). 52 links, every one live. The 5 industries with hand-written pages keep their one-line descriptions. Generated once from the hub grouping by `node scripts/industries-site/build.mjs` (new `syncNav`), applied to 51 files (index, patch-notes, who, every public/industries page), so it cannot drift again. Opens by click/tap and keyboard (Enter/Space/Down, arrows, Esc returns focus, Tab/outside click closes). On phones the opened Menu panel now scrolls (`max-height:100dvh-68px; overflow-y:auto`), otherwise the long list was unreachable below the screen.
- "Coming soon"/disabled on industries: **none found anywhere** (nav, hub, homepage, industry pages, footer, pricing, who). Remaining "Coming soon" labels are feature notes, left as is (list below).

## Feature "Coming soon" notes left in place (not industries)
index.html: "Email & folder upload" (how it works), "Callback analytics for field-service teams" (owner view), Email intake, Daily off-site backups 30-day restore, Google Drive sync, Branch scoping, 99.5% uptime SLA, Backups every 6 hours, Per-company restore (pricing tiers), plus the annual-prepay note. public/integrations.html: "Coming soon" section (Google Drive, Gmail).

## Audit method
`scripts/verify-site-clicks.mjs` (new, in verify:all) parses 57 pages; checks every `<a>` (href present, not `#`/empty/javascript:, anchor ids exist on the target page, path resolves through vercel.json redirects/rewrites or a file, mailto/tel valid, `target=_blank` has rel noopener); every "Try..." control must go to /demo/ or /demo/?industry=<real slug>; dropdown must link all 43 industries + hub with no disabled/soon item; no leftover homepage sample, no `#demo` link; sitemap entries resolve; /demo routing (`/demo`, `/demo/`, `/demo/?industry=realty`) resolves. With Playwright it then, at 1440 and 390 on all 57 pages: loads each page (no console/page errors), checks nav/hero/main buttons are enabled and not covered (elementFromPoint), clicks or taps EVERY button/summary/[role=button] outside the dropdown and records the effect (204 clicks), opens the dropdown by click/tap and keyboard on /, /industries/, an industry page and /who.html, checks Esc and outside-click close, last item reachable, clicks every dropdown link, and clicks every Try control and checks it lands on a loading /demo/ page.

Result after fixes: **5103 checks, 0 failures, 2 warnings** (the /get "Copy link" button shows a browser prompt when the clipboard is blocked in headless, fine). Full rows: `claude/inbox/site_clicks/audit_all_after.csv`. Baseline failures: `audit_before_failures.csv` (115).

### Audit table: issues found (before) and fixes
| Page(s) | Element | Expected | Actual (before) | Fix |
|---|---|---|---|---|
| /get | Email it to me | valid mailto | mailto:?subject=DeepWell%20Mobile&body=Open%20this%20on%20your%20phone%3A%20https%3A%2F%2Fdeepwelltechnology.c | Intentional recipient-less share mailto (opens the phone mail app to email the link to yourself). Check now accepts it; no change to the page. |
| / | "Try it" nav link and "Try a question" buttons | /demo/ or /demo/?industry=<slug> | #demo | point the button at the demo |
| /industries/, /industries/any-business.html, /industries/any-business.html and 53 more (56 total) | "Try it" nav link and "Try a question" buttons | /demo/ or /demo/?industry=<slug> | /#demo | point the button at the demo |
| /, /industries/, /industries/any-business.html and 48 more (51 total) | Any Business, One App dropdown | links all 43 industries + hub | 38 missing | Menu regenerated from the hub grouping (43 industries + guides) in 51 files by scripts/industries-site/build.mjs (syncNav). |
| /integrations.html, /privacy.html, /security.html and 1 more (4 total) | Any Business, One App | dropdown present | missing | add dropdown |
| / | inline Try it sample | removed from homepage | still present | Section, data, JS and CSS removed. |
| / | #demo links | none | 1 link(s) to removed #demo | Link now /demo/. |

Everything else (about 4,500 other links: logo -> `/`, nav items, footer links, pricing / Log in / Start free trial / Contact sales / Talk to us / Send a sample box mailtos, anchors) already resolved. Logo goes to `/` (or `#top` on the homepage), CTAs go to /app/?plan=..., #contact, #plans, mailto:hello@deepwelltechnology.com.

## Screenshots (claude/inbox/site_clicks/)
- nav_dropdown_open_1440.png, nav_dropdown_open_390.png, nav_dropdown_open_industry_page_1440.png / _390.png
- try_destination_home_1440/390.png, try_destination_hub_1440.png (the demo page after clicking Try)
- home_hero_1440/390.png, home_find_industry_1440/390.png (after); BEFORE_home_hero_*.png, BEFORE_try_it_section_*.png, BEFORE_try_it_section_full_*.png (before)

## Verification
- verify:site-clicks: OK (5103 checks incl. browser). Static-only run: OK.
- verify:industries-site: all checks pass (the single "api/ has exactly 12 top-level files" line fails only in the scratch copy that has no api/; it is untouched in the repo, still 12).
- verify:site-placement: 544 passed, 0 failed.
- Built with `VITE_DEEPWELL_DEMO=true vite build` (see Deviations) and loaded /demo/ and /demo/?industry=realty in Chromium: real demo UI, 43 industries selectable.

## What the owner must push
Commit and push these files (all applied to the repo already, see manifest): index.html, patch-notes.html, public/who.html, public/industries/*.html (50 files incl. hub), scripts/industries-site/build.mjs + lib.mjs, scripts/verify-site-clicks.mjs (new), package.json, scripts/build-tryit.mjs + verify-tryit.mjs + verify-website-demo.mjs (now retired stubs), claude/inbox/. vercel.json is unchanged: the /demo, /get, /m, /app rewrites already exist. Keep `VITE_DEEPWELL_DEMO=true` in the Vercel project env (Production). After deploy, smoke test https://deepwelltechnology.com/demo/?industry=hotel and the Try it nav link.

## Housekeeping notes
- package.json: removed `build:tryit` and `verify:tryit` (and from verify:all), added `verify:site-clicks` (last in verify:all). `verify:website-demo` still exists but is a stub because the sample it tested is gone. `src/data/tryIt.json` is now unused (left in place, nothing reads it).
- Leftover unused CSS in index.html (.ask, .q, .demo* base rules) was left because the same selectors are shared with other sections; the dedicated Try-it CSS blocks were removed.
- public/who.html and industry pages still carry unused `.status-pill.soon` / `.card.soon` CSS definitions (no markup uses them).
- Not changed (not clickable-related): the 8-tile "Find your industry" grid only shows 8 of 43 by design of the other engineer; "See all industries" leads to the full hub.

## Deviations / process
- Playbook A1-A6 followed: APP_APPLY.lock taken and released, work done in a scratch copy under donovan-training/_links_work/, only the listed files applied, md5 manifest in `_links_work/APPLY_MANIFEST.md`, no git in the repo, no symlinks, no .env touched, api/ untouched.
- The desktop node_modules is a Windows install and the device VM has no npm registry access, so the app could not be built on the device. The build and Playwright run happened in the cloud container on a copy of the sources (npm ci there), serving the built dist with the vercel.json redirect/rewrite rules. The verify script also runs without a build (serves sources) and with `--dist <dir>`. Run the full browser version on the desktop with `node scripts/verify-site-clicks.mjs --dist dist` after `npm run build` (needs VITE_DEEPWELL_DEMO=true).

## Addendum 2026-10-28: "Any Business, One App" heading, mega-menu, demo back-link
- Hub H1 is exactly "Any Business, One App"; title/og:title "Any Business, One App — DeepWell Technology"; meta description and subline rewritten with no number. All industry pages (hand-written + generated) carry a "Any Business, One App" breadcrumb link to /industries/ above their own H1. Done in scripts/industries-site (lib.mjs, new mega.css) and regenerated; `build.mjs` also syncs the menu + CSS into every page.
- Nav dropdown redesigned as a mega-menu: 7 category headings (each links to its hub section, e.g. /industries/#g-trades) with at most 5 common industries each, one "Browse all industries" link and one "Don't see your business? ... Try the demo" line. Stacked, scrollable, 44px targets on phones (inside the existing drawer on the homepage). Header height unchanged (69px). No counts anywhere (homepage Industry-demo tile, hub count line, nav).
- De-cluttered (removed): the 52-link flat list; "All 43 industries" and "Every industry, one app" items (same destination as the Industries top-bar link / hub); the By-role links (who.html anchors); the "Any business" and "More guides" items (offices, fleet, plumbing; still on the hub); every per-item description line; "Showing N of M industries" hub counter. Remaining overlap by design: top bar already has "Industries" and "Try it"; on phones those top-bar links are hidden, so the menu's Browse-all and Try-the-demo are the only route.
- /demo/: new src/demo/HomeBackBar.tsx (logo + "Back to home", plain `<a href="/">`, 44px+, focus ring) rendered once in DemoApp.tsx and on the "not available" fallback in main.tsx; no other demo error/limit screens exist. The demo header keeps its own wordmark (minor logo repeat; left alone to avoid touching the sandbox's header edits).
- verify-site-clicks: now flags duplicate hrefs inside the dropdown, checks category headings -> hub anchors, <=5 per category, no numbers, hub H1/title, no industry counts in hub/home copy, back-link wired; browser part checks mega-menu open/h-scroll and (with --dist) the /demo/ back link at 1440/820/390 incl. click-to-/. New flags: --quick (page subset), --trace. verify-industries-site asserts new H1/title/breadcrumbs; verify-site-placement reads tile notes from the generator.
- Verified (Playwright, shots in claude/inbox/site_clicks/): hub H1/title; breadcrumb on hvac/hotel/any-business/plumbing; menu at 1440/1250/1100/820/390/360 with no h-scroll, no duplicate links, Esc closes; /demo/ and /demo/?industry=hvac back link at 1440/820/390: >=44px, not covering controls, click lands on /. verify:industries-site 4499/4499, verify:site-placement 534/0, verify:site-clicks static OK + browser (--quick, dist built with demo flag).
