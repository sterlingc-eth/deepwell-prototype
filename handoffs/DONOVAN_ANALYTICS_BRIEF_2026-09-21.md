# Donovan analytics + 600-document business + industry expansion (2026-09-21)

Owner (heading to the office, hours available): "Donovan is unable to answer
generic basic questions — how many clients do we have in Arizona, how many in
a particular county. He needs to answer generic questions using NLP. Build an
entire business with sample documents a real business would have (a few
hundred, up to a thousand if cost-effective), link them all to their customer,
and make natural-language generic questions succeed. Also a team thinking about
expanding to electricians, plumbing, property management, and how the website
could change — maybe additional tabs."

Standing constraints: no git; exactly 12 files directly under api/; no DDL run
(guarded M3-config/NN-*.sql only if unavoidable, code tolerates absence); no new
deps; Haiku only in product; `npm run typecheck && npm run typecheck:api &&
npm run lint && npm run verify:all` green (2792 PASS / 0 FAIL now); reviewer
GO before commit. Cheap: sonnet agents, no wasted reads.

## Workstream A — Donovan analytics (aggregate NLP questions)
Today Ask = meta-router → fast path (field lookups) → retrieval → Haiku with
citations. Counting/grouping/listing questions have no path: "how many
customers in Arizona", "how many in Maricopa County", "list customers in
Gilbert", "how many units are out of warranty", "which customers have Trane
units", "how many documents did we add this month", "who did we service in
August", "how many Goodman units are older than 10 years".

Design (api/_lib/analytics.js + api/_lib/routes/analytics.js, wired into
api/ask.js before retrieval):
1. Classifier: a cheap deterministic pre-check (regex on "how many / count /
   list / which customers / total / breakdown / by city|county|brand") →
   then ONE Haiku call with a strict JSON schema (tool use) that turns the
   question into a QUERY PLAN — never SQL from the model:
   {entity: customers|equipment|documents|serviceVisits|warranties,
    op: count|list|groupBy|sum, groupBy?: city|county|state|zip|brand|
    documentType|month|technician|warrantyStatus, filters: [{field, op, value}],
    timeRange?: {from,to}, limit?} with a closed vocabulary of fields
   (state, county, city, zip, brand, model, equipmentType, tonnage,
   refrigerant, installYear, warrantyStatus (active|expiring|expired|unknown),
   documentType, technician, customerName). Reject anything outside the
   vocabulary → fall through to the existing pipeline.
2. Executor: parameterized SQL per entity built from the plan (whitelisted
   columns/JSON paths only), tenant-scoped via withTenant, LIMIT 500, with a
   geography helper: derive state + zip + city from service_address
   (reuse deriveCity in routes/customers.js; add deriveState/deriveZip), and a
   county lookup from ZIP → county using a bundled compact table
   (api/_lib/geo/zip-county.json: ALL Arizona ZIPs at minimum + the 100
   largest US metros' ZIP ranges, generated from public HUD/USPS crosswalk
   knowledge; document the source; keep it ≤ 150 KB). City→county fallback
   table for AZ when ZIP is missing. Unknown → counted under "unknown".
3. Answer: deterministic text (no second model call): "You have 14 customers
   in Maricopa County (of 31 in Arizona): Gilbert 5, Mesa 4, Chandler 3,
   Tempe 2." plus facts rows (label/value) and, for list ops, the customer
   rows as linkable facts (entityId) so the UI opens them. Sources = the
   customer/equipment records. Cache via askCache with corpus_stamp.
4. Client: AnswerCard already renders facts + linkable entities; add a
   compact table renderer for groupBy results (≤ 12 rows, "and N more").
5. Ambiguity rule: if the plan's filters name a value not present in the
   tenant's data (county "Pima" with 0 rows) answer "0 customers in Pima
   County — your customers are in Maricopa (14) and Pinal (3)."
6. Verify: scripts/verify-analytics.mjs — planner schema validation, SQL
   builder against a fixture (no DB), geo derivation (AZ addresses incl.
   suites, missing zip, 9-digit zip), county lookup, answer formatting, and
   the fall-through when the plan is invalid. ≥ 60 checks.
7. Cost: one Haiku call ≤ 400 output tokens per analytics question, cached.

## Workstream B — a whole business in documents (600 docs, ~120 customers)
Extend scripts/synth-corpus.mjs (deterministic, seeded) into
scripts/synth-business.mjs generating test-docs/business/: a fictional
Phoenix-metro HVAC company "Sonoran Comfort Air" with ~120 customers spread
across Maricopa (Phoenix, Mesa, Gilbert, Chandler, Tempe, Scottsdale, Glendale,
Peoria, Queen Creek), Pinal (San Tan Valley, Casa Grande, Maricopa city,
Florence) and Pima (Tucson, Oro Valley, Marana) counties + 4 customers in
Nevada/New Mexico/California for the "in Arizona" question; residential +
commercial (dental, restaurants, churches, a school, an apartment complex with
8 units); brands Trane/Carrier/Goodman/Lennox/Rheem/York/Daikin/Mitsubishi;
install dates 2009–2026 so warranty tiers are mixed; ~5 docs per customer
across all document types the app supports (invoice, service ticket, work
order, warranty registration, startup sheet, maintenance agreement,
proposal/quote, permit, inspection report, purchase order, correspondence,
nameplate "photo" transcript, dispatch note) with realistic vendor/permit
numbers, technicians (6), and the traps from the first corpus (household name
variants, near-miss surnames, same complex different units, letterhead-only
docs, shop phone/email on every letterhead). Output PDFs (hand-rolled like
synth-corpus) + .txt. Write test-docs/business/ANSWER_KEY.json with: customer
count total / by state / by county / by city, equipment count by brand,
warranty status counts as of 2026-09-21, documents by type, plus 60 natural-
language questions (30 analytics, 30 lookup) with expected substrings.
Extend scripts/score-corpus.mjs to score analytics questions. Also write
scripts/build-bundle.mjs to produce bundle.json (base64) for the browser
ingest step, and a browser-side ingest+snapshot script
scripts/browser-ingest.js (plain JS, pasteable into the signed-in app console)
that respects the 60-units/minute rate limit with backoff and can resume
(skips names already uploaded via sha256 alreadyUploaded). Estimated Haiku
cost at ~$0.012/doc ≈ $7 for 600 docs — acceptable per owner.

## Workstream C — industry expansion
Research (WebSearch allowed, brief) electricians, plumbers, property managers:
their document types, the questions they ask, regulatory/warranty specifics,
what field-service software they already use, and how DeepWell's HVAC domain
(src/domains/hvac/*: schema, units, documentTypes, warrantyRules) generalizes.
Deliver: (1) handoffs/INDUSTRY_EXPANSION_2026-09-21.md — per-industry: ICP,
document set, top 20 questions, schema deltas, warranty/compliance rules,
pricing fit, go-to-market order with rationale; (2) domain scaffolds
src/domains/electrical, plumbing, property (schema + documentTypes + units +
rules stubs that type-check, registered but not selectable yet unless there is
already a domain switch); (3) website: an "Industries" nav item on index.html
with a dropdown/section linking HVAC (live) and three new pages
public/industries/electrical.html, plumbing.html, property-management.html
built from the same design system as index.html (copy the head/nav/footer,
reuse CSS variables), each with an honest "Built on the same records engine —
join the waitlist" CTA (mailto: or the existing Records-Rescue mailto pattern;
no fake signup), sitemap.xml updated, no claims the product can't back today.
Zero pageerrors in Playwright, both widths.

## Sequence
A, B, C run in parallel (different files). Reviewer GO on each. Then commit
by path. The live upload of the 600-doc business waits for the owner to sign
in on the app tab (his session expired); the analytics answers are then scored
against the answer key live.
