# Industry expansion — electrical, plumbing, property management (2026-09-21)

Workstream C of `handoffs/DONOVAN_ANALYTICS_BRIEF_2026-09-21.md`. Runs
alongside Workstream A (Donovan analytics) and Workstream B (600-doc
business corpus) on disjoint files.

## Executive summary

DeepWell's HVAC schema generalizes cleanly to electrical and plumbing —
same document set (work order, invoice, permit, inspection, warranty
registration), same field-service software landscape (ServiceTitan,
Housecall Pro serve all three trades today), same buyer (a 1–15-person
trade shop owner), same pricing model (per-technician tiers). Both need
one or two new document types and a handful of new nameplate fields, no
new entities. **Recommended order: electrical, then plumbing, then
property management.**

Property management is a real pivot, not a generalization: it needs new
`unit`/`lease`/`tenant`/`vendor` entities HVAC has no equivalent for, a
different buyer (a property manager, not a trade-business owner), a
different pricing unit (per door, not per technician), and it competes
with entrenched all-in-one suites (AppFolio, Buildium, Yardi) rather than
point-solution field-service tools. It's the most differentiated
opportunity but the most expensive to build — hence third.

Delivered: this analysis; type-checking domain scaffolds for all three
(`src/domains/electrical`, `plumbing`, `property`) registered in a new
`src/domains/registry.ts`, inert until a domain switch exists; an
"Industries" nav dropdown on `index.html`; four short pages under
`public/industries/`; and an updated `sitemap.xml`. Nothing here changes
what HVAC customers see or what the product claims to do today.

## Research basis

Brief search (6 queries, WebSearch): field-service software landscape for
electricians/plumbers (ServiceTitan, Housecall Pro, and trade-specific
tools dominate all three trades — no single vertical has an incumbent
DeepWell would need to displace the way property management has AppFolio/
Buildium/Yardi); electrical panel-schedule/NEC-compliance software;
plumbing permit/backflow-testing/warranty conventions; property-management
document and compliance tooling (lease, unit-turn, vendor COI tracking).
Combined with the existing HVAC domain code as the generalization baseline.
Sources: general trade/PropTech industry coverage, no paywalled or
authoritative-only sources were needed for directional figures (warranty
term lengths, code-cycle cadence) — those are marked "typical" in the
scaffolds' `rules.ts`, not contractual.

---

## 1. Electrical

**ICP.** Residential/light-commercial electrical contractors, 1–15
electricians, state-licensed (journeyman/master electrician), doing
service calls, panel upgrades, EV charger and generator installs, and
new-construction rough-in/trim. Same shop size and buying motion as
DeepWell's current HVAC customer — often the *same* shop, since many
HVAC companies also run an electrical division (the site's existing
"Where it works" section already lists "HVAC, plumbing, electrical &
more" as one trade-business category).

**Document set** (✓ = identical to hvac's canonical 15 types; ▲ = new).
work order ✓ · invoice ✓ · permit ✓ · inspection report ✓ (rough-in +
final, AFCI/GFCI test results) · warranty registration ✓ · nameplate
photo ✓ (panel/generator nameplate) · maintenance agreement ✓ (generator
service contracts) · service ticket ✓ · dispatch note ✓ · proposal/quote
✓ · purchase order ✓ · equipment record ✓ · correspondence ✓ · other ✓ ·
**▲ panel schedule** (maps a panel's breakers to circuits/loads — no hvac
equivalent; the closest analog, nameplate-photo, captures one equipment
record, not a whole panel's circuit map).

**Top 20 questions.**
1. How many customers have a 200-amp panel installed?
2. Which customers still have a 100-amp panel?
3. How many panel upgrades did we do this year?
4. Is the panel at [address] still under warranty?
5. Who installed the generator at [address] and when?
6. How many customers have a Generac generator?
7. List customers with EV chargers installed.
8. How many EV charger installs did we do in Chandler?
9. Which jobs are missing a final inspection?
10. How many open permits do we have?
11. What's the panel's main breaker rating at [address]?
12. How many customers in Mesa have had a service upgrade?
13. Which customers have generators under a maintenance agreement?
14. How many callbacks did we have on panel jobs last month?
15. List all customers with Square D panels.
16. How many customers are still on a fuse box, not a breaker panel?
17. What permit number was pulled for the job at [address]?
18. How many inspections failed on the first attempt this year?
19. Which technician installed the most panels this quarter?
20. How many customers have AFCI/GFCI protection documented?

**Schema deltas from hvac.** `equipment` gains `amperage`/`voltage`/`phase`
in place of `tonnage`/`refrigerant`; `equipmentType` values become panel /
sub-panel / generator / EV charger / disconnect / meter instead of
furnace / AC / heat pump. No new entity types — `property`, `customer`,
`technician`, `service` carry over unchanged.

**Warranty/compliance.** Labor warranty typically 1–2 years
(contractor-set, not code-mandated). Manufacturer terms vary by part:
breakers ~1yr, some panel enclosures up to 10yr, generators ~5yr (often
capped by run-hours), EV chargers 2–3yr. Compliance is permit + inspection
pairing (identical mechanism to hvac, no schema change) plus NEC
code-cycle awareness (NEC updates every 3 years; a job's governing edition
is fixed at permit issuance — a good "is this still compliant" feature,
not built here). See `src/domains/electrical/rules.ts`.

**Pricing fit.** Same technician-count tiers work unchanged. Average
electrical ticket (a panel upgrade runs $2,500–4,000) is comparably high
to HVAC's, so the "one prevented $300–600 callback pays for the plan"
framing holds — a comeback on a panel job (a tripped breaker, a failed
inspection re-visit) is exactly this kind of avoidable cost.

---

## 2. Plumbing

**ICP.** Residential/light-commercial plumbing and water-heater/drain
specialists, 1–15 plumbers — the trade most often already bundled with
HVAC in a single shop (again, the site's own existing copy groups them).

**Document set.** work order ✓ · invoice ✓ · warranty registration ✓
(tank/tankless water heater) · startup sheet ✓ (water heater commissioning)
· permit ✓ (plumbing + gas line) · inspection report ✓ (rough-in/final,
gas pressure test) · nameplate photo ✓ · maintenance agreement ✓ ·
service ticket ✓ · dispatch note ✓ · proposal/quote ✓ · purchase order ✓ ·
equipment record ✓ · correspondence ✓ · other ✓ · **▲ backflow test
certificate** (most jurisdictions require annual or biennial certified
testing reported to the water utility — a due-date record structurally
identical to warranty-expiry tracking DeepWell already does) · **▲
sewer/drain camera report** (a video + notes deliverable, increasingly
standard for diagnosis and pre-sale inspections).

**Top 20 questions.**
1. Which backflow devices are due for testing this month?
2. How many backflow tests did we complete last year?
3. Is the water heater at [address] still under warranty?
4. How many tankless water heaters have we installed?
5. List customers with a Rheem water heater.
6. How many gas line permits are still open?
7. Which customers had a sewer camera inspection in the last 12 months?
8. How many water heaters are older than 10 years?
9. How many customers in Gilbert have a sump pump installed?
10. What size water heater is installed at [address]?
11. How many drain cleaning calls did we do this month?
12. Which customers are on a maintenance agreement for their water heater?
13. List all open plumbing permits by city.
14. How many repeat drain-clog calls did [customer] have this year?
15. Which backflow devices failed their last test?
16. How many water heater replacements did we do in Tucson?
17. Who tested the backflow device at [address] and when?
18. How many customers have a tank vs. tankless water heater?
19. Which technician installed the most water heaters this quarter?
20. How many gas leaks were reported and resolved this year?

**Schema deltas from hvac.** `equipment` adds `fixtureType`/`applianceType`
and a `nextTestDue` date (same shape as `warrantyExpiry`, reused for a
recurring compliance date instead of a one-time coverage date) —
`equipmentType` values become water heater (tank/tankless), sump pump,
backflow preventer/RPZ device, garbage disposal, sewer line, gas line,
fixture. No new entity types.

**Warranty/compliance.** Tank water heater: ~6–12yr manufacturer tank
warranty, typically 1yr labor. Tankless: heat exchanger often 10–15yr,
parts ~5yr, labor ~1yr. The standout feature: backflow devices need
annual (sometimes biennial) certified testing filed with the water
purveyor — the exact same "due date, flag when it lapses" mechanism as
warranty-expiry, just pointed at a different field. See
`src/domains/plumbing/rules.ts`.

**Pricing fit.** Same tiers; ticket mix (small drain calls, larger water
heater replacements) is comparable to HVAC's. Same ROI story.

---

## 3. Property management

**ICP.** Small-to-mid property management companies or owner-operators
managing 20–500 doors (single-family rentals, small multifamily, HOAs).
**Different buyer than the other two**: a property manager or maintenance
coordinator, not a trade-business owner — and the first vertical where
the buyer has no field technicians of their own (they dispatch vendors).

**Document set.** Two genuinely new types (lease, move-in/-out inspection)
plus vendor compliance; the rest carries over from hvac's "customer +
equipment" shape almost unchanged. **▲ lease agreement · ▲ move-in
inspection · ▲ move-out inspection · ▲ certificate of insurance (vendor
COI)** · work order ✓ (unit turn/make-ready/maintenance) · invoice ✓ ·
warranty registration ✓ (per-unit appliance) · service ticket ✓ ·
purchase order ✓ · inspection report ✓ (code/HOA compliance) ·
correspondence ✓ (tenant/owner communication) · other ✓.

**Top 20 questions.**
1. How many units do we manage in Mesa?
2. Which vendors have an expired certificate of insurance?
3. How many leases expire in the next 60 days?
4. Is the water heater in unit 4B under warranty?
5. How many maintenance requests did building [X] have this month?
6. Which units haven't had a move-out inspection filed?
7. How many make-ready work orders are open right now?
8. List all appliances older than 10 years across our portfolio.
9. Which vendors worked on property [X] in the last year?
10. How many units are currently vacant?
11. What's the lease end date for unit [X]?
12. How many HVAC units are we responsible for across the portfolio?
13. Which tenants have an open maintenance ticket?
14. How many turn requests did we complete last month?
15. List properties with an expiring HOA inspection.
16. How many security deposits are we currently holding?
17. Which unit had the most maintenance calls this year?
18. How many appliance warranties expire this quarter?
19. What vendor installed the water heater in unit [X]?
20. How many COIs are expiring in the next 30 days?

**Schema deltas from hvac — the largest of the three.** New entity types
with no hvac equivalent: `unit` (an apartment/suite inside a `property`),
`tenant`, `lease`, `vendor` (replaces `technician` — an external party,
not a W2 tech, and carries `coiExpiry`). `customer` is repurposed as
"Owner" (the property's owner, a DeepWell customer's client — not the
end occupant, that's `tenant`). `equipment` (renamed "Appliance") is the
one entity that carries over almost unchanged, scoped to a `unit` instead
of directly to a `property`.

**Warranty/compliance.** No single code cycle like NEC; instead: state
landlord-tenant law (habitability repair windows — jurisdiction-specific,
not encoded), local rental-registration/inspection ordinances, and vendor
COI expiry — the standout reusable feature, using the exact same
expiry-tracking mechanism as HVAC's warranty status. Appliance warranties
themselves reuse HVAC's warranty math directly. See
`src/domains/property/rules.ts`.

**Pricing fit — the real blocker, not the schema.** DeepWell prices by
technician headcount; a property management company has none. This
vertical needs a per-door or per-unit pricing tier before it can be sold
at all — a go-to-market and pricing decision, not an engineering one.
That, plus the incumbent all-in-one suites (AppFolio, Buildium, Yardi,
DoorLoop) already selling document management as a feature of a bigger
platform, is why this is recommended last despite already being flagged
"Next" in the site's existing "Where it works" section.

---

## Recommended expansion order & rationale

1. **Electrical** — smallest schema delta (new nameplate fields only, no
   new entities, one new document type), same buyer, same software
   landscape, same pricing model, and often the *same shop* as an
   existing or prospective HVAC customer. Cheapest to build, cheapest to
   sell.
2. **Plumbing** — same profile as electrical, marginally larger delta (two
   new document types instead of one), and the backflow-test compliance
   angle is a strong, demonstrable use of the reminder engine DeepWell
   already ships for warranties.
3. **Property management** — highest differentiation, highest build cost:
   new entity model, new buyer persona, new pricing unit, and entrenched
   incumbent competition. Worth pursuing, but only after 1–2 have
   validated the "records engine, not a vertical field-service tool"
   positioning with a second and third trade.

---

## What was built

### Domain scaffolds (`src/domains/electrical`, `src/domains/plumbing`,
### `src/domains/property`)

Each mirrors the part of hvac's file layout the brief asked for —
`schema.ts`, `documentTypes.ts`, `units.ts` — plus a new `rules.ts` (hvac
has no equivalent; its warranty math lives inline wherever
`warrantyExpiry` is read, so this is a new pattern, not a mirrored one)
and an `index.ts` that re-exports all four. All four files per domain
type-check under the same strict `tsconfig.app.json` hvac does (`npm run
typecheck` passes, `strict`/`noUnusedLocals`/`noUncheckedIndexedAccess`
included).

**Deliberately excluded**, unlike hvac: `seed.ts` (a demo fixture),
`answer.ts` (the mock Q&A engine), `intake.ts` (upload-flow classify
helpers). The brief asked for schema/documentTypes/units/rules "stubs
that type-check" — building a working seed/answer/intake per vertical
means fabricating a second and third synthetic corpus and duplicating the
answer engine for trades nobody has sold yet. That's real follow-on work
for whichever industry gets greenlit next, not part of this scaffold.

**Registration, and why nothing is user-selectable.** There is no
domain-switch UI in DeepWell today. `hvacSchema` isn't just imported in
one place — it's hardcoded directly into the real pipeline
(`src/hooks/usePostgresSync.ts` imports it by name, as do
`ReviewScreen.tsx`, `BrowseScreen.tsx`, `IntakeScreen.tsx`, etc.), and
`src/main.tsx` only ever bootstraps the hvac *demo fixture*, gated by
`VITE_DEMO_MODE`. Wiring electrical/plumbing/property into that pipeline
would make them reachable by a real signed-in user, which the brief
explicitly says not to do without an existing domain switch — so I didn't
touch `main.tsx`, `App.tsx`, `usePostgresSync.ts`, or any screen.

Instead, all three are registered in a new **`src/domains/registry.ts`**
— `DOMAINS` (array) and `DOMAINS_BY_ID` (map), alongside `hvacSchema`,
plus a `LIVE_DOMAIN_IDS` set (`{'hvac'}`) and an `isDomainLive()` helper.
Nothing in the running app imports this file; it exists purely as the
discovery point for whenever a real domain switch gets built, so that
work reads `DOMAINS` instead of hardcoding `hvacSchema` the way today's
pipeline does.

### Website (`index.html`, `public/industries/*.html`, `sitemap.xml`)

- **`index.html`**: one new "Industries" nav item, a dropdown listing HVAC
  (Live) and the three new pages (Coming), added as a labeled CSS block
  (right before `</style>`, after the existing numbered micro-animation
  comment blocks) and a **separate, standalone `<script>`** placed after
  the existing micro-animation `<script>` block — the hero canvas IIFE and
  the nine numbered micro-animation IIFEs are untouched. The dropdown
  toggle is a real `<button>` (not an `<a href="#">`), so it doesn't get
  picked up by the existing nav-active-indicator script (which only
  queries `a[href^="#"]` inside `.navlinks`), and the menu's own links
  point to `/industries/...` for the same reason.
  - Keyboard: Enter/Space/↓ on the toggle opens the menu and focuses the
    first item; ↑/↓ move between items; Escape closes and returns focus to
    the toggle; Tab closes the menu once focus leaves it.
  - Touch: the toggle's `click` handler fires on tap with no separate
    touch code needed; verified with Playwright's `hasTouch` context and
    `.tap()`.
- **`public/industries/hvac.html`, `electrical.html`, `plumbing.html`,
  `property-management.html`** (new): short pages, same design-system
  tokens as `index.html` (`:root` CSS variables, fonts, `.btn` classes),
  nav and footer copied from `index.html`'s markup (nav links point back
  to `/#section` since these pages have no sections of their own; the
  Industries dropdown is reproduced verbatim on each so it's consistent
  and testable everywhere, not just on the homepage). No hero canvas, no
  ambient background, no marquee — these pages are intentionally plain.
  - Every page states, identically, three things DeepWell does **today**:
    reads your records (whatever document types you have), links every
    document to the customer and the asset, and answers plain-English
    questions with a citation back to the source. Nothing industry-specific
    is claimed as live.
  - `hvac.html` is marked **Live** and its CTA is "Start free trial" /
    "Log in" (real links into `/app/`) — no waitlist, because it isn't
    a coming feature.
  - `electrical.html`, `plumbing.html`, `property-management.html` are
    marked **Coming** and each ends with the honest CTA the brief asked
    for verbatim: **"Built on the same records engine — join the
    waitlist"**, a `mailto:hello@deepwelltechnology.com?subject=<Industry>%20waitlist`
    link (no fake signup form).
- **`sitemap.xml`**: added all four `/industries/*.html` URLs.

### Verification

- `npm run typecheck && npm run typecheck:api && npm run lint && npm run
  verify:all` — all green (this run: typecheck/typecheck:api clean, lint
  exit 0 with only pre-existing warnings in files I didn't touch,
  `verify:all` all PASS, including Workstream A's `verify:analytics` and
  Workstream B's `verify:business-corpus`, both already present from the
  parallel agents).
- `npm run build` succeeds (confirms the new `index.html` markup doesn't
  break the Vite build).
- An ad hoc Playwright check (not added to the repo — see below) loaded
  `/`, `/industries/hvac.html`, `/industries/electrical.html`,
  `/industries/plumbing.html`, `/industries/property-management.html` at
  375×812 and 1440×900: **zero `pageerror` and zero console errors** on
  every page at both widths. A second pass at 1440 (with `hasTouch: true`)
  exercised the dropdown: click-open, `aria-expanded` toggling,
  Escape-closes-and-returns-focus, Enter-opens-and-focuses-first-item,
  ArrowDown-moves-to-next-item, click-outside-closes, and tap-open +
  tap-a-menu-item navigates to `/industries/hvac.html`. All passed.
  I did not add this as a permanent `scripts/verify-*.mjs` / `verify:all`
  entry — it's nav/page QA for a one-time addition, not a regression
  surface the rest of the team is likely to break by editing unrelated
  code, and adding an entry to the shared `verify:all` chain during a
  three-way parallel run risked a spurious conflict with Workstream A/B's
  own script additions for no real ongoing benefit. If the team wants it
  as a standing check, the script is easy to reconstruct from this
  handoff's description — happy to add it properly on request.

## Not done / explicitly out of scope

- No backend extraction pipeline for electrical/plumbing/property (no
  `api/_lib` changes — the standing constraint caps `api/` at 12 files and
  this work doesn't touch it at all).
- No `seed.ts`/`answer.ts`/`intake.ts` per new domain (see "Domain
  scaffolds" above).
- No pricing-page or plan changes for property management's per-door
  question — flagged, not solved.
- No NEC-code-cycle or habitability-law logic — flagged in each `rules.ts`
  as jurisdiction/edition-dependent, not encoded.
- No changes to `main.tsx`, `App.tsx`, `usePostgresSync.ts`, or any
  screen — hvac remains the only domain the running app can seed.

## Files changed / added

- `handoffs/INDUSTRY_EXPANSION_2026-09-21.md` (this file, new)
- `src/domains/electrical/{schema,documentTypes,units,rules,index}.ts` (new)
- `src/domains/plumbing/{schema,documentTypes,units,rules,index}.ts` (new)
- `src/domains/property/{schema,documentTypes,units,rules,index}.ts` (new)
- `src/domains/registry.ts` (new)
- `index.html` (Industries nav dropdown: markup, one labeled CSS block, one
  standalone `<script>` block — hero canvas + numbered micro-animation
  blocks untouched)
- `public/industries/hvac.html` (new)
- `public/industries/electrical.html` (new)
- `public/industries/plumbing.html` (new)
- `public/industries/property-management.html` (new)
- `public/sitemap.xml` (four new `<url>` entries)
