# DeepWell security & privacy

This is a plain description of how DeepWell protects a shop's data today — verified against this
codebase, not a marketing claim. Every statement below cites the file(s) that actually implement it.
The "not yet done" section at the end is just as important as everything above it: this document
does not round up.

## Can DeepWell see our data?

**Short answer: not by default, and never without your knowledge.**

Your documents, customer records, and Donovan Q&A history live behind Postgres row-level security
that is *forced* per tenant (below) — nobody, including DeepWell staff, can query another shop's rows
through the app's normal database connection, full stop. The one path that ever lets a DeepWell staff
member look at your data at all is **support access** (below): something *you* turn on, for a time
limit *you* pick, that you can revoke instantly, and that is always recorded in an access log only
your own admins can read. Outside of that:

- DeepWell staff cannot browse your documents, ask Donovan questions "as you," or read your Q&A
  history from any admin tool.
- Error monitoring (Sentry) never receives your question text, customer names, addresses, phone
  numbers, document contents, or extracted field values — see "Error monitoring" below for exactly
  what it does receive.
- Application logs are built the same way: counts, ids, and enum labels, not the content behind them
  (see "Server logs" below).
- The one AI provider that reads your document content to answer a question is Anthropic (Claude),
  under Anthropic's commercial API terms, which state API inputs/outputs are not used to train their
  models. Voyage AI reads short text passages to build search embeddings, under a similar no-training
  commercial arrangement. Neither company is DeepWell staff, and neither gets your data for any
  purpose beyond answering that one request.

## Tenant isolation

Every tenant-scoped table (`documents`, `extractions`, `entities`, `audit_log`, `ask_misses`,
`donovan_promoted_tests`, `support_access_grants`, `staff_access_log`, and everything else with a
`tenant_id`) has Postgres row-level security **enabled AND forced** — `FORCE ROW LEVEL SECURITY`,
not just `ENABLE`, which matters because `FORCE` means even a table owner's own connection cannot
bypass the policy (`ENABLE` alone would exempt it). Every one of those tables carries exactly one
isolation policy, shaped like:

```sql
USING (tenant_id = (current_setting('app.tenant_id', true))::uuid)
```

The app's own database role (`deepwell_rls`) has no `BYPASSRLS` attribute (see
`M3-config/01b-app-role.sql`), so this is not a "trust the app to filter correctly" scheme — it is
enforced by Postgres itself, on every query, including one a bug might otherwise construct without a
`WHERE tenant_id = ...` clause. `api/_lib/recordsStore.js`'s `withTenant()` opens one transaction,
calls the `resolve_tenant()` `SECURITY DEFINER` function to map your Clerk organization id to your
tenant row, and sets `app.tenant_id` for that transaction only — every read/write in this codebase
goes through it. Row deletion (`api/_lib/routes/tenant-delete.js`) and full data export
(`api/_lib/routes/tenant-export.js`) are the same story: a fixed, reviewed list of every tenant-scoped
table, run inside the same tenant-scoped transaction.

The Donovan Q&A agent's own SQL tool (`api/_lib/agent/sqlGuard.js`) adds a second, independent layer
on top of RLS: its generated queries are parsed and every real table name is **denied outright** — the
agent can only read through a small set of hand-written views (`customers`, `equipment`,
`documents_v`, `facts`, `doc_links`, plus the finance views), never a raw table. This means even a
successful prompt-injection or model mistake that tried to `SELECT * FROM extractions` (this
tenant's own, since RLS still applies) — or, worse, was somehow tricked into naming
`support_access_grants` or `staff_access_log` — is rejected before it ever reaches the database, not
merely scoped correctly by RLS.

## Encryption

- **In transit:** every connection this app makes is over TLS — the browser to Vercel (HTTPS only),
  Vercel to Neon (Postgres, native TLS via `NEON_CONNECTION_STRING`'s pooled endpoint), Vercel to
  Cloudflare R2 (HTTPS, presigned requests — `api/_lib/r2.js`), and Vercel to every third-party API
  (Clerk, Anthropic, Voyage, Stripe, Inngest, Sentry, Resend) — all HTTPS.
- **At rest:** document files live in Cloudflare R2 and database rows live in Neon Postgres; both
  encrypt data at rest as a platform-level guarantee of that provider, not something this application
  layer implements itself. (See "Not yet done" — per-tenant encryption keys are not part of this.)
- **Document access:** nobody, including a browser with a stolen bearer token to some *other* API
  route, can construct a link straight to R2 and download a file. Every file read/write goes through a
  short-lived, HMAC-signed URL DeepWell's own server mints per request (`api/_lib/r2.js`'s `presign()`,
  SigV4) — 120 seconds for a read, 60 for a delete — scoped to one object key, never a bucket listing.

## Support access — the only path to staff seeing your data

By default, **no DeepWell staff account can read any tenant's documents, Donovan answers, misses, or
learning data** — the operator-only actions in `api/review.js` (replaying a miss against real
documents, promoting a miss to a permanent test, running the accuracy scorecard against real data)
all require an **active, tenant-granted support-access grant** before they run
(`api/_lib/privacy/supportAccess.js`'s `requireSupportAccess`), on top of already requiring a
DeepWell-operator account. A shop's own admin grants this from **Settings → Support access**: pick a
duration (24 hours, 72 hours, or 7 days — the maximum any single grant can last), an optional note for
why, and revoke it early any time. The DEFAULT is off; nothing about using DeepWell ever creates a
grant automatically.

Every access made under a grant — and every "break-glass" emergency access made *without* one (only
ever with an explicit, logged reason, for a genuine incident where a customer needs help right now and
no admin is reachable) — is appended to that tenant's own **Access log**
(`staff_access_log`, same forced-RLS tenant isolation as every other table): who, when, which action,
how many records — **never the records themselves**. A tenant's own admins can read this log any time
under Settings → Access log; DeepWell has no separate, hidden copy.

Two things are *not* gated by a support-access grant, because they carry no single tenant's content:
Donovan's own cross-tenant miss digest and capability-gap report (aggregate counts and
already-redacted question text across every shop, never which shop), and the platform-level "what has
Donovan learned" routing-rule bank (no `tenant_id` column at all — see `M3-config/26-donovan-learning.sql`).
Both are documented, line by line, in `api/review.js`'s own `SUPPORT-ACCESS-EXEMPT` comments, and
`scripts/verify-privacy.mjs` fails the build if a future change quietly removes a required gate or
mislabels an exemption.

## Error monitoring (Sentry)

Sentry is configured with `sendDefaultPii: false` — explicitly, not relying on it being the default —
so it never automatically attaches request IP addresses, cookies, or a "user" object. On top of that,
`api/_lib/telemetry.js` runs **every** event and breadcrumb through its own scrubbing before it can
leave the process:

- `beforeSend` strips the entire request object (headers, query string, cookies, request body) and
  the user object, runs the exception/message text itself through PII redaction (in case an error
  message echoed a value, e.g. a database constraint violation), and re-applies an explicit allowlist
  to tags/extra data.
- `beforeBreadcrumb` strips breadcrumb `data` entirely for console-log breadcrumbs, and keeps only
  method + hostname (never the path or query string) for outgoing HTTP breadcrumbs — a signed R2
  URL's own token, or a search term in a URL, never reaches Sentry.
- The one thing DeepWell staff can still correlate in Sentry is which **tenant** an error belongs to —
  but even that is a one-way hash of the tenant id, never the raw Clerk organization id, so a Sentry
  event can be grouped by tenant without naming which tenant. Route name, error type, stack frames, and
  an internal document/stage identifier (an opaque UUID, not a person's or a company's name) pass
  through in the clear — that is what makes an error report useful to fix.
- With no `SENTRY_DSN` configured (true of every environment as of this write-up), none of this talks
  to a network at all — errors fall back to a single structured `console.error` line carrying the
  same scrubbed fields.

`scripts/verify-privacy.mjs` feeds this pipeline synthetic events built from a request body, an
email, a customer name, and document text, and asserts none of it survives either hook.

## Server logs

Application logs (Vercel's log stream) follow the same discipline: route-level logs already carried
counts and enum labels only ("fast path hit: true", "citations: count_mismatch") — this round found
and fixed the three places that didn't:

- Two fuzzy-typo-correction log lines in `api/ask.js` used to print the raw `{from, to}` word pair a
  technician's typo was corrected against (a customer surname, a street name) — now only a count and a
  one-way hash of each side.
- The email fallback log (`api/_lib/email.js`, used when no `RESEND_API_KEY` is set) used to print
  every recipient address and the full subject line — now a hash per recipient and a length-only
  description of the subject.
- One address-matching log line (`api/_lib/recordsStore.js`) used to print the tenant id and a
  normalized address in the clear — now both are hashed.

`api/_lib/privacy/redact.js` is the one shared helper behind all three fixes (and Sentry's own
scrubbing above), so the redaction rule only has to be right in one place.

## Data export & deletion

Any tenant admin can download every document, extraction, customer/unit record, and audit-log entry
DeepWell holds for their shop as one JSON file, on demand, from **Settings** — see
`api/_lib/routes/tenant-export.js`. A tenant can also be fully deleted (`api/_lib/routes/tenant-delete.js`),
which wipes every tenant-scoped table (documents, extractions, entities, misses, learned data, usage
counters, members, API keys — the full list is `opsStore.js`'s own `DELETE_ORDER`) behind a
confirmation step that requires typing the tenant id back, and is itself audit-logged.

## Subprocessors

Every subprocessor below is verified as actually used in this codebase (not just planned), with what
it's used for and what it can see:

| Subprocessor | Used for | What it can see |
|---|---|---|
| **Vercel** | Application hosting, serverless functions (`vercel.json`) | Encrypted requests in transit; runs the application code |
| **Neon** | Postgres database, tenant-isolated via forced RLS (`NEON_CONNECTION_STRING`) | Your data at rest, encrypted, isolated per tenant by RLS |
| **Cloudflare R2** | Document file storage, accessed only via short-lived signed URLs (`api/_lib/r2.js`) | Your document files at rest, encrypted |
| **Clerk** | Authentication and organizations/teams (`api/_lib/auth.js`) | Account/login info (email, name), never document content |
| **Inngest** | Background job queue for document ingestion steps (`api/inngest.js`, `api/_lib/queue.js`) | Job metadata; document content passes through, not stored by Inngest |
| **Anthropic (Claude)** | Donovan's Q&A model, Haiku/Sonnet (`api/_lib/claude.js`) | Document excerpts relevant to a specific question, under Anthropic's commercial API terms (no training on API inputs/outputs) |
| **Voyage AI** | Text embeddings for "search by meaning" (`api/_lib/search/embed.js`) | Short text passages from your documents, to build a search index |
| **Stripe** | Billing and subscription management (`api/_lib/billing.js`, `api/billing.js`) | Billing contact info and payment details; never document content |
| **Sentry** | Error monitoring, scrubbed as described above (`api/_lib/telemetry.js`) | Error type, stack trace, route, a hashed tenant id — never PII or content |
| **Resend** | Transactional email (warranty digests, notifications) (`api/_lib/email.js`) | Recipient address and message content for the emails DeepWell sends on your behalf |

## What is NOT yet done

Being direct about the gap is part of the honest answer:

- **No SOC 2 (or equivalent) certification yet.** Everything above is real and verifiable in this
  codebase, but it has not been through an independent third-party audit.
- **No per-tenant encryption keys.** Encryption at rest today is each provider's own platform-level
  encryption (Neon, R2) — every tenant's data is encrypted, but not with cryptographically distinct
  keys per tenant. Isolation between tenants is enforced by Postgres RLS, not by separate encryption
  keys.
- **No formal breach-notification SLA is published yet.** DeepWell's commitment is to notify affected
  tenant admins without undue delay upon confirming a breach affecting their data; this is not yet
  backed by a contractual notification-time commitment (e.g., "within 72 hours").
- **Support-access break-glass is trust-based, not further hard-gated.** An operator can proceed with
  no grant by supplying a reason; nothing currently blocks a bad-faith reason from being accepted —
  the control is that it is always logged and visible to the tenant, not that it is pre-approved.

## FAQ: "Can DeepWell see our data?"

**No, not by default.** Your documents, customer records, and Q&A history are isolated from every
other tenant by Postgres row-level security that is *forced*, not optional — including for DeepWell's
own database connection. DeepWell staff cannot open your documents or read your Q&A history from any
tool unless you've explicitly granted time-boxed support access in Settings, which you control, can
revoke instantly, and which is always visible in your own Access log — including any emergency access
used to help you in an incident. The one thing that reads your document content to answer a question
is Anthropic's Claude model, under commercial terms that exclude your data from model training; a
short text passage also goes to Voyage AI to power search, under a similar no-training arrangement.
Error monitoring and application logs are built to carry counts and labels, not your customers' names,
addresses, or the content of your documents.
