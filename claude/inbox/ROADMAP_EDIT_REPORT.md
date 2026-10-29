# Roadmap edit: remove "Fleet and equipment rental" from the roadmap (2026-10-28)

Owner request: the app is good for any industry now, so fleet and equipment rental comes off the roadmap. The industry page stays and is reworded as available now.

Applied under donovan-training/APP_APPLY.lock (taken for the apply only, released after). Patch-based, against the desktop copy read at 04:50Z; the six files matched that read at apply time. Only the two site files in public/industries and api/_lib/support changed in the apply window, and those are this edit. No other lane's files changed. No git, no symlinks, no .env touched. api/ still has 12 top-level files.

## Files and lines changed (original line numbers)

1. docs/roadmap.json
   - Lines 34-35: removed the "fleet-equipment-rental" entry from the "later" array (the uptime-sla line lost its trailing comma).
2. scripts/build-roadmap.mjs
   - Lines 145-146: removed the check that required the fleet roadmap item to exist.
3. index.html
   - Line 2215: "8 planned" changed to "7 planned" (Coming next column).
   - Line 2224: removed the "Fleet and equipment rental" list item from Coming next.
   - Line 2424 (FAQ): "Electrical, plumbing, property-management, and fleet and equipment rental features are marked coming soon" changed to "Electrical, plumbing, and property-management features are marked coming soon".
4. docs/help/18-known-limits-and-coming-soon.md
   - Line 13: removed ", fleet and equipment rental" from the "Coming next" list.
5. api/_lib/support/kb.generated.js
   - Three occurrences of "uptime sla, fleet and equipment rental." changed to "uptime sla." (the help 18 answer, in MODEL_KB and MODEL_KB_PUBLIC). Edited by hand: build-support-kb.mjs cannot run on this device without node_modules (stripe missing). Re-run `npm run build:support-kb` on a machine with node_modules to confirm it produces the same output.
6. public/industries/fleet-equipment-rental.html (reworded as available now, facts from the page only)
   - Status pill: "Coming soon" (class soon) changed to "Available today" (class live, same as the other live industry pages).
   - H1: "Coming for fleet and equipment rental" changed to "DeepWell for fleet and equipment rental".
   - Lede: "...We're building the fleet and rental pieces next." replaced with "Upload them, and DeepWell files them by customer and asset and answers your questions with the original page attached." (both facts are already on the page in the "Works today" cards).
   - Removed the "Coming for fleet and equipment rental" block: its h2, four "Coming for Fleet and rental" cards (unit and VIN records, service and inspection history, rental agreements by unit, registration and warranty dates), and the illustration directly above the h2. Those features were not stated as live anywhere on the page, so they could not be reworded as available now from the page's own facts.

## Left unchanged on purpose
- public/industries/index.html hub entry (line 659) and index.html industries menu tile (line 1574): fleet stays a valid industry.
- scripts/industries-site/lib.mjs line 37 and src/demoAccount/industries.ts: industry entry and hub grouping kept.
- sitemap.xml: page kept.
- "DeepWell Fleet" pricing plan name: not touched.
- No anchors, ids or links pointed at the removed roadmap item. Grep for "fleet" finds no href to a removed anchor.
- claude/inbox/site_clicks/*.csv: audit records, not user-facing.

## Verification
- verify:industries-site: 4421/4421 checks passed.
- verify:site-placement: 308 static checks passed. 3 FAIL, all pre-existing and not related to this edit: index.html, patch-notes.html and public/who.html have no direct "Industries" nav link to /industries/ (the nav uses a dropdown). The browser part could not run (see below).
- verify:site-clicks: exit 0, but the browser part was skipped ("chromium unavailable": missing system libraries on the device VM). Its assertions do not reference the removed item, so none needed updating. Needs a run on a machine with a browser.
- verify:roadmap / build-roadmap --check: fleet failure is gone. It still fails on the untouched base for two pre-existing reasons: (a) index.html's "Industry demo" line differs from roadmap.json (drift, not changed here), and (b) electrical.html, plumbing.html and property-management.html are marked "Coming soon" with no matching roadmap item. Those pages belong to the industry-art lead.
- Re-running `npm run build:roadmap` would also rewrite the "Industry demo" line in index.html to match roadmap.json; I did not do that to keep this edit scoped.

## Ambiguous, left for the owner
- public/who.html (fleet card, around line 531): "Fleet and rental features such as unit and VIN records are not live yet." It is not a roadmap item, so it is unchanged. It conflicts with the removal of the unit and VIN "Coming" cards from the industry page. Decide whether to keep that caveat.
- docs/help/01-what-is-deepwell.md and index-generated kb text: "What is not live yet are the industry-specific features" is generic and unchanged.
- The "8 planned" to "7 planned" count is updated by hand. Confirm it matches what the generator would produce.
