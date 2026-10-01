# UX R36 - desktop UX and workflow audit (first since R24)

Scope: `src/screens/**` (not Intake/Browse/Customers) and `src/components/**` (not answer/, AnswerCard, DocumentPreview, support/, records/). Harnesses run at 1280 and 1440, dark (Office) and light (Field), as admin, member and solo owner (new `scripts/r36-harness/` mounts the real App with a mutable Clerk mock). Screenshots: `/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad/ux-r36-shots/{before,after}/`.

Baseline (before any change): verify-desktop-ux 36/36, desktop-ia, r31-qa 110, r30-app-fixes 86, app-qa 70, support-access-ui 43, ask-ux 50 all green. The existing "warranty export <= 6 actions" check only counted to the packet screen, which hid the real dead end (finding 1).

## Findings, ranked by pain x frequency

| # | Finding | Status |
|---|---|---|
| 1 | Warranty export dead end: Dashboard "select all" includes expired units; the packet's Download PDF stays greyed until every unit is claim-ready, with no reason shown. 7 expired units = 7 single Remove clicks. | FIXED: on-screen "N of M not ready..." note + one-click "Remove N not ready". |
| 2 | Customer "Call"/"Email" were 12px underlined links, the weakest control on the page for the main "find customer, call" flow. | FIXED: 44px buttons (`tel:`/`mailto:` unchanged). |
| 3 | Dashboard "Needs attention" sat under ~550px of Data health tiles (below the fold at 1280x800), and needed expand then act (2 clicks per insight). | FIXED: moved to the top; top insight opens by default. |
| 4 | Member Billing: a wall of greyed-out Choose plan / Manage billing / Buy Records Rescue / See Fleet buttons the member can never use. | FIXED: members get plan + usage meters + "Ask an admin" note only. Admin view unchanged. |
| 5 | Team (admin): invite form was below the phone-app card and 3 collapsed sections (below the fold at 1280x800); at the plan cap the login limit was stated 4 times (chip, banner, explainer, in-form hint). | FIXED: invite form leads; limit stated in the chip + one banner; explainer trimmed. |
| 6 | Dashboard repeated Documents (52 / 37 checked) twice and Units on record duplicated the warranty table. | FIXED: Overview tiles removed (Data health tile is the click-through to Records). |
| 7 | Help-chat launcher covered the footer "Website" link at <= 1400px wide (every screen). | FIXED in AppShell footer (right padding below 1400px). The launcher itself is `support/**`. |
| 8 | Trade-specific copy in generic places: Ask empty-shop examples ("furnace", "outdoor unit"), Outreach placeholders ("Acme HVAC", "yourshop.com"), Team email placeholder ("tech@yourshop.com"). | FIXED for strings no test or support KB pins. See owner decisions for the rest. |
| 9 | Billing plan buttons wrapped to two lines at 1280-1440 ("Choose / plan"). | FIXED: one line. |
| 10 | Contrast (WCAG AA text scan on Ask/Dashboard/Inbox x2/Records/Billing/Team, both themes, 1280), visible focus on the first 14 Tab stops, no horizontal overflow, no console errors. | CLEAN, no change. Guarded in the new verify script (focus + overflow). |

Also checked, no change needed: far-future date Confirm chip and Re-check in Inbox (work, but see owner decisions), billing usage meters, seat messages, role gates (member never sees Team/Donovan nav; admin-only buttons say "Ask an admin"), solo owner sees the invite form.

## Movement counts (clicks; typing counted as one action per field)

| Flow | Before | After |
|---|---|---|
| Ask a question + open the source | chip or type+Enter (1-2) + source click (1) = 2-3 | same (Ask/AnswerCard not changed) |
| Find a customer + call | Records, Customers tab, row, Call = 4; Call a 12px link | 4 clicks; Call is a 44px button |
| Customer -> equipment | row click, Equipment tab already selected = 0 extra | same (Records > Customers > row = 3 from anywhere; target <= 2 met from the Customers list) |
| Upload + resolve an Inbox item (incl. far-future Confirm) | Inbox, choose files, "Needs you" tab, item, Confirm = 5 (not driven end to end: the real upload needs the live pipeline; IntakeScreen is another engineer's) | unchanged |
| Warranty export to a PDF in hand | Dashboard, select all, Prepare, then 7 x Remove, Download = 11 (Download greyed, unexplained) | Dashboard, select all, Prepare, Remove not ready, Download = 5 (target <= 6 met) |
| Find a document | Records (opens on Documents), search box, row = 3; or Cmd-K, type, Enter = 3 | same |
| Review insights and act | Dashboard + scroll(1-2) + expand + action = 4-5 | Dashboard + action = 2 |
| Invite a teammate | Team + scroll + email + role + Send (form bottom at y=838 on an 800px screen) | Team + email + role + Send, form fully in the first screen |
| Check usage / billing | header Billing icon = 1 | 1 (member now sees only usage + note) |

## Regression checks

`scripts/verify-r36-desktop-ux.mjs` (`npm run verify:r36-desktop-ux`, appended to `verify:all`): 90 checks across 1280/1440 x dark/light x admin/member/solo. Covers warranty export (explained disabled state, one-click remove, <= 6 actions), member vs admin Billing, Team order/dedupe/role views, Dashboard duplicate tile and insights placement/open state, footer vs launcher clearance, focus rings, Call button >= 44px, generic placeholders. Run: verify-desktop-ux 36, desktop-ia, r31-qa 110, r30-app-fixes 86, app-qa 70, support-access-ui 43, ask-ux 50, verify:ui, verify:support-app, verify:readiness 184, `tsc -p tsconfig.app.json --noEmit`, `npm run build` all pass.

New harness files: `scripts/r36-harness/` (index.html, main.tsx, serve.mjs with an isolated vite cache dir, clerk-mock.tsx = app-qa mock + `solo`).

## Owner decisions / other teams' files

1. Vocabulary: the app says "shop" (Team, Billing, Onboarding, Outreach, notes like "Only a shop admin...") and "techs" (Team's "Phone app for your techs"). The site now targets any business. Not changed here because verify-desktop-ia, verify-readiness, verify-app-qa pin some strings and `api/_lib/support/kb.generated.js` (api/, support KB) quotes them ("Phone app for your techs", "shop admin", the Ask placeholder). Decide a term (team / workspace / company), then update the KB and these checks in one change.
2. Ask input placeholder wraps to two lines at 1280 ("Ask Donovan anything - an address, a serial, a name, a question..."). A shorter string fits one line but the support KB quotes the current one.
3. Help launcher (`support/**`): it overlaps content at the bottom-right edge at <= 1300px (it can hide a row's rightmost "Ask" action while scrolling). Footer is fixed here; the launcher could sit lower or auto-hide on scroll.
4. Inbox (IntakeScreen/BrowseScreen/CustomersScreen are not mine): the Add files tab shows "Add files" four times (tab, heading, button, per-batch button); the Needs you tab stacks three control rows (tabs, ten filter chips with an orphaned "All", My work/Everyone + Hide shop records) before the list. Suggest merging the Add-files heading/button and moving My work/Everyone onto the chip row.
5. Far-future date: the Confirm prompt appears three times in the review panel (banner Confirm, row Confirm, "(please confirm)" chip). All do the same thing; harmless but noisy. Left alone (ReviewScreen, pinned by r33 checks).
6. Header account icons (Billing, Team, Donovan, Field view, Sign out) are icon-only below 1536px (tooltip + aria-label only). No room at 1280/1440 without a menu; consider an account menu.
7. Insights only render outside demo mode, so the demo/sales fixture never shows "Needs attention". Consider seeding an example for the demo.
