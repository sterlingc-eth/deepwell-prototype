# DeepWell website QA (round 25), 2026-09-28

Method: live crawl with WebFetch (/, /get, /industries/hvac.html, robots.txt, sitemap.xml, 404 probe). /app/ fetch was refused by robots.txt (respected, tested locally instead). Local build (vite build + preview :4174), Playwright at 360/390/768/1280/1920, axe-core 4.10 (wcag2a/aa + best-practice, light and dark scheme), CDP 4x CPU + slow-4G perf at 390. Screenshots in /tmp/claude-0/r25/web/. Note: `vite preview` does not apply vercel.json rewrites, so /get, /m and /expenses were tested via their real files.
The live site still showed the "Placeholder bio" text and the same pricing block at crawl time (all fixes below are local, uncommitted).

## Defects found and FIXED (index.html, public/*)
| Sev | Defect | Fix |
|---|---|---|
| High | Founder bios literally said "Placeholder bio." (live too) | Replaced with factual, minimal bios (Sterling: IT infrastructure background, builds/runs platform; Hilton: customer relationships + marketing). Removed the invented origin story. OWNER TO REVIEW wording. |
| High | Pricing said "Questions: Unlimited" and "Everything else is unlimited" but app enforces asksPerMonth (3,000/9,000/22,500/60,000, api/_lib/plan.js) | Rows now "Donovan usage / month" with the app's numbers; heading and lede corrected. Fleet pages "10,000+" changed to "10,000" (app hard cap). |
| High | Unmeasured claims: hero "< 3 s / < 5 min / 100% answers cite source"; "Under 95% on your own set" (breaks the no-accuracy-% rule); demo "serial read 99%", "4 sources · 1.4 s" hard-coded | Hero facts now words (Seconds / Minutes / Every answer shows its source); 95% removed; demo source count derived from data, fake timings and 99% removed. |
| High | HVAC page: "running for real HVAC shops today", "real contractors" (no paying client yet) | Reworded to "the one it runs end to end today / your own documents". |
| Med | Keyboard focus invisible on demo question buttons and Ask button (`all:unset` killed outline) | Added :focus-visible outline. |
| Med | Nav light plate with dark-scheme colours: "Live"/"Coming" tags 1.7:1 contrast; industry pages status pill/cards 1.26:1 (green on dark) | Fixed colours on index + 4 industry pages. axe now clean on all pages, both schemes, menu open. |
| Med | 761-1000px header overflowed (830px content at 768, logo crushed); phones (<=760) had NO menu, nav links silently hidden, Industries unreachable | Added accessible Menu button (aria-expanded, Esc, closes on tap) at <=1000px, nowrap, tighter 360px sizing. Verified no horizontal overflow at every width 320-1400 (step 20). |
| Med | robots.txt `Disallow: /app` also blocked /apple-touch-icon.png; /expenses, /expense-tracker.html, /m/ not disallowed | `/app/`, `/app$`, `/expenses`, `/expense-tracker.html`, `/m/` disallowed; Allow / kept. (/expenses etc. also carry noindex.) |
| Low | No `<main>` landmark on home | Added. |
| Low | Reduced motion: pricing sweep pseudo-element still animated | Rule now covers ::before/::after; 0 running animations. |
| Low | Demo sample dates in the past ("earliest 24 Sep 2026", "before 11 Dec 2026") | Moved to 9 Oct / 27 Dec 2026. |
| Low | 404 page had canonical to home plus noindex | Canonical removed. |
| Low | Footer lacked HVAC and Mobile app links | Added. |
| Legal | Privacy: only "contact us" for deletion (Security page says self-serve); asserted "no consent banner required under GDPR/CCPA" (legal conclusion) | Privacy now mentions self-serve export/delete; legal conclusion removed. Terms s.6 now says plans carry monthly page/Donovan usage and storage limits. |

## NEEDS OWNER DECISION (not changed)
1. Legal entity: pages say "DeepWell Inc." (Mesa, AZ). Confirm it exists; otherwise change to actual entity/sole prop. No mailing address anywhere.
2. Contact email inconsistency: home CTA and all legal pages use deepwellincorporated@gmail.com; pricing/industry waitlists use hello@deepwelltechnology.com. I could not verify hello@ receives mail. Pick one; a gmail address as the main CTA looks unprofessional.
3. No contact form: every "form" is a mailto (dead-end for people without a mail client). Consider a form/Calendly.
4. "a phone that gets answered" headline, "Phone + email" (Crew) and "Dedicated + SLA" (Fleet) support promises: no phone number or SLA published. Confirm or soften.
5. Fleet "Contact sales" button goes to self-serve sign-up (?plan=fleet). Fleet "10,000 pages" vs "custom fit".
6. Effective date Sept 19, 2026 is older than later content (Security page reviewed Sept 28). Update date when finalized. Post-cancellation retention period is unstated ("reasonable period"). Data location "United States" for Cloudflare R2/Neon is unverified (R2 uses automatic region).
7. Operational promises to confirm you can keep: "white-glove setup", "trains your crew in an afternoon", "free demo: we digitize one sample box free", "reads handwriting", "searchable within minutes", "every answer shows its source" as a contractual commitment.
8. Terms lack an "as is"/warranty disclaimer and explicit usage-cap/fair-use language; have counsel review before first signature. Founder photos absent (initial avatars).
9. Terms/Privacy are "HVAC contractors" scoped while industries pages advertise other verticals (fine while Coming soon).

## Checks that PASSED
- All internal links resolve (10 static pages, no 404s, no missing anchors); pricing links `/app/?plan=solo|shop|crew|fleet&interval=month` carry plan into /app/ (app handles ?plan= survival, tested link only); prices ($99/199/399/899) and tech/document/page limits match src/services/billingClient.ts and api/_lib/plan.js; Records Rescue $0.12/$500 min matches (4,167 pages); annual = 11x matches; trial only on Solo matches.
- Title, description, OG, canonical, favicon, manifest present on all marketing pages (404 intentionally noindex); og-image 1200x630 (60 KB); h1 count 1, no heading-level skips; lang set; all images have alt; no broken images.
- No horizontal overflow at 360/390/768/1280/1920 on any page (post-fix). Nav dropdown keyboard + Esc work. Demo widget is labelled "Example records ... illustrative", unmatched questions handled honestly.
- axe (wcag2a/aa + best-practice): 0 violations after fixes, light and dark, dropdown/menu open. Reduced motion respected.
- Sitemap lists 9 real pages (all exist). Subprocessor list on Privacy and Security pages matches your list (Vercel, Neon, R2, Clerk, Stripe, Anthropic, Voyage, Inngest, Resend, Sentry). Tenant export/delete, support-access grants, and Sentry redaction exist in api/. No SOC 2, HIPAA or "bank-level" claims anywhere.
- Performance (390px, 4x CPU, ~1.6 Mbps): home HTML 27.5 KB gzip, zero JS bundles, FCP/LCP ~0.5 s (fonts blocked in sandbox; real Google Fonts stylesheet is the only render-blocking asset, display=swap), CLS 0. Largest asset: deepwell-logo.jpg 71 KB (lazy). Console errors only from sandbox-blocked externals and local-only /_vercel/insights.
