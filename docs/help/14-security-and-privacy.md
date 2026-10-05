---
id: security-and-privacy
title: Security and privacy
audience: public
surface: both
keywords: security, privacy, data, encryption, isolation, tenant, can you see my data, subprocessors, gdpr, soc 2, compliance, ai training, hosting
updated: 2026-10-05
---
DeepWell describes its real, current controls on the Security & Privacy page and in the Privacy Policy. This article does not round up: it lists what is not done yet, too.

### Is my data secure?
~ is my data secure, is my data safe, is it safe, safe, secure, is deepwell secure, is it secure, safety, is my data protected, is my data private, privacy, data privacy, how safe is my data, can i trust deepwell with my records, security
Yes. Your records are stored under your own company's account and kept separate from every other customer's, and the database enforces that separation on every query. Data is encrypted in transit and at rest, and files sit in private storage that opens only through short-lived links. DeepWell staff have no standing access to your account: your admin can grant **support access** for a set time and revoke it at any time, and every access is recorded in your own activity log.

### Can DeepWell see our data or files?
~ can you see my data, can deepwell see our data, can you see our files, who can see my data, do you have access to my documents, staff access, do employees see my data, who can access my records, can you read my files
DeepWell staff have no standing access to your account. Your records live under your company's own account, and the database enforces that isolation for every query. Inside the product, staff can look at your account only through **support access** that your admin grants for a set time and can revoke at any time, or in an emergency that is always logged where your admin can see it. Every access is recorded in your own activity log. The two founders also administer the hosting, database and file-storage accounts.

### Is my data isolated from other customers?
~ isolation, is my data separate, other customers see my data, multi tenant, tenant isolation, shared with other contractors, pooled, mixed with other companies, separated, data separation, row level security, is my data shared, where is my data stored, where is my data, where is data stored, where do you store my data, where is my data hosted, data location, data residency, where are my files stored, hosting, data center
Yes. Every document, customer record and answer is stored under your company's account and is never pooled with another customer's data. The database enforces this at the row level on every query, not only in application code.

### Is my data encrypted?
~ encrypted, encryption, is my data encrypted, encrypted at rest, encrypted in transit, ssl, tls, https, secure storage, how is data protected, data protection, how secure
Data is encrypted in transit with HTTPS/TLS, and files and database records are encrypted at rest by our storage providers (Cloudflare and Neon). Per-tenant encryption keys are not implemented: each customer's data is isolated by the database, not by separate keys.

### Is DeepWell SOC 2 certified or compliant?
~ soc 2, soc2, certified, certification, compliance, iso 27001, hipaa, gdpr, audit, audited, security audit, penetration test, pen test, compliant, security certification, security questionnaire
No. DeepWell has **no SOC 2 or equivalent certification** yet, and it hasn't had an independent third-party audit. The controls described on the Security & Privacy page are real, but I can't claim a certification. For a security questionnaire, email security@deepwelltechnology.com.

### Does DeepWell use my documents to train AI?
~ train ai, ai training, used for training, train models, training data, do you train on my data, anthropic training, does ai learn from my documents, model training, is my data used for ai, openai
No. To read documents and answer questions, DeepWell sends content and query text to its AI providers (Anthropic, and Voyage AI for search). Under those providers' API terms, that content is not used to train their models, and it is not shared with any other customer. AI answers can still be wrong, so check the citation.

### Who are your subprocessors?
~ subprocessors, sub processors, third parties, vendors, who do you share data with, which companies, which providers, service providers, cloudflare, neon, clerk, anthropic, voyage, stripe, vercel, resend, sentry, inngest, cloud provider, where is data stored, data location, hosted where, which vendors handle my data, vendors handle my data, who handles my data, which vendors, what vendors, what companies handle my data, third party vendors
Cloudflare R2 (file storage), Neon (database), Clerk (sign-in), Anthropic (AI reading and answering), Voyage AI (search), Inngest (background jobs, identifiers only), Vercel (hosting and cookieless analytics), Stripe (payments), Resend (email) and Sentry (scrubbed error monitoring). All are US-based. See the Privacy Policy for the full table.

### Are files private?
~ are files public, file access, signed links, private files, can someone guess a url, link sharing, shareable links, file security, secure links, document links
Yes. Uploaded files are not public. Each time a document is opened, DeepWell issues a short-lived signed link for that one file, so a leaked link can't be reused for long and a file can't be found by guessing a URL.

### Does DeepWell use cookies or advertising trackers?
~ cookies, cookie banner, advertising, ad trackers, cookie policy, tracking cookies, do you use analytics, site analytics, do you spy on me, are you tracking me, third party trackers
No tracking or advertising cookies, and no cookie banner. The only cookies are strictly necessary sign-in cookies from our authentication provider. Site analytics are cookieless.

### What if I find a security problem?
~ report a vulnerability, security issue, found a bug, vulnerability, security bug, responsible disclosure, bug bounty, report security, security report, breach, data breach, was i breached, hacked, security incident
Please tell us before anyone else: **security@deepwelltechnology.com**. We acknowledge real reports and work with you on a fix. There is no formal published breach-notification deadline yet. Our commitment is to notify affected account admins without undue delay after confirming a breach.
!handoff:security

### Where can I read the privacy policy or terms?
~ privacy policy, terms, terms of service, terms and conditions, legal, tos, read the terms, contract terms, agreement, dpa, data processing agreement, legal terms, liability
They are at deepwelltechnology.com/privacy and deepwelltechnology.com/terms, with a plain-language security summary at deepwelltechnology.com/security. I can't give legal advice. For a contract or DPA question, email privacy@deepwelltechnology.com or support@deepwelltechnology.com.
!handoff:legal
