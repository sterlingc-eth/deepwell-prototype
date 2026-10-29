# Industry art review redo (2026-10-29)

## Done
1. Single hero: on the 9 hand-written pages the older hero art is retired (sm-amb ambient scene in hvac, electrical, property-management, plumbing, fleet-equipment-rental; np-scene figure in contractors, nonprofits, offices, any-business) and the sm-sc body scene directly under the stage is removed (the 5 sm pages). Done in the generator (`retireOldHero` in scripts/industries-site/art.mjs, idempotent), so rebuilds keep it.
2. Contrast: `palette()` now lifts accent lightness (hue kept) until each accent is >= 4.5:1 on both stage background and surface. The 3 offenders (dentallabco 3.95, foodtruck 4.25, grantnp 4.46, all the second accent) and a few borderline-on-surface themes are fixed; all themes now >= 4.5.
3. Workspace labels: fleet-equipment-rental now borrows `auto` (was trucking); plumbing leads with plumbing docs (Drain cleaning ticket, Maintenance agreement, Tune up checklist) and a question taken from the real Blair Starlingford drain ticket (Feet cabled: 115) stored as `story` in themes.json (fixtures have no sourced plumbing question).
4. Question shape: pickStory(d, key) rotates shape by theme position (total / field / clause / latest-date). Now 23 "total on", 20 "when was", a few field-style, 1 plumbing; limited by the fixtures (few field/clause questions exist). verify-industry-art passes `key` and accepts fixed stories.
5. Extra task, who.html retired: vercel.json permanent redirects /who.html and /who -> /industries/; removed from sitemap.xml; index.html footer link removed; back-links on any-business/contractors/nonprofits/offices now "Back to all industries" -> /industries/ (via generator injectStage); who.html removed from verify-site-clicks page lists. public/who.html NOT deleted: delete is not permitted in this VM (redirect wins). Please delete it by hand.

## Checks (run in a scratch copy, then applied; live repo re-checked for art)
- verify:industry-art 3268/3268 (live repo after apply: passes).
- verify:industries-site 7841/7841.
- verify:site-placement: 3 failures, all pre-existing (index.html, patch-notes.html, who.html "primary nav has an Industries link"; declutter removed that link, the verifier is stale) + playwright missing on device.
- verify:site-clicks --quick: static 4294 ok, 1 FAIL pre-existing: home copy says "Pick from 43 industries" (Industry demo tile in index.html), against the no-counts rule. Not touched. Browser part skipped (no Playwright on device).
- Not run: browser/visual check of the single hero; run `node scripts/verify-site-clicks.mjs --dist dist` on the desktop.

## Process
Work copy in donovan-training/_art_redo_work/w, manifest in _art_redo_work/APPLY_MANIFEST.md (no live file was newer than the work start, so no 3-way merge needed). No git, no symlinks in the app repo, no secrets. APP_APPLY.lock could not be deleted (Operation not permitted); it is overwritten with "DONE" text, delete it by hand.

## Changed files
- index.html
- vercel.json
- public/industries/any-business.html
- public/industries/brewery.html
- public/industries/church.html
- public/industries/contractors.html
- public/industries/daycarecenter.html
- public/industries/dentallabco.html
- public/industries/dentaloffice.html
- public/industries/electrical.html
- public/industries/eventvenue.html
- public/industries/feedstore.html
- public/industries/fleet-equipment-rental.html
- public/industries/foodtruck.html
- public/industries/grantnp.html
- public/industries/hotel.html
- public/industries/hvac.html
- public/industries/index.html
- public/industries/insagency.html
- public/industries/marina.html
- public/industries/medbillingco.html
- public/industries/medicaloffice.html
- public/industries/mfgqa.html
- public/industries/msp.html
- public/industries/nonprofits.html
- public/industries/offices.html
- public/industries/pestcontrol.html
- public/industries/plumbing.html
- public/industries/policerecords.html
- public/industries/poolservice.html
- public/industries/property-management.html
- public/industries/realty.html
- public/industries/restaurant.html
- public/industries/salonspa.html
- public/industries/tutoring.html
- public/industries/vetclinic.html
- public/sitemap.xml
- scripts/industries-site/art.mjs
- scripts/industries-site/themes.json
- scripts/verify-industry-art.mjs
- scripts/verify-site-clicks.mjs
