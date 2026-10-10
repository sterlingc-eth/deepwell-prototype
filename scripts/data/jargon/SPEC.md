# Jargon research spec (every research agent follows this)

## Goal
Donovan (DeepWell's assistant) and the document reader fail when people or paperwork use different words for the same thing. Build a large, sourced dictionary of real-world small-business jargon. Each entry maps a term to a canonical concept the app already understands.

## Rules
- Read DeepWell's concepts first. They are in /home/claude/int2 (read-only):
  - api/_lib/documentTypes.js: DOCUMENT_TYPES, REQUIRED_FIELDS and DOCUMENT_TYPE_SYNONYMS
  - api/_lib/industry/packs/*.js: field keys per industry
  - api/_lib/modelAvoidance/fieldSynonyms.js: the field label synonyms already in place
  - api/_lib/lookups/lexicon.js: word classes already in place

  Do not repeat what already exists. Add what is missing.
- Use WebSearch and WebFetch for real usage: trade glossaries, industry association glossaries, software help centers (QuickBooks, ServiceTitan, Housecall Pro, Jobber, AppFolio, Buildium, Procore, Fleetio, Bloomerang and similar), forums (Reddit trade subs), and government and IRS glossaries. Record a source URL for each entry, or for each group of entries from one source.
- Never read .env or secrets. No database access. Don't edit the repo.
- Write ONLY to your output file. Map only terms that clearly mean the concept. When a term is ambiguous, list it under "ambiguous" with its possible meanings, so the code never maps it silently.

## Output
Write one JSON file at /home/claude/work/jargon/<your-group>.json:
```
{ "group": "...",
  "entries": [
    { "term": "tune-up", "variants": ["tuneup","tune up","precision tune-up"],
      "class": "doc_type|field|role|money|status|date_phrase|equipment|part|action|document_label",
      "means": "<canonical id: a DeepWell doc type id, field key, or one of: technician, customer, vendor, unpaid, paid, overdue, replaced, installed, expired, renewed, quote, ...>",
      "industries": ["hvac"], "note": "short", "source": "https://..." } ],
  "ambiguous": [ { "term": "...", "could_mean": ["...","..."], "industries": [...] } ],
  "new_concepts": [ { "id": "...", "why": "concept people ask about that DeepWell has no id for" } ] }
```

## Target size and coverage
- Aim for 250–500 solid entries per group.
- Cover what people TYPE when they ask questions: casual words, abbreviations, misspellings people commonly use, and plural forms.
- Also cover the LABELS printed on paperwork: field labels on invoices, receipts, work orders, leases, agreements, policies, statements and POs.
- Include roles (who did the work, who pays), statuses (open, closed, paid, past due, voided), money words, time words specific to the industry ("billing cycle", "lease term", "net 30"), equipment, parts, and actions.

## Final reply
Under 200 words: entry count, ambiguous count, new concepts, and the top 10 most important additions.
