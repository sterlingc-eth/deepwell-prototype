/**
 * R32 (Team A): an honest, deterministic "not on file" for a question about a street address nobody on this tenant serves.
 *
 * Fires only at the model fallthrough (ask.js tryAddressMiss, next to tryClarify) and only when EVERY check below agrees the address is absent:
 *   - the question names a full street address (house number + street + suffix) and carries a record cue (serial, warranty, last tech, ...);
 *   - no customer's service address matches all its significant tokens (contactLookup.resolveAddressCandidates);
 *   - no customer has the same house number AND the same first street word (so "Elliot"/"Elliott", "Rd"/"Road", a missing direction, a wrong
 *     city are all left to the normal near-miss / model path, never declared absent);
 *   - no document page mentions "<house number> <first street word>".
 * Gate: DONOVAN_ADDRESS_MISS (default on; "0" disables). Never runs on a follow-up turn (context may carry the address).
 */
import { resolveAddressCandidates } from "../contactLookup.js";
import { attachCitations } from "../citations/records.js";
import { ADDRESS_RE } from "./clarify.js";

export function addressMissEnabled() {
  return process.env.DONOVAN_ADDRESS_MISS !== "0";
}

const CUE_RE = /\b(?:serial|model|brand|make|manufacturer|warranty|covered|unit|units|system|equipment|furnace|ac|a\/c|heat\s*pump|tonnage|install(?:ed|ation|er)?|tech|technician|serviced?|service|visit|maintenance|last|old|age|permit|invoice|customer|who|phone|contact|lives?|owner|account|file|documents?|paperwork|invoices?|permits?|nameplate|photo)\b/i;
const DIRECTION = new Set(["n", "s", "e", "w", "north", "south", "east", "west", "ne", "nw", "se", "sw"]);

export function extractAddressPhrase(question) {
  const q = String(question ?? "");
  const m = ADDRESS_RE.exec(q);
  if (!m || !CUE_RE.test(q)) return null;
  const phrase = m[0].replace(/\.$/, "").trim();
  const words = phrase.split(/\s+/);
  const number = words[0];
  const street = words.slice(1).find((w) => !DIRECTION.has(w.toLowerCase().replace(/\./g, "")));
  if (!/^\d{2,6}$/.test(number) || !street || street.length < 3) return null;
  return { phrase, number, street: street.replace(/[^A-Za-z0-9'-]/g, "") };
}

export async function buildAddressMissAnswer(db, question) {
  if (!addressMissEnabled()) return null;
  const a = extractAddressPhrase(question);
  if (!a) return null;
  if ((await resolveAddressCandidates(db, a.phrase)).length) return null;
  const esc = (s) => s.replace(/[\\%_]/g, "\\$&");
  const loose = await db.raw(
    `SELECT 1 FROM entities WHERE entity_type = 'customer' AND merged_into IS NULL
        AND data->>'service_address' ILIKE $1 AND data->>'service_address' ILIKE $2 LIMIT 1`,
    [`${esc(a.number)} %`, `%${esc(a.street)}%`]
  );
  if (loose.rows.length) return null;
  const pages = await db.raw(`SELECT 1 FROM document_pages WHERE text ILIKE $1 LIMIT 1`, [`%${esc(a.number)} %${esc(a.street)}%`]);
  if (pages.rows.length) return null;
  return attachCitations(
    {
      kind: "no-answer",
      text: `I don't have anything on file for ${a.phrase}: no customer, unit, or document at that address.`,
      facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [],
      addressMiss: true,
    },
    { records: [], total: 0, kind: "searched", basis: `Searched every customer service address and every document page for ${a.phrase}; none matched.` }
  );
}
