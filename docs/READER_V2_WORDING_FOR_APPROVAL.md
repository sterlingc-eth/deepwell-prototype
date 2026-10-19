# Wording for approval: Donovan answers from your documents (Donovan 1.4.0, UNRELEASED)

Every piece of text a customer can see because of this change is on this page. Nothing else is customer-visible.
Approve, edit or strike each line before the switch is turned on for customers. The switch is off today.

## 1. Patch Notes entry (Donovan 1.4.0, marked UNRELEASED in src/data/releases.json)

> Smarter answers from your documents. Donovan now finds and reads the exact answer in your files more often — including totals and counts across many documents, dates and amounts written different ways, and clauses inside long agreements. Every answer still shows the document it came from, and when Donovan isn't sure, he says so instead of guessing.

(Stored as three notes, one per sentence, because the Patch Notes file takes two or three notes per release; the words are exactly the text above.)

## 2. The one-sentence "how this was worked out" line under an answer

| When | Text |
|---|---|
| the answer comes from one document | Read from the cited document in your files. |
| the answer is worked out from several documents | Worked out from the N matching documents in your files; each is listed. (one document: "1 matching document") |
| the answer is a contact detail or a count of zero (no document behind it) | Read from the records stored in your files. |

## 3. The answer sentence (the words come from the company's own paper types, names and dates)

The sentence shapes below are the only ones the reader can produce. Examples are from made-up test companies.

| Kind of question | Shape of the answer | Example |
|---|---|---|
| a total on one document | Total: $X (document) | Total: $768,675.00 (Lease summary sheet LB-2090 (Cobalt Holdings LLC, 2026-09-02)) |
| a date on one document | Date: YYYY-MM-DD (document) | Date: 2019-03-17 (Due diligence checklist (Cobalt Ventures Metro, 2019-03-17)) |
| who a document belongs to | Name (document) | Blue Ridge Investments Prime (Property appraisal AP-2032 (…)) |
| find a document | Document | Rent roll RL-1983 (2024-12-21) |
| a stored field | Field name: value (document) | Units occupied: 47 (Rent roll RL-1981 (2024-12-14)) |
| a sentence inside a document | The sentence as written (page N, document); a yes/no question starts with "Yes. " | Subject property: … (Property appraisal AP-1982 (…)) |
| a count | Name has N <paper type>s on file (filters). / N <paper type>s on file (filters). | Northgate Investments East has 1 annual common area bill on file. |
| a sum | Total of N <paper type>s for Name (filters): $X | Total of 2 lease summary sheets for Blue Ridge Holdings LLC Metro: $926,529.57 |
| latest / earliest | Latest or Earliest <paper type> for Name (filters): date (document) | Latest due diligence checklist for Steven Douglas: 2022-01-23 (…) |
| a list | Name's <paper type>s (filters): document; document; … | Harbor Ventures West's lease summary sheets: … |
| highest / lowest total | Highest or Lowest <paper type> (filters): $X (document) | Lowest rent roll: $29,908.00 (Rent roll RL-1915 (2021-02-06)) |
| highest / lowest of a stored field | Field highest or lowest among <paper type>s (filters): value. Who and what identifies it (document) | |
| a count for a year | N <paper type>s dated YYYY. / N <paper type>s on file (YYYY). | 6 comparative market analyses on file (2026). |
| where a name or number is mentioned | Mentioned in: document; document | Mentioned in: Lease summary sheet LB-2090 (…) |
| a customer's address | Name is at address. | Cobalt Group North is at 1063 W Spring St, Hillsboro, OR 97124. |
| a customer's phone, email or address | Name: value | Patrick Smith: (602) 555-6576 |

"(filters)" is the company's own words for what was asked, in plain form, for example: (2022), (this year), (Q3 2026), (before 2021-08-20), (after 2019-01-07), (between 2020-01-01 and 2020-06-30), (paid), (over $5,000.00).

Plurals are corrected before the customer sees them (for example "analyses", "summaries", "accesses"); the reference pipeline simply adds an "s".

## 4. What is NOT shown

* A question the reader is not sure about gets no new text at all: the app's existing "not on file" wording is sent unchanged. The reader's own release reasons (for example "number not found") are for the logs only and never reach a customer.
* The words "Reader", "V2", "shadow", "verifier", "parity" appear only in logs and in the owner report, never in anything a customer sees.
* Logs hold ids, a short fingerprint of each answer, the scores and the release reason. They hold no document text (an optional switch DONOVAN_READER_V2_LOG_TEXT=1, off by default, adds the first 300 characters of the answer for a test session only).
