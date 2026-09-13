# `/api/ask` contract (M1)

Both sides of the seam build to this file. Client: `src/services/answerService.claude.ts`. Server: `api/ask.js`.

## Request

`POST /api/ask` · `Content-Type: application/json` · `Accept: text/event-stream`

```jsonc
{
  "question": "Is the furnace at 2847 N 24th St still under warranty?",
  "includeUnverified": false,
  "today": "2026-09-12",              // YYYY-MM-DD, the client's clock (eval pins it)
  "records": [                        // answerable entity records only (isAnswerable rule)
    {
      "entityId": "EQ002",
      "type": "equipment",            // property | equipment | customer | technician | service
      "label": "Lennox Furnace SN-LEN-456789",   // human name for retrieval/display
      "related": ["PROP002", "CUST002"],         // one-hop entity ids (property↔equipment↔service↔technician↔customer)
      "fields": {
        "serial": { "value": "SN-LEN-456789", "sources": [ { "documentId": "DOC004", "location": { "page": 1, "field": "Serial Number" }, "excerpt": "Serial Number: SN-LEN-456789" } ] },
        "warrantyExpiry": { "value": "Nov 22, 2029", "sources": [ /* … */ ] }
      }
    }
  ],
  "heldBack": [                       // docs that are Linked but not Verified and were EXCLUDED because includeUnverified=false
    { "documentId": "DOC019", "entityIds": ["EQ010", "PROP008", "SVC010"] }
  ],
  "docs": [                           // catalog of every answerable doc, for `closest`
    { "documentId": "DOC004", "filename": "warranty-lennox-456789.pdf", "type": "Warranty Card", "entityIds": ["EQ002", "PROP002"] }
  ]
}
```

Size guard: the server rejects bodies over 512 KB with 413. The client sends everything answerable today (prototype scale); the server still retrieves top-K before generation — **never the whole export into the prompt**.

## Response — Server-Sent Events

`Content-Type: text/event-stream`. Events, in order:

```
event: status
data: {"stage":"reading"}      // request accepted, retrieval starting

event: status
data: {"stage":"linking"}      // retrieval done: {"stage":"linking","entities":8,"docs":12}

event: status
data: {"stage":"writing"}      // Claude call started

event: answer
data: {"text":"Yes — …"}       // may be emitted once (full text) or several times (deltas, concatenate)

event: done
data: { …Answer… }             // the full Answer object, camelCase, same shape as src/core/types.ts
```

On any failure after the stream opened: `event: error` + `data: {"status":504,"error":"…"}` then close. Before the stream opens (guard failures, bad body) the server answers plain JSON with the HTTP status: **403** `{"error":"Answer service is disabled"}` when `ASK_ENABLED !== "true"`, **403** for a disallowed `Origin`, **429** `{"error":"Too many questions","retryAfter":N}` with a `Retry-After` header for per-IP or daily-cap limits, **413** body too large, **400** bad body.

### `done` payload (Answer)

```jsonc
{
  "kind": "answer" | "no-answer",
  "text": "…",                        // validated prose (see validator)
  "facts": [ { "label": "Warranty", "value": "Active until Nov 22, 2029", "status": "ok", "entityId": "EQ002", "sources": [ SourceRef ] } ],
  "sources": [ SourceRef ],           // union of fact sources
  "confidence": 0.9,
  "entityId": "PROP002",              // primary entity, if any
  "interpretation": "…",              // optional: how the question was read
  "verifiedCount": 2,                 // distinct cited documents
  "unverifiedCount": 1,               // heldBack docs touching a retrieved entity that would add a field no verified record has
  "closest": [ SourceRef ],           // top-5 docs from retrieval, with excerpt = why ("mentions 12 Main St, no boiler on file")
  "latencyMs": 1830,
  "retrievalIds": ["EQ002", "PROP002"],
  "validatorStrikes": 0,              // sentences removed by the prose validator
  "cached": false
}
```

`SourceRef = { documentId, location: { page?, field? }, excerpt? }`. Every source's `documentId` must exist in `records`/`docs`; the server drops anything else, then drops facts left with no sources. Facts may only cite sources supplied in the retrieved context.

## Server rules (api/ask.js)

1. Guard first (`api/_lib/guard.js`): `ASK_ENABLED`, origin allow-list, body size, per-IP token bucket (`ASK_PER_IP_PER_MINUTE`, default 10), global daily cap (`ASK_DAILY_CAP`, default 500). In-memory by default; Upstash REST when `UPSTASH_REDIS_REST_URL`/`TOKEN` are set.
2. Retrieve (`api/_lib/retrieve.js`): mention detection (serials incl. hyphenless/confusable forms, model numbers, address tokens, person/company names), lexical scoring over `label` + field values, expand top-8 entities one hop via `related`, cap context at ~6k tokens (~24k chars). Returns `{ entities, docIds, closest }`.
3. Generate: `claude-sonnet-4-5`, `max_tokens: 600`, temperature 0, 8 s timeout (`AbortController`); on timeout or API error → no-answer with `closest`, logged. The prompt carries only the retrieved records, with sources as short refs (`s12`), every date annotated (`iso`, `when`, `within`), precomputed `WINDOWS` / `IN WINDOW` lists when the question names a period, and a `WARRANTY SUMMARY` for warranty questions over ≥3 units. Output is a compact line format (`TEXT:` / `FACT: label | value | ref` / `ENTITY:` / `CONFIDENCE:` / `NONE:`) parsed server-side into the Answer; fact `status` is derived server-side from the cited field. Zero-retrieval questions short-circuit to no-answer without a model call; `answerable:false`/`NONE:` forces the no-answer path even if facts were sent; if facts survive but the validator strikes every sentence, `text` is synthesized from the facts.
4. Validate (`api/_lib/validate.js`): split `text` into sentences; keep a sentence if it shares ≥1 normalized value (date, serial, money, name, address token, number) with a cited fact, or matches the hedge/no-answer allow-list. Removed sentences count as `validatorStrikes` and are logged. Nothing left → no-answer path.
5. Emit `done`.

## Client rules (answerService.claude.ts)

- Parse SSE incrementally with `fetch` + `ReadableStream`; call `opts.onStatus(stage)` for each `status` event so the thinking ticker is driven by real events, not timers.
- Non-2xx before the stream: throw `Error` whose message the AskScreen can show ("Answer service is off", "Too many questions — try again in N s").
- Final Answer goes through `normalizeAnswer` (drop unknown doc ids, recompute `sources`, keep `latencyMs` etc.).
