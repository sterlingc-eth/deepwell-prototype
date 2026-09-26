# QuickBooks / Xero / Stripe sync — design (2026-09-26)

Goal: pull ledger-side invoices/bills/payments into DeepWell so `document_financials`
(what we extracted from PDFs) can be reconciled against what actually got recorded/paid,
and eventually job-costing can use real payment status instead of PDF "balance due" text.

## What each integration gives us
- **QuickBooks Online (Intuit)**: Invoices, Bills, Payments, Customers, Vendors via the
  Accounting API. Best fit for owner-operators already on QBO — most of our SMB corpus.
- **Xero**: Invoices, Bills (ACCPAY), Payments, Contacts via the Xero Accounting API.
  Same shape as QBO, different auth/field names.
- **Stripe**: Charges/PaymentIntents/Invoices — tells us when a customer *actually paid*,
  independent of what the ledger says. Read-only value: payment-status ground truth.

## OAuth registration (OWNER does this, we cannot)
- **Intuit**: create an app at developer.intuit.com, get `client_id`/`client_secret`,
  set redirect URI to `https://<domain>/api/integrations/qbo/callback`, request
  `com.intuit.quickbooks.accounting` scope. Sandbox company first.
- **Xero**: create an app at developer.xero.com, get `client_id`/`client_secret`,
  redirect URI `https://<domain>/api/integrations/xero/callback`, scopes
  `accounting.transactions.read accounting.contacts.read offline_access`.
- **Stripe**: owner creates a **restricted key** (Developers → API keys → restricted),
  read-only on `Charges`, `PaymentIntents`, `Invoices`. No OAuth app needed for
  single-account use; Stripe Connect only if we ever manage multiple owner accounts.

Env vars added (Vercel project settings, owner pastes): `QBO_CLIENT_ID`,
`QBO_CLIENT_SECRET`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `STRIPE_RESTRICTED_KEY`
(per-tenant, so actually stored encrypted in DB — see Security — not a shared env var).

## Data model
- `integration_connections` (tenant_id, provider ['qbo'|'xero'|'stripe'], status
  ['connected'|'error'|'disconnected'], access_token_enc, refresh_token_enc,
  realm_id/tenant_id (their side), connected_by, connected_at, last_synced_at,
  last_error). FORCE RLS same as every other tenant table.
- `ledger_documents` (tenant_id, provider, external_id, doc_kind ['invoice'|'bill'|'payment'],
  customer_or_vendor_name, total_cents, balance_cents, currency, issued_date, status,
  raw jsonb, synced_at). One row per ledger record, provider-namespaced.
- `financial_reconciliation` (tenant_id, document_financials_id, ledger_documents_id,
  match_confidence, match_basis ['invoice_number'|'amount_date_customer'|'manual'],
  amount_delta_cents, status ['matched'|'amount_mismatch'|'unmatched'], reviewed_by).
- Sync cursor: `last_synced_at` + provider's own cursor (QBO `ChangeDataCapture`, Xero
  `If-Modified-Since`, Stripe `created[gte]`) stored on `integration_connections` so a
  poll only pulls deltas.

## Reconciliation rules
1. Match by invoice/PO number printed on the doc vs. ledger `DocNumber`/`InvoiceNumber` —
   highest confidence, auto-matched.
2. Fallback: same customer + same total (±$0.01) + issued date within 3 days — medium
   confidence, auto-matched but flagged `match_basis: amount_date_customer`.
3. Below that: listed as unmatched, never guessed — same "never invent" rule as job
   costing. Amount mismatches (matched but totals differ) are surfaced, not silently
   averaged or overwritten.
4. Stripe payments reconcile against `document_financials.balance_due` directly (a
   PaymentIntent succeeded ⇒ that invoice's balance should be 0; a gap is flagged).

## Security
- Tokens (access + refresh) encrypted at rest (AES-GCM, key from a KMS-backed secret,
  not the DB itself) in `integration_connections`, never logged.
- Per-tenant opt-in only: connecting QBO/Xero/Stripe is a tenant-level setting an owner
  turns on explicitly; no tenant is auto-enrolled. Disconnecting revokes the token
  (provider-side) and deletes the encrypted row, not just flips a flag.
- Scopes are read-only everywhere; we never write back to the customer's ledger.

## Cost
- QBO/Xero: free to integrate (standard API tiers cover our call volume at SMB scale).
- Stripe: no extra cost beyond the owner's existing Stripe fees; restricted key is free.
- Our cost is engineering time + one background sync job (Vercel cron, tenant-scoped,
  similar shape to the existing backfill jobs) — no new paid infrastructure.

## Phased build
1. **Read-only Stripe** (simplest OAuth-free case): payment-status ground truth only.
2. **QuickBooks OAuth + Invoices/Bills/Payments pull**, `ledger_documents` table,
   invoice-number matching only (rule 1).
3. **Xero**, same shape as QBO, shared `ledger_documents`/reconciliation code path.
4. **Fuzzy match (rule 2) + reconciliation UI** (owner reviews unmatched/mismatched),
   then wire job costing to prefer ledger `status` over PDF-parsed "balance due" text
   when a reconciled match exists.
