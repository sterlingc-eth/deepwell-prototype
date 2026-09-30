# QA R31 - continuous QA / UX loops (4 loops)

Scope: everything outside the Donovan engine (screens, mobile shell, billing UI, help widget, website, accessibility, copy).
Screenshots: `/tmp/claude-0/-home-claude/c8b456ad-32a9-5305-923e-589d73c65629/scratchpad/qa-r31-shots/` (L1/, L2/, L3/, verify/).
Regression file: `scripts/verify-r31-qa.mjs` (`npm run verify:r31-qa`), sections L1-A..F, L2-A..E, L3-A. Explore scripts and logs live beside the shots (`explore/`, `qa-r31-logs/`).

## Suite before / after

| | Before (baseline) | After (final) |
|---|---|---|
| verify:* scripts | 142 PASS, 3 not passing | 146 PASS, 0 not passing (incl. live-test-day and how-it-works-ui, which pass when the machine is not shared) |
| typecheck / typecheck:api / build | OK | OK |
| oxlint | warnings only | warnings only (1 new no-control-regex warning in handoff.js, intentional control-char strip) |
| verify:r31-qa | n/a | 110 / 110 |

Baseline non-passes: `verify:live-test-day` (240s runner timeout; passes 50/50 standalone in ~8m), `verify:how-it-works-ui` (CPU-load timing, passes standalone), `verify:website-demo` 115/116 (REAL bug, F9, now 116/116).
Known flake under load: `verify:agent` failed once in the L1 run on the NEON pooled-endpoint env check while other suites ran; passes standalone.

## Loop log

**Loop 1** - baseline suite + exploratory sweep (all screens x 1440/1280/800/390/360 x Office/Field; owner, office-manager and phone-tech personas; contrast, focus, targets, overflow, console). Fixed F1-F5, F9.
**Loop 2** - the two R25 should-haves that live in my files (in-app "Report a problem", browser error reporter), Billing usage meters, small layout fixes.
**Loop 3** - re-sweep after L1/L2 (0 overflow, 0 unnamed controls, 0 console errors, 0 contrast failures across all screens/viewports/themes); crashed-screen card; found and fixed a duplicate crash report (React also fires window.onerror).
**Loop 4** - keyboard pass on the new form (focus fell to `<body>` after Cancel; fixed); final full suite, typecheck, lint, build.

## Findings

| ID | Sev | Finding | Status |
|---|---|---|---|
| F1 | High | Customers tab loaded only the first 200 customers; #201+ unfindable | FIXED: pages through the whole list via `nextCursor` (cap 5,000), server-search fallback when rows are missing, honest count footer, page-failure message |
| F2 | Med | Dark theme: `text-*-ink` status colours 1.7:1 (error lines, "Empty this shop's documents" card, phone DocSheet, Expenses errors); danger button 2.9:1 | FIXED (CSS override on dark surface only, explicit `text-stone-0` on danger buttons) |
| F3 | Med | Field (light) phone: accent text 2.9-3.1:1 (active tab, "Choose photos or PDFs", links) | FIXED (`text-accent-ink`) |
| F4 | Low-Med | Desktop header wrapped "Office / view", "Sign / out", long shop names onto 2-3 lines | FIXED: account cluster icon-only with tooltips below 2xl, nowrap + truncated org name |
| F5 | Low | Phone header showed shop name truncated to "Sunris..." | FIXED: shown from 480px up; Account sheet still names the shop |
| F6 | Med | Billing "745 / 750" with no meter or nudge; ambiguous cancel date "10/9/2026" | FIXED: meters (role=meter), near-limit (>=80%) and at-limit nudge, "cancels Oct 9, 2026; you keep access until then". Label wording is an owner decision (below) |
| F7 | Med | No "Report a problem"; browser errors invisible | FIXED: `src/services/errorReporter.ts` (scrubbed ring of 10, crash auto-report max 3/page load, noise filter), `POST /api/support {action:'client-error'}` (signed-in only, 30/user/day, one log line + Sentry message if DSN, nothing stored), "Report a problem" in the help chat (desktop + phone) emailing support with a diagnostics block; crash card links to support email |
| F8 | Low | Trial banner says "1 day" for <24h left | WON'T FIX: documented round-up rule (verify-ui), "today" wording only at 0 |
| F9 | Med | Website hero demo mixed the visitor's typing with the animated text (real failing check) | FIXED |
| F10 | Low | Warranty export "Add a unit" select overflowed 222px at 390 | FIXED |
| F11 | Low | Floating Help launcher covered the last footer link on phone widths | FIXED (footer bottom padding below lg) |
| F12 | Low | Cancel/Send in the handoff form dropped keyboard focus to `<body>` | FIXED |
| F13 | Low | Records 20px overflow at 390 (desktop shell) | NOT REPRODUCIBLE after F4; sweep shows 0 overflow on every screen |
| F14 | Low | Desktop shell on phones spends ~190px on a 3-row header at 360 | OPEN (low; the phone path is /m) |
| F15 | Low | Team screen shows an install QR on a phone-width viewport (cannot scan own screen) | OPEN (low) |

## Open - owner decisions

1. **Trial-ending / payment-failed emails.** Turn on Stripe's own emails (Dashboard > Settings > Billing > Emails). Building our own needs `RESEND_API_KEY` (not set) and a `customer.subscription.trial_will_end` webhook subscription; the app already shows trial and past-due banners in-app. Not built to avoid a second, duplicate email path.
2. **"Pages this month" wording.** Pages are counted over a rolling 30 days (`countPagesSince`) while the API's `resetsOn` says the 1st of next month. Pick calendar-month or rolling and align UI + `docs/help/22-billing-screen.md` (the help KB is generated from it, so I did not relabel).
3. **Icon-only account buttons below 1536px** (Billing, Team, Donovan, Office/Field, Sign out; tooltips + aria-labels). Trade-off: discoverability vs. header stability.
4. **Fleet tile says "Choose plan"; the website says "Contact sales".** Align one way.
5. **Sentry / log drain.** `client-error` lines are structured logs; they reach Sentry only when `SENTRY_DSN` is set (R25 owner item).
6. R25 owner items unchanged (Vercel plan, Neon plan, Resend, restore drill).

## Movement counts (targets)

| Task | Target | Before | After |
|---|---|---|---|
| Warranty export | <=6 | 3 | 3 |
| Customer profile from Ask (Records > Customers > row) | <=2 clicks after Records | 3 clicks, Equipment visible without another click | same |
| Phone intake resolve | <=2 taps | 2 | 2 |
| Phone customer -> call | <=3 taps | 3 | 3 |
| Desktop customer -> call | (none) | 4 | 4 (phone number lives on the profile only; list has no phone column) |
| Report a problem (new) | - | n/a | 3 (open Help, Report a problem, Send) |

## Website + help widget (1440/390/360)
23 links, 0 dead, 0 missing anchors, 0 overflow, no console/CSP errors (only the expected dev 404 for `/_vercel/insights/script.js`). CSP `connect-src 'self'` already covers the new report endpoint. Pricing matches `PLAN_CATALOG` / `PLAN_LIMITS` (Solo $99/750 pages/2 logins, Shop $199/2,000/5, Crew $399/5,000/10, Fleet $899/10,000/unlimited). "Coming soon" pills only on unbuilt items. FAQ is native `<details>`. Terms say export/deletion is by request, consistent with the current tenant-delete state.

## Files changed
App: `src/components/AppShell.tsx`, `src/components/ScreenLoadBoundary.tsx`, `src/components/support/SupportAssistant.tsx`, `src/index.css`, `src/main.tsx`, `src/mobile/main.tsx`, `src/mobile/MobileApp.tsx`, `src/mobile/ScanTab.tsx`, `src/screens/{BillingScreen,BrowseScreen,CustomersScreen,ReviewScreen,WarrantyExportScreen}.tsx`, `src/services/{customerClient,supportClient}.ts`, new `src/services/errorReporter.ts`, `src/core/{customerPaging,usageMeter}.ts`.
API: `api/_lib/support/{route,limits,policy,handoff}.js`, new `api/_lib/support/clientError.js`.
Website: `index.html`. Harness: `scripts/app-qa-harness/{clerk-mock,main,mobile-main}.tsx`. Tests: new `scripts/verify-r31-qa.mjs`, `package.json` (`verify:r31-qa`).
No Donovan engine files touched. No git, no installs, no `.env`.
