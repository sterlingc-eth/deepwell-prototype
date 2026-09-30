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

- FAQ hit-rate (signed in): 93.5% on the 92 answerable questions of the 136-question tuning fixture (86/92; the other 6 need the
  model), but the matcher was tuned on that set. A 45-question second set written afterward scored 56% on first contact
  before keyword fixes, so expect roughly 55-70% of real in-scope traffic to be answered at $0 and the rest to go to the
  model (if on) or the hand-off.
- Not a certified anything: the KB says plainly there is no SOC 2, no status page yet, and lists coming-soon items as
  not available.
- The public widget is unauthenticated, so per-IP limits are best effort; the caps on spend are the real ceiling.

## Verify

`node scripts/verify-support-assistant.mjs` (unit, 168 checks), `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node
scripts/verify-support-widget.mjs` (browser, 108 checks; screenshots to `$SUPPORT_SHOTS_DIR`),
`node scripts/build-support-kb.mjs --check`, `node scripts/build-support-widget.mjs --check`. `verify:support` is in
`verify:all`.

## Guardrails (every layer, in request order)

Who sees what
1. **Audience enforcement.** Each `docs/help` article has `audience: public|app`, carried onto every KB entry. A signed-out
   visitor (surface `public`, or any caller without a verified session) is matched against public entries only. If the
   question is confidently about an app-only topic (9 articles: logins, change/cancel/invoices, uploading, scan status,
   exports, team/notifications, support access, data export/deletion, troubleshooting) they get a short pointer ("covered
   inside the app once you are signed in"), the public overview article as the source, and a hand-off offer. The app-only
   answer text is never returned. Signed-in app/mobile callers match everything.
2. **Two model prefixes.** The model gets a public-only knowledge prefix (about 5.8k estimated tokens) for signed-out
   visitors and the full one (about 8.9k) for signed-in users. Both are byte-stable and above Haiku's 4,096-token cache
   minimum. The full KB never reaches a signed-out visitor, and the account summary is never added to a public request.
3. **Tenant from auth only.** The tenant/user come from the verified Clerk session, never from the body. The account
   tools (plan/usage/upload counts, read-only, counts only, no names or filenames) are called only when signed in.
   Billing dates are shown to admins/solo only; a member is told to ask their admin.

Before the model
4. Request limits (per IP hash / per user), 600-char input cap, 12-turn cap, honeypot on hand-off.
5. Sensitive-data screen (SSN/card shapes refused before anything else looks at them).
6. Injection screens (ignore/override/reveal/persona/repeat-above patterns) -> refusal, never the model.
7. Scope screen: small talk, identity, competitor comparisons, trade how-to, off-topic all answered with canned text.
8. "Your own records" questions (addresses, serials, named-customer equipment/warranty) -> `redirectTo:'ask'`, never answered.
9. The FAQ ($0) comes before the model; the model runs only if the FAQ misses, a dedicated key exists, and every spend cap
   is readable and open (fail closed).

The model call
10. Dedicated `SUPPORT_ANTHROPIC_API_KEY` (never `CLAUDE_API_KEY`), kill switch `SUPPORT_ASSISTANT_MODEL=off`, temperature 0,
    250/350 max tokens, no retries, 15 s timeout, per-turn worst-case cost cap, spend caps per tenant/day/month, platform
    and public pool.
11. Rules in the cached system block: only the audience's facts; never invent prices, dates, certifications or contacts;
    never speculate about roadmap, costs, margins, staff or infrastructure; vendors only if in the published subprocessor
    list; security details only as published; never mention other companies, customers or accounts; never write customer
    names, addresses, serials, file names or record contents; only `@deepwelltechnology.com` addresses.
12. Untrusted text is wrapped in `<user_message>` with angle brackets defanged; canary string; forced structured `reply` tool.

After the model (any failure drops the WHOLE reply and falls back to a hand-off offer)
13. Output validator: canary/prompt leak, prompt markup, competitor names, prices not derived from the price constants,
    "coming soon"/roadmap promises, certification claims, **any email not @deepwelltechnology.com, street addresses,
    serial-like tokens, file names, company-name shapes, and capitalized name pairs the KB does not contain**, foreign
    links, HTML/markdown, SSN/card redaction, 1,200-char cap.
14. Citation required: a reply must cite known articles; a public reply that cites an app-only article is dropped.

After the answer
15. Hand-off email: email validated, transcript capped (12 turns x 600 chars), SSN/card/password redacted, ticket ref, Reply-To
    set, per-IP/user daily cap. Nothing is stored server-side; logs hold hashes and counts only.

Entry-level audience (articles 06, 07, 15, 16). An entry can override its article with `!audience:public` (visible to
everyone) or `!audience:public-only` (a signed-out summary; hidden from signed-in users, who get the fuller app entry),
and every such entry must carry `!source:` naming the public page(s) that state it (index.html, terms.html, privacy.html,
security.html, get/). `verify-support-assistant` checks that every number, price, email and menu path in these entries
appears on the cited page. Click-by-click in-app steps stay `audience: app`. Current split: 79 public entries (5 inside app
articles: refund policy, trial refund, card storage, delete a document, data after cancel) + 6 public-only summaries
(cancel any time, file types/size, support access, activity log, delete all data, what is kept) + 43 app-only entries.
The public site does not publish a file-format list or a size limit, so a signed-out visitor asking is told that and offered
the team. The public model prefix is now about 6.7k estimated tokens, the signed-in one about 9.0k.

## App how-to coverage + Ask routing (Round 29)

**Goal:** every "how do I do X in the app" question is answered, both in the DeepWell Help chat and when typed into Donovan's Ask box, from the same signed-in KB, at $0.

- **Inventory:** `docs/help/APP_INVENTORY.md` (not part of the KB build) lists 19 screens and 105 actions (`A-...` ids) read from `src/` and `src/mobile/`, with the exact labels, plus an errors reference and a "half-built or confusing" list. It is the source of truth for the articles.
- **Articles:** new `20-getting-around-the-app` .. `27-team-and-data-how-to` (audience app) and corrected/extended `02, 06, 07, 08, 09, 10, 11, 12, 13, 15, 16, 19`. Stale facts fixed: stage names are Uploaded / Sorted / Read / Matched / Checked (not received/read/mapped/linked/verified), size limits (PDF/photo 24 MB, text/CSV 20 MB, 100 MB ceiling, 50 files per request), support access lives in Team -> Support access, phone scans queue offline. Entry 20#8 is the honest "DeepWell has no scheduling, payments, GPS, texting, branding" answer.
- **Enforced coverage:** each app entry may carry `!covers:A-XXX`; `scripts/build-support-kb.mjs` fails the build when an inventory action is covered by no entry (or covers an unknown id, or a public-only entry claims one). KB is now 204 entries, about 14.6k model-KB tokens (cap for the Haiku turn guard is about 18.5k at `perTurnMaxUsd` 0.04, so no policy change).
- **Ask box route:** `api/_lib/support/askhelp.js` (no new top-level api file). In `api/ask.js` right after question validation: `helpGate(question)` (regex only: how-to shape + app vocabulary + a records veto for serials/model numbers, addresses, dates/months, "who/what did", "how many jobs", proper nouns, other people's passwords) then `answerHowTo` (lazy `import('./faq.js')`, strict: score >= 4.2, coverage >= 0.6, margin >= 1.1 over any other article, >= 75% of the question's words explained by the entry's own question/keywords, entry must be an app how-to). Skipped for scorecard calls and API-key callers. Answer shape is a normal Ask answer (`kind:'answer'`, no facts) with `interpretation: "From DeepWell Help: <article>"` and a `help` block; claim/citation fields are pre-filled so `send()` leaves it alone. It does not count against the monthly allowance and costs $0.
- **No-answer hint:** when the gate passed but the strict match did not answer and the normal pipeline ends in "no answer", the response carries `helpHint: true`; desktop AskScreen and mobile AskTab show "This looks like a how-to question... Open DeepWell Help". Both open the same Help chat through a `deepwell:open-help` window event (`SupportWidget`, `MobileApp`).
- **Client:** `Answer.help` / `Answer.helpHint` in `src/core/types.ts`, kept by `normalizeAnswer`; `src/components/HelpAnswerCard.tsx` renders the help card (desktop and mobile) and the hint.
- **Verify:** `npm run verify:support` now also runs `scripts/verify-support-app-coverage.mjs` (also `verify:support-app`): inventory-to-KB coverage, 164 tagged how-to questions (`scripts/fixtures/app-howto-questions.mjs`; typos and field-tech voice), out-of-scope how-tos, 28 records questions the gate must never capture, and every question in `test-docs/scorecard/**` (1,845 strings) through the gate and route (0 captured).
- **Honest numbers:** 164/164 on the tuned set, 40/40 on the second set (used once to tune), and only about 57% (17/30) at the FAQ level on a third set written after tuning (`HOLDOUT2`), with 6 of 30 answered from a wrong-but-related entry and 7 falling through. The Ask route is the safe subset: 25 answers on the 70 held-out questions, 0 wrong. The FAQ scorer generalizes to paraphrases only as well as the keyword lists; add phrasing to the entry's `~` line when a real question misses (check `HOLDOUT2` numbers stay flat or better).
- **Product feedback:** see "Half-built or confusing" at the bottom of `APP_INVENTORY.md`.

## Round 30 - precision over recall, article sync, L6

**Matcher (api/_lib/support/faq.js).** Answers only when it is sure; otherwise a short "Did you mean: A / B?" (two chips, each chip is an entry's own question and answers on its own, $0, engine step 11b, faqId `did-you-mean`) or a fall-through to the model as before. Gates: score, margin tiers (overwhelming/dominant/clear/narrow/tie), explained-weight (share of the question's words, weighted by specificity, explained by the entry's own question + keywords), generic/modifier-word down-weighting, action-verb class clash, "strange short" out-of-vocabulary word, contested runner-up. An exact question always answers. Thresholds live in the exported `GATES` object. Ask box (`askhelp.js`) additionally refuses 'narrow' wins and needs explained >= 0.75; zero-capture on `test-docs/scorecard/**` re-verified (31 pass the gate, 0 captured).

**Held-out results** (correct / did-you-mean / fall-through / wrong; A = 117 q, B = 107 q; app how-to + traps + public pre-sales + public traps):
- Old matcher: A 58 / 0 / 41 / 18 (15.4% wrong); B 53 / 0 / 36 / 18 (16.8% wrong).
- New matcher: A 39 / 13 / 64 / 1 (0.9% wrong); B 46 / 10 / 46 / 5 (4.7% wrong).
- A was used for exactly one tuning pass. B was written before the matcher was frozen and scored once, after: it is the clean number. Of B's 5 "wrong", 3 are defensible answers the pre-written labels did not list (payment failed -> the public payment-failure entry; fleet API -> "Is API access an add-on?"; Android install -> the public Android entry), 2 are real (invite waiting -> "invite a technician"; "api rate limit" -> the fair-use entry). B's gate in verify-support-precision.mjs is therefore 5%, A's is 3%. Do not tune on B.
- The recall given up goes to the model (signed in) or the hand-off (signed out), not to a wrong article. Tuned sets: 0 wrong; some questions are now did-you-mean (the verify scripts count a did-you-mean with the right entry as "offered").

**Articles synced with the shipped app (each verified in src/ first).** Records opens on Documents then remembers the last tab; Team > Settings > Notifications wording plus per-admin "Mute my daily digest" (A-DIGEST-MUTE); member-gated buttons show "Ask an admin" (Export CSV, customer merge, Billing actions, API keys) and Empty documents / Delete document are hidden (A-MEMBER-GATE); unit-page Install date + Dashboard Add/Change install date, saving re-derives warranty when a verified brand rule exists (A-INSTALL-DATE); upload note "check Inbox" with "See Needs you", Inbox "Classify received" -> "Classified N of M" (A-CLASSIFY); phone Account sheet: shop name, Switch shop (>1 shop), Sign out; sign-out with unsent scans warns and deletes them; switching shops reloads and queued scans stay with their shop (A-M-ACCOUNT); Team screen points to the Members / Invitations tabs of the Clerk panel. APP_INVENTORY.md now lists 110 actions; KB is 27 articles / 208 entries.

**L6 (forged assistant turns).** `prompt.js` `sanitizeHistory` drops every client `assistant` turn that is not a prefix of a server-known text (KB answers, canned replies, starters; signed-out requests only accept public texts). No client change and no signing key needed. Checked in verify-support-precision.mjs.

**New / changed scripts.** `scripts/verify-support-precision.mjs` (A and B, did-you-mean contract, L6), fixtures `support-heldout-r30.mjs` and `support-heldout-r30b.mjs`; `verify-support-assistant.mjs` and `verify-support-app-coverage.mjs` are did-you-mean aware (thresholds: how-to set >= 80% answered and >= 90% answered-or-offered; Ask route >= 45% because it is stricter now). Not wired into package.json (not an editable file): run `node scripts/verify-support-precision.mjs`.
