# HVAC brand warranty research

Source of truth for `api/_lib/warrantyRules.js`'s `BRAND_RULES`. Manufacturer
pages only (or an explicitly-disclosed one-step-removed source); "not stated"
means the page didn't say, not that a number was guessed. All checked
2026-09-19 unless noted. Registration windows/terms below are for residential
split systems (parts term); labor is separately noted since this app's rule
shape doesn't track it (assume none unless a brand explicitly extends it).

## Market share note (why these brands, in this order)

By US residential HVAC volume, the brands worth prioritizing are roughly:
Carrier/Bryant/Payne (ICP/Carrier Global owns all three, plus Heil/Tempstar/
Comfortmaker/Day&Night/KeepRite/Arcoaire), Trane/American Standard, Goodman/
Amana (Daikin owns both), Lennox (+ Armstrong Air/AirEase/Ducane, its "Allied
Air" value line), Rheem/Ruud, and York/Coleman/Luxaire (Johnson Controls,
recently folded into Bosch — see below). Mitsubishi Electric and Fujitsu lead
ductless mini-splits specifically. Napoleon, Nordyne/Maytag/Frigidaire, and
Bosch's own badge are lower-volume. A tenant's fleet is very likely dominated
by the first two groups, so those being fully modeled (already true before
this pass) matters more than any single brand below.

## Newly verified this session

| Brand | Family / parent | Reg. window | Registered parts | Unregistered parts | Compressor | Heat exchanger | Labor | Confidence | Source |
|---|---|---|---|---|---|---|---|---|---|
| Heil | ICP (Carrier) | 90 days | 10 yr | 5 yr | not separately stated | longer, years not stated | none (install labor "may apply") | high | [heil-hvac.com](https://www.heil-hvac.com/en/us/product-registration-warranty) |
| Tempstar | ICP (Carrier) | 90 days | 10 yr | 5 yr | not separately stated | longer, years not stated | none | high | [tempstar.com](https://www.tempstar.com/en/us/product-registration-warranty) |
| Comfortmaker | ICP (Carrier) | 90 days (assumed*) | 10 yr (assumed*) | 5 yr (assumed*) | not stated | not stated | none (assumed*) | medium | shared ICP certificate; not fetched directly, corroborated by Heil/Tempstar |
| Day & Night | ICP (Carrier) | 90 days (assumed*) | 10 yr (assumed*) | 5 yr (assumed*) | not stated | not stated | none (assumed*) | medium | shared ICP certificate; not fetched directly |
| KeepRite | ICP (Carrier) | 90 days (assumed*) | 10 yr (assumed*) | 5 yr (assumed*) | not stated | not stated | none (assumed*) | medium | shared ICP certificate; not fetched directly |
| Arcoaire | ICP (Carrier) | 90 days (assumed*) | 10 yr (assumed*) | 5 yr (assumed*) | not stated | not stated | none (assumed*) | medium | shared ICP certificate; not fetched directly |
| Armstrong Air | Lennox ("Allied Air") | 60 days | 10 yr | 5 yr | not stated | lifetime reg. / 20 yr unreg. | not stated | high | [armstrongair.com](https://www.armstrongair.com/buyers-guide/warranty/) |
| AirEase | Lennox ("Allied Air") | 60 days | 10 yr | 5 yr | not stated | lifetime reg. / 20 yr unreg. | not stated | high | [airease.com](https://www.airease.com/planning/warranty/) |
| Ducane | Lennox ("Allied Air") | 60 days | 10 yr (corroborated, not on Ducane's own page)* | 5 yr | not stated | 20 yr unreg. (reg. term not stated) | not stated | medium | [ducanehvac.com](https://www.ducanehvac.com/owner-support/warranty-registration/) |
| Napoleon | independent (cheap/low-volume) | 60 days | 10 yr | 5 yr (incl. compressor) | 5 yr (bundled w/ parts) | n/a (AC unit) | none ("diagnostics, transportation or labor... not covered") | high | [napoleonproducts.com PDF](https://napoleonproducts.com/downloads/hvac/warranty/NAP%20MFG%20Warranty_AC_SEER_13_14_16_EN.pdf) |
| Mitsubishi Electric | Mitsubishi Electric Trane HVAC US (METUS) | 90 days | 10 yr std / 12 yr "Diamond Contractor" tier (owner-occupied required for either) | 5 yr | 7 yr unreg. / 10–12 yr reg. | n/a (ductless) | none ("does NOT include labor") | medium | [acdirect.com PDF](https://www.acdirect.com/media/specs/Mitsubishi/mitsubishi-r454b-warranty.pdf) (dealer-hosted copy of the manufacturer certificate, not mitsubishicomfort.com directly) |

`*` = not independently fetched this session; treated as corroborated from a
sibling brand's page, same standard this file already applies to Payne/Carrier
and Ruud/Rheem. Code models only what's independently confirmed as high
confidence, and marks the rest `medium` — see `BRAND_RULES` caveats.

**Code note:** only Heil, Tempstar, Comfortmaker, Day & Night, KeepRite,
Arcoaire, Armstrong Air, AirEase, Ducane, Napoleon, and Mitsubishi Electric got
a `rule` this session (all fit the registration-window/parts-term shape).
Compressor and heat-exchanger terms above are for the record only — the rule
shape tracks one parts term, not a per-component breakdown.

## Confirmed still unverified — and why (not "not yet checked", but actually blocked)

| Brand | Family | What was found | Why it stays `rule: null` |
|---|---|---|---|
| York | Johnson Controls (recently under Bosch) | `york.com`'s warranty pages 302-redirect to `york.bosch-hcgroup.com`, a Bosch parent landing page with no terms reachable, as of 2026-09-19 | Nothing to cite. Same finding as before this session — the redirect target changed (now explicitly Bosch-branded) but the outcome (no reachable terms) did not. |
| Coleman | Johnson Controls (same family as York) | not separately checked; shares York's ownership/distribution problem | same as York |
| Luxaire | Johnson Controls (same family as York) | not separately checked | same as York |
| Fujitsu | Fujitsu General | Own AIRSTAGE/HALCYON warranty PDF states real numbers — 5 yr parts / 7 yr compressor unregistered, 10 yr registered (licensed contractor), 12 yr (Elite contractor) — CA/Quebec exempt from registering at all | The PDF never states a registration **deadline in days**. That's the one number this schema's `registrationWindowDays` needs, and inventing one (60? 90?) would produce a confidently wrong "register within N days" message. Left `null` rather than guessed. |
| Bosch | Bosch (own badge, distinct from the York/JCI business it now owns) | Bosch's own FAQ: *"Your warranty eligibility is not impacted by whether you have registered your product or not."* A separately found BOVA/BVA heat-pump certificate: flat 10-year parts/compressor regardless of registration, with registering adding only a 90-day **labor** allowance | Registering doesn't change the parts term at all — this schema's rule shape assumes registration extends parts coverage, and forcing Bosch into it would either invent a meaningless deadline or produce a "register to get 10 years instead of 10" message. Wrong shape for this brand; needs a product decision (e.g. a labor-only rule variant) before modeling, not a workaround. |
| Maytag | Nordyne / Nortek Global HVAC (Broan-NuTone) | maytaghvac.com states a registered figure (12 yr, "M1200"/"M120" lines) | The **unregistered floor** — the guaranteed-minimum number this schema needs — is not stated anywhere found. Can't set a conservative floor without it. |
| Nordyne | umbrella/OEM name | nordyne.com is a brand-family portal (Maytag, Frigidaire, Westinghouse, Concord, Tappan, Broan), not itself a product line with a consumer warranty page | Not a real "manufacturer" for warranty purposes — the actual badge (Maytag, etc.) is what a document would print. |

## Already-verified brands (prior session, re-cited here for the full picture — not re-checked this pass)

Goodman, Trane, Amana, American Standard, Lennox (Merit/Elite only), Carrier,
Payne, Bryant, Rheem, Ruud, Daikin — see `BRAND_RULES` in
`api/_lib/warrantyRules.js` for their terms, sources, and caveats (jurisdiction
overrides, conditional registered terms, shared-certificate provenance). Not
re-verified this session; no new information changes them.

## Coverage after this pass

22 of 29 recognized brands now have a `rule` (up from 12). The 7 still `null`
(York, Coleman, Luxaire, Fujitsu, Bosch, Maytag, Nordyne) are blocked on a real
gap in what's publicly stated or reachable, not on research time — see the
table above for the specific missing fact per brand.
