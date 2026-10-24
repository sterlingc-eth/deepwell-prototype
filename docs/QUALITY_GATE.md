# Quality gate: document reading

**Rule.** You may not call a change to document reading, the Inbox, required fields, document types, Re-check or extraction
"fixed" unless `npm run verify:real-docs` passes. Put its output, before and after your change, in the report.

The gate exists because earlier fixes were tested only on small fixtures written for the test. They passed, and then
failed on the real documents in the Sonoran Comfort Air account.

## What it runs
`npm run verify:real-docs` (`scripts/verify-real-docs.mjs`) runs the reading pipeline over the original Sonoran test
documents. It uses the same functions that upload and Re-check call (`scripts/real-docs/pipeline.mjs`): the text reader, the
labelled scan, the sentence and column reader (`api/_lib/modelAvoidance/proseFacts.js`), grounding
(`groundedFacts.js`), page-anchor typing (`retype.js`), required fields and the automatic check. It then compares the
result with `test-docs/real-docs/GOLD.json`.

- **Inputs.** There are 1,000 documents: the shared-drive set `UPLOAD_THIS_FIRST_all_industries_100_each_1000_documents.zip`.
  - Their page text is stored in `test-docs/real-docs/pages.json`, built from the originals by the app's own readers.
  - Photos, and PDFs the text-layer reader refuses, go to the paid vision model in production. For those, the stored text
    is a stand-in: pdftotext for PDFs and tesseract for photos.
- **Degraded copies.** `test-docs/real-docs/pages-degraded.json` holds 43 extra documents with known answers: 13 source
  documents, each as a phone photo, a low-resolution scan and a skewed scan, plus 4 handwriting-style notes.
- **Stubs.** The extraction model is stubbed, so it returns no fields. Its type guess is replaced by the page's own title
  line. Every fact the gate counts is therefore read by the deterministic reader alone.

## When it fails
1. **Oracle self-test (runs first).** Three planted failures must be rejected: a date moved by one day, a party swapped for
   the next line's text, and a fact cited on the wrong page. If any of them gets through, the gate itself is broken.
2. **Grounding and cross-check cases.**
   - "a term of 60 months beginning 02/10/2023 and ending 02/09/2028" must give the term, start and end, with the
     arithmetic check passed.
   - The gate must refuse an end date that does not match start + term, a quote found on a different page, and a digit flip.
3. **Wrong fact.** Any gold fact read with a different value or page.
4. **Forbidden value back.** Any of 216 known-wrong values the old reader produced. Examples: "SERVICE LOCATION" as a
   customer, a signer's name as the vendor, a bid's validity date read as a warranty expiry.
5. **Regression.** Any of these:
   - a gold fact that is no longer captured;
   - a document that now needs a person but is not on the gold list (each listed document has its reason);
   - fewer facts captured in total.
6. **Ungrounded fact.** Any fact the readers wrote whose quote is not on its page, or whose value does not come from the quote.
7. **Live screenshot regressions, as Re-check sees stored documents.**
   - The warehouse lease must get its term.
   - COIs and plumbing licenses stored as "Warranty registration" must be re-typed, with nothing left missing.
8. **Signer taken as a party (docread2).** A name printed only in a signature block ("By:", "Signature", "Authorized
   representative", "Name / Title", a line under a signature rule, "Client: X Date: ____") is a signer, not the customer or
   vendor, unless the party clause or a party block names the same person as the party. Spec cases P8 (signer refused, the
   party clause's name read instead), P9 (named in the party clause: kept) and P10 (By / Name-Title lines refused) run in the
   gate, and the 5 Ridgeline / Redwood / Westfield event contracts are gold facts with "Colin Dunn" forbidden.
9. **Stored-value audit (docread2).** `api/_lib/modelAvoidance/storedAudit.js` re-runs the cross-checks over values ALREADY
   STORED (period vs the page, start + term = end, subtotal + tax = total, a label as a name, a signer as a party). Over this
   tree's own values it must flag nothing (no false alarms on the 1,000 documents); 11 planted cases (7 wrong stored values, 4
   correct controls including a person-corrected value) must each be flagged or left alone as expected. With `--tree <older
   checkout>` it reports what it finds in the values that older reader stored. `npm run verify:stored-audit` covers the database
   half on PGlite: dry run by default, nothing is ever overwritten, flags only with the owner switch.
10. **Degraded copies.** Any wrong fact other than the 4 known tesseract misreads, or fewer correct facts than the gold count.
11. **Line-item tables (tables lane, 2026-10-24).** `api/_lib/modelAvoidance/tableRows.js` reads the printed rows of invoice /
   receipt / work-order / rent-roll / pay-application tables. A row is a fact only if the page's own arithmetic proves it
   (qty x unit = amount, rows = subtotal, rows + tax = total, per-column sums for rent rolls and pay applications); anything
   else is quarantined. Gate section 6 (`test-docs/real-docs/tables/`, ratchets in `GOLD_TABLES.json`):
   - **Oracle plants (must be rejected):** a swapped column (unit price and amount), an off-by-one row (the next row's label),
     a total taken from another page. The same three are then fed to the reader as damaged page text.
   - **Clean synthetic suite (14 "Sample" documents, 119 gold rows, enforced):** any wrong row or total, or fewer rows
     captured than the ratchet, fails. Run twice: x-anchored (PDF word positions) and text-only (what the app stores).
   - **Original 1,000 documents (no gold rows exist):** a verified table whose total contradicts the document's own cost
     fact fails; the verified-row count is a ratchet.
   - **Degraded copies of the 14 documents (phone photo, low-res scan, rotated scan, coffee stain + stamp, handwriting-style
     fields; tesseract stand-in text): MEASURED, NOT ENFORCED yet.** The printed line shows rows captured, wrong rows (target 0)
     and documents needing a person.
   - `node scripts/real-docs/tables-fuzz.mjs [N]` corrupts the clean documents (digit, swapped cells, dropped / duplicated row,
     changed total, letter for a digit ...) and counts verified rows that are not in the gold (target 0).
   - `python3 scripts/real-docs/make-degraded-tables.py <work dir>` then `node scripts/real-docs/build-tables-pages.mjs <work dir>`
     rebuild the suite (needs reportlab, Pillow, numpy, OpenCV, pdftoppm, tesseract; own script, no Augraphy).
   - The reader is behind `TABLE_ROWS_READER=1` (default OFF) in the app (`financialsHook.js`, `financials/extract.js`).

## Updating the gold
- When a change makes documents complete that the gold lists as needing a person, the gate prints a note.
  - Check those documents by hand.
  - Then run `node scripts/verify-real-docs.mjs --update-needs` and review the `GOLD.json` diff.
- Never add a value to `facts` without reading it on the page.
- Never remove a `forbidden` entry to make the gate pass.

## Other commands
- `npm run verify:real-docs-independent`: 30 random documents whose answers were written by hand from the page
  (`INDEPENDENT_GOLD_30.json`). This file is self-checked: the same agent wrote the reader. A second reviewer is still worth it.
- `node scripts/real-docs/build-page-cache.mjs <dir of originals> --standin`: rebuilds `pages.json`. Needs poppler and
  tesseract for the stand-ins.
- `python3 scripts/real-docs/make-degraded.py <dir of originals> <work dir>`: rebuilds the degraded copies. Needs pdftoppm,
  tesseract and Pillow.
- `node scripts/verify-real-docs.mjs --tree <other checkout>`: runs another tree's reader against the same gold. Use this
  for the "before" numbers.

The test documents are synthetic test data (the table suite is marked "Sample" on every page). Never use them for Donovan training.
