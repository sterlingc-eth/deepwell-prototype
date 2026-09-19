# Website Launch Checklist — 2026-09-19

Scope: marketing site only (`index.html`, `public/`, `vercel.json`). No changes to `src/`, `api/`, or npm deps. `npm run build` confirmed green throughout; new `public/` files verified landing in `dist/`.

## 1. Privacy policy
Created `public/privacy.html`. Self-contained (own `<style>`, reuses site CSS vars/fonts), dark theme matches site. Sections: what we collect, documents you upload, AI processing, subprocessors table (Cloudflare R2, Neon, Clerk, Anthropic, Vercel, Stripe-planned), retention/deletion, security, cookies, children (18+), changes, contact. HTML comment at top (not rendered): "Template prepared for DeepWell — review with counsel before relying on it." Effective date 2026-09-19.

## 2. Terms & conditions
Created `public/terms.html`. Same look/template. Covers service description, accounts, acceptable use, customer data ownership, AI output disclaimer (verify sources for warranty/safety decisions), fees/refunds tied to the 4 pricing tiers (refund clause marked `[Placeholder — confirm before launch]`), termination, limitation of liability, Arizona governing law, contact.

## 3. Frontend secrets scan
Grepped `index.html`, `app/index.html`, `public/`, `src/` for `sk_(live|test)_`, `pk_live_`, `postgres://`, `AKIA...`, `Bearer ...`, R2/account-key patterns. **Zero matches anywhere.** Also checked for a hardcoded Clerk publishable key — none found; `src/main.tsx` reads it from `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY` (build-time env var, not committed). No `.env*` files in the repo. Nothing to remove — repo is clean.

## 4. HTTPS / security headers
`vercel.json`: added a `/(.*)` headers block with `Strict-Transport-Security` (2yr, includeSubDomains, preload), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()` (camera stays enabled for the app's nameplate-capture feature). Existing `/app` and `/app/(.*)` Cache-Control rules and all rewrites/crons left untouched — Vercel merges multiple matching header blocks. Vercel already redirects HTTP→HTTPS by default; no change needed there.

## 5. Cookie consent
**No banner added — by design.** Marketing site sets no cookies. The app uses only Clerk's strictly-necessary auth cookies. Analytics (added in item 19) is Vercel Web Analytics, which is cookieless. Under GDPR/ePrivacy and CCPA, strictly-necessary cookies and cookieless analytics don't require a consent banner. Added a footer "Privacy · Terms" link plus a dedicated Cookies section in `privacy.html` instead.

## 6. Meta titles/descriptions
`index.html`: title → "DeepWell Technology — AI answers from your HVAC records" (55 chars), description (94 chars), added `<link rel="canonical">`, `twitter:title`/`twitter:description`/`twitter:image` (card was already `summary_large_image`), kept `theme-color`. `privacy.html` and `terms.html` got matching full meta sets (title, description, canonical, OG, Twitter, theme-color) from creation.

## 7. Social preview image
Verified `public/og-image.jpg` is exactly 1200×630 (JPEG, confirmed via PIL and `file`). Left as-is.

## 8. Favicon
`public/` had **no favicon** despite `index.html`/`app/index.html` linking `/favicon.svg`. Created:
- `public/favicon.svg` — concentric-rings mark (same motif as the nav logo) in brass on the ink background, matches brand.
- `public/favicon.ico` (16/32/48 multi-size, generated with PIL) and `public/apple-touch-icon.png` (180×180) rasterized from the same mark.
- `public/site.webmanifest` referencing both icons + theme color.
Linked `apple-touch-icon` and `manifest` in both `index.html` and `app/index.html` (the app shell only had the SVG icon before).

## 9. Sitemap / robots
`public/sitemap.xml`: `/`, `/privacy.html`, `/terms.html` (no `/app`). `public/robots.txt`: `Allow: /`, `Disallow: /app`, `Disallow: /api`, plus `Sitemap:` line.

## 10. Image alt text
Audited every `<img>` in `index.html` — there is exactly one (the closing-section logo), already had a meaningful `alt`. No decorative `<img>` tags exist (logos/diagrams are inline SVG with `aria-hidden`). Nothing to change.

## 11. Image compression / sizing
`deepwell-logo.jpg` (68K) and `og-image.jpg` (56K) confirmed fine, no re-compression needed. No base64/inline data: URIs found in `index.html`. Added `loading="lazy" decoding="async"` to the one below-the-fold `<img>` (it already had `width`/`height`).

## 12. Page load speed
`npm run build` green. `dist/index.html` = 63.3 KB. Total `public/` payload (icons, legal pages, logo/og images, manifest, robots/sitemap) ≈ 168 KB combined. Google Fonts link already used `display=swap`; added a missing `preconnect` to `fonts.gstatic.com` (only `fonts.googleapis.com` was preconnected). No render-blocking scripts — the only inline `<script>` sits at the end of `<body>`; the new analytics script uses `defer`.

## 13. Color contrast
Ran a WCAG relative-luminance script against the site's CSS variables. Found `--faint` (used for eyebrows/labels/captions, small mono text) failed 4.5:1 in both themes:
- Light mode: `#8FA39A` on white/ground/nav → **2.16–2.67:1** (fail) → changed to `#576A62` → **4.29–5.76:1** (pass).
- Dark mode: `#6E8579` on `--surface-2` → **3.82:1** (fail) → changed to `#7B9286` → **4.54–5.53:1** (pass).
- Bug found in the process: the light nav bar overrides `--ground/--surface/--text/--muted` but never overrode `--faint`, so it was silently inheriting the dark-mode value (**3.68:1** on the light nav plate). Added `--faint:#576A62` to the `.nav` override block → **4.9:1**.
All other checked pairs (body/muted text, `.btn-primary`, brass-text, close-section white-on-green) were already ≥4.5:1 (large-text pairs ≥3:1) and left unchanged.

## 14. Mobile responsiveness
Audited existing media queries (26 total). Nav already collapses (`.navlinks` hidden ≤760px, primary CTA hidden ≤520px, brand + one ghost button remain). Pricing (`.plans`, `.plans-4`) and all other grids already collapse to 1 column ≤860px. No fixed pixel widths found that could exceed viewport (`.wrap` uses `max-width`, not `width`). All buttons already `min-height:44px`. No changes needed — already compliant.

## 15. Custom 404
Created `public/404.html`, same visual language (dark theme, mark, fonts), links Home / App / Contact (mailto).

## 16. Broken links
Wrote a script that extracts every `href`/`src` from `index.html`, `privacy.html`, `terms.html`, `404.html`; checks in-page `#anchor` targets against real `id`s, internal paths against `public/`, and HEAD-checks external URLs. Result: **no real breakages.**
  - `/sterling.jpg` only appears inside an HTML *comment* (the founder-photo placeholder instructions) — not a live link.
  - `/_vercel/insights/script.js` doesn't exist as a static file locally by design — Vercel serves it dynamically once Web Analytics is enabled (see item 19/19-note below).
  - `fonts.googleapis.com`/`fonts.gstatic.com` bare-origin 404s are from `preconnect` hints, not real links; the actual font stylesheet URL returned 200.
  - `deepwelltechnology.com/privacy.html` and `/terms.html` 404 today only because they aren't deployed yet — will resolve on deploy.

## 17. Form validation
The only form is `#ask`. It already had an `aria-label` and JS guard (`if(!q)return`) preventing empty-query submission. Added `required` on the input as a native HTML5 backstop. No server-side form exists (this is a client-side demo box), so nothing else applies.

## 18. Spam protection
N/A — no server-side form exists (the `#ask` box is a client-side demo; the real conversion path is a `mailto:` link). Documented here: **if a real contact/lead form is added later, it must use Cloudflare Turnstile** before going live.

## 19. Analytics
Added `<script defer src="/_vercel/insights/script.js"></script>` to `index.html`, `public/privacy.html`, `public/terms.html`, `public/404.html`, and `app/index.html`. Cookieless (Vercel Web Analytics).
**Action required from Sterling:** enable "Web Analytics" in the Vercel project settings — the script is a no-op until that's turned on.

## 20. Single clear CTA
Decision: kept the hero primary button labeled **"See pricing"** linking to `#plans` (label matches destination — appropriate for a pricing-led page; the ghost "See what it feels like" stays a clearly secondary action). The real inconsistency was in the *conversion* CTAs: the three self-serve pricing tiers (Solo/Shop/Crew) linked "Get started" to `/app/`, which is also where the nav's unrelated "Log in" link points — confusing for a prospect who has no account yet, and the product copy throughout ("we set it up for you," white-glove onboarding) doesn't describe a self-serve signup flow. Changed Solo/Shop/Crew's "Get started" buttons to `#contact` so they, the Fleet tier's "Contact sales," and the nav's "Get started" all now lead to the same place — the contact section with the `mailto:` link. Nav's "Log in" correctly still points to `/app/` for existing customers.

---

## Final verification
- `npm run build` → exit 0, no errors (one pre-existing warning about a >500KB app chunk, unrelated to this work and inside `src/`, not touched).
- `dist/` confirmed to contain all new `public/` files: `404.html`, `privacy.html`, `terms.html`, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `site.webmanifest`, `robots.txt`, `sitemap.xml`, plus the pre-existing `deepwell-logo.jpg`/`og-image.jpg`.
- `vercel.json` validated as valid JSON; existing rewrites/crons/Cache-Control headers for `/app` untouched.

## Files created
- `public/privacy.html`
- `public/terms.html`
- `public/404.html`
- `public/favicon.svg`
- `public/favicon.ico`
- `public/apple-touch-icon.png`
- `public/site.webmanifest`
- `public/robots.txt`
- `public/sitemap.xml`
- `handoffs/WEBSITE_LAUNCH_CHECKLIST_2026-09-19.md` (this file)

## Files changed
- `index.html` — meta/title/description, canonical, twitter tags, favicon/manifest links, gstatic preconnect, `--faint` contrast fix (3 places) + nav override, lazy-load logo image, `required` on ask input, pricing CTA hrefs → `#contact`, footer Privacy/Terms links, Vercel Analytics script tag.
- `app/index.html` — apple-touch-icon + manifest + theme-color links, Vercel Analytics script tag.
- `vercel.json` — added security headers block for `/(.*)`.

## What Sterling must do by hand
1. **Enable "Web Analytics"** in the Vercel project settings (item 19) — without this the analytics script does nothing.
2. **Have counsel review `privacy.html` and `terms.html`** before relying on them — both are marked as templates (see the HTML comment / refund placeholder in terms.html section 6).
3. Confirm the refund policy language in `terms.html` §6 (currently a placeholder) and the phone number in the footer `tel:` link (currently a placeholder `+10000000000`) before launch.
