# Website security & bug audit — Round 22 (S3)

Scope: `index.html` + every marketing/static page under `public/**` (NOT `public/m/**` app
logic) — `404.html`, `privacy.html`, `terms.html`, `security.html` (new), `expense-tracker.html`,
`get/`, `industries/*.html`, `samples/*`, `sitemap.xml`, `robots.txt`, `site.webmanifest`.

Method: `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build`, served `dist/` locally with a
plain Node static server, Playwright-crawled every owned page at 390px and 1440px (see
`scripts/verify-website.mjs`), plus manual source review for scripts/styles/forms/claims. Screenshots
saved and reviewed for every page/viewport during the audit.

## Findings

### 1. [Medium] Horizontal scroll on mobile — all 4 industries pages
- **Evidence**: at 390px, `document.documentElement.scrollWidth` (425px) > `clientWidth` (390px) on
  `public/industries/{hvac,electrical,plumbing,property-management}.html`. Root cause: the footer's
  link row (`Problem Platform Plans People Contact Privacy Terms`) is seven `<a>` tags written back-to-back
  with **no whitespace between the tags** in the HTML source, and `footer a{margin-left:16px}` was the
  only layout rule — inline boxes with no space/newline between them have no line-break opportunity at
  that boundary, so the row can't wrap and forces the footer (and the page) wider than the viewport.
  `index.html`'s own footer already carries the fix for this same pattern
  (`footer .wrap>div:last-child{display:flex;flex-wrap:wrap;gap:8px 18px;min-width:0}`) — the industries
  pages just didn't have it.
- **Fix**: added the same `footer .wrap>div:last-child` flex-wrap rule to all four industries pages
  (`public/industries/*.html`) and to `public/get/index.html` (same anti-pattern present, not yet
  overflowing at 390px only because its link list is shorter — hardened defensively before it grows).
- **Regression test**: `scripts/verify-website.mjs` fails on any 390px page whose `scrollWidth >
  clientWidth`; this is now checked on every owned page including the new `security.html`.

### 2. [Medium/Low, privacy accuracy] Subprocessor list was missing two real data processors
- **Evidence**: `api/_lib/search/embed.js` sends chunk/query text to `https://api.voyageai.com/v1/embeddings`
  whenever `VOYAGE_API_KEY` is set (semantic search/rerank), and `api/_lib/queue.js` sends
  `{documentId, tenantKey, tenantName, userId}` to Inngest for background ingestion — neither Voyage AI
  nor Inngest appeared in `privacy.html`'s subprocessor table, which listed only Cloudflare, Neon, Clerk,
  Anthropic, Vercel and Stripe. Given the owner's explicit ask ("when companies ask can you see our
  data/files, we must have a defensible answer"), an incomplete subprocessor list is exactly the kind of
  gap that answer would fail on.
- **Fix**: added Voyage AI and Inngest rows to `public/privacy.html`'s subprocessor table and to the new
  `public/security.html` table (with an explicit "sees document content?" column so the defensible-answer
  question is answered directly), and updated the "AI processing" paragraph to name both AI providers
  instead of only Anthropic.
- **Regression test**: none automatable (a content-accuracy fact, not a runtime behavior) — verified
  by reading `api/_lib/search/embed.js`, `api/_lib/search/rerank.js`, and `api/_lib/queue.js` directly.

### 3. [Low] Demo "Ask" box error path escapes `<` but not other HTML metacharacters
- **Evidence**: `index.html`, the `/#ask` demo submit handler: `` `...matches "${q.replace(/</g,'&lt;')}"...` ``
  assigned via `innerHTML`. Only `<` is escaped; `&`, `>`, quotes are not. In this exact context (plain
  text node inside a `<p>`, not inside a quoted attribute) that's not exploitable — no `<` means no new
  tag can open — and the whole widget is 100% client-side with no network call and no other viewer, so
  there's no privilege boundary to cross even in the worst case. Flagged for completeness per the audit
  brief's "any user-controlled content rendering" item, not because it's a real vulnerability.
- **Fix**: not changed (no behavior risk to justify touching a working, hand-tuned demo script); noted
  here so it isn't rediscovered as a false "XSS" in a future round. If touched again, prefer building the
  text with `textContent`/`createElement` over string-concatenated `innerHTML`.

### 4. [Informational] Local-build-only noise, not real bugs
- `/_vercel/insights/script.js` 404s in every local `dist/` build and in this round's Playwright crawl —
  Vercel injects this script only at its production edge; it does not exist in the repo or in any local
  build. Not fixable locally, not present in production. Allowlisted by name in
  `scripts/verify-website.mjs` so it never fails the crawl.
- `public/expense-tracker.html` → redirects to `/expenses/` (a different Vite entry, app logic, not
  S3-owned) → that app throws a Clerk "invalid publishableKey" console error when built with the
  contract's required dummy test key (`pk_test_dummy`). Expected with a fake key; not a marketing-page
  bug. Allowlisted by message in the verify script.
- A scroll-reveal false alarm during my own investigation: a naive Playwright `fullPage` screenshot taken
  right after `page.goto` can capture the 4 pricing cards mid-CSS-transition (opacity still 0), looking
  like a rendering bug. Under an actual incremental scroll (simulating a real visitor) the cards reveal
  correctly every time — confirmed by instrumenting the page's own `IntersectionObserver`. Not a bug;
  `scripts/verify-website.mjs` screenshots with `reducedMotion: 'reduce'` so this can't recur as a false
  positive in this round's screenshots.

## Verified clean (no fix needed)
- **No 404s / broken links or assets** across every owned page at both viewports (`scripts/verify-website.mjs`).
- **No console errors** (real ones — see the two known-noise exceptions above).
- **No mixed content**: only external origins anywhere in owned pages are `fonts.googleapis.com` /
  `fonts.gstatic.com` (Google Fonts) — everything else is same-origin, all over HTTPS.
- **No `target="_blank"`** anywhere in owned pages, so no `rel="noopener"` gap to begin with.
- **No inline event-handler attributes** (`onclick=`, etc.) anywhere — all JS is `addEventListener` in
  `<script>` blocks; no `eval`/`new Function`; no `data:` URIs.
- **No secrets/keys** in any owned static file (checked for `sk-`, `pk_live_`, AWS key patterns, etc.);
  `public/samples/*` contain only obviously-synthetic demo data (555-prefixed fake phone numbers,
  fictional names/addresses) used nowhere by the actual app code — orphaned but harmless.
- **Forms**: the only `<form>` in owned pages is `index.html`'s `#ask` demo search box — client-side only,
  `preventDefault()`, no network request, no PII ever leaves the browser. No spam-protection concern since
  nothing is submitted anywhere.
- **Meta tags**: title/description/OG/canonical present and page-specific on every real page (verified by
  the crawl); `404.html` and the `expense-tracker.html` redirect stub are intentionally minimal/noindexed.
- **Pricing consistency**: `index.html`'s `#plans` prices ($99/$199/$399/$899) match
  `api/_lib/billing.js`'s `PLAN_CATALOG` exactly (Solo/Shop/Crew/Fleet monthly amounts); the cost
  calculator's `PLAN_PRICE = 199` matches the Shop tier it's compared against.
- **Security/privacy claims**: cross-checked against the actual codebase — FORCE RLS tenant isolation
  (`withTenant`, `M3-config/01-create-schema.sql`'s `audit_log` + tenant policies), R2 presigned URLs with
  a bounded expiry (`api/_lib/r2.js`'s `presign()`, max 7 days, default 900s), self-service export/delete
  (`api/_lib/routes/tenant-export.js` / `tenant-delete.js`, admin-gated, wired into `src/screens/TeamScreen.tsx`),
  and the long-standing `audit_log` table. All now true today.
- **sitemap.xml / robots.txt**: sitemap is well-formed XML; every URL in it resolves; `robots.txt` allows
  `/` and disallows `/app` and `/api` (unchanged — correct).
- **Favicon/manifest**: `site.webmanifest` icons (`favicon.svg`, `apple-touch-icon.png`) both exist.

## New: `/security.html` (Security & Privacy page)
Added per the contract: plain-language page covering per-tenant isolation, encryption via our
providers, short-lived signed file links, a "support access is yours to grant" section (customer-controlled
support access + activity logging), audit logs, self-service export/delete, AI processing & no-training
language (now covering both Anthropic and Voyage), and the corrected subprocessor table. Linked from
`index.html`'s footer, `privacy.html`'s and `terms.html`'s footers, and inline from `privacy.html`'s
"Security" section; added to `public/sitemap.xml`.

**Coordination note for the lead / S2**: the "Support access is yours to grant" + "Audit logs" sections
describe the customer-controlled support-access grants + staff access log the contract says S2 is
building this round (`api/_lib/privacy/**`). That code isn't visible from this worktree. The wording is
deliberately capability-level (no specific UI path/route named) so it stays true regardless of exact
implementation, but if that feature does **not** ship this round, these two sections need to be softened
(e.g. "we're rolling this out" future tense) before merge — please re-check against the merged S2 branch.

## S1 coordination: CSP needs of the marketing pages
`vercel.json` currently has no `Content-Security-Policy` header (only HSTS/X-Content-Type-Options/
Referrer-Policy/X-Frame-Options/Permissions-Policy). Whatever CSP S1 adds must allow, for every page in
S3's scope:
- `script-src`: `'self'` + `'unsafe-inline'` (every page's interactive bits — nav dropdown, demo Ask box,
  cost calculator, scroll-reveal — are inline `<script>` blocks, not external files; no `eval`/`Function`
  is used anywhere so a stricter policy is possible later only via a nonce/hash migration, which is a
  bigger lift than this round).
- `style-src`: `'self'` + `'unsafe-inline'` (all CSS is inline `<style>` in `<head>`) + `https://fonts.googleapis.com`.
- `font-src`: `https://fonts.gstatic.com`.
- `img-src`: `'self'` (no external images, no `data:` URIs anywhere in owned pages).
- `connect-src`: `'self'` at minimum — Vercel's injected Web Analytics beacon (`/_vercel/insights/script.js`)
  posts through Vercel's edge; if it turns out to hit a separate domain (e.g. `vitals.vercel-insights.com`)
  in production, that domain needs adding — worth a quick check against a real deployment before locking
  `connect-src` down.
- `frame-ancestors 'self'` (already effectively enforced via `X-Frame-Options: SAMEORIGIN`; keep both).
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` are all safe (no plugins/embeds; the one
  form never actually submits anywhere).
- SRI: **not applied** to the Google Fonts `<link>` — Google's `css2` endpoint serves different bytes per
  requesting User-Agent (different font formats/subsets), so a fixed SRI hash would break for a large slice
  of browsers. This is Google's own documented reason SRI isn't offered for that endpoint. If SRI on a CDN
  asset is a hard requirement, the alternative is self-hosting the font files (out of scope for this round).

## Files changed
- `public/industries/{hvac,electrical,plumbing,property-management}.html` — footer overflow fix + Security
  footer link.
- `public/get/index.html` — same footer hardening (defensive, not yet broken).
- `public/privacy.html` — added Voyage AI + Inngest to subprocessor table, updated AI-processing paragraph,
  added Security footer link + inline cross-link, footer overflow hardening.
- `public/terms.html` — added Security footer link, footer overflow hardening.
- `index.html` — added Security footer link.
- `public/security.html` — **new** Security & Privacy page.
- `public/sitemap.xml` — added `/security.html`.
- `scripts/verify-website.mjs` — **new** Playwright crawl (see script header for exactly what it checks).
- `package.json` — added `verify:website` script (not in `verify:all`, per the `*-ui` convention — needs a
  browser).

## Finishing checklist run this round
- `npm run typecheck` — clean.
- `npm run typecheck:api` — clean.
- `npx oxlint api scripts src` — 33 warnings, identical to baseline (none introduced; one `no-unused-vars`
  I introduced in a draft of `verify-website.mjs` was fixed before this count).
- `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build` — clean.
- `npm run verify:website` — clean (see script for what's covered).
- No `api/` or `src/` files were touched this round (this is a pure `public/**` + `index.html` +
  `package.json`-script-entry + new-script change), so the model/agent/scorecard/graph/etc. verify suite
  and the offline exam are unaffected by anything in this diff.
