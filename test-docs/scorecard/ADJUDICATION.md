# Donovan Scorecard: adjudication log

The first production run (2026-09-24, founder tenant, 75.9%) failed 69 of 286 answered questions. Before trusting that number
every failing question was adjudicated: **is the answer key (oracle) or the grader wrong, or is Donovan?** Where the exam was
wrong it was fixed and the fix is pinned by a test in `scripts/verify-scorecard.mjs` (section 3b, seeded shop with hand-computed
answers). Where a definition is genuinely ambiguous the oracle accepts either documented reading **only if the answer states which
one it counted** (`alts` in the oracle: `oracle.alt`, checked by `compare.js`).

Verdicts: **ORACLE** = the exam was wrong, fixed. **GRADER** = the comparison was too strict, fixed. **BOTH-OK** = two defensible
definitions, either accepted when stated. **DONOVAN** = the exam is right; the failure stands (and belongs to the answering team).

| Question | Verdict | Reason and rule now in force |
|---|---|---|
| Show me a breakdown of customers by city (Mesa 18 vs 19) | ORACLE | The oracle's geography regex required `, ST 85xxx`. Addresses shaped `City ST 85201` (no comma before the state), or with no zip, were silently in no bucket, so the oracle lost one customer everywhere (46 customers, 45 counted). Owner meaning: a customer's city is the locality in their one service address. New rule (`CITY`/`STATE`/`ZIP` in `gen-scorecard.mjs`): city = last comma segment that is not a unit/suite/street segment after stripping a trailing state+zip; state = the 2 letters before the zip (comma or not, ZIP+4 ok) or a trailing `, ST`, or "Arizona"; zip = the trailing 5 digits. A customer with no recognisable city/state is counted in no bucket, never guessed. To list the customers the old regex missed: `SELECT c.data->>'customer_name', c.data->>'service_address' FROM entities c WHERE c.entity_type='customer' AND c.merged_into IS NULL AND c.data->>'service_address' !~ ',[[:space:]]*[A-Z]{2}[[:space:]]+[0-9]{5}'`. The exact record cannot be named from the aggregate; the mechanism is confirmed by reading Donovan's own parser (accepts the no-comma form) against the oracle's. |
| breakdown of customers by state (AZ 44 vs 45); how many in Mesa / AZ | ORACLE | Same root cause as above (one customer dropped from every geography count). Pinned by the seeded shop: Mesa 4, AZ 7, NV 1, ZIP+4, no-zip and no-comma addresses all counted. |
| how many customers have no email on file (E 46 vs G 29) | ORACLE | The bank entry only *names* its condition (`conditionsOnly: ["email"]`, no filter), and the generator silently graded it as an unfiltered customer count (all 46). Donovan's 29 was the real count. New rule: a `conditionsOnly` entry gets its filters derived from the wording (no/without/missing = false) or is dropped, and an unfiltered count is refused when the wording carries any condition word (email, phone, county, brand, "in <place>"). Same defect existed for "which customers have a phone number on file", "how many customers are in Mesa" and "in Arizona". |
| how many customers have a unit newer than 5 years old (E 18 vs G 10) | ORACLE | The question asks for **customers**; the bank filed it under `equipment` and the oracle counted **units** (18 units, 10 customers). New rule: "customers/clients/accounts ... have a unit ..." counts distinct customers with a qualifying unit. "Newer than N years" = install year >= current year - N (install dates are often year-only). |
| do we have more invoices or more service tickets on file | ORACLE | The oracle graded a 15-item set of every document type. It is a comparison of two types: now a small rubric over the two counts (must name the larger, or say tied). Donovan's "You have 68 documents" stays a failure (**DONOVAN**). |
| is the Salazar unit still under warranty (E unknown vs G "no warranty date on file") | GRADER | Same answer. `warrantyStatusFromText` now reads "no warranty date/expiration/info on file", "warranty ... not recorded/listed", "no expiry listed" as **unknown**. |
| how many times have we been to Mercer's (G "4 visits") | BOTH-OK | It was a model-graded rubric whose reference listed all documents, which cannot check a number. Now a number: a visit = a distinct completed service date on a service-type document (ticket, report, work order, dispatch note, inspection, startup sheet, invoice) dated on or before today. A per-document count is accepted only if the answer says it counted documents/tickets/work orders/records; a surname that matches several customers accepts each customer's own count when the answer names that customer. |
| show me a breakdown by tech (G "170 service visits by technician") | ORACLE | The rubric's reference counted every document that has a technician value, but a job is a document with a service date, which is what Donovan counts. It is now a deterministic set `tech|jobs` (a job = a document with a service date, attributed to its technician). "Who did the most jobs" is now a deterministic value (ties all accepted). |
| When did we last service the unit at 988 W Southern Ave / 3300 S Alma School Rd, Apt 104 (G "November 14, 2027", a future date) | ORACLE + DONOVAN | Two oracle defects: (1) any dated extraction counted, including agreement start dates and scheduled visits; (2) an address with `Apt 104` matched the whole complex. New rule: **last service = the newest completed visit** (service-type document with a service date on or before today); a future date is a *scheduled* visit, never "last service"; an address with Apt/Suite/Unit selects that unit. Donovan answering with a future date stays a failure (**DONOVAN**). |
| what do we have on file for donald holbrook (G contact card only) | DONOVAN | Oracle is a rubric over the documents on file (types, dates). A contact card alone is not what a shop has "on file". Unchanged. |
| Who installed the Mitsubishi at 359 E Broadway Rd (G "Marisol Vega installed") | ORACLE (widened) | There is no structured "installed by" field, so the old oracle was always empty. The installer is now read from the document text ("Installed by <Name>", "installation performed/completed by <Name>"). If no document says so the expectation is empty and Donovan must decline: naming the technician of a different visit is fabrication (**DONOVAN**). |
| when was the unit at 137 W Southern Ave installed (E none, G states a date) | ORACLE (widened) | The oracle only read the unit record. An installation date printed on one of the address's documents is "on file" too; it now accepts both. If neither exists Donovan must decline (**DONOVAN**). |
| list invoices for delgado (E 2 vs G "none for Barbara Delgado") | BOTH-OK | The surname matches more than one customer. The oracle counts all Delgados (2); an answer about one Delgado is accepted when it names her and gives her own count. An answer that silently picks one and says none stays wrong. |
| did we pull a permit for 174 N College Ave (G "more than one match") | DONOVAN | The question names an address, not a customer; asking "which one?" at a single address is not an answer. Oracle unchanged (address-level). |
| Which customers are overdue for maintenance / who's due for fall maintenance | ORACLE (tightened) + DONOVAN | Oracle now: customers whose last **completed visit** is more than 12 months before today (customers never serviced are not "overdue"; agreement dates are not visits). The rubric says describing agreement coverage is not an answer, so Donovan's agreement-text answer stays a failure (**DONOVAN**). |
| any notes on the rios unit | DONOVAN | Rubric over the notes/observations in that customer's pages. Serial/model plus one visit is not "notes". Unchanged. |
| How many documents have we added year to date / last month (E 239 / 0 vs G 123 / 11) | BOTH-OK | "Added / uploaded / received" = the day it entered the system (`created_at`); "serviced / worked" = the service date. The upload reading is primary. The service-date reading is accepted only if the answer says so ("by service date", "dated", "work performed"); the mirror rule applies to "how many invoices this month" (work date primary, upload date accepted when stated). Donovan answering by service date **without saying so** stays a failure. |
| service visit counts (time category) | ORACLE (tightened) | A visit is one document plus one service date (a duplicated extraction row is not a second visit). |

## Money questions

The nine bank "money" honest-zero questions ("What's the total dollar amount of our open invoices?", ...) were retired by the live
financials layer (34 skipped in the first run). They are replaced by 80+ real financials questions (81 in the financials category, plus money-based data-quality, existence, trend and ranking questions) whose oracles read
`document_financials` (M3-config/22) with the same rule the product uses for reviewed numbers: a `corrections` value beats the
extracted one. Definitions: **invoice** = `doc_kind='invoice'` and `direction='receivable'`; **open** = status unpaid/partial;
**overdue** = open and due date before today; **owed** = balance due (or total minus paid); **revenue/invoiced** = invoice total by
invoice date; **collected** = paid invoices' total plus the paid part of partial ones. Money answers are graded to the dollar and
the figure may be any number in the sentence. When the table or its rows are absent the questions are **retired (skipped), never failed**.

## Citations

A question now passes only if the value is right **and** the answer carries at least one citation (`sources`, `facts[].sources`,
`citations`, `records`, `drillDown`, or a fact's `documentId`), unless the right answer is itself empty (zero, no, not on file, an
honest decline), where there is nothing to cite, or the question is tagged `citationRequired: false`. Rubric questions say what must
be cited (`citeWhat`). The run reports **pass score, value-only score and citation coverage separately**, so a shop can see that
Donovan is right but uncited (fix: attach records) versus wrong (fix: answer logic). Right-but-uncited answers are not retried on
Sonnet (more model will not add a source).

## Not adjudicated from here (needs the live records)

The exact customer behind the geography count and the specific documents behind the 988 W Southern and 137 W Southern answers
cannot be identified from the failure summary. The rules above are the ones a business owner means and are pinned on seeded data;
after the next production run any remaining disagreement on those rows is Donovan's, and the failing list shows expected vs got.

## Round 16 (2026-09-26): address-answer policy — owner product decision 2026-09-26

**Decision** (R16_CONTRACT.md): a question about the unit's warranty, manufacturer, tonnage, refrigerant, or install date,
resolved by a raw street ADDRESS (`ADDRESS_ENTITY_FIELD_INTENTS` in `api/_lib/fastPath.js`), is no longer a blanket
"not on file". Resolve address → customer(s) → their unit(s) and:
- exactly one customer + one unit (or a named brand/model narrows several down to one) → answer, with an explicit
  match-basis sentence ("the only \[Trane\] unit on file for \<addr\> (\<customer\>)") and the field's own citation.
- one customer, several units, nothing disambiguating → list every unit, each with its own answer + source.
- several customers at the address (apartment complex, no unit # given) → ask which one, list who's there. Never pick.
- nothing on file at the address → unchanged ("not on file for that address").

Implemented in `api/_lib/fastPathQuery.js` (`resolveAddressEntityFieldGroup` + `runAddressEntityFieldPolicy`, called from
`runFastPath` in place of the old blanket `buildAddressFieldDecline` for these six intents) and `api/_lib/fastPath.js`
(`buildFieldAnswer`/`buildWarrantyAnswer` gained an optional `labelOverride` for the match-basis sentence;
`buildAddressFieldDecline` gained a `multi-customer` case that lists names instead of a generic "ambiguous"). Tests:
`scripts/verify-address-lookups.mjs` section 4 (single unit via a customer match, single unit via the unit's own address,
brand-narrows-to-one, no-disambiguation multi-unit list, two-brand-words-match-two-units, several-customers ask-which,
apartment-with-unit# answers only that unit, nothing-on-file, field-genuinely-missing defers to the model) plus the
required look-alike/negative traps (same house # different street, same street different city — two real accounts, never
conflated, typo'd street fails safe).

**Oracle fix** (`test-docs/scorecard/exam.json`, SQL only — never hard-coded values, never touching any other question):
these 4 field-templates' oracle SQL matched ONLY an equipment row whose OWN `service_address` matched (this corpus's
equipment entities never carry one — see R15's own note above); broadened to also resolve via a matching CUSTOMER's
address, joined by `customer_id` — the same address → customer → unit path the fast path now takes:
```
-- was:  e.entity_type = 'equipment' AND e.merged_into IS NULL AND e.data->>'service_address' ILIKE $1
-- now:  e.entity_type = 'equipment' AND e.merged_into IS NULL AND (e.data->>'service_address' ILIKE $1
--         OR e.customer_id IN (SELECT c.id FROM entities c WHERE c.entity_type = 'customer'
--                                AND c.merged_into IS NULL AND c.data->>'service_address' ILIKE $1))
```
Verified against the real golden corpus (`scripts/golden/golden-export.json`) that every adjudicated address resolves to
exactly one customer with exactly one unit, so this broadening introduces no new ambiguity for any of these 24 ids.

**Changed ids** (24 — every one a `value`-cmp "is the unit at \<address\> ..." question; verdict **ORACLE**, reason "owner
product decision 2026-09-26"):
- warranty (15): `warranty-0001-canonical/-typo/-abbreviated`, `warranty-0002-canonical`, `warranty-0006-canonical`,
  `warranty-0008-canonical`, `warranty-0012-canonical/-typo/-abbreviated`, `warranty-0017-canonical`,
  `warranty-0029-canonical/-typo/-abbreviated`, `hvac-tech-0039-canonical`, `hvac-tech-0073-canonical`
- manufacturer (5): `lookups-0092-canonical`, `lookups-0019-canonical`, `lookups-0024-canonical/-typo/-abbreviated`
- tonnage (3): `hvac-tech-0085-canonical/-typo/-abbreviated`
- refrigerant (1): `hvac-tech-0036-canonical`

**Measured effect** (offline exam, golden tenant, `today=2026-09-25`, models disabled): wrong is **unchanged at 4** (same
4 ids as before — `breadth-content-019`, `breadth-semantic-001/002/003` — verified id-for-id, no new wrong). Of the 24,
only `hvac-tech-0036` (refrigerant) is answerable without a model in THIS corpus (refrigerant is the one field of the six
with a real per-entity `extractions` row — confirmed: manufacturer/model/serial_number/installation_date/warranty_expires
have ZERO extraction rows anywhere in the golden export, only `entities.data`, so warranty/manufacturer/install-date
answers correctly decline to fabricate a citation and instead defer to the model = `needs-model`, never `wrong`); the
other 23 move `correct → needs-model` (honest: the shop DOES have this on file, Donovan just can't cite it without a
model yet — that gap is a citation-pipeline one, outside `fastPath*.js`, not this policy). Net: `answeredWithoutModel`
687→664, `correct` 609→586 (a deliberate, adjudicated drop — see `scripts/verify-golden.mjs`'s own updated floor comment;
its `wrong` floor is untouched). `hvac-tech-0036` example: was `no-answer: not on file`; now `answer: The only unit on
file for 507 N Dobson Rd, Casa Grande, AZ 85122 (Donald Sorenson) takes R-410A.` (cited, `citationPrecision: 1`).

**Explicitly NOT touched** (left declining "not on file", per "never loosen anything else"): `lookups-0010-canonical/
-typo/-abbreviated`, `lookups-0084-canonical`, `hvac-tech-0007-canonical` (install-date questions already resolve their
address/unit correctly via a separate mechanism that states "No install date is recorded for the \<manufacturer\>
\<model\> at ..." — a genuine, already-correct, model-free decline that does not reach the address-entity-field policy
at all; updating their oracle to expect a real date would turn a correct decline into a hard wrong, since that mechanism
never attempts a model call to fall back on). `live-misses-2026-09-21-0018-*` (766 N Val Ivsta Dr — a typo severe enough
that no real address matches at all; still correctly "not on file" either way) and `live-misses-2026-09-21-0019-canonical`
(serial number — not one of the six `ADDRESS_ENTITY_FIELD_INTENTS`, unaffected by this policy) were identified by the same
oracle-SQL-shape search and deliberately left alone.
