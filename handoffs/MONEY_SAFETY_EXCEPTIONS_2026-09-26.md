# Money safety exceptions (Round 18, H3, D1 #3/#4)

r16_d1_pipeline.json's routing_conflicts audit flagged 7 (now 22, once the full 904-question corpus is
counted — see `scripts/golden/router-multi-claimed.json`) "money+relations" conflicts: financial-shaped
questions (relations own `classifyRelationsQuestion` claims them, AND `isMoneyQuestion`/`isFinancialQuestion`
also claim them) that relations answers at trial order 0.35, before the money gate ever gets a look at
0.65. The audit's own note: "benign here since relations answers with real counts, but this means the money
gate's careful 'no fabricated $ figures' guard can be silently bypassed by relations for any phrasing
relations' own shape detector also matches."

This document is the promised follow-up: for every relations family that can win a money conflict, decide
**keep** (relations answers correctly and cites) or **route to the money gate**, and record why.

## Decision: KEEP, for every family below

Every relations family that can win a money+relations conflict answers one of:
  - a plain **document-type count** (`docTypeDocumentCount`: "how many invoices do we have on file" —
    `documentsOfType` count, no dollar figure anywhere in the answer),
  - a **document-type presence/absence** check per customer (`docTypeCustomersSet`/`Count`,
    `docTypeNoRecentVisit`, `hasNeverHadDocType`, `quotedReplacementSet`/`Count` — all EXISTS/NOT EXISTS
    over `document_entity_links`, no `document_financials` row ever read),
  - or a **Yes/No or count derived from real `document_financials` rows**, gated on
    `tenantHasFinancialRows(db)` (`invoiceQuoteMismatchSet`/`Count`/`YesNo`, `quotedNoInvoiceSet`/`Count`/
    `YesNo`, `openInvoiceSet`/`Count`) — these DO sum real invoice/quote totals internally to compare them,
    but the comparison result (a Yes/No, or a customer count/list) is the only thing that ever reaches the
    answer text; no handler in `relations/questions.js` or `connect2.js` prints a raw `$` figure anywhere
    (verified by grep — none of `finish(...)`'s `text` arguments interpolate a computed total).

None of these is the shape the money gate exists to stop: `isMoneyQuestion`/`moneyFallbackAnswer`'s whole
job is to say "not built yet" instead of fabricating a specific dollar amount (`"$0.00 across N
documents"`) for a question that has no real answer. Every family above HAS a real, correctly-cited
answer — a document count, a presence check, or a comparison over real financial rows that degrades to
`null` (falls through, same as any other pre-router miss) the moment `tenantHasFinancialRows(db)` is
false. Routing these to the money gate instead would turn a correct, cited answer into a wrong, unhelpful
"we don't have that yet" — worse for the customer, not safer.

**Verdict: keep.** relations answering first is an accepted exception, not a bug — see
`scripts/verify-router.mjs`'s `MONEY_SAFE_RELATIONS_FAMILIES` allowlist, which fails loudly if a FUTURE
relations family (one not on this list) ever wins a money conflict, so this decision is re-reviewed rather
than silently inherited by new code.

## What would NOT be safe (why the allowlist is closed, not "any relations family")

A hypothetical relations family that computed and printed an actual sum ("customer owes $4,231.50 total")
would be exactly the fabrication risk the money gate exists to prevent, UNLESS it is itself gated on
`tenantHasFinancialRows` — which is why the allowlist is a closed, named set of today's families, not
"relations wins, and that's fine by construction." `scripts/verify-router.mjs` enforces this: any question
where a NEW relations family wins a money conflict fails the money-safety check until a human reviews it
and either adds it to `MONEY_SAFE_RELATIONS_FAMILIES` (with the same reasoning as above) or fixes the
family/gate so it doesn't win that conflict.

## Out of scope this round: money+deterministic, money+fastPath

The corpus also has money conflicts where `deterministic` (6) or `fastPath` (3) wins instead of relations —
same shape of question (a financial noun the money gate's classifier also flags), same "the winner answers
with a real, cited value, never a fabricated $ figure" property on inspection, but `deterministicRouter.js`/
`fastPath.js` are H1-owned this round (`../R18_CONTRACT.md`), not H3's. Recorded by
`scripts/verify-router.mjs` for visibility (printed, never failed) so H1/a future round can make the same
keep/route call for those with the same rigor.
