# Where DeepWell fits — competitive landscape (2026-09-28)

**Bottom line.** Every big FSM (ServiceTitan/Atlas, Housecall Pro AI Team, Jobber Copilot, BuildOps
OpsAI, ServiceTrade) has added an "AI teammate" — aimed at booking calls, marketing copy and coaching.
None of them answers questions across a shop's historical paperwork **with citations** (ServiceTitan's
Atlas carries a "may be inaccurate" disclaimer and shows no sources). That is our lane: **the cited
memory of the business that sits beside whatever FSM the shop already runs.** Be careful not to
over-claim: equipment history (ServiceTitan, ServiceTrade), nameplate-photo capture (BuildOps) and
photo documentation (XOi) already exist elsewhere — they are table stakes, not our differentiator.

## The research's recommendations vs. what DeepWell already has

| # | Recommendation (evidence) | Status in DeepWell |
|---|---|---|
| 1 | Cited answers, source one tap away (Glean, Dropbox Dash) | **Have** — every answer cites; page + excerpt. Gap: highlight the exact passage on the page |
| 2 | Nameplate photo → unit record (BuildOps) | **Have** — plate capture (plateCapture / SerialCapture) |
| 3 | Warranty-claim packet from the contractor side (no one else) | **Have** — claim-packet export. Keep investing: it's genuinely novel |
| 4 | Pull attachments from ServiceTitan / Housecall Pro / Jobber (public APIs) | **Gap — biggest one.** Removes "yet another system to feed". Needs your OK (new integrations) |
| 5 | Permission-aware answers by role (Glean) | **Partial** — tenant isolation (RLS) + internal/customer audience. Gap: role-level (tech vs office) limits on sensitive docs/money |
| 6 | Expiring-warranty outreach queue (ServiceTitan "Second Chance Leads" pattern) | **Have** — Outreach (draft-to-copy; auto-send add-on) |
| 7 | Flag superseded documents (old agreement replaced by new) (Glean) | **Gap** — medium effort, prevents stale citations |
| 8 | Shareable "proof of work" link for the homeowner (XOi) | **Gap** — low effort, trust + retention |
| 9 | Guided multi-photo capture (XOi) | **Partial** — multi-page scan → one PDF. Gap: guided shots (nameplate, disconnect, before/after) |
| 10 | Offline capture + background sync | **Have** — mobile offline queue |
| 11 | Portfolio rollups ("Trane units in Maricopa County") — no FSM does this | **Have** — Donovan analytics; consider saved/scheduled reports |
| 12 | Published AI pricing (competitors hide AI add-on prices) | **Have** — Solo/Shop/Crew/Fleet published. Say it in marketing |

## Recommended next, in lane (ranked)
1. **FSM attachment ingestion** — start with ServiceTitan (attachments endpoint on installed equipment),
   then Housecall Pro, Jobber. Read-only pull into the existing ingest pipeline. *Decision needed: you.*
2. **Passage highlight in the source viewer** — show the exact words behind each cited fact.
3. **Superseded-document flag** — newest agreement/registration wins; older ones marked "replaced".
4. **Homeowner proof-of-work link** — read-only, expiring link to a job's documents.
5. **Role-aware answers** — option to hide money/internal docs from tech role.

## Do not build (out of lane)
Dispatch/scheduling/routing, estimates/quotes, invoicing/payments, payroll/timesheets, CRM/marketing
and ad automation, GPS/fleet, inbound call answering (CSR AI), manufacturer-side warranty adjudication.
We assemble the proof; we don't run the job, the money, or the phone.

## Messaging lines
- "The memory beside your FSM."
- "Every FSM has an AI teammate for booking calls. None can tell you — with a citation — whether the
  unit at 123 Main is still under warranty."
- "Cited answers, not chatbot guesses." / "Published pricing, no sales-call surprise."

---

# Appendix — full research report

**Date:** 2026-09-28
**Scope:** FSM platforms HVAC shops use, document/AI-knowledge tools, and warranty/equipment-specific tools — where DeepWell fits and what to learn, staying in-lane (document management + AI Q&A, not FSM).

---

## 1. Field Service Management (FSM) platforms

### ServiceTitan
- **AI stack:** "Titan Intelligence" is the umbrella brand; **Atlas** is the conversational AI sidekick embedded in the platform. Atlas lets techs "look up job details and customer history in natural language, right from the field," gives office staff feature help, gives Field Pros "equipment knowledge, troubleshooting guides, calculators, diagnostics, and replacement parts," and lets owners ask business-performance questions from a phone app. Titan Intelligence also bundles Job Value Predictor, Second Chance Leads, Price Insights, Benchmark Reporting, Review Response Generator, Risky Driver Detection, Ads Optimizer.
- **Equipment/warranty:** Native "Installed Equipment" tracking with history, tags, and alerts; templated HVAC warranty tracking (labor/parts) exists but is manually configured, not automatically extracted from scanned paperwork.
- **Documents:** Attachments can be posted to installed-equipment records via the public API (`installed_equipment_post_attachment`), i.e., ServiceTitan treats equipment documents as an attachment field, not a first-class searchable/queryable corpus.
- **Trust/citations:** Atlas's own docs explicitly warn it "may generate inaccurate, incomplete, or outdated responses" and tell users to verify outputs — **no visible citation/sourcing mechanism** in the documentation we could find. This is a real gap vs. enterprise search tools (see §2).
- **Reviews/complaints (G2/Capterra):** Dominant complaints are steep learning curve, bugs, poor/slow support, integration gaps, and workarounds for feature limits (e.g., recalled jobs not auto-attaching to projects, no reminders on open quotes). We did **not** find explicit "can't find old paperwork" complaints in the review excerpts surfaced — this specific pain shows up more in HVAC-Talk / contractor forums than in software review sites (see below). Be honest: this means the "search pain" thesis needs framing as an *inferred* gap (systems store documents as attachments with no cross-record Q&A) rather than a widely-repeated review complaint.
- **API/integrations:** Full public developer API (developer.servicetitan.io) with an ecosystem of integration partners — this is a real ingestion opportunity for DeepWell (see improvements list).

### Housecall Pro
- **AI stack ("AI Team"):** Four bundled agents — **CSR AI** (24/7 call/chat answering and booking, claims "2x more revenue" for users of the paid add-on), **Analyst AI** (natural-language business reporting), **Coach AI** (strategic advice), **Marketing AI** (auto-generates campaigns/content). Marketing AI, CSR AI (chat), Analyst AI, Coach AI, and Help AI are included on all plans; the 24/7 phone-answering tier of CSR AI is a separately-priced add-on with **no published price** — sold only through sales calls (opaque AI add-on pricing is a pattern across this whole category).
- **Document/equipment handling:** Not a focus of the public AI Team marketing — Housecall Pro's document/attachment and equipment-history features are basic compared to ServiceTitan/ServiceTrade.
- **Pricing:** Basic $59–79/mo (1 user), Essentials $149–189/mo (5 users), MAX $299–329/mo, +$35/user. AI features are effectively bundled marketing/CSR automation, not document intelligence.

### Jobber (Copilot)
- Positioned as a business-coaching/marketing assistant ("simplify daily operations," marketing content generation, data analysis on cash flow/workforce, personalized coaching), trained on Jobber's own knowledge base. **Free in beta** (US/Canada). No document-AI, equipment, or warranty angle at all — Jobber Copilot is purely an operations/marketing copilot, leaving document intelligence completely open.

### FieldEdge, BuildOps, Service Fusion, ServiceTrade, Workiz, Successware
- **BuildOps (OpsAI)** is the most relevant adjacent play: a **Nameplate Scanner** ("Techs snap a nameplate and the asset record fills in automatically") and a **Purchasing Document Scanner** that extracts PO line items from photos — i.e., BuildOps is already doing photo-to-structured-data extraction for equipment nameplates, which validates DeepWell's "scan nameplate → auto-populate unit record" feature as directionally correct and already a competitive expectation, not a novelty. OpsAI also "reads completed visit notes and flags repair/replacement/upsell opportunities" and gives "full service history summarized before anyone opens the panel" — a document-grounded summary pattern worth copying.
- **ServiceTrade** (commercial/mechanical HVAC — DeepWell's closest FSM neighbor) emphasizes "asset lifecycle management" and "complete asset history," plus "Stella" AI agents that summarize equipment info for techs and generate customer-facing work summaries. No warranty-specific tracking feature was found on their features page — an opening for DeepWell in the commercial-mechanical segment specifically.
- **FieldEdge, Service Fusion, Workiz, Successware**: their public marketing centers on scheduling/dispatch/invoicing/payments; equipment and warranty tracking exist as basic fields, not as an extraction-and-Q&A layer. No AI-search or citation features surfaced for any of these four — they are behind ServiceTitan/Housecall Pro/BuildOps on AI generally.

### Cross-platform pattern
Every major FSM vendor is racing to bolt on an "AI teammate" (Atlas, AI Team, Copilot, OpsAI, Stella) but the AI is aimed at **CSR/call-answering, business coaching, and marketing content** — the money-generating surface — not at **making the historical document/photo/paperwork trail searchable and trustworthy**. Where equipment/document AI exists (BuildOps nameplate scanner, ServiceTitan attachments API, ServiceTrade asset history) it's a feature bolted onto the FSM record, not a queryable knowledge base with citations. None of the platforms researched publish a citation/sourcing UX for their AI answers — Atlas explicitly disclaims accuracy with no cited source shown. This is DeepWell's cleanest differentiation: **Glean-style cited answers, applied to trade paperwork**, sitting beside (not replacing) these FSM tools.

---

## 2. Document/AI-knowledge tools & warranty-specific tools

### Glean
- Enterprise search grounded in **RAG over connected repositories** with **permission-aware retrieval** (checks each user's access rights against source-app permissions *before* a passage enters generation — not just after), **passage-level inline citations** (each claim links to a specific source, not a generic reference list), and continuous re-indexing so citations don't point to stale versions. This is the gold-standard pattern for the "citations Donovan should copy": passage-level, permission-checked-at-retrieval, freshness-aware.

### Dropbox Dash
- "Cited sources in every AI answer," Q&A grounded in connected docs/PDFs/folders, respects existing file permissions ("only content you already have access to"), plus summarization and drafting. Same trust pattern as Glean at a lighter/simpler level — validates that "cited answer + respects permissions" is now the baseline expectation for any document-AI product, including a vertical one like DeepWell.

### Microsoft Copilot / SharePoint, Box AI
- Microsoft is pushing "SharePoint Knowledge AI Search" (Copilot + Azure AI Search) for grounded document discovery with citations, and Microsoft 365 Copilot has recently emphasized "citations in plugins" as a trust feature — reinforcing that citation UX is becoming table stakes across the whole document-AI category, not just niche players.

### XOi Vision (photo/video documentation for trade techs — closest analog to DeepWell's "Scan" use case)
- Workflow: techs photograph/video jobsite work, building a "searchable repository of every unit serviced, every fix applied, and every recommendation made" over time. Includes live video calls to remote experts (reduces second truck rolls) and lets techs share a documented-job web link with the customer as "verifiable proof of quality." XOi is the strongest existing proof that (a) photo-first field documentation and (b) a growing searchable equipment history are both validated, monetizable patterns in the trades — but XOi is documentation-and-collaboration focused, not an AI Q&A/citation layer answering natural-language questions across the whole corpus the way Donovan does.

### Manufacturer warranty portals (Carrier/Trane) & MeasureQuick
- Trane/Carrier warranty registration is a **separate, manual, manufacturer-run portal** step contractors complete after installation (register serial number, install date, owner info) — completely disconnected from the FSM/document system. This is a real gap: nobody found connects the *manufacturer* registration/claim workflow to the shop's own document trail, so a claim later requires manually re-assembling install date, model/serial photo, and invoice from wherever they landed. DeepWell's warranty-claim-packet idea (auto-assemble what a manufacturer claim needs from records already ingested) has no direct competitor doing this from the contractor side.
- MeasureQuick is a diagnostics/commissioning app (superheat/subcooling calculations, verified startup reports) — adjacent but not document-management; it produces a *report* per job that could itself become a document type DeepWell ingests and indexes, not a competitor.

---

## 3. Synthesis

### (a) The honest gap assessment
- **Real and defensible:** No FSM platform researched offers a permission-aware, **cited**, natural-language Q&A layer across the *entire historical document corpus* (work orders, invoices, warranty registrations, startup sheets, nameplate photos, permits, maintenance agreements) the way Glean/Dash do for general enterprise docs. FSM "AI teammates" are aimed at CSR/marketing/coaching, not document retrieval-with-citations.
- **Partially covered already — be skeptical:** Equipment/asset history and basic document attachment exist in ServiceTitan, ServiceTrade, and BuildOps. Photo-to-structured-data (nameplate scanning) is already shipped by BuildOps, and XOi already does rich photo/video documentation with a searchable repository. DeepWell should not claim "nobody tracks equipment history" — several vendors do. The differentiated claim is narrower and true: *none combine that history with cross-document, cited natural-language Q&A, and none are built to sit beside a shop's existing FSM tool rather than replace it.*
- **Unproven from public reviews:** The "techs can't find old paperwork" pain is intuitive and shows up in trade forums (warranty disputes, missing proof-of-purchase) but was not strongly evidenced in the mainstream FSM review sites we could access — the dominant public complaints there are learning curve, support quality, and integration gaps, not search/history. DeepWell's pitch should lean on the forum/warranty-dispute evidence and the "opaque AI-addon pricing" pattern, not overstate FSM review complaints we didn't actually find.

### (b) 8–12 ranked in-lane improvements (value vs. effort, each tied to evidence)
1. **Ship a "cited answer" UX for Donovan (passage-level source links, not just a doc list).** *Evidence:* Glean and Dropbox Dash both treat inline, passage-level citation as the core trust mechanism; ServiceTitan's Atlas explicitly lacks this and disclaims accuracy instead. High value, moderate effort — this is DeepWell's clearest wedge claim.
2. **Nameplate-scan → auto-populate unit record (model/serial/date/manufacturer extracted from a photo).** *Evidence:* BuildOps OpsAI already ships exactly this ("Techs snap a nameplate and the asset record fills in automatically") — proves demand and is table-stakes to match, not a differentiator, but a must-have for the mobile PWA.
3. **Warranty-claim packet generator: auto-assemble the manufacturer's required proof (install date, serial photo, invoice, registration confirmation) into one packet on demand.** *Evidence:* Carrier/Trane warranty registration is a disconnected manual portal step; HVAC-Talk threads show techs fighting to reconstruct proof after the fact. No FSM or document tool found does this end-to-end from the contractor side — genuinely novel, higher effort, high value.
4. **Ingestion connectors from ServiceTitan/Housecall Pro/Jobber attachments (pull existing work-order/invoice attachments into DeepWell rather than requiring re-upload).** *Evidence:* ServiceTitan has a full public API including an attachments endpoint on installed-equipment records; shops already have years of documents trapped in these systems as unindexed attachments. Medium-high effort (per-platform API work), very high value — removes the "yet another system to feed" objection.
5. **Permission-aware retrieval enforced at query time, not just document-level ACLs.** *Evidence:* Glean's architecture explicitly checks access rights before a passage enters generation; this is now an expected enterprise pattern and matters once DeepWell has techs, office staff, and (eventually) customer portals sharing one corpus. Medium effort, high value for Shop/Crew/Fleet tiers.
6. **Expiring-warranty proactive outreach (queue + draft email/text when a warranty is about to lapse), similar in spirit to ServiceTitan's "Second Chance Leads" automation pattern.** *Evidence:* direct analog exists (Second Chance Leads flags unbooked calls automatically) — same automation pattern applied to DeepWell's actual data (warranty expirations) instead of leads. Low-medium effort, high value, very much in-lane.
7. **Freshness/versioning on the index — flag or suppress citations to superseded documents (e.g., an old maintenance agreement replaced by a new one).** *Evidence:* Glean calls this out explicitly as a common AI-search failure mode ("citing outdated information"); DeepWell's corpus (contracts, agreements) will have exactly this problem as shops re-paper agreements. Medium effort.
8. **Customer-facing "proof of work" shareable link per document/job, mirroring XOi's model.** *Evidence:* XOi lets techs share a documented job via web link as "verifiable proof of quality," used for retention/upsell. Cheap to build once documents are indexed; low effort, medium value, nice cross-sell/trust feature for the mobile PWA.
9. **Live-photo-first capture flow (multi-photo per document + guided angles) rather than single-scan, learning from XOi's photo/video-first UX rather than a flat "upload a PDF" model.** *Evidence:* XOi's core workflow is photo/video-first, purpose-built for a truck, not a desk. Low-medium effort, meaningfully improves field adoption.
10. **Offline capture with background sync for the Lite mobile PWA.** *Evidence:* not directly cited in a specific review but is a structural requirement implied by every field-tech tool researched (XOi, ServiceTitan Mobile) working in basements/rural sites with poor signal; a document tool that fails offline will get abandoned in the field. Medium effort, high value, table-stakes for the mobile roadmap already underway.
11. **"Ask across shops/units" county- or region-level rollups (e.g., "how many Trane units in Maricopa County") as a first-class saved-query/report feature**, differentiated from FSM's per-customer view. *Evidence:* this is explicitly one of DeepWell's own target questions and no FSM platform's public marketing shows portfolio-level natural-language rollups — Titan Intelligence's Benchmark Reporting is business-performance, not equipment-portfolio, analytics. Medium effort, distinctive value.
12. **Transparent, published AI pricing** (a lesson from what to avoid, framed as an improvement to how DeepWell sells): *Evidence:* Housecall Pro's CSR AI 24/7 add-on and most competitors' AI add-ons have no published price ("you find out during the sales process") — a repeated pattern across the category. DeepWell keeping AI features inside clearly published Solo/Shop/Crew/Fleet tiers is a low-effort, real differentiator in trust and sales friction.

### (c) Explicitly out of lane — do not build
- **Dispatching/scheduling and technician routing** — ServiceTitan, Housecall Pro, Jobber, Workiz all compete hard here; it's a mature, defended category and not what shops are hiring DeepWell for.
- **Estimating/quoting and sales-proposal tools** — Housecall Pro's MAX tier and Jobber both bundle this; building it duplicates the tool DeepWell is supposed to sit beside.
- **Invoicing/payments processing** — regulatory/PCI overhead and a saturated field (every FSM plus Stripe/Square-style processors); no evidence DeepWell's target user is unhappy with existing options.
- **Payroll/timesheets** — Successware, ServiceTitan, Housecall Pro all have this; out of DeepWell's "memory of the business" positioning entirely.
- **CRM/marketing automation and ad optimization** (e.g., ServiceTitan's Ads Optimizer, Housecall Pro's Marketing AI, Jobber Copilot's content generation) — this is where every FSM vendor is aiming its own AI; competing head-on here means fighting entrenched incumbents on their home turf instead of the document/knowledge gap they're all ignoring.
- **GPS/fleet tracking** — ServiceTitan's Risky Driver Detection covers this; unrelated to documents/warranty.
- **Full inbound-call answering (a CSR AI competitor)** — Housecall Pro's CSR AI and ServiceTitan/BuildOps are pushing hard into voice; building this would move DeepWell from "memory" into "front office," diluting the pitch and requiring telephony infrastructure DeepWell doesn't need.
- **Manufacturer-side warranty adjudication** (deciding whether a claim is valid) — that's Carrier/Trane's own business process; DeepWell's job is to assemble the *packet*, not replace the manufacturer's approval workflow.

### (d) Positioning/messaging lines
- "The memory beside your FSM." / "Donovan remembers so your CSR AI doesn't have to guess."
- "Every FSM has an AI teammate for booking calls and writing marketing copy. None of them can tell you, with a citation, whether the unit at 123 Main is still under warranty."
- "We don't replace ServiceTitan, Housecall Pro, or Jobber — we're the paperwork and warranty memory that lives behind them."
- "Cited answers, not chatbot guesses" — direct contrast with Atlas's own disclaimer that it "may generate inaccurate, incomplete, or outdated responses" with no visible source shown.
- "Published pricing, no sales-call surprise" — contrast with the industry pattern of undisclosed AI-addon pricing (Housecall Pro CSR AI, etc.).

### (e) Pricing context of AI add-ons in the category
- Housecall Pro: base plans $59–$329/mo (1 user to unlimited features), +$35/user; **CSR AI 24/7 phone-answering is a paid add-on with no published price** — sold only through a sales conversation. Most other add-ons (Pipeline, Voice, HCP Assist, Campaigns, Payroll) are similarly undisclosed.
- ServiceTitan: no public pricing at all (demo/quote-only); Titan Intelligence features appear to be bundled/tiered within existing contracts rather than sold as a distinct visible SKU.
- Jobber Copilot: currently **free in beta** (US/Canada) — a customer-acquisition/data-gathering play rather than a monetized product yet.
- **Pattern:** the category treats "AI" as a black-boxed, sales-gated upsell rather than a transparent line item. DeepWell keeping AI-assisted Q&A inside its named Solo/Shop/Crew/Fleet tiers (rather than a hidden add-on) is both simpler to sell and a point of differentiation worth stating explicitly in messaging.

---

## Sources
- https://www.servicetitan.com/features/titan-intelligence
- https://help.servicetitan.com/commercial/docs/atlas-home
- https://help.servicetitan.com/docs/track-manage-installed-equipment-1
- https://glama.ai/mcp/servers/JordanDalton/ServiceTitanMcpServer/tools/installed_equipment_post_attachment
- https://developer.servicetitan.io/docs/faqs-developers/
- https://www.servicetitan.com/templates/hvac/warranty
- https://www.g2.com/products/servicetitan/reviews?qs=pros-and-cons
- https://www.capterra.com/p/150053/ServiceTitan/reviews/
- https://www.housecallpro.com/features/ai-team/
- https://help.housecallpro.com/en/articles/9740104-csr-ai-overview
- https://projul.com/blog/housecall-pro-pricing-analysis-2026/
- https://www.greenindustrypros.com/business-management/software/product/22922371/jobber-jobber-launches-jobber-copilot
- https://servicetrade.com/products/servicetrade-platform/features/
- https://servicetrade.com/industries/mechanical-commercial-hvac/
- https://buildops.com/platform/opsai
- https://buildops.com/resources/best-contractor-software-ai-features
- https://xoi.io/article/not-just-a-documentation-tool/
- https://www.glean.com/perspectives/top-ai-assistants-for-accurate-source-citations
- https://www.glean.com/blog/secure-generative-ai-for-the-enterprise-requires-the-right-permissions-structure
- https://dash.dropbox.com/features/chat
- https://dropbox.tech/machine-learning/bringing-ai-powered-answers-and-summaries-to-file-previews-on-the-web
- https://msdynamicsworld.com/blog/introducing-sharepoint-knowledge-ai-search-powered-azure-ai-search-copilot
- https://team400.ai/blog/2026-05-microsoft-365-copilot-plugin-citations
- https://www.trane.com/residential/en/resources/warranty-and-registration/register/
- https://partners.trane.com/warranties
- https://measurequick.com/smart-diagnostics/
- https://www.hvac-talk.com/threads/goodman-warranty-sol-is-this-how-all-hvac-is.1815061/
- https://www.hvac-talk.com/threads/goodman-not-honoring-warranty.2247739/
