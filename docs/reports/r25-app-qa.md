# R25 App QA (desktop /app + mobile /m) — first-paying-client pass

Method: real `src/App.tsx` (non-demo path, `VITE_ANSWER_PROVIDER=claude`) and real `src/mobile/MobileApp.tsx` mounted in Playwright via new
`scripts/app-qa-harness/` (mutable Clerk mock + Playwright-routed fake backend: billing none/canceled/past_due/trialing/active, empty shop,
12 / 60 / 1,500 docs+customers, long names, 401/402/429/500(HTML)/offline). Viewports 390x844, 768x1024, 1280x800, 1440x900, both themes.
Screenshots: /tmp/claude-0/r25/app/{x,qa,desktop-ux,mobile-ux,ask-ux,fluidity}/.

## Defects (ranked)

| # | Sev | Screen | Issue | Status |
|---|-----|--------|-------|--------|
| 1 | Blocker | Desktop header (<=1100px, phones opening an invite link) | Header row was 744px wide at 390 (and clipped 94px at 1024, 18px at 1100): Billing, Team, Donovan, org switcher and **Sign out** off-screen, page scrolled sideways | FIXED (AppShell wraps; non-sticky on phones) |
| 2 | Major | Onboarding (first screen a new signup sees) | Intro copy, option cards and helper text pale-on-pale (dark tokens on a fixed light plate) - near invisible | FIXED |
| 3 | Major | Ask (desktop + mobile), new shop / API down / offline | "Try asking" sample chips showed a pulsing blank skeleton forever; the empty-state fallback ("Add a document") was unreachable | FIXED (`useSamplePrompts` settles) |
| 4 | Major | Ask, Records banner, mobile | Raw "Failed to fetch" / "500 Internal Server Error" / "API error 500: ..." shown to owner; missing period before "Showing whatever loaded" | FIXED (`friendlyErrorMessage`) |
| 5 | Major | Inbox, failed upload (402/offline/5xx) | Failed files stayed as phantom documents: pipeline read "Uploaded 2", Inbox badge counted them; reason sat ~800px below the fold, no "See plans" on the bulk path | FIXED (placeholder removed when no document row; top-of-Inbox alert) |
| 6 | Major | Mobile Ask, brand-new shop | "All clear - nothing needs attention" with zero documents, no pointer to Scan | FIXED (first-run card + button) |
| 7 | Major | Billing, canceled tenant | Told to "Start your 30-day Solo trial" (already used); Solo tile advertises "30-day free trial" to active subscribers | FIXED |
| 8 | Major | Global token | `--dw-ink-3` 3.8-4.4:1 on light surfaces (Field/sunlight theme captions, helper text) | FIXED (#5f6d64, 4.7-5.4:1; post-fix contrast sweep of 8 screens x 2 themes = 0 offenders) |
| 9 | Minor | Team / Outreach alerts, Office theme | Seat-limit alert dark-brown text on dark card | FIXED |
| 10 | Minor | Gated shell at <1024px | Sub-bar said "Ask" while Billing was shown | FIXED |
| 11 | Minor | Any screen crash | "Something went wrong" only offered full Reload | FIXED (adds Try again) |
| 12 | Minor | Customers table | "C-00001" wrapped to "C-" / "00001" beside long names | FIXED |
| 13 | Minor | Customer profile | Phone/email plain click-to-edit text, no call/email action | FIXED (Call / Email links) |
| 14 | Minor | Mobile plan-gate screen | No sign-out / switch-shop | FIXED (UserButton) |
| 15 | Minor | Ask, shop with docs but no suggestions | Would have said "Nothing added yet" | FIXED (only when docCount = 0) |
| 16 | Major (scale) | Customers tab | 1,500 customers: all 1,500 rows rendered, ~4 s load, 86,000px page. Fine for hundreds | OPEN - needs API paging |
| 17 | Minor | Header @1280 | Clerk switcher / "Office view" / "Sign out" labels wrap to two lines | OPEN cosmetic |

Verified OK: first-run redirect to Inbox with big CTA; empty Dashboard/Records/Grid/Graph/Warranty/Outreach copy; 402 -> "See plans"; 429 message kept;
billing gate (none/canceled) + past_due/trial banners; no unlabeled icon buttons/inputs on any screen; skip link; Esc returns focus from bell; Cmd-K palette;
no console errors on any screen in either theme.

## Needs API / owner
1. **Verify production has `VITE_ANSWER_PROVIDER=claude`.** The default is the demo mock: with it unset every Ask returns a wrong "Not on file". (Vercel project env, build-time.)
2. `GET /api/v1/customers`: accept `limit`, `cursor`, `q`, `sort` and return `nextCursor`/`total`; UI currently receives the full list and renders it (item 16).
3. Bulk import: `BulkFileState` keeps only an error string. If the API's per-file error carried `status` (402) and `url`, the UI would not have to infer "plan" wording (IntakeScreen `planIssue` regex).
4. `/api/account?action=insights` must always return `{items: []}`; a 200 with another shape crashes the Dashboard card (now recoverable via Try again).
5. Package script is `verify:mobile-fluidity-ui` (not `verify:mobile-fluidity`).

## Files changed
src/App.tsx, components/AppShell.tsx, components/ScreenLoadBoundary.tsx, core/suggestions.ts, index.css, mobile/{AskTab,MobileApp}.tsx,
screens/{AskScreen,BillingScreen,CustomerProfileScreen,CustomersScreen,IntakeScreen,OnboardingScreen,OutreachScreen,TeamScreen}.tsx, services/httpError.ts;
scripts/verify-desktop-ux.mjs (mock-switcher exclusion in the 44px check), package.json (`verify:app-qa`); new scripts/verify-app-qa.mjs (70 checks) + scripts/app-qa-harness/.

## Results
typecheck 0 errors; oxlint 0 errors (24 pre-existing warnings); verify:ui pass; verify:desktop-ux 36/36; verify:mobile-ux 65/65; verify:ask-ux 50/50;
mobile-fluidity 55/55; verify:app-qa 70/70; vite build OK.
