# QA Break-Test — DeepWell App (deepwelltechnology.com/app/)
Run 2026-09-19 against live prod, org "Sterling's Organization", tab 1533080506. Cleanup done: qa- docs deleted, 8 real documents (01–08) confirmed intact at end.

## Results table

| # | Step | Expected | Actual | Verdict |
|---|---|---|---|---|
| 1 | Reload 3x, check merge banner | Shows at most once, or never when nothing to move | "Moving any earlier uploads into Sterling's Organization…" shown on **all 3** reloads | **FAIL** |
| 2a | Nav clicks: Ask/Inbox/Records/Dashboard + tabs | All render correctly | All render correctly; labels match new IA (Ask, Inbox/Add files+Needs a person, Records/Documents+Search, Dashboard) | PASS |
| 2b | `?screen=review` | Inbox, Needs-a-person | Inbox, Needs-a-person filter active | PASS |
| 2c | `?screen=records` | Dashboard (aliased) | Dashboard | PASS |
| 2d | `?screen=ingest` | Inbox, Add files | Inbox, Add files | PASS |
| 2e | `?screen=browse` | Records/Documents | Records/Documents | PASS |
| 2f | `?screen=dashboard` | Dashboard | Dashboard | PASS |
| 2g | `?screen=nonsense` | No crash, fallback | Falls back to Ask, no crash | PASS |
| 2h | `?doc=<real id>` | Opens that doc's detail, URL scrubbed | Opens Inbox detail for that doc, URL scrubbed | PASS |
| 2i | `?doc=not-a-uuid` | No crash | Falls back to Ask after ~8s retry budget, URL scrubbed | PASS |
| 2j | `?q=How much was the Henderson install?` | Some sane handling | **Silently ignored** — `?q=` is not a recognized deep-link param (only `entity`/`doc`/`screen` are); box stays empty, no auto-ask, param never cleaned from URL | **FAIL (minor)** |
| 2k | Browser back/forward x5 | No crash | See finding #2 below — one `back` press served a **stale pre-redesign UI** via bfcache | **FAIL** |
| 3 | Mobile width (390px) sub-bar / overflow | Active-screen label visible, no horizontal overflow | Could not force actual viewport to 390px in this environment (`resize_window` did not change `window.innerWidth`, body max-width doesn't affect Tailwind `sm:` media queries). **Verified in source instead**: `AppShell.tsx` implements the sub-bar (`sm:hidden` label div, line ~146) and moves Website to footer / relabels Field → "Truck view" correctly per spec. Not independently visually confirmed. | INCONCLUSIVE (source matches spec) |
| 4a | Upload 3 qa- files (normal/0-byte/garbage) | Handled distinctly | 0-byte file rejected immediately, clearly labeled "Empty file", never uploaded, no doc record created (correctly excluded from Records count) — PASS. Normal + garbage files uploaded, then required a manual "Classify received" click to proceed past "Sorted" (not automatic) | PASS (empty-file handling); see finding re: processing pill below |
| 4b | Header "Processing N of M…" pill visible while processing, from any screen | Persistent indicator | **Never observed**, on Inbox or after navigating to Dashboard, while 2 docs sat in Uploaded/Sorted for 20+ seconds | **FAIL** |
| 4c | Normal file reaches Checked w/ AI badge ~3min | Reaches Checked | Reached "AI verified" only after manually clicking "Verify with AI" (not automatic); see finding #3 for the double-click bug encountered here | PARTIAL |
| 5a | Needs-a-person empty-queue copy | "Nothing needs you right now — new uploads will show up here." | Exact match | PASS |
| 5b | Dashboard tile → same-count filter | Tile click lands on matching filter | "Needs linking" tile → Inbox with "Needs linking" filter active (aria-current confirmed) | PASS |
| 5c | "Currently: X · Next step: Y" header | Plain two-field format | Confirmed: "Currently: Sorted · Next step: Read" | PASS |
| 5d | Double-click "Verify with AI" | No error, no duplicate/contradictory state | **Contradictory state produced** — see finding #3 | **FAIL** |
| 5e | Correct field to empty/5000 chars/emoji | No crash | Not tested — qa- docs had "Nothing extracted yet." (no fields to edit) and hard limits forbid editing the 8 real documents' fields | SKIPPED (no safe test surface) |
| 6a | Filter by filename/customer/type | Narrows correctly | "dispatch" → 3/10, "Goodman" → 1/10, "Invoice" → 1/10 | PASS |
| 6b | Sort every column x2 | No crash | No crash, list stays at 10/10 | PASS |
| 6c | Select-all / deselect | Works | 10 checked → 0 checked | PASS |
| 6d | Open original renders PDF | Renders | PDF renders in iframe modal with page count, "View record"/"Fix this document"/"Done" | PASS |
| 6e | "View record" navigates sensibly | Yes | Lands on EntityScreen with linked facts, sources, "Ask about this" (verb standardized per spec item 11) | PASS |
| 6f | "Empty documents" wrong confirmation word | Must NOT delete | Typed "delete" (wrong case) → button stayed disabled; clicking it did nothing; doc count unchanged at 10/10 | PASS |
| 7a | Data health tiles clickable | Yes | Confirmed for "Needs linking" | PASS |
| 7b | Alerts show counts; Expired ≥1 expected for Trane/Plaza Dental | Expired ≥1 | **Actual: Expired = 0.** Root cause traced via `/api/records`: the only document linked to the Trane (21341ABCD) — `04-maintenance-agreement-plaza-dental.pdf` — extracted `warranty_term: "5 years from install"` (relative) with **no `install_date` field**, so no absolute expiry is computable; Dashboard correctly shows "No warranty on file — needs install date." Whether an install date should have been inferred/extracted from this document is a data-extraction question, not confirmed as a UI bug — reporting actual behavior as requested. | REPORTED (see finding #4) |
| 7c | Draft outreach clipboard text | Sane text | Not testable — Upsell candidates / Registration closing tiers were both 0, no rows to trigger "Draft outreach" | SKIPPED (no data) |
| 7d | "No warranty on file — needs install date" list | Present | Present, lists all 3 units missing install dates | PASS |
| 8a | 6 rapid-fire questions | Box clears each time, no merged answers | Box cleared every time; only the last question's answer shown (correct, non-merged); "Recent" list correctly ordered all 6 | PASS |
| 8b | "delete everything" / "how many documents" / "list all customers" | No destructive action | All three returned "Nothing in your records answers that" — safe no-op, though the app has no aggregate/meta-query capability (minor UX gap, not a break) | PASS (safety); minor gap noted |
| 8c | 3000-char question | No crash | "Couldn't get an answer. Question is too long" — handled | PASS |
| 8d | Shift+Enter inserts newline | Newline inserted | Source code correctly guards `!e.shiftKey` before preventDefault (AskScreen.tsx:132-136), so this should work by native textarea behavior. Automation could not reliably confirm via synthetic key events in this environment (no visible newline appeared after a real keypress via the computer tool either) — inconclusive, likely a test-tooling limitation rather than an app bug given the source is correct. | INCONCLUSIVE |
| 8e | Source card → preview → "Fix this document" → Inbox detail | Works | Confirmed via Records "Open original" flow (equivalent code path); "Fix this document" button present in preview modal alongside "View record" | PASS |
| 9 | Bad bearer token to /api/ask, then app still works | App unaffected | `/api/ask` with `Authorization: Bearer bad` correctly returned 401; app's own subsequent real question (via UI) still worked (got 200 and a correct answer) | PASS |
| — | Answer consistency (side finding) | Same question → same quality answer | Asking "Is 4N211908772 still under warranty?" once returned "Nothing in your records answers that" (a wrong non-answer for data that exists); asking again immediately after returned the correct detailed answer. Flaky/non-deterministic retrieval. | **FAIL (flaky)** |
| — | Date display consistency (side finding) | Same stored date renders identically everywhere | See finding #5 below | **FAIL** |

## Ranked FAIL list (highest impact first)

1. **Merge-tenant banner shows on every single page load, not once.**
   Repro: reload `https://deepwelltechnology.com/app/` any number of times while signed in — the banner "Moving any earlier uploads into Sterling's Organization…" appears every time (confirmed 3/3 reloads).
   Root cause (App.tsx:51-69): `prevOrgId = useRef(orgId)` initializes to `orgId`'s value **at the time of that render**, which on every fresh page load is `null` (org hasn't loaded from Clerk yet). The effect fires once with `orgId=null` (sets `prevOrgId.current=null`, no-ops), then fires again when `orgId` resolves to the real org id — at that point `had = null` (falsy) and `orgId` is truthy, so `setMergeNotice(true)` runs, indistinguishable from an actual "just joined this org" transition. Because this ref resets on every mount, the notice re-fires on every full reload forever, not just the one time a tenant is actually merged.
   Fix direction: persist "have we already shown/attempted this merge for this org" in something that survives a reload (e.g. `localStorage` keyed by orgId, or a server-side flag), not a `useRef` that resets every mount.

2. **Double-clicking "Verify with AI" produces a contradictory, self-conflicting document state.**
   Repro: Inbox → Add files (or Needs a person) → open a Sorted document → click "Verify with AI" twice in quick succession.
   Actual: header shows "Currently: **AI verified** · Next step: **Read**" (nonsensical — Read precedes verification, not follows it) while the body simultaneously shows "**AI verified · 100% confidence**" AND "**Not confident enough yet — this still needs a person**" AND "**Nothing extracted yet.**" — three mutually contradictory status messages on screen at once, and the doc remains stuck under "Needs a person" while also claiming to be verified. This persisted (did not self-correct) on screen for the observation window. Almost certainly a race between two concurrent verify requests updating overlapping state.
   No console errors were thrown (checked via read_console_messages), so this fails silently — a real user would see the contradictory copy but no error to explain it.

3. **Browser Back can restore a stale pre-redesign UI via bfcache.**
   Repro: with the tab open from before this deploy, navigate a bit within the app, then press the browser Back button (`navigate {url:"back"}`).
   Actual: the page instantly showed the **old** 5-item nav ("Ask, Records, Intake, Dashboard, Browse" + separate "Website"/"Field" icon buttons) instead of the new IA (Ask/Inbox/Records/Dashboard/Truck view) — i.e., Chrome's back-forward cache served a full DOM/JS snapshot from before the redesign shipped, with no re-fetch of the new bundle. Pressing Forward returned to the new UI correctly. This is a deploy/caching risk: any user who had the app open before a redesign ships and taps Back can land back on old, unsupported UI without any visual indication that anything is wrong.
   Mitigation direction: send `Cache-Control: no-store` (or at least disable bfcache) for the app shell HTML, or add a `pageshow` listener that force-reloads on `event.persisted`.

4. **No "Processing N of M…" persistent indicator ever appeared during active ingest.**
   Repro: upload files in Inbox, then navigate to Dashboard while docs are still in "Uploaded"/"Sorted" (not yet Checked). Per spec (build item 9) and the header code (`AppShell.tsx` `ingestProgress` pill), this should show from any screen.
   Actual: the pill never appeared — on Inbox itself, or after navigating to Dashboard — even while 2 documents sat un-checked for over 20 seconds and required a manual "Classify received" click to advance. Root cause: `selectIngestProgress` (appStore.ts) only tracks the client-side upload **transfer** (`uploads` state: hashing/uploading/done/error) and clears as soon as the transfer itself finishes — it does not track the server-side classify/extract/link/verify pipeline stages, which is where the actual multi-second-to-multi-minute processing time happens. Functionally this reintroduces the exact problem spec item 9 was meant to fix: leaving Inbox mid-processing gives no visibility that work is still happening.

5. **Date display is inconsistent (off-by-one day) between screens for the same stored value.**
   Repro: Ask "Is 4N211908772 still under warranty?" vs. Records → Search → open that unit's record ("View record"), vs. Dashboard's warranty-expiry table.
   Actual: raw stored data (`/api/records`, `listEntities`) has `installDate: "2024-03-14"`, `expires: "2034-03-14"`. The Ask answer correctly renders "03/14/2024" / "expires 03/14/2034". But the **Entity screen** ("View record") shows "Installed **Mar 13**, 2024" / "Warranty expires **Mar 13**, 2034", and the **Dashboard** expiry table also shows "**Mar 13**, 2034" — one day earlier than the stored value, on both of the non-Ask surfaces. Classic symptom of parsing an ISO date string as UTC midnight and formatting it in a negative-UTC-offset local timezone. This directly affects whether a unit shows as expired/expiring in the Dashboard alert tiles around a boundary date, and is likely the source of the "month/day-precision" concerns flagged going into this test — it is not fully fixed.

## Minor / not independently confirmed
- `?q=` deep-link param is silently ignored (not wired into `useDeepLink`); harmless but a dead link if anyone relies on it, and it lingers in the URL forever since it's outside the cleaned param set.
- Ask has no aggregate/meta-query capability ("how many documents", "list all customers" both return "Nothing in your records answers that"). Safe, but a plausible customer question with no good answer.
- Same exact question to Ask ("Is 4N211908772 still under warranty?") returned a wrong "no answer found" once, then the correct detailed answer on immediate retry — retrieval flakiness, not reproduced on demand.
- Shift+Enter-inserts-newline could not be independently confirmed by automation (source code at `AskScreen.tsx:132-136` is correct); likely a tooling limitation, not a real defect.
- Mobile-width sub-bar/overflow behavior verified only in source (`AppShell.tsx`), not visually — the test environment's `resize_window` did not actually shrink the viewport.
- Records table's Stage column renders as an icon-only pill with only an `aria-label` ("Stage: AI verified") and no visible text label — not one of the assigned test steps, but worth a look given the spec's plain-language goals.
- Clerk is running with development keys in this production app (console warning on every load) — unrelated to the IA redesign but worth flagging.

## Cleanup performed
Uploaded `qa-dispatch-note-jordan-reyes.txt`, `qa-empty-file.txt` (rejected client-side, never became a document), `qa-garbage.txt`. Selected and deleted the 2 created qa- documents via Records → Documents → select → Delete selected (confirmed dialog, confirmed). Final state: Records shows exactly 8 documents, all named `01-`…`08-`, matching the original set.
