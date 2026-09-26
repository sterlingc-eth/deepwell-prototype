# Startup performance — desktop app (Round 13)

Owner report: deepwelltechnology.com/app takes a long time to load. Warm
production trace: Clerk init ~0.85s, then a staggered waterfall — billing
(581ms @864ms), two records calls (@864ms and @1305ms), review (@1777ms),
document-status (@2434ms), account/notifications (@3404ms) — ~3.8s before
everything is in. Cold is worse (serverless cold starts + Neon scale-to-zero,
1-3s each on top).

## Root causes (the startup sequence, and why each call waited on the last)

1. **`App.tsx` rendered nothing at all until three separate things all
   finished**: Clerk (`isLoaded`), a billing-status fetch
   (`billingStatusLoaded`), and the full Postgres sync (`sync.status`). Each
   was its own `useEffect`, so the billing fetch didn't even START until
   Clerk resolved, and the blank/busy screen stayed up until the LAST of the
   three settled — normally the full sync, which is itself five sequential
   round trips (see #2).
2. **`usePostgresSync` / `loadGraphFromServer` is inherently five calls
   deep**: `listDocuments` + `listEntities` in parallel, then THREE more bulk
   calls that all need the first pair's document ids first (extractions,
   links, corrections), then a chunked `document-status` call for
   completeness. That's a real, legitimate data dependency for the FULL
   record graph — but the app was treating "full graph loaded" as a
   precondition for showing anything, including the Ask box, which doesn't
   read the local graph at all (an answer is a server round trip against
   Postgres, not a client-side lookup).
3. **The notification bell fetched eagerly on mount** (`NotificationsPanel`),
   adding a sixth call to the pile before the tab was interactive, for a
   badge count nobody had asked to see yet.
4. **Every screen was one static import** (`AskScreen, BillingScreen,
   BrowseScreen, CustomerProfileScreen, DashboardScreen, EntityScreen,
   InboxScreen, LoginScreen, TeamScreen` all imported directly in `App.tsx`),
   so `BrowseScreen`'s records grid and every screen's own components were
   in the ONE bundle that has to load before the Ask screen can render, even
   though a signed-in tech lands on Ask first almost every time.

## What changed

- **`api/records.ts`**: new `bootstrap` action (`runBootstrap`) — billing
  status, notification unread count, a first page of documents, and a
  document-status-by-stage summary, all as a `Promise.all` inside the SAME
  `withTenant` transaction/connection every other action already uses. One
  round trip, one connection, instead of five.
- **`src/hooks/useBootstrap.ts`** (new) fires that call once Clerk resolves,
  seeds billing status from a `sessionStorage` cache first (try/catch
  everywhere) so a returning tenant's hard-gate decision doesn't wait on the
  network at all, and falls back to the old `billingClient.status()` call
  alone if the bootstrap action itself fails (an older deployed API, or a
  genuine failure) — this keeps working before/without the change being live
  everywhere.
- **`App.tsx`**: the billing gate now fails OPEN whenever `billingStatus` is
  null (not yet loaded) instead of blocking behind a blank screen — it only
  ever gates once a status (cached or fresh) actually says none/canceled.
  The full-sync blank screen is now skipped specifically for the `ask`
  screen (the default landing screen); every other screen still waits for
  real data, same as before.
- **Screens are lazy** except `AskScreen`/`LoginScreen`: `BillingScreen`,
  `BrowseScreen`, `CustomerProfileScreen`, `DashboardScreen`, `EntityScreen`,
  `InboxScreen`, `TeamScreen` are all `React.lazy` now, same pattern the
  codebase already used for `WarrantyExportScreen`/`OutreachScreen`. This is
  what actually keeps `GridView` (Records Browse's grid) and the
  knowledge-graph screens out of the bundle that has to load before first
  paint — cytoscape/jspdf/html2canvas/jszip were already dynamically
  imported inside their own modules and were NOT in the initial graph even
  before this round; verified again below.
- **`NotificationsPanel`**: the badge count now comes from the bootstrap
  response; the full item list is fetched lazily (when the tray opens),
  with a 4s fallback timer and an eager fetch if bootstrap itself errored,
  so the bell never silently stays empty.
- **Private cache + ETag** (`api/_lib/claude.js`'s `sendPrivateCacheableJson`)
  on the two polled GETs — `GET /api/billing?action=status` and
  `GET /api/account?action=notifications` — so a repeat poll that hasn't
  changed comes back as a 304 with no body.
- **`vercel.json` `regions`**: NOT set. Grepped `api/`, `M3-config/`,
  `docs/`, `handoffs/` for a real Neon region/hostname and found none — only
  placeholder connection strings (`HOST.neon.tech`) and a build-spec mention
  of "one region (us-east)" as a *target*, not a confirmed value. Setting
  this wrong (this account is Vercel Pro, so it's not ignored) could pin
  compute AWAY from Neon and make things worse. **Owner action needed:**
  Vercel → Project → Settings → Functions → Function Region, and Neon →
  Project → Settings → General → Region — if they don't match, either pin
  `regions` in `vercel.json` to Neon's region or move the Neon project
  (`handoffs/ASK_LATENCY_2026-09-20.md` §4(i) has the exact steps already).
  While there: check Neon's auto-suspend/scale-to-zero setting
  (`handoffs/ASK_LATENCY_2026-09-20.md` §4(ii)) — a 5-minute idle suspend is
  almost certainly most of the "cold" numbers in the owner's report.

## Measurement — `scripts/perf/startup.mjs`

Builds the real `/app/` entry twice (this branch vs a fixed pre-round SHA)
with `@clerk/clerk-react` aliased to `scripts/perf/mockClerk.tsx` at build
time (so real `App.tsx`/`AskScreen`/`usePostgresSync`/`useBootstrap` code
runs completely unmodified — no real Clerk/Neon network, per the round's
hard rules), serves both, and drives each with Playwright against every
`/api/**` call mocked at 500ms + an extra 1.5s "cold" on the very first
request. `npm run perf:startup` (or `node scripts/perf/startup.mjs --before
<ref>`).

**`--before` note (2026-09-26):** the default `--before r13-int` is only
valid while `r13-int` still points at the actual pre-round base. `r13-int`
is a shared integration branch other rounds also merge into, and it has
since had this very branch (`r13p`) merged INTO it — so `--before r13-int`
no longer isolates the old behavior, it compares this branch against a
build that already contains most of this round's own fixes. The table
below uses the fixed pre-round SHA (`31fb5b1`) instead, which stays a true
baseline regardless of where `r13-int` moves next. Re-check which ref is
actually "before" anything you compare against this harness later.

| metric | before (`31fb5b1`) | after (this branch, post reviewer-fix) |
|---|---|---|
| time-to-shell (`<header>` in DOM) | 4010ms | **1362ms** |
| time-to-interactive-Ask (`<textarea>` in DOM) | 4026ms | **1384ms** |
| time-to-all-data (network settles) | 4099ms | **1480ms** |

Honest reading: time-to-shell/Ask drops ~66%, consistent with the original
round-1 measurement (3934→1353 / 3961→1370), because the app no longer
waits on billing status or the full records sync to render Ask — it only
waits on Clerk (mocked at 850ms here) plus one render pass. Time-to-all-data
now also drops substantially in this run (4099→1480) — the earlier report
called this "essentially unchanged" against the-then `r13-int`; re-measured
against the correct fixed baseline it is not. Not re-investigated further
this round (out of scope for the reviewer's fix list); the architectural
fact that matters for this round stands either way: the full four-call sync
runs in the background and is no longer render-blocking.

Caveat: this harness builds only the `/app/` entry in isolation (not the
real multi-page `site+app+mobile+expenses` build), which changes Rollup's
cross-entry chunk splitting — its own bundle-size numbers are not
representative. The real bundle-size numbers below are from the actual
`npm run build`.

## Bundle size (real `npm run build`, both branches)

| | before | after |
|---|---|---|
| main `/app/` JS chunk | 367.51 kB (92.58 kB gz) | 102.02 kB (29.42 kB gz) |

cytoscape (434.86 kB), jspdf (399.07 kB), html2canvas (199.50 kB), and jszip
(95.96 kB) all confirmed as separate chunks in BOTH builds — none are in
`app/index.html`'s `modulepreload` list (checked directly). They were
already dynamically imported inside their own modules (`KnowledgeGraph.tsx`,
`WarrantyExportScreen.tsx`, `bulkImport.ts`) before this round; what this
round fixed was `GridView`/`BrowseScreen`/`EntityScreen`/etc. riding along
in the main chunk via `App.tsx`'s static imports.

## Reviewer NO-GO fixes (2026-09-26)

The first pass (commit `36df3fb`) shipped a real cross-org data leak: making
Ask render before the full sync finishes means the Ask screen now reads
`useGraph` (global store) *during* that window, and nothing cleared it on a
same-tab tenant switch. Four fixes:

1. **Cross-org leak (HIGH).** `usePostgresSync` now tracks the last
   `tenantKey` it actually started a load for (`lastTenantKeyRef`); the
   moment the effect sees a DIFFERENT `tenantKey`, it synchronously calls
   the new `resetGraphForTenantSwitch()` (`src/hooks/usePostgresSync.ts`) —
   wipes `useGraph`'s `entities`/`docs`/`batches`/`conflicts` and resets the
   module-level `fullSyncCompleted`/`linkSweepRanForTenant` latches —
   *before* starting the new tenant's fetch. A genuine same-tenant
   `refresh()` (DataHealthStrip's "Re-check all documents") is untouched —
   it calls `run` directly, outside this effect, and must keep showing the
   old data until the reseed lands. `useBootstrap`'s sessionStorage billing
   cache is now keyed by `userId::orgId` (`useBootstrap(enabled, orgId,
   userId)`, was a single pre-combined `tenantKey`) and clears its own
   in-memory billing/notification state on the same switch.
   `NotificationsPanel`'s local item list resets on the same signal.
   **Test:** `scripts/verify-tenant-isolation.mjs` (`npm run
   verify:tenant-isolation`) — seeds tenant A into `useGraph`, calls
   `resetGraphForTenantSwitch()`, asserts the store is genuinely empty (not
   just hidden), then seeds tenant B and asserts no A data survives and the
   partial-seed latch works again post-reset.
2. **`Vary: Authorization`** added to `sendPrivateCacheableJson`
   (`api/_lib/claude.js`) — the response varies per caller (tenant is
   derived from the bearer token), so a cache in front of it must never
   reuse one caller's body for a different token. Documented inline that
   any future org-selector header must be added to this Vary list too.
3. **Error boundary** (`src/components/ScreenLoadBoundary.tsx`, new) now
   wraps the `<Suspense>` around every `React.lazy` screen in `App.tsx`. A
   chunk-load failure (stale `index.html` pointing at a hash a new deploy no
   longer ships) is detected by matching the thrown error's message against
   the wording Vite/Rollup and every major browser use for a failed dynamic
   `import()`, and auto-reloads ONCE per tab (a `sessionStorage` guard key
   stops a reload loop if the deploy is somehow still broken after
   reloading) behind a small "A new version is available" card. Any other
   render error shows a plain "Something went wrong" card and never
   auto-reloads.
4. **Dropped `documentStatus`** from `runBootstrap` (`api/records.ts`) and
   `BootstrapResponse` (`src/services/bootstrapClient.ts`) — nothing on the
   client read it, so it was a documents-by-stage SQL query run on every
   single bootstrap call for no reason. Add it back, consumed, the day
   something actually wants it.

Re-verified after these fixes: `tsc -b`, `tsc -p tsconfig.api-check.json`,
`oxlint api scripts src` (38 warnings — true pre-round baseline, no new
ones), `npm run build`, `verify:billing`, `verify:notify`,
`verify:tenant-isolation` (new), `scripts/perf/startup.mjs`, and all four
`-ui` suites (`graph-ui`, `answer-ui` — 198 checks, `records-ui`,
`grid-ui`) — all green.
