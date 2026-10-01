# MODEL CALLS R32 (Team M, model avoidance)

Goal: rely on Claude as little as possible without losing accuracy. Every model call site, what it costs a Shop-plan tenant,
what was replaced by a deterministic path in R32, and how to turn each change off.

Assumptions (Shop plan): 2,000 pages/mo (about 800 documents at 2.5 pages), 1,500 Donovan questions/mo, 5 users. Prices: Haiku $1/$5 per Mtok,
Sonnet $3/$15 (`usage.js`). Per-call figures are estimates from prompt sizes and the repo's own cost comments, not billing data.

## 1. Call-site inventory

| # | Site (file) | Fires when | Inputs | Model | Typical tokens (in/out) | $/call | Calls per tenant per month | Deterministic path? | R32 status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Page read: `readDocument.js` `extractWithClaude` (fast pass, optional escalation, both default Haiku) | Every uploaded PDF/photo, once per document | The file itself as PDF/image | Haiku 4.5 vision | ~2.7k / 0.9k per page | 0.0042/page | 2,000 pages | PDF text layer (digital PDFs only). Scans/photos: none (no OCR available on Vercel) | **Text layer first** (`PDF_TEXT_LAYER`) |
| 2 | Field extraction: `extractDocument.js` | Every document after read | Stored page text | Haiku | ~1.8k / 0.4k | 0.0039 | 800 | Title + labelled-field extractor (`textExtract.js`) | **Deterministic first** (`EXTRACT_DETERMINISTIC`) |
| 3 | Financials: `financials/extract.js` via queue/`api/extract.js` | Money documents (invoice, quote, agreement) | Page text | Haiku | ~1.5k / 0.3k | 0.003 | ~400 | Printed total/number/date/customer/address from labelled lines | **Deterministic first** (`FINANCIALS_DETERMINISTIC`) |
| 4 | Dossiers: `search/dossier.js` (ingest hook + nightly catch-up) | New document linked to a customer and/or unit | Page text, 3.5k chars per document | Haiku | ~1k / 0.2k | 0.0018 x ~2 entities | ~800 docs x 2 | Field-derived cited sentences (`dossierText.js`) | **Model now opt-in** (`DOSSIER_MODEL=1`); default is deterministic |
| 5 | Autopilot nightly: `learning/autopilot.js` (replay, 12-question exam through ask, vocab labelling <=5 calls) | Cron 09:17 UTC, per eligible tenant | Misses, exam questions, vocab | Haiku, plus the ask path | up to the cap | up to $0.25/night | 30 nights = up to $7.50 cap | Partly (exam answers are mostly deterministic) | **Model now opt-in** (`DONOVAN_AUTOPILOT_MODEL=1`), whole step skipped by default |
| 6 | Ask, retrieval + answer: `ask.js` (~line 1974) | Question not answered by help/meta/router/cache | Question + top passages | Haiku 4.5 (`ASK_MODEL`) | ~3k / 0.3k | ~0.0075 | ~135 (60% of the ~15% that reach a model) | Router, fast path, analytics, contact/doc/money lookups, relations, answer cache answer 85%+ ($0) | Unchanged; cache probed first |
| 7 | Ask, research agent: `agent/loopV2.js` (v1 `loop.js` when `DONOVAN_RESEARCH_AGENT=0`) | Enumerations, honest no-answers, hard questions | Question + tool results, max 6 turns / 12 tool calls | Sonnet via `escalationModel()` | ~12k / 1.5k | ~0.05 | ~90 | Recipe/answer cache probed first; `DONOVAN_CHEAP_TIER` (R31) left OFF | **Non-question gate before it** (`ASK_NONQUESTION_GATE`) |
| 8 | Analytics planner: `routes/analytics.js` | Analytics question the deterministic planner cannot map, not cached | Question + schema hints | Haiku | ~2k / 0.3k | 0.0035 | included in #6 share | Deterministic planner first (most questions) | Unchanged |
| 9 | Help chat: `support/client.js` | Question the FAQ, smalltalk, off-topic, competitor, account and did-you-mean steps all failed to settle | Question + KB excerpt | Haiku | ~1.5k / 0.2k | 0.002 | under 10 | FAQ ($0) first, verified in `support/engine.js` order | Verified, left alone |
| 10 | Reclassify: `reviewStore.js` `classifyByModel` | Admin "reclassify" only, <=20 calls/request | First 1,500 chars of text | Haiku | ~0.5k / 0.05 | 0.001 | admin only, ~0-50 | Facts/filename heuristic, then **title-line classifier (new)** | **Title classifier before the model** (`CLASSIFY_DETERMINISTIC`) |
| 11 | Reminder backfill: `reviewStore.js` `extractReminderByModel` | Admin backfill action | Page text | Haiku | ~1k / 0.2k | 0.002 | admin only | No | Unchanged (operator-initiated) |
| 12 | Nameplate camera: `api/extract.js` imageData path | User taps the camera on an equipment record | One image | Haiku vision | ~1.5k / 0.3k | 0.003 | ~30 | No | Unchanged (user-initiated, no text layer exists) |
| 13 | Receipt read: `routes/expenses.js` | User uploads a receipt | Image/PDF | Haiku vision | ~1.5k / 0.2k | 0.002 | ~20 | PDF text layer could apply; low volume | Unchanged |
| 14 | Knowledge reports: `search/mapReduce.js` | User asks for a full report (queued) | Many documents | Haiku (map) + reduce | large | up to $3 cap | rare | No | Unchanged (explicit user demand) |
| 15 | Learning proposer / vocab mining / gap promoter: `learning/*` | Nightly (inside #5) or "learning now" | Misses, vocab | Haiku | small | <0.002 | inside #5 | n/a | Off with #5 |
| 16 | Embeddings: `search/embed.js` (Voyage) | Every stored page | Page text | voyage | tiny | ~0.00002/page | 2,000 pages = about $0.03 | n/a | Unchanged, negligible |
| 17 | Scorecard grader/baseline: `scorecard/*` | Dev only | | | | | 0 in production | | n/a |

Every call goes through `withBackoff` (`claude.js`): retries only on 429/529 (rate-limit/overload errors that are not billed), 3 attempts
maximum, bounded by the request deadline; the queue passes `modelAttempts: 1`. No path retries a billed, successful response.
The agent is capped at 6 turns / 12 tool calls. Answer cache and recipe probes happen before any Ask model call (`ask.js` ~652 and ~1069).

## 2. Monthly model dollars per tenant (Shop plan)

| Line | Before R32 | After: mostly-digital shop (matches the synthetic corpus) | After: realistic mixed shop (30% digital pages, rest scans/photos) |
|---|---|---|---|
| Page read (#1) | 8.40 | 0.00 | 6.00 |
| Field extraction (#2) | 3.10 | 1.10 | 2.70 |
| Financials (#3) | 1.20 | 0.06 | 1.00 |
| Dossiers (#4) | 2.90 | 0.00 | 0.00 |
| Autopilot (#5, at cap) | 7.50 | 0.00 | 0.00 |
| Ask retrieval + agent + planner (#6-8) | 5.50 | 5.30 | 5.30 |
| Everything else (#9-16, Voyage, nameplate, receipts) | 0.30 | 0.30 | 0.30 |
| **Total** | **28.90** | **6.76** | **15.30** |
| Change | | -77% | -47% |

How the "after" columns are built (measured where marked): mostly-digital column uses the measured 560/560 corpus PDFs read from the text layer, 390 of 604
documents accepted by the deterministic extractor (64.6%), and about 95% of money documents accepted by the financials hook. The realistic column assumes
30% of pages are digital PDFs (the text layer reads about 95% of those), 40% of those digital documents pass the extractor, and 15% of money documents pass the
financials hook. The 30%/40%/15% figures are ASSUMPTIONS: a real shop's mix is not measured yet. The Ask line drops only 4% because the non-question gate
removes greetings/off-topic input, which is a small share of real traffic. Ask is otherwise already about 85% model-free (the offline exam needs a model for 7.6% of questions).

Where the money is: the two opt-in switches (autopilot 7.50 and dossiers 2.90) are about $10.40 of the $28.90 and are unconditional. The deterministic read/extract/financials
savings depend on what customers upload. Scans and phone photos, the largest share in practice, have no deterministic path and still use vision.

## 3. What changed (all on by default except where noted; every change has an env kill switch)

| Change | Switch | Restores the old behaviour |
|---|---|---|
| PDF text-layer read before the vision model (`modelAvoidance/pdfText.js`, `readDocument.js`); provenance in `method`/`source` (`pdf-text-layer`, or `model:<reason>` when refused) | `PDF_TEXT_LAYER=0` | Always vision |
| Deterministic extractor before the extraction model (`textExtract.js`, `extractDocument.js`); `method: text|model`, `model: deterministic-text` in the audit log and result | `EXTRACT_DETERMINISTIC=0` | Always model |
| Title-line classifier before the reclassify model (`reviewStore.js`) | `CLASSIFY_DETERMINISTIC=0` | Model only |
| Deterministic financials (`modelAvoidance/financialsHook.js`; the unchanged normalize/upsert path runs on the precomputed input, row marked `model='deterministic-text'`; anything not accepted falls back to the model) | `FINANCIALS_DETERMINISTIC=0` | Model only |
| Ask non-question gate (`modelAvoidance/nonQuestion.js`, `ask.js`): greetings, thanks, keyboard mash/symbols, and a closed list of clearly off-topic requests get a canned honest no-answer, never retrieval or the agent | `ASK_NONQUESTION_GATE=0` | Old flow |
| Dossier summaries are deterministic, cited, field-derived sentences (`dossierText.js`); model summaries opt-in | `DOSSIER_MODEL=1` | Model summaries |
| Autopilot nightly step skipped unless opted in | `DONOVAN_AUTOPILOT_MODEL=1` | Nightly loop runs (capped at `DONOVAN_LEARNING_DAILY_USD`) |
| Master | `MODEL_AVOIDANCE=0` | Every path above returns to its pre-R32 behaviour (opt-ins return to ON) |

Acceptance rule of the extractor (`textExtract.js`): a document is accepted only if its title names a template type, every line is explained
(header, validated "Label: value", block list, unit line, or whitelisted boilerplate), the type's required fields are present, and nothing conflicts
(one technician, one total, one value per label, no unexplained prose). Anything else, including install invoices, goes to the model unchanged.
The PDF reader refuses (and the model reads) encrypted files, image-only scans, OCR overlays with invisible text, rotated pages/text, unreadable fonts,
unmapped characters, and pages where an image covers more than 12% of the page.

## 4. Measured accuracy

`node scripts/verify-r32-model-avoidance.mjs` (no network/db/model). Labelled set: 81 documents = 49 corpus PDFs (truth from `ANSWER_KEY.json` plus the independent golden template parser),
7 real-tool PDFs (LibreOffice, wkhtmltopdf, reportlab, qpdf object streams, qpdf QDF, an image-only scan, an OCR-overlay scan; hand labelled), and 25 generated PDFs
(plain and Flate; 16 accepted-style plus 9 adversarial traps: two technicians, unexplained prose, reminder language, conflicting phones, missing required address,
install invoice, two different totals, no title, non-form text).

- Overall field precision 100.00% (382/382); every field 100%; no trap accepted; both scans refused by the reader.
- Documents skipping the model: 55/81 (67.9%), pages the same. This set is stratified and contains traps, so it is not a mix estimate.
- Whole synthetic corpus (604 documents): 560/560 PDFs read from the text layer; 390 accepted (service-ticket 120, proposal 60, warranty 52, work-order 31, startup 27, permit 27, maintenance 27, inspection 19, equipment 19, invoice 8 with the install guard); rejections are 112 install invoices (judgement needed), 25 dispatch, 20 internal, 19 no-title correspondence, 19 purchase orders, 19 nameplates. Identity fields on accepted documents match `ANSWER_KEY` 100% (customer_name 363, service_address 390, serial/model/manufacturer 221, installation_date 90). With the install guard skipped for financials, the deterministic total equals the golden total on every accepted money document.
- Recall on the labelled set: 100% on every field except customer_name (94.5%: three documents print a variant the labelled canonical name does not equal).
- Known limits: two-column layouts (wkhtmltopdf invoice with a table "Bill To" block) are refused and use the model; scans and photos have no deterministic path; financial line items are not emitted (the printed forms carry only a total; the golden export's single "line" is an artifact of its parser).
- Offline exam unchanged: 1524 answered without a model, 1496 correct, 8 wrong, 129 needs-model (baseline 1524/1496/8/129). The non-question gate fires on 4 of the 1,704 exam questions, all `out_of_domain`/honest-zero ones, and matches no real question.

## 5. Batch API (design only)

The installed SDK is `@anthropic-ai/sdk` 0.24.3, which has no `messages.batches`, so nothing is implemented. Design for the first-import / Records Rescue backfill (the only bulk, latency-insensitive model spend):

1. Upgrade the SDK (or call `POST /v1/messages/batches` with `fetch`; the request body is `{requests:[{custom_id, params}]}` where `params` equals today's `messages.create` body).
2. New Inngest function `ingest/backfill.batch` for jobs flagged `bulk: true` (5,000+ pages): after the text layer pass, collect the pages that were refused, build one batch per tenant (up to 10k requests / 256 MB), store `batch_id` + `custom_id -> document_id/page` in a `model_batches` table.
3. A poller step (every few minutes; batches complete within 24 h, usually under 1 h) writes results through the same `extractWithClaude` result handler, so validation and provenance (`source: model-batch`) are shared with the live path.
4. 50% discount applies to input and output tokens: a 5,000-page first import drops from about $21 to about $10.50 of vision reads. Interactive uploads stay on the live API (customers wait on them).
5. Risks: no prompt-cache discount stacking guarantee, results expire after 29 days, partial failures need per-request retries; keep `custom_id` idempotent.
Expected value is one-time (onboarding), not monthly: at most about $10 per large import, so it ranks below the changes above.

## 6. Risks and follow-ups

- The mix is unknown: if most customer uploads are phone photos, the read/extract savings are at the low end; the autopilot and dossier savings are unaffected.
- The deterministic extractor is tuned on a synthetic, single-template corpus plus 7 real-tool PDFs. It is deliberately strict (26 of the 81 labelled documents fall to the model rather than being guessed), but real shop templates need sampling before raising confidence in the acceptance rate. Precision is protected by the acceptance rules, not by the corpus.
- Dossiers are now shorter (up to 4 sentences per accepted document, none for unexplained documents). The agent falls back to `searchKnowledge` for those; watch the knowledge/dossier questions in the next live scorecard. Set `DOSSIER_MODEL=1` to compare.
- Autopilot off means no nightly vocabulary learning or replay of misses. Turn it on for a design-partner tenant only, or trigger "learning now" manually.
- Provenance: `document_pages.model = 'pdf-text-layer'`, extraction audit `method: 'text'|'model'`, `document_financials.model = 'deterministic-text'`. Dashboards that group by model name will show these new labels.
- Not done: `DONOVAN_CHEAP_TIER` still needs a live A/B (unchanged, OFF); no OCR for scans (would need a wasm OCR or a paid OCR API and an accuracy study); vercel `api/` still 12 top-level functions.
