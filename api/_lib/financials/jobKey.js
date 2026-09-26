/**
 * Job costing (M3-config/36-job-costing.sql) — pure helpers shared by normalize.js
 * (extraction time) and jobCosting.js (query time). Split into its own file so
 * neither of those two ends up importing the other (normalize.js needs job-key
 * derivation while parsing a fresh extraction; jobCosting.js needs the exact same
 * derivation while aggregating stored rows — a real circular import between them
 * otherwise).
 *
 * No DB, no model: pure text -> text.
 */
import { parseStreetAddress, extractUnitDesignator } from '../scope.js';

/** Below this, a document is never auto-grouped into a job: it is listed as unmatched instead. */
export const JOB_MATCH_CONFIDENCE = 0.5;

/** ", Phoenix, AZ[ 85001]" -> "phoenix" (city only — a printed zip is not required and is never
 *  used alone: two documents that agree on city but not zip must still be allowed to match).
 *  No ", <city>, <ST>" shape printed at all -> null, never guessed. */
const CITY_RE = /,\s*([A-Za-z][A-Za-z .'-]{1,40}?)\s*,\s*[A-Za-z]{2}\b/;
function extractCity(text) {
  const m = CITY_RE.exec(String(text ?? ''));
  if (!m) return null;
  return m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

/**
 * "For job at: 248 W Guadalupe Rd, Phoenix, AZ 85001 (Amy Isaacson)" or
 * "Service Address: 840 S Ellsworth Rd, Gilbert, AZ 85234" (any capitalization, with
 * or without a trailing "(<name>)") -> {address, customerName|null}, else null.
 * Stops at end of line or an opening paren so a trailing "(Amy Isaacson)" never gets
 * folded into the address itself.
 */
const JOB_LINE_RE = /(?:for\s+job\s+at|job\s+(?:site\s+)?address|service\s+address|service\s+location)\s*:\s*([^\n(]+?)\s*(?:\(([^)]{1,80})\))?\s*(?:\n|$)/i;
export function extractJobReference(text) {
  const m = JOB_LINE_RE.exec(String(text ?? ''));
  if (!m) return null;
  const address = m[1].trim().replace(/\s+/g, ' ');
  if (!address) return null;
  return { address, customerName: m[2]?.trim() || null };
}

/**
 * The pieces a job key is built from, exposed separately (not just the joined string) so
 * jobCosting.js can apply the "no city printed -> only link if the customer entity also
 * agrees" rule: a bare house-number + street-name match is NOT proof of the same property —
 * "123 N Main St, Phoenix" and "123 N Main St, Gilbert" must never collide just because both
 * start with "123 Main", and "Apt 1" must never collide with "Apt 2" at the same street address
 * (an apartment/suite/unit number changes `core` itself, never just `locality`, so two
 * different units NEVER merge regardless of confidence or customer).
 *   - core: house number + up to 2 street words + unit designator, e.g. "248-guadalupe" or
 *     "3300-alma-school-u104"
 *   - locality: the printed city, or null when none is printed
 *   - full: core + locality (the actual grouping key) — core alone when no city is printed
 * Reuses scope.js's own address parser and unit-designator reader (the same tokenizer "the
 * unit at <address>" questions already resolve customers with) so a job key computed from a
 * PO's free text and one computed from an invoice's service address always agree for the same
 * physical job.
 */
export function jobKeyParts(addressText) {
  const parsed = parseStreetAddress(addressText);
  if (!parsed) return null;
  const unit = extractUnitDesignator(addressText);
  const core = `${parsed.house}-${parsed.words.join('-')}${unit ? `-u${unit}` : ''}`;
  const locality = extractCity(addressText);
  return { core, locality, full: locality ? `${core}-${locality}` : core };
}

/**
 * Canonical job key from a printed address, or null: house number + up to 2
 * significant street-name words + unit + city, lower-cased — "248 W Guadalupe Rd, Phoenix, AZ
 * 85001" -> "248-guadalupe-phoenix". No city printed -> just the house+street(+unit) core;
 * jobCosting.js decides separately whether a bare core like that is safe to group on.
 */
export function normalizeJobKey(addressText) {
  return jobKeyParts(addressText)?.full ?? null;
}

/** The job_key a piece of free text's own embedded address resolves to, or null. */
export function jobKeyFromText(text) {
  return jobKeyParts(String(text ?? ''))?.full ?? null;
}
