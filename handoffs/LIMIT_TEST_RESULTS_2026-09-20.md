# Limit test results — synthetic corpus round 1 (2026-09-20)

Ran `handoffs/LIMIT_TEST_PLAN_2026-09-20.md` against production
(tenant org_3JZNNONccxbYbVGY5wTekSRN6YZ, Haiku only). 61 documents uploaded
through the real presign → R2 PUT → /api/read-document path, all 61 extracted
with 0 extract errors; the two shop-only documents correctly stopped at
`mapped` and created no customer. 30 /api/ask questions asked once each.

## Scorecard (before fixes)

```
Customers: 12/12 matched, 3 extra   (extras: "Paterson" dup, plus 2 pre-existing customers)
Merge traps: 3/3 held               (reyes/kimball, castro/castillo, carlos/elena ramirez)
Documents linked: 92.6%             (the 5 unlinked were the OLD desert-peak docs; "Fix everything"
                                     dry-run proposed the right customer for all 5; applied — now 100%)
Units linked: 100% (15/15)
Warranty alerts: 2/2                (Whitmore expiring, Bell expired — computed from install date + brand)
Ask accuracy: 27/30 (90%)           fast-path hit rate 53%
```

## Defects found (all reproduced on live data)

A. **Shop letterhead PHONE leaks into every customer.** All 15 customers now
   carry `phone = (480) 555-0199` (the contractor's own number), including
   Ortiz whose invoice prints a real customer phone (480) 555-0176, and the
   two pre-existing customers whose documents never printed that number
   (fill-only merge copied it from whichever doc came first). Ask then
   answers "Patterson's phone number is (480) 555-0199" — wrong, and outreach
   would text/call the shop. Same defect class as the shop_address leak fixed
   on 2026-09-20, but for `customer_phone` (and `customer_email`).

B. **Misspelled surname at the same address becomes a second customer with
   no duplicate suggestion.** "Paterson" (36-service-ticket-paterson,
   38-correspondence-paterson) vs "Patterson" — same street address, same
   phone. `findOrCreateCustomer`'s candidate query is surname-`LIKE` only, so
   Patterson was never a candidate; `compareNamesStrict` says `no-match`, so
   score 0.3 < CUSTOMER_SUGGEST_THRESHOLD and the banner shows nothing.
   36-service-ticket-paterson.pdf is now attached to BOTH customers (direct
   link → Paterson, unit link → Patterson).

C. **A different business at the same address is silently absorbed.**
   "Desert Ridge Dental" (7 docs, 3 RTUs) at 880 S Dobson Rd Suite 110 was
   linked into the pre-existing "Plaza Dental Group" at the same address.
   Cause: `selectCustomerMatch` line ~203 — an exact normalized-address match
   returns eligible **regardless of the name** (the candidate got in via
   `LIKE '%dental%'`). Violates the owner's strict rule (name+address+phone+
   email must agree before combining). Ask consequences: "term on the Desert
   Ridge Dental maintenance agreement" and "serial of RTU-3 at Desert Ridge
   Dental" → no-answer.

D. **Name-only document linked to the wrong same-surname customer.**
   25-correspondence-castillo.pdf ("Dear Castillo," no service address) was
   linked to the OLD Castillo at 1519 W Juniper because it was the single
   same-name candidate at that moment; the synthetic Castillo at 640 W
   Guadalupe was created seconds later. Order-dependent and invisible
   afterwards.

E. **Bulk upload via "Add files" hits the 60-units/minute ingest limit with
   no retry.** 61 files at concurrency 2 → 31 presign 429s ("More than 60
   ingest units in the last minute"). `IntakeScreen.uploadFiles` →
   `ingestFiles(files, …, 3)` has no backoff; only `bulkImport.ts` (the bulk
   drop zone / zip path) retries 429s. A customer who selects a 40-file box
   through the file picker sees ~10 "Too many requests" failures.

F. Old documents that pre-date the 2026-09-20 linking fix stay unlinked until
   someone presses "Fix everything" or the nightly cron runs — dry-run showed
   the fix proposes the right customer for all 5, applied it live, 5/5 linked.

## Fix brief (engineer)

See `handoffs/REQUESTS_limit-test-fixes.md` — same items A–E with the exact
code locations and acceptance tests.
