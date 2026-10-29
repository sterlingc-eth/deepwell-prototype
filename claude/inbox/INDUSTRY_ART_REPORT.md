# Industry art report (2026-10-28)

Every industry page now opens with a themed "stage": inline SVG/CSS art built from that industry's own objects, a short animation, and the product moment (documents read -> a question -> the answer -> its source). Pure CSS/SVG/vanilla JS, no libraries.

## How it works
- One generator, not 48 hand edits: `scripts/industries-site/art.mjs` (stage + backdrops), `glyphs.mjs` (47 hand-drawn glyphs), `themes.json` (per-industry palette, glyph, backdrop, choreography), `art.css` / `art.js` (shared, published as `public/industries/ia.css` and `ia.js`).
- All words and numbers on a stage are copied from `data.json` (the demo fixtures): document types, one question, its answer and its source record. Labelled "Example records from the ... sample workspace (<company>, a made-up company)". No accuracy numbers, testimonials or invented claims.
- Hand-written pages keep their content; the stage is inserted idempotently after the hero block (`<!--ia-hero-->` markers) by `build.mjs`. Existing hero art on those pages (other engineers' work) is untouched, so those pages show both; retire the older art if you prefer one hero.
- Hub (`/industries/`): every card gets its themed mark, an accent edge, and a hover/focus pop.
- Hand-written pages without their own demo data borrow the closest sample workspace (plumbing -> Plumbing & HVAC, offices -> IT services, any-business -> Bookkeeping, fleet -> Trucking); the caption names that workspace.
- 12 choreographies (draw, light, pop, stack, fill, scan, merge, drift, orbit, wave, stamp, sweep) x 10 backdrops x 47 glyphs x per-industry accent pairs.

## Behaviour
- The final frame is the default state. Motion exists only under `.ia-arm`, added when IntersectionObserver exists and prefers-reduced-motion is not set. Reduced motion (or no JS): no animation at all, clean static final frame, no pause button.
- Starts when 35% visible, loops twice then rests on the final frame, gentle ambient loops (fan, blink) after, pauses off-screen and when the tab is hidden. A keyboard "Pause/Play" button (aria-pressed) is provided. No sound.
- Stage `role=group` with an aria-label describing the example (documents, question, answer, source); art is aria-hidden; question/answer/source are real text.
- Space is reserved (aspect-ratio art, fixed grid), only opacity/transform/stroke animate: no layout shift.

## Size (added per page)
Stage markup 4-9 KB (max 8.7 KB) + shared ia.css 9.5 KB + ia.js 2.2 KB (cached, one request each) => about 16-21 KB per page, budget 35 KB. Hub: +25 KB of card marks + the same css.

## Theme table
| Industry | Palette (accent / highlight) | Scene (glyph, backdrop, choreography) | Story (documents -> question -> answer) | Stage size |
|---|---|---|---|---|
| Plumbing & HVAC | #80c9db / #dc8c6a | hvac (condenser, rings, merge) | HVAC replacement quote + HVAC invoice -> "When was Reese Fernsby's latest HVAC replacement quote?" -> Latest HVAC replacement quote for Reese Fernsby: 2026-03-30 | 4.0 KB |
| Plumbing | #80b5db / #6adcc9 | plumbing (pipe, grid, draw) | HVAC replacement quote + HVAC invoice -> "When was Reese Fernsby's latest HVAC replacement quote?" -> Latest HVAC replacement quote for Reese Fernsby: 2026-03-30 | 3.9 KB |
| Electrical | #dbc980 / #6ab6dc | electrical (panel, circuit, light) | Electrical invoice + Electrical estimate -> "When was Ellis Zephyrton's latest electrical invoice?" -> Latest electrical invoice for Ellis Zephyrton: 2026-03-07 | 4.2 KB |
| General contractor | #dbb080 / #dc6a9a | general-contractor (crane, hatch, stack) | Remodel proposal + Change order -> "When was Skyler Juniperfield's latest remodel proposal?" -> Latest remodel proposal for Skyler Juniperfield: 2026-02-07 | 4.0 KB |
| Roofing | #db9e80 / #d36adc | roofing (roof, tiles, stack) | Roofing invoice + Insurance claim estimate -> "When was Avery Wickerby's latest roofing invoice?" -> Latest roofing invoice for Avery Wickerby: 2025-08-17 | 4.5 KB |
| Landscaping | #97db80 / #dcd36a | landscaping (tree, topo, fill) | Landscape change order + Landscape estimate -> "When was Marlowe Fernsby's latest landscape change order?" -> Latest landscape change order for Marlowe Fernsby: 2026-03-20 | 4.5 KB |
| Pest control | #badb80 / #dc6a7d | pestcontrol (bug, dots, scan) | Initial inspection report + Pest control invoice -> "When was Parker Lanternby's latest initial inspection report?" -> Latest initial inspection report for Parker Lanternby: 2026-09-20 | 8.2 KB |
| Pool service | #80d2db / #6a9adc | poolservice (pool, waves, wave) | Pool service invoice + Pool repair estimate -> "When was Arden Juniperfield's latest pool service invoice?" -> Latest pool service invoice for Arden Juniperfield: 2026-02-27 | 4.6 KB |
| Cleaning & janitorial | #80dbc9 / #c96adc | cleaning (spray, dots, pop) | Cleaning invoice + Cleaning estimate -> "When was Quinn Pippinwood's latest cleaning invoice?" -> Latest cleaning invoice for Quinn Pippinwood: 2026-01-21 | 8.3 KB |
| Auto repair | #db8086 / #6a9adc | auto (car, rays, draw) | Written estimate + Final invoice -> "When was Emery Juniperfield's latest written estimate?" -> Latest written estimate for Emery Juniperfield: 2026-04-23 | 4.0 KB |
| Real estate | #dbaa80 / #6adcb6 | realty (house, grid, merge) | Buyer advisory + Closing statement -> "When was Tatum Bumblethorn's latest buyer advisory?" -> Latest buyer advisory for Tatum Bumblethorn: 2025-11-30 | 3.7 KB |
| Property management | #80bddb / #ad6adc | property-management (apartments, tiles, light) | Rent statement + Owner statement -> "What are the open charges on RS-1041?" -> Open charges: 3 | 5.1 KB |
| Self storage | #80a6db / #dc6ac0 | storage (units, tiles, stack) | Past due notice + Monthly billing statement -> "What are the days past due on PD-1070?" -> Days past due: 12 | 5.0 KB |
| Hotel | #a180db / #dcb26a | hotel (bell, rays, pop) | Guest folio + Banquet event order -> "What's the room nights on FO-1057?" -> Room nights: 9 | 3.6 KB |
| Event venue | #db80bd / #dcc06a | eventvenue (spots, rays, sweep) | Tour inquiry form + Event rental agreement -> "What is the event type on IQ-1059?" -> Event type: Holiday party | 3.8 KB |
| Marina | #808cdb / #6adca3 | marina (boat, waves, wave) | Fuel dock ticket + Dockage invoice -> "What are the gallons pumped on FD-1049?" -> Gallons pumped: 187 | 4.2 KB |
| Wedding planning | #db80a1 / #dc876a | weddingplan (rings2, topo, orbit) | Installment invoice + Retainer invoice -> "What is the installment number on IV-1052?" -> Installment number: 5 | 4.2 KB |
| Restaurant | #db9780 / #dcc56a | restaurant (cloche, dots, pop) | Banquet event order + Guest feedback note -> "What is the guest count on BEO-1058?" -> Guest count: 203 | 8.0 KB |
| Brewery | #dbba80 / #dc9f6a | brewery (mug, waves, fill) | Keg tracking log + Distributor call log -> "What are the kegs out on KG-1067?" -> Kegs out: 100 | 4.3 KB |
| Food truck | #dba180 / #7d6adc | foodtruck (truck, tiles, drift) | Catering order form + Customer comment log -> "What is the guest count on CO-1062?" -> Guest count: 25 | 4.5 KB |
| Bookkeeping | #80dbad / #dcc56a | bookkeeping (ledger, ledger, draw) | Bank reconciliation report + Bookkeeping engagement letter -> "When was Harper Bumblethorn's latest bank reconciliation report?" -> Latest bank reconciliation report for Harper Bumblethorn: 2025-10-26 | 4.2 KB |
| Law office | #8097db / #addc6a | legal (scales, rings, stamp) | Engagement letter + Legal invoice -> "When was Blair Fernsby's latest engagement letter?" -> Latest engagement letter for Blair Fernsby: 2025-12-23 | 3.8 KB |
| Insurance agency | #80bddb / #6adc7d | insagency (shield, tiles, draw) | Premium invoice + Declarations page -> "When was Sage Tumbleby's latest premium invoice?" -> Latest premium invoice for Sage Tumbleby: 2026-02-25 | 4.2 KB |
| IT services | #9780db / #6adcd3 | msp (rack, circuit, light) | Account manager note + Managed services invoice -> "When was Quinn Marbleworth's latest account manager note?" -> Latest account manager note for Quinn Marbleworth: 2026-03-27 | 3.9 KB |
| Film production | #b5db80 / #dc6adc | filmprod (clap, rays, stamp) | Crew deal memo + Location release -> "When was Finley Thistledown's latest crew deal memo?" -> Latest crew deal memo for Finley Thistledown: 2026-02-02 | 3.7 KB |
| Photo studio | #b580db / #6ac0dc | photostudio (camera, rings, scan) | Photography services contract + Photography invoice -> "When was Quinn Puddleby's latest photography services contract?" -> Latest photography services contract for Quinn Puddleby: 2025-10-30 | 3.9 KB |
| Tutoring | #d2db80 / #dc6ab6 | tutoring (book, ledger, drift) | Progress report + Enrollment agreement -> "When was Rowan Honeyvale's latest progress report?" -> Latest progress report for Rowan Honeyvale: 2025-10-10 | 3.4 KB |
| Medical office | #80dbcf / #dc6a7d | medicaloffice (cross, grid, draw) | Superbill + Cms 1500 claim -> "When was Reese Starlingford's latest superbill?" -> Latest superbill for Reese Starlingford: 2025-07-28 | 3.3 KB |
| Dental office | #808fdb / #876adc | dentaloffice (tooth, tiles, pop) | Ada dental claim + Patient ledger statement -> "When was Quinn Lanternby's latest ada dental claim?" -> Latest ada dental claim for Quinn Lanternby: 2025-12-31 | 4.4 KB |
| Dental lab | #80dbc9 / #746adc | dentallabco (crown, hatch, scan) | Monthly lab statement + Case quote -> "When was Tatum Quillfeather's latest monthly lab statement?" -> Latest monthly lab statement for Tatum Quillfeather: 2026-02-25 | 3.9 KB |
| Medical billing | #80db9e / #6a9adc | medbillingco (claim, ledger, sweep) | Client invoice + Claim batch report -> "What is the fee pct on INV-1053?" -> Fee pct: 3 | 3.6 KB |
| Veterinary clinic | #80db80 / #dc9f6a | vetclinic (paw, topo, orbit) | Treatment estimate + Client invoice -> "When was Remy Bramblewood's latest treatment estimate?" -> Latest treatment estimate for Remy Bramblewood: 2026-01-11 | 4.3 KB |
| Pet grooming | #db80db / #c9dc6a | petgroomco (dog, dots, drift) | Grooming receipt + Grooming ticket -> "When was Remy Copperkettle's latest grooming receipt?" -> Latest grooming receipt for Remy Copperkettle: 2026-06-13 | 8.1 KB |
| Gym & fitness | #db8680 / #6adc6a | gymfit (dumbbell, rays, fill) | Payment receipt + Failed payment notice -> "When was Parker Bumblethorn's latest payment receipt?" -> Latest payment receipt for Parker Bumblethorn: 2026-04-28 | 3.7 KB |
| Salon & spa | #db80ad / #6adca3 | salonspa (mirror, rings, sweep) | Sales receipt + Bridal party invoice -> "When was Remy Gingerbrook's latest sales receipt?" -> Latest sales receipt for Remy Gingerbrook: 2025-10-05 | 3.9 KB |
| Daycare center | #b5db80 / #6adc74 | daycarecenter (blocks, tiles, stack) | Tuition invoice + Family account statement -> "What are the days per week on TU-1067?" -> Days per week: 5 | 4.5 KB |
| Nonprofit | #db808f / #addc6a | nonprofit (folder, topo, drift) | Donation receipt + Event registration receipt -> "What is the fund on DON-1061?" -> Fund: Programs | 4.0 KB |
| Grant-funded nonprofit | #a6db80 / #9a6adc | grantnp (letter, ledger, fill) | Vendor invoice + Grant ledger statement -> "When was Avery Rosethorn's latest vendor invoice?" -> Latest vendor invoice for Avery Rosethorn: 2026-04-03 | 3.9 KB |
| Church | #8080db / #dcc96a | church (church, rays, light) | Offering receipt + Annual contribution statement -> "What is the fund on GV-1051?" -> Fund: Benevolence | 3.7 KB |
| Records office | #80a1db / #dc6a6a | policerecords (badge, hatch, stamp) | Public records request + Impound tow sheet -> "When was Hayden Bumblethorn's latest public records request?" -> Latest public records request for Hayden Bumblethorn: 2025-11-01 | 3.8 KB |
| Trucking | #83db80 / #6ab6dc | trucking (semi, hatch, drift) | Freight invoice + Bill of lading -> "When was Emery Moonpenny's latest freight invoice?" -> Latest freight invoice for Emery Moonpenny: 2025-12-02 | 3.9 KB |
| Warehouse | #ccdb80 / #6adcd3 | warehouse (racks, grid, stack) | Return authorization + Packing slip -> "When was Casey Gingerbrook's latest return authorization?" -> Latest return authorization for Casey Gingerbrook: 2026-03-27 | 4.3 KB |
| Manufacturing | #80cfdb / #c0dc6a | mfgqa (gear, circuit, orbit) | Production traveler + Certificate of conformance -> "What is the job number on WO-1048?" -> Job number: 11333 | 4.2 KB |
| Feed & farm store | #addb80 / #dcad6a | feedstore (sack, topo, pop) | Bulk delivery ticket + Charge account statement -> "When was Hayden Lanternby's latest bulk delivery ticket?" -> Latest bulk delivery ticket for Hayden Lanternby: 2026-07-14 | 4.3 KB |
| Offices | #80dbbd / #7ddc6a | offices (cabinet, ledger, scan) | Account manager note + Managed services invoice -> "When was Quinn Marbleworth's latest account manager note?" -> Latest account manager note for Quinn Marbleworth: 2026-03-27 | 3.6 KB |
| Any business | #dbbd80 / #7ddc6a | any-business (mix, dots, orbit) | Bank reconciliation report + Bookkeeping engagement letter -> "When was Harper Bumblethorn's latest bank reconciliation report?" -> Latest bank reconciliation report for Harper Bumblethorn: 2025-10-26 | 8.7 KB |
| Fleet and equipment rental | #dbcc80 / #d3dc6a | fleet-equipment-rental (excavator, hatch, wave) | Freight invoice + Bill of lading -> "When was Emery Moonpenny's latest freight invoice?" -> Latest freight invoice for Emery Moonpenny: 2025-12-02 | 3.8 KB |

## Tests (real Chromium via Playwright, cloud container; built on a copy of the current desktop tree)
- verify:industries-site 7804/7804 (includes new art checks); verify:industry-art 3268/3268: a theme per industry, unique scene ids, unique palettes (hue pairs >= 30 deg apart in total), unique glyphs, reduced-motion fallback present, all animation inside prefers-reduced-motion:no-preference, aria markup, facts match data.json, demo link `/demo/?industry=<slug>` and Any Business, One App breadcrumb and nav intact, size budget.
- verify:site-placement 604 pass / 3 fail: the 3 are pre-existing and identical on the untouched tree (index.html, patch-notes.html, who.html nav says "Any Business, One App", the check wants "Industries"). New checks (stage fits, no shift, reduced motion, nav at 1100 breakpoint, hub marks at 390) all pass.
- verify:site-clicks --quick: 102/102 new stage rows pass (pause button Enter/Space, demo link lands on /demo/?industry=). 156 other rows fail only because built entry pages (/app, /m, /expenses) are not in the cloud copy; same on the untouched tree.
- Animated QA, 17 pages (all 9 hand-written + realty, brewery, marina, trucking, church, legal, msp, photostudio) x 4 viewports (1440, 820, 390, 360) = 68 runs: start/mid/end frames differ, story hidden at start / documents in at mid / answer+source at end, no layout shift, CLS < 0.02, pauses off-screen and resumes, Tab reaches Pause with a visible focus ring, Enter pauses, Space resumes, reduced motion = zero animations. 68/68 pass. 3 first-pass long-task flags (205-326 ms) happened only under 6 parallel browsers and passed when rerun alone; at 4x CPU throttling the longest task was 128 ms.
- All 47 pages x widths 1440/1101/1100/820/390/360 in reduced motion: 282/282 (no horizontal scroll, stage inside viewport, no clipped chips, nav and breadcrumb present, no console errors).
- Timing at 4x CPU slowdown: DOMContentLoaded 183-243 ms, load 184-292 ms, LCP 196-260 ms.
- Screenshots: `claude/inbox/industry_art/` (`<page>_<viewport>_start|mid|end|reduced.jpg`, hub_1440/390.png, chor.png = 12 choreographies mid-animation).
- Honest note: QA was run by a separate harness (qa.cjs, written independently of the builder code path) by the same lead; no second agent was available in this session.
