# Round 22 — independent adversarial review (security & privacy)

Reviewed `git diff r21-int..r22-int` against `handoffs/SECURITY_AUDIT_R22.md`,
`handoffs/PRIVACY_SUPPORT_ACCESS_R22_2026-09-28.md`, `handoffs/WEBSITE_AUDIT_R22.md`,
`../R22_CONTRACT.md`, `../R11_RULES.md`. Two real defects found and fixed; everything else in the
five-item checklist checked out.

## Findings

### H1 — Shipped CSP breaks two real, shipped app features (High, fixed)

**Evidence**: `vercel.json`'s new `frame-src` and `img-src` directives were derived from a document
read of the HTML entry points, but not checked against what the compiled React app actually does at
runtime with document previews and mobile photo capture:

- `src/components/DocumentPreview.tsx:173` renders a PDF original as `<iframe src={original.url}>`,
  where `original.url` is an R2 presigned GET (`api/_lib/r2.js`'s `presign()`, host
  `${accountId}.r2.cloudflarestorage.com`). The shipped `frame-src` was
  `https://challenges.cloudflare.com https://*.clerk.accounts.dev` — no R2 host at all. `object-src
  'none'` does not cover this (that's for `<object>`/`<embed>`, not `<iframe>`).
- `src/mobile/ScanTab.tsx:167,464` and `src/components/SerialCapture.tsx:56,121` preview a
  just-captured/selected photo via `<img src={URL.createObjectURL(file)}>` (a `blob:` URL) before
  it's ever uploaded — core to the mobile "Scan" flow. The shipped `img-src` was `'self' data:
  https:` — no `blob:`.

Verified against a real headless Chromium enforcing the actual `vercel.json` CSP (not just grepped):
a synthetic PDF iframe against an R2-shaped host was refused with `Refused to frame '...' because it
violates ... "frame-src https://challenges.cloudflare.com https://*.clerk.accounts.dev"`, and a
`blob:` image was refused with `Refused to load the image 'blob:...' because it violates ...
"img-src 'self' data: https:"`. Both are exactly the console errors a real user would hit opening a
document or taking a scan photo in production — a silent, first-load break with no server-side
signal at all (build passes, every existing test passes, only the browser console shows it).

**Fix**: `vercel.json` — added `https://*.r2.cloudflarestorage.com` to `frame-src`, and `blob:` to
`img-src`. Nothing else widened (checked for `<video>`/`<audio>`/live camera stream usage — none;
capture is a native file-input `capture="environment"`, so no `media-src` addition needed).

**Regression test**: `scripts/verify-csp-app-needs.mjs` (new, `npm run verify:csp-app-needs`) — spins
up a static server that serves the *actual* `vercel.json` CSP header, drives real Chromium through
the exact DOM operations DocumentPreview/ScanTab/SerialCapture perform, and asserts zero CSP console
violations for: blob: image preview, R2 iframe, R2 image, Clerk Frontend API fetch. (Cloudflare
Turnstile's own iframe response sets its own strict `frame-ancestors`, which fires even against a
bare `data:` page with no CSP at all — verified separately as a sandbox/site-key artifact, not
something our policy controls, so it's documented rather than asserted.)

### M1 — Subprocessor list inconsistent across the three customer-facing/internal sources (Medium, fixed)

**Evidence**: the R22 contract and `PRIVACY_SUPPORT_ACCESS_R22_2026-09-28.md`'s own coordination note
both require `docs/SECURITY.md`, `public/security.html`, and `public/privacy.html` to agree.
`docs/SECURITY.md`'s subprocessor table lists 9 providers including **Resend** ("Recipient address
and message content for the emails DeepWell sends on your behalf") and **Sentry**. `public/privacy.html`
and `public/security.html` both listed only 8 — Resend and Sentry were missing from both. Resend is
not a cosmetic omission: `api/_lib/routes/outreach.js` calls `sendEmail()` to send messages to a
tenant's own end customers (opt-out-checked outreach/warranty messages), so Resend is a real
subprocessor that receives actual customer contact data, and the owner's own stated bar here is "when
companies ask if we can see their data, we must have a defensible answer" — an incomplete
subprocessor list fails that bar directly.

**Fix**: added matching Resend and Sentry rows to `public/privacy.html`'s and `public/security.html`'s
subprocessor tables, wording aligned with `docs/SECURITY.md`'s existing language for each.

**Regression test**: rebuilt (`VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build`) and re-ran
`scripts/verify-website.mjs` clean (no overflow/console/link regressions from the new table rows). No
automated cross-file consistency check was added (a content-accuracy fact, same category
`WEBSITE_AUDIT_R22.md`'s own finding #2 used, not a runtime behavior) — verified by direct comparison
of all three tables.

## Checked, no finding

- **Support-access gating** (`api/_lib/privacy/supportAccess.js`, `api/review.js`): every
  `OPERATOR_ACTIONS` entry that reads a specific tenant's content goes through `gateSupportAccess`;
  the platform-level/aggregate exemptions are real (checked `donovan_proposals`/`donovan_learned` have
  no `tenant_id` column, and `missDigest`/`learningGapReport`/`learningAutopilotStatus` are genuinely
  cross-tenant aggregates with no per-tenant content). `ctx.tenantKey` comes only from the verified
  Clerk claim (`auth.tenantId`), never the request body — an operator can only ever act against a
  tenant whose org they're actually a Clerk member of, so the grant check can't be spoofed by a
  tenant id in the payload. Founder-tenant exemption compares the same string both sides use
  consistently. Break-glass requires a non-empty reason and always logs `is_emergency=true` — no
  silent bypass. `supportAccessGrant/Revoke/Status/Log` are gated by `requireAdmin` (org role or solo
  tenant), never `requireOperator` — a non-admin member can't grant/revoke/read their own tenant's
  grants, and (unrelated to this round) can't do it for another tenant regardless, since `ctx` is
  always the caller's own resolved tenant. Migration 58 degrades safely: every read/write function
  catches, warns once, and returns null/empty/false — `requireSupportAccess` then denies (fails
  closed) rather than 500ing, and this path is only ever reached from `OPERATOR_ACTIONS`, never from
  any ordinary tenant action, so a missing migration cannot break normal app routes. Migration 58
  itself: idempotent, FORCE RLS + tenant policy on both tables matches the established `TENANT_SQL`
  pattern used by every other migration in `M3-config/` (compared directly against `23-ask-misses.sql`).
  `scripts/verify-privacy.mjs` (115 checks, against a real Neon test DB) passes, including live
  tenant-isolation checks (shop B never sees shop A's grants/log rows).
  Checked `api/_lib/routes/expenses.js`'s operator gate too (per the task's explicit callout): it's
  DeepWell's own internal business-expense tracker (`platform_expenses`, no `tenant_id` column at
  all, module doc: "never a tenant's data and never reachable by one") — not a customer-data path, so
  no support-access gating is needed there, and none was added.
- **Sentry scrubbing** (`api/_lib/telemetry.js`): `sendDefaultPii: false` pinned; `beforeSend` drops
  `request`/`user` wholesale, redacts breadcrumb/exception message text, and re-scrubs `tags`/`extra`
  through the same allowlist; `beforeBreadcrumb` drops everything except category/type/level/timestamp
  plus a redacted message and (for fetch/xhr only) method+host. Stack trace frames, exception type,
  and route/tenant-hash context all survive, matching the "useful for debugging" requirement.
  Confirmed no log-redaction call-site swap changed behavior beyond what reaches the log (grepped
  every remaining `console.*` call site touching customer-shaped fields in `api/` — the ones outside
  the three the S2 round fixed are error-name/message-only, no raw customer content).
  One documented, not-a-regression observation: `redact.js`'s `hashForLog` is an explicitly unsalted,
  truncated SHA-256 ("not a cryptographic secret-hiding primitive... no salt-injection defense is
  claimed" — its own doc comment). For a UUID tenant/user id that's fine (unguessable input); for the
  low-entropy inputs it's also used on in `api/ask.js` (a customer surname or street-name fragment)
  and `api/_lib/email.js` (a recipient email address), an attacker with log/Sentry access and a
  candidate list (a plausible surname/address dictionary, or a guessed email) could confirm a match by
  hashing guesses — the redaction resists casual reading, not a targeted guess-and-check. Flagged as a
  residual, not fixed: it's an explicit, disclosed design tradeoff this round already made rather than
  an oversight, fixing it would mean adding a new pepper secret (operational burden, and outside this
  round's file ownership to plumb through Vercel env), and it doesn't regress anything r21 had.
- **Offline exam**: `EXAM_TODAY=2026-09-25 node scripts/offline-exam.mjs scripts/golden/golden-export.json
  /tmp/r22x.json /tmp/r22x.md` → 1220 answered-without-model / 1183 correct / 22 wrong. Exact match.
- **Website claims**: re-verified `docs/SECURITY.md`'s and both HTML pages' isolation/encryption/
  support-access/audit-log claims against the actual code paths named (`withTenant`, `r2.js`'s
  `presign()` max/default expiry, `tenant-export.js`/`tenant-delete.js`); all true as written.

## Files touched this pass

- `vercel.json` — CSP `frame-src`/`img-src` fix (H1).
- `public/privacy.html`, `public/security.html` — subprocessor table fix (M1).
- `scripts/verify-csp-app-needs.mjs` — new regression test for H1.
- `package.json` — added `verify:csp-app-needs` script (standalone, needs a browser — same convention
  as `verify:website`, not wired into `verify:all`).

## For the owner (production follow-ups, unchanged from S1's own handoff)

- Confirm Clerk's production Frontend API host: if it's a custom subdomain of deepwell's own domain
  rather than `*.clerk.accounts.dev`, add that exact host to `connect-src`/`frame-src` before launch.
- Paste `M3-config/58-support-access.sql` in Neon to enable actual support-access grants — until then,
  `gateSupportAccess` fails closed (denies every operator action against a non-founder tenant with no
  emergency reason), which is safe but means support literally cannot look at a customer's data at all
  yet, grant or no grant.
- Verify Vercel Web Analytics' beacon domain in a real deployment (`WEBSITE_AUDIT_R22.md`'s own
  open item) in case it needs a `connect-src` addition beyond `'self'`.

## Finishing checks run this pass

`npm run typecheck` clean · `VITE_CLERK_PUBLISHABLE_KEY=pk_test_dummy npm run build` clean ·
`node scripts/verify-security.mjs` all pass · `node scripts/verify-privacy.mjs` 115/115 pass ·
`node scripts/verify-website.mjs` clean · `node scripts/verify-csp-app-needs.mjs` (new) all pass ·
offline exam exact match (1220/1183/22). Did not run `npm run verify:all` (already running in the
background per instructions) or `npm install`/touch `node_modules`.
