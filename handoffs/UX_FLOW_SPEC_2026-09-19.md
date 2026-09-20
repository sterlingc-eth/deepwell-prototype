# DeepWell App — Ergonomics & Flow Change Spec
Audited 2026-09-19. Live app (`deepwelltechnology.com/app/`, signed-in org "Sterling's Organization", 8 real documents) + source in `src/`. Audience for this doc: a frontend engineer implementing in ~1 day. Audience for the app: a shop owner or office manager — not an engineer.

## Why this exists
Nav has 5 top-level items plus two icon buttons ("Website", "Field") that all read as roughly the same weight. Three screens (Records, Browse, Dashboard) all show "overview" data with overlapping tiles (Unlinked inbox, Conflicts, Documents), so a first-time user can't tell which one to check. The document review queue — the single most important daily task for an office manager — has no nav entry of its own; it's a button inside Intake. Internal pipeline vocabulary ("Unlinked inbox," "Blocked at Classified," "Linked → can reach Classified") is shown verbatim to shop owners who have never seen the word "classified" used this way.

---

## A. Proposed information architecture

| Order | Nav label (unchanged unless noted) | Plain-English purpose | Becomes |
|---|---|---|---|
| 1 | **Ask** | "Ask a question, get an answer with proof." | Same screen, unchanged. |
| 2 | **Inbox** *(rename from Intake)* | "Add paperwork and clear what needs your attention." | `IntakeScreen` + `ReviewScreen` merge into one screen with two tabs: **Add files** (today's Intake) and **Needs a person** (today's Review, today's separate `review` route). One nav item, one mental model: "the pile I have to work through." |
| 3 | **Records** | "Every property, unit, and document you have on file." | `BrowseScreen` (Documents + Records sub-tabs) — this is the browsing/lookup screen. Today's `RecordsScreen` (health metrics) is folded into a "Data health" card at the top of the Dashboard (see #4), because a shop owner does not think of "health metrics" as a destination distinct from "how's my data doing" — which belongs on the Dashboard they already open first. |
| 4 | **Dashboard** | "What needs attention today — warranties, gaps, alerts." | Existing `DashboardScreen` (alerts, expiry table, at-risk equipment) **plus** a new top "Data health" strip carrying today's Records-screen tiles (Documents, AI verified, Unlinked inbox → "Needs linking", Gaps → "Missing info", Conflicts) so there is exactly one place that answers "is my data OK." |
| 5 | *(remove from top nav)* Browse | — | Content absorbed into Records (#3) as its Documents/Records tabs, already how `BrowseScreen` is internally structured. Removes the Records-vs-Browse naming collision (BrowseScreen literally has an internal tab called "Records"). |
| — | Website (icon, top right) | External marketing site | Move out of the primary nav row entirely into the org-switcher/account menu (it's not part of using the product) or drop it — a signed-in user managing paperwork has no task need for the marketing site, and it currently sits at the same visual weight as "Dashboard." |
| — | Field (icon, top right) | Toggle high-contrast/larger-text mode for outdoor/truck use | Rename to **"Field view"** or **"Outdoor mode"** — "Field" beside a nav that has nothing else called "field" reads as a place, not a toggle. Keep as icon toggle, just relabel. |

Net result: **4 primary nav items** (Ask, Dashboard, Inbox, Records) instead of 5 screens + 2 ambiguous icons, and the review queue — the daily task — is one click from a labeled nav item instead of a button buried inside Intake.

---

## B. Ranked change list (≤15, highest impact first)

1. **Give the review queue its own visible location.**
   Current: Review queue only reachable via a secondary button on the Intake screen (`IntakeScreen.tsx:401-403`, `<button>Review queue</button>`); no nav entry.
   Proposed: Merge Intake + Review into one **Inbox** screen with two tabs, "Add files" / "Needs a person," per IA above.
   Files: `src/App.tsx` (routing), `src/components/AppShell.tsx` (NAV array), `src/screens/IntakeScreen.tsx`, `src/screens/ReviewScreen.tsx`.
   Why: the task an office manager repeats daily ("clear what needs me") currently has no top-level door.

2. **Rename "Unlinked inbox" everywhere to "Needs linking."**
   Current: `RecordsScreen.tsx:161`, `DashboardScreen.tsx:347`, `ReviewScreen.tsx:29` all say "Unlinked inbox."
   Proposed: "Needs linking" (count of documents not yet attached to a property/unit).
   Why: "unlinked" and "inbox" are both jargon a non-technical owner has to decode; "needs linking" states the required action.

3. **Rename "Blocked at Classified" / "Required-field gaps" to plain language.**
   Current: `RecordsScreen.tsx:162` ("Required-field gaps" / "Blocked at Classified"), `ReviewScreen.tsx:372` ("Blocked at Classified — required fields missing").
   Proposed: Tile label **"Missing info"**; inline message **"Missing information — fill in the highlighted fields to continue."**
   Why: "Classified" is an internal pipeline-stage name; a shop owner has never classified anything.

4. **Replace the stage-pipeline copy with a plain progress phrase.**
   Current: `RecordsScreen.tsx:196`: "Nothing is answerable until Linked; nothing counts toward accuracy until Verified." Stage names shown as-is: Received, Classified, Extracted, Linked, Verified (`StagePill.tsx`, `PIPELINE_STAGES` in `types.ts:70`).
   Proposed: Keep the 5-step visual (it's a fine mental model — "how far along is this file") but caption it once, plainly: **"A document must reach 'Ready to link' before Ask can use it, and 'Checked' before it counts as accurate."** Rename stages for display only (data model untouched): Received → **Uploaded**, Classified → **Sorted**, Extracted → **Read**, Linked → **Matched**, Verified → **Checked**.
   Files: `src/components/StagePill.tsx` (`STAGE_LABEL` map — display-only, no schema change).
   Why: five unfamiliar-sounding stages plus a sentence using two of them as if self-evident is the single densest piece of jargon in the app.

5. **Fix "→ can reach" header copy on the review panel.**
   Current: `ReviewScreen.tsx:283`: `<StagePill/> → can reach <StagePill/>`.
   Proposed: **"Currently: Sorted · Next step: Matched"** (two labeled fields, not an arrow-plus-jargon-verb sentence).
   Why: "can reach" describes a graph traversal, not a document's status, to the one audience reading it.

6. **Make the document preview link back to the record and to Review.**
   Current: `DocumentPreview` (opened from Ask's source citations and from `EntityScreen`) has only a "Done" close button — confirmed live: opening a source from an Ask answer shows the PDF with no way to jump to the linked property/unit or to fix a wrong value.
   Proposed: Add two footer actions to `DocumentPreview`: **"View record"** (routes to `EntityScreen` for the doc's first linked entity) and **"Fix this document"** (routes to Review, pre-selecting that document — `openDocument` + `setCurrentScreen('review')`, same call `IntakeScreen.review()` already makes).
   Files: `src/components/DocumentPreview.tsx`.
   Why: today an answer's proof is a dead end — you can see the source but not act on it or navigate from it, in either the Ask flow or the Entity flow.

7. **Collapse the Records/Browse/Dashboard overlap.**
   Current: three separate top-level screens each show a version of "documents count," "unlinked inbox," "conflicts open" (`RecordsScreen.tsx:159-163`, `DashboardScreen.tsx:343-359`) with no single canonical place.
   Proposed: per IA section A — Records' health tiles move into Dashboard's new "Data health" strip; Browse merges into Records as its tabs. One nav item owns "browse/search," one owns "what needs attention."
   Files: `src/App.tsx`, `src/components/AppShell.tsx`, `src/screens/RecordsScreen.tsx`, `src/screens/BrowseScreen.tsx`, `src/screens/DashboardScreen.tsx`.
   Why: confirmed live — Records, Dashboard, and Browse each independently show an "Unlinked inbox" or equivalent metric; a new user has no way to know which is authoritative or where to click first.

8. **Add a real empty-state / first-run path, not just a banner.**
   Current: `App.tsx:151-156` shows a one-line dismissable-looking banner ("Nothing ingested yet for this account. Head to Intake…") above whatever screen the user landed on (e.g., a bare Dashboard with six all-zero alert tiles and empty tables) — no button, no visual hierarchy, easy to miss.
   Proposed: When the account has zero documents, route first sign-in straight to the Inbox/Add-files tab (not Ask or Dashboard) with a large single call to action: **"Add your first document to get started"** plus the existing drag-and-drop zone front and center, rather than a thin banner above an empty Dashboard.
   Files: `src/App.tsx`, `src/screens/IntakeScreen.tsx`.
   Why: a brand-new shop's first screen today is either Ask (nothing to ask about, though it does show good "e.g." examples) or a Dashboard that looks broken (six zero tiles, empty tables) rather than an inviting starting point.

9. **Show upload progress where the user is standing.**
   Current: confirmed in source — `IntakeScreen.tsx` upload rows do show live per-file status (Uploading/Reading/StagePill) correctly *while the Intake screen is open*, but that state is explicitly component-local (`uploads` state, comment at line 163-165: "It is about the transfer... and it should disappear when you navigate away") and there is no Dashboard/nav indicator that a batch is still processing if the user leaves Intake.
   Proposed: Add a small persistent "Processing 3 of 8…" indicator in the `AppShell` header (visible from any screen) whenever an ingest/bulk-import is in flight, linking back to Inbox.
   Files: `src/components/AppShell.tsx`, `src/store/appStore.ts` (lift minimal in-flight count).
   Why: today, navigating away from Intake mid-upload (e.g., to answer a phone call and check Ask) loses all visibility into whether the upload finished.

10. **Clarify the Dashboard alert tiles lead to an action, not just a number.**
    Current: confirmed live — the 6 alert tiles (Expired, Expiring 30/90/365, Registration closing, Upsell candidates) expand in place to a list with "Ask about this unit" / "Draft outreach" buttons, which is good. But the tiles themselves give no preview of what clicking does (no chevron/affordance beyond the whole card being a button).
    Proposed: Add a small "View list" / chevron affordance to each tile and change the empty-list message from generic "Nothing in this bucket right now" to name the bucket: **"No units expired right now."**
    Files: `src/screens/DashboardScreen.tsx:244-303`.
    Why: minor, but every other count on the page (Documents, Unlinked inbox) already reads as clickable via hover-lift; the alert tiles look identical but behave as expand/collapse, which is a different interaction the user can't predict.

11. **Standardize action-button verbs.**
    Current: mixed verbs across screens for the same underlying action of "go answer this": "Ask about this record" (Records), "Ask about this unit" (Dashboard), "Ask about this property" (Dashboard at-risk cards), "Ask this instead" (Browse), "Ask" (Records table row).
    Proposed: pick one verb form — **"Ask about this"** everywhere, since it's already the majority pattern; only the object noun ("record/unit/property") should vary contextually as an optional suffix.
    Files: `RecordsScreen.tsx:261`, `DashboardScreen.tsx:290,481` (search buttons), `BrowseScreen.tsx:361`, `ReviewScreen.tsx:480`.
    Why: five different phrasings for one action makes the app feel inconsistent even though the underlying behavior is identical.

12. **Merge the two nav-adjacent icon links into the account area.**
    Current: "Website" (external link to marketing site) and "Field" (mode toggle) sit at the same visual rank as Ask/Records/Intake/Dashboard/Browse in `AppShell.tsx:78-97`.
    Proposed: move "Website" into the org-switcher dropdown or drop it; rename "Field" to "Field view" (or "Outdoor mode") per IA table.
    Files: `src/components/AppShell.tsx`.
    Why: confirmed live — both render as unlabeled-on-mobile icon buttons in the same row as core nav, and neither is a "place in the app," which is what everything else in that row is.

13. **Give the "Review queue" its own empty-queue message, not "Select a document."**
    Current: confirmed live — with the default "Needs a person" filter and zero matching docs, the right panel reads only **"Select a document."**, which is a leftover default for the *other* (non-empty) case; the left list already correctly shows "Nothing here. The queue is clear."
    Proposed: When the queue is empty, right panel should say **"Nothing needs you right now — new uploads will show up here."**, not the generic picker prompt.
    Files: `src/screens/ReviewScreen.tsx:195` (`<div className="dw-card p-8 text-ink-3">Select a document.</div>`).
    Why: this is a real dead end observed live — a fully "clear" queue currently displays two contradictory messages side by side.

14. **Name the bulk "Reclassify & verify all" button in plain terms.**
    Current: `RecordsScreen.tsx:276-279`, button reads "Reclassify & verify all."
    Proposed: **"Re-check all documents with AI"**.
    Why: "Reclassify" is pipeline-internal; "re-check with AI" says what will happen in terms the owner already understands from "AI verified" elsewhere on the same screen.

15. **Fix the mobile nav-label collapse so at least the current screen is legible.**
    Current: `AppShell.tsx:71-72` hides all nav text below `sm` (640px) leaving five bare icons (plus two more icons for Website/Field) in a single row — confirmed from source; on a phone-width shop-owner session there is no visible label at all for which screen is active, only an underline/shadow indicator (`aria-current` styling, line 66).
    Proposed: below `sm`, keep icons but show the active screen's label as a one-line sub-bar under the header ("Records", "Ask", etc.) instead of relying on a shadow underline nobody will notice at a glance.
    Files: `src/components/AppShell.tsx`.
    Why: this is the primary device for a technician in a truck — an icon-only nav with no active-state label is the highest-risk mobile issue found.

---

## C. Empty-state / first-run copy, by screen

- **Ask (zero documents)** — *(already close; keep, minor tighten)* Heading: "Ask your records." Sub: "One question. One answer, with the documents it came from." Body: "Nothing added yet. Add a document, then ask about it." Button: **"Add a document"** (routes to Inbox, replacing today's "Go to Intake").
- **Inbox / Add files (zero documents, first visit)** — Heading: "Add your first document." Sub: "Drop in invoices, warranty cards, work orders, or a whole folder — we'll sort it out." Primary button: **"Add files"** (unchanged action, new prominence).
- **Inbox / Needs a person (queue empty)** — "Nothing needs you right now — new uploads will show up here automatically."
- **Records — Documents tab (zero documents)** — *(matches current, keep)* "No documents yet."
- **Records — Records/search tab (zero entities)** — Replace current implicit empty grid with: "No properties or units yet. They'll appear here once you add documents in Inbox."
- **Dashboard (zero documents)** — Do not show 6 zero-value alert tiles as the first thing a new shop sees. Replace the whole Alerts section with one card: **"Your warranty alerts will show up here once you've added a few documents."** plus an **"Add documents"** button, and keep the Overview tiles (Documents: 0, etc.) below it since those are still informative at zero.
- **Dashboard alert bucket, expanded, zero items** — Current: "Nothing in this bucket right now." Proposed: name the bucket, e.g. **"No units expired right now."**, **"No registrations closing soon."**

## D. Glossary — internal term → plain label to use everywhere

| Internal / current term | Where it appears | Plain label to standardize on |
|---|---|---|
| Unlinked inbox | Records, Dashboard, Review filter | **Needs linking** |
| Blocked at Classified | Review panel, Records sub-label | **Missing information** |
| Required-field gaps | Records tile | **Missing info** |
| "Nothing is answerable until Linked; nothing counts toward accuracy until Verified." | Records | **"A document must be Matched before Ask can use it, and Checked before it counts as accurate."** (after stage rename in item 4) |
| Received / Classified / Extracted / Linked / Verified (pipeline stages) | StagePill, Intake, Records | **Uploaded / Sorted / Read / Matched / Checked** (display labels only; keep internal `PipelineStage` values unchanged) |
| "→ can reach" | Review panel header | **"Currently: X · Next step: Y"** |
| Reclassify & verify all | Records button | **Re-check all documents with AI** |
| Mapped, facets, extractions | Backend/services code only (`postgresRecordsStore.ts`, `reviewClient.ts`) — **not currently shown in the UI** | No change needed; flagged here only as terms that must never leak into future UI copy. |
| Field (mode toggle) | AppShell icon | **Field view** (or Outdoor mode) |
| Browse / Records (two different screens with overlapping meaning) | Nav | Merge into one **Records** screen, tabs "Documents" / "Search" |
| "Select a document." (shown on empty queue) | Review panel | **"Nothing needs you right now — new uploads will show up here."** |

---

## Appendix — three walkthroughs (ideal path vs. where it breaks today)

**1. Brand-new shop, zero documents.**
Ideal: sign up → land on an inviting "add your first document" screen → drop files → see them move through sorting → ask a question → get an answer with the source. Breaks today at: first screen after onboarding is Ask or Dashboard, not Inbox; Dashboard with zero data shows six confusing zero-tiles and empty tables (item 8); Ask's empty state is otherwise good.

**2. Office manager clearing a box of paperwork.**
Ideal: open the inbox screen → drop the whole batch → watch a progress count → get routed to "needs a person" for the handful that didn't auto-file → resolve each with clear plain-English blockers → done, queue empty. Breaks today at: "Review queue" isn't a nav item (item 1); blocker text uses pipeline jargon (items 2-5); leaving the screen mid-upload loses progress visibility (item 9); an empty queue shows a contradictory "Select a document" (item 13).

**3. Owner asking questions and chasing warranty expirations.**
Ideal: open Dashboard → see what's expiring → click straight into an answer or a customer outreach draft → from an answer, jump to the actual document, and from the document, to the property record. Confirmed working well: Dashboard tiles, expiry table, and at-risk cards are all clickable to Ask (good); Ask's citations correctly show verified sources with page numbers. Breaks today at: the source-document preview is a dead end with no link to the property/unit record or a way to fix a wrong value (item 6); alert tiles look like the same "click for detail" pattern as Overview tiles but actually expand-in-place (item 10).
