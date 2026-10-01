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

## R31 (Donovan Team A) — oracle fixes and OWNER-DECISION conflicts

### Oracle fixes applied (verdict ORACLE, defect proven against the golden export)

1. `breadth-content-019` (and its sibling set question `breadth-content-020`), `breadth-semantic-001/002/003`. The two generator
   patterns in `test-docs/scorecard/breadth.mjs` were unanchored substrings:
   - `(frozen|freez|iced|ice )` — the bare `ice ` matched "Serv-**ice** Address:" on nearly every document, so the oracle expected 317 freeze-up jobs;
   - `(noise|noisy|loud|...)` — the bare `loud` matched "i**cloud**.com" in every customer's email, so the oracle expected 8 customers with a noise complaint.
   Fixed at the source (`breadth.mjs`): `ice ` -> `\yice\y`, `loud` -> `\yloud`, `noise` -> `\ynoise` (Postgres word boundary). Applied by an
   exact-string replacement of those two patterns in `exam.json` (no other question changed: verified id-for-id) and the generator version
   hash re-stamped so `node scripts/gen-scorecard.mjs --check` passes. NOTE: `exam.json` carries hand-applied post-generation edits
   (keyFacts, address-policy oracles), so do NOT regenerate it wholesale; re-run `gen-scorecard.mjs` only to `--check`.
   Corrected expected values (measured on the golden export): freeze-up count 0 (the question's `requires` probe is now 0, so the exam
   SKIPS it — the fixture genuinely has no freeze-up text); noise customers `[]`, noise jobs `0`. Donovan already answered "No documents
   on file mention noise" (correct). Effect: wrong 12 -> 8, skipped 50 -> 51, correct +3. The ids are removed from
   `KNOWN_WRONG_IDS` in `verify-golden.mjs` / `verify-precision-guard.mjs`.
2. `generalization/dialogues-2.json` e033-e040 (turn 1). The oracle SQL selected the customer name from EQUIPMENT rows, so the graded
   "who is the customer at <address>" turn expected the wrong entity. Now selects `c.data->>'customer_name'` from customer entities with a
   single-customer guard. (Found because Donovan's slot-filled, correct answer was flagged "fabricated".)

### OWNER DECISION — options, nothing chosen here

**h115 / k141 "which technician has the fewest visits / jobs logged".** Oracle = fewest `technician` extractions, ties broken by name
(`Denise Ford`, 55); Donovan answers `Ray Sutton` (50 dated service visits). The corpus has TWO defensible units and they disagree:
Denise Ford 55 and Ray Sutton 55 tie on tagged records, but Ray has only 50 that carry a service date. Options:
  A. "Visit" = a service record naming the technician (oracle reading). Donovan's analytics count would switch to technician
     extractions; ties must be reported as ties ("Denise Ford and Ray Sutton tie at 55") — the oracle's alphabetical tiebreak then also changes.
  B. "Visit" = a service record with a service date (current Donovan). Change the oracle to that definition (Ray Sutton, 50).
  C. Answer both, state the definition ("by dated visits: Ray Sutton 50; by tagged jobs: tie Denise Ford / Ray Sutton 55") — passes any oracle that
     accepts either via `alts`. Recommended: C now, decide A vs B when the owner settles the vocabulary ("job" vs "visit").

**j141 / j142 / j143 "units over 15 / over 10 / under 5 years old".** Oracle = exact date age (`installation_date <= today - N years`):
20 / 59 / 35. Donovan filters by calendar-year difference: 17 / 53 / 42 (a unit installed 2011-12-30 is "15 years" on 2026-09-25 by year
math but 14.7 by date). Options:
  A. Exact-date age everywhere (matches the oracle and "how old is the unit" which already uses whole years by date). Change the
     `installYear` age filters in `analytics.js`/`detPlan.js` to date arithmetic. Recommended: it is the natural reading and the only
     one that agrees with the per-unit "how old" answer.
  B. Keep calendar-year age and change the three oracles (and say "by install year" in the answer).
  C. Both figures in the answer ("20 units are over 15 years old by install date; 17 by install year").

**Typo policy: lookups-0101-typo, lookups-0106-typo, live-misses-2026-09-21-0002-typo.** Oracle expects the fuzzy-resolved value
(e.g. the phone for "maaria gallardo"); Donovan answers `I don't have a customer named "maaria gallardo". Did you mean Maria Gallardo?` (R21 P0
policy: a one-edit near-miss is never auto-resolved, because "Amanda Quinly" -> a different real customer's PII). Options:
  A. Keep the policy; change these three oracles to `honest-zero`/"asks Did-you-mean" (recommended: a phone number is PII).
  B. Auto-resolve ONLY with a second signal (the customer's own address or serial in the same question — already implemented as
     `corroboratesCandidate`), else Did-you-mean. This is today's behavior; the three questions carry no second signal.
  C. Auto-resolve when exactly one customer is within edit distance 1 AND the field is non-PII (address of a business). Not recommended.
R31 extends the same policy to shapes that had no near-miss handling ("pull up the file for Nanc Alvarez", "who is Kevinn Zimmerman").

### R26 "+1 wrong" root cause
`scripts/offline-exam.mjs` never pinned a time zone. The oracle SQL casts `created_at::date` in the PGlite SESSION time zone, which
follows the host `TZ`. Under `TZ=UTC` (a scheduled / CI environment) one rolling-window date bucket moved a day and one question flipped
correct -> wrong; under `America/Phoenix` (every developer run and the R24/R25/R27 numbers) it does not. Fixed by pinning
`process.env.TZ = process.env.DONOVAN_EXAM_TZ || "America/Phoenix"` at the top of `offline-exam.mjs`. The canonical invocation
(`TZ=America/Phoenix EXAM_TODAY=2026-09-25 node scripts/offline-exam.mjs scripts/golden/golden-export.json out.json out.md`) is unchanged.

## R32 (Team A, deterministic coverage) — owner decisions applied, blind-oracle conflicts, one rejected rule

### Owner decisions from the "OWNER DECISION" section above, decided by the owner on 2026-09-30 and applied in R32

- **h115 / k141 "fewest visits / jobs logged" — a visit is a distinct dated visit.** Oracle rewritten to count DISTINCT documents that carry a
  `service_date` per technician (Ray Sutton, 50), ties reported as ties. Donovan already counted this; nothing changed in the engine.
- **j141–j143 (and 21 sibling oracles) "N years old" — exact-date age.** `resolveAgeFilter` filters on `installDate` (`<= today - N years`,
  `> today - N years` for newer) instead of the calendar-year difference; a year-only / year-month install date is compared conservatively.
  24 exam / field-phrasing oracles that had encoded the calendar-year reading were rewritten to the exact-date SQL (`exam.json`,
  `field-phrasing-2/4/5.json`, generators updated). The "how old is the unit" per-unit answer already used whole years by date.
- **Typo'd names auto-resolve when unambiguous, visibly.** `lookups/typoResolve.js` (policy documented at the top of the file): one candidate,
  same word count, per-word Damerau distance <= 2 (<= 1 under 6 letters), words under 4 letters must match exactly, total <= 2, no other customer
  within distance 3, the mistyped word is not a real word / given name / surname / brand / city / street word and is not another customer's word,
  not typed in quotes. The answer starts `Showing results for X (you typed "y").` and the client shows a one-tap "Not who you meant?" chip that
  re-asks with the name quoted ("as typed" restores the honest decline). Oracle field `typoResolvesTo` (compare.js) accepts either the resolved value
  or the honest decline for j176–j180, k161–k165 and the R31 near-miss blind sets. Kill switch `DONOVAN_TYPO_AUTORESOLVE=0`. The three PII-worry
  options above (A/B/C) are superseded: the visible note plus the one-tap escape is the safeguard, and every "could be a different real person"
  shape (two similar customers, short names, real words, a typo equal to another customer's word, > 2 edits, quoted) is a negative test in
  `scripts/verify-r32-coverage.mjs`.

### Blind-oracle conflicts found while writing the R32 blind sets (the ENGINE's adjudicated reading won; the blind oracle was corrected)

- **"tickets" / "work orders"** are DOCUMENT counts in this engine, never visit counts (frozen by exam ids); the window blind set does not assert them as visits.
- **"still / under warranty" count** is the strict >365-day "active" bucket (frozen by `counts-warranty-0004`); the future-side count is not asserted.
- **Install date at a multi-unit address** enumerates every unit; a single-date oracle is wrong there.
- **Multi-customer address attribute questions** stay an honest "which one?" decline (R16 owner decision); the new bare-surname stage reuses that policy.
- **Technician totals have two adjudicated readings that disagree**: "how many jobs has X done in total" = distinct documents with a service date
  (`breadth-tech-performance-*`, 52 for Danny Ochoa); "how many jobs/calls has X done / been out on, total" = technician records (`field-phrasing-5` k133, 57).
  The rewrite maps the "calls ... total" phrasings onto the record-count reading (k133's convention) and leaves the exact "in total" wording alone.
  Owner decision needed if one number is wanted everywhere.
- **Replacement-due (j136–j140)** oracle uses a 15-year heuristic with no product rule behind it: skipped deliberately, not fought.
- **"jobs for customer X" (g102)** counts distinct linked documents, which is questionable as "jobs": left as is, no new rules on top of it.

### Rejected rule (measured, do not re-add)

**Rule G, "decline any question that names a record-shaped noun nobody stores"** produced 21 false declines on the 1704-question exam (a record question that
merely contains a lexicon word, e.g. "condenser" or "filter" inside a real lookup). It is documented and removed in `router/earlyDecline.js`. The early-decline
rules that remain each need an off-domain lexicon hit AND the absence of every record anchor (customer name, address, serial, brand, unit noun), with a customer-name veto.

## R32b (Team A3, learning loops A-E) — oracle / convention conflicts found while writing the blind sets

The engine's already-adjudicated reading won in every case; the blind oracle was corrected, never the exam oracle.

- **"how many units are still under warranty" (shop-wide) vs a brand-scoped one.** The shop-wide figure keeps the owner's `counts-warranty-0004` reading
  (status `active` = more than 365 days left, 33), while the brand-scoped exam ids (h050, g135, h091-h098) count end date AFTER today. New code
  (`lookups/aggregates.js`) answers the unambiguous side only: units whose end date has PASSED (shop-wide or per brand, h132 reading, 79) and brand-scoped
  "still under warranty" (end date after today, with the within-a-year share named). The shop-wide "still under warranty" is left on the existing route.
  Owner decision needed if one number is wanted for the shop-wide question (33 vs 37).
- **"soonest warranty expiry"** is a from-today reading ("next to expire"), not the earliest date on file (h054 = earliest overall, 2014-01-13). Only
  earliest / first / oldest / latest / last / furthest-out are answered; "soonest" and "next" are left to the model.
- **"do we do more repair work or more preventive maintenance"** (a "which one" question) vs i019's yes/no oracle ("Repair > PM" = yes): the answer names the winner
  and both counts ("Repair has more visits: Repair 85, Preventive Maintenance 35"), which satisfies both oracles; the blind oracle uses "value" for the which-form.
- **"visits" = a dated `service_date` record (317)** for shop-wide counts (j048 convention), not documents with a service type (120).
- **Technician "jobs on file"** (pair comparisons, "who has the most/fewest jobs on file", per-technician typed counts) use the technician-record convention of
  `r31-technician*` / k133 (every document naming the technician: Kevin Pratt 59). The existing "busiest technician this year" keeps the dated-visit convention
  (`breadth-tech-performance-019`); the two disagree for shop-wide totals (see the R32 note above), so the answer text names what was counted.
- **No readable text:** every document in the golden tenant has text on at least one page, so "how many documents have no readable text" is an honest 0 (the old answer
  was "You have 500 documents").
- **Open invoices in a period:** no invoice in the golden tenant carries a payment status, so "any invoices from last quarter that are still open" is an honest
  "can't tell, none records a payment status" (kind no-answer); with real statuses on file the route yields to the money route.
- **City names that are also brand/surname words:** "temperature in New York" is off-domain, never "customers with a York unit"; "Prescott" (a real city) is not an
  unknown customer name (it is on the non-name word list), so "serial on the prescott unit" keeps going to the model.

### R32b loop log (fresh blind set written BEFORE the rules; hold-out = a second set with different phrasings written after the rules were tuned)

| loop | family | rule(s) | blind before -> after (no-model / q) | hold-out |
|---|---|---|---|---|
| A | unextracted unit attributes (SEER / filter size), unknown names, persona / app-settings / announcement declines | `pageAttribute.js`, `unknownName.js`, earlyDecline additions | 33 -> 141 / 144 (needs-model 100 -> 3, wrong 2 -> 0) | decl2: 116 -> 135 / 135 |
| B | per-customer / per-vendor counts, named-pair comparisons (customers, vendors, service types) | `namedCompare.js`, financials subject scoping, contact/slotFill count guards | 36 -> 105 / 106 (needs-model 38 -> 1, clarified 32 -> 0, wrong 4 -> 0) | (compare variants inside the set) |
| C | shop-wide aggregates (warranty extremes / out-of-warranty counts / tech-never sets / date extremes / history skew / open-in-period / no-text docs) | `aggregates.js` (closed vocabularies) | 55 -> 106 / 106 (needs-model 51 -> 0, wrong 13 -> 0) | agg2: 75 -> 81 / 81 |
| D | technician pair comparisons, "who has the most/fewest jobs", typed per-technician counts | `namedCompare.js` tech shapes, `aggregates.js` tech-extreme / tech-typed-count | 70 -> 115 / 115 (needs-model 45 -> 0) | (pair orders and phrasings split inside the set) |
| E | off-domain trivia / shopping / device / health / weather, dangling follow-ups with no conversation | earlyDecline lexicon + dangling shapes | 74 -> 103 / 103 (needs-model 21 -> 0, wrong 1 -> 0) | off2: 66 -> 68 / 68 |

Every loop kept: exam wrong 0, no new wrong id vs the baseline run, `verify:golden` floors raised (correct >= 1570, answered >= 1590, needs-model <= 16), p95 unchanged (~55 ms).


## R35 (Donovan) — owner decisions decided 2026-10-01, learning loops, blue-collar brevity

### Owner decisions (decided by the owner on 2026-10-01; implemented deterministic, $0)

- **"Still under warranty" means coverage is still active: warranty end date ON OR AFTER today** (shop-wide, per brand, per customer, per
  unit; also "in warranty", "covered", "warrantied", "active / current / valid warranty", "haven't expired"). This SUPERSEDES the R32 / R32b notes
  above (strict >365-day "active" bucket, 33). The answer gives the active count AND, in the same short line, how many of those run out within
  12 months, so both readings are covered: `37 units are still under warranty — 4 of them run out in the next 12 months.` (followed by the
  number with no end date on file when there are any). Explicit phrasings keep their own buckets: "more than a year left" = end date more than
  365 days out (33); "expiring soon / about to expire / run out in the next 12 months" = within 12 months (4); "expired / out of warranty /
  not warrantied / no longer covered" = end date passed (79); "no warranty on file / unknown / no end date" = no end date on file (16).
  Oracle: `counts-warranty-0004` counts status IN ('active','expiring') (37); the brand-scoped ids (h050, g135, h091-h098) already counted
  end date after today. The `number` comparator reads the first number, so the two-number answer form passes; no grader change was needed.
  Per-unit / per-customer answers say `active, under warranty until May 9, 2027 (expiring within 12 months)` (the grader's 'expiring' token).
  "Covered by a maintenance agreement / plan / contract" is a different coverage and is never answered as a warranty count.
- **Nicknames resolve without asking when they name exactly ONE person** (`api/_lib/vocab/nicknames.js`, several hundred formal <-> nickname
  pairs both directions incl. common Hispanic diminutives; same surname; customers and technicians counted together; a technician only in a
  work question; word-like nicknames — will, bill, pat, rob ... — only where a name can stand; quoted = exactly as typed). Visible note
  `Showing results for Thomas Mercer (you typed "Tom Mercer").` (same note + "Not who you meant?" chip as typo auto-resolve); two candidates ->
  the one-tap "Did you mean" choices. Kill switch `DONOVAN_NICKNAMES=0`.
- **Serial lookups are deterministic** (`api/_lib/lookups/serialLookup.js`): every phrasing (unit / model / brand / install / warranty /
  location / customer / last service for serial X), case / space / dash-insensitive, O->0 and I->1 on both sides (a collision lists every unit,
  never picks one), a serial printed only on a document is reported from it, near misses name the closest serial, a model number typed as a
  serial is called out. **Partial serials** (>= 5 characters, at least one digit): answered when exactly ONE serial contains it, with the
  visible note `Showing results for serial 2C100091 (you typed "100091").`; several -> listed, none picked; typed in quotes -> exactly as typed.
- **A mistyped city / zip never blocks** the answer; the note is now short: `(Note: on file in Phoenix, not Mesa.)`, `(Note: on file under zip
  85001, not 85201.)`, both -> `(Note: on file in Phoenix 85001, not Mesa 85201.)`. It now also fires when the typed city is followed by more
  words ("... Ave, Mesa still under warranty") and on single-unit address answers that echo the typed address.
- **Blue-collar brevity:** declines are one short line (off-domain, untracked field, no earlier question, unknown person, judgment); a list
  sentence that repeats every fact row keeps its first 5 names + "and N more" (`api/_lib/router/brevity.js`; every name stays a fact row and a
  cited record; kill switch `DONOVAN_BREVITY=0`); the maintenance-due rule sentence moved to the citation basis; open-invoice and document-number
  answers lead with the figure. Measured on every deterministic exam answer (n ≈ 1685): average 95.4 -> 87.6 characters, answers over 300
  characters 32 -> 13, average first sentence 77.7 -> 73.6.

### R35 learning loops (fresh blind set per family written and frozen BEFORE the rule; `scripts/gen-blind-r35b.mjs`)

| loop | family | rule(s) | blind before -> after (correct / q) |
|---|---|---|---|
| 1 | warranty wording ("covered", "warrantied", "expiring soon", "no warranty on file") | `aggregates.js` buckets + unknown state; detPlan never reads "covered by an agreement" as a warranty; a rewrite claimed only by analytics no longer overrides a deterministic claim (`classifyAll.js`) | 24 / 43, **11 wrong** -> 42 / 43, 0 wrong (1 needs-model: "covered by a maintenance agreement") |
| 2 | document numbers (INV / WO / PO / permit; on file and not) — r34 G5 | `lookups/docNumberLookup.js` | 0 / 96 (96 needs-model) -> 96 / 96 |
| 3 | judgment / advice / prediction / false premise / unknown person — r34 G3, G4, G5 | `safetyGate.js` judgment decline, `lookups/falsePremise.js`, unknown-name "who is X" shapes, address-miss work-history cues | 7 / 52 (29 needs-model, 1 wrong) -> 44 / 52 + 8 clarify chips, 0 needs-model, 0 wrong |
| 4 | partial serials (unique / ambiguous) | `serialLookup.js` partial match | 6 / 38, **23 wrong** -> 38 / 38 |
| 5 | texting shorthand ("4" = for, "@" = at, ph#, addy, wrnty, s/n 4 ...) | `router/rewrite.js` rewriteShorthand (+ invoice typos) | 12 / 47 (3 wrong) -> 47 / 47 |

r34 battery would-be model calls 15 -> 0 (deferred 13 -> 0: G3 advice, G4 false premise, G5 not on file). Exam: 1594 answered / 1574 correct /
0 wrong / 14 needs-model -> 1596 / 1576 / 0 / 12 (g091 shorthand, hvac-bookkeeper-0011-typo "invices"); no status changed for any other id.

### Blind-oracle notes

- `r35-warr2` "no warranty on file" oracle: the first generated SQL had an unused `$1` parameter (oracle-error, not a meaning change); fixed in
  the generator and regenerated with the same seed (same questions).
- `r35-advice`: a clarify reply ("Here is what I can look up for X: tap one") is $0 and honest but is counted as clarified, not correct.
- Adversarial pass (self, no reviewer agent available): fixed "invoice 100 E Main St" read as invoice #100, "est 2026" read as an estimate
  number, "not warrantied" read as under warranty, "covered by warranty but not registered" answered as the bare warranty count (analytics now
  bails), "the 2026 revenue" / "2025 invoices total" answered with the all-time total (financials now reads a year next to a money noun),
  "which brand has the most repairs" answered "120 customers." (an unfiltered customer list is never a superlative answer: detPlan bails),
  "which brand fails the most" (reliability = opinion, judgment decline), "is invoice X paid" with no status printed (honest no-answer).
- Nickname blind set (`r35-nick`): the 4 technician contact rows ("phone for Dan Ochoa", "address for Raymond Sutton") now get an honest
  `Danny Ochoa is one of your technicians — no technician contact details are on file.` at $0 (161 -> 165 / 166; never fires when a customer
  can be meant by the same name).
