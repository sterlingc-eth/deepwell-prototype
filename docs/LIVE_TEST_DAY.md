# Live Test Day — a plain-language guide

**What this is for:** the day you load real Anthropic credits and want to know, safely and cheaply,
whether Donovan is actually ready — with a hard dollar ceiling you set yourself, a report you can read
in five minutes, and the ability to stop and pick back up later if anything goes wrong.

This is not a developer document. Everything below is copy-paste commands and what to look at.

---

## Before you start (pre-flight checklist)

1. **Load your Anthropic credits** first — the whole point of this exercise.
2. **Always do a dry run first.** It costs nothing (it never calls the model) and tells you roughly what
   a real run would cost, so you're never surprised. See "Step 2: dry run" below.
3. **If you're testing against production** (option B below), raise the per-day AI spending caps for
   your test tenant *before* you start. These are separate from the $ limit you give the test itself, and
   by default they're small enough to choke a bigger test partway through for a reason that has nothing to
   do with Donovan's quality:
   - `DONOVAN_ANALYTICS_DAILY_USD` (default $1/day)
   - `DONOVAN_SONNET_DAILY_USD` (default $2/day)
   - `DONOVAN_RESEARCH_DAILY_USD` (default $10/day)

   Set these in Vercel's environment variables for a day (Project Settings → Environment Variables), run
   your test, then you can set them back. **If you only run locally (option A below), you can skip this** —
   a local run uses a throwaway, in-memory copy of your data that starts fresh every time, so it never
   builds up a day's spending the way your real, production tenant does.
4. Decide your budget. The tool defaults to **$25** and will not spend more than you tell it to — see
   "What if it costs too much?" below for exactly how that promise is kept.

---

## Two ways to run it

### Option A — locally on your Windows PC (recommended first)

This is the safe, complete option: it grades Donovan's answers against your own data automatically and
gives you a full report (accuracy, cost, how confident wrong answers were, everything). It needs an
export of your data (the same kind of file used for the offline exam) and your Anthropic API key.

**Step 1 — open PowerShell** in the project folder (where you'd normally run `npm run ...` commands).

**Step 2 — set your API key for this window only.** This does **not** save it anywhere — it only exists
for as long as this PowerShell window stays open, and it is never written to a file, never committed, and
never shown on screen when you paste it if you use this exact form:

```powershell
$env:ANTHROPIC_API_KEY = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
```

Run that line, then paste your key at the prompt and press Enter (it won't echo the characters). If you'd
rather just see it while you type (fine for a single trusted machine), the simpler version works too:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

Either way: **close the PowerShell window when you're done for the day** and the key is gone. Never paste
it into a chat message, a document, or a script file.

**Step 3 — dry run (costs $0, always do this first):**

```powershell
node scripts/live-test-day.mjs scripts/golden/golden-export.json --dry-run --budget=25
```

This prints something like:

```
live-test-day --dry-run: 1504 questions, 234 need the model, estimated cost at $25 budget: $9.79 (234 priced, 0 would exceed budget)
```

That $9.79 is a **ceiling estimate for asking every single question that needs the model** — the real run
in Step 4 only asks a *sample* of those (by default, a handful per category, not all 234), so the real
run will cost noticeably less than this number, never more. If this number looks obviously wrong (way
higher than expected), stop and get in touch before running Step 4.

**Step 4 — the real run:**

```powershell
node scripts/live-test-day.mjs scripts/golden/golden-export.json --budget=25
```

This will take a few minutes. It prints a running summary and, when done, writes:

- `docs/reports/live-test-day-<today's date>.md` — **read this one.** Plain-language report.
- `docs/reports/live-test-day-<today's date>.json` — the same data, for me (Claude) to read back.
- `docs/reports/live-test-day-<today's date>.learning-candidates.json` — questions the model got right
  that could become free, permanent rules later.
- `docs/reports/live-test-day-<today's date>.checkpoint.json` — the resume file (see below). You never
  need to open this one.

**If it stops partway through for any reason** (you close the laptop, it crashes, you press Ctrl+C), just
run the *exact same command again* with `--resume` added:

```powershell
node scripts/live-test-day.mjs scripts/golden/golden-export.json --budget=25 --resume
```

It will pick up exactly where it left off — nothing already asked gets asked twice, and nothing already
answered is lost.

### Option B — against the real, live app (Sonoran Comfort Air), as an eyeball smoke test

This is a lighter, second check: it asks a small sample of real questions through the actual production
website (not a copy of your data), and hands you back the raw answers to read yourself. It does **not**
grade correctness automatically — there is no way to check "was that right" without your live database,
which this tool is deliberately never given.

**Getting a key, safely** — the site has no separate "create an API key" page today, so the safe way is a
few lines typed into your browser's own developer console, while you are already logged into the app as
the Sonoran Comfort Air account:

1. Open the DeepWell app in Chrome/Edge and make sure you're logged in and viewing that tenant.
2. Press F12 (or right-click → Inspect) to open Developer Tools, click the **Console** tab.
3. Paste this and press Enter:

   ```js
   fetch('/api/account?action=keys', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ action: 'create', name: 'live-test-day', scopes: ['ask'] }),
     credentials: 'include',
   }).then(r => r.json()).then(r => console.log('YOUR KEY (copy this now, it is shown once):', r.key));
   ```
4. Copy the key it prints (starts with `dw_live_...`) into your PowerShell window, same way as Step 2
   above:
   ```powershell
   $env:DEEPWELL_TEST_KEY = "dw_live_..."
   ```
5. That key can only ever *ask questions* (scope `"ask"` only) — it cannot read your bills, change
   settings, or create more keys. Still treat it like a password: don't paste it anywhere but this
   PowerShell window, and revoke it afterward if you don't plan to reuse it (there's a "revoke" action on
   the same `POST /api/account?action=keys` endpoint, or ask me to walk you through it).

**Run it:**

```powershell
node scripts/live-test-day.mjs --mode=production --base-url=https://deepwelltechnology.com --api-key-env=DEEPWELL_TEST_KEY --budget=25
```

(swap in your actual production URL if different). This writes a `.json` file with every question asked,
the answer text, whether it answered or honestly declined, and how long it took. **Read a handful of the
answers yourself** — that's the actual test here.

---

## What "good" looks like

Open the `.md` report and look for, in this order:

1. **CONFIDENT-WRONG, and especially FABRICATED, count.** This is the number that matters most. Zero (or
   very close to it) is the goal. A "CONFIDENT-WRONG" is a question Donovan couldn't answer at all
   without the model, that came back wrong once the model was allowed — some of those are just an honest
   "I don't know" that happens to not match, which is fine; the **FABRICATED** count underneath it is the
   stricter, scarier number — Donovan stating something as fact that was wrong. That one should be zero.
2. **Accuracy** on the stratified sample (stage a) and the A/B section (stage c) — the closer to the
   rules-only baseline's own near-100% the better, though some drop is normal (needs-model questions are,
   by definition, the harder ones).
3. **Honest-decline rate** — Donovan should say "I don't know" rather than guess when it doesn't have
   enough. Not a "the higher the better" number on its own; read it next to accuracy.
4. **Citation presence / support** — close to 100% is healthy; every claimed fact should point at a real
   document or record.
5. **The "every wrong answer" table at the bottom** — read through it. Each row is one you can hand back
   for a rule to be written.
6. **$ spent vs. budget**, and each stage's per-question cost — sanity-check against your own sense of
   what a question should cost.

## If something looks wrong

Don't panic and don't keep re-running it. Save the `.md` and `.json` report files and bring them back to
a Claude conversation — paste the file(s) in, or if we're already in a session with this project open,
just say "here's today's live test day report" and I'll read the `.json` one (it has everything the `.md`
has, in a form I can check precisely).

## A note on the model-ab.mjs tool

`scripts/model-ab.mjs` is a smaller, related tool: rules-only vs. rules+model on one exam/export, nothing
staged. `live-test-day.mjs` is the one built for tomorrow; `model-ab.mjs --live` still works (same
`--budget` safety) if you ever want a quick, single-pass comparison instead of the full staged run.

---

## For whoever reads this after Sterling (the technical version)

- **Pricing assumptions** live in one place: `scripts/live-test-day.mjs`'s `pricingAssumptions()`, sourced
  from `api/_lib/usage.js`'s `MODEL_PRICE_PER_MTOK` (env-overridable — see that file if Anthropic's prices
  have moved since 2026-09). Every report embeds this block so a reader can check it against the
  Anthropic console before trusting the $ figures.
- **Verified this round with zero real network calls**, via `scripts/lib/mockAnthropicClient.mjs` (patches
  the same shared `Anthropic.prototype.messages.create` seam `scripts/offline-exam.mjs`'s
  `installModelBlock` uses, but returns realistic, schema-valid, usage-priced responses instead of
  throwing) and `scripts/verify-live-test-day.mjs` (`npm run verify:live-test-day`, part of `verify:all`):
  budget hard stop mid-run, retries/429/overload handling via the codebase's own `withBackoff`, a
  persistent-outage scenario that never fabricates, a concurrency limit, a per-question timeout, and a
  simulated-crash-then-`--resume` that proves no completed result is ever lost.
- **Known limits, stated plainly (also in `live-test-day.mjs`'s own header comment):** a dialogue turn in
  stage (a) is asked standalone, not threaded through `conversationContext` the way
  `scripts/run-dialogues.mjs` replays a real conversation — this harvests needs-model question SHAPES from
  the dialogue sets, it does not test multi-turn follow-up resolution. Stage (d)'s "Haiku side" is
  `DONOVAN_RESEARCH_AGENT=0` (v1's `loop.js`), which still self-escalates to Sonnet for a question its own
  difficulty classifier calls hard — the report records which model each side actually used from the
  response's own debug trace, never assumes it. Production mode is intentionally ungraded (no DB
  credential is ever given to this script) — it is a smoke test, not a scorecard.
- **CONFIDENT-WRONG vs. confident FABRICATION**: `confidentWrongCount` mirrors `model-ab.mjs`'s own
  `isNewConfidentWrong` (shared, so the two tools' reports never define the metric differently) and
  includes an honest decline that happens to grade wrong against a non-empty expected value.
  `confidentFabricationCount` (`kind === "answer"` among those) is the strictly more actionable subset —
  see `summarizeResults`' own doc comment in `scripts/live-test-day.mjs`.
