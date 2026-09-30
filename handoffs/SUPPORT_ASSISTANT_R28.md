# DeepWell Support Assistant (Round 28)

A support chatbot that answers ONLY questions about DeepWell (company, plans and pricing, add-ons, setup, uploading and
scanning, the phone app, Donovan usage, security and privacy, billing, contacting humans). It is separate from Donovan:
different key, different rate-limit buckets, different spend caps.

## What was built

- **Backend** `api/_lib/support/`: `policy` (constants, canned replies, starters), `guard` (input and output screens),
  `faq` ($0 matcher), `prompt` (model request), `client` (Haiku call), `limits` (rate + spend caps), `tools` (read-only
  plan/usage/upload lookups), `handoff` (email to a person), `engine` (the pipeline), `route` (HTTP), `kb.generated.js`
  (generated). Wired as `?action=support` in `api/account.js` (lazy import, so the Anthropic SDK stays out of cold start);
  `vercel.json` rewrites `/api/support`. `api/` still has exactly 12 top-level files.
- **Knowledge base** `docs/help/01..19-*.md` (19 articles, 121 Q/A entries) compiled by
  `scripts/build-support-kb.mjs` (`npm run build:support-kb`, `--check` in verify). Prices/limits are `{{tokens}}`
  rendered from `PLAN_CATALOG` / `PLAN_LIMITS` / `RECORDS_RESCUE`; the build fails on an unresolved token, a literal `$`
  amount not derived from those constants, or a mismatch with index.html / terms.html.
- **Website widget** `public/support/widget.js` (12.4 KB, built from `scripts/support-widget/widget.src.js` by
  `npm run build:support-widget`), `widget.css`, `logo-mark.svg`. Added to security, terms, privacy, the four
  industries pages and `get/index.html`. NOT added to `index.html` (owner adds two tags, below).
- **SQL** `M3-config/61-support-assistant.sql` (optional; see Owner steps).
- **Other edits**: `email.js` (`replyTo`), `privacy/redact.js` (`redactSecrets`), `rateLimit.js` (`support` bucket),
  `planner/spend.js` (`ROUTE_BUCKETS.support`), `verify-security.mjs` (route inventory), `verify-readiness.mjs`
  (migration-numbering check now tolerates 61).

## Pipeline (cheapest first)

guard (secrets, injection) -> small talk / identity / "talk to a person" / competitor -> signed-in account intents
(read-only tools, $0) -> "your own records" redirect to Ask -> **FAQ ($0)** -> trade how-to / off-topic refusal ->
optional Haiku -> canned fallback that offers a hand-off. The model runs only when the FAQ cannot answer AND a key
exists AND every spend cap is readable and open.

## API (the in-app UI codes against this)

- `POST /api/support {message<=600, history?:[{role,text}], surface:'public'|'app'|'mobile', page?, turn?}` ->
  `200 {reply, sources:[{id,title}], mode:'faq'|'model'|'guard'|'redirect'|'fallback', redirectTo?:'ask',
  handoff?:{offered:true,reason}, suggestions?:string[<=3]}`; `429 {error, retryAfterSec}` (+ `Retry-After`);
  `400 {error}`; `401` for app/mobile without a Clerk session.
- `POST /api/support {action:'handoff', email, name?, message, transcript?, surface}` -> `200 {ok:true}` (or 400/429/502).
  Emails support@deepwelltechnology.com with Reply-To = the customer. Public 3/day per IP, app 5/day per user.
- `GET /api/support?starter=1&surface=` -> `{greeting, suggestions[3-4]}`. Static, $0, no auth.
- Nothing about the conversation is stored server-side. Logs carry hashes and counts only.

## Owner steps

1. Deploy. The FAQ, guard, hand-off and starters work with no new env vars and no SQL.
2. Add the two tags to `index.html` (before `</head>` and before `</body>`):
   `<link rel="stylesheet" href="/support/widget.css">` and `<script defer src="/support/widget.js"></script>`.
3. Confirm `RESEND_API_KEY` is set (hand-off uses the existing email sender; without it the widget shows a mailto message).
4. To turn the **model** on (optional): run `M3-config/61-support-assistant.sql` in Neon, then set
   `SUPPORT_ANTHROPIC_API_KEY` (a NEW key, ideally in its own Anthropic workspace with its own monthly limit). The
   assistant never falls back to `CLAUDE_API_KEY`. Without the SQL, the model stays off (spend caps unreadable = fail
   closed) and per-IP limits fall back to per-instance memory; the FAQ keeps working.
5. Optional: run the SQL anyway for shared public per-IP limits.

## Env vars (all optional except the key to enable the model)

| Var | Default | Meaning |
|---|---|---|
| `SUPPORT_ANTHROPIC_API_KEY` | unset | enables the model; unset = FAQ + fallback only |
| `SUPPORT_ASSISTANT_MODEL` | `claude-haiku-4-5` | `off` / `0` / `false` = kill switch even with a key; a `claude-...` id overrides the model |
| `SUPPORT_DAILY_USD` / `SUPPORT_MONTHLY_USD` | 0.50 / 8 | per tenant |
| `SUPPORT_PLATFORM_DAILY_USD` | 25 | all signed-in tenants |
| `SUPPORT_PUBLIC_DAILY_USD` | 5 | website visitors (no tenant), also counted in the platform cap |
| `SUPPORT_PUBLIC_PER_MINUTE` / `_PER_DAY` | 8 / 60 | per IP hash |
| `RATE_LIMIT_SUPPORT_PER_MINUTE` / `_PER_DAY` | 8 / 200 | per signed-in user |
| `SUPPORT_HANDOFF_PUBLIC_PER_DAY` / `SUPPORT_HANDOFF_APP_PER_DAY` | 3 / 5 | hand-offs |

## Cost math (Haiku 4.5: $1/MTok in, $5/MTok out, cache read 0.1x, cache write 1.25x for 5 min or 2x for 1 hour)

- Cached prefix (rules + tool + whole KB) is about 8.7k estimated tokens, byte-identical on every call, 1-hour cache.
- Warm model turn: about $0.002 (8.7k cache-read $0.0009, ~250 fresh input $0.0003, ~150 output $0.0008).
- Cold turn (writes the cache): about $0.012 at the 5-minute rate, about $0.018 at the 1-hour rate. Paid once per hour of traffic.
- FAQ / guard / redirect / account-lookup / fallback turns: $0.
- A 5-turn conversation with 60% answered by the FAQ costs about $0.004 of model time once warm; the public $5/day cap is
  roughly 2,500 warm model turns.
- Worst case is bounded by the caps above; a turn whose estimated worst case exceeds $0.04 is not started.

## Turning the model on and off

- On: set `SUPPORT_ANTHROPIC_API_KEY` (and run SQL 61). Off: delete the var, or set `SUPPORT_ASSISTANT_MODEL=off`
  (instant, no redeploy of code; a redeploy or env refresh applies it).
- Off is graceful: unanswerable questions get "I'm not sure about that one - want me to pass it to the team?" with the
  hand-off form.

## Safety layers

Delimited untrusted text (`<user_message>`, angle brackets defanged), canary string, forced structured `reply` tool,
temperature 0, output validator (drops canary or prompt leaks, competitor talk, prices not derived from the price
constants, "coming soon" promises, certification claims, foreign links or addresses, markup), citation required, 12 turns
max, 600-char input cap, SSN/card/password redaction on hand-offs. Questions about a customer's own records never
reach an answer: they return `redirectTo:'ask'`.

## Known limits (be honest with customers)

- FAQ hit-rate: 93.5% on the 92 answerable questions of the 136-question tuning fixture (86/92; the other 6 need the
  model), but the matcher was tuned on that set. A 45-question second set written afterward scored 56% on first contact
  before keyword fixes, so expect roughly 55-70% of real in-scope traffic to be answered at $0 and the rest to go to the
  model (if on) or the hand-off.
- Not a certified anything: the KB says plainly there is no SOC 2, no status page yet, and lists coming-soon items as
  not available.
- The public widget is unauthenticated, so per-IP limits are best effort; the caps on spend are the real ceiling.

## Verify

`node scripts/verify-support-assistant.mjs` (unit, 107 checks), `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node
scripts/verify-support-widget.mjs` (browser, 108 checks; screenshots to `$SUPPORT_SHOTS_DIR`),
`node scripts/build-support-kb.mjs --check`, `node scripts/build-support-widget.mjs --check`. `verify:support` is in
`verify:all`.
