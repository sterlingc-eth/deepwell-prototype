# Staff import runbook (R43)

For DeepWell staff, or an AI agent working on a staff computer. Plain English first; the exact commands are in the numbered steps.

**What this is.** A small program that loads a big folder of one customer's files (tens of thousands) into their DeepWell account. It uses exactly the same upload path the app uses in the browser, so reading, search and Donovan behave as if the customer had uploaded the files themselves. It exists because a browser tab cannot reliably push that many files: close the tab, or let the laptop sleep, and the browser forgets where it was. This program keeps a progress file and carries on where it stopped.

**Where it lives.** In the DeepWell repo folder: `scripts/import/deepwell-import.mjs`. No installation: it needs only Node.

**Is this the right tool?** See "Small customer" at the bottom. Under about 5,000 documents, just use the app.

---

## What you need

1. **The DeepWell repo folder** on the staff computer (the folder that contains `package.json`, `scripts` and `M3-config`). Open a terminal in it.
2. **Node version 18 or newer.** Check: run `node --version`. It must print `v18` or higher (for example `v20.11.0`). If it says "command not found" or a lower number, install the current LTS from nodejs.org, then close and reopen the terminal.
3. **An encrypted computer.** Full-disk encryption on (FileVault on a Mac, BitLocker on Windows). Do not run this on a shared or unencrypted machine.
4. **The customer's files in one folder on that computer** (for example exported from their Google Drive with rclone, or from a hard drive they sent). The tool never changes or deletes anything in that folder.
5. **Access to the Neon SQL Editor** (the owner pastes the SQL). AI agents never paste SQL themselves: hand the file to Sterling.
6. **Before a big import, the owner has raised the shared limits** (Inngest paid plan, the reading-speed settings in Vercel, Anthropic spend limit and credits, paid Neon plan). The checklist is section 2.1 of `claude/crew/ATLAS_ENGINEERING_PLAN.md` and `handoffs/FIRST_CUSTOMER_READINESS_R35.md`. This tool does not change those.

The customer's company must be on a plan (a trial or a paid plan, any plan). The import switch does not replace a missing or cancelled subscription.

---

## The procedure, start to finish

Replace `"/path/to/Customer Files"` with the real folder. The progress file, report and error list are saved **next to** that folder (not inside it), in files that begin `.deepwell-import-`.

### 1. Count the files (2 minutes)

Look at the folder size and file count (right-click > Get Info on a Mac; Properties on Windows). Write down the number. At the end it must reconcile with the tool's report.

### 2. Dry run (nothing is uploaded, no internet used)

```
node scripts/import/deepwell-import.mjs --folder "/path/to/Customer Files" --dry-run
```

It prints, in plain English: how many files, how many of each kind, how big, which files will be **skipped and why**, an estimated page count and an estimated reading-cost range (clearly labelled as an estimate), and a suggested page allowance for step 3.

Read the "skipped" list with the customer. Typical findings and what to do:

| Message | What it means | What to do |
|---|---|---|
| Google Docs/Sheets shortcuts (.gdoc, .gsheet ...) | These are tiny pointer files, not the documents | In Google Drive, export the real files to PDF (File > Download > PDF) and add them to the folder |
| Types DeepWell cannot read (.doc, .xls, .docm, .xlsm, .heic, .tif ...) | Old Word/Excel, macro files, iPhone photos (this tool cannot convert them; a browser does) and TIFF are not read. Word (.docx) and Excel (.xlsx) are read | Re-save old Word/Excel as .docx/.xlsx (or PDF); convert iPhone photos and TIFF to JPEG or PDF |
| Too large to read | PDFs and photos must be under 24 MB; text/CSV under 20 MB | Split the PDF, or scan again at a lower resolution |
| Empty files / hidden or system files | Nothing to read (.DS_Store, Thumbs.db, ~$ temp files) | Nothing. They are skipped automatically |
| Shortcuts / symbolic links | The tool never follows links, so it can never wander outside the folder | Copy the real file into the folder if it is needed |

Re-run the dry run after fixing files until the skipped list is only things you are happy to leave out. Save the screen output with your notes.

### 3. Paste I1 (the owner, 1 minute)

`M3-config/import/I1-allow-staff-import.sql` opens a temporary import for this one company: API keys on any plan, a separate page allowance for the import (it does **not** use the customer's monthly pages, and the pages it reads are left out of the customer's monthly count), higher upload-speed and daily AI-call limits, and room for more stored documents. It switches itself off after 14 days (never more than 60).

1. Make sure `M3-config/66-staff-import-override.sql` has been pasted once (I1 stops with a clear message if not).
2. Open I1. Edit the **one** line marked `>>> EDIT THIS LINE <<<`: put the company's name as it shows in the app, or its id.
3. Paste the whole file into the Neon SQL Editor and run it.
4. Read the result: two rows, BEFORE and AFTER. AFTER must show a `staff_import` with an `until` date in the future. If it stopped with an error, nothing changed; the message says why.
5. Optional: if the dry run's suggested allowance is far below 250,000, lower the `v_pages` number in the "leave these alone" block. It caps how much reading the import can spend. The app also enforces hard ceilings whatever is pasted (pages 1,000,000; AI calls per day 500,000; uploads per minute 2,000), and the import has a whole-import cap on AI calls of 4 per budgeted page, so an extra zero cannot remove the cap. I1 refuses numbers above the ceilings.
5a. If you pasted I2 earlier and now need the import again, I1 stops with a message instead of re-opening it by accident. Change `v_reopen := false` to `v_reopen := true` in the same block, then paste.
6. **Wait 5 minutes.** The app remembers each company's limits briefly.

### 4. Create the import key in the customer's account

The tool signs in with an API key made in the customer's own account.

- **Where in the app:** sign in as a **company admin** of the customer's account > **Billing** > the **API access** card > type a key name (use `DeepWell staff import`) > **Create key**. The key is shown **once**: copy it then. While the import is open, this card is available on every plan and says so; outside an import, only Fleet sees it.
- **Who does it:** the customer's admin, on a call with you, creates it. If DeepWell staff have been given access to the account, you can do it yourself. Either way the card must be used by an admin of that company.
- **Moving the key:** paste it straight into the tool's hidden prompt, or use a password manager share. **Never** email it, text it, put it in a chat, or type it as part of a command.
- **Name it with the word "import"**: I2 revokes keys with "import" in the name automatically.

The tool takes the key from the `DEEPWELL_IMPORT_KEY` setting or asks for it with a hidden prompt (you will see nothing as you type or paste). It refuses a key typed on the command line, on purpose: that would save it in your shell history.

- Mac/Linux, one session: `read -rs DEEPWELL_IMPORT_KEY && export DEEPWELL_IMPORT_KEY` (paste the key, press Enter, you will see nothing). Or just run the tool and answer its prompt.
- Windows PowerShell: `$env:DEEPWELL_IMPORT_KEY = Read-Host -MaskInput "Import key"`

Check the key and the allowance work before the long run (still harmless, one tiny request):

```
node scripts/import/deepwell-import.mjs --folder "/path/to/Customer Files" --dry-run --check-key
```

You want `Key check: OK`.

### 5. The 500-file test run

```
node scripts/import/deepwell-import.mjs --folder "/path/to/Customer Files" --limit 500
```

It uploads a spread-out sample of 500 files (the biggest few plus an even sample across folders). It asks "Type YES to start" (add `--yes` to skip the question).

Then, in the app, watch the 500 documents get read. Write down: minutes until all 500 are "Checked", seconds per document (Inngest dashboard), Anthropic spend before and after divided by pages, how many documents needed a person, and any failures. This is the real go/no-go; the pass criteria are in section 2.3 of the Atlas plan. Rescale the estimates with the measured numbers before the full run.

### 6. The full run

```
node scripts/import/deepwell-import.mjs --folder "/path/to/Customer Files" --watch-reading
```

It skips everything already done in the test run and carries on. Leave the computer awake and plugged in (turn off sleep). A live line shows `done/total`, files per minute, time left, failures and slow-downs.

Useful options: `--concurrency 4` (how many groups at once; the default 3 is safe, the maximum is 8), `--yes` (do not ask), `--state <file>` (a different progress file; it must not be inside the customer folder).

### 7. Watch reading

`--watch-reading` (used above) then checks every 30 seconds how many documents have finished being read and says when all of this run's documents are done. It uses an existing read-only status call and needs a key that includes the "read" permission (the app's Create key gives it). Also watch the Inngest dashboard (runs and failures), the Anthropic console (spend per hour) and Sentry. Reading continues in the background even if you stop the tool.

### 8. Reconcile

When the tool finishes it prints a report and saves it as `<progress file>.report.txt`:

- **Files found** = **uploaded** + **already in DeepWell** + **skipped** + **failed** + **not attempted**. The tool prints the check and says "matches files found". If it does not match, do not trust the report; tell Sterling.
- Compare **files found** with the count you wrote in step 1.
- `<progress file>.errors.csv` lists every failed and skipped file with the reason and what to do. Fix them (convert, split) and run the **same command again**; it only does what is left.
- In the app's Inbox, check nothing is stuck at "Reading", and review the "needs a person" list with the customer. Failed readings are retried by the Recover action and the nightly sweep.

The exit code is 0 when everything is done, 1 when any file failed, 2 when it could not start, 3 when it stopped early.

### 9. Paste I2 (the owner, 1 minute)

Only **after reading has finished** (pages that finish after this count against the customer's monthly allowance). Edit the one line in `M3-config/import/I2-end-staff-import.sql` (same company), paste it, and read the BEFORE/AFTER rows: AFTER must show an `endedAt` time. I2 ends the page allowance, the higher limits and the API-key permission, and revokes any key with "import" in its name. Nothing is deleted. Wait about 5 minutes for it to take full effect.

Any key stops working on its very next request after I2 or when the end date passes (the app checks the database on every key request, using the database's own clock). The company's own page budget and speed limits go back to normal within about 5 minutes (the app remembers them briefly).

If you stopped using the owner's raised settings (Inngest, Vercel reading speed, Anthropic limit), put them back to normal now.

### 10. Delete the key, then delete the customer files

1. In the app (Billing > API access) **revoke the import key** (I2 already did if it had "import" in its name; check).
2. Unset it on the staff computer: close the terminal, or `unset DEEPWELL_IMPORT_KEY`.
3. **Delete the local copies of the customer's files** (the folder, any zip, any rclone cache) and empty the trash/recycle bin. Delete the progress file, report and error list too (they contain file names, which can include customer names). Keep only the numbers you wrote down. Un-share the customer's Drive folder.

---

## What the messages mean

| Message | Meaning | What to do |
|---|---|---|
| `Cannot start: ... the import key must never be typed on the command line` | You put the key in the command | Set `DEEPWELL_IMPORT_KEY`, or leave it out and use the hidden prompt |
| `Cannot start: ... progress file must not be inside the customer folder` | `--state` points inside the customer's folder | Choose a place outside it |
| `Cannot start: ... must start with https://` | Wrong server address | Leave `--base-url` out (the default is correct) |
| `The import key was refused` | Wrong key, or it was revoked | Create a new key and run again |
| `API access is not switched on for this company right now` | I1 was not pasted, has expired, or I2 already ran | Paste I1 (again), wait 5 minutes |
| `IMPORT PAGE ALLOWANCE USED UP` | The import's page budget is spent | Raise `v_pages` in I1, paste again, wait 5 minutes, run again |
| `THE COMPANY HAS REACHED ITS STORED-DOCUMENT LIMIT` | Plan cap on stored documents | Raise `v_extra_docs` in I1, or move the company to a bigger plan (Solo holds 25,000, Team 100,000, Crew 500,000) |
| `THE MONTHLY PAGE LIMIT WAS HIT, ... allowance is NOT in force` | The override is off, expired or not yet visible | Paste I1, wait 5 minutes |
| `THE COMPANY HAS NO ACTIVE PLAN` | No trial or paid plan | Fix the plan first |
| `The daily upload limit for this company has been reached` | Per-day upload units used | Run again after midnight UTC, or raise `v_per_day` in I1 |
| `Stopped by you (Ctrl-C)` | You pressed Ctrl-C | Run the same command again |
| `The server has been too busy or unreachable for too long` | Three groups in a row failed after many tries | Try again later; nothing is lost |
| `Waited out N "slow down" replies` | The server asked the tool to slow down; it waited and carried on | Nothing. Lots of them means lower `--concurrency` |
| `the file changed while it was being uploaded` | The file was edited during the run | Run again |

## When it stops

**Whatever happens, nothing is lost.** The progress file records each file. Fix the cause, then run the **same command again**: finished files are skipped instantly (not even re-read), files that changed since are checked again, and everything else carries on. Ctrl-C stops cleanly after the files in progress (press it twice to quit at once; the progress file is still valid, even after the computer is switched off mid-run). Failed files from a temporary problem are retried by the next run; files the server refused (too large, empty, damaged) are not retried until they change.

## Data-handling rules

- Encrypted disk only. Never email, message or upload the customer's files anywhere except through this tool to their own DeepWell account.
- The tool never changes or deletes the customer's files, never follows shortcuts out of the folder, and never prints, logs or saves the key.
- Delete everything local after the reconciliation is signed off (step 10). Do not keep a copy "just in case".
- Do not paste the screen output into any chat if it shows file names that could identify the customer; summarise the counts instead.
- Only one import per company at a time.

## For an AI agent

You may run steps 1, 2, 4 (the key check), 5, 6, 7, 8 and 10 on the staff computer, with the folder and key supplied by the human. Do **not** run SQL (hand I1/I2 to Sterling). Never put the key in a command, a file or a message. If the tool exits with 2 or 3, read its last message and report it; do not retry in a loop. Report: the dry-run counts, the 500-file measurements, the final reconciliation numbers, and the path of the errors file.

## Small customer (under about 5,000 documents): just use the app

You do not need any of this. The app's normal upload is reliable at that size:

1. Sign in to their account > **Inbox** > **Bulk import** (or drop the files into the Inbox).
2. Add **1,000 to 2,000 files at a time** (a folder, several files, or a zip of that size), keep the tab open and the computer awake until the batch finishes, then do the next chunk. The browser tool uses 4 uploads at once, sends the files in groups of 50, retries by itself and slows down when the server asks. It stops with a plain message at a limit.
3. If the tab closes or the laptop sleeps, drop the same files again: files already stored are matched by content and skipped.
4. Do not drop one huge zip (tens of GB): the browser opens a zip in memory and that size is untested.

The customer's own plan limits apply there (pages per month, uploads per day); a 5,000-document customer on Team or Crew is normally fine without any override.
