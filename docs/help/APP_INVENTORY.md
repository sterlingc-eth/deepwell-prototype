# DeepWell app inventory (Round 29)

Not part of the knowledge base: `scripts/build-support-kb.mjs` only reads `NN-slug.md` files, so this file is skipped by the build.
It is the source of truth for the help articles. Every action id (`A-...`) below must be named by at least one KB entry through a
`!covers:` line in `docs/help/NN-*.md`, and `scripts/verify-support-app-coverage.mjs` fails when one is not.

Derived by reading `src/` (desktop) and `src/mobile/` (phone) on 2026-09-29 (re-synced with the Round 30 app changes the same day) plus the API strings the UI shows. Labels are copied
from the code. "Admin" = Clerk org role `admin` (`isAdminRole`); "Member" = any other role. The owner is the admin who created the
company. Where a panel is rendered by Clerk (our sign-in provider) the layout and labels come from Clerk, not this code, and are marked
"(provider panel)".

Surfaces: Desktop app = `deepwelltechnology.com/app`. Phone app = `deepwelltechnology.com/m` (installable web app, three tabs).

## Screens

- **S-LOGIN** Sign-in page (desktop `/app`, phone `/m`). Provider sign-in form. Desktop shows "Back to the DeepWell website".
- **S-ONBOARD** "You're signed in — now join or start a company." Shown when a signed-in user has no company. Choices: **Create your company**, **I was invited**.
- **S-ASK** Ask (desktop nav "Ask", phone tab "Ask"). Heading "Ask Donovan."
- **S-DASH** Dashboard (nav "Dashboard"): Data health tiles, Financials, Alerts, Overview, Warranty expiry table, Equipment at risk, Customer outreach summary.
- **S-INBOX** Inbox (nav "Inbox", badge = items needing a person). Two tabs: **Add files**, **Needs you**.
- **S-RECORDS** Records (nav "Records"). Four tabs: **Documents** (default for a user who has not chosen), **Customers**, **Grid**, **Graph**; the last tab used is remembered per user on this browser.
- **S-CUSTOMER** Customer profile (opens from a customer row). Tabs Documents, Equipment, Timeline, Graph, Notes.
- **S-ENTITY** Equipment / property / technician record page ("Graph" toggle, related records, linked documents).
- **S-BILLING** Billing (icon + "Billing" in the header). Admin actions; every member can open the page.
- **S-TEAM** Team (icon + "Team" in the header; admins only in the nav). Cards: Phone app for your team, Follow-ups, Settings, Support access, invite form, member panel.
- **S-DONOVAN** Donovan (admin) overlay: Answer quality (misses, learning, scorecard, Search by meaning). Admin-only, opened from the header "Donovan" button or the command palette.
- **S-WARRANTY-PACKET** Warranty claim packet (from Dashboard "Prepare claim packet").
- **S-OUTREACH** Customer outreach (from Dashboard "Open Outreach" or an alert).
- **S-PALETTE** Command palette (`Ctrl+K` / `Cmd+K`), "Jump to a customer, address, serial, document, or screen…".
- **S-BELL** Notifications bell panel.
- **S-HELP** DeepWell Help chat (round launcher bottom-right on desktop; header button on the phone).
- **S-DOCPREVIEW** Document preview dialog (Records rows, citations, Inbox).
- **S-PAYWALL** Billing-only shell for a company with no plan ("Pick a plan to open your account").
- **S-M-ASK / S-M-SCAN / S-M-DOCS** The three phone tabs. **S-M-DOCSHEET**, **S-M-CUSTSHEET** phone bottom sheets. **S-M-INSTALL** the install guide on the phone sign-in page.
- **S-M-GATES** Phone full-screen messages: "Join your company first", "Choose a plan to continue".
- Not customer-facing (excluded): `/expenses` founders' expense site (operator-only).

## Actions: access, account, shell

- **A-SIGNIN** Sign in. Desktop: open `deepwelltechnology.com/app` (or **Log in** on the website). Phone: the installed DeepWell app or `deepwelltechnology.com/m`. The home-screen phone app keeps its own sign-in. Anyone.
- **A-RESETPW** Reset a forgotten password: on the sign-in form use the provider's password option / "Forgot password?" link. DeepWell staff cannot see or set passwords; never send one in chat.
- **A-SIGNOUT** Sign out. Desktop: header **Sign out**. Phone: round profile button (initial) at the top right opens the **Account** sheet, then **Sign out**; with unsent scans it warns first (see A-M-ACCOUNT).
- **A-SWITCHORG** Switch company (a person who works two companies). Desktop: company switcher in the header (no personal account is offered). Phone: Account sheet (round profile button) -> **Switch company** list, shown only with more than one company (see A-M-ACCOUNT).
- **A-CREATESHOP** Create a company: after first sign-in, **Create your company**. Then you are the owner/admin.
- **A-JOINSHOP** Join a company you were invited to: accept the invite email, or **I was invited** on the join screen. The phone says "Join your company first" and points to the desktop if you have no company.
- **A-FIELDVIEW** Office view (dark) / Field view (light, larger type for outdoors). Desktop header toggle; phone header sun/moon button. Remembered on the device.
- **A-HELPCHAT** Open DeepWell Help: round button bottom-right (desktop) / header button (phone). Title "DeepWell Help", placeholder "Ask about DeepWell". "Send this to a person" hand-off form.
- **A-PALETTE** Jump anywhere: `Ctrl+K` / `Cmd+K`. Groups: Screens, Customers, Addresses, Units, Service visits, Technicians, Documents, Ask. Desktop only.
- **A-NAV** Main navigation. Desktop: **Ask**, **Dashboard**, **Inbox**, **Records** in the top bar; **Billing**, **Team** (admin), **Donovan** (admin), Office/Field view, company switcher, **Sign out**; footer links **Phone app**, **Website**. On narrow windows only icons show and a label bar names the current screen. Phone: bottom tabs **Ask**, **Scan**, **Docs**.
- **A-DEEPLINK** Links that open a record: unit rows have **Copy link** (opens that unit). `?screen=billing` opens Billing.

## Actions: team, roles, seats

- **A-INVITE** Invite a teammate: admin opens **Team → Invite someone**, types the email, picks a Role (Member or Admin), **Send invite**. The person gets an email; accepting puts them in the company. Admin only. Desktop only.
- **A-INVITE-ROLE** Member vs Admin choice on the invite form (default Member). Admin can manage billing, invites, exports, deletions, support access, Donovan admin, merges. Member can ask, upload, browse, fix records.
- **A-ROLE-CHANGE** Change a person's role: **Team**, member list below the invite form (provider panel, **Members** tab). Admin only.
- **A-USER-REMOVE** Remove a user: **Team**, **Members** tab of the provider panel, that person's menu. Frees the login. Admin only.
- **A-INVITE-MANAGE** See, resend or revoke a pending invitation: **Team**, **Invitations** tab of the provider panel (Team text: "use the Members and Invitations tabs of the panel below the form"). Pending invites count toward the login cap.
- **A-SEATS** Login usage: **Team** header pill "3 of 5 logins used (owner not counted)" and "N pending invites". Members see "N members" only.
- **A-SEATCAP** At the cap the invite form is disabled and says "Your plan's login limit is reached — upgrade to invite more people." (Go to Billing). Over the cap: "Your team is over your plan's login limit ... Nobody is locked out, but new invites are paused until you're under the limit or upgrade." Server error text: "Your Team plan includes up to 5 logins (the owner account isn't counted). Upgrade your plan to invite more people." Caps: Solo 2, Shop 5, Crew 10, Fleet no DeepWell cap.
- **A-TEAM-MEMBER** A member who reaches Team directly sees a read-only "Members of <company>" list with "Only a company admin can invite people, change roles or remove someone. Ask an admin."; nothing in the nav points there.
- **A-MEMBER-GATE** What a member sees instead of a 403: admin-only buttons are visible but disabled with the note **Ask an admin** (tooltip "Only a company admin can do this. Ask an admin."): Records -> Documents **Export CSV**, Records -> Customers **Export CSV**, Data health export, customer **Merge into <name>** (Inbox -> Needs you and customer profile), every **Billing** action (note: "Only a company admin can start a plan, change it or manage billing. Ask an admin."), API access ("API keys are managed by a company admin. Ask an admin." on Fleet). Hidden from members entirely: **Empty this company's documents / Empty documents**, **Delete document**, the whole-company **Duplicate customers** scan. The server still returns "This action requires the 'admin' role in your company." if a request gets through.
- **A-PHONE-CARD** Team → "Phone app for your team": QR code, **Copy install link**, **See install steps**.

## Actions: billing and plan

- **A-TRIAL** Start the 30-day Solo trial (card required, nothing charged until it ends). **Billing → Start 30-day free trial**. Only companies that never subscribed.
- **A-PAYWALL** A company with no plan (never subscribed) or a canceled one sees only Billing and Team until it picks a plan ("Pick a plan to open your account"). Phone: "Choose a plan to continue ... The company owner can pick one on the desktop app."
- **A-PLAN-CHANGE** Change plan: **Billing → Choose a plan**, pick **Monthly** or **Annual · 1 month free**, **Choose plan** on the tier. Current tier shows **Current plan**. Admin. Opens Stripe checkout.
- **A-PORTAL** **Billing → Manage billing** (Current plan card) opens Stripe's billing portal: update card, see invoices/receipts, cancel. Admin. Only shown once a plan exists.
- **A-CANCEL** Cancel: Manage billing in Stripe's portal. After cancel the company shows "Ends <date>" and later the paywall.
- **A-INVOICES** Invoices and receipts: Manage billing (Stripe portal). billing@deepwelltechnology.com for missing ones.
- **A-CARD** Update card / payment method: Manage billing. Never type a card number into chat.
- **A-USAGE** Usage: **Billing → Current plan** shows Logins, Documents stored (used / cap), Pages this month (used / cap); Donovan is unlimited; the owner is not counted toward logins.
- **A-STATUS** Status pill: Free trial, Active, Payment failed, Canceled, No plan yet. Banner: "Your free trial ends in N days." / "Your last payment failed. Update billing to keep uploading." (Go to Billing). Past due more than 7 days: uploads blocked with "Subscription required".
- **A-BILLING-CONFIRM** After Stripe: toast "Billing updated — thanks!" or "Checkout canceled — nothing was charged." and "Confirming your subscription…" for up to a minute.
- **A-RESCUE** Buy Records Rescue (one-time paper scanning): **Billing → Records Rescue**, enter Pages (minimum applies), **Buy Records Rescue**. Admin.
- **A-APIKEYS** API keys (Fleet only): **Billing → API access**, **Key name**, **Create key**; the key (dw_live_...) is shown once ("Copy your new key now — it will not be shown again"); **Revoke** on a row. Admin. Scopes given: read, ingest, ask.
- **A-APIKEYS-GATE** Other plans see "API access is included on the Fleet plan. Upgrade to connect your own systems to DeepWell with API keys." and **See Fleet**. Server: 403 "API access is included on the Fleet plan".

## Actions: adding records

- **A-UPLOAD-WEB** Upload on desktop: **Inbox → Add files** tab, **Add files** (top right, or inside a batch), or drag files onto **Bulk import**. A batch is created around the drop; **New batch** lets you name one (Name, Source: Filing cabinet / Email / Shared drive / Truck, From, To dates). First-run companies land here with "Add your first document."
- **A-UPLOAD-BULK** Bulk import: **Choose files or a .zip** or drag a .zip / folder. Accepts .zip .pdf .jpg .jpeg .png .gif .webp .txt .md .csv .tsv .json .docx .xlsx (and iPhone .heic/.heif, converted to JPEG in Safari). A line under the drop zone says what is read and how iPhone photos are handled. Skips: macOS archive metadata, hidden files, folders, empty files, too large, unsupported type, a .zip inside a .zip, unsafe file names, and a .zip that expands to far more than it should. **Cancel** stops a run. Shows counts "N files · N uploaded · N queued · N skipped · N failed".
- **A-UPLOAD-LIMITS** Limits: PDFs and photos under 24 MB, text, CSV, Word and Excel under 20 MB, 100 MB hard ceiling; 50 files per upload request; per-page monthly allowance by plan; daily upload limit ("Today's upload limit has been reached. Uploading has stopped ... Try again after the limit resets (UTC midnight)").
- **A-UPLOAD-STATUS** Watching progress: per-file status (Checking…, Uploading…, Reading…, Queued…), stage pill (Uploaded, Sorted, Read, Matched, Checked; "AI verified"), header pill "Processing N of M…" (or "Still working on N — check Inbox" after ten minutes), the note "Still processing — check Inbox in a few minutes" next to a file that was accepted but not finished (with a **See Needs you** button that opens Inbox -> Needs you), and the six-number pipeline row with "N documents · N answerable and counted". Bell for later changes.
- **A-CLASSIFY** Inbox -> Add files, inside a batch that has files still at Uploaded: **Classify received** (demo mode: "Guess type from file name"). Runs server classification (same path as Records' classify), never overwrites a type a person chose, then reports "Classified N of M." or "Classified N of M. The rest need a person: open them under Needs you." or "Nothing could be classified automatically. Open each file under Needs you to set its type."; "These files are still uploading. Try again in a moment." / "Could not classify right now. Try again."
- **A-UPLOAD-DUP** A file already uploaded is recognized by content: "Already on file (matched by content)". No second copy.
- **A-UPLOAD-ERR** Upload errors: "Choose a plan to get started", "Monthly page limit reached (N) — upgrade your plan for more.", "Subscription required", "File is larger than 100 MB", "PDFs and photos have to be under 24 MB to be read...", "Text and spreadsheet files have to be under 20 MB...", "Word and Excel files have to be under 20 MB...", "Old Microsoft Office files (.doc, .xls, .ppt) can't be read...", "Files that can contain macros (...) are not accepted...", "HEIC/HEIF photos ... can't be uploaded as they are..." (iPhone photos), "This file has no file type at the end of its name...", "... files are not accepted. DeepWell accepts ...", "Daily AI budget reached — resumes tomorrow", "Waiting for the server's rate limit…", "Couldn't reach DeepWell — check your connection and try again." Billing errors show **See plans**.
- **A-SCAN** Scan on the phone: **Scan** tab, **Take photo** (rear camera) / **Add another page**, or **Choose photos or PDFs**. Photos are shrunk on the phone. Several photos: toggle "One document, N pages" vs "N separate documents", then **Upload N pages**. Result rows: "Uploaded and read", "Uploaded — still being read", "Already in DeepWell — nothing new to add". Then **Scan another** or **View docs**. Phone accepts images and PDFs only (no zip, no CSV).
- **A-SCAN-STATUS** After a phone upload each row shows "Filled X of Y fields", then "— all set" or "— needs 1 answer" (tap to answer in the document sheet).
- **A-SCAN-OFFLINE** No signal: the scan is saved on the phone ("No signal — saved on your phone, will upload automatically"), listed under **Waiting to upload (N)**, retried with backoff and when the phone is back online or the app is opened. **Sign in again** appears if the session expired. A row can be removed from the queue. Files that are too large or permanently rejected stay listed until removed.
- **A-SCAN-PLAN** Phone upload hitting a plan block shows the message and **See plans**.
- **A-ASK-SERIAL** Serial from a photo (desktop Ask): camera icon in the Ask box ("Serial from photo"), **Take a photo of the label**, confirm/edit the serial (placeholder SN-XXX-000000), it then asks Donovan about that serial.

## Actions: fixing and verifying records

- **A-NEEDS-YOU** **Inbox → Needs you** (badge shows the count). Chips: **Decisions**, **Needs a person**, **Missing info**, **Needs linking**, **Conflicts**, **Duplicates**, **Ready to verify**, **Company records**, **Money to check** (only when there are money issues), **All**. Dashboard Data health tiles open the matching chip.
- **A-DECISIONS** **Decisions** chip = short questions when DeepWell wasn't sure (serial, customer, address). Click an option (or press 1-9), **Type it instead** then **Confirm**, snooze ("Ask again later", key S), dismiss ("Doesn't apply"), **Why are we asking?** for the evidence, **Load more**. "On file for this document" chips: check mark = **Looks right**, pencil = **Fix**. Message when empty: "Nothing needs a decision right now."
- **A-FIX-FIELD** Correct a wrong extracted value: open the document (Inbox → Needs you, or the Fix/Looks right chips on a decision card). In the review panel **Extracted fields**; missing required fields have a box and **Add**. Corrections are used for later answers.
- **A-VERIFY-FACT** Confirm a value: **Looks right** on a field chip; or resolve all issues then **Mark checked** (last stage) / **Advance to <stage>**. Blocked reason shown: "Blocked: choose a document type; missing ...; not linked to a record; a value is disputed."
- **A-DOC-TYPE** **Document type** buttons in the review panel set what kind of document it is.
- **A-LINK** **Linked to**: pick a record in "Record to link" then **Link**. **Customer** section: suggestion button "Link to <name>", or **Change customer…** (search "Search customers by name…", **Use this**, or "Or create a new customer…").
- **A-CONFLICT** "Two documents disagree on <field>": click the value that is right.
- **A-DUP-DOC** Duplicate document: **Merge into original** (keeps the original, drops this copy).
- **A-DUP-CUSTOMER** Duplicate customers: **Duplicate customers** panel in Inbox → Needs you (Merge into <name>, Keep separate) and Records → Customers (banner: Merge into <name>, **Not the same**, **Merge all**; whole-company **Duplicate customers** scan for admins with Undo). Merging is admin.
- **A-AI-VERIFY** **Verify with AI** on a document not yet checked: "Verified by AI." or "Not confident enough yet — this still needs a person." Verified-by-AI shows as "AI verified".
- **A-OPEN-ORIGINAL** **Open original** (review panel) / **Download <filename>** (preview dialog). Phone: **Open original** in the document sheet. One file at a time.
- **A-DELETE-DOC** Delete one document: open it (Inbox → Needs you → the document), **Delete document**, then **Confirm delete** ("Delete this document? This can't be undone."). Admin only; the button is hidden from members.
- **A-MONEY-FIX** Money on this document (invoice number, dates, Subtotal, Tax, Total, Paid, Balance due, Status): **Correct <field>**.
- **A-REMINDERS** **Find reminders** on the Needs linking chip scans documents for reminders and attaches them to customers; a customer profile lists "Open reminders".
- **A-HIDE-SHOP** "Hide company records" checkbox and a technician filter on the Company records chip (company's own paperwork, not customer jobs).
- **A-M-NEEDS-INFO** Phone: open a document (Docs tab or the Scan result) and answer under **Needs your input**. "All set — nothing else needs an answer on this document."

## Actions: finding records

- **A-RECORDS-TABS** **Records** has tabs **Documents** (opens first for a new user), **Customers**, **Grid**, **Graph**; it then reopens on the last tab the person used (remembered per user in the browser). Search boxes live in the Customers and Documents tabs (the old Search screen was folded into them and the palette).
- **A-SEARCH-DOCS** **Records → Documents**: search box "Search filename, customer, address, technician, brand, contents…". Results as a table (Name, Type, Customer, Address, Date, Tech, Status, Amount) or cards; row click opens the preview.
- **A-FILTER-DOCS** **Filters** button (panel): Type, Status (Verified / Needs review / Missing info), Warranty (Expired / Expiring (90 days) / Active / No warranty on file), Customer, Site, Technician, Brand, Money (Has money, Open balance), My uploads, Service date range, Upload date range. Active filters appear as chips; **Clear all**.
- **A-SORT-GROUP** **Sort**: Newest upload, Newest service date, Customer A–Z, Type, Amount. **Group**: No grouping, Customer, Type, Month, Site. Table/Card view buttons. **Audience** control: Customer, Internal, All (Internal = team-only documents, badged "Team only").
- **A-VIEWS** Saved views: built-in **Needs review**, **Warranties expiring 90 days**, **This month's invoices**, **My uploads**; **Save current view** (name, Save); delete with the x. Saved on this browser. The URL holds the filters so a view can be shared.
- **A-CUSTOMER-SEARCH** **Records → Customers**: "Search by name, address, phone, or email…". Filters: Alerts (Any alert status, Expiring soon, Expired, Needs attention, No alerts), Equipment (Any equipment, Has units, No units on file), City, Last activity (Any time, 30/90/365 days), Sort (Recent activity, Name A–Z, Address A–Z, Most documents, Most equipment, Alerts first). **Clear all**.
- **A-CUSTOMER-NEW** **New customer** (Name, Address, Phone, Email). Customers also appear automatically as documents come in.
- **A-CUSTOMER-PROFILE** Customer profile: edit Name/Address/Phone/Email (click the value, save), Call / Email links, **Assign a document to this customer**, tabs Documents / Equipment / Timeline / Graph / Notes (**Save notes**), overview tiles (Documents, Equipment, Next warranty expiry, Open alerts), "Open reminders".
- **A-GRID** **Records → Grid**: spreadsheet of Documents or Units, "Filter by model or serial…", **Columns** picker (remembered), **Load more rows** / **Load all (up to 5,000)**, **Export CSV (N rows)**.
- **A-GRAPH** The **Graph** toggle on a record/customer (there is no Graph tab in Records): knowledge graph of customers, properties, equipment, documents.
- **A-EQUIPMENT-PAGE** Unit page: fields with sources, related service visits, linked documents ("Documents linked to this record"). Reached from a serial anywhere. Has an **Install date** field (see A-INSTALL-DATE).
- **A-INSTALL-DATE** Unit page **Install date** section: shows the date (or "Not on file") with its source ("From the documents below" / "Entered by <name> on <date>"); **Add install date** / **Change install date** opens a date box, **Save** / **Cancel**. Not admin-gated: anyone signed in who can correct facts (members too). Date must be a real day, 1950 or later, at most ~3 months ahead ("That install date is too far back. Check the year." / "...in the future..."). Saving audits it, stores "entered by", and re-derives the warranty when a verified brand rule exists (a printed expiry from a document is kept; an unverified brand keeps the date but no computed expiry). Result note: "Saved. Warranty now ends <date>." or "Saved. DeepWell could not work out a warranty end date from it (no verified warranty term for this brand), so the unit stays under "No warranty on file"." The Dashboard link **Add install date** (**Change install date** when one exists) opens this page with the box focused.
- **A-M-DOCS** Phone **Docs** tab: search "Customer, address, serial…", **Filters** sheet (Type, Status, Warranty, Site / address, Apply / Clear), **Sort**, **Group by customer**, refresh button, tap a row for the document sheet (customer button, missing fields, **Open original**), customer sheet (Equipment, Recent documents, Call).

## Actions: asking Donovan

- **A-ASK** Ask: **Ask** screen, type in the box ("Ask Donovan anything — an address, a serial, a name, a question…"), **Enter** to ask (Shift+Enter for a new line), **Esc** to clear. Typeahead suggestions appear as you type; the small pill under the box explains what Donovan will search.
- **A-ASK-EXAMPLES** Before the first question: **Try asking** chips (from your own records) or "For example" samples; a **Recent** list of past questions to re-ask. Field view chooses field-style samples.
- **A-ASK-SOURCES** Every answer shows citations ([1] markers, source chips, "Closest documents" when nothing is found, a records panel listing the rows behind a count). Click a source to open the document.
- **A-ASK-UNVERIFIED** Toggle **Include unverified** to also search documents that are read but not yet checked (caption says "Searched verified records only" / "Searched linked and verified records").
- **A-ASK-FOLLOWUP** Follow-up questions build on the last four ("Following up on N earlier questions"); **New question** starts fresh; follow-up chips under an answer.
- **A-ASK-NOANSWER** When Donovan finds nothing: "Nothing in your records answers that." with a **Not on file** badge, "Closest documents", and **Did you mean** chips.
- **A-ASK-FEEDBACK** "Was this right?" thumbs up / thumbs down ("What was wrong? (optional)"): a thumbs-down logs it and Donovan re-checks.
- **A-ASK-SHARE** **Share** (copies/shares the answer) and copy buttons on values.
- **A-ASK-ERR** Ask errors: "Donovan couldn't get an answer." + message; 402 shows **See plans**; "Donovan is seeing unusually high usage on your account. Please contact support@deepwelltechnology.com..."; "Daily AI budget reached — resumes tomorrow"; "Your session has expired. Reload the page and sign in again."; "That took too long — probably a weak signal. Try again." (phone).
- **A-M-ASK** Phone **Ask** tab: type in "Ask Donovan…", tap a starter, thread stays while you switch tabs. Help chat can send a question here.

## Actions: dashboard, warranty, outreach, notifications

- **A-DASH** Dashboard sections (each collapses): **Data health** (Documents, AI verified, Needs linking, Missing info, Conflicts; duplicates held out of every count), **Financials** (admin), **Alerts** cards, **Overview** (Documents, Units on record), **Warranty expiry · next to expire first**, **Equipment at risk**, **Customer outreach**.
- **A-DASH-ALERTS** Alert cards: **Expired**, **This quarter (30+90d)**, **Expiring in 30 days**, **Expiring in 90 days**, **Expiring in 12 months**, **Registration closing**, **Upsell candidates**. Open a card to see its units. Per unit: **View customer**, **Ask about this unit**, **Open in Outreach**, **Dismiss** (then **Undo**), checkbox to select for the claim packet. Empty text like "No units expiring this quarter right now."
- **A-DASH-EXPIRY** Warranty table: **All** / **This quarter**, columns Unit, Location, Expires, Status, **Copy link**, **Ask**, **Ask: next 12 months**. "Covered" and "No warranty on file — needs install date" lists (**Add install date** / **Change install date** opens the unit page with the date box ready, A-INSTALL-DATE).
- **A-CLAIM-PACKET** Warranty claim packet: tick units (Dashboard alerts or table), **Prepare claim packet (N)** opens **Warranty claim packet**: "Add a unit…" picker, **Select all**/**Clear**, remove x, "Packet preview", **Download PDF** (disabled until every unit has verified documents; shows "Warranty expired" / "Missing ..." / "No verified documents"). "Ask about this unit" link.
- **A-OUTREACH** Outreach: **Dashboard → Open Outreach** (or **Open in Outreach** on an alert). Settings (collapsed): Send outreach emails on/off, **Review first** vs **Automatic** (add-on), days before expiry, company name, phone, From name, signature, reply-to, offer text; only admins can change. **Generate drafts**, open a draft, **Copy email** / **Open in mail**, **Approve** / **Approve all**, **Send approved (N)** (admin, needs the email add-on/sending set up), **Skip**. **Sent log**. "Needs an email on file" count.
- **A-BELL** Bell (header, unread count): warranty/attention notifications with time ago; click one to go to it; **Mark all read**; "Nothing needs your attention." Polls every five minutes.
- **A-DIGEST** Daily warranty email digest: **Team → Settings → Notifications → Send the company's daily warranty digest (every admin)** switch (company-wide, admin; formerly "Email me warranty digests"). One email a day, only when something needs attention. Sent to every company admin who has not muted it.
- **A-DIGEST-MUTE** Same card: **Mute my daily digest** switch (per person, independent of the company-wide switch): stops the digest for that admin only; others still get theirs. Caption: "Stops the digest email for you only. Other admins still get it. Only admins receive the digest, so members have nothing to mute."
- **A-FOLLOWUPS** Follow-ups to team members: **Team → Follow-ups** card, **Send follow-up messages** switch, **Also email** switch, "Currently due" list with **Send now**, **Copy**, **Open in mail**. Admin.
- **A-DONOVAN-ADMIN** **Donovan** header button (admin): Answer quality — misses (questions Donovan couldn't answer, replay, copy for review), learning (proposals, keep as test), scorecard (**Run scorecard**), **Search by meaning → Prepare older documents**.
- **A-FINANCIALS** Financials strip/card on the Dashboard: totals Donovan counted from invoices, states what it could not count; admin can start the backfill. Money on a document is corrected in the review panel (A-MONEY-FIX).

## Actions: exports, data, support access

- **A-EXPORT-JSON** Full data export: **Team → Settings → Your data → Download data export (JSON)**. Admin. Documents, extractions, customer/unit records, audit log.
- **A-EXPORT-CSV** CSV exports: **Records → Documents → Export CSV**, **Records → Customers → Export CSV**, **Records → Grid → Export CSV (N rows)**. The first two are admin-only (disabled with "Ask an admin" for members); the Grid one downloads what is on screen.
- **A-EXPORT-WARRANTY** Warranty export = the claim packet PDF (A-CLAIM-PACKET); expiring-warranty list is the Dashboard table and Alerts cards.
- **A-DELETE-ALL-DOCS** **Records → Documents**, "Empty this company's documents": type DELETE, **Empty documents**. Permanent. Admin.
- **A-DELETE-SHOP** **Team → Settings → Delete this company**: **Delete company data…**, type the company name, **Permanently delete**. Cancels the subscription first; if that fails nothing is deleted. Admin. Export first.
- **A-SUPPORT-GRANT** **Team → Support access** (collapsed card): **Grant for** 24 hours / 72 hours / 7 days, optional reason (500 chars), **Grant support access**. Admin. Off by default.
- **A-SUPPORT-REVOKE** Active grant shows "Access active until <date>"; **Revoke now**.
- **A-SUPPORT-LOG** **Team → Support access → Access log (N)**: every staff access (action, time, record count, "emergency" marker and reason). "No staff access recorded yet."

## Actions: phone app

- **A-M-INSTALL** Install: iPhone/iPad Safari → `deepwelltechnology.com/m` → **Share** → **Add to Home Screen** → **Add**. Android Chrome → **Install** / menu **Install app** or **Add to Home screen**. In-app browsers (social, email, messaging) cannot install: open in Safari/Chrome. QR code and **Copy link** in the install guide; a small banner in the Ask tab prompts too. A phone opening the desktop app sees "On a phone? DeepWell Mobile is built for it." (**Open**, dismissible).
- **A-M-TABS** Tabs Ask / Scan / Docs; last tab remembered. Header: company name, Help button, Field/Office view, round profile button (opens the Account sheet).
- **A-M-LIMITS** Not on the phone: Dashboard, Inbox review queue, Team/invites, Billing, exports, settings, notifications bell, delete. Use the desktop app. (Sign out and Switch company ARE on the phone, in the Account sheet.)
- **A-M-OFFLINE** Offline behavior: app shell opens from cache with weak/no signal; Ask needs a connection; scans queue on the phone and upload later (A-SCAN-OFFLINE).
- **A-M-ACCOUNT** Phone Account sheet: header round profile button (initial, aria-label "Account and companies") opens a sheet titled **Account**: name and email, **Current company**, **Switch company** list (only when the person belongs to more than one company; note "Scans waiting to upload stay with the company they were taken in"), and **Sign out**. Switching halts the old company's uploads, clears company-scoped state, activates the new company and reloads. Queued scans are not sent to the new company: they stay under their own company and upload when it is active again (server refuses them with a 409 otherwise). Signing out with unsent scans shows "N scans have not been sent yet. Signing out deletes them from this phone." with **Stay signed in** / **Sign out and delete**; with none it signs out at once and wipes the phone's offline queue.
- **A-M-GATES** No company: "Join your company first ... Open DeepWell". No plan: "Choose a plan to continue ... See plans".

## Errors and limits reference (strings the UI shows)

- "This action requires the 'admin' role in your company." (403) — a member tried an admin action (billing, invite, export, delete, merge, key, outreach send).
- "Your session has expired. Reload the page and sign in again." — 401/403 from the API.
- "Couldn't reach DeepWell — check your connection and try again." — offline or dropped connection.
- "Something went wrong on our end. Try again in a moment." — 5xx.
- "Too many requests" + "Try again in N s." / "Try again tomorrow." — rate or daily cap.
- "Choose a plan to get started" (402) — no active plan. "Subscription required" — payment failed more than 7 days ago. "Monthly page limit reached (N) — upgrade your plan for more."
- "Daily AI budget reached — resumes tomorrow" (429).
- "Donovan is seeing unusually high usage on your account..." (429) — safety ceiling, contact support.
- "Enter a valid email address"; "Create your company first to invite people."; "Invites are unavailable right now. Try again in a moment."; "Could not check your team size. Try again in a moment."; "Could not send that invite. Try again in a moment."
- "Still processing — check Inbox in a few minutes" (with a **See Needs you** button) — shown next to an upload that was accepted but not finished.

## Half-built or confusing (product feedback, not for customers)

Fixed in Round 30 (kept here so the articles are not re-broken): members now see admin buttons disabled with "Ask an admin" (A-MEMBER-GATE) and Empty documents / Delete document hidden; the Dashboard "Add install date" now opens a unit page with a real Install date field (A-INSTALL-DATE); Classify received now runs server classification (A-CLASSIFY); the upload note now says "check Inbox" with a **See Needs you** button; Records opens on Documents for new users and remembers the last tab; the daily digest has a per-admin **Mute my daily digest** (A-DIGEST-MUTE); the phone has an Account sheet with Switch company and a labelled Sign out (A-M-ACCOUNT); the stale "Free preview used up" banner is gone.

Still open:

1. Role change, remove user and invitation management live in the provider's embedded panel under Team (Members / Invitations tabs); DeepWell's own invite form hides the provider's invite button. Labels inside that panel are not in our code.
2. The company-wide digest switch and the per-admin mute live in an admin-only card; a member has no digest setting (members do not receive it).
3. Outreach send and a few other admin actions may still return the 403 text instead of being disabled; the articles say "admin only" for those.
4. The Help chat (desktop) and Donovan's Ask box are two separate places for questions; round 29 routes clear how-to questions typed into Ask to Help answers.
