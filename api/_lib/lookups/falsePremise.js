/**
 * R35 loop 3 — FALSE PREMISE about a repair at an address ("why did Danny Ochoa replace the compressor at 100 E Main St",
 * "when did we swap the capacitor at 951 E Main St"). When the address is on file and NOT ONE document tied to it mentions the
 * part, the honest answer is "No compressor work is on file for 100 E Main St." — at $0, instead of a model inventing a reason.
 *
 * Declines ONLY when all hold (else null: the question goes on exactly as before):
 *   - the question is "(why|when|how come|what day) did <someone> <replace|swap|change|install|fix|repair> the <part> at <address>"
 *     with <part> from a closed list of HVAC parts;
 *   - the address resolves to at least one customer or unit on file (an unknown address is the address-miss path's);
 *   - no page of any document tied to that address (direct links, unit links, extracted service address) mentions the part word.
 * Never answers WHY (that would be a guess); a mention of the part sends the question on to the normal path.
 * pure: parseFalsePremise     db: runFalsePremise     Kill switch: DONOVAN_FALSE_PREMISE=0.
 */
import { attachCitations } from "../citations/records.js";
import { TENANT_SQL, resolveAddressScope, scopeDocumentIds, extractUnitDesignator } from "../scope.js";
import { stripConversationalFrame } from "../router/frame.js";

const PARTS = ["compressor", "capacitor", "contactor", "blower motor", "blower", "fan motor", "condenser fan motor", "evaporator coil", "condenser coil", "coil",
  "thermostat", "heat exchanger", "igniter", "ignitor", "flame sensor", "inducer motor", "inducer", "txv", "expansion valve", "reversing valve", "circuit board",
  "control board", "board", "gas valve", "transformer", "pressure switch", "limit switch", "drain pan", "condensate pump", "filter drier", "air handler", "furnace", "condenser"];
const PART_ALT = PARTS.map((p) => p.replace(/\s+/g, "\\s+")).join("|");
const VERB = "(?:replace|replaced|swap|swapped|change|changed|install|installed|put\\s+in|fix|fixed|repair|repaired)";
const SHAPE_RE = new RegExp(String.raw`^(?:why|when|how\s+come|what\s+day|what\s+date)\s+did\s+(?:we|you|they|[a-z][a-z'.-]+(?:\s+[a-z][a-z'.-]+)?)\s+${VERB}\s+(?:the|a|an|their|his|her|that)\s+(${PART_ALT})s?\s+(?:at|on|for)\s+(\d{1,6}\s+.+?)\s*[?.!]*$`, "i");

export const falsePremiseEnabled = () => process.env.DONOVAN_FALSE_PREMISE !== "0";

/** Pure. @returns {part, address} or null. */
export function parseFalsePremise(question) {
  if (!falsePremiseEnabled()) return null;
  const raw = String(question ?? "").replace(/[’`]/g, "'").trim();
  if (!raw || raw.length > 200) return null;
  const q = (stripConversationalFrame(raw) ?? raw).replace(/\s+(?:for\s+me|please|thanks|real\s+quick)\s*[?.!]*$/i, "").trim();
  const m = SHAPE_RE.exec(q);
  if (!m) return null;
  return { part: m[1].toLowerCase().replace(/\s+/g, " "), address: m[2].trim() };
}

/** @returns the honest "no <part> work on file" answer, or null (address unknown / the part IS mentioned / anything unsure). */
export async function runFalsePremise(db, intent) {
  const scope = await resolveAddressScope(db, intent.address, { unit: extractUnitDesignator(intent.address) });
  const docIds = await scopeDocumentIds(db, scope);
  if (!scope.customers.length && !scope.equipment.length) {
    if (docIds.length || !scope.addressPatterns.length) return null;
    // the address itself is nowhere on file: no customer, unit or document carries it
    const shown = intent.address.split(",")[0];
    return attachCitations(
      { kind: "no-answer", text: `Nothing on file for ${shown} — no customer, unit, or document at that address.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [], addressMiss: true },
      { records: [], total: 0, kind: "searched", basis: `Searched every customer and unit service address and every document's service address for ${shown}; none matches.` }
    );
  }
  if (!docIds.length) return null;
  const word = intent.part.split(" ").pop(); // "blower motor" -> any page saying "motor" keeps it open (conservative)
  const stem = word.replace(/(?:or|er|s)$/i, "").slice(0, Math.max(4, word.length - 2));
  const { rows } = await db.raw(
    `SELECT 1 FROM document_pages WHERE ${TENANT_SQL} AND document_id = ANY($1::uuid[]) AND (text ILIKE $2 OR text ILIKE $3) LIMIT 1`,
    [docIds, `%${word}%`, `%${stem}%`]
  );
  if (rows.length) return null;
  const { rows: ex } = await db.raw(
    `SELECT 1 FROM extractions WHERE ${TENANT_SQL} AND document_id = ANY($1::uuid[]) AND (value ILIKE $2 OR value ILIKE $3) LIMIT 1`,
    [docIds, `%${word}%`, `%${stem}%`]
  );
  if (ex.length) return null;
  const label = scope.customers[0]?.service_address?.split(",")[0] || intent.address.split(",")[0];
  const who = [...new Set(scope.customers.map((c) => c.customer_name).filter(Boolean))].slice(0, 2).join(", ");
  return attachCitations(
    { kind: "no-answer", text: `No ${intent.part} work is on file for ${label}${who ? ` (${who})` : ""}.`, facts: [], sources: [], confidence: 1, verifiedCount: 0, unverifiedCount: 0, closest: [] },
    { records: [], total: 0, kind: "searched", basis: `Searched every page of the ${docIds.length} document${docIds.length === 1 ? "" : "s"} tied to ${label} for "${intent.part}"; none mentions it.` }
  );
}
