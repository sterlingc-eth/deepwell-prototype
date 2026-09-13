# Document handling & data agreement — draft framework

**⚠️ NOT LEGAL ADVICE. NOT A FINISHED CONTRACT.** I'm not a lawyer, and this cannot be sent to a customer as-is. This is a first-draft framework — the terms a document-ingestion agreement actually needs to cover, in plain language with sample clause language attached — meant to save your attorney time by giving them a real starting point instead of a blank page. Have an actual attorney review, revise, and approve this before it goes anywhere near a customer signature. Some of the numbers below (retention windows, liability caps, SLA percentages) are placeholders marked clearly — they're business decisions for you and counsel to set, not defaults I'm qualified to pick.

**Date:** September 13, 2026 · Companion to `claude/M3_PLAN.md` (the infrastructure that has to exist for these terms to be true) and `claude/INGESTION_STRATEGY_AT_SCALE.md` (the process that has to exist for the accuracy terms to be honest).

## Why this exists now

You can't honestly ask a company to hand over thousands of documents — service records, warranty paperwork, customer information — without telling them, in writing, what happens to that data and what DeepWell promises and doesn't promise about what comes out of it. This isn't optional paperwork; it's the thing that turns "trust us with your documents" from a sales pitch into something a business owner can actually say yes to.

## The terms this needs, and why each one matters

### 1. Data ownership
**Plain English:** the customer's documents and everything extracted from them belong to the customer, always. DeepWell processes them; DeepWell doesn't own them, doesn't sell them, doesn't use them to train anything, and doesn't keep them if the customer leaves.

**Sample clause direction:** *"Customer retains all right, title, and interest in and to Customer Data. DeepWell is granted a limited, non-exclusive license to process Customer Data solely to provide the Service. DeepWell will not use Customer Data to train any machine learning model, DeepWell's own or a third party's, and will not sell, rent, or otherwise disclose Customer Data to any third party except as necessary to provide the Service (see §5, Subprocessors) or as required by law."*

### 2. Retention and deletion
**Plain English:** documents stay as long as the customer is a customer. If they leave, DeepWell deletes everything within a stated window and can prove it. This directly depends on M3's tenant-deletion job and "signed deletion certificate" actually existing (`claude/M3_PLAN.md` §3) — don't promise this in writing before it's built.

**Placeholder to fill in with counsel:** deletion within **[30 days — placeholder]** of account termination; backup copies purged within **[60 days — placeholder]** given normal backup-rotation windows.

**Sample clause direction:** *"Upon termination of this Agreement, DeepWell will delete all Customer Data, including backups, within [N] days, and will provide written confirmation of deletion upon request. Customer may request a full export of Customer Data at any time prior to termination in a standard machine-readable format at no additional charge."*

### 3. Security commitments
**Plain English:** documents are encrypted in transit and at rest, access is limited to what's needed, every access is logged, and one customer's documents are never reachable by another customer — enforced, not just promised.

**Sample clause direction:** *"DeepWell will maintain administrative, physical, and technical safeguards designed to protect Customer Data, including encryption in transit (TLS 1.2+) and at rest, role-based access controls, tenant-level data isolation enforced at the database layer, and audit logging of all access to Customer Data. DeepWell will notify Customer of any confirmed unauthorized access to Customer Data without undue delay and in no event later than [72 hours — placeholder, check applicable state/federal breach-notification law with counsel] after DeepWell becomes aware of it."*

This section should not be signed until `claude/M3_PLAN.md`'s security items (RLS, encryption at rest, audit log) are actually built and independently verified — a security commitment made before the infrastructure exists is the kind of gap that becomes a real liability the first time it's tested.

### 4. Accuracy — what's promised, and, just as important, what isn't
**Plain English, and the part that needs the most care:** DeepWell should never promise "our AI is X% accurate" as a guarantee, because — as Sterling's own math shows — even a genuinely good accuracy rate leaves real errors at volume. The honest, defensible commitment is about the *process*, not a number: every fact DeepWell surfaces is either human-verified or clearly labeled as unverified, sources are always shown, and the customer is never asked to take an unverified fact as fact. This is exactly what `claude/INGESTION_STRATEGY_AT_SCALE.md`'s Verified/unverified distinction is for — it's not just a UX pattern, it's the thing that makes an honest accuracy clause possible at all.

**Sample clause direction:** *"DeepWell does not guarantee that all information extracted from Customer Data is accurate. DeepWell's Service distinguishes between 'Verified' information (confirmed by a human reviewer or by independently corroborating sources) and 'Unverified' information (extracted automatically and not yet confirmed), and clearly labels each accordingly within the Service. Customer is responsible for independently verifying any Unverified information before relying on it for decisions with legal, financial, warranty, or safety consequences. DeepWell will provide Customer with a measured accuracy report for Customer's own document set as described in the onboarding process, and will notify Customer if measured accuracy for Customer's account falls below [95% — matches the existing NN-5 internal requirement] on the sampling methodology described in the Service documentation."*

**Do not, under any circumstances, let a liability or warranty clause promise a flat accuracy percentage as a guarantee** — that inverts the entire design of the Verified/unverified system into a number a lawyer can hold you to regardless of what actually happened on a specific document. Counsel should confirm the accuracy language is framed as a described process with monitoring, not a warranted outcome.

### 5. Subprocessor disclosure (the Claude API)
**Plain English:** DeepWell sends document content to Anthropic's Claude API to read and extract information. The customer should know this plainly, and DeepWell should have its own agreement with Anthropic covering how that data is handled (zero-retention where available, no training on customer data).

**Sample clause direction:** *"DeepWell uses Anthropic PBC's Claude API as a subprocessor to perform document reading and information extraction. DeepWell maintains a data processing agreement with Anthropic governing this processing. Customer Data submitted to Anthropic's API is not used by Anthropic to train its models. DeepWell will notify Customer of any change in subprocessor at least [30 days — placeholder] in advance."* — **Action item, not a drafting question:** confirm the actual terms of Anthropic's API data-handling commitments (retention window, training-use policy, available zero-retention options) directly from Anthropic's current commercial terms before this clause is finalized; don't rely on this document's phrasing as fact.

### 6. Service level and what happens when it's wrong
**Plain English:** uptime and response-time targets, and — the part that matters more for an ingestion product than most — what happens procedurally when a document is misread: is there a way for the customer to flag it, how fast does DeepWell fix it, and does fixing one wrong extraction re-check anything else like it (this is what M2's re-map mechanism already does technically — the agreement should describe that capability honestly, since it's a genuine strength).

**Sample clause direction:** *"DeepWell targets [99.9% — matches the existing SLO target] monthly uptime for the Service. Customer may flag any extracted fact as incorrect within the Service; DeepWell will investigate flagged corrections and, where the correction reveals a systematic pattern, will apply the correction across other affected documents without requiring Customer to re-submit them."*

### 7. Liability limitation
**Plain English:** standard SaaS practice is to cap liability (often at fees paid in the prior 12 months) and exclude certain categories of damages, with carve-outs for things like data breach or gross negligence. This is squarely a "have your attorney draft this" section — the placeholder numbers below are for discussion, not a recommendation.

**Placeholder to fill in with counsel:** liability cap at **[12 months of fees paid — placeholder, standard SaaS convention]**; carve-outs for breach of confidentiality, data security obligations, and gross negligence/willful misconduct are typical but should be sized by counsel to your actual risk (a warranty-claim decision made on bad data is a different risk profile than a typical SaaS outage).

### 8. What the customer needs to do on their end
**Plain English, easy to forget:** the customer should confirm they have the right to upload the documents they're uploading (e.g., customer PII from their own end customers), and should agree to review Unverified information before treating it as fact for anything consequential — this is the flip side of the honest accuracy clause in §4 and should appear as a customer obligation, not just a DeepWell disclaimer.

## What to do with this document

1. Fill in every `[placeholder]` with an actual decision — most of these are business/risk decisions (retention window, breach-notification timing, liability cap) that should be made deliberately, with counsel, not defaulted from this draft.
2. Confirm Anthropic's actual current API data-handling terms directly (§5) before finalizing that section — don't take this document's phrasing as verified fact about a third party's terms.
3. Send the filled-in draft to an actual attorney for review before it becomes a real agreement. This document is the head start, not the finish line.
4. Once approved, this becomes the reference for what the product must actually do — which is why `claude/M3_PLAN.md` (security, backups, deletion) and `claude/INGESTION_STRATEGY_AT_SCALE.md` (the Verified/unverified accuracy story) both need to be real before the corresponding clauses here are signed, not just drafted.
