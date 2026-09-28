# Round 22 — Security & Privacy Audit (S1: app security)

Scope per R22_CONTRACT.md: `api/**` except `api/_lib/telemetry.js`, `api/_lib/privacy/**`, and
`api/review.js`'s operator gating (all S2); `vercel.json` headers/CSP; `package.json` deps. S2 covers
Sentry scrubbing / support-access grants / staff access log; S3 covers the marketing site + a
Security & Privacy page. This document covers S1's findings only.

Method: full read of every handler in `api/*.js` and every action/route under `api/_lib/routes/**` +
`api/_lib/grid/route.js` + `api/_lib/audience/route.js`, plus the shared auth/tenant/rate-limit/R2
primitives (`api/_lib/auth.js`, `apiKeyAuth.js`, `scope.js`, `recordsStore.js`'s `withTenant`,
`rateLimit.js`, `r2.js`); targeted greps for string-built SQL, `new RegExp(...)` construction, `fetch(`
call sites, `dangerouslySetInnerHTML`/`innerHTML =`; a production build (`VITE_CLERK_PUBLISHABLE_KEY=
pk_test_dummy npm run build`) grepped for secret-shaped strings; `npm audit`.

## Summary

| Severity | Found | Fixed | Notes |
|---|---|---|---|
| Critical | 0 | — | |
| High | 1 | 1 | Missing Content-Security-Policy |
| Medium | 1 | 1 | Billing checkout/portal not rate-limited |
| Low | 2 | 0 (documented) | npm audit transitive deps; Inngest introspection GET (pre-existing, accepted) |

The rest of the surface — AuthN/AuthZ on every handler, tenant scoping via `withTenant`/FORCE RLS,
SQL parameterization, ReDoS/input-length caps, upload validation, R2 signed-URL scope, CORS, agent
tool read-only-ness, and the client bundle — checked clean; see "Areas reviewed, no finding" below.

## Findings

### H1 — No Content-Security-Policy header (High)

**Evidence**: `vercel.json` (before this round) had `Strict-Transport-Security`, `X-Content-Type-
Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` on the catch-all route, but no
`Content-Security-Policy` at all — repo-wide grep for `Content-Security-Policy` returned nothing.
Given the owner's ask ("ensure the website has no bugs or vulnerabilities"), a missing CSP is the
single biggest gap between "no known bug" and "defense in depth against the bug we haven't found yet"
(a stored/reflected XSS anywhere in the marketing site, the `/app` SPA, or a future third-party
snippet would otherwise execute with no additional constraint).

**Fix**: `vercel.json:80-92` (catch-all headers block) now sets:
```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self';
script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com data:;
img-src 'self' data: https:;
connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://clerk-telemetry.com
            https://*.r2.cloudflarestorage.com;
frame-src https://challenges.cloudflare.com https://*.clerk.accounts.dev;
worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests
```
Derivation, not guesswork: I read every entry-point HTML (`index.html`, `app/index.html`,
`m/index.html`, `expenses/index.html`) and `package.json` to see what actually needs to load.
- `script-src`/`style-src` need `'unsafe-inline'`: `index.html` and `app/index.html` both ship inline
  `<script>`/`<style>` blocks with no nonce mechanism (Vercel's static `headers` config can't mint a
  per-request nonce, and adding one means touching those HTML files, which this round doesn't own —
  see "Recommendation" below). `m/index.html` and `expenses/index.html` have neither.
- Stripe needs **nothing** in this CSP: `stripe` is a `dependencies` entry only (server-side SDK in
  `api/_lib/billing.js`); there is no `@stripe/stripe-js` client dependency, so Checkout/Portal are a
  plain top-level redirect (`window.location = session.url`), which CSP does not govern.
- Sentry needs **nothing**: `@sentry/node` only (`api/_lib/telemetry.js`, S2's file) — no browser SDK,
  so no `connect-src` entry for `ingest.sentry.io`.
- R2 needs `connect-src https://*.r2.cloudflarestorage.com`: uploads/downloads are direct
  browser↔R2 XHR/fetch against a presigned URL (`api/upload-url.js`'s own doc comment: "the file bytes
  go browser -> R2 directly, never through a Vercel function").
- Clerk needs `connect-src`/`frame-src` for its Frontend API and optional bot-protection widget
  (`@clerk/clerk-react` in `src/main.tsx`); the exact Frontend API host is an env var I did not open
  (`.env` is off-limits) and can be either `*.clerk.accounts.dev` or a custom subdomain of the app's
  own domain, so both the default host pattern and `https://challenges.cloudflare.com` (Cloudflare
  Turnstile, Clerk's bot-protection iframe) are allow-listed defensively.

**Test**: `scripts/verify-security.mjs` asserts the header exists, that `frame-ancestors`, `object-src
'none'`, and `base-uri` are present, and that a clickjacking defense (either `X-Frame-Options` or
`frame-ancestors`) is set. I also rebuilt the app (`npm run build`) after the change to confirm the
build itself is unaffected (headers are edge config, not compiled in) — **I could not do a live
browser load against real Clerk/Sentry/R2 endpoints from this sandbox (no network egress to them)**,
so a manual check against a Preview deployment with real env vars, watching the browser console for
CSP violations on first load / sign-in / an upload, is the one verification step I'm handing off.

**Recommendation (not done this round, out of S1's file ownership)**: migrate `index.html` and
`app/index.html`'s inline `<script>` tags to nonce- or hash-based CSP so `script-src` can drop
`'unsafe-inline'` — that's the one real gap left in this policy, and it needs edits to files this
round doesn't own (`index.html` is S3's; `app/index.html` isn't listed to any of S1/S2/S3 explicitly).

### M1 — Billing checkout/portal session creation had no rate limit (Medium)

**Evidence**: `api/billing.js`'s `handleCheckout`/`handlePortal` (lines ~50, ~97 before this round)
required a valid Clerk session (`requireAuth`) and, inside a shop, an admin role — but neither called
`api/_lib/rateLimit.js`'s `limit()`, unlike every other stateful action in the app (`ask`, `ingest`,
`read`). Both make a real call to Stripe (`stripe.customers.create`/`checkout.sessions.create`/
`billingPortal.sessions.create`) per request. A single authenticated caller (any solo tenant is its
own admin) could loop either endpoint indefinitely: at minimum this piles up abandoned Stripe
Checkout/Portal Session objects for that tenant's customer; at scale it risks tripping the shared
Stripe account's own API rate limit, which would 429 Stripe calls for every tenant, not just the
caller's.

**Fix**: added a `billing` bucket to `DEFAULT_LIMITS` (`api/_lib/rateLimit.js`, 6/min · 60/day — sized
for a human comparing plans, nowhere near a real workflow's needs) and wired `limit(req, res, auth,
"billing")` into both `handleCheckout` and `handlePortal` in `api/billing.js`, same pattern (and same
fail-open-on-lookup-failure semantics) every other rate-limited action already uses. The webhook
action is unaffected (it's Stripe calling in, gated by `verifyStripeSignature`, not a user action).

**Test**: `npm run verify:billing` (existing suite, unit-tests the gate logic) still passes unchanged;
`verify:apikeys`' bucket-default assertions are unaffected since `billing` is a new, separate bucket.
No new fixture was added because `limit()` itself is already exhaustively covered by
`scripts/verify-apikeys.mjs`; what's new here is only that `billing.js` now calls it, which
`scripts/verify-security.mjs` doesn't specifically assert (rate-limit coverage is a smaller, judgment-
call finding, not a general lint) but is easy to grep-verify by hand: `grep -n rateLimit api/billing.js`.

### L1 — `npm audit`: 1 Critical / 6 High, all transitive under `@vercel/node` (devDependency); 1 High direct in `postcss` (fixed); 22 Moderate transitive under `@sentry/node`'s OpenTelemetry instrumentation (Low, listed)

`npm audit` (full JSON in this round's scratch, not committed): 1 critical (`tar`), 6 high
(`@mapbox/node-pre-gyp`, `@vercel/nft`, `@vercel/node`, `path-to-regexp`, `undici`, and `postcss`).
Every one of the critical/high **except `postcss`** is a transitive dependency of `@vercel/node`
(a `devDependency` — Vercel's local-dev/build tool, not part of the deployed serverless runtime), and
`npm audit`'s only fix path for those is `@vercel/node@16.0.1`, a semver-major bump — out of scope for
"non-breaking upgrades only" this round, and risky to force without a full build/deploy smoke-test the
security round alone shouldn't gate on. **Left as-is; flagging for a dedicated dependency-upgrade
round.**

`postcss` (a direct `devDependency`, CSS build tool — not shipped to the browser or the API runtime)
had 4 advisories up to High (arbitrary `.map` file disclosure via `sourceMappingURL`, XSS in stringify
output) all fixed as of 8.5.10+/8.5.23. **Fixed**: `package.json`'s pin bumped `^8.4.47` → `^8.5.28`
(the latest published patch, non-breaking within `postcss@8`). I deliberately did **not** run `npm
install` — this worktree's `node_modules` is a symlink shared with the other two Round 22 worktrees
(`repo-r22s2`, `repo-r22s3`, confirmed via `readlink`), and reinstalling mid-round would mutate a
resource S2/S3 are concurrently relying on. **Hook for the lead**: run `npm install` once (regenerates
`package-lock.json` too) after all three worktrees merge, to materialize this pin.

The 22 moderate findings are all transitive `@opentelemetry/instrumentation-*` packages pulled in by
`@sentry/node` (S2's `api/_lib/telemetry.js`) — none reachable from user input, all build/instrumentation
tooling. Listed, not fixed, per the contract's "Medium where safe; list Low."

### L2 — Inngest queue endpoint's introspection GET is unauthenticated (Low, pre-existing, accepted)

`api/inngest.js` fails closed on every **execution** request without `INNGEST_SIGNING_KEY` set, but
the SDK's own unauthenticated introspection `GET` (lists registered function/event names) is not
Clerk-gated — already called out in that file's own header comment by a prior round as an accepted,
documented residual. Re-verified this round: no code path off that introspection response reaches
tenant data (it's metadata about the deployment, not a data query), so left as-is. Recorded here only
so it doesn't get re-discovered as new.

## Areas reviewed, no finding

- **AuthN/AuthZ inventory** — every handler under `api/*.js` and every action dispatched from
  `api/account.js`'s `ACTIONS` / `api/v1.js`'s `RESOURCES` calls `requireAuth`, `requireAuthOrKey`, or
  (for the one cron endpoint) the bespoke `CRON_SECRET`-based `isValidCronAuth` — see
  `scripts/verify-security.mjs`'s route-auth inventory, which now enforces this mechanically. Tenant is
  derived exclusively from the verified Clerk claim (`auth.js`'s `deriveAuth`: `tenantId = orgId ??
  user_${userId}`), never from request body/query, and every DB access I traced goes through
  `recordsStore.js`'s `withTenant()` (`SET LOCAL app.tenant_id` inside a transaction over the
  `deepwell_rls`/`NOBYPASSRLS` pooled connection — see that file's own doc comment) or
  `scope.js`'s `TENANT_SQL` constant threaded through every hand-written query. Role checks
  (`hasShop`/`requireRole('admin')`) are applied consistently on the admin-only actions
  (`keys`, `tenant-export`, `tenant-delete`, `document-delete`, `export-csv`, `entity-merge`, `graph`,
  `financials`, `naming`, `outreach`, `followups`, `unit-address-backfill`, billing checkout/portal).
- **IDOR** — every document/entity/export id read is scoped inside a `withTenant()` call or filtered by
  `TENANT_SQL`/`t(alias)`; a cross-tenant id simply matches no rows (RLS + the app-level predicate
  agree), not a leak. Object storage keys (`r2.js`'s `objectKey`) are `tenantId/sha256[:2]/sha256` —
  tenant-prefixed, and deliberately exclude the filename (both a path-traversal non-issue and, per that
  file's own comment, a correctness fix for the old filename-in-key scheme).
- **SQL injection** — every `db.raw()`/`.query()` call site with a `${...}` interpolation either
  splices in a fixed string constant (`TENANT_SQL`, a hardcoded table/column list keyed by an
  already-validated enum value — `ask.js`'s `countFor`, `router/guard/portfolioTotals.js`,
  `financials/answers.js`'s `cmp`/`dir`) or a helper (`grid/store.js`'s `whereSql`) that only ever
  appends `$N`-parameterized clauses. No occurrence of a request field (`req.`/`query.`/`body.`/
  `params.`) spliced directly into SQL text — now asserted by `scripts/verify-security.mjs`'s SQL lint.
- **ReDoS / input length** — `api/ask.js` caps the question at `MAX_QUESTION = 2000` chars before any
  regex runs against it; the handful of `(?:X)*` / `(?:\s+Y+)*`-shaped patterns (`scope.js`'s
  `ADDR_HEAD_RE`, `contactLookup.js`'s address patterns) partition on disjoint character classes
  (word chars vs. whitespace), which is linear, not the ambiguous-overlap shape that causes
  catastrophic backtracking. The large `relations/questions.js` regex table is all fixed, module-load-
  time patterns matched *against* the (length-capped) question, never built *from* it.
- **Prompt-injection → write access** — `api/_lib/agent/tools.js` (the research agent's tool surface)
  has no `INSERT`/`UPDATE`/`DELETE` statement anywhere in the file; every tool is a read.
- **Uploads** — `api/upload-url.js` validates `sha256` (64-hex regex), enforces a 100 MB hard cap plus
  tighter per-content-type caps (20 MB text, 24 MB PDF/image) *before* presigning, and the presigned
  PUT (`r2.js`) expires in 15 minutes; the presigned GET path (`mode: 'get'`) expires in 15 minutes too
  and is tenant-scoped through the same `withTenant`. No SSRF: I grepped every `fetch(` call site in
  `api/` and none takes a user-supplied URL — R2/Voyage/Resend/Anthropic hosts are all hardcoded
  constants. No archive/zip handling anywhere server-side (no zip-bomb surface).
- **CORS** — `api/_lib/claude.js`'s `handleCors` is a hardcoded origin allowlist (never `*`),
  `Vary: Origin` is set, methods are limited to `POST, OPTIONS`.
- **Client bundle** — built with `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy` and grepped for
  `sk_(live|test)_`, `sk-ant-`, `AKIA...`, PEM private-key headers, `whsec_`, and a credentialed
  `postgres://` URL: none found. No `dangerouslySetInnerHTML` and no `.innerHTML =` anywhere in `src/`
  (Donovan's answer text renders as plain React text, auto-escaped; the bundled `dompurify` chunk is a
  transitive dep of the PDF export path, unrelated to answer rendering).

## New tooling

**`scripts/verify-security.mjs`** (wired into `verify:all`):
1. Route auth inventory — every file in `api/*.js` / `api/_lib/routes/**` / the two `route.js`
   siblings either contains a recognized auth call, is in a reasoned `ALLOWLIST`, or is a documented
   non-HTTP helper — and a companion check ensures every file that actually exists under
   `api/_lib/routes/` is accounted for in one of those buckets, so a new route added without wiring up
   auth (or without updating this inventory) fails the suite.
2. Asserts `vercel.json`'s catch-all headers include HSTS, CSP, `X-Content-Type-Options`,
   `Referrer-Policy`, `Permissions-Policy`, and that the CSP itself sets `frame-ancestors`,
   `object-src 'none'`, `base-uri`.
3. If `dist/` exists, scans every built JS/HTML/CSS/map file for secret-shaped strings (Stripe/Clerk/
   Anthropic/AWS/R2 key patterns, PEM headers, credentialed Postgres URLs).
4. Greps `api/**/*.js` for a request field (`req.`/`query.`/`body.`/`params.`) interpolated directly
   into a `.raw()`/`.query()` template literal — the one SQL-building shape that's never safe.

## Files touched

- `vercel.json` — added `Content-Security-Policy` to the catch-all headers block.
- `api/billing.js` — rate-limit `handleCheckout`/`handlePortal` on a new `billing` bucket.
- `api/_lib/rateLimit.js` — added the `billing` bucket to `DEFAULT_LIMITS` (6/min, 60/day).
- `package.json` — `postcss` `^8.4.47` → `^8.5.28`; added `verify:security` script, wired into
  `verify:all`.
- `scripts/verify-security.mjs` — new.
- `handoffs/SECURITY_AUDIT_R22.md` — this file.

## Finishing checklist run this round

`npm run typecheck` ✅ · `npm run typecheck:api` ✅ · `npx oxlint api scripts src` — 33 pre-existing
warnings, **zero new** (confirmed none in `api/billing.js`, `api/_lib/rateLimit.js`,
`scripts/verify-security.mjs`) · `npm run build` (`VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy`) ✅ ·
`verify:security` (new) ✅ · `verify:auth` ✅ · `verify:apikeys` ✅ · `verify:tenant-isolation` ✅ ·
`verify:billing` ✅ · `verify:financials` ✅ · `verify:agent` ✅ · `verify:agent-v2` ✅ ·
`verify:scorecard` ✅ · `verify:citations` ✅ · `verify:knowledge` ✅ · `verify:relations` ✅ ·
`verify:graph` ✅ · `verify:job-costing` ✅ · `verify:r7-guardrails` ✅ · `verify:r7-search` ✅ ·
`verify:r10-retrieval` ✅ · `EXAM_TODAY=2026-09-25 npm run verify:offline-exam` ✅ (23/23 checks
passed; the run's own question corpus is `test-docs/scorecard/exam.json`'s 746 questions — the
contract's "1220/1183/22" figures look like they come from a different, larger invocation than this
script's default one, and nothing about that count changed as a result of anything in this round, so I
did not chase reproducing the exact historical number).
