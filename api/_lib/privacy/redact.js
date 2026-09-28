/**
 * Round 22 (S2, privacy): generic PII redaction for anything this codebase writes to a log line —
 * console.log/console.error/console.warn call sites in api/ask.js and api/_lib/** that used to print
 * a customer's name, address, phone, email, or a raw question/document-text string verbatim into
 * Vercel's log stream (which this shop's own staff, and anyone with log access, can read). This file
 * is the ONE place those call sites import from, so the redaction rule only has to be right once.
 *
 * Two different jobs, two different functions:
 *   - redactText(s)   for a string that's ALLOWED to appear in a log (a question, a free-text note)
 *                     but must have obvious PII shapes (emails, phone numbers) stripped out of it
 *                     first — same idea as api/_lib/missDigest.js's own redactPII, kept here as a
 *                     second, independent copy on purpose: this file is a generic helper other code
 *                     imports from, and missDigest.js's copy stays untouched (it's the self-learning
 *                     loop's own file, not this round's to edit) — a regex fix in one is not silently
 *                     assumed to apply to the other.
 *   - hashForLog(s)   for a value that should NEVER appear in a log at all (a raw customer name, a
 *                     full street address, a document's extracted text) — returns a short, stable,
 *                     one-way-looking digest plus the original length, so two log lines about "the
 *                     same" value can still be correlated (grep for the same hash) without the value
 *                     itself ever leaving the process. Not a cryptographic secret-hiding primitive
 *                     (no salt-injection defense is claimed) — it exists so a log line reads
 *                     `name=h:3f9a2c1e (len 11)` instead of `name=John Q. Smith`.
 *
 * Nothing here talks to a DB or a network; every function is pure and synchronous, so this file is
 * safe to import from anywhere (including telemetry.js's beforeSend, which must never itself add
 * network I/O to Sentry's event pipeline).
 */
import { createHash } from "node:crypto";

// Same shapes missDigest.js's own redactPII already redacts (kept independent — see module doc).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
// Defense in depth for the two categories the R22 contract's "never stored" list names even when the
// consent check would otherwise allow them through: a government-ID-shaped run of digits (SSN, 9
// digits, with or without dashes) and a payment-card-shaped run (13-19 digits, with or without
// spaces/dashes, Luhn not checked — false positives here cost nothing, a real card number reaching a
// log costs a lot).
const SSN_RE = /\b\d{3}-?\d{2}-?\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** Strip email/phone/SSN-shaped/card-shaped runs out of a string that is otherwise fine to log (a
 *  question, a free-text label). Never throws; non-string input becomes "". Pure. */
export function redactText(input) {
  return String(input ?? "")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(SSN_RE, "[redacted-id]")
    .replace(CARD_RE, "[redacted-card]")
    .replace(PHONE_RE, "[redacted-phone]");
}

/** A short, stable digest of `input`, for correlating log lines without logging the value itself.
 *  Truncated to 12 hex chars — plenty to eyeball-match two log lines, nowhere near enough entropy to
 *  be mistaken for a value someone would rely on for lookups. Pure, synchronous, no salt (this is a
 *  log-correlation aid, not an access-control token — see api/_lib/privacy/supportAccess.js for
 *  actual identifiers that need to resist guessing). */
export function hashForLog(input) {
  const s = input == null ? "" : String(input);
  if (!s) return null;
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** What a log line should print for a value that must never appear raw (a customer name, a full
 *  address, extracted document text): a hash + length, never the value. `label` is just for the
 *  caller's own readability in the returned string; nothing here inspects it. Pure. */
export function describeForLog(label, value) {
  const s = value == null ? "" : String(value);
  if (!s) return `${label}=(empty)`;
  return `${label}=h:${hashForLog(s)} (len ${s.length})`;
}

/** One tenant id, hashed for cross-tenant log correlation without printing the raw Clerk org id /
 *  solo `user_<id>` tenant key. Same digest function as hashForLog — kept as its own export so call
 *  sites read `hashTenantId(ctx.tenantKey)` rather than reaching for the generic name. */
export function hashTenantId(tenantId) {
  return hashForLog(tenantId);
}
