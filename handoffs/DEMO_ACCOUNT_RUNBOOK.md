# Industry demo account: runbook (Wave 1)

Everything Sterling does by hand to put the six Wave 1 demo companies on **staging**, check them, and later move them to
**production**. Nothing here needs an agent to see a password, key or connection string.

Wave 1 industries, with the exact Clerk organization names (copy them exactly; the `·` and `—` are how the app recognizes a demo company):

| Industry | Organization name (exact) |
|---|---|
| Real Estate | `Demo · Real Estate — Quailbrush Realty Group` |
| Property Management | `Demo · Property Management — Tallgrass Mesa Property Management` |
| HVAC | `Demo · HVAC — Coppervane Heating & Air` |
| Plumbing | `Demo · Plumbing — Bluegill Plumbing Co.` |
| Electrical | `Demo · Electrical — Kestrel Line Electric` |
| General Contractors | `Demo · General Contractors — Stonefield & Pike Builders` |

Files: `M3-config/73-demo-accounts.sql` (migration), `M3-config/demo/D1-setup-demo-companies.sql`, `M3-config/demo/D2-finish-seeding.sql`,
`scripts/demo-acct/` (key maker, seeding, staging QA, local proof and verify). Sample paperwork: the `demo-wave1` folder
(one sub-folder per industry, already generated; `scripts/demo-acct/gen/` regenerates it byte-for-byte).

---

## A. Staging, one time (about 45 minutes)

Staging = a Vercel preview deployment of a `staging` branch, on its own Neon branch and its own storage bucket, at
`https://staging.deepwelltechnology.com` (already allowed in `api/_lib/util/origins.js`).

1. **Neon**: Console > your project > Branches > Create branch `staging` from `main`. Copy its *pooled* connection string (keep it to yourself).
2. **Cloudflare R2**: create bucket `deepwell-staging` and an API token limited to that bucket (Object Read & Write). Add the bucket's CORS rule like the production bucket's (PUT and GET from `https://staging.deepwelltechnology.com`).
3. **Vercel** > Project > Settings > Environment Variables, scope **Preview**, branch **staging** only:
   - `NEON_CONNECTION_STRING` = the staging branch string
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME=deepwell-staging`
   - `CRON_SECRET` = a new random value (different from production)
   - Clerk (`CLERK_SECRET_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`) and Anthropic (`ANTHROPIC_API_KEY`/`CLAUDE_API_KEY`): same values as production
   - Inngest: either create an Inngest **branch environment** and set its `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` here (best: documents are read and their facts extracted within minutes), or leave them unset (then see step D3).
4. **Vercel** > Settings > Domains: add `staging.deepwelltechnology.com`, assign it to Git branch `staging`. Add the CNAME it asks for in Cloudflare DNS.
5. **Vercel** > Settings > Deployment Protection: the seeding tool cannot sign in through Vercel Authentication. Add `staging.deepwelltechnology.com` as a protection exception, or switch preview protection off while seeding and back on after.
6. **Clerk** (production instance) > Configure > Paths / allowed redirect URLs: add `https://staging.deepwelltechnology.com/app/`. (Same Clerk instance as production, so the same demo login and organizations work on both.)
7. **GitHub Desktop**: create branch `staging` from the branch with these changes and push it. Vercel builds it at the staging address.
8. **Neon SQL editor, staging branch selected**: paste and run `M3-config/73-demo-accounts.sql`. The proof rows at the bottom must show `rls t, force t` and both functions `prosecdef t`.

## B. Demo login and organizations (Clerk, one time; shared by staging and production)

1. Clerk > Users > `demo@deepwelltechnology.com`: set a strong password and save it in the team password manager.
2. Check the demo login is a member of **no** real company (in particular not Sonoran Comfort Air).
3. Clerk > Organizations > create the six organizations above (exact names). Add `demo@deepwelltechnology.com` to each as **Admin**. No other members.
4. Copy the six organization ids (`org_...`).
5. Sign in at `https://staging.deepwelltechnology.com/app/` (or the production app) as the demo login and switch to each of the six organizations once. This makes the app create each company and record the demo login as its admin. D1 refuses any organization that has not been opened this way, that has any other member, or that already holds documents.

## C. Make them demo companies on staging (5 minutes)

1. Open `M3-config/demo/D1-setup-demo-companies.sql`, paste the six ids into the six `>>> EDIT <<<` lines and the demo login's Clerk user id (Clerk > Users > demo@deepwelltechnology.com > User ID, `user_...`) into the seventh, run it in the Neon SQL editor (staging branch). Result: six rows, plan `demo`, status `demo`, an `import_open_until` date.
2. On your computer: `node scripts/demo-acct/make-demo-keys.mjs --out "C:\Users\chapman\Documents\deepwell-demo-keys"` (a folder outside the repo).
3. Paste `D1b-demo-import-keys.sql` from that folder into the Neon SQL editor (staging branch). Result: six key rows.

## D. Load the sample paperwork through the normal pipeline (30-90 minutes, mostly waiting)

1. In PowerShell, from the repo folder: `. "C:\Users\chapman\Documents\deepwell-demo-keys\demo-keys.ps1"`
2. `node scripts/demo-acct/seed-demo.mjs --docs "C:\Users\chapman\Downloads\donovan-training\demo-wave1" --base-url https://staging.deepwelltechnology.com`
   It runs the staff import tool once per industry (upload links -> storage -> read), shows progress, and waits until every document is read. Safe to run again; it resumes.
3. Only if you left Inngest unset in A3: facts are extracted by the sweep for documents read more than an hour ago, 25 per company per run. After an hour, run this twice (your staging `CRON_SECRET`):
   `curl.exe -H "Authorization: Bearer <staging CRON_SECRET>" "https://staging.deepwelltechnology.com/api/account?action=sweep&mode=docs"`

## E. Quality gate on staging (10 minutes)

1. Same PowerShell window: `node scripts/demo-acct/qa-staging.mjs --docs "C:\Users\chapman\Downloads\donovan-training\demo-wave1" --base-url https://staging.deepwelltechnology.com`
2. It asks all 90 starter questions in their demo companies and writes `qa-staging-report.md` into the demo-wave1 folder. A question passes only with the right answer AND the right cited page; the last question in each industry passes only when Donovan says he does not know.
3. Hand the report to the team (it goes in `claude/inbox`). Failures are fixed by improving the sample data or Donovan, never by matching question wording, then this step runs again.

## F. Lock the seed and test the resets (10 minutes)

1. Neon SQL editor (staging): run `M3-config/demo/D2-finish-seeding.sql`. Result: `seed_documents = documents` for all six, `import_closed = true`. The keys stop working (delete the keys folder now).
2. Sign in on the iPad at `https://staging.deepwelltechnology.com/app/` as the demo login: the industry picker appears. Tap "Check all demos": six green checks.
3. Open HVAC, scan any page (Inbox > Add files > Take Photo), ask about it, then tap the eraser ("Clear my scans") and confirm. The scan is gone; the sample paperwork is unchanged.
4. Next morning (the reset runs 10:05 UTC = 3:05 am Arizona), or right away by hand:
   `curl.exe -H "Authorization: Bearer <staging CRON_SECRET>" "https://staging.deepwelltechnology.com/api/account?action=demo&op=reset-all"` -> `"ok": true, "reset": 6`.

## G. Production (only after Sterling approves staging)

1. Neon SQL editor, **production** branch: run `73-demo-accounts.sql`, then D1 with the same six ids, then a NEW `make-demo-keys.mjs` run and its D1b.
2. Push to `main` (GitHub Desktop) so production has the code (the nightly reset cron is in `vercel.json`).
3. Seed with `--base-url https://deepwelltechnology.com`, run the production QA (`qa-staging.mjs` with the production URL), then D2 on production.
4. Patch note (customer-facing, exact): **"Added interactive industry demos."** Note: `src/data/releases.json` requires at least two notes per entry, so either add the entry with this note plus one more sentence, or sign it off with `internal.ownerApproved` so the single note is accepted after the rule is relaxed.

## Undo

- Take the whole demo out of a database: edit the `>>> EDIT <<<` line of `M3-config/demo/D9-rollback-demo.sql` to `'ROLLBACK DEMO'` and run it (staging first). It reverts every demo company to a plan-less company, revokes their keys and drops the two seed tables and three functions that 73 added. It deletes no company, user or document.
- A seed recorded before fix round 2 does not hold the company's settings copy: re-paste `73-demo-accounts.sql` and run `D2` again (on a clean demo company: after "Clear my scans") so the nightly reset can restore notification settings exactly. Until then the reset removes the three keys a presenter can change (`emailDigest`, `digestMuted`, `uiPrefs`).
- Remove one demo company from the demo: `UPDATE tenants SET plan = NULL, billing_status = NULL WHERE clerk_org_id = 'org_...';` (it then behaves like an unsubscribed company; delete the Clerk organization to remove it entirely).
- The nightly reset only ever touches companies whose plan AND billing status are both `demo` (`list_demo_tenants()`), and refuses any company without a recorded seed.
